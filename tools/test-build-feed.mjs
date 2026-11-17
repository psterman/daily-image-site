#!/usr/bin/env node
/**
 * 护栏：站点的 RSS 订阅源（published/feed.xml）
 *
 * 用法：node tools/test-build-feed.mjs
 * 退出码：0 = 全过；1 = 有失败
 *
 * ── 为什么要有这道护栏 ───────────────────────────────────────
 * 站内原来**一个 feed 都没有**：/feed.xml 会落到 Cloudflare Pages 的 404 兜底页，
 * 返回 200 + text/html。订阅者拿到的不是「订阅源」，而是**一份看起来正常的网页**，
 * 没有任何报错提示它根本不是 feed —— 这种故障只会被默默忽略。
 *
 * ── 这些断言盯的是「坏了看不出来」的地方 ─────────────────────
 *   1. link / guid 必须是**绝对 URL**：阅读器拿到的 link 是直接拿去打开的，
 *      相对路径它手里没有站点根，拼不出来。
 *   2. pubDate 必须是 **UTC RFC822**：读者遍布全球，本地时区会让
 *      「这期是哪天」在不同机器上飘。
 *   3. 标题/描述必须 **XML 转义**：见报的标题来自别的 RSS 源，
 *      "AT&T"、"<紧急>" 是常事；不转义整份 feed 被判成坏 XML，阅读器**直接丢弃**。
 *   4. **每期一条 item**：这是一份日报，3 万多条内容全塞进去阅读器会卡住。
 *   5. feed.xml 必须在**根目录**：内容是所有往期，写到当期目录等于订阅不到历史。
 *   6. 概览按页面上 6 个 tab 的顺序出条数（追更已并进看片，不再单列）。
 *
 * ⚠️ **对源码的匹配一律先剥注释**：
 *    build.mjs 的注释里就写着「RSS」「绝对 URL」「每期一条 item」这些词。
 *    全文匹配的话，护栏会把自己的说明书当成合规证据 —— 代码改坏了也照样全绿，
 *    那就是一道**假护栏**。剥注释只用于匹配；编码/字节的断言看的是原文件。
 *
 * 变异测试入口：BUILD_FEED_MJS / BUILD_MJS / TEMPLATE_HTML 环境变量可以指向别的文件
 * （验「护栏能抓住坏版本」时不用碰真文件）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripJsComments, stripHtmlComments } from './strip-comments.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;

function check(label, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? '  —— ' + detail : ''}`);
  }
}

/* 环境变量覆盖：变异脚本靠它把「坏版本」喂进来，不碰真文件。 */
const BUILD_FEED_MJS = process.env.BUILD_FEED_MJS || path.join('tools', 'build-feed.mjs');
const BUILD_MJS = process.env.BUILD_MJS || path.join('tools', 'build.mjs');
const TEMPLATE_HTML = process.env.TEMPLATE_HTML || path.join('site', 'template.html');

function absPath(rel) {
  return path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
}

function readBytes(rel) {
  try {
    return fs.readFileSync(absPath(rel));
  } catch {
    return null;
  }
}

const feedBytes = readBytes(BUILD_FEED_MJS);
const buildBytes = readBytes(BUILD_MJS);
const tplBytes = readBytes(TEMPLATE_HTML);

const feedText = feedBytes === null ? '' : feedBytes.toString('utf8');
const buildText = buildBytes === null ? '' : buildBytes.toString('utf8');
const tplText = tplBytes === null ? '' : tplBytes.toString('utf8');

/* 匹配一律看剥掉注释后的代码；字节/行尾的断言看原文件。 */
const feedCode = stripJsComments(feedText);
const buildCode = stripJsComments(buildText);
const tplCode = stripHtmlComments(tplText);

/* ────────────────────── 测试夹具 ────────────────────── */

const SITE_URL = 'https://example.com';
const SITE_TITLE = '每日图片站';
const EXPECTED_KEYS = ['jianwen', 'jianshe', 'jianxiao', 'news', 'music', 'movie'];
/* 概览长什么样是约定死的：6 个 tab，顺序跟页面一致。 */
const EXPECTED_SUMMARY = '见闻 30 · 见她 72 · 见笑 80 · 见报 369 · 听乐 550 · 看片 435';
const COUNTS = { jianwen: 30, jianshe: 72, jianxiao: 80, news: 369, music: 550, movie: 435 };
const ISSUES = [
  { date: '2026-11-15', pubDate: '2026-11-15T00:00:00Z', counts: { ...COUNTS } },
  { date: '2026-11-16', pubDate: '2026-11-16T00:00:00Z', counts: { ...COUNTS } },
  { date: '2026-11-17', pubDate: '2026-11-17T00:00:00Z', counts: { ...COUNTS } },
];

