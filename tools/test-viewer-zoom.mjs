#!/usr/bin/env node
/**
 * 大图查看器的**缩放**护栏（Playwright 真跑手势）
 *
 * 为什么要有这个：
 *   用户反馈「见笑的图片无法放大」。查下来是两件不同的事：
 *     ① 查看器里**一点缩放能力都没有** —— `transform:none`、没有缩放 UI，
 *        而站点 `<meta viewport>` 写着 `user-scalable=no` + `maximum-scale=1.0`，
 *        **浏览器自带的双指缩放也被全局禁了** → 手机上真的一点放大办法都没有；
 *     ② 见笑的梗图最长边只有 800px —— 那是**上游图源给的上限**，
 *        改构建参数也提不高（护栏管不了，只能写进注释提醒别白费力气）。
 *
 *   护栏只能守住 ①。② 是事实，只能靠注释和文档说清楚。
 *
 * 测什么（每条都是**行为**断言，不是「源码里写没写」）：
 *   · 双击放大 / 再双击还原
 *   · 双指捏合放大（合成 touch 事件，走 CDP 的多指通道）
 *   · 桌面滚轮放大；缩小到 1× 以下会被夹住
 *   · 放大后单指拖动 = 平移，**不切图**；平移有边界
 *   · 放大状态下单击 = 还原，**不关闭**
 *   · 1× 状态下的老行为不能坏：横向滑动切图、单击关闭
 *   · 构建侧：大图宽度上限是 1920（见笑/见闻不受影响，见她那栏不再被压）
 *
 * 为什么必须用真 Playwright：这些都是手势。
 * 源码 grep 只能证明「代码写了 setZoom」，证明不了「双击之后 transform 真的变了」——
 * 手势逻辑最容易被后来的改动悄悄改坏（比如把 passive 改回去、把 dblclick 漏掉）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'site');

const DATE = '2026-11-26';

/* 假大图：800×600 的 SVG。
   不用真 PNG —— SVG 写死 width/height，Chromium 报的 naturalWidth 就是 800，
   不必在测试里塞二进制、也不必依赖 ffmpeg。
   尺寸必须是**已知**的：缩放的边界计算全靠它。 */
const FULL_W = 800;
const FULL_H = 600;
function svg(w, h) {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
    '<rect width="100%" height="100%" fill="#334"/>' +
    '<circle cx="' + (w / 2) + '" cy="' + (h / 2) + '" r="' + Math.min(w, h) / 4 + '" fill="#fc0"/>' +
    '</svg>'
  );
}
const FULL_SVG = svg(FULL_W, FULL_H);
const THUMB_SVG = svg(400, 300);

function manifest() {
  const items = [];
  for (let i = 1; i <= 3; i++) {
    items.push({
      id: 'jx_' + String(i).padStart(3, '0'),
      w: FULL_W, h: FULL_H, tw: 400, th: 300,
      thumb: '/img/thumb.svg', full: '/img/full.svg',
    });
  }
  return {
    date: DATE,
    generatedAt: '2026-11-26T00:00:00.000Z',
    title: '测试',
    siteUrl: 'http://127.0.0.1',
    imageBase: '/img',
    defaultTab: 'jianxiao',
    tabs: [
      {
        key: 'jianxiao', label: '见笑', accent: '#ffb020', count: items.length, items,
      },
    ],
  };
}

function renderTemplate(mf) {
  let html = fs.readFileSync(path.join(SITE, 'template.html'), 'utf8');
  const m = JSON.stringify(mf).replace(/</g, '\\u003c');
  return html
    .replace(/\{\{PAGE_TITLE\}\}/g, '测试页')
    .replace(/\{\{PAGE_DESC\}\}/g, '测试')
    .replace(/\{\{SITE_URL\}\}/g, 'http://127.0.0.1')
    .replace(/\{\{OG_URL\}\}/g, 'http://127.0.0.1')
    .replace(/\{\{ASSET_BASE\}\}/g, '/assets')
    .replace(/\{\{CSS\}\}/g, '/app.css')
    .replace(/\{\{JS\}\}/g, '/app.js')
    .replace(/\{\{TITLE\}\}/g, '测试')
    .replace(/\{\{DATE\}\}/g, DATE)
    .replace(/\{\{HOME\}\}/g, '/archive/')
    .replace(
      /<script src="\{\{MANIFEST\}\}" defer><\/script>/,
      '<script>window.__DAILY_MANIFEST__ = ' + m + ';</script>',
    );
}

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    const html = renderTemplate(manifest());
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(html);
    return;
  }
  if (url === '/app.js') {
    res.writeHead(200, { 'Content-Type': MIME['.js'] });
    res.end(fs.readFileSync(path.join(SITE, 'app.js')));
    return;
  }
  if (url === '/app.css') {
    res.writeHead(200, { 'Content-Type': MIME['.css'] });
    res.end(fs.readFileSync(path.join(SITE, 'app.css')));
    return;
  }
  if (url === '/img/full.svg') {
    res.writeHead(200, { 'Content-Type': MIME['.svg'] });
    res.end(FULL_SVG);
    return;
  }
  if (url === '/img/thumb.svg') {
    res.writeHead(200, { 'Content-Type': MIME['.svg'] });
    res.end(THUMB_SVG);
    return;
  }
  res.writeHead(404).end('404');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;

