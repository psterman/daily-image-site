#!/usr/bin/env node
/**
 * 「一滑就退出网页」的护栏（横向越界 → 浏览器历史回退）
 *
 * 问题：手机上横滑一下，网页直接退回了。
 *
 * 机制（规范 + 实测）：
 *   视口的**横向越界**（overscroll）在 Chrome / Android 上会触发**历史回退**
 *   （规范里叫 horizontal swipe navigation）。
 *   只要页面上有**横向滚动容器**（tab 栏、见报的分类 chip），滑到头继续滑 →
 *   **滚动链**一路传到根 → 根再横向越界 → 浏览器判成「用户想后退」→ 页面退出。
 *
 * 修法（两条都要）：
 *   ① **显式滚动容器**上 `overscroll-behavior-x: contain`
 *      —— 这才是真正管用的那一处（根元素上的同款在老 iOS / 微信 X5 会被静默忽略，
 *         而这个属性**只在显式滚动容器上生效**）。
 *   ② 根上 `overscroll-behavior-x: none` 兜底（只关 x，y 轴留着，下拉刷新不受影响）。
 *   ③ 查看器里我们自己做横向手势时**必须 preventDefault** —— 不然浏览器有机会
 *      把它当成自己的越界手势。
 *
 * 测什么：
 *   · 静态：三个声明在不在（**锚到行首**，见 memory 里那条教训）
 *   · 真浏览器：computed style 是不是真的生效（规则没写错选择器）
 *   · 真浏览器：**滚动链本体** —— 把 chips 拖到头再往外拖，**文档不能被带着滚**
 *   · 真浏览器：查看器里横向拖动**被页面接管**（defaultPrevented），
 *     纵向拖动**不被拦**（别把系统行为挡掉），横向拖动**仍然切图**（老行为不坏）
 *   · 真浏览器：**返回陷阱** —— 看大图时按返回，关的是大图，不是整页
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
      { key: 'jianxiao', label: '见笑', accent: '#ffb020', count: items.length, items },
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
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(renderTemplate(manifest()));
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
    res.end(svg(FULL_W, FULL_H));
    return;
  }
  if (url === '/img/thumb.svg') {
    res.writeHead(200, { 'Content-Type': MIME['.svg'] });
    res.end(svg(400, 300));
    return;
  }
  res.writeHead(404).end('404');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;

/* ─────────────────────────────────────────────────────────
 * ① 静态断言（源码级）
 *
 * ⚠️ 正则**锚到行首**：CSS 里同义写法（`-ms-` / `-webkit-` 前缀）会喂饱断言，
 *    去掉真声明护栏也不红 —— memory 里那条教训。
 *    还要**限定在对应的规则块里**，不能整份文件搜。
 * ───────────────────────────────────────────────────────── */
const css = fs.readFileSync(path.join(SITE, 'app.css'), 'utf8');
const js = fs.readFileSync(path.join(SITE, 'app.js'), 'utf8');

/** 取某个选择器规则块的内容（`}` 之前），用于「这条声明在这个块里」的断言 */
function ruleBlock(src, selector) {
  const i = src.indexOf(selector + ' {');
  if (i < 0) return '';
  const j = src.indexOf('}', i);
  return j < 0 ? '' : src.slice(i, j);
}

const htmlBodyBlock = ruleBlock(css, 'html, body');
const tabsBlock = ruleBlock(css, '.tabs');
const chipsBlock = ruleBlock(css, '.chips');

check('静态：html, body 规则里有 overscroll-behavior-x: none',
  /^[ \t]*overscroll-behavior-x:[ \t]*none[ \t]*;/m.test(htmlBodyBlock), htmlBodyBlock.slice(0, 120));
check('静态：.tabs 规则里有 overscroll-behavior-x: contain',
  /^[ \t]*overscroll-behavior-x:[ \t]*contain[ \t]*;/m.test(tabsBlock), tabsBlock.slice(0, 160));
check('静态：.chips 规则里有 overscroll-behavior-x: contain',
  /^[ \t]*overscroll-behavior-x:[ \t]*contain[ \t]*;/m.test(chipsBlock), chipsBlock.slice(0, 160));
