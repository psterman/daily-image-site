#!/usr/bin/env node
/**
 * RSS 抓取 + 解析（零依赖，只用 Node 内置 API）
 *
 * ── 为什么放在构建期抓，而不是让 Pages Function 运行时抓？──────────────────
 *  1. Pages Functions **不支持 Cron Trigger**（Cloudflare 的产品决策，不是运行时限制）。
 *     想定时抓必须另起一个 Worker，再用 Service Binding 调回来 —— 为了「每天抓一次」
 *     要多一个项目、多一次部署、多一层 Service Binding。
 *  2. 构建期抓是在**你本机**跑的（国内 IP）。实测国内 RSS 源从国内拉通顺得多，
 *     而 Cloudflare 边缘节点去拉国内站点经常被拒或超时。
 *  3. 运行时抓会占 Workers 请求额度（免费 100,000 次/天，和图片代理共用同一个池）。
 *  4. 这个站本来就是「每天一份快照」，标题在发布那一刻定格最符合语义。
 *
 * ── 为什么要自己写解析器 ──────────────────────────────────────────────────
 *  package.json 是零依赖的，build 工具链只��� Node 内置 API。
 *  RSS 2.0 和 Atom 的结构足够规整，正则解析完全够用（而且比引三方库更可控）。
 *
 * ── 容错 ──────────────────────────────────────────────────────────────────
 *  单个源失败（超时 / 403 / 返回的不是 RSS）只跳过它，不影响其他源；
 *  所有源都失败时 headlines 为空，页面不渲染「见报」tab，构建照常成功。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFeedPolicy } from '../lib/pipeline-policy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'rss.config.json');

/* ──────────────────── undici 的连接重置崩溃（兜底） ────────────────────
 *
 * 现象：连接在**读 body 的中途**被对端重置时，Node 内置 fetch（undici）内部
 *   的 Parser.finish 会抛一个 assert 失败：
 *     AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:
 *     assert(!this.paused)
 *     at Parser.finish (node:internal/deps/undici/undici:6165:9)
 *
 * 为什么要专门兜它：
 *   那个断言是在**socket 的事件回调里**抛的，**不在任何 promise 链上** ——
 *   外层的 try/catch 接不住，它会变成 uncaughtException 直接把整个构建进程带走。
 *   而本机到国内站点的链路本来就时不时断（今天已经因此挂过两次构建）。
 *   后果是：59 个源里只要有一个在读 body 时断线，**整期构建全废**。
 *
 * 兜法：只放行这一种错误（undici + Parser.finish + ERR_ASSERTION），
 *   其它未捕获异常照旧抛出去、照旧让进程退出 —— 不能拿这个当万能挡箭牌。
 *   被放行的那个 fetch 本身会失败，源会被记成「抓取失败」，不影响其它源。
 */
function isUndiciResetAssert(err) {
  if (!err || err.code !== 'ERR_ASSERTION') return false;
  const stack = String(err.stack || '');
  return /undici/.test(stack) && /Parser\.finish/.test(stack);
}

if (!process.__dailyRssUncaughtGuard) {
  process.__dailyRssUncaughtGuard = true;
  process.on('uncaughtException', (err) => {
    if (isUndiciResetAssert(err)) {
      console.warn('  ! 抓取过程中连接被重置（undici 已知崩溃），该源按失败处理，继续');
      return;
    }
    throw err;
  });
}

/* ──────────────────────────── 文本工具 ──────────────────────────── */

function codePoint(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  hellip: '…',
  mdash: '—',
  ndash: '–',
};

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => {
      const v = NAMED_ENTITIES[name.toLowerCase()];
      return v === undefined ? m : v;
    });
}

/** 去掉 HTML 标签，HTML 实体也一起解掉 —— 标题/摘要里常有 <b> 之类 */
function stripTags(s) {
  return String(s)
    // 只剥「像标签」的：要求 < 后面紧跟字母或 /，
    // 这样 "5 < 10 > 3" 这种正文里的比较号不会被误伤
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function unwrapCdata(s) {
  const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  return m ? m[1] : s;
}

/**
 * HTML -> 纯文本。
 *
 * RSS 的 description 经常是「被转义过的 HTML」：源码里写的是 &lt;p&gt;，
 * 解实体之后会变成真的 <p> —— 不再剥一次就会把标签当正文显示出来。
 * 所以这里反复「解实体 -> 剥标签」直到稳定为止（最多 3 轮，够覆盖双重转义）。
 */
function htmlToText(raw) {
  let s = String(raw || '');
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = stripTags(decodeEntities(s));
    if (s === before) break;
  }
  return s;
}

