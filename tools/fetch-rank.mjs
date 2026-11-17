#!/usr/bin/env node
/**
 * 榜单抓取 v2 —— 听乐（多榜单）/ 看片（电影 + 视频），每条带层级标签 tags。
 *
 * 零依赖：只用 Node 内置 API（http/https / fs / path / URL）。
 *
 * ── 为什么在构建期抓 ───────────────────────────────────────────────────────
 *   跟 tools/fetch-rss.mjs 同一个理由：这个站是「每天一份快照」，
 *   榜单要在发布那一刻定格；构建期抓还能在本机跑（国内 IP 直连这几个源很稳）。
 *
 * ── 输出契约（build.mjs 按这个结构读，字段名和顺序一个字都不能改） ────────
 *   { date, generatedAt, music[], movie[], video[], errors[] }
 *     · date        YYYY-MM-DD
 *     · generatedAt 固定零点 '2026-11-16T00:00:00.000Z'
 *                  （**不是**墙上时钟 —— 同一天重跑结果一致，好比对账）
 *     · music / movie / video 三个数组，各自从 rank 1 连号
 *     · 条目 9 个字段（顺序固定）：
 *       rank / title / subtitle / meta / cover / link / source / tag / tags
 *
 * ── tags：层级标签（前端多层 chip 过滤全靠它） ─────────────────────────────
 *   格式 '@<层号>:<值>'；一个条目在它所属的**每一层上恰好有一个**标签。
 *     @1 = 板块（中文榜 / 国际榜 / 场景榜 / 电影 / 视频）
 *     @2 = 分类（热歌榜 / 正在放映 / B站热门 …）
 *   前端把 '@N:' 后面的文字直接当 chip 文案 → 值必须人类可读。
 *
 * ── 抓的源（全部 2026-11-16 实测可用） ───────────────────────────────────
 *   听乐  网易云官方榜单 13 个（每榜最多 50 条）+ Apple Music 官方 RSS（30 条）
 *   看片  电影：猫眼热映榜 + 猫眼即将上映（都带封面）+ 豆瓣 /coming（补量，无封面）
 *         视频：B站热门 popular（50 条）+ 抖音热词榜（50 条，无封面）
 *
 * 用法：
 *   node tools/fetch-rank.mjs --date 2026-11-16
 *   node tools/fetch-rank.mjs --date 2026-11-16 --dry-run
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SRC_LOCAL } from './paths.mjs';

/* ───────────────────────────── 常量 ───────────────────────────── */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 各源基址都做成环境变量可覆盖 —— 护栏要能**完全离线**地跑：
 * 起一个本机 fixture server，把基址指过去就能喂假数据、验行为。
 * 生产环境不设这些变量，走默认值。
 */
function baseUrl(envName, fallback) {
  const v = String(process.env[envName] || '').trim();
  return (v || fallback).replace(/\/+$/, '');
}

const NETEASE_BASE = baseUrl('FETCH_RANK_NETEASE_BASE', 'https://music.163.com');
const APPLE_BASE = baseUrl('FETCH_RANK_APPLE_BASE', 'https://rss.marketingtools.apple.com');
const MAOYAN_BASE = baseUrl('FETCH_RANK_MAOYAN_BASE', 'https://api.maoyan.com');
const MAOYAN_M_BASE = baseUrl('FETCH_RANK_MAOYAN_M_BASE', 'https://m.maoyan.com');
const DOUBAN_BASE = baseUrl('FETCH_RANK_DOUBAN_BASE', 'https://movie.douban.com');
const BILI_BASE = baseUrl('FETCH_RANK_BILI_BASE', 'https://api.bilibili.com');
const DOUYIN_BASE = baseUrl('FETCH_RANK_DOUYIN_BASE', 'https://www.iesdouyin.com');

/**
 * Referer 写死成**生产值**，不跟着基址变 ——
 * Referer 是源的防盗链要求，不是地址；护栏要能断言「请求带对了 Referer」。
 */
const NETEASE_REFERER = 'https://music.163.com/';
const MAOYAN_REFERER = 'https://www.maoyan.com/';
const MAOYAN_M_REFERER = 'https://m.maoyan.com/';
const DOUBAN_REFERER = 'https://movie.douban.com/';
const BILI_REFERER = 'https://www.bilibili.com/';
const DOUYIN_REFERER = 'https://www.douyin.com/';

/** 网易云榜单分组 → 第 1 层 chip 的中文名 */
export const GROUP_LABEL = { cn: '中文榜', intl: '国际榜', scene: '场景榜' };

