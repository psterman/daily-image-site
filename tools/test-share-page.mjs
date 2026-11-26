#!/usr/bin/env node
/**
 * 单图分享页的护栏 —— 四组断言（静态 / 纯函数 / 真浏览器 / 产物）
 *
 * 为什么要有这个：
 *   「每张图一个能单独分享的页」（/pic/<日期>/<栏key>/<序号3位>/）是新加的一整条链路：
 *   上游原帖反解（tools/upstream-url.mjs）→ 构建期写进 manifest（tools/build.mjs）→
 *   卡片图（tools/build-cards.mjs）→ 运行时渲染（functions/pic/[[path]].js）→
 *   前端入口（site/app.js、site/template.html）。
 *   这条链路上任意一环写错，用户看到的都是「分享出去是白卡 / 点原帖是死链 / 序号对不上」，
 *   而且**线上才发现** —— 微信里的卡片爬虫不会报错，页面也不会 500。
 *
 * 所以这四组分别盯住：
 *   A. 静态：源码里该有的东西在不在（形状对不对）
 *   B. 纯函数：**真 import** 源码调用 renderSharePage，看它吐出来的 HTML 对不对
 *      （不许把逻辑抄一份到护栏里 —— 抄的那份永远是对的，守不住任何东西）
 *   C. 真浏览器：把 renderSharePage 的输出真的用 Chrome 打开，看图能不能加载、
 *      「看原帖」在有 src 时在不在、「回到这一期」指对没有
 *   D. 产物：真实构建产物（published/）里的卡片图与 manifest 对不对得上
 *
 * 约定（跟 tools/test-viewer-zoom.mjs 一致）：
 *   · 每条断言一个独立标签，失败时打印现场
 *   · 末尾「全部通过：N 通过 / 0 失败」，有失败 exit 1
 *   · 产物那组缺产物时**打印说明并跳过**，不许假装通过
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'published');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

/** 读工程里的源码文件；读不到返回空串（让断言去红，别让脚本自己崩）。 */
function readSrc(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
  catch { return ''; }
}

/* ══════════════════════════════════════════════════════════════
   A. 静态断言（源码级）
   ══════════════════════════════════════════════════════════════ */
console.log('\n── A. 静态：源码级 ──');