/** 取某个子标签的文本内容。标题/链接/分类用这个：只解一次实体。 */
function textOf(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(block);
  if (!m) return '';
  // 先剥真标签、再解实体。反过来的话，&lt;C&gt; 会被解成 <C> 然后当标签删掉。
  return decodeEntities(stripTags(unwrapCdata(m[1])));
}

/** 摘要/正文用这个：解实体后可能又露出标签，要反复剥到稳定。 */
function richTextOf(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(block);
  if (!m) return '';
  return htmlToText(unwrapCdata(m[1]));
}

/** Atom 的 <link href="..."/> 与 RSS 的 <link>url</link> 都要认 */
function linkOf(block) {
  const inner = textOf(block, 'link');
  if (inner) return inner;
  const selfClosing = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i.exec(block);
  if (selfClosing) return decodeEntities(selfClosing[1]);
  const withBody = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/link>/i.exec(block);
  if (withBody) return decodeEntities(withBody[2].trim());
  return '';
}

/** RSS 的 <category>文字</category> 与 Atom 的 <category term="x"/> 都要认 */
function categoriesOf(block) {
  const out = [];
  const re = /<category\b([^>]*?)(?:\/>|>([\s\S]*?)<\/category>)/gi;
  let m;
  while ((m = re.exec(block))) {
    const attrs = m[1] || '';
    const inner = m[2] === undefined ? '' : m[2];
    const term = /\bterm=["']([^"']+)["']/i.exec(attrs);
    const value = term ? term[1] : inner;
    const v = htmlToText(unwrapCdata(value));
    if (v) out.push(v);
  }
  return out;
}