check('静态：查看器 1× 横向拖动分支有 preventDefault（页面接管手势）',
  /Math\.abs\(dx\)\s*>\s*Math\.abs\(dy\)[^\n]*\n?[^\n]*preventDefault/.test(js) ||
  /preventDefault\(\);\s*\n[^\n]*\/\*[^*]*\*\/\s*\n?[^\n]*moved = true/.test(js) ||
  /Math\.abs\(dx\)\s*>\s*Math\.abs\(dy\)[\s\S]{0,120}?preventDefault\(\)/.test(js));
check('静态：返回陷阱有 pushState（压历史）+ popstate 监听（接住返回）',
  /^[ \t]*history\.pushState\(/m.test(js) &&
  /^[ \t]*window\.addEventListener\('popstate'/m.test(js),
  {
    pushState: /^[ \t]*history\.pushState\(/m.test(js),
    popstate: /^[ \t]*window\.addEventListener\('popstate'/m.test(js),
  });

/* ─────────────────────────────────────────────────────────
 * ② 真浏览器：computed style + 滚动链 + 手势
 * ───────────────────────────────────────────────────────── */
const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
});
const page = await ctx.newPage();
await page.route('**/likes/api*', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"count":0}' }),
);
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(400);

/* 造两个横向滚动容器 + 一个横向可滚的文档（用来观察滚动链有没有外传） */
await page.evaluate(() => {
  const mk = (cls, n, label) => {
    const d = document.createElement('div');
    d.className = cls;                    // ← 注意：类名**不带点**（'.tabs' 是选择器，不是类名）
    d.id = cls === 'tabs' ? 'probeTabs' : 'probeChips';
    /* 固定到屏幕上的已知位置 —— 追加在 body 末尾的话它在首屏之外，
       手指根本碰不到，测的就不是它了。 */
    d.style.cssText = 'position:fixed;top:600px;left:0;width:300px;height:60px;z-index:5;background:#222';
    for (let i = 0; i < n; i++) {
      const c = document.createElement('span');
      c.textContent = label + i;
      c.style.cssText = 'display:inline-block;width:120px;height:40px;background:#333;color:#fff';
      d.appendChild(c);
    }
    document.body.appendChild(d);
  };
  mk('tabs', 12, 'tab');
  mk('chips', 12, 'chip');
  /* 让文档本身横向可滚 —— 滚动链一旦外传，window.scrollX 就会变 */
  const wide = document.createElement('div');
  wide.style.cssText = 'width:3000px;height:10px';
  document.body.appendChild(wide);
  const st = document.createElement('style');
  st.textContent = 'html{overflow-x:auto !important}body{overflow-x:visible !important}';
  document.head.appendChild(st);
});
await page.waitForTimeout(200);

const computed = await page.evaluate(() => {
  const g = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { x: cs.overscrollBehaviorX, y: cs.overscrollBehaviorY };
  };
  return {
    html: g('html'),
    body: g('body'),
    tabs: g('#probeTabs'),
    chips: g('#probeChips'),
  };
});
check('真浏览器：html 的 computed overscroll-behavior-x = none', computed.html && computed.html.x === 'none', computed.html);
check('真浏览器：body 的 computed overscroll-behavior-x = none', computed.body && computed.body.x === 'none', computed.body);
check('真浏览器：.tabs 的 computed overscroll-behavior-x = contain', computed.tabs && computed.tabs.x === 'contain', computed.tabs);
check('真浏览器：.chips 的 computed overscroll-behavior-x = contain', computed.chips && computed.chips.x === 'contain', computed.chips);