const upstreamSrc = readSrc(path.join('tools', 'upstream-url.mjs'));
check('静态：tools/upstream-url.mjs 存在并导出 upstreamUrlFor',
  upstreamSrc !== '' && /export function upstreamUrlFor\(/.test(upstreamSrc),
  { bytes: upstreamSrc.length });
check('静态：upstream-url.mjs 导出规则表 UPSTREAM_RULES',
  /export const UPSTREAM_RULES\s*=\s*\[/.test(upstreamSrc), '');

const buildSrc = readSrc(path.join('tools', 'build.mjs'));
/* ⚠️ 正则必须**锚到行首**：仓库里有「同义写法」的历史坑，
   不锚行首的话「src 字段不写了」这种变异根本不会让断言变红（护栏自己没有牙齿）。 */
check('静态：build.mjs 的媒体 item 带 src（整个键不出现的那种写法）',
  /^[ \t]*\.\.\.\(upstream \? \{ src: upstream \} : \{\}\),[ \t]*$/m.test(buildSrc), '');
check('静态：build.mjs 用 upstreamUrlFor 反解上游原帖',
  /import \{ upstreamUrlFor \} from '\.\/upstream-url\.mjs';/.test(buildSrc) &&
  /upstreamUrlFor\(tab\.key, name\)/.test(buildSrc), '');
/* 方形卡片图：微信对 og:image 强制 1:1 居中裁剪，长边版裁完中位只剩 68% 面积，
   所以额外出一套 640×640 正方形（模糊底 + 主体居中）给 og:image 用。
   三处（生成端 / 构建端 / 分享页端）必须同时在，缺一处方图就出不来。

   ⚠️ `cardSquareJobs.push` 必须**两条产出路径上都有**：
     ① 正常路径（src = destFull）
     ② 源图缺失的「重建路径」（src = destFull 目录里的 webp）——
        少挂一条 → 那条路径构建出来的期次没有方图 → og:image 悄悄退回长边版，
        而**线上不会报错**（只是缩略图又被裁了）→ 所以这里数个数，不只看「有没有」。 */
const squarePushCount = (buildSrc.match(/cardSquareJobs\.push\(\{/g) || []).length;
check('静态：build.mjs 会生成方形卡片图（两条产出路径都挂了 cardSquareJobs）',
  /import \{[^}]*buildSquareCards[^}]*\} from '\.\/build-cards\.mjs';/.test(buildSrc) &&
  /buildSquareCards\(\{ ffmpeg, jobs: cardSquareJobs \}\)/.test(buildSrc) &&
  squarePushCount === 2 &&
  /cardSquareJobs\.push\(\{\s*\n\s*src: destFull,/.test(buildSrc) &&
  /cardSquareJobs\.push\(\{\s*\n\s*src: path\.join\(destDir, webpName\),/.test(buildSrc),
  { squarePushCount });

const cardsSrc = readSrc(path.join('tools', 'build-cards.mjs'));
check('静态：tools/build-cards.mjs 存在，卡片图规格是长边 900 / 质量 70',
  /export const CARD_MAX_EDGE = 900;/.test(cardsSrc) &&
  /export const CARD_QUALITY = 70;/.test(cardsSrc), '');
check('静态：tools/build-cards.mjs 存在，方形卡片图规格是 640×640 / 目录 card-sq',
  /export const CARD_SQUARE_SIZE = 640;/.test(cardsSrc) &&
  /export const CARD_SQUARE_DIR_NAME = 'card-sq';/.test(cardsSrc), '');
/* ⚠️ 方图必须是「模糊底 + 主体缩到画布内再叠加」——
   直接把长边版裁成方，主体就被切掉了（实测最差的一张只剩 29% 面积）。 */
check('静态：方图是「模糊底 + 主体缩进画布居中叠加」，不是直接裁剪',
  /gblur=sigma=/.test(cardsSrc) &&
  /overlay=\(W-w\)\/2:\(H-h\)\/2/.test(cardsSrc) &&
  /force_original_aspect_ratio=decrease/.test(cardsSrc), '');

const fnSrc = readSrc(path.join('functions', 'pic', '[[path]].js'));
check('静态：functions/pic/[[path]].js 存在并导出 onRequest 与 renderSharePage',
  /export async function onRequest\(/.test(fnSrc) &&
  /export function renderSharePage\(/.test(fnSrc), '');
check('静态：分享页声明的卡片图长边也是 900（跟生成端一致）',
  /const CARD_LONG_EDGE = 900;/.test(fnSrc), '');
check('静态：分享页声明的方形卡片图边长也是 640（跟生成端一致）',
  /const CARD_SQUARE_SIZE = 640;/.test(fnSrc), '');
check('静态：分享页的方形卡片图目录也是 card-sq（跟生成端一致）',
  /const CARD_SQUARE_DIR = 'card-sq';/.test(fnSrc), '');
/* ⚠️ **「看原帖」入口已下线**（2026-11-26 用户拍板）：上游原帖是 t.me 外链，
   微信内置浏览器会拦成微信自己的「已停止访问该网页」页 → 留着就是给用户埋雷。
   这里盯的是「**一个都不许有**」：分享页不许再渲染那个按钮，
   也不许再读那条上游地址（否则哪天又被加回来）。
   ⚠️ 正则必须排除 viewerOriginal —— 它是 viewerOrigin 的**子串**，
   直接写 /viewerOrigin/ 会把「原图」按钮也一起判红。 */
check('静态：分享页不渲染「看原帖」、不读上游地址（入口已下线）',
  !/>看原帖</.test(fnSrc) && !/srcLink/.test(fnSrc) && !/item\.src/.test(fnSrc), '');

const appSrc = readSrc(path.join('site', 'app.js'));
check('静态：site/app.js 里能看出单图页路径的拼法 /pic/<日期>/<栏key>/<序号3位>/',
  /function pagePath\(/.test(appSrc) &&
  /'\/pic\/'/.test(appSrc) &&
  /padStart\(3, '0'\)/.test(appSrc), '');
check('静态：site/app.js 里有分享两件套的 id（viewerShare / viewerOriginal）',
  /getElementById\('viewerShare'\)/.test(appSrc) &&
  /getElementById\('viewerOriginal'\)/.test(appSrc), '');
/* ⚠️ 「看原帖」入口已下线：app.js 里既不能有 #viewerOrigin，
   也不能再有上游地址的消费（manifest 的 src 字段仍然保留 —— 上游反解机制备用 ——
   但**没有任何入口消费它**）。
   ⚠️ 正则必须排除 viewerOriginal —— 它是 viewerOrigin 的**子串**。 */
check('静态：site/app.js 里没有 viewerOrigin、也没有消费上游地址（入口已下线）',
  !/viewerOrigin(?!al)/.test(appSrc) && !/entry\.item\.src/.test(appSrc), '');
check('静态：site/app.js 把网格里的图包在 a.cell-link 里，href 指向单图页',
  /className = 'cell-link'/.test(appSrc) &&
  /setAttribute\('href', pagePath\(tab\.key, i\)\)/.test(appSrc), '');

const tplSrc = readSrc(path.join('site', 'template.html'));
check('静态：site/template.html 里有那两个 id，且没有 viewerOrigin',
  /id="viewerShare"/.test(tplSrc) &&
  /id="viewerOriginal"/.test(tplSrc) &&
  !/id="viewerOrigin"/.test(tplSrc), '');

/* ══════════════════════════════════════════════════════════════
   B. 纯函数断言 —— 真 import 源码，不许抄逻辑
   ══════════════════════════════════════════════════════════════ */
console.log('\n── B. 纯函数：真 import 源码调用 ──');

/* functions/pic/[[path]].js 是 .js、又不在 package.json 的 "type" 里 ——
   Node 会为它报一句 MODULE_TYPELESS_PACKAGE_JSON 警告（能正常 import，
   只是每次都被重新按 ESM 解析一遍）。这里**只收掉这一条**，其余警告照常显示。 */
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.code === 'MODULE_TYPELESS_PACKAGE_JSON' || w.name === 'MODULE_TYPELESS_PACKAGE_JSON') return;
  console.warn((w && w.stack) || String(w));
});

const upstreamMod = await import(pathToFileURL(path.join(ROOT, 'tools', 'upstream-url.mjs')).href);
const shareMod = await import(pathToFileURL(path.join(ROOT, 'functions', 'pic', '[[path]].js')).href);

/* 上游原帖反解 */
check('纯函数：upstreamUrlFor 见笑规则匹配 → t.me 链接',
  upstreamMod.upstreamUrlFor('jianxiao', 'jandan_pic_184601_20261125_000105_img0.jpg') === 'https://t.me/jandan_pic/184601',
  upstreamMod.upstreamUrlFor('jianxiao', 'jandan_pic_184601_20261125_000105_img0.jpg'));
check('纯函数：见她不给原帖（返回 null）',
  upstreamMod.upstreamUrlFor('jianshe', '6252822_01.gif') === null,
  upstreamMod.upstreamUrlFor('jianshe', '6252822_01.gif'));
check('纯函数：见闻不给原帖（返回 null）',
  upstreamMod.upstreamUrlFor('jianwen', '001_37665.webp') === null,
  upstreamMod.upstreamUrlFor('jianwen', '001_37665.webp'));

const rules = upstreamMod.UPSTREAM_RULES;
check('纯函数：规则表每条都带 tabKey / pattern / build / status / note',
  Array.isArray(rules) && rules.length > 0 && rules.every((r) =>
    typeof r.tabKey === 'string' && r.pattern instanceof RegExp &&
    typeof r.build === 'function' && typeof r.status === 'string' && typeof r.note === 'string'),
  rules.map((r) => Object.keys(r)));
const statusOf = (k) => {
  const r = (rules || []).find((x) => x.tabKey === k);
  return r ? r.status : '';
};
check('纯函数：见笑规则状态是 verified，见她 unverified，见闻 impossible',
  statusOf('jianxiao') === 'verified' && statusOf('jianshe') === 'unverified' && statusOf('jianwen') === 'impossible',
  { jianxiao: statusOf('jianxiao'), jianshe: statusOf('jianshe'), jianwen: statusOf('jianwen') });

/* 单图页渲染 */
const SITE_URL = 'https://example.com';
const DATE = '2026-11-26';
const FULL = '/img/2026-11-26/jianxiao/x_001.webp';
const BASE = {
  siteUrl: SITE_URL,
  date: DATE,
  tabKey: 'jianxiao',
  tabLabel: '见笑',
  seq: 1,
  item: {
    id: 'jianxiao_001', w: 800, h: 1200, tw: 200, th: 300,
    thumb: '/img/2026-11-26/jianxiao/x_001_t.webp',
    full: FULL,
    src: 'https://t.me/jandan_pic/184601',
  },
  cardImage: { url: SITE_URL + '/2026-11-26/card/jianxiao/abc_001.jpg', width: 600, height: 900 },
};

/** 从 HTML 里取某个 meta 的 content（只认精确的 name / property）。 */
function metaContent(html, kind, key) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (tag.includes(`${kind}="${key}"`)) {
      const m = tag.match(/content="([^"]*)"/i);
      if (m) return m[1];
    }
  }
  return '';
}

const html = shareMod.renderSharePage(BASE);
const ogTitle = metaContent(html, 'property', 'og:title');
const ogImage = metaContent(html, 'property', 'og:image');
const ogUrl = metaContent(html, 'property', 'og:url');

check('纯函数：og 标签齐全（title / description / image / url / type / twitter:card）',
  ogTitle !== '' &&
  metaContent(html, 'property', 'og:description') !== '' &&
  ogImage !== '' &&
  ogUrl !== '' &&
  metaContent(html, 'property', 'og:type') !== '' &&
  metaContent(html, 'name', 'twitter:card') !== '',
  {
    title: ogTitle, image: ogImage, url: ogUrl,
    type: metaContent(html, 'property', 'og:type'), twitter: metaContent(html, 'name', 'twitter:card'),
  });
check('纯函数：og:image 是绝对 URL（微信爬虫抓不到相对路径）',
  /^https:\/\//.test(ogImage), ogImage);
check('纯函数：og:title 格式 = <栏中文名> <序号> · <日期>（序号不补零）',
  ogTitle === '见笑 1 · 2026-11-26', ogTitle);
check('纯函数：og:url 指向单图页（序号补 3 位）',
  ogUrl === SITE_URL + '/pic/2026-11-26/jianxiao/001/', ogUrl);

/* 两套卡片图并存：方图给 og:image（微信 1:1 裁剪，方的等于不裁），
   长边版给 twitter:image（X / Telegram 按原比例显示）。 */
const SQ_URL = SITE_URL + '/2026-11-26/card-sq/jianxiao/abc_001.jpg';
const LONG_URL = SITE_URL + '/2026-11-26/card/jianxiao/abc_001.jpg';
const htmlSquare = shareMod.renderSharePage({
  ...BASE,
  cardImage: {
    og: { url: SQ_URL, width: 640, height: 640 },
    twitter: { url: LONG_URL, width: 900, height: 263 },
  },
});
check('纯函数：og:image 优先方形版（640×640），twitter:image 留给长边版',
  metaContent(htmlSquare, 'property', 'og:image') === SQ_URL &&
  metaContent(htmlSquare, 'property', 'og:image:width') === '640' &&
  metaContent(htmlSquare, 'property', 'og:image:height') === '640' &&
  metaContent(htmlSquare, 'name', 'twitter:image') === LONG_URL,
  {
    og: metaContent(htmlSquare, 'property', 'og:image'),
    w: metaContent(htmlSquare, 'property', 'og:image:width'),
    h: metaContent(htmlSquare, 'property', 'og:image:height'),
    twitter: metaContent(htmlSquare, 'name', 'twitter:image'),
  });
check('纯函数：cardImage 是扁的旧形状时，og:image 和 twitter:image 都用它',
  metaContent(html, 'property', 'og:image') === BASE.cardImage.url &&
  metaContent(html, 'name', 'twitter:image') === BASE.cardImage.url,
  {
    og: metaContent(html, 'property', 'og:image'),
    twitter: metaContent(html, 'name', 'twitter:image'),
  });

/* 选图逻辑（pickCardImages）—— 运行时到底挑了哪张当 og:image，护栏直接测这个纯函数。 */
const PICK_ITEM = { w: 800, h: 1200 };
const pickArgs = {
  squarePath: '/2026-11-26/card-sq/jianxiao/abc_001.jpg',
  longPath: '/2026-11-26/card/jianxiao/abc_001.jpg',
  item: PICK_ITEM,
  siteUrl: SITE_URL,
};
const pickedSquare = shareMod.pickCardImages({ ...pickArgs, squareExists: true, longExists: false });
check('纯函数：pickCardImages 有方图时 og 用方图（640×640）、twitter 用长边版',
  !!pickedSquare &&
  pickedSquare.og.url === SITE_URL + '/2026-11-26/card-sq/jianxiao/abc_001.jpg' &&
  pickedSquare.og.width === 640 && pickedSquare.og.height === 640 &&
  pickedSquare.twitter.url === SITE_URL + '/2026-11-26/card/jianxiao/abc_001.jpg',
  pickedSquare);
const pickedLong = shareMod.pickCardImages({ ...pickArgs, squareExists: false, longExists: true });
check('纯函数：pickCardImages 没有方图时退回长边版（og 和 twitter 同一张）',
  !!pickedLong &&
  pickedLong.og.url === SITE_URL + '/2026-11-26/card/jianxiao/abc_001.jpg' &&
  pickedLong.twitter.url === pickedLong.og.url,
  pickedLong);
check('纯函数：pickCardImages 两张都没有时返回 null（走 og.jpg 兜底）',
  shareMod.pickCardImages({ ...pickArgs, squareExists: false, longExists: false }) === null,
  shareMod.pickCardImages({ ...pickArgs, squareExists: false, longExists: false }));

/* ⚠️ 「看原帖」入口已下线（2026-11-26 用户拍板）：t.me 外链在微信内置浏览器里
   会被拦成「已停止访问该网页」→ **传了 src 也不许渲染**，更不许渲染成死链。 */
check('纯函数：即使传了 src，HTML 里也没有「看原帖」（入口已下线）',
  !html.includes('看原帖') && !html.includes('https://t.me/'), '');

/* 没 src → 同样没有（这条留着当回归：别以为「有 src 才渲染」还能蒙混过关） */
const noSrcItem = { ...BASE.item };
delete noSrcItem.src;
const htmlNoSrc = shareMod.renderSharePage({ ...BASE, item: noSrcItem });
check('纯函数：没传 src 时 HTML 里同样没有「看原帖」',
  !htmlNoSrc.includes('看原帖'), '');

/* 降级：当期没有卡片图 → 用该期的 og.jpg */
const htmlFallback = shareMod.renderSharePage({ ...BASE, cardImage: null });
const ogFallback = metaContent(htmlFallback, 'property', 'og:image');
check('纯函数：cardImage 为 null 时 og:image 降级成 <日期>/og.jpg',
  ogFallback.endsWith('/' + DATE + '/og.jpg'), ogFallback);
check('纯函数：cardImage 为 null 时 twitter:image 也降级成 <日期>/og.jpg',
  metaContent(htmlFallback, 'name', 'twitter:image').endsWith('/' + DATE + '/og.jpg'),
  metaContent(htmlFallback, 'name', 'twitter:image'));

check('纯函数：HTML 里有唯一的 share-page 标记',
  (html.match(/<meta name="share-page" content="1">/g) || []).length === 1, '');
check('纯函数：「原图」指向 item.full 的绝对地址',
  html.includes('<a class="btn" href="' + SITE_URL + FULL + '">原图</a>'), '');
check('纯函数：「回到这一期」指向 <站点>/<日期>/',
  html.includes('href="' + SITE_URL + '/' + DATE + '/">回到这一期</a>'), '');

/* 序号：显示去前导零、URL 里补 3 位 */
const htmlSeq = shareMod.renderSharePage({ ...BASE, seq: '007' });
check('纯函数：序号 007 显示成 7、URL 里补成 007',
  metaContent(htmlSeq, 'property', 'og:title') === '见笑 7 · 2026-11-26' &&
  metaContent(htmlSeq, 'property', 'og:url').endsWith('/pic/2026-11-26/jianxiao/007/'),
  { title: metaContent(htmlSeq, 'property', 'og:title'), url: metaContent(htmlSeq, 'property', 'og:url') });

/* ══════════════════════════════════════════════════════════════
   C. 真浏览器断言 —— 把 renderSharePage 的输出真的用 Chrome 打开
   ══════════════════════════════════════════════════════════════ */
console.log('\n── C. 真浏览器：Chrome 打开单图页 ──');

/* 假大图：800×600 的 SVG（写死 width/height，Chromium 报的 naturalWidth 就是 800）。
   副本走 https://example.com/img/... —— 用 page.route 拦下来喂本地图，
   不依赖外网。 */
const FULL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">' +
  '<rect width="100%" height="100%" fill="#334"/>' +
  '<circle cx="400" cy="300" r="120" fill="#fc0"/>' +
  '</svg>';

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/pic/with-src') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  if (url === '/pic/no-src') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlNoSrc);
    return;
  }
  if (url === '/pic/square') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlSquare);
    return;
  }
  if (url.startsWith('/img/')) {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    res.end(FULL_SVG);
    return;
  }
  res.writeHead(404).end('404');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;

let browser = null;
try {
  browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  /* 副本走绝对地址（https://example.com/img/...），拦下来喂本地 SVG —— 不碰外网。 */
  await page.route(
    (u) => u.hostname === 'example.com' && u.pathname.startsWith('/img/'),
    (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: FULL_SVG }),
  );

  await page.goto(base + '/pic/with-src', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => {
      const i = document.querySelector('.shot img');
      return !!i && i.complete && i.naturalWidth > 0;
    },
    { timeout: 15000 },
  );

  const seen = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a'));
    const byText = (t) => links.find((a) => a.textContent.trim() === t) || null;
    const origin = byText('看原帖');
    const original = byText('原图');
    const back = byText('回到这一期');
    const img = document.querySelector('.shot img');
    return {
      natural: img ? img.naturalWidth : 0,
      originHref: origin ? origin.getAttribute('href') : '',
      originVisible: origin ? origin.getClientRects().length > 0 : false,
      originText: origin ? origin.textContent.trim() : '',
      originalHref: original ? original.getAttribute('href') : '',
      backHref: back ? back.getAttribute('href') : '',
      marker: !!document.querySelector('meta[name="share-page"][content="1"]'),
      ogTitle: (document.querySelector('meta[property="og:title"]') || {}).content || '',
      ogImage: (document.querySelector('meta[property="og:image"]') || {}).content || '',
    };
  });

  check('真浏览器：页面里的全尺寸图能加载（naturalWidth > 0）', seen.natural > 0, seen);
  check('真浏览器：「原图」链接指向 item.full 的绝对地址', seen.originalHref === SITE_URL + FULL, seen);
  check('真浏览器：「看原帖」**整个不存在**（入口已下线，微信会拦 t.me 外链）',
    !seen.originVisible && !seen.originHref && seen.originText === '', seen);
  check('真浏览器：「回到这一期」指向 https://example.com/' + DATE + '/',
    seen.backHref === SITE_URL + '/' + DATE + '/', seen);
  check('真浏览器：页面里有 share-page 标记', seen.marker, seen);
  check('真浏览器：og:title / og:image 在 DOM 里（微信爬虫读的就是这两个）',
    seen.ogTitle === '见笑 1 · 2026-11-26' && /^https:\/\//.test(seen.ogImage), seen);

  /* 方形版那一路：og:image 必须指向方图且声明 640×640，twitter:image 留给长边版。 */
  await page.goto(base + '/pic/square', { waitUntil: 'domcontentloaded' });
  const sq = await page.evaluate(() => ({
    og: (document.querySelector('meta[property="og:image"]') || {}).content || '',
    w: (document.querySelector('meta[property="og:image:width"]') || {}).content || '',
    h: (document.querySelector('meta[property="og:image:height"]') || {}).content || '',
    twitter: (document.querySelector('meta[name="twitter:image"]') || {}).content || '',
  }));
  check('真浏览器：og:image 是方形版 URL 且声明 640×640，twitter:image 是长边版',
    sq.og === SQ_URL && sq.w === '640' && sq.h === '640' && sq.twitter === LONG_URL, sq);

  await page.goto(base + '/pic/no-src', { waitUntil: 'domcontentloaded' });
  const without = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a'));
    const origin = links.find((a) => a.textContent.trim() === '看原帖') || null;
    return {
      hasOrigin: !!origin,
      bodyHas: document.body.innerText.includes('看原帖'),
    };
  });
  check('真浏览器：没有 src 的单图页同样没有「看原帖」', !without.hasOrigin && !without.bodyHas, without);

  check('真浏览器：这一路没有 JS 报错', errors.length === 0, errors);
  await ctx.close();
} catch (err) {
  fail++;
  console.log('  ✗ 真浏览器：Playwright 这一段跑挂了（后面 C 组的断言没跑）  -> ' +
    JSON.stringify(String((err && err.message) || err)));
} finally {
  if (browser) { try { await browser.close(); } catch { /* 忽略 */ } }
  server.close();
}

