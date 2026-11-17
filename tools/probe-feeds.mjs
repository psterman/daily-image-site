#!/usr/bin/env node
/**
 * 批量探测候选 RSS 源：能不能抓、条目数、最新一条是什么时候。
 *
 * 用 fetch-rss.mjs **同一个** requestFeed，保证探测结果和正式抓取完全一致
 * （包括「什么该重试、什么不该重试」这套策略 —— 早先这里自己抄了一份，
 *  探测会重试 3 次反爬页，正式抓取不重试，两边对不上）。
 *
 * 用途：**往「见报」加源之前先跑一遍**，别拿「Folo 里能刷到」当能抓的证据 ——
 * Folo 自己抓得到不代表本机服务端请求能过（2026-11-05 实测：linux.do / 36氪(无 www)
 * / APPSO / 异次元 / 小众软件 在 Folo 里都能刷到，本机服务端抓不动）。
 *
 * 单个源用 `node tools/fetch-rss.mjs --probe <url>` 就行；
 * 这个脚本是「一次验一大批」。
 *
 * 候选来源：
 *   1. 手写清单（国内媒体 / 社区 / 资讯）
 *   2. tidings-rss 的 news / communities 两个 OPML 合集
 *
 * 语言过滤（2026-11-05 用户要求）：**只留中文源**，英文源一律不进候选清单。
 *   - 列清单时：合集条目按「标题里有汉字」筛掉英文源
 *   - 探测完再复核：按「最近条目标题里中文占比」剔掉标题是中文、内容是英文的源
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestFeed } from './fetch-rss.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(__dirname, '..', 'docs');
const OUT_TSV = path.join(DOCS, 'rss-candidates.tsv');
const OUT_MD = path.join(DOCS, 'rss-candidates.md');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 中文判定：标题里有没有汉字 */
const CN_RE = /[一-鿿]/;
/** 中文占比门槛：最近条目标题里中文少于这个比例就算英文源，剔掉 */
const ZH_MIN_RATIO = 0.2;
/** 过期门槛：直接读 tools/rss.config.json 的 maxAgeDays，别在这里写死两份 */
const STALE_DAYS = (() => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'rss.config.json'), 'utf8'));
    return Number(cfg.maxAgeDays) > 0 ? Number(cfg.maxAgeDays) : 10;
  } catch {
    return 10;
  }
})();

/* ── 候选清单 ── */