/**
 * 网易云官方榜单 13 个（id 来自 music.163.com/api/toplist/detail，2026-11-16 实测全部 200）。
 *
 * 顺序很重要：前端第 1 层 chip 是**从元素里推出来的**，
 * 所以这个数组顺序就是用户看到的 chip 顺序 —— 中文榜在前、国际榜居中、场景榜在后。
 */
export const NETEASE_CHARTS = [
  { id: 3778678, label: '热歌榜', group: 'cn' },
  { id: 3779629, label: '新歌榜', group: 'cn' },
  { id: 5059642708, label: '国风榜', group: 'cn' },
  { id: 71384707, label: 'ACG榜', group: 'cn' },
  { id: 991319590, label: '中文说唱榜', group: 'cn' },
  { id: 2884035, label: '原创榜', group: 'cn' },
  { id: 745956260, label: '韩语榜', group: 'intl' },
  { id: 60198, label: 'Billboard', group: 'intl' },
  { id: 60131, label: '日本Oricon', group: 'intl' },
  { id: 180106, label: 'UK周榜', group: 'intl' },
  { id: 19723756, label: '飙升榜', group: 'scene' },
  { id: 5338990334, label: '潜力爆款', group: 'scene' },
  { id: 8246775932, label: '实时热度', group: 'scene' },
];

/** 每榜最多取几条 */
const NETEASE_LIMIT = 50;
const APPLE_LIMIT = 30;
const BILI_LIMIT = 50;
const DOUYIN_LIMIT = 50;

/**
 * 榜单停更多久算「老榜」。
 * 网易云有些榜（如潜力爆款）已经大半年没更新了 —— 留着只会给出过时的热度，
 * 直接跳过（记一条说明到日志，**不进 errors**：源本身没坏）。
 */
const STALE_CHART_MS = 30 * 24 * 3600 * 1000;

/** 每个封面 host 抽查几条（host 活着 ≠ 每张图都活着） */
const COVER_SAMPLES_PER_HOST = 4;

/** 顶层字段 —— 契约就是这个顺序，一个字都不能改 */
export const TOP_FIELDS = ['date', 'generatedAt', 'music', 'movie', 'video', 'errors'];

/** 条目字段 —— 契约就是这个顺序，一个字都不能改 */
export const ITEM_FIELDS = ['rank', 'title', 'subtitle', 'meta', 'cover', 'link', 'source', 'tag', 'tags'];

/* ───────────────────────────── HTTP ───────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECT_DEPTH = 6;

/**
 * 一次请求（**不**跟跳转）。http / https 都支持 ——
 * 护栏的本机 fixture server 走 http，生产走 https。
 */
function rawGet(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(
      url,
      {
        headers: {
          'User-Agent': UA,
          Accept: '*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          ...headers,
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        const location = res.headers.location || '';
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status, text, location }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      try { req.destroy(new Error(`超时 ${timeoutMs}ms`)); } catch { /* ignore */ }
    });
  });
}

/**
 * 自己逐跳跟随跳转，**不用** fetch 的 redirect:'follow'。
 *
 * 为什么：豆瓣的 301 是「软跳转」—— 响应体里写着
 * "Your browser should have redirected you to <真实地址>"，
 * 而 Location 指的地方还会再 301 一次；undici 在这条链上会停在 301
 * 只拿到跳转提示页，于是正文和链接一起丢（实测）。
 * 原型 tools/proto-v2.mjs 里这套实现已验证可用，这里照抄（depth 上限 6）。
 */
async function followGet(url, headers, timeoutMs, depth = 0) {
  const res = await rawGet(url, headers, timeoutMs);
  if (REDIRECT_CODES.has(res.status) && res.location && depth < MAX_REDIRECT_DEPTH) {
    const next = new URL(res.location, url).href;
    return followGet(next, headers, timeoutMs, depth + 1);
  }
  return res;
}

/**
 * 带重试的 GET（返回文本）。
 *
 * 重试策略：网络层错误（ECONNRESET 之类）+ 429/5xx 重试 2 次（退避 1s / 3s）——
 * 到境外链路会间歇 ECONNRESET，重试基本都能救回来；
 * 其它 4xx 是站点自己的回答，重试没有意义，直接失败。
 */
async function httpGet(url, { headers = {}, timeoutMs = 20000, attempts = 3, backoffMs = [1000, 3000] } = {}) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await followGet(url, headers, timeoutMs);
      if (res.status >= 200 && res.status < 300) return res.text;
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    } catch (e) {
      lastErr = e;
      const retryable = e && e.status ? e.status === 429 || e.status >= 500 : true;
      if (!retryable || i === attempts - 1) throw e;
      await sleep(backoffMs[Math.min(i, backoffMs.length - 1)]);
    }
  }
  throw lastErr;
}