function parseDate(s) {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

/* ──────────────────────────── 图片 ──────────────────────────── */

/**
 * 取某个标签的**原始 HTML**（解实体、解 CDATA，但**不剥标签**）。
 * 摘要/正文里常埋着 <img>，要靠它找配图。
 */
function rawHtmlOf(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(block);
  if (!m) return '';
  return decodeEntities(unwrapCdata(m[1]));
}

/**
 * 从一个 item 块里抠出候选配图地址。
 *
 * 为什么要有优先级：同一个条目里往往有好几种图，含义完全不同。
 *   enclosure / media:thumbnail / media:content —— 作者明确指定的配图
 *   <image>（RSS 1.0）                            —— 频道级配图
 *   摘要/正文里内联的 <img>                       —— 从 HTML 里扒的，混着广告图、表情、
 *                                                   站点 logo、公众号二维码、1x1 像素占位
 * 所以前四种优先，最后才轮到内联图。
 *
 * 这里**只做收集，不做判断**。哪张图值得用（是不是太小、是不是广告条）
 * 要看下载下来的实际字节和尺寸 —— 靠 URL 猜不准，
 * 「logo」「avatar」这些词在正常文章图 URL 里也经常出现。
 * 筛选在 tools/rss-images.mjs 那一层做。
 *
 * @param {string} block   item/entry 的内部 XML
 * @param {string} baseUrl feed 的最终地址（重定向后），用来补相对路径
 * @returns {{url:string, kind:string}[]}  按优先级排好序的候选
 */
export function extractImages(block, baseUrl) {
  const out = [];
  const seen = new Set();

  const push = (raw, kind) => {
    if (!raw) return;
    let s = String(raw).trim();
    if (!s) return;
    s = s.replace(/&amp;/g, '&').replace(/^["']|["']$/g, '');
    if (s.startsWith('//')) s = 'https:' + s;
    else if (s.startsWith('/') && baseUrl) {
      try { s = new URL(s, baseUrl).href; } catch { return; }
    }
    if (!/^https?:\/\//i.test(s)) return;
    if (seen.has(s)) return;
    seen.add(s);
    out.push({ url: s, kind });
  };

  // 1) <enclosure url="..." type="image/*">
  for (const m of block.matchAll(/<enclosure\b[^>]*>/gi)) {
    const u = /url\s*=\s*["']([^"']+)["']/i.exec(m[0]);
    const t = /type\s*=\s*["']([^"']+)["']/i.exec(m[0]);
    if (u && (!t || /image/i.test(t[1]))) push(u[1], 'enclosure');
  }
  // 2) <media:thumbnail url="..."> / 3) <media:content url="..." medium|type=image>
  for (const m of block.matchAll(/<media:(thumbnail|content)\b[^>]*>/gi)) {
    const tag = m[1].toLowerCase();
    const u = /url\s*=\s*["']([^"']+)["']/i.exec(m[0]);
    const t = /type\s*=\s*["']([^"']+)["']/i.exec(m[0]);
    const med = /medium\s*=\s*["']([^"']+)["']/i.exec(m[0]);
    const isImage = (t && /image/i.test(t[1])) || (med && /image/i.test(med[1])) ||
      (tag === 'thumbnail') || (!t && !med && tag === 'content');
    if (u && isImage) push(u[1], tag === 'thumbnail' ? 'media-thumb' : 'media-content');
  }
  // 4) RSS 1.0 的 <image><url>...</url></image>
  for (const m of block.matchAll(/<image\b[^>]*>([\s\S]*?)<\/image>/gi)) {
    const u = /<url>([\s\S]*?)<\/url>/i.exec(m[1]);
    push(u && u[1], 'image');
  }
  // 5) 摘要/正文里内联的 <img src="...">
  //
  //    要扫**两份**：原始块 和 解实体后的摘要/正文。
  //    因为 description 有两种写法：
  //      · CDATA 包着真 HTML  -> <img ...> 原样出现在块里
  //      · 实体转义           -> 块里是 &lt;img ...&gt;，得先解实体才看得见
  //    只扫一份的话，转义的那种源（实测很多）一张图都取不到。
  const inlineSources = [
    block,
    rawHtmlOf(block, 'description'),
    rawHtmlOf(block, 'summary'),
    rawHtmlOf(block, 'content:encoded'),
    rawHtmlOf(block, 'content'),
  ].filter(Boolean);
  for (const src of inlineSources) {
    for (const m of src.matchAll(/<img\b[^>]*>/gi)) {
      const u = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[0]);
      const d = /\bdata-src\s*=\s*["']([^"']+)["']/i.exec(m[0]);
      push((d && d[1]) || (u && u[1]), 'inline');
    }
  }

  // 候选太多时只留前 8 个：内联图常常有十几个，后面基本是页脚和追踪像素。
  return out.slice(0, 8);
}

/**
 * 频道头像：RSS channel <image><url> / itunes:image / Atom logo|icon。
 * 微信 wechat2rss 的公众号头像就在这里（wx.qlogo.cn/mmhead/...）。
 */
export function extractChannelAvatar(xml, baseUrl) {
  if (typeof xml !== 'string' || !xml) return '';
  const head = xml.split(/<(?:item|entry)\b/i)[0] || xml;
  const abs = (raw) => {
    let s = String(raw || '').trim().replace(/&amp;/g, '&').replace(/^["']|["']$/g, '');
    if (!s) return '';
    if (s.startsWith('//')) s = 'https:' + s;
    else if (s.startsWith('/') && baseUrl) {
      try { s = new URL(s, baseUrl).href; } catch { return ''; }
    }
    return /^https?:\/\//i.test(s) ? s : '';
  };
  const itunes = /itunes:image\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(head);
  if (itunes) {
    const u = abs(itunes[1]);
    if (u) return u;
  }
  const image = /<image\b[^>]*>[\s\S]*?<url>([\s\S]*?)<\/url>/i.exec(head);
  if (image) {
    const u = abs(htmlToText(unwrapCdata(image[1])));
    if (u) return u;
  }
  const atom = /<(?:logo|icon)>([\s\S]*?)<\/(?:logo|icon)>/i.exec(head);
  if (atom) {
    const u = abs(htmlToText(unwrapCdata(atom[1])));
    if (u) return u;
  }
  return '';
}

/* ──────────────────────────── 解析 ──────────────────────────── */

/**
 * 从 XML 里抽出条目。RSS 2.0 用 <item>，Atom 用 <entry>。
 *
 * @param {string} xml
 * @param {string} [baseUrl] feed 的最终地址，用来把相对图片地址补成绝对的
 * @returns {{title:string,link:string,ts:number,desc:string,categories:string[],imgs:{url:string,kind:string}[]}[]}
 */
export function parseFeed(xml, baseUrl) {
  if (typeof xml !== 'string' || !xml) return [];
  const cleaned = xml.replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  const re = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(cleaned))) {
    const block = m[2];
    const title = textOf(block, 'title');
    if (!title) continue;
    const link = linkOf(block);
    const dateStr =
      textOf(block, 'pubDate') ||
      textOf(block, 'published') ||
      textOf(block, 'updated') ||
      textOf(block, 'dc:date');
    const desc =
      richTextOf(block, 'description') ||
      richTextOf(block, 'summary') ||
      richTextOf(block, 'content:encoded') ||
      richTextOf(block, 'content');
    // 推文短帖放宽；文章仍截短导读（全文走按需抽取，不入库）
    const twDesc =
      /(?:twitter\.com|x\.com|api\.xgo\.ing|xgo\.ing)/i.test(link + ' ' + (baseUrl || ''));
    out.push({
      title,
      link,
      ts: parseDate(dateStr),
      desc: desc.slice(0, twDesc ? 2000 : 220),
      categories: categoriesOf(block),
      // 候选配图（按优先级排好）。**候选不等于能用** ——
      // 到底哪张合适由 tools/rss-images.mjs 下载后按尺寸/体积筛。
      imgs: extractImages(block, baseUrl),
    });
  }
  return out;
}

/** 判断一段文本到底是不是 RSS/Atom —— 有些站点返回 200 但其实是反爬 HTML */
export function looksLikeFeed(text) {
  if (typeof text !== 'string') return false;
  if (/<html[\s>]/i.test(text.slice(0, 2000))) return false;
  return /<\s*(rss|feed|rdf:RDF)[\s>]/i.test(text);
}

/* ──────────────────────────── 抓取 ──────────────────────────── */

/**
 * 抓一个 feed 的原始内容。用同一套请求头，探测任意 URL 时也走这里，
 * 保证「探测结果」和「正式抓取结果」完全一致。
 *
 * 为什么要重试（2026-11-05 实测）：
 * 国内站点到本机的链路会间歇性超时/断连 —— 一次跑下来 15 个源里有 5 个
 * 超时（少数派发现 / 知乎日报 / V2EX创意 / 博海拾贝 等），
 * 当天的新闻条数直接少三分之一，而且日志只写「抓取失败」，
 * 看不出是网络抖了还是源真的挂了。重试之后这些源都能正常拿到。
 *
 * 只重试**网络层面**的失败：超时、连接被重置、socket 断掉。
 * HTTP 4xx/5xx 和「200 但返回的是反爬页」是站点自己的回答，
 * 重试多少次结果都一样 —— 那两种不重试。
 */
export async function requestFeed(url, timeoutMs, attempts = 3) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await requestOnce(url, timeoutMs);
    } catch (e) {
      lastErr = e;
      if (!isRetryable(e) || i === attempts - 1) throw e;
      await sleep(800 * (i + 1));
    }
  }
  throw lastErr;
}