const CURATED = [
  // 国际资讯
  ['每日环球视野(feedx)', 'https://feedx.net/rss/idaily.xml', '资讯'],
  ['每日环球视野(RSSHub)', 'https://rsshub.app/idaily/today', '资讯'],
  ['卫星社中文A', 'https://sputniknews.cn/export/rss2/archive/index.xml', '资讯'],
  ['卫星社中文B', 'https://zh.sputniknews.cn/export/rss2/archive/index.xml', '资讯'],
  ['卫星社中文C', 'https://sputniknews.cn/rss', '资讯'],
  ['卫星社中文D', 'https://sputniknews.cn/export/rss2/news/index.xml', '资讯'],
  ['BBC中文', 'https://feeds.bbci.co.uk/zhongwen/simp/rss.xml', '资讯'],
  ['联合早报中国', 'https://www.zaobao.com/realtime/china/rss.xml', '资讯'],
  ['法广中文', 'https://www.rfi.fr/cn/rss', '资讯'],
  ['纽约时报中文', 'https://cn.nytimes.com/rss/', '资讯'],
  ['参考消息', 'https://rss.cankaoxiaoxi.com/', '资讯'],
  ['澎湃新闻', 'https://feedx.net/rss/thepaper.xml', '资讯'],
  ['环球时报', 'https://feedx.net/rss/huanqiu.xml', '资讯'],
  ['德国之声中文', 'https://rss.dw.com/rdf/rss-chi-all', '资讯'],
  ['纽约时报中文网', 'https://cn.nyt.com/rss/', '资讯'],
  ['FT中文网', 'https://www.ftchinese.com/rss/feed', '资讯'],
  ['路透中文', 'https://cn.reuters.com/rssFeed/CNTopGenNews', '资讯'],
  ['香港01', 'https://www.hk01.com/rss', '资讯'],

  // 社区讨论
  ['linux.do', 'https://linux.do/latest.rss', '社区'],
  ['V2EX首页', 'https://www.v2ex.com/index.xml', '社区'],
  ['V2EX热榜', 'https://rsshub.app/v2ex/topics/hot', '社区'],
  ['NodeSeek', 'https://nodeseek.com/rss', '社区'],
  ['知乎每日精选', 'https://rsshub.app/zhihu/daily', '社区'],
  ['什么值得买好文', 'https://rsshub.app/smzdm/haowen/7', '社区'],
  ['雪球热帖', 'https://rsshub.app/xueqiu/hots', '社区'],
  ['虎扑话题', 'https://rsshub.app/hupu/bbs', '社区'],
  ['掘金热门', 'https://rsshub.app/juejin/category/frontend', '社区'],
  ['吾爱破解', 'https://www.52pojie.cn/forum.php?mod=rss', '社区'],
  ['Chiphell', 'https://www.chiphell.com/forum.php?mod=rss', '社区'],
  ['博客园', 'https://www.cnblogs.com/feed/', '社区'],
  ['Reddit中文', 'https://rsshub.app/reddit/subreddit/chinese', '社区'],

  // 科技媒体
  ['36氪', 'https://www.36kr.com/feed', '科技'],
  ['虎嗅', 'https://rss.huxiu.com/', '科技'],
  ['机器之心', 'https://www.jiqizhixin.com/rss', '科技'],
  ['量子位', 'https://www.qbitai.com/feed', '科技'],
  ['品玩', 'https://www.pingwest.com/feed', '科技'],
  ['钛媒体', 'https://www.tmtpost.com/feed', '科技'],
  ['雷锋网', 'https://www.leiphone.com/feed', '科技'],
  ['差评', 'https://www.chaping.cn/feed', '科技'],
  ['蓝点网', 'https://www.landiannews.com/feed', '科技'],
  ['爱范儿(现用)', 'https://www.ifanr.com/feed', '科技'],
  ['驱动之家', 'https://www.mydrivers.com/rss.xml', '科技'],
  ['少数派(现用)', 'https://sspai.com/feed', '科技'],
  ['知乎日报(现用)', 'https://rsshub.bestblogs.dev/zhihu/daily', '科技'],
  ['知乎日报(旧镜像·已停更)', 'https://feedx.net/rss/zhihudaily.xml', '科技'],
  ['AIHOT(现用)', 'https://aihot.news/feed.xml', '科技'],

  // 技术博客 / 官方
  ['美团技术团队', 'https://tech.meituan.com/feed/', '博客'],
  ['阿里技术', 'https://developer.aliyun.com/feed', '博客'],
  ['字节跳动技术团队', 'https://juejin.cn/rss', '博客'],
  ['酷壳', 'https://www.qq.com/feed', '博客'],
  ['SegmentFault', 'https://segmentfault.com/feed', '博客'],
  ['infoQ中文', 'https://www.infoq.cn/feed', '博客'],
  ['机器之心中文站', 'https://www.jiqizhixin.com/rss', '博客'],
];

// ↓ 用户明确去掉过的源（2026-11-05），别再加回来：
//   Hacker News / Solidot / IT之家 / 极客公园 / 开源中国
//   理由：Hacker News 是英文源；后四个用户 2026-10-25 就嫌内容太杂/更新太慢移掉了。
//   另外「英文相关 RSS 源」和 tidings 的 chinese 合集也一并去掉了（见文件头）。

/**
 * 挡掉用户去掉过的源 —— **合集里还有它们的镜像**
 * （实测 tidings news 合集里有「奇客Solidot」和「IT之家」两个镜像，
 *  名字是中文，靠中文过滤挡不住，得按名字/域名点名挡）。
 */
const BLOCKED = [
  { name: /Hacker\s*News/i, host: /hnrss\.org|ycombinator\.com/i },
  { name: /Solidot/i, host: /solidot\.org/i },
  { name: /IT\s*之家/i, host: /ithome\.com/i },
  { name: /极客公园/i, host: /geekpark\.net/i },
  { name: /开源中国/i, host: /oschina\.net/i },
];
function isBlocked(name, url) {
  return BLOCKED.some((b) => (b.name && b.name.test(name)) || (b.host && b.host.test(url)));
}

const TIDINGS = [
  ['news', 'https://github.com/fuxiaoai/tidings-rss/releases/latest/download/tidings-news.opml'],
  ['communities', 'https://github.com/fuxiaoai/tidings-rss/releases/latest/download/tidings-communities.opml'],
];