/** GET + 解析 JSON（源返回的不是 JSON 就当失败） */
async function httpJson(url, opts) {
  const text = await httpGet(url, opts);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`不是 JSON（前 120 字：${text.slice(0, 120)}）`);
  }
}

/* ───────────────────────────── 文本工具 ───────────────────────────── */

function codePoint(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

/**
 * 解 HTML 实体。
 * &amp; 放最后解 —— 否则 &amp;nbsp; 会被解两次（先成 &nbsp;，再成空格）。
 */
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codePoint(parseInt(d, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&middot;/gi, '·')
    .replace(/&hellip;/gi, '…')
    .replace(/&mdash;/gi, '—')
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&lsquo;|&rsquo;/gi, "'")
    .replace(/&amp;/gi, '&');
}

/** 剥标签 + 压空白 */
function stripTags(s) {
  return String(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** HTML 片段 → 纯文本 */
function textOf(html) {
  return stripTags(decodeEntities(html));
}

/**
 * http:// 开头换成 https://，其它原样返回。
 *
 * 为什么必须有：页面本身是 https，浏览器会把 http 图片按 mixed content 拦掉
 * （网易云 album.picUrl、B站 pic 实测全是 http://）。
 */
export function toHttps(url) {
  const s = String(url || '');
  return s.startsWith('http://') ? 'https://' + s.slice('http://'.length) : s;
}

/** 播放数 → 「51万」/「9999」/「1.2亿」 */
export function formatCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v < 10000) return String(v);
  if (v < 100000000) {
    const w = (v / 10000).toFixed(1);
    return (w.endsWith('.0') ? w.slice(0, -2) : w) + '万';
  }
  const y = (v / 100000000).toFixed(1);
  return (y.endsWith('.0') ? y.slice(0, -2) : y) + '亿';
}

/**
 * 上映日 → 可比较的排序键。
 *
 * 猫眼给的是 'YYYY-MM-DD'，豆瓣表格给的多半也是；给不出日期的一律排最后
 * （'9999-99-99' 比任何 '9999-12-31' 都大）。
 */
export function releaseSortKey(rt) {
  const s = String(rt || '').trim();
  if (!s) return '9999-99-99';
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}`;
  const cn = s.match(/^(\d{1,2})月(\d{1,2})日/);
  if (cn) return `9999-${String(cn[1]).padStart(2, '0')}-${String(cn[2]).padStart(2, '0')}`;
  return '9999-99-99';
}

/* ───────────────────────────── 听乐 ───────────────────────────── */

/**
 * 网易云榜单 → 条目数组。吃 JSON 字符串或已解析的对象都行。
 *
 * 坑（实测）：封面 album.picUrl 是 http:// —— 必须换 https，
 * 否则页面是 https 时图片会被 mixed content 拦掉。
 */
export function parseNeteaseChart(rawJson, chart) {
  const data = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
  const tracks = (data && data.result && data.result.tracks) || [];
  const groupLabel = GROUP_LABEL[chart.group] || chart.group;
  const out = [];
  for (const t of tracks) {
    if (!t) continue;
    const title = String(t.name || '').trim();
    if (!title) continue;
    const artists = (Array.isArray(t.artists) ? t.artists : [])
      .map((a) => (a && a.name ? String(a.name).trim() : ''))
      .filter(Boolean);
    const album = t.album || {};
    out.push({
      rank: 0, // 统一在外层按顺序编号
      title,
      subtitle: artists.join(' / '),
      meta: String(album.name || '').trim(),
      cover: toHttps(album.picUrl || ''),
      link: `https://music.163.com/#/song?id=${t.id}`,
      source: '网易云音乐',
      tag: chart.label,
      tags: [`@1:${groupLabel}`, `@2:${chart.label}`],
    });
  }
  return out;
}

/**
 * Apple Music 官方 RSS → 条目数组。
 *
 * 坑（实测）：老域名 rss.applemarketingtools.com 已 301 迁到
 * rss.marketingtools.apple.com —— 用后者。封面 100x100bb 换成 200x200bb 取大图。
 */
export function parseAppleFeed(rawJson, label = 'Apple Top Songs') {
  const data = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
  const results = (data && data.feed && data.feed.results) || [];
  const out = [];
  for (const r of results) {
    if (!r) continue;
    const title = String(r.name || '').trim();
    if (!title) continue;
    out.push({
      rank: 0,
      title,
      subtitle: String(r.artistName || '').trim(),
      meta: String(r.albumName || '').trim(),
      cover: toHttps(r.artworkUrl100 || '').replace('100x100bb', '200x200bb'),
      link: String(r.url || ''),
      source: 'Apple Music',
      tag: label,
      tags: ['@1:国际榜', `@2:${label}`],
    });
  }
  return out;
}