const cdp = await ctx.newCDPSession(page);
/** 单指拖动：从 from 拖到 to（**一根手指**，不是两点 —— 两点会被当成捏合） */
async function touchDrag(from, to, steps) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
  for (let k = 1; k <= steps; k++) {
    const x = from.x + (to.x - from.x) * (k / steps);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: from.y, id: 1 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/* ③ 滚动链本体：把 chips 拖到**头**再继续往外拖，文档不能被带着滚。
      （有 contain → 越界停在容器里；没有 → 传给根 → 根横向滚 → 正是回退手势的来源） */
const chain = await page.evaluate(() => {
  const chips = document.getElementById('probeChips');
  chips.scrollLeft = chips.scrollWidth;   // 先顶到最右（会被夹到最大值）
  window.scrollTo(0, 0);
  return {
    scrollLeft: chips.scrollLeft,
    maxScrollLeft: chips.scrollWidth - chips.clientWidth,
    scrollWidth: chips.scrollWidth,
    docX: window.scrollX,
  };
});
/* 起点必须落在 chips 里面（它宽 300px）—— 否则摸到的是页面，测的就不是它了 */
await touchDrag({ x: 280, y: 630 }, { x: 20, y: 630 }, 12);
await page.waitForTimeout(400);
const afterChain = await page.evaluate(() => ({
  docX: window.scrollX,
  chipsLeft: document.getElementById('probeChips').scrollLeft,
}));
check('真浏览器：chips 滑到头再往外拖，文档没被带着横向滚（越界不外传 = 不会触发回退）',
  afterChain.docX === 0, { before: chain, after: afterChain });

/* 探针用完了，撤掉，免得挡住后面的查看器手势 */
await page.evaluate(() => {
  document.getElementById('probeTabs')?.remove();
  document.getElementById('probeChips')?.remove();
});

/* ④ 查看器：横向拖动被页面接管（defaultPrevented）→ 浏览器不会拿它当回退手势 */
await page.evaluate(() => {
  window.__mv = [];
  document.addEventListener('touchmove', (e) => { window.__mv.push(e.defaultPrevented); }, false);
});
await page.click('#grid-jianxiao .cell');
await page.waitForFunction(() => {
  const i = document.getElementById('viewerImg');
  return !!i && i.complete && i.naturalWidth > 0;
}, { timeout: 15000 });
await page.waitForTimeout(300);

/* 横向拖（**往左**滑 = 下一张；app.js 里 `step(dx < 0 ? 1 : -1)`） */
const countBefore = await page.evaluate(() => document.getElementById('viewerCount')?.textContent || '');
await touchDrag({ x: 330, y: 420 }, { x: 120, y: 420 }, 10);
await page.waitForTimeout(400);
const afterH = await page.evaluate(() => ({
  mv: window.__mv.slice(),
  count: document.getElementById('viewerCount')?.textContent || '',
}));
check('真浏览器：查看器里横向拖动被 preventDefault（页面接管，不给浏览器回退的机会）',
  afterH.mv.length > 0 && afterH.mv[afterH.mv.length - 1] === true, afterH.mv.slice(-3));
check('真浏览器：横向拖动仍然切图（老行为不坏）',
  afterH.count && afterH.count !== countBefore, { before: countBefore, after: afterH.count });

/* 纵向拖：不该拦（别把系统行为挡掉） */
await page.evaluate(() => { window.__mv = []; });
await touchDrag({ x: 195, y: 200 }, { x: 195, y: 640 }, 10);
await page.waitForTimeout(400);
const afterV = await page.evaluate(() => window.__mv.slice());
check('真浏览器：查看器里纵向拖动不被拦（系统行为照旧）',
  afterV.length === 0 || afterV[afterV.length - 1] === false, afterV.slice(-3));

/* ─────────────────────────────────────────────────────────
 * ⑤ 返回陷阱：看大图时按返回 → 关的是大图，不是整页
 *
 * ⚠️ 这几组用**独立的页面**跑：万一陷阱没生效，history.back()
 *    会真的把页面退走（回到上一张），放在共用页面上会把前面
 *    几组断言一起带偏 —— 那叫「状态串场」，护栏就不可信了。
 * ───────────────────────────────────────────────────────── */
const trapPage = await ctx.newPage();
await trapPage.route('**/likes/api*', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"count":0}' }),
);
await trapPage.goto(base, { waitUntil: 'domcontentloaded' });
await trapPage.waitForTimeout(400);