/** 单次 HTTP 请求（不重试）。重试逻辑在 requestFeed 里。 */
async function requestOnce(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // 故意不带 `*/*`、也不带 `application/atom+xml`：
  // 有些站点对 Accept 头做精确匹配，多一个它不认识的类型就直接回 419。
  // Atom 走 `text/xml` 就够了（Atom 本来就是 XML）。
  // 万一某个源只认 */*，收到 406/415 时再退回去重试一次。
  const narrow = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: 'application/rss+xml, application/xml, text/xml',
  };
  const wide = { ...narrow, Accept: '*/*' };
  try {
    let res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: narrow });
    if (res.status === 406 || res.status === 415) {
      res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: wide });
    }
    if (!res.ok) {
      // 站点自己的回答 —— 重试也不会变好。
      // noRetry 是**防呆标记**：真正拦住它的是 isRetryable 里的正则（那才是判定者），
      // 这个标记只是保证「以后有人放宽正则时，HTTP 错误也不会被重试」。
      const err = new Error(`HTTP ${res.status}`);
      err.noRetry = true;
      throw err;
    }
    const text = await res.text();
    if (!looksLikeFeed(text)) {
      // 返回 200 但不是 feed：多半是反爬页面。同样重试无意义（noRetry 同上，是防呆）。
      const err = new Error('返回的不是 RSS/Atom（多半是反爬页面）');
      err.noRetry = true;
      throw err;
    }
    // res.url 是**重定向后**的最终地址 —— 相对路径的 <img src> 要按它补全，
    // 用请求前那个 URL 补会指向错误的站点。
    const items = parseFeed(text, res.url);
    const channelAvatar = extractChannelAvatar(text, res.url);
    if (channelAvatar) {
      for (const it of items) it.channelAvatar = channelAvatar;
    }
    return { text, items, channelAvatar };
  } finally {
    clearTimeout(timer);
  }
}