/* ── 读页面上的缩放状态 ────────────────────────────────────
   zoom 是闭包里的变量，外部读不到 → 从 DOM 反推：
   · data-zoom = 比例的数字真值（应用里写死的，用来断言「夹在 1×~4×」）
   · transform 里同时有 scale() 和 translate3d()，徽标上是倍数。 */
async function zstate(page) {
  return page.evaluate(() => {
    const img = document.getElementById('viewerImg');
    const badge = document.getElementById('viewerZoom');
    const stage = document.getElementById('viewerStage');
    const raw = (img && img.style.transform) || '';
    const ms = /scale\(([\d.]+)\)/.exec(raw);
    const mt = /translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(raw);
    return {
      zoom: stage ? Number(stage.getAttribute('data-zoom')) : 1,
      scale: ms ? Number(ms[1]) : 1,
      tx: mt ? Number(mt[1]) : 0,
      ty: mt ? Number(mt[2]) : 0,
      raw,
      badge: badge && !badge.hidden ? badge.textContent : '',
      badgeHidden: badge ? badge.hidden : true,
      viewerOpen: !document.getElementById('viewer').hidden,
      count: document.getElementById('viewerCount').textContent,
      natural: img ? img.naturalWidth + 'x' + img.naturalHeight : '',
    };
  });
}

/** 点开第一张大图，并等它真的解码完（固定 sleep 会误判成「加载不出来」）。 */
async function openFirst(page) {
  await page.click('#grid-jianxiao .cell');
  await page.waitForFunction(
    () => {
      const i = document.getElementById('viewerImg');
      return !!i && i.complete && i.naturalWidth > 0;
    },
    { timeout: 15000 },
  );
  await page.waitForTimeout(120);
}

/** 合成多指 touch（CDP 才有真正的多指通道，page.touchscreen 只有 tap）。 */
async function touchSeq(cdp, type, points) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
}

const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] });

/* ══════════ 触屏（手机）══════════ */
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.route('**/likes/api*', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"count":0}' }),
);
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(300);
const cdp = await ctx.newCDPSession(page);

console.log('\n── 触屏：双击 / 捏合 / 平移 ──');

/** 关掉再打开，回到干净状态（1×、第一张图）。
 *
 *  每组场景都从这里开始 —— 上一组留下的副作用（尤其是「还没到点的延时关闭
 *  定时器」）就不会把下一组的结果搅黄。
 *  2026-11-26 变异实测踩过：不隔离的话，一条变异引发的连锁反应
 *  会把后面好几条断言一起带偏，护栏就看不出「到底哪一条被改坏了」。 */
async function reopen(page) {
  await page.evaluate(() => {
    const v = document.getElementById('viewer');
    if (v && !v.hidden) document.getElementById('viewerClose').click();
  });
  await page.waitForTimeout(320);
  await openFirst(page);
}

const CX = 195;
const CY = 420;

await reopen(page);
let s = await zstate(page);
check('点开大图后查看器是开的，图已解码', s.viewerOpen && s.natural === FULL_W + 'x' + FULL_H, s);
check('刚打开时是 1×（没有残留的放大）', s.zoom === 1 && s.scale === 1 && s.raw === '', s);

/* ① 双击放大 */
await page.touchscreen.tap(CX, CY);
await page.waitForTimeout(60);
await page.touchscreen.tap(CX, CY);
await page.waitForTimeout(200);
s = await zstate(page);
check('双击放大：比例变成 2.5×', Math.abs(s.zoom - 2.5) < 0.01 && Math.abs(s.scale - 2.5) < 0.01, s);
check('双击放大：查看器没有被关掉', s.viewerOpen, s);
check('双击放大：倍数徽标显示 2.5×', s.badge === '2.5×', s);

/* ② 再双击还原（先放大，再双击回来） */
await reopen(page);
await page.touchscreen.tap(CX, CY);
await page.waitForTimeout(60);
await page.touchscreen.tap(CX, CY);
await page.waitForTimeout(200);
s = await zstate(page);
check('双击能先放大到 2.5×', Math.abs(s.zoom - 2.5) < 0.01, s);
await page.touchscreen.tap(CX, CY);
await page.waitForTimeout(60);
await page.touchscreen.tap(CX, CY);
await page.waitForTimeout(200);
s = await zstate(page);
check('再双击还原：回到 1×', s.zoom === 1 && s.scale === 1 && s.raw === '', s);
check('再双击还原：徽标隐藏', s.badgeHidden, s);