/* ───────────────────────────── 看片 · 电影 ───────────────────────────── */

/**
 * 猫眼图床是 qiniu 系 —— 原图 **430 KB**（列表里只显示 56×56），
 * 必须用图床参数裁成小图，否则看片 tab 每屏要拉好几 MB。
 *
 * 实测：`?imageMogr2/thumbnail/200x200^/gravity/center/crop/200x200/quality/80` → **39 KB**（11 倍↓）。
 * ⚠️ 不要用 `thumbnail/!200x200`（那是「不裁剪只限制最长边」）—— 实测反而涨到 559 KB。
 * 实现方式：把 img 里原有的 `?...` 整段替换掉。
 */
export function maoyanCover(url) {
  const s = toHttps(url || '');
  if (!s) return '';
  return s.replace(/\?.*$/, '') +
    '?imageMogr2/thumbnail/200x200^/gravity/center/crop/200x200/quality/80';
}

/**
 * 猫眼条目（热映榜 / 即将上映列表，字段完全一致）→ 条目数组。
 *
 * globalReleased === false → 「近期即将上映」，否则「正在放映」。
 */
export function parseMaoyan(list) {
  const out = [];
  for (const h of list || []) {
    if (!h) continue;
    const title = String(h.nm || '').trim();
    if (!title) continue;
    const tag = h.globalReleased === false ? '近期即将上映' : '正在放映';
    out.push({
      rank: 0,
      title,
      subtitle: String(h.star || '').trim(),
      meta: [
        h.sc ? `${h.sc} 分` : '',
        h.wish ? `${h.wish} 人想看` : '',
        h.showInfo ? String(h.showInfo) : '',
      ].filter(Boolean).join(' · '),
      cover: maoyanCover(h.img),
      link: h.id ? `https://www.maoyan.com/films/${h.id}` : '',
      source: '猫眼',
      tag,
      tags: ['@1:电影', `@2:${tag}`],
      /* 内部字段：排序用。normalizeItem 会把它丢掉，不进契约。 */
      sortKey: releaseSortKey(h.rt),
    });
  }
  return out;
}

/**
 * 豆瓣「即将上映」→ 条目数组。
 *
 * 这页是**表格**（每行 5 个 <td>）：上映日期 / 片名链接 / 类型 / 制片国家地区 / 想看人数。
 * ⚠️ 表格页**没有海报字段** → cover 只能留空（前端渲染文字卡）。
 *   豆瓣图床还防盗链：裸连 418、第三方 Referer 403，只有 Referer: https://movie.douban.com/ 才 200
 *   → 外站根本拿不到，不要试图绕过。
 * 作用是**补量**（实测 22 条，比猫眼 comingList 多），封面由猫眼那批兜底。
 */