/* ══════════════════════════════════════════════════════════════
   D. 产物断言 —— 真实构建产物（缺产物按既有范式跳过并说明）
   ══════════════════════════════════════════════════════════════ */
console.log('\n── D. 产物：published/ 里的真实产物 ──');

/** 读 JPEG 文件头：确认真是 JPEG（webp 是 'RIFF'），并取出宽高。 */
function jpegInfo(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;   // 缺 SOI → 不是 JPEG
  let i = 2;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xda) break;                            // 图像数据开始，后面没有尺寸了
    if (i + 4 > buf.length) break;
    const len = buf.readUInt16BE(i + 2);
    i += 2 + len;
  }
  return null;
}

if (!fs.existsSync(PUB)) {
  console.log('  （没有 published/ 目录，跳过 —— 跑一次 node tools/build.mjs 就能查）');
} else {
  const dates = fs.readdirSync(PUB)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .reverse();
  const date = dates.find((d) => fs.existsSync(path.join(PUB, d, 'card')));
  if (!date) {
    console.log('  （published/ 里没有带 card/ 的期次，跳过 —— 跑一次 node tools/build.mjs 就能查）');
  } else {
    const dir = path.join(PUB, date);
    const mfName = fs.readdirSync(dir).find((f) => /^manifest\..*\.js$/.test(f));
    const manifest = mfName
      ? JSON.parse(fs.readFileSync(path.join(dir, mfName), 'utf8')
        .replace(/^window\.__DAILY_MANIFEST__=/, '').replace(/;\s*$/, ''))
      : null;

    if (!manifest) {
      console.log('  （这一期没有 manifest 文件，跳过 —— 跑一次 node tools/build.mjs 就能查）');
    } else {
      for (const tab of manifest.tabs || []) {
        const cardDir = path.join(dir, 'card', tab.key);
        if (!fs.existsSync(cardDir)) continue;
        const files = fs.readdirSync(cardDir).filter((f) => /\.jpe?g$/i.test(f));
        const items = tab.items || [];

        check('产物：card/' + tab.key + ' 的卡片图数量 = 该栏当期的图片数',
          files.length === items.length, { files: files.length, items: items.length });

        if (!items.length || !files.length) continue;
        /* 抽第一张：文件名跟全图同名（只换扩展名），据此找回 manifest 里那一条。 */
        const sample = items[0];
        const cardName = path.basename(sample.full || '').replace(/\.[A-Za-z0-9]+$/, '.jpg');
        const cardFile = path.join(cardDir, cardName);
        if (!fs.existsSync(cardFile)) {
          check('产物：card/' + tab.key + ' 里能找到 ' + cardName + '（跟全图同名）', false, { cardFile });
          continue;
        }
        const buf = fs.readFileSync(cardFile);
        const info = jpegInfo(buf);
        check('产物：card/' + tab.key + ' 的卡片图真的是 JPEG（不是 webp 改名）',
          !!info && buf.slice(0, 4).toString('latin1') !== 'RIFF', { head: buf.slice(0, 4).toString('hex') });
        if (!info) continue;
        check('产物：card/' + tab.key + ' 的卡片图长边 = 900（等比放大到 900）',
          Math.max(info.width, info.height) === 900, info);
        /* 原比例：卡片图与母本（manifest 里的 w/h）比例一致（允许四舍五入误差）。 */
        const cardRatio = info.width / info.height;
        const itemRatio = Number(sample.w) / Number(sample.h);
        check('产物：card/' + tab.key + ' 的卡片图保持原比例',
          Number.isFinite(itemRatio) && itemRatio > 0 &&
          Math.abs(cardRatio - itemRatio) / itemRatio < 0.01,
          { card: cardRatio, item: itemRatio, itemWH: [sample.w, sample.h], cardWH: [info.width, info.height] });
      }

      /* 方形卡片图（card-sq/）：微信 1:1 居中裁剪用的那套 —— 必须是 640×640 正方形。
         少了这一套，og:image 就会退回长边版，微信裁完只剩 29%~100% 面积。 */
      const squareRoot = path.join(dir, 'card-sq');
      if (!fs.existsSync(squareRoot)) {
        console.log('  （这一期还没有 card-sq/，跳过方形卡片图断言 —— 跑一次 node tools/build.mjs 就能查）');
      } else {
        for (const tab of manifest.tabs || []) {
          const sqDir = path.join(squareRoot, tab.key);
          if (!fs.existsSync(sqDir)) continue;
          const sqFiles = fs.readdirSync(sqDir).filter((f) => /\.jpe?g$/i.test(f));
          const sqItems = tab.items || [];

          check('产物：card-sq/' + tab.key + ' 的方形卡片图数量 = 该栏当期的图片数',
            sqFiles.length === sqItems.length, { files: sqFiles.length, items: sqItems.length });

          if (!sqItems.length || !sqFiles.length) continue;
          const sqSample = sqItems[0];
          const sqName = path.basename(sqSample.full || '').replace(/\.[A-Za-z0-9]+$/, '.jpg');
          const sqFile = path.join(sqDir, sqName);
          if (!fs.existsSync(sqFile)) {
            check('产物：card-sq/' + tab.key + ' 里能找到 ' + sqName + '（跟全图同名）', false, { sqFile });
            continue;
          }
          const sqBuf = fs.readFileSync(sqFile);
          const sqInfo = jpegInfo(sqBuf);
          check('产物：card-sq/' + tab.key + ' 的方形卡片图真的是 JPEG（不是 webp 改名）',
            !!sqInfo && sqBuf.slice(0, 4).toString('latin1') !== 'RIFF',
            { head: sqBuf.slice(0, 4).toString('hex') });
          if (!sqInfo) continue;
          check('产物：card-sq/' + tab.key + ' 的方形卡片图是 640×640 正方形',
            sqInfo.width === 640 && sqInfo.height === 640, sqInfo);
        }
      }

      /* manifest 里的 src：只有当这一期的 manifest **本身带 src** 时才断言 ——
         加 src 之前构建出来的旧 manifest 没有这个键，
         那时候硬断言就是「拿旧产物冤枉新代码」，必须跳过并说明。 */
      const hasSrcAnywhere = (manifest.tabs || []).some((t) =>
        (t.items || []).some((it) => Object.prototype.hasOwnProperty.call(it, 'src')));
      if (!hasSrcAnywhere) {
        console.log('  （这一期的 manifest 还没带 src —— 是加 src 之前构建的，跳过 src 相关断言 —— 跑一次 node tools/build.mjs 就能查）');
      } else {
        const jianxiao = (manifest.tabs || []).find((t) => t.key === 'jianxiao');
        const withSrc = (jianxiao?.items || []).filter((it) => Object.prototype.hasOwnProperty.call(it, 'src'));
        check('产物：manifest 里见笑的 item 带 src 且形如 https://t.me/...',
          withSrc.length > 0 && withSrc.every((it) => /^https:\/\/t\.me\//.test(it.src)),
          { count: withSrc.length, sample: withSrc[0] });
        for (const key of ['jianshe', 'jianwen']) {
          const tab = (manifest.tabs || []).find((t) => t.key === key);
          const items = tab?.items || [];
          check('产物：manifest 里 ' + key + ' 的 item 没有 src 这个键',
            items.length > 0 && items.every((it) => !Object.prototype.hasOwnProperty.call(it, 'src')),
            { items: items.length });
        }
      }
    }
  }
}

console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + '：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