/** 只有网络层面的失败才值得重试 */
function isRetryable(err) {
  if (!err || err.noRetry) return false;
  if (err.name === 'AbortError') return true; // 超时
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|terminated|network/i.test(
    String((err && err.message) || err),
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 抓一个源，并丢掉过期条目。
 *
 * 为什么要有这一步（2026-11-05 评审加）：
 * 页面只显示 `MM-DD HH:mm`，**没有年份**。源一旦停更（比如镜像挂了），
 * 去年的文章看起来跟今天的一模一样 —— 知乎日报旧镜像就是这样
 * （最新条目停在 2025-09-16，页面却显示成「09-16」）。
 * 所以按源的最大存活天数把过期条目直接丢掉：
 * 源停更 = 整源从见报里消失（看得见的故障），而不是把上个月的文章当成今天的新闻。
 *
 * 没有时间的条目一律保留 —— 判断不了新旧，不该乱丢。
 */
async function fetchOne(feed, timeoutMs, defaultMaxAgeDays) {
  const r = await requestFeed(feed.url, timeoutMs);
  const days = Number(feed.maxAgeDays) > 0 ? Number(feed.maxAgeDays) : defaultMaxAgeDays;
  const newestTs = r.items.reduce((m, it) => Math.max(m, it.ts || 0), 0);
  if (!days) return { items: r.items, dropped: 0, total: r.items.length, newestTs };
  const cutoff = Date.now() - days * 86400000;
  const items = r.items.filter((it) => !it.ts || it.ts >= cutoff);
  return { items, dropped: r.items.length - items.length, total: r.items.length, newestTs };
}

/**
 * 探测单个 URL 能不能当 RSS 用（加进 rss.config.json 之前先测一下）。
 * @returns {{ok:boolean,count:number,error:string,titles:string[],bytes:number,ms:number,sampleLink:string}}
 */
export async function probeFeed(url, timeoutMs = 15000) {
  const t0 = Date.now();
  try {
    const r = await requestFeed(url, timeoutMs);
    return {
      ok: true,
      count: r.items.length,
      error: '',
      titles: r.items.slice(0, 3).map((i) => i.title),
      bytes: r.text.length,
      ms: Date.now() - t0,
      sampleLink: r.items[0] ? r.items[0].link : '',
    };
  } catch (e) {
    const msg = e.name === 'AbortError' ? `超时 ${timeoutMs}ms` : e.message;
    return {
      ok: false,
      count: 0,
      error: msg,
      titles: [],
      bytes: 0,
      ms: Date.now() - t0,
      sampleLink: '',
    };
  }
}

/* ──────────────────────────── 归一化 ──────────────────────────── */

/** 去掉 hash 和常见追踪参数，用来判重 */
export function normalizeLink(u) {
  const raw = String(u || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    for (const k of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|from$|spm$|share|wx|scene$)/i.test(k)) url.searchParams.delete(k);
    }
    let s = url.origin + url.pathname + url.search;
    if (s.endsWith('/') && url.pathname !== '/') s = s.slice(0, -1);
    return s.toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

/**
 * 条目时间。超过 OLD_STAYS_DAYS 的条目**带上年份**：
 * 页面只有 MM-DD，停更的源会把「三个月前」的文章显示成跟今天一模一样。
 * 前端原样渲染这个字符串，不用改一行前端代码。
 */
const OLD_STAYS_DAYS = 7;
export function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  const ageDays = (Date.now() - d.getTime()) / 86400000;
  if (ageDays > OLD_STAYS_DAYS) {
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  return md;
}

/* ──────────────────────────── 主流程 ──────────────────────────── */

export function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return { enabled: false, feeds: [] };
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.log(`  ! rss.config.json 解析失败：${e.message}`);
    return { enabled: false, feeds: [] };
  }
}