function parseOpml(xml) {
  const out = [];
  // <outline text=".." title=".." xmlUrl=".." type="rss"/>
  const re = /<outline\b[^>]*>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const tag = m[0];
    const url = attr(tag, 'xmlUrl');
    const title = attr(tag, 'title') || attr(tag, 'text') || '';
    if (url && /^https?:/i.test(url)) out.push({ title, url });
  }
  return out;
}
function attr(tag, name) {
  const re = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i');
  const m = re.exec(tag);
  if (m) return m[1];
  const re2 = new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i');
  const m2 = re2.exec(tag);
  return m2 ? m2[1] : '';
}

/** 探测一个源。请求走 fetch-rss.mjs 的 requestFeed（同一套重试策略）。 */
async function probe(url, tries = 3, timeoutMs = 15000) {
  let lastErr = '未知';
  for (let i = 0; i < tries; i++) {
    try {
      const t0 = Date.now();
      const r = await requestFeed(url, timeoutMs);
      const items = r.items || [];
      const latest = items.reduce((m, it) => Math.max(m, it.ts || 0), 0);
      const oldest = items.reduce((m, it) => Math.min(m, it.ts || 0), Date.now());
      const zhTitles = items.filter((it) => CN_RE.test(it.title || '')).length;
      return {
        ok: true,
        count: items.length,
        bytes: r.text.length,
        ms: Date.now() - t0,
        tries: i + 1,
        latest,
        oldest,
        // 中文占比：探测完复核语言用。条目少的时候按 0 算（判不出来就当英文源剔掉）
        zhRatio: items.length ? zhTitles / items.length : 0,
        title: items[0] ? items[0].title : '',
        link: items[0] ? items[0].link : '',
        hasDesc: items.some((it) => it.desc && it.desc.length > 20),
      };
    } catch (e) {
      lastErr = e.name === 'AbortError' ? `超时${timeoutMs}ms` : e.message;
      const hard = /^HTTP (4\d\d)/.test(lastErr); // 4xx 重试也没用
      if (hard && i >= 1) break;
      if (i < tries - 1) await new Promise((res) => setTimeout(res, 800 * (i + 1)));
    }
  }
  return { ok: false, error: lastErr, tries };
}

/** 拉文本。**必须自带重试** —— 国内 -> GitHub 这条链路会间歇性断连，
 *  一次 fetch failed 就少掉一整个合集（几十个候选凭空消失）。 */
async function fetchText(url, tries = 3) {
  let lastErr = '未知';
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e.message;
      if (i < tries - 1) await new Promise((res) => setTimeout(res, 800 * (i + 1)));
    }
  }
  throw new Error(lastErr);
}

