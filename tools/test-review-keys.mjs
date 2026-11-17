#!/usr/bin/env node
/**
 * 审稿台「回车选中」的 Playwright 测试
 *
 * 为什么要有这个测试：
 *   审稿台的选中是纯前端键盘交互。事件挂在 document 上、查看器和网格
 *   两套焦点、按钮上的回车不能被抢 —— 这三处都容易「看着对、实际不灵」。
 *   光读代码说「接上了」不算数，所以真的开浏览器按回车，看图到底有没有被选中。
 *
 * 怎么做到不碰真的审稿台：
 *   1. IMAGE_ROOT 指到临时沙箱 → 审稿台读的是沙箱里的假图，不碰 ~/image-root
 *   2. REVIEW_PORT_FILE 指到沙箱 → 不会覆盖正在跑的那个审稿台的 .review-port
 *   3. 日期用 2000-01-01 → 不会跟任何真实期次撞
 *   4. /api/pass 被 route 拦截 → 不会真的生成放行凭证
 *
 * 变异测试（护栏有没有牙齿的判定标准）：
 *   把 review.mjs 里的 Enter 分支去掉，这个测试必须变红。
 *   跑法见文件末尾的 usage 说明。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* 被测脚本 —— 变异测试时指向 tools/ 下的副本（必须留在 tools/ 里，
   副本里的 './paths.mjs' 相对导入才解析得到） */
const SCRIPT = path.resolve(ROOT, process.env.REVIEW_SCRIPT || 'tools/review.mjs');

const SANDBOX = path.join(__dirname, '.tmp-reviewkeys');
const IMG_ROOT = path.join(SANDBOX, 'imageroot');
const PORT_FILE = path.join(SANDBOX, 'port.txt');
const DATE = '2000-01-01';
const CATS = ['见笑', '见闻', '见她'];
const PER_CAT = 3;
/* 当前网格里应该有几张 —— Delete 直接删除那节会真删掉一张，之后要跟着减。
   （写死 9 的话，删完之后后面几节都在等一个永远等不到的数量，
     表现成 waitForFunction 超时，跟被测功能无关。） */
let expectedCells = CATS.length * PER_CAT;

/* 1x1 PNG —— 网格只要能加载出来就行，尺寸不重要 */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else {
    fail++;
    console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
  }
}
function section(t) { console.log('\n── ' + t); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- 沙箱 */

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }

function buildSandbox() {
  rmrf(SANDBOX);
  for (const c of CATS) {
    const dir = path.join(IMG_ROOT, 'src', DATE, c);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= PER_CAT; i++) {
      fs.writeFileSync(path.join(dir, `${String(i).padStart(3, '0')}.png`), PNG_1PX);
    }
  }
  fs.mkdirSync(SANDBOX, { recursive: true });
}

/* --------------------------------------------------------------- 起审稿台 */

async function startReview() {
  const port = 8800 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, [SCRIPT, DATE, `--port=${port}`], {
    cwd: ROOT,
    env: {
      ...process.env,
      IMAGE_ROOT: IMG_ROOT,
      REVIEW_PORT_FILE: PORT_FILE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (b) => { log += b.toString(); });
  child.stderr.on('data', (b) => { log += b.toString(); });

  /* 端口可能因为被占用而顺延 —— 以它自己写出来的端口文件为准 */
  let actual = null;
  for (let i = 0; i < 120; i++) {
    if (fs.existsSync(PORT_FILE)) {
      const t = fs.readFileSync(PORT_FILE, 'utf8').trim();
      if (t) { actual = Number(t); break; }
    }
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  if (!actual) {
    child.kill();
    throw new Error('审稿台没起来。输出：\n' + log);
  }
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${actual}/`);
      if (r.ok) return { child, base: `http://127.0.0.1:${actual}`, log: () => log };
    } catch { /* 还没监听上 */ }
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  child.kill();
  throw new Error('审稿台起没来。输出：\n' + log);
}

/* --------------------------------------------------------------- 页面状态 */

/* 关掉查看器 —— 查看器开着的时候它盖住了工具栏，点不到按钮。
   （这是审稿台本来的行为，不是 bug：查看器是全屏遮罩，要关掉才能点工具栏） */
async function closeViewer(page) {
  const open = await page.evaluate(() => document.getElementById('lb').classList.contains('on'));
  if (open) await page.keyboard.press('Escape');
}

/* 等网格渲染出 n 张。
   不用 waitForFunction：等不到它会抛超时异常，把整个测试带崩 ——
   后面所有断言都跑不到，报错还看不出是哪一条不对。
   改成有上限的轮询，等不到就返回实际数量，让断言自己去判。 */
async function waitCells(page, n) {
  for (let i = 0; i < 80; i++) {
    const c = await page.evaluate(() => document.querySelectorAll('.cell').length);
    if (c === n) return c;
    await sleep(100);
  }
  return await page.evaluate(() => document.querySelectorAll('.cell').length);
}

async function state(page) {
  return await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.cell')];
    const on = cells.filter((c) => c.classList.contains('marked'));
    const lb = document.getElementById('lb');
    return {
      total: cells.length,
      counter: document.getElementById('marked').textContent.trim(),
      marked: on.length,
      nos: on.map((c) => c.querySelector('.no').textContent.trim()),
      ids: on.map((c) => c.dataset.id),
      viewerOpen: lb.classList.contains('on'),
      lbMark: !document.getElementById('lbmark').hidden,
      lbCount: document.getElementById('lbcount').textContent.trim(),
      active: document.activeElement ? document.activeElement.className : '',
    };
  });
}