/**
 * 真的调一次 buildFeedXml。
 *
 * 为什么包 try/catch：护栏的「红」必须是**断言不成立**，
 * 不是护栏自己崩了。崩出来的红会把真缺口盖住（那不叫抓到，叫自己坏掉了）。
 */
function callFeed(args) {
  try {
    return { xml: mod?.buildFeedXml?.(args) ?? '', error: '' };
  } catch (e) {
    return { xml: '', error: e?.message ?? String(e) };
  }
}

/** 取第一个捕获组，取不到就是空串 —— 绝不抛。 */
function grab(re, text) {
  return (String(text ?? '').match(re) || [])[1] ?? '';
}

/** 去掉已知实体，剩下的裸 & / 裸 < 就是坏 XML 的来源。 */
function stripEntities(s) {
  return String(s ?? '').replace(/&(?:amp|lt|gt|quot|apos);/g, '');
}

/** 一条 item 里的期号：从 link 里挑，挑不到再从标题尾巴上挑。 */
function dayOf(item) {
  const link = grab(/<link>([\s\S]*?)<\/link>/, item);
  const fromLink = (link.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] ?? '';
  if (fromLink) return fromLink;
  const title = grab(/<title>([\s\S]*?)<\/title>/, item);
  return (title.match(/(\d{4}-\d{2}-\d{2})\s*$/) || [])[1] ?? '';
}

/* build-feed.mjs 是纯函数模块 —— 可以真的 import 进来调，
   这比静态匹配强得多：断言跑的是**真代码**，不是文本。 */
let mod = null;
let importError = '';
try {
  mod = await import(pathToFileURL(absPath(BUILD_FEED_MJS)).href);
} catch (e) {
  importError = e?.message ?? String(e);
}

/* ────────────────────── 0) 文件在不在 ────────────────────── */

console.log('\n0) 文件在不在');
{
  check('tools/build-feed.mjs 存在', feedBytes !== null, BUILD_FEED_MJS);
  check('tools/build.mjs 存在', buildBytes !== null, BUILD_MJS);
  check('site/template.html 存在', tplBytes !== null, TEMPLATE_HTML);
}

/* ────────────────────── 1) 导出与 6 个 tab 的映射 ────────────────────── */

console.log('\n1) build-feed.mjs：导出与 6 个 tab 的映射');
{
  check('build-feed.mjs 能 import 进来（不是崩在加载阶段）', mod !== null, importError);
  check('build-feed.mjs 导出 buildFeedXml', typeof mod?.buildFeedXml === 'function');
  check('build-feed.mjs 导出 rfc822', typeof mod?.rfc822 === 'function');
  check(
    'build-feed.mjs 导出 FEED_CN_NAMES',
    !!mod?.FEED_CN_NAMES && typeof mod.FEED_CN_NAMES === 'object'
  );

  const names = mod?.FEED_CN_NAMES ?? {};
  const keys = Object.keys(names);
  const has = (k) => Object.prototype.hasOwnProperty.call(names, k);

  check(
    'FEED_CN_NAMES 恰好 6 个 key（见闻/见她/见笑/见报/听乐/看片）',
    keys.length === 6 && EXPECTED_KEYS.every(has),
    `实际：${keys.join(', ')}`
  );
  check(
    'FEED_CN_NAMES 不含已下线的 follow（追更已并进看片）',
    !has('follow'),
    'follow 这个 tab 已经并进看片，feed 里再列它就是多了一个不存在的栏'
  );
  check(
    'FEED_CN_NAMES 的顺序跟页面 6 个 tab 一致（概览按这个顺序出条数）',
    keys.length === EXPECTED_KEYS.length && keys.every((k, i) => k === EXPECTED_KEYS[i]),
    `实际：${keys.join(' → ')}`
  );
}

/* ────────────────────── 2) buildFeedXml 的产出 ────────────────────── */