async function main() {
  const candidates = [];
  const seen = new Set();
  let blockedCount = 0;
  const push = (name, url, group) => {
    if (isBlocked(name, url)) {
      blockedCount++;
      console.error(`  挡掉（用户去掉过的源）：${name} — ${url}`);
      return false;
    }
    const k = url.replace(/\/$/, '');
    if (seen.has(k)) return false;
    seen.add(k);
    candidates.push({ name, url, group });
    return true;
  };

  for (const [name, url, group] of CURATED) push(name, url, group);

  // 拉 tidings 两个合集。合集里全是英文源和中文源混在一起 ——
  // 标题里没有汉字的直接不要（用户要求只留中文源）。
  for (const [bundle, url] of TIDINGS) {
    try {
      const xml = await fetchText(url);
      const list = parseOpml(xml);
      let added = 0;
      let skipped = 0;
      for (const f of list) {
        if (!CN_RE.test(f.title)) {
          skipped++;
          continue;
        }
        if (push(`${f.title}[${bundle}]`, f.url, bundle)) added++;
      }
      console.error(`  ${bundle} 合集：解析 ${list.length} 条，选入 ${added} 条（英文源 ${skipped} 条已剔）`);
    } catch (e) {
      console.error(`  ${bundle} 合集下载异常：${e.message}`);
    }
  }

  console.error(`候选总数 ${candidates.length}，开始探测…`);

  const results = [];
  const CONC = 6;
  let cursor = 0;
  async function worker() {
    while (cursor < candidates.length) {
      const i = cursor++;
      const c = candidates[i];
      const r = await probe(c.url);
      results[i] = { ...c, ...r };
      process.stderr.write(
        `  [${i + 1}/${candidates.length}] ${r.ok ? '✓' : '✗'} ${c.name} ${r.ok ? `${r.count} 条 / 最新 ${new Date(r.latest).toISOString().slice(0, 10)}` : r.error}\n`
      );
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  /* ── 语言复核 ──
   * 只对**抓到了的源**判语言：按「最近条目标题里中文占比」剔掉标题是中文、内容是英文的源。
   * 抓失败的源一律留在「失败」清单里 —— 失败就是失败，不能因为名字是英文就当它不存在
   * （linux.do 就是这个情况：内容是中文，只是名字是英文，而且本机直连 403）。
   */
  const kept = [];
  let droppedEn = 0;
  for (const r of results) {
    if (!r.ok) {
      kept.push(r);
      continue;
    }
    if (r.zhRatio >= ZH_MIN_RATIO) {
      kept.push(r);
    } else {
      droppedEn++;
      console.error(`  剔掉英文源：${r.name}（中文标题占比 ${Math.round((r.zhRatio || 0) * 100)}%）`);
    }
  }

  /* ── 输出 ── */
  const fmt = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : '');
  const lines = ['name\tgroup\turl\tok\tcount\tlatest\toldest\tbytes\tms\ttries\ttitle'];
  for (const r of kept) {
    lines.push(
      [
        r.name,
        r.group,
        r.url,
        r.ok ? 'Y' : 'N',
        r.ok ? r.count : 0,
        r.ok ? fmt(r.latest) : '',
        r.ok ? fmt(r.oldest) : '',
        r.ok ? r.bytes : 0,
        r.ok ? r.ms : 0,
        r.tries,
        r.ok ? (r.title || '').replace(/[\t\n]/g, ' ').slice(0, 90) : (r.error || ''),
      ].join('\t')
    );
  }
  fs.writeFileSync(OUT_TSV, lines.join('\n'), 'utf8');

  const okList = kept.filter((r) => r.ok);
  const md = [];
  md.push(`# 候选 RSS 源探测结果（${new Date().toISOString()}）`);
  md.push('');
  md.push(
    `探测 ${results.length} 个，留下的 ${kept.length} 个（成功 ${okList.length}，失败 ${kept.length - okList.length}）`
  );
  md.push('');
  md.push(
    `> 只列中文源：英文源 ${droppedEn} 个已剔除；用户去掉过的源（含合集里的镜像）${blockedCount} 个已挡掉。`
  );
  md.push('');
  md.push(
    `> ⚠️ 标记 = 最新条目已经超过 ${STALE_DAYS} 天 —— 构建时的过期闸门（maxAgeDays=${STALE_DAYS}）` +
      `会把它们全丢掉，加进配置当天就是 0 条。`
  );
  md.push('');
  for (const g of ['资讯', '社区', '科技', '博客', 'news', 'communities']) {
    const rows = okList.filter((r) => r.group === g);
    if (!rows.length) continue;
    md.push(`## ${g}（${rows.length}）`);
    md.push('');
    md.push('| 源 | 条目 | 最新 | 条目示例 | 地址 |');
    md.push('|---|---|---|---|---|');
    for (const r of rows.sort((a, b) => b.count - a.count)) {
      const age = r.latest ? Math.round((Date.now() - r.latest) / 86400000) : null;
      const stale = age !== null && age > STALE_DAYS;
      md.push(
        `| ${r.name} | ${r.count} | ${fmt(r.latest)}${stale ? ` ⚠️ ${age} 天前` : ''} | ${(r.title || '').slice(0, 40)} | ${r.url} |`
      );
    }
    md.push('');
  }
  const bad = kept.filter((r) => !r.ok);
  if (bad.length) {
    md.push(`## 失败（${bad.length}）`);
    md.push('');
    md.push('> 抓失败的源一律列在这里，不按语言过滤（失败就是失败）。');
    md.push('');
    for (const r of bad) md.push(`- ${r.name} — ${r.error} — ${r.url}`);
    md.push('');
  }
  fs.writeFileSync(OUT_MD, md.join('\n'), 'utf8');
  console.error(`\n报告：${OUT_TSV}\n      ${OUT_MD}`);
}

await main();