/* --------------------------------------------------------------- 跑 */

let server = null;
let browser = null;

try {
  buildSandbox();
  server = await startReview();

  browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  /* 放行凭证不能真生成 —— 拦住它，只记录「按钮确实被触发了」 */
  let passCalls = 0;
  await page.route('**/api/pass', (route) => {
    passCalls++;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, count: 0, counts: {} }),
    });
  });

  await page.goto(server.base + '/');
  await waitCells(page, expectedCells);

  section('网格');
  let s = await state(page);
  check('三个栏目各 3 张都渲染出来了', s.total === expectedCells, s.total);
  check('一开始没有任何标记', s.marked === 0 && s.counter === '0', s);

  section('查看器里按回车 = 选中当前这张');
  await page.click('.cell:first-child img');
  await page.waitForFunction(() => document.getElementById('lb').classList.contains('on'));
  s = await state(page);
  check('点图打开查看器', s.viewerOpen && s.lbCount === '1 / 3', s.lbCount);

  await page.keyboard.press('Enter');
  s = await state(page);
  check('回车把当前这张标上了', s.marked === 1 && s.counter === '1', s);
  check('标的是当前这张（#1）', s.nos[0] === '#1', s.nos);
  check('查看器里也显示了「已标记 · 准备删除」', s.lbMark === true, s);

  await page.keyboard.press('Enter');
  s = await state(page);
  check('再按一次回车取消标记', s.marked === 0 && s.counter === '0', s);

  section('翻页后回车，标的是新那张');
  await page.keyboard.press('ArrowRight');
  s = await state(page);
  check('→ 翻到了第 2 张', s.lbCount === '2 / 3', s.lbCount);
  await page.keyboard.press('Enter');
  s = await state(page);
  check('回车标的是第 2 张，不是第 1 张', s.marked === 1 && s.nos[0] === '#2', s.nos);

  section('Escape 关查看器');
  await page.keyboard.press('Escape');
  s = await state(page);
  check('查看器关了', s.viewerOpen === false, s);
  check('关掉后标记还在（没被顺手清掉）', s.marked === 1, s);

  section('网格里按回车 = 选中刚点过的那张');
  /* 先清干净，免得跟上面的标记混在一起数不清 */
  await closeViewer(page);
  await page.click('#clearAll');
  await page.click('.cell:first-child img');
  await page.waitForFunction(() => document.getElementById('lb').classList.contains('on'));
  await page.keyboard.press('Escape');
  s = await state(page);
  check('点过之后焦点落在格子上', /cell/.test(s.active), s.active);
  await page.keyboard.press('Enter');
  s = await state(page);
  check('回车把刚点过的那张标上了', s.marked === 1 && s.nos[0] === '#1', s.nos);

  section('Delete 键直接删除当前这张（2026-11-09 改）');
  await closeViewer(page);
  await page.click('#clearAll');
  /* 先记住要删的是哪一张 —— 断言「文件真的没了」要用它 */
  const first = await page.evaluate(() => {
    const c = document.querySelector('.cell');
    return { id: c.dataset.id, no: c.querySelector('.no').textContent.trim() };
  });
  const [fCat, fName] = [first.id.split('/')[0], first.id.split('/').slice(1).join('/')];
  const DIR_OF = { jianwen: '见闻', jianshe: '见她', jianxiao: '见笑' };
  const fPath = path.join(IMG_ROOT, 'src', DATE, DIR_OF[fCat] || fCat, fName);
  check('删除前那张图在磁盘上', fs.existsSync(fPath), fPath);

  await page.click('.cell:first-child img');
  await page.waitForFunction(() => document.getElementById('lb').classList.contains('on'));
  await page.keyboard.press('Delete');
  /* 等网格少一张 —— 用轮询而不是 waitForFunction：
     等不到时 waitForFunction 会抛超时异常把整个测试带崩，
     后面所有断言都跑不到，报错还看不出是哪一条不对。 */
  const wantCells = expectedCells - 1;
  let cellsNow = -1;
  for (let i = 0; i < 60; i++) {
    cellsNow = await page.evaluate(() => document.querySelectorAll('.cell').length);
    if (cellsNow === wantCells) break;
    await sleep(150);
  }
  expectedCells = wantCells;   // 后面几节的断言都得跟着这个数走
  await sleep(400);   // 等 paintViewer 把查看器计数更新完
  s = await state(page);
  check('Delete 之后网格少了一张', cellsNow === wantCells, cellsNow);
  check('Delete 不再是「标记」—— 一张都没标', s.marked === 0 && s.counter === '0', s);
  check('文件真的从磁盘上删掉了（真删，不是挪进隔离区）', !fs.existsSync(fPath), fPath);
  check('查看器停在下一张（1 / 2）', s.lbCount === '1 / 2', s.lbCount);

  section('焦点在按钮上时 Delete 不删图（别把刚点完按钮的手顺手删了图）');
  const cntBefore = (await state(page)).total;
  await page.evaluate(() => document.getElementById('pass').focus());
  await page.keyboard.press('Delete');
  await sleep(500);
  s = await state(page);
  check('图一张都没少', s.total === cntBefore, s.total);

  section('焦点在按钮上时，回车归按钮，不抢去标图');
  await closeViewer(page);
  await page.click('#clearAll');
  s = await state(page);
  check('清空后没有标记', s.marked === 0, s);
  await page.focus('#pass');
  await page.keyboard.press('Enter');
  await sleep(300);
  s = await state(page);
  check('「通过审核」按钮确实被回车触发了', passCalls >= 1, passCalls);
  check('但没有顺手标任何图', s.marked === 0 && s.counter === '0', s);

  section('标记会存下来（刷新不丢）');
  await closeViewer(page);
  await page.click('#clearAll');
  await page.click('.cell:first-child img');
  await page.waitForFunction(() => document.getElementById('lb').classList.contains('on'));
  await page.keyboard.press('Enter');
  await sleep(200);
  await page.reload();
  await waitCells(page, expectedCells);
  s = await state(page);
  check('刷新后标记还在', s.marked === 1, s);

  section('「清空标记」之后重新选中的，刷新后也得在');
  /* 这一条盯的是一个真 bug：「清空标记」把全部 id 写进了 off 墓碑表，
     之后重新选中的图在合并时被旧墓碑抹掉 —— 页面看着有标记，刷新就没了。 */
  await page.click('#clearAll');
  await page.click('.cell:first-child img');
  await page.waitForFunction(() => document.getElementById('lb').classList.contains('on'));
  await page.keyboard.press('Enter');
  await sleep(200);
  s = await state(page);
  check('页面上确实标上了', s.marked === 1, s);
  await page.reload();
  await waitCells(page, expectedCells);
  s = await state(page);
  check('刷新后没丢', s.marked === 1, s);

  section('两个标签页各标各的，谁都不吃掉对方');
  /* 墓碑表存在的理由就是这个：老标签页保存时不能把新标签页的标记覆盖掉。
     现在的规则是「最后一次操作赢」（每个 id 记时间戳）。 */
  const pageB = await ctx.newPage();
  await pageB.goto(server.base + '/');
  await waitCells(pageB, expectedCells);
  await closeViewer(page);
  await page.click('#clearAll');
  await pageB.click('#clearAll');
  await sleep(200);
  /* 要点的到底是哪几张，从 DOM 上取 —— 别写死 id。
     前面那节真删掉了一张，写死的 id 会整个错位（第一张变成 002）。
     用 querySelector 取第一个匹配，跟 Playwright 非严格点击选的是同一个元素。 */
  const cellId = async (sel) => await page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? el.closest('.cell').dataset.id : null;
  }, sel);
  const ids = [
    await cellId('.cell:nth-child(1) .mark'),
    await cellId('.cell:nth-child(2) .mark'),
    await cellId('.cell:nth-child(3) .mark'),
  ];
  await page.click('.cell:nth-child(1) .mark');       // A 标第 1 张
  await sleep(200);
  await pageB.click('.cell:nth-child(1) .mark');      // B 也标第 1 张
  await sleep(200);
  await pageB.click('.cell:nth-child(2) .mark');      // B 标第 2 张
  await sleep(200);
  await page.click('.cell:nth-child(3) .mark');       // A 再动一下，触发一次保存
  await sleep(300);
  const stored = JSON.parse(await page.evaluate(() => localStorage.getItem('review-marked-' + DATE)));
  /* 有效集合 = on / off 里时间戳新的那一边 */
  const on = (id) => {
    const o = stored.on[id], f = stored.off[id];
    if (o === undefined) return false;
    return f === undefined || o > f;
  };
  check('A 标的第 1 张还在', on(ids[0]) === true, { ids, stored });
  check('B 标的第 2 张还在（没被 A 的旧状态吃掉）', on(ids[1]) === true, { ids, stored });
  check('A 标的第 3 张也在', on(ids[2]) === true, { ids, stored });

  section('晚一步的「取消」赢过早先的「标上」');
  await sleep(200);
  await pageB.click('.cell:nth-child(1) .mark');      // B 取消第 1 张（更晚）
  await sleep(300);
  const stored2 = JSON.parse(await page.evaluate(() => localStorage.getItem('review-marked-' + DATE)));
  const on2 = (id) => {
    const o = stored2.on[id], f = stored2.off[id];
    if (o === undefined) return false;
    return f === undefined || o > f;
  };
  check('第 1 张现在是「没标」', on2(ids[0]) === false, { ids, stored2 });
  check('第 2 张不受影响', on2(ids[1]) === true, { ids, stored2 });
  await pageB.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.child.kill();
  rmrf(SANDBOX);
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