/**
 * 抓所有源，合并去重排序。
 * @returns {{items:object[], tags:string[], sources:string[], failures:{name:string,error:string}[], stale:{name:string,dropped:number,total:number,ageDays:number|null}[]}}
 */
/** 有限并发跑任务，避免 几百源 Promise.all 把 undici 打崩。 */
async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function fetchHeadlines(cfg) {
  const feeds = Array.isArray(cfg.feeds) ? cfg.feeds : [];
  if (!feeds.length) return { items: [], tags: [], sources: [], failures: [], stale: [] };

  const perFeed = Number(cfg.perFeed) > 0 ? Number(cfg.perFeed) : 8;
  const maxItems = Number(cfg.maxItems) > 0 ? Number(cfg.maxItems) : 24;
  const timeoutMs = Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 15000;
  // 过期条目闸门：0 = 不限。默认不启用，配置里显式写死数值。
  const maxAgeDays = Number(cfg.maxAgeDays) > 0 ? Number(cfg.maxAgeDays) : 0;
  // 890 源全开并发会触发 undici Parser.finish 断言；16~24 稳
  const concurrency = Math.max(1, Number(cfg.concurrency) || 20);

  const results = await mapPool(feeds, concurrency, async (feed) => {
    const policy = resolveFeedPolicy(feed, { maxAgeDays, perFeed });
    try {
      // 用 policy 算好的窗（已含源名/格式/feed 字段优先级），避免旧 feed.maxAgeDays=45 盖掉短窗
      const r = await fetchOne(
        { ...feed, maxAgeDays: policy.maxAgeDays },
        timeoutMs,
        policy.maxAgeDays || maxAgeDays,
      );
      return { feed, ...r, ok: true, policy };
    } catch (e) {
      const msg = e.name === 'AbortError' ? `超时 ${timeoutMs}ms` : e.message;
      return { feed, items: [], ok: false, error: msg, policy };
    }
  });

  const failures = [];
  const stale = [];
  const seen = new Set();
  const items = [];
  const policyBySource = new Map();

  for (const r of results) {
    if (!r.ok) {
      failures.push({ name: r.feed.name || r.feed.url, error: r.error });
      continue;
    }
    const policy = r.policy || resolveFeedPolicy(r.feed, { maxAgeDays, perFeed });
    const srcName = r.feed.name || '';
    if (srcName) policyBySource.set(srcName, policy);
    // 过期条目被丢了 —— 记一笔，源停更时要看得见（否则就是「静悄悄地少了个源」）
    if (r.dropped > 0) {
      stale.push({
        name: r.feed.name || r.feed.url,
        dropped: r.dropped,
        total: r.total,
        ageDays: r.newestTs ? Math.round((Date.now() - r.newestTs) / 86400000) : null,
      });
    }
    let taken = 0;
    const ct = r.feed.contentType || r.feed.content_type || '';
    // dailyCap：第一类按白名单收满日窗；二/三类短窗小数；不再给播客地板 50
    const feedCap = Math.max(1, Number(policy.dailyCap) || perFeed);
    for (const it of r.items) {
      if (taken >= feedCap) break;
      const key = normalizeLink(it.link) || it.title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      taken++;
      items.push({
        title: it.title,
        link: it.link,
        source: r.feed.name || '',
        tag: r.feed.tag || r.feed.name || '',
        time: fmtTime(it.ts),
        ts: it.ts,
        desc: it.desc,
        // 候选配图地址 —— 跟上面那些字段一样是逐字段搬过来的，
        // 漏了这一行图片候选到不了构建那一步。
        imgs: it.imgs || [],
        // 频道头像（微信公众号等）—— 写入 metadata.publisher_avatar
        channelAvatar: it.channelAvatar || '',
        // 格式第二轴：rss.config 可写 contentType（article|podcast|video|note|link）
        contentType: ct || undefined,
      });
    }
  }

  // 新的在前；没有时间的排最后
  items.sort((a, b) => (b.ts || 0) - (a.ts || 0));

  // 公平配额：
  //  1) 普通源 fairCap，防无名话痨霸屏
  //  2) 安静源保底 1 条
  //  3) 流水白名单（board/wire/media）按 dailyCap 豁免均分刀
  const srcCount = new Set(items.map((i) => i.source)).size;
  const fairCap = Math.max(2, Math.ceil(maxItems / Math.max(1, srcCount)));
  const fairFor = (it) => {
    const p = policyBySource.get(it.source);
    if (p && p.pipeline) return Math.max(1, p.dailyCap);
    if (p && p.dailyCap > 0) return Math.min(Math.max(fairCap, 1), p.dailyCap);
    return fairCap;
  };

  const kept = [];
  const used = new Map();
  const taken = new Set();

  // 第一轮：每个源保底 1 条
  const firstOf = new Map();
  for (const it of items) {
    if (!firstOf.has(it.source)) firstOf.set(it.source, it);
  }
  for (const it of firstOf.values()) {
    if (kept.length >= maxItems) break;
    kept.push(it);
    taken.add(it);
    used.set(it.source, 1);
  }

  // 第二轮：按时间补齐，受公平配额限制
  for (const it of items) {
    if (kept.length >= maxItems) break;
    if (taken.has(it)) continue;
    const n = used.get(it.source) || 0;
    if (n >= fairFor(it)) continue;
    taken.add(it);
    used.set(it.source, n + 1);
    kept.push(it);
  }

  // 最终整体按时间倒序
  kept.sort((a, b) => (b.ts || 0) - (a.ts || 0));

  const tags = [];
  for (const it of kept) {
    if (it.tag && !tags.includes(it.tag)) tags.push(it.tag);
  }
  const sources = [];
  for (const it of kept) {
    if (it.source && !sources.includes(it.source)) sources.push(it.source);
  }

  return { items: kept, tags, sources, failures, stale };
}