/* ③ 双指捏合放大 */
await reopen(page);
await touchSeq(cdp, 'touchStart', [{ x: CX - 40, y: CY, id: 1 }, { x: CX + 40, y: CY, id: 2 }]);
await touchSeq(cdp, 'touchMove', [{ x: CX - 80, y: CY, id: 1 }, { x: CX + 80, y: CY, id: 2 }]);
await touchSeq(cdp, 'touchEnd', []);
await page.waitForTimeout(200);
s = await zstate(page);
check('双指捏合能放大（两指分开 → 比例变大）', s.zoom > 1.5 && s.scale > 1.5, s);
check('捏合放大后查看器还开着', s.viewerOpen, s);

/* ④ 放大后单指拖动 = 平移，**不切图** */
const before = await zstate(page);
await touchSeq(cdp, 'touchStart', [{ x: CX, y: CY, id: 1 }]);
await touchSeq(cdp, 'touchMove', [{ x: CX - 90, y: CY, id: 1 }]);
await touchSeq(cdp, 'touchEnd', []);
await page.waitForTimeout(150);
s = await zstate(page);
check('放大后单指拖动会平移（translate 变了）', Math.abs(s.tx - before.tx) > 5, { before, after: s });
check('放大后拖动**不切图**（序号没变）', s.count === before.count, { before, after: s });

/* ⑤ 放大状态下单击 = 还原，不关闭 */
await reopen(page);
await touchSeq(cdp, 'touchStart', [{ x: CX - 40, y: CY, id: 1 }, { x: CX + 40, y: CY, id: 2 }]);
await touchSeq(cdp, 'touchMove', [{ x: CX - 80, y: CY, id: 1 }, { x: CX + 80, y: CY, id: 2 }]);
await touchSeq(cdp, 'touchEnd', []);
await page.waitForTimeout(150);
await page.touchscreen.tap(CX, CY);
await page.waitForTimeout(320);
s = await zstate(page);
check('放大状态下单击 = 还原到 1×', s.zoom === 1 && s.scale === 1, s);
check('放大状态下单击**不关闭**查看器', s.viewerOpen, s);

/* ⑥ 平移边界：放大后往一个方向死拖，图不能被拖出屏幕
   ⚠️ 捏合要停在 **2×**：上限 4× 时允许的平移量（(390×4−390)/2 = 585px）
      比屏幕还宽 —— 手指在屏幕里根本拖不出那个范围，这条断言就永远绿着。 */
await reopen(page);
await touchSeq(cdp, 'touchStart', [{ x: CX - 40, y: CY, id: 1 }, { x: CX + 40, y: CY, id: 2 }]);
await touchSeq(cdp, 'touchMove', [{ x: CX - 80, y: CY, id: 1 }, { x: CX + 80, y: CY, id: 2 }]);
await touchSeq(cdp, 'touchEnd', []);
await page.waitForTimeout(150);
await touchSeq(cdp, 'touchStart', [{ x: 380, y: CY, id: 1 }]);
await touchSeq(cdp, 'touchMove', [{ x: 5, y: CY, id: 1 }]);
await touchSeq(cdp, 'touchMove', [{ x: 5, y: CY, id: 1 }]);
await touchSeq(cdp, 'touchEnd', []);
await page.waitForTimeout(150);
s = await zstate(page);
const bound = await page.evaluate(() => {
  const img = document.getElementById('viewerImg');
  const stage = document.getElementById('viewerStage');
  const m = /scale\(([\d.]+)\)/.exec(img.style.transform || '');
  const z = m ? Number(m[1]) : 1;
  const maxX = Math.max(0, (img.offsetWidth * z - stage.clientWidth) / 2);
  return { maxX: Math.round(maxX) };
});
check('平移有边界：拖到底也不会超出允许范围',
  s.tx <= bound.maxX + 1 && s.tx >= -(bound.maxX + 1), { tx: s.tx, bound });

/* ⑦ 1× 状态的老行为不能坏：横向滑动切图 */
await reopen(page);
const pre = await zstate(page);
await touchSeq(cdp, 'touchStart', [{ x: 320, y: CY, id: 1 }]);
await touchSeq(cdp, 'touchMove', [{ x: 180, y: CY, id: 1 }]);
await touchSeq(cdp, 'touchEnd', []);
await page.waitForTimeout(200);
s = await zstate(page);
check('1× 状态横向滑动仍然切图（老行为没坏）',
  s.count !== pre.count && /^2 \/ /.test(s.count), { pre, after: s });

