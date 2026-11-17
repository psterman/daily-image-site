#!/usr/bin/env node
/**
 * 站点 RSS 2.0 feed 生成（站点自己的订阅源）。
 *
 * 为什么要有：
 *   见报本身就是 RSS 热榜 + 头条，是「订阅型内容」，但站点只给网页，
 *   读者只能手动来逛。给一份 feed，阅读器就能自己追更。
 *
 * 为什么 link 必须是**绝对 URL**：
 *   RSS 客户端拿到 <link> 是直接拿去打开的，相对路径它没有站点根，拼不出来。
 *   微信 / X 爬 og:image 也是同一个道理 —— 相对路径它们拉不到。
 *
 * 为什么时间一律用 UTC：
 *   读者遍布全球，用本地时区会让「这一期是哪天」在不同机器上飘。
 *   RFC822 的 GMT 时间没有歧义。
 *
 * 为什么标题/描述要转义：
 *   见报的标题来自 RSS 源站，标题里带 & 和 < 是常事（"AT&T"、"<紧急>"）。
 *   不转义的话整份 feed 会被阅读器判为坏 XML，直接丢弃。
 */
import { pathToFileURL } from 'node:url';

/**
 * 分类 key -> 中文名。
 *
 * 为什么要单独导出：调用方（构建脚本、页面）要用同一份映射，
 * 免得 feed 里叫「见报」而页面上叫「新闻」，两边对不上。
 */
export const FEED_CN_NAMES = {
  jianwen: '见闻',
  jianshe: '见她',
  jianxiao: '见笑',
  news: '见报',
  music: '听乐',
  movie: '看片',
};

/** 数量在概览里的固定顺序（跟页面上 6 个 tab 的顺序一致）。 */
const COUNT_KEYS = Object.keys(FEED_CN_NAMES);

/**
 * XML 非法控制字符（XML 1.0 规定这些字符连转义都不能写）。
 * 见报的摘要是从别的站点抓来的，偶尔会带这种字符 —— 留着整份 feed 就是坏的。
 * 写成转义序列而不是真的控制字符，文件本身才是干净的 UTF-8 文本。
 */
const BAD_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/**
 * Date -> RFC822（UTC）。
 *
 * 为什么用 toUTCString 而不是手拼格式：
 *   它就是 RFC1123/RFC822 兼容的 GMT 形式（"Tue, 17 Nov 2026 00:00:00 GMT"），
 *   手拼反而容易把星期和日期写错。
 *
 * @param {Date|string|number} date
 * @returns {string}
 */
export function rfc822(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new Error(`时间不合法：${String(date)}`);
  return d.toUTCString();
}