/* ──────────────────────────── CLI ──────────────────────────── */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // --probe <url>：探测单个地址能不能当 RSS 用（加进配置前先测）
  const probeIdx = process.argv.indexOf('--probe');
  if (probeIdx > -1) {
    const url = process.argv[probeIdx + 1];
    if (!url) {
      console.error('用法：node tools/fetch-rss.mjs --probe <url>');
      process.exit(2);
    }
    const r = await probeFeed(url);
    if (r.ok) {
      console.log(`✓ 能抓  ${url}`);
      console.log(`  条目 ${r.count} / ${r.bytes} 字节 / ${r.ms}ms`);
      for (const t of r.titles) console.log(`  · ${t}`);
      if (r.sampleLink) console.log(`  样例链接 ${r.sampleLink}`);
    } else {
      console.log(`✗ 抓不了  ${url}`);
      console.log(`  原因：${r.error}（${r.ms}ms）`);
    }
    process.exit(r.ok ? 0 : 1);
  }

  const cfg = loadConfig();
  if (!cfg.enabled) {
    console.log('RSS 功能已关闭（rss.config.json 里 enabled=false）');
    process.exit(0);
  }
  console.log(`抓取 ${cfg.feeds.length} 个源 …\n`);
  const t0 = Date.now();
  const r = await fetchHeadlines(cfg);
  for (const f of r.failures) {
    console.log(`  [X] ${f.name.padEnd(14)} ${f.error}`);
  }
  for (const s of r.stale || []) {
    console.log(
      `  [!] ${s.name.padEnd(14)} 丢弃 ${s.dropped}/${s.total} 条过期条目（最新条目 ${s.ageDays} 天前）`
    );
  }
  console.log(`\n成功 ${r.items.length} 条 / 标签 ${r.tags.join('、') || '（无）'} / 耗时 ${Date.now() - t0}ms\n`);
  for (const it of r.items.slice(0, 12)) {
    console.log(`  [${it.tag}] ${it.title}`);
    console.log(`      ${it.source} · ${it.time} · ${it.link}`);
  }
  if (r.failures.length) {
    console.log(`\n注意：${r.failures.length} 个源失败，不影响其他源。`);
  }
}