console.log('\n2) build-feed.mjs：buildFeedXml 的产出');
{
  const r = callFeed({ siteUrl: SITE_URL, siteTitle: SITE_TITLE, issues: ISSUES });
  const xml = r.xml;

  check('buildFeedXml 不抛异常', r.error === '', r.error);
  check(
    'feed 首行是 XML 声明',
    xml.split('\n')[0] === '<?xml version="1.0" encoding="UTF-8"?>',
    xml.split('\n')[0] ?? ''
  );
  check('feed 含 <rss version="2.0"', /<rss version="2\.0"/.test(xml));
  check('feed 含 <channel> 和 </channel>', xml.includes('<channel>') && xml.includes('</channel>'));
  check('feed 以 </rss> 收尾', xml.trimEnd().endsWith('</rss>'));

  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  check(
    'feed 的 item 数 = 传入的期数（每期一条 item，不是每条内容一条）',
    items.length === ISSUES.length,
    `实际 ${items.length} 条 / 传入 ${ISSUES.length} 期`
  );

  const links = items.map((it) => grab(/<link>([\s\S]*?)<\/link>/, it));
  const guids = items.map((it) => grab(/<guid[^>]*>([\s\S]*?)<\/guid>/, it));
  const pubDates = items.map((it) => grab(/<pubDate>([\s\S]*?)<\/pubDate>/, it));

  check(
    '每个 item 的 link 都是绝对 URL（相对路径阅读器点不开）',
    links.length > 0 && links.every((u) => /^https:\/\//.test(u)),
    links.filter((u) => !/^https:\/\//.test(u)).join(' | ')
  );
  check(
    '每个 item 的 guid 都是绝对 URL',
    guids.length > 0 && guids.every((u) => /^https:\/\//.test(u)),
    guids.filter((u) => !/^https:\/\//.test(u)).join(' | ')
  );
  check(
    '每个 item 的 pubDate 都能被 new Date() 解析',
    pubDates.length > 0 && pubDates.every((p) => !Number.isNaN(new Date(p).getTime())),
    pubDates.filter((p) => Number.isNaN(new Date(p).getTime())).join(' | ')
  );
  check(
    '每个 item 的 pubDate 都以 GMT 结尾（UTC RFC822）',
    pubDates.length > 0 && pubDates.every((p) => /GMT$/.test(p.trim())),
    pubDates.filter((p) => !/GMT$/.test(p.trim())).join(' | ')
  );

  const days = items.map(dayOf);
  check(
    'item 按期号倒序（新的在前）',
    days.length > 0 && days.every((d, i) => i === 0 || days[i - 1] > d),
    days.join(' → ')
  );

  /* 转义：用真实会出现的字符去撞 —— 见报的标题就是从别的 RSS 源抓来的。 */
  const ESC_TITLE = 'AT&T <紧急> "引号" \'单引号\'';
  const escXml = callFeed({
    siteUrl: SITE_URL,
    siteTitle: ESC_TITLE,
    issues: ISSUES,
  }).xml;
  const channelTitle = grab(/<title>([\s\S]*?)<\/title>/, escXml);

  check(
    '标题里的特殊字符都被转义（不转义整份 feed 是坏 XML）',
    channelTitle.includes('&amp;') &&
      channelTitle.includes('&lt;') &&
      channelTitle.includes('&gt;') &&
      channelTitle.includes('&quot;') &&
      channelTitle.includes('&apos;'),
    channelTitle
  );
  check(
    '转义后的标题里没有裸 & 或裸 <（裸符号会让 XML 解析失败）',
    !/[<&]/.test(stripEntities(channelTitle)),
    channelTitle
  );

  const firstDesc = grab(/<description>([\s\S]*?)<\/description>/, items[0] ?? '');
  const summary = firstDesc.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
  check('item 的 description 是 6 个 tab 的条数摘要', summary === EXPECTED_SUMMARY, `实际：${summary}`);

  const channelDesc = grab(/<description>([\s\S]*?)<\/description>/, xml);
  check(
    'channel 的 description 里不再出现「三栏」（站点已经 6 个 tab）',
    !channelDesc.includes('三栏'),
    channelDesc
  );

  check('feed 以换行结尾', xml.endsWith('\n'));
  check('feed 输出无 BOM', xml.length > 0 && xml.charCodeAt(0) !== 0xfeff);
}

/* ────────────────────── 3) 降级与边界 ────────────────────── */

console.log('\n3) build-feed.mjs：降级与边界');
{
  /* counts 缺失/为空都不许炸：构建期一份旧 manifest 可能就是没有这些字段。 */
  const noCounts = callFeed({
    siteUrl: SITE_URL,
    siteTitle: SITE_TITLE,
    issues: [{ date: '2026-11-17' }],
  });
  check('issues 缺 counts 时不抛异常（降级成空摘要）', noCounts.error === '', noCounts.error);

  const emptyCounts = callFeed({
    siteUrl: SITE_URL,
    siteTitle: SITE_TITLE,
    issues: [{ date: '2026-11-17', counts: {} }],
  });
  check('counts 为空对象时也不抛异常', emptyCounts.error === '', emptyCounts.error);

  /* siteUrl 带尾斜杠不能拼出 // —— 站点地址是配置来的，末尾多一个斜杠很常见。 */
  const slash = callFeed({
    siteUrl: `${SITE_URL}///`,
    siteTitle: SITE_TITLE,
    issues: ISSUES,
  });
  const slashItems = slash.xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  const slashLinks = slashItems.map((it) => grab(/<link>([\s\S]*?)<\/link>/, it));
  const slashChannelLink = grab(/<channel>[\s\S]*?<link>([\s\S]*?)<\/link>/, slash.xml);
  const noDoubleSlash = slashLinks.every((u) => !String(u).replace(/^https?:\/\//, '').includes('//'));
  check(
    'siteUrl 结尾带斜杠时不产生双斜杠',
    slashChannelLink === `${SITE_URL}/` && noDoubleSlash,
    `channel=${slashChannelLink} item=${slashLinks.join(' | ')}`
  );

  /* 非法日期必须炸：静默返回一个坏时间，feed 里就多了一条「1970 年」的假条目。 */
  let threw = false;
  try {
    mod?.rfc822?.('这不是一个日期');
  } catch {
    threw = true;
  }
  check('rfc822 对非法日期抛错', threw);
}

/* ────────────────────── 4) build.mjs 集成 ────────────────────── */

console.log('\n4) build.mjs 集成（静态匹配，看剥掉注释后的代码）');
{
  const lines = buildCode.split('\n');

  /* feed 那一块的代码窗口：从 buildFeedXml( 往上找它所在的那个 { 块。
     为什么不用固定的行号：build.mjs 天天在改，写死行号的护栏今天绿明天红。 */
  const callIdx = lines.findIndex((l) => /buildFeedXml\s*\(/.test(l));
  let feedRegion = '';
  if (callIdx >= 0) {
    let open = -1;
    for (let i = callIdx; i >= Math.max(0, callIdx - 40); i--) {
      if (lines[i].trim() === '{') {
        open = i;
        break;
      }
    }
    const start = open >= 0 ? open : Math.max(0, callIdx - 20);
    feedRegion = lines.slice(start, start + 40).join('\n');
  }

  /* dates（往期清单）的定义在 feed 块上面一点，单独取。 */
  const datesIdx = lines.findIndex((l) => /const dates\s*=/.test(l));
  const datesRegion = datesIdx >= 0 ? lines.slice(datesIdx, datesIdx + 10).join('\n') : '';

  check(
    'build.mjs import 了 buildFeedXml（来自 ./build-feed.mjs）',
    /import\s*\{[^}]*\bbuildFeedXml\b[^}]*\}\s*from\s*['"]\.\/build-feed\.mjs['"]/.test(buildCode)
  );
  check(
    'feed.xml 写到 published 根目录（不是当期目录）',
    /path\.join\(publishedRoot,\s*['"]feed\.xml['"]\)/.test(feedRegion),
    '内容是所有往期；写到当期目录的话订阅者永远只能看到今天这一期'
  );
  check('feed.xml 没有写到当期目录', !/path\.join\(publishedDir,/.test(feedRegion));
  check(
    'build.mjs 的 dates 是 publishedRoot 下按 YYYY-MM-DD 命名的目录列表',
    datesRegion.includes('fs.readdir(publishedRoot') &&
      datesRegion.includes('/^\\d{4}-\\d{2}-\\d{2}$/'),
    `实际：${datesRegion.split('\n')[0] ?? ''}`
  );
  check(
    'feed 遍历的是往期目录列表 dates（不是只有当期）',
    /for\s*\(\s*const\s+d\s+of\s+dates\s*\)/.test(feedRegion),
    '只扫当期 = 订阅者永远只能看到今天这一期'
  );
  check(
    'feed 用 findLiveManifestName 找活 manifest（不是写死文件名）',
    /await\s+findLiveManifestName\(/.test(feedRegion)
  );
  check('feed 没有写死 manifest 文件名', !/['"]manifest\./.test(feedRegion));
  const pushes = (feedRegion.match(/issues\.push\(/g) || []).length;
  check(
    'feed 每期只 push 一条 issue（每期一条 item）',
    pushes === 1,
    `实际 ${pushes} 处`
  );
  check(
    'feed 的条数来自 manifest 的 tab 计数',
    /for\s*\(\s*const\s+t\s+of\s+m\.tabs/.test(feedRegion) && /counts\[t\.key\]/.test(feedRegion)
  );
  check(
    'item 的 pubDate 取 manifest 的 generatedAt，缺省回退到期号当天',
    /pubDate:\s*m\.generatedAt\s*\|\|/.test(feedRegion) && /\$\{d\}T/.test(feedRegion)
  );

  /* 往期页（/archive/）**自带一份 <head>**，不走 site/template.html ——
     所以模板里那条 <link rel="alternate"> 不会自动出现在那儿。
     漏了它，读者从「全部日期」点进来就没有订阅入口（发现链断一半）。
     注意：这段 HTML 在 build.mjs 的模板字符串里，剥注释剥不到它，
     所以这里只认 <link> 标签本身，HTML 注释里提一嘴不算数。 */
  const archiveLinkTags = buildCode.match(/<link\b[^>]*>/g) || [];
  const archiveFeedTag = archiveLinkTags.find((t) => /href\s*=\s*['"]\/feed\.xml['"]/.test(t)) ?? '';
  const archiveAttr = (name) => grab(new RegExp(`${name}\\s*=\\s*['"]([^'"]*)['"]`), archiveFeedTag);
  check(
    '往期页（buildIndexHtml 自带的 head）里也有指向 /feed.xml 的 <link>',
    archiveFeedTag.length > 0,
    `实际找到 ${archiveLinkTags.length} 个 <link>`
  );
  check('往期页那条订阅链接的 rel 是 alternate', archiveAttr('rel') === 'alternate', `实际：${archiveAttr('rel')}`);
  check(
    '往期页那条订阅链接的 type 是 application/rss+xml',
    archiveAttr('type') === 'application/rss+xml',
    `实际：${archiveAttr('type')}`
  );
}

/* ────────────────────── 5) site/template.html ────────────────────── */

console.log('\n5) site/template.html：阅读器怎么发现这个 feed');
{
  /* 只认 <link> 标签本身：注释里提一嘴「<link rel="alternate">」不算数。 */
  const linkTags = tplCode.match(/<link\b[^>]*>/g) || [];
  const feedTag = linkTags.find((t) => /href\s*=\s*['"]\/feed\.xml['"]/.test(t)) ?? '';
  const attr = (name) => grab(new RegExp(`${name}\\s*=\\s*['"]([^'"]*)['"]`), feedTag);

  check('template.html 里有指向 /feed.xml 的 <link>', linkTags.length > 0 && feedTag.length > 0);
  check('订阅链接的 rel 必须是 alternate', attr('rel') === 'alternate', `实际：${attr('rel')}`);
  check(
    '订阅链接的 type 必须是 application/rss+xml（text/xml 很多阅读器不认）',
    attr('type') === 'application/rss+xml',
    `实际：${attr('type')}`
  );
  check(
    '订阅链接的 href 必须是根路径 /feed.xml（日期页和归档页深度不同）',
    attr('href') === '/feed.xml',
    `实际：${attr('href')}`
  );
}

/* ────────────────────── 6) 编码 ────────────────────── */

console.log('\n6) 编码：UTF-8 无 BOM + 纯 LF');
{
  const hasBom = (b) => !!b && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
  const crCount = (b) => (b ? b.filter((x) => x === 0x0d).length : 0);

  check('site/template.html 无 BOM', !hasBom(tplBytes));
  check(
    'site/template.html 只有 LF（没有 CR）',
    tplBytes !== null && crCount(tplBytes) === 0,
    `有 ${crCount(tplBytes)} 个 CR`
  );
  check('tools/build-feed.mjs 无 BOM', !hasBom(feedBytes));
  check(
    'tools/build-feed.mjs 只有 LF（没有 CR）',
    feedBytes !== null && crCount(feedBytes) === 0,
    `有 ${crCount(feedBytes)} 个 CR`
  );
}

/* ────────────────────── 结果 ────────────────────── */

console.log('');
console.log(`  ${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