const trapLenBefore = await trapPage.evaluate(() => history.length);
await trapPage.click('#grid-jianxiao .cell');
await trapPage.waitForFunction(() => {
  const i = document.getElementById('viewerImg');
  return !!i && i.complete && i.naturalWidth > 0;
}, { timeout: 15000 });
await trapPage.waitForTimeout(300);
const trapOpen = await trapPage.evaluate(() => ({
  len: history.length,
  state: history.state,
}));
check('真浏览器：打开大图时压了一条历史（返回手势会被大图吃掉）',
  trapOpen.len === trapLenBefore + 1 && !!(trapOpen.state && trapOpen.state.vt),
  { before: trapLenBefore, after: trapOpen });

/* 关掉大图 → 我们把自己压的那条退掉 → 返回键恢复正常（不多按一次）。
 *
 * ⚠️ 判据不能看 `history.length` —— 按规范，**后退不会让 length 变短**
 *    （前进位还留在列表里，只是当前项退回去了）；length 变短是「又压了一条」才有的效果。
 *    精确判据 = **当前项不再是陷阱项**（history.state 里没有我们写的 vt 标记）。
 */
await trapPage.click('#viewerClose');
await trapPage.waitForTimeout(400);
const trapClosed = await trapPage.evaluate(() => ({ len: history.length, state: history.state }));
check('真浏览器：关掉大图后陷阱被收回（下一次返回是正常退出页面）',
  !(trapClosed.state && trapClosed.state.vt), { before: trapOpen, after: trapClosed });

/* 再打开一次 → 按返回 → 大图关上，页面不退出 */
await trapPage.click('#grid-jianxiao .cell');
await trapPage.waitForFunction(() => {
  const v = document.getElementById('viewer');
  return v && !v.hidden;
}, { timeout: 15000 });
await trapPage.waitForTimeout(300);
/* 这个标记只有「页面没被重新加载」才会还在 */
await trapPage.evaluate(() => { window.__noReload = 'ok'; });
await trapPage.evaluate(() => history.back());
await trapPage.waitForTimeout(500);

/* 陷阱没生效时，history.back() 会把页面真的退走 → evaluate 会抛。
 * 那不是「护栏崩了」，那是**这一条断言该红** —— 抓住它，别让整套脚本崩掉。 */
let afterBack = null;
try {
  afterBack = await trapPage.evaluate(() => ({
    hidden: document.getElementById('viewer')?.hidden,
    noReload: window.__noReload === 'ok',
    href: location.href,
    cells: document.querySelectorAll('#grid-jianxiao .cell').length,
  }));
} catch (e) {
  afterBack = { hidden: null, noReload: false, href: '', cells: 0, error: String(e && e.message || e) };
}
check('真浏览器：查看器开着时按返回 → 大图关上、页面没退出去',
  !!afterBack && afterBack.hidden === true && afterBack.noReload === true &&
  String(afterBack.href).startsWith(base) && afterBack.cells > 0,
  afterBack);

/* 最后一条：陷阱**不能把用户困在站内**（返回键怎么按都出不去 = 骚扰）。
   关掉大图后按返回 → 页面要真的退走。 */
const leavePage = await ctx.newPage();
await leavePage.goto(base, { waitUntil: 'domcontentloaded' });
await leavePage.waitForTimeout(400);
await leavePage.click('#grid-jianxiao .cell');
await leavePage.waitForFunction(() => {
  const v = document.getElementById('viewer');
  return v && !v.hidden;
}, { timeout: 15000 });
await leavePage.waitForTimeout(300);
await leavePage.click('#viewerClose');
await leavePage.waitForTimeout(400);
await leavePage.evaluate(() => history.back());
await leavePage.waitForTimeout(600);
let afterLeave = null;
try {
  afterLeave = await leavePage.evaluate(() => ({ href: location.href }));
} catch (e) {
  afterLeave = { href: '<上下文已销毁>', error: String(e && e.message || e) };
}
check('真浏览器：关掉大图后按返回，页面能真的退出去（陷阱不困人）',
  !(afterLeave && String(afterLeave.href).startsWith(base)), afterLeave);

await browser.close();
server.close();

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