export function parseDoubanComing(html) {
  const text = String(html || '');
  const rows = text.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  const out = [];
  for (const row of rows) {
    const tds = row.match(/<td[^>]*>[\s\S]*?<\/td>/g) || [];
    if (tds.length < 5) continue;
    const cells = tds.map((td) => textOf(td));
    const a = row.match(/<a\b[^>]*\bhref="(https:\/\/movie\.douban\.com\/subject\/\d+\/?)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const title = textOf(a[2]) || cells[1];
    if (!title) continue;
    const want = (cells[4] || '').match(/(\d[\d,]*)/);
    out.push({
      rank: 0,
      title,
      subtitle: cells[2] || '',
      meta: [
        cells[0] ? `${cells[0]} 上映` : '',
        cells[3] || '',
        want ? `${want[1]} 人想看` : '',
      ].filter(Boolean).join(' · '),
      cover: '',
      link: a[1],
      source: '豆瓣',
      tag: '近期即将上映',
      tags: ['@1:电影', '@2:近期即将上映'],
      sortKey: releaseSortKey(cells[0]),
    });
  }
  return out;
}

/**
 * 片名去重（猫眼和豆瓣有重叠，先出现的留下）。
 *
 * 用**片名**当键：猫眼 / 豆瓣的 id 不是一套，没法按 id 去重；
 * 片名重复在电影数据里基本就是同一部片。
 */
export function dedupeByTitle(items) {
  const seen = new Set();
  const out = [];
  for (const it of items || []) {
    const key = String(it.title || '').trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/**
 * 电影排序：**有封面的排在前面**（用户明确要求「尽量有图的靠前」），
 * 同一组内按上映日升序，上映日相同的按源顺序（猫眼在前、豆瓣在后）。
 *
 * 源顺序靠「稳定排序 + 不打乱原数组」保住（V8 的 Array#sort 是稳定的）。
 */
export function sortMovieItems(items) {
  return (items || [])
    .map((it, i) => ({ it, i }))
    .sort((a, b) => {
      const ha = a.it.cover ? 0 : 1;
      const hb = b.it.cover ? 0 : 1;
      if (ha !== hb) return ha - hb;
      const ka = a.it.sortKey || '9999-99-99';
      const kb = b.it.sortKey || '9999-99-99';
      if (ka !== kb) return ka < kb ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => x.it);
}

/* ───────────────────────────── 看片 · 视频 ───────────────────────────── */

/** B站热门 → 条目数组。吃 JSON 字符串或已解析的对象都行。 */
export function parseBiliPopular(rawJson) {
  const data = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
  const list = (data && data.data && data.data.list) || [];
  const out = [];
  for (const v of list) {
    if (!v) continue;
    const title = String(v.title || '').trim();
    if (!title) continue;
    const view = v.stat && v.stat.view;
    const bvid = String(v.bvid || '').trim();
    out.push({
      rank: 0,
      title,
      subtitle: String((v.owner && v.owner.name) || '').trim(),
      meta: formatCount(view) ? `播放 ${formatCount(view)}` : '',
      cover: toHttps(v.pic || ''),
      link: bvid ? `https://www.bilibili.com/video/${bvid}` : toHttps(v.short_link_v2 || ''),
      source: '哔哩哔哩',
      tag: 'B站热门',
      /* 2026-11-16 v3：B站热门从 @2 提到 @1 —— 看片 tab 的大目录直接是
         「频道更新 / 电影 / B站热门 / 抖音热门 / 本地演出」，
         原来的 @1:视频 这个壳去掉了（壳下面只有 B站热门 一档，留着只是多一次点击）。 */
      tags: ['@1:B站热门'],
    });
  }
  return out;
}

/**
 * 抖音热词榜 → 条目数组。
 *
 * ⚠️ 用的是精简版 iesdouyin 接口：完整版的封面在 p*-sign.douyinpic.com 上带签名
 *    且约 24 小时过期（x-expires），次日必裂。精简版**没有封面字段** →
 *    cover 留空，前端渲染占位框。
 * ⚠️ 它是**热搜词榜**不是热门视频榜：标题只有词，没有具体视频 → link 拼搜索页。
 */
export function parseDouyinHot(rawJson) {
  const data = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
  const words = (data && data.word_list) || [];
  const out = [];
  for (const w of words) {
    if (!w) continue;
    const word = String(w.word || '').trim();
    if (!word) continue;
    out.push({
      rank: 0,
      title: word,
      subtitle: '',
      meta: w.hot_value ? `热度 ${w.hot_value}` : '',
      cover: '',
      link: `https://www.douyin.com/search/${encodeURIComponent(word)}`,
      source: '抖音',
      tag: '抖音热门',
      /* 同上：抖音热门升为 @1，跟 B站热门 平级当大目录。 */
      tags: ['@1:抖音热门'],
    });
  }
  return out;
}

/* ───────────────────────────── 输出契约 ───────────────────────────── */

/**
 * 把条目压成契约里那 9 个字段（顺序也定死）。
 * 多余的字段（比如内部的 sortKey）在这里被丢掉。
 */
function normalizeItem(item, rank) {
  const src = item || {};
  const out = { rank };
  for (const f of ITEM_FIELDS.slice(1, 8)) {
    out[f] = src[f] === undefined || src[f] === null ? '' : String(src[f]);
  }
  out.tags = Array.isArray(src.tags) ? src.tags.filter((t) => typeof t === 'string' && t) : [];
  return out;
}

/**
 * 组装最终 JSON 对象。
 *
 * generatedAt 取「当天 00:00:00Z」而不是墙上时钟 —— 契约里写的就是这个形状
 * （"2026-11-16T00:00:00.000Z"），而且同一天重跑结果一致，好比对账。
 */
export function buildRankPayload({ music = [], movie = [], video = [], date = '', errors = [] } = {}) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? String(date) : new Date().toISOString().slice(0, 10);
  return {
    date: d,
    generatedAt: `${d}T00:00:00.000Z`,
    music: music.map((it, i) => normalizeItem(it, i + 1)),
    movie: movie.map((it, i) => normalizeItem(it, i + 1)),
    video: video.map((it, i) => normalizeItem(it, i + 1)),
    errors: Array.isArray(errors) ? errors.map((e) => String(e)) : [],
  };
}

/** 榜单 JSON 的落盘位置：<SRC_LOCAL>/<date>/rank_<date>.json */
export function rankFilePath(date) {
  return path.join(SRC_LOCAL, String(date), `rank_${date}.json`);
}

/* ───────────────────────────── 封面可达性 ───────────────────────────── */

/**
 * 探一张封面能不能直连。
 *
 * 刻意**不带 Referer** —— 那才是「外站直连」的真相：
 * 页面里最终是前端直接 <img src>，带不带 Referer 由浏览器说了算。
 */
export function probeCover(url) {
  return new Promise((resolve) => {
    let mod;
    try {
      mod = url.startsWith('https:') ? https : http;
    } catch {
      resolve(false);
      return;
    }
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    const req = mod.get(
      url,
      { headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' } },
      (res) => {
        const status = res.statusCode || 0;
        res.destroy();
        finish(status >= 200 && status < 300);
      },
    );
    req.on('error', () => finish(false));
    req.setTimeout(9000, () => {
      try { req.destroy(); } catch { /* ignore */ }
      finish(false);
    });
  });
}

/** 从一段下标里均匀挑 k 个 */
function pickEvenly(list, k) {
  if (list.length <= k) return list.slice();
  const out = [];
  for (let i = 0; i < k; i++) {
    out.push(list[Math.round((i * (list.length - 1)) / (k - 1))]);
  }
  return [...new Set(out)];
}

/**
 * 验封面：坏图的条目 cover 置空（留空位让前端渲染文字卡）。
 *
 * **按 host 分组验**，别一条条请求 —— 逐个探会把 CDN 打到限流，
 * 反而把好图也判成坏的。每个 host 先探 1 张，活着再均匀抽 4 张。
 */
export async function verifyCovers(items, { samplePerHost = COVER_SAMPLES_PER_HOST, probe = probeCover } = {}) {
  const groups = new Map();
  items.forEach((it, i) => {
    if (!it || !it.cover) return;
    let host;
    try {
      host = new URL(it.cover).host;
    } catch {
      return;
    }
    if (!groups.has(host)) groups.set(host, []);
    groups.get(host).push(i);
  });

  let probed = 0;
  let blanked = 0;
  const blockedHosts = [];

  for (const [host, idxs] of groups) {
    probed++;
    const ok = await probe(items[idxs[0]].cover);
    if (!ok) {
      blockedHosts.push(host);
      for (const i of idxs) {
        items[i].cover = '';
        blanked++;
      }
      continue;
    }
    for (const i of pickEvenly(idxs, samplePerHost)) {
      probed++;
      if (!(await probe(items[i].cover))) {
        items[i].cover = '';
        blanked++;
      }
    }
  }

  return { hosts: groups.size, probed, blanked, blockedHosts };
}

/* ───────────────────────────── 编排 ───────────────────────────── */

/**
 * 结构自检：源返回了 N 条、我们却解析出 0 条 → 抛错（源可能改版了）。
 *
 * 这是「静默失败」的最后一道闸：源挂了会走 catch 进 errors；
 * 源活着但字段名变了，旧代码会写出 0 条还当没事发生。
 */
export function assertParsed(rawCount, items) {
  const n = Array.isArray(items) ? items.length : 0;
  if (n) return items;
  const raw = typeof rawCount === 'number' ? rawCount : 0;
  throw new Error(raw > 0 ? `解析出 0 条（源结构可能变了，源返回 ${raw} 条）` : '源返回 0 条');
}

/**
 * 跑一个源：失败只记 error，不炸整个命令。
 *
 * fn 返回 { items, rawCount }；rawCount 是**源原始计数**，
 * 用来区分「源本身空了」和「源有数据但我们解析不出来（改版了）」。
 * fn 返回 { skip: true, note } 表示「源没坏，但这一档不要」（比如停更老榜）。
 */
export async function runSource(name, fn, errors) {
  const t0 = Date.now();
  try {
    const res = (await fn()) || {};
    if (res.skip) {
      return { name, items: [], ms: Date.now() - t0, error: '', skipped: true, note: res.note || '' };
    }
    const items = res.items || [];
    const rawCount = typeof res.rawCount === 'number' ? res.rawCount : items.length;
    assertParsed(rawCount, items);
    return { name, items, ms: Date.now() - t0, error: '', skipped: false, note: '' };
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    errors.push(`${name}: ${msg}`);
    return { name, items: [], ms: Date.now() - t0, error: msg, skipped: false, note: '' };
  }
}

/**
 * 抓所有源，组装成最终 payload。
 *
 * 任何一个源失败都不影响其它源（失败进 errors）；全挂了由调用方决定退出码。
 */
export async function fetchRank({ date = '', checkCovers = true, now = Date.now() } = {}) {
  const errors = [];
  const notes = [];
  const sources = [];
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? String(date) : new Date().toISOString().slice(0, 10);

  /* ── 听乐：网易云 13 榜（顺序 = 前端 chip 顺序） ── */
  const music = [];
  for (const chart of NETEASE_CHARTS) {
    const r = await runSource(
      `网易云 ${chart.label}`,
      async () => {
        const j = await httpJson(`${NETEASE_BASE}/api/playlist/detail?id=${chart.id}`, {
          headers: { Referer: NETEASE_REFERER },
        });
        const tracks = (j && j.result && j.result.tracks) || [];
        const updateTime = j && j.result && j.result.updateTime ? Number(j.result.updateTime) : 0;
        if (updateTime && now - updateTime > STALE_CHART_MS) {
          return {
            skip: true,
            note: `网易云 ${chart.label}: 停更老榜（最后更新 ${new Date(updateTime).toISOString().slice(0, 10)}）→ 跳过`,
          };
        }
        return { items: parseNeteaseChart(j, chart).slice(0, NETEASE_LIMIT), rawCount: tracks.length };
      },
      errors,
    );
    if (r.note) notes.push(r.note);
    music.push(...r.items);
    sources.push(r);
  }

  /* ── 听乐：Apple Music 官方 RSS（排在最后） ── */
  {
    const r = await runSource(
      'Apple Top Songs',
      async () => {
        /* ⚠️ 这是唯一的境外链路 —— 实测单次要 20~25s，默认 20s 超时经常刚好踩线。
           给它 40s：宁可多等，也不要把这一档整个丢掉（丢了第 1 层的「国际榜」就少一块）。 */
        const j = await httpJson(`${APPLE_BASE}/api/v2/us/music/most-played/30/songs.json`, {
          timeoutMs: 40000,
        });
        const results = (j && j.feed && j.feed.results) || [];
        return { items: parseAppleFeed(j).slice(0, APPLE_LIMIT), rawCount: results.length };
      },
      errors,
    );
    music.push(...r.items);
    sources.push(r);
  }

  /* ── 看片 · 电影：猫眼热映榜 ── */
  const maoyanHot = await runSource(
    '猫眼 热映榜',
    async () => {
      const j = await httpJson(`${MAOYAN_BASE}/mmdb/movie/v5/list/hot.json?ci=1`, {
        headers: { Referer: MAOYAN_REFERER },
      });
      const hot = (j && j.data && j.data.hot) || [];
      return { items: parseMaoyan(hot), rawCount: hot.length };
    },
    errors,
  );
  sources.push(maoyanHot);

  /* ── 看片 · 电影：猫眼「即将上映」（带封面的主力源） ── */
  const maoyanComing = await runSource(
    '猫眼 即将上映',
    async () => {
      const j = await httpJson(`${MAOYAN_M_BASE}/ajax/comingList?token=&ci=1`, {
        headers: { Referer: MAOYAN_M_REFERER },
      });
      const coming = (j && j.coming) || [];
      return { items: parseMaoyan(coming), rawCount: coming.length };
    },
    errors,
  );
  sources.push(maoyanComing);

  /* ── 看片 · 电影：豆瓣「即将上映」（补量，表格页没封面） ── */
  const doubanComing = await runSource(
    '豆瓣 即将上映',
    async () => {
      const html = await httpGet(`${DOUBAN_BASE}/coming`, { headers: { Referer: DOUBAN_REFERER } });
      const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
      return { items: parseDoubanComing(html), rawCount: rows.length };
    },
    errors,
  );
  sources.push(doubanComing);

  /* ── 看片 · 视频：B站热门 ── */
  const bili = await runSource(
    'B站热门',
    async () => {
      const j = await httpJson(`${BILI_BASE}/x/web-interface/popular?ps=50&pn=1`, {
        headers: { Referer: BILI_REFERER },
      });
      if (j && j.code !== undefined && j.code !== 0) {
        throw new Error(`接口返回 code=${j.code}${j.message ? ' message=' + j.message : ''}`);
      }
      const list = (j && j.data && j.data.list) || [];
      return { items: parseBiliPopular(j).slice(0, BILI_LIMIT), rawCount: list.length };
    },
    errors,
  );
  sources.push(bili);

  /* ── 看片 · 视频：抖音热词 ── */
  const douyin = await runSource(
    '抖音热门',
    async () => {
      const j = await httpJson(`${DOUYIN_BASE}/web/api/v2/hotsearch/billboard/word/`, {
        headers: { Referer: DOUYIN_REFERER },
      });
      const words = (j && j.word_list) || [];
      return { items: parseDouyinHot(j).slice(0, DOUYIN_LIMIT), rawCount: words.length };
    },
    errors,
  );
  sources.push(douyin);

  /* ── 电影：去重 → 排序（有封面的靠前）→ 统一编号 ── */
  const movie = sortMovieItems(dedupeByTitle([...maoyanHot.items, ...maoyanComing.items, ...doubanComing.items]));

  /* ── 视频：B站在前、抖音在后 ── */
  const video = [...bili.items, ...douyin.items];

  /* ── 验封面（坏图 → cover 置空） ── */
  let coverInfo = null;
  if (checkCovers) {
    coverInfo = await verifyCovers([...music, ...movie, ...video]);
  }

  const payload = buildRankPayload({ music, movie, video, date: d, errors });

  return {
    payload,
    sources,
    notes,
    coverInfo,
    allFailed: music.length === 0 && movie.length === 0 && video.length === 0,
  };
}

/* ───────────────────────────── CLI ───────────────────────────── */

/** 北京时区的今天（不能用本机时区 —— 差一天就是差一期） */
export function beijingToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => (parts.find((p) => p.type === t) || { value: '' }).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function parseArgs(argv) {
  const out = { date: '', dryRun: false, help: false, checkCovers: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') out.date = String(argv[++i] || '').trim();
    else if (a.startsWith('--date=')) out.date = a.slice('--date='.length).trim();
    else if (a === '--dry-run' || a === '--dry') out.dryRun = true;
    else if (a === '--skip-cover-check') out.checkCovers = false;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function usage() {
  return [
    '用法：',
    '  node tools/fetch-rank.mjs --date 2026-11-16              抓取并写文件',
    '  node tools/fetch-rank.mjs --date 2026-11-16 --dry-run    只抓取并打印统计',
    '',
    '  --date <YYYY-MM-DD>   期号（缺省 = 北京今天）',
    '  --dry-run             不写文件',
    '  --skip-cover-check    不验封面可达性（默认验）',
    '  --help                打印本用法',
  ].join('\n');
}

/** 中文按两个宽度算，输出才对得齐 */
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  }
  return w;
}

function padDisplay(s, width) {
  const t = String(s);
  return t + ' '.repeat(Math.max(0, width - displayWidth(t)));
}

/**
 * CLI 主体。返回退出码：0 正常 / 2 日期非法 / 1 所有源全挂。
 */
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const date = args.date || beijingToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`日期格式不对：${date}（要 YYYY-MM-DD）`);
    console.error(usage());
    return 2;
  }

  console.log(`\n榜单抓取  ${date}\n`);
  const t0 = Date.now();
  const r = await fetchRank({ date, checkCovers: args.checkCovers });

  for (const s of r.sources) {
    const mark = s.error ? '失败' : s.skipped ? '跳过' : 'OK  ';
    console.log(
      `  [${mark}] ${padDisplay(s.name, 16)}${padDisplay(s.items.length + ' 条', 8)}${padDisplay(s.ms + 'ms', 8)}` +
        (s.error ? `  ${s.error}` : ''),
    );
  }

  if (r.notes.length) {
    console.log('\n说明：');
    for (const n of r.notes) console.log(`  - ${n}`);
  }

  if (r.coverInfo) {
    const c = r.coverInfo;
    console.log(
      `\n  封面：${c.hosts} 个 host / 探测 ${c.probed} 次 / 置空 ${c.blanked} 条` +
        (c.blockedHosts.length ? `（防盗链：${c.blockedHosts.join(', ')}）` : ''),
    );
  }

  const p = r.payload;
  console.log(`\n听乐 ${p.music.length} / 电影 ${p.movie.length} / 视频 ${p.video.length} / 耗时 ${Date.now() - t0}ms`);
  if (p.errors.length) {
    console.log('\n失败摘要：');
    for (const e of p.errors) console.log(`  - ${e}`);
  }

  if (args.dryRun) {
    console.log('\n--dry-run：不写文件。');
  } else {
    const file = rankFilePath(date);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(p, null, 2) + '\n', 'utf8');
    console.log(`\n写入  ${file}`);
  }

  if (r.allFailed) {
    console.error('\n所有源全挂了 —— 没有榜单可写。');
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error('榜单抓取失败：', err && err.message ? err.message : err);
      process.exitCode = 1;
    });
}