/** 文本节点转义：& 必须最先处理。 */
function esc(s) {
  return String(s)
    .replace(BAD_XML_CHARS, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * CDATA 包裹。
 *
 * 为什么 CDATA 里还要处理 ]]>：
 *   CDATA 段用 ]]> 收尾，描述里真的出现 ]]> 就会提前闭合，
 *   后面全变成裸文本 —— XML 直接解析失败。
 *   把它切成 ]]]]><![CDATA[> 是标准拆法（一个 CDATA 拆成两段，语义不变）。
 */
function cdata(s) {
  return '<![CDATA[' + String(s).replace(BAD_XML_CHARS, '').replaceAll(']]>', ']]]]><![CDATA[>') + ']]>';
}

/** 期号 -> 可比较的时间戳（日期格式认 YYYY-MM-DD，其余按原样 parse）。 */
function issueTime(dateStr) {
  const s = String(dateStr || '');
  const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) : Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

/** 当期概览：见闻 30 · 见她 72 · 见笑 80 · 见报 369 · 听乐 550 · 看片 435 */
function issueSummary(counts) {
  const c = counts || {};
  const parts = [];
  for (const key of COUNT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(c, key)) continue;
    const v = Number(c[key]);
    if (!Number.isFinite(v)) continue;
    parts.push(`${FEED_CN_NAMES[key]} ${v}`);
  }
  return parts.join(' · ');
}

/** item 的发布时间：没给 pubDate 就按期号当天（UTC 零点）算。 */
function issuePubDate(issue) {
  if (issue.pubDate != null) return rfc822(issue.pubDate);
  const d = String(issue.date || '');
  return rfc822(/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00Z` : d);
}

/**
 * 生成 RSS 2.0 XML 字符串（UTF-8，无 BOM）。
 *
 * @param {object} o
 * @param {string} o.siteUrl   站点根地址（不带结尾斜杠）
 * @param {string} o.siteTitle 站点标题（调用方传，不在函数里写死）
 * @param {object[]} o.issues  期号数组，每项 { date, pubDate, counts }
 * @returns {string}
 */
export function buildFeedXml({ siteUrl, siteTitle, issues }) {
  const base = String(siteUrl || '').replace(/\/+$/, '');
  const title = String(siteTitle || '');
  if (!base) throw new Error('buildFeedXml 需要 siteUrl');
  if (!title) throw new Error('buildFeedXml 需要 siteTitle');

  const list = Array.isArray(issues) ? issues.filter((it) => it && it.date) : [];
  // 新的在前 —— 阅读器默认也是按这个顺序铺的。
  const sorted = list
    .slice()
    .sort((a, b) => {
      const d = issueTime(b.date) - issueTime(a.date);
      if (d) return d;
      return String(b.date).localeCompare(String(a.date));
    });

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '<channel>',
    `  <title>${esc(title)}</title>`,
    `  <link>${esc(`${base}/`)}</link>`,
    '  <description>见闻 / 见她 / 见笑 图片，见报热榜，听乐与看片榜单，每日一阅。</description>',
    '  <language>zh-cn</language>',
    `  <lastBuildDate>${rfc822(new Date())}</lastBuildDate>`,
    `  <atom:link href="${esc(`${base}/feed.xml`)}" rel="self" type="application/rss+xml"/>`,
  ];

  for (const issue of sorted) {
    const day = String(issue.date);
    const link = `${base}/${day}/`;
    lines.push(
      '  <item>',
      `    <title>${esc(`${title} · ${day}`)}</title>`,
      `    <link>${esc(link)}</link>`,
      `    <guid isPermaLink="true">${esc(link)}</guid>`,
      `    <pubDate>${issuePubDate(issue)}</pubDate>`,
      `    <description>${cdata(issueSummary(issue.counts))}</description>`,
      '  </item>',
    );
  }

  lines.push('</channel>', '</rss>');
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------ CLI 自测 */

function parseArgs(argv) {
  const out = { issues: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--site-url') out.siteUrl = argv[++i];
    else if (a === '--title') out.siteTitle = argv[++i];
    else if (a === '--issue') out.issues.push(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

/** --issue 的格式：日期:见闻,见她,见笑,见报,听乐,看片 */
function parseIssue(text) {
  const s = String(text || '');
  const i = s.indexOf(':');
  if (i < 0) throw new Error(`--issue 格式应为 日期:数量1,数量2,...，收到：${s}`);
  const date = s.slice(0, i).trim();
  if (!date) throw new Error(`--issue 缺日期：${s}`);
  const nums = s
    .slice(i + 1)
    .split(',')
    .map((x) => Number(x.trim()));
  const counts = {};
  COUNT_KEYS.forEach((key, idx) => {
    const v = nums[idx];
    if (Number.isFinite(v)) counts[key] = v;
  });
  // pubDate 用**期号当天**（UTC 零点），不是构建当时 ——
  // 否则同一个期号每次跑出来的 pubDate 都不一样，排序也没意义。
  return { date, pubDate: new Date(`${date}T00:00:00Z`), counts };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.siteUrl || !args.issues.length) {
    console.log(`用法：
  node tools/build-feed.mjs --site-url "<站点地址>" --issue "<日期>:<见闻>,<见她>,<见笑>,<见报>,<听乐>,<看片>" [--issue ...]

  --title <s>   站点标题，默认 每日图片站
`);
    process.exit(args.help ? 0 : 1);
  }

  const issues = args.issues.map(parseIssue);
  const xml = buildFeedXml({
    siteUrl: args.siteUrl,
    siteTitle: args.siteTitle || '每日图片站',
    issues,
  });
  process.stdout.write(xml);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.error(`✗ ${e && e.message ? e.message : String(e)}`);
    process.exit(1);
  }
}