/* ⑧ 单击仍然关闭查看器（延后 240ms 之后） */
await reopen(page);
await page.touchscreen.tap(CX, CY);
await page.waitForTimeout(500);
s = await zstate(page);
check('单击仍然关闭查看器（延后 240ms 关）', s.viewerOpen === false, s);

check('触屏这一路没有 JS 报错', errors.length === 0, errors);

await ctx.close();

/* ══════════ 桌面（滚轮 + 双击）══════════ */
console.log('\n── 桌面：滚轮 / 双击 ──');
const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page2 = await ctx2.newPage();
const errors2 = [];
page2.on('pageerror', (e) => errors2.push(String(e)));
await page2.route('**/likes/api*', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"count":0}' }),
);
await page2.goto(base, { waitUntil: 'domcontentloaded' });
await page2.waitForTimeout(300);

await openFirst(page2);
let d = await zstate(page2);
check('桌面：点开大图后是 1×', d.zoom === 1 && d.scale === 1, d);

/* 滚轮放大 */
await page2.mouse.move(640, 400);
await page2.mouse.wheel(0, -300);
await page2.waitForTimeout(200);
d = await zstate(page2);
check('桌面滚轮能放大', d.scale > 1.05, d);

/* 一直往下滚 → 夹在 1×，不能小于 1 */
for (let i = 0; i < 12; i++) await page2.mouse.wheel(0, 300);
await page2.waitForTimeout(250);
d = await zstate(page2);
check('滚轮缩到最小会夹在 1×（不会小于 1）', d.zoom === 1 && d.scale === 1 && d.raw === '', d);

/* 一直往上滚 → 夹在 4× */
for (let i = 0; i < 20; i++) await page2.mouse.wheel(0, -300);
await page2.waitForTimeout(250);
d = await zstate(page2);
check('滚轮放到最大会夹在 4×（不会无限放大）', d.zoom <= 4.001 && d.zoom > 3.5, d);

/* 桌面双击：先回到 1×，再双击放大、再双击还原。
   ⚠️ 双击是「切换」：在 4× 上双击是**还原**到 1×，不是放大。
      所以这里必须先滚回 1× 再测 —— 否则断言写的是「放大」，
      实际测到的是「还原」，看起来像实现坏了，其实断言写错了。 */
for (let i = 0; i < 20; i++) await page2.mouse.wheel(0, 300);
await page2.waitForTimeout(250);
d = await zstate(page2);
check('滚轮能回到 1×（桌面双击的前置状态）', d.zoom === 1, d);

await page2.mouse.dblclick(640, 400);
await page2.waitForTimeout(250);
d = await zstate(page2);
check('桌面双击能放大', d.zoom > 1.5, d);

await page2.mouse.dblclick(640, 400);
await page2.waitForTimeout(250);
d = await zstate(page2);
check('桌面再双击能还原到 1×', d.zoom === 1, d);

check('桌面这一路没有 JS 报错', errors2.length === 0, errors2);
await ctx2.close();
await browser.close();
server.close();

/* ══════════ 静态断言：CSS 与构建参数 ══════════ */
console.log('\n── 静态：CSS / 构建参数 ──');

const css = fs.readFileSync(path.join(SITE, 'app.css'), 'utf8');
const stageBlock = (css.match(/\.viewer-stage \{[^}]*\}/) || [''])[0];
const imgBlock = (css.match(/\.viewer-stage img \{[^}]*\}/) || [''])[0];
/* ⚠️ 正则必须**锚到行首**：CSS 里还有 `-ms-touch-action` 和 `-webkit-transform-origin`
   两行带前缀的同义写法，不锚行首的话，
   「去掉 touch-action」这种变异根本不会让断言变红（护栏自己就没有牙齿）。 */
check('CSS：.viewer-stage 禁掉了浏览器自己的手势（touch-action:none）',
  /^[ \t]*touch-action:[ \t]*none;/m.test(stageBlock), stageBlock);
check('CSS：.viewer-stage img 的缩放锚点是中心（transform-origin:center center）',
  /^[ \t]*transform-origin:[ \t]*center center;/m.test(imgBlock), imgBlock);

const tpl = fs.readFileSync(path.join(SITE, 'template.html'), 'utf8');
check('页面提示里写了「双击放大」（用户知道能放大）', /双击放大/.test(tpl), '');
check('页面里有倍数徽标容器（#viewerZoom）', /id="viewerZoom"/.test(tpl), '');

const buildSrc = fs.readFileSync(path.join(ROOT, 'tools', 'build.mjs'), 'utf8');
const fullMax = (buildSrc.match(/const FULL_MAX_W = (\d+);/) || [])[1];
check('构建：大图宽度上限是 1920（源图上限，见她那栏不再被压到 1080）',
  fullMax === '1920', { fullMax });

console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + '：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
