#!/usr/bin/env node
/**
 * 「见报」tab 专项验证（微信 UA + 移动端视口）
 *
 * 用法：node tools/verify-news.mjs [url]
 *   默认 https://example.com/
 *
 * 退出码：0 = 全过；1 = 有失败
 */
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.verify');
const URL_ = process.argv[2] || 'https://example.com/';

const WECHAT_UA =
  'Mozilla/5.0 (Linux; Android 10; V1938CT Build/QP1A.190711.020; wv) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Version/4.0 Chrome/78.0.3904.108 Mobile Safari/537.36 ' +
  'MicroMessenger/8.0.32.2180(0x28002037) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64';

let pass = 0;
let fail = 0;
function chk(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`);
  }
}

await fs.mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: WECHAT_UA,
});
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('requestfailed', (r) => {
  // Cloudflare RUM 分析上报在页面跳转时被取消是正常的
  if (r.url().includes('/cdn-cgi/rum')) return;
  errors.push(`reqfail ${r.url()} ${r.failure()?.errorText}`);
});

console.log(`\n见报 tab 验证：${URL_}\n`);

await page.goto(URL_, { waitUntil: 'load', timeout: 30000 });
await page.waitForTimeout(2000);

/* ── 1. tab 栏 ─────────────────────────────────────────── */
console.log('tab 栏');
const tabs = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.tab')).map((t) => ({
    key: t.getAttribute('data-key'),
    label: t.querySelector('.tab-label')?.textContent,
    badge: t.querySelector('.tab-badge')?.textContent,
    active: t.classList.contains('is-active'),
  })),
);
console.log('  ' + tabs.map((t) => `${t.label}(${t.badge})${t.active ? '*' : ''}`).join('  '));
/* tab 数不写死：榜单 tab（听乐 / 看片）只有当构建期抓到了榜单数据时才有，
   所以线上可能是 4 个（只有图片 + 见报）也可能是 6 个。
   写死成 4 的话，加了榜单的那一期反而会被判成「tab 数不对」。 */
chk('至少 4 个 tab（见闻/见她/见笑/见报）', tabs.length >= 4, String(tabs.length));
chk(
  '三个图片 tab 都在',
  ['见闻', '见她', '见笑'].every((l) => tabs.some((t) => t.label === l)),
  tabs.map((t) => t.label).join('、'),
);
/* 榜单 tab：有就必须在，且徽标数大于 0（空的榜单 tab 不该出现） */
for (const k of ['music', 'movie']) {
  const t = tabs.find((x) => x.key === k);
  if (t) chk(`榜单 tab「${t.label}」有徽标数`, Number(t.badge) > 0, t.badge);
}
chk('默认落点仍是「见笑」', tabs.some((t) => t.label === '见笑' && t.active));
const newsTab = tabs.find((t) => t.key === 'news');
chk('存在「见报」tab', !!newsTab, newsTab ? newsTab.label : '');
chk('见报有徽标数', newsTab && Number(newsTab.badge) > 0, newsTab ? newsTab.badge : '');

/* ── 2. 切到见报 ───────────────────────────────────────── */
console.log('\n见报内容');
await page.click('.tab[data-key="news"]');
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(OUT, '09-news-tab.png') });

const news = await page.evaluate(() => {
  const grid = document.querySelector('#grid-news');
  const items = Array.from(grid.querySelectorAll('.news-item'));
  // 两层筛选有两行 chip：目录行是 data-tag，来源行是 data-src。
  // **必须分开取** —— 2026-11-05 之前这里用 .chip 全收，
  // 把来源那行的 33 个 chip 也当成了目录 chip，
  // 后面点「全部源」时按 data-tag 找不到 → 超时 → 整个脚本崩在最后一步。
  // 也就是说这个脚本从 11-04 加两层筛选那天起就没真正跑完过（假护栏）。
  const chips = Array.from(grid.querySelectorAll('.chip[data-tag]'));
  const srcChips = Array.from(grid.querySelectorAll('.chip[data-src]'));
  const a = items[0]?.querySelector('.news-link');
  // 源名就是完整文本 —— 有些源名带空格（「V2EX 热榜」），
  // 按空格切第一段会算错来源数
  const sources = new Set(items.map((i) => i.querySelector('.news-src')?.textContent));
  return {
    gridVisible: getComputedStyle(grid).display !== 'none',
    columns: getComputedStyle(grid).columnCount,
    itemCount: items.length,
    chips: chips.map((c) => c.textContent),
    srcChips: srcChips.map((c) => ({ text: c.textContent, src: c.getAttribute('data-src') })),
    activeChip: chips.find((c) => c.classList.contains('is-active'))?.textContent,
    firstTitle: items[0]?.querySelector('.news-title')?.textContent,
    firstHref: a?.getAttribute('href'),
    firstTarget: a?.getAttribute('target'),
    firstRel: a?.getAttribute('rel'),
    hasTag: !!items[0]?.querySelector('.news-tag'),
    hasMeta: !!items[0]?.querySelector('.news-meta'),
    countPill: document.getElementById('countPill')?.textContent,
    sourceCount: sources.size,
    photosHidden: Array.from(document.querySelectorAll('.grid:not(.grid-headlines)')).every(
      (g) => getComputedStyle(g).display === 'none',
    ),
  };
});
console.log(`  ${news.itemCount} 条 / ${news.sourceCount} 个来源 / chips: ${news.chips.join(' ')}`);
console.log(`  来源行 ${news.srcChips.length} 个 chip：${news.srcChips.map((c) => c.text).join(' ')}`);
console.log(`  首条：${news.firstTitle}`);
chk('见报网格可见', news.gridVisible);
chk('单列（不是多列图片布局）', news.columns === '1', news.columns);
chk('有条目', news.itemCount > 0, String(news.itemCount));
chk('多个来源', news.sourceCount > 1, String(news.sourceCount));
chk('标签 chips 存在', news.chips.length >= 2, news.chips.join('/'));
/* 2026-11-06 起分类行没有「全部」了 —— 只留分类本身 */
chk('分类行没有「全部」', !news.chips.includes('全部'), news.chips.join('/'));
chk('默认选中第一个分类', news.activeChip === news.chips[0], news.activeChip);
chk('来源 chip 行存在', news.srcChips.length >= 2, String(news.srcChips.length));
/* 下层跟着当前分类走 —— 第一个是「全部·<分类>」 */
chk(
  '来源行第一个是「全部·当前分类」',
  String(news.srcChips[0]?.text || '').startsWith('全部·'),
  news.srcChips[0]?.text,
);
chk('来源 chip 带条数', /\d/.test(news.srcChips[1]?.text || ''), news.srcChips[1]?.text);
chk('标题是文字', typeof news.firstTitle === 'string' && news.firstTitle.length > 4);
chk('链接指向原文', /^https?:\/\//.test(news.firstHref || ''), news.firstHref);
chk('新窗口打开', news.firstTarget === '_blank');
chk('rel=noopener noreferrer', news.firstRel === 'noopener noreferrer', news.firstRel);
chk('有标签和来源', news.hasTag && news.hasMeta);
chk('计数显示「条」', /条$/.test(news.countPill || ''), news.countPill);
chk('照片 tab 都收起了', news.photosHidden);

/* ── 3. 标签切换 ───────────────────────────────────────── */
console.log('\n标签切换');
const tag = news.chips[1];
await page.click(`.chip[data-tag="${tag}"]`);
await page.waitForTimeout(500);
const filtered = await page.evaluate(() => {
  const items = Array.from(document.querySelectorAll('#grid-news .news-item'));
  const shown = items.filter((i) => !i.classList.contains('is-hidden'));
  const cur = document.querySelector('#grid-news .chip[data-tag].is-active')?.getAttribute('data-tag');
  return {
    total: items.length,
    shown: shown.length,
    // 归属判断必须看 data-tags（空格分隔的全部标签），
    // 不能看 data-tag（那只是显示用的徽章）——
    // 一条新闻同时属于「头条」「热榜」时，data-tag 只有其中一个。
    allMatch: shown.every((i) =>
      (i.getAttribute('data-tags') || '').split(/\s+/).indexOf(cur) >= 0,
    ),
    hiddenAllMatch: items
      .filter((i) => i.classList.contains('is-hidden'))
      .every((i) => (i.getAttribute('data-tags') || '').split(/\s+/).indexOf(cur) < 0),
    activeChip: document.querySelector('#grid-news .chip[data-tag].is-active')?.textContent,
  };
});
console.log(`  标签「${tag}」→ 显示 ${filtered.shown} / ${filtered.total}`);
chk('筛选后数量变少', filtered.shown > 0 && filtered.shown < filtered.total, `${filtered.shown}/${filtered.total}`);
chk('显示的都属于该标签', filtered.allMatch);
chk('隐藏的都不属于该标签', filtered.hiddenAllMatch);
chk('chip 选中态跟着切', filtered.activeChip === tag, filtered.activeChip);

/* ── 3b. 目录（chip）自检 ────────────────────────────────── */
console.log('\n目录切换');
// 目录名 = 内容领域（知乎/微博/V2EX/科技/社区/效率…），
// 不再有「头条」「热榜」这种伞标签 —— 它们和「全部」内容重复。
// 2026-11-06 起也没有「全部」了 —— 分类行只有分类本身。
for (const t of news.chips) {
  await page.click(`#grid-news .chip[data-tag="${t}"]`);
  await page.waitForTimeout(400);
  const r = await page.evaluate((tagName) => {
    const items = Array.from(document.querySelectorAll('#grid-news .news-item'));
    const shown = items.filter((i) => !i.classList.contains('is-hidden'));
    return {
      shown: shown.length,
      total: items.length,
      allMatch: shown.every((i) =>
        (i.getAttribute('data-tags') || '').split(/\s+/).indexOf(tagName) >= 0
      ),
    };
  }, t);
  console.log(`  「${t}」→ 显示 ${r.shown} / ${r.total}`);
  chk(`「${t}」显示的都属于该目录`, r.allMatch);
  chk(`「${t}」有内容`, r.shown > 0, String(r.shown));
}
chk('没有「头条」伞标签', !news.chips.includes('头条'), news.chips.join('/'));
chk('没有「热榜」伞标签', !news.chips.includes('热榜'), news.chips.join('/'));

/* 2026-11-06 起没有「全部」这个 chip 了 —— 「切回全部」这一步改成：
   1) 每个条目至少属于一个分类（没有漏网的）
   2) 切回第一个分类，显示数与「数据里属于该分类的条目数」一致 */
const coverage = await page.evaluate(() => {
  const items = Array.from(document.querySelectorAll('#grid-news .news-item'));
  const covered = items.filter((i) => (i.getAttribute('data-tags') || '').trim().length > 0);
  return { total: items.length, covered: covered.length };
});
chk('每个条目都至少属于一个分类（没有漏网的）', coverage.covered === coverage.total, coverage);

const firstTag = news.chips[0];
await page.click(`#grid-news .chip[data-tag="${firstTag}"]`);
await page.waitForTimeout(400);
const backToFirst = await page.evaluate((tagName) => {
  const items = Array.from(document.querySelectorAll('#grid-news .news-item'));
  const shown = items.filter((i) => !i.classList.contains('is-hidden'));
  const expected = items.filter((i) =>
    (i.getAttribute('data-tags') || '').split(/\s+/).indexOf(tagName) >= 0);
  return { shown: shown.length, expected: expected.length };
}, firstTag);
chk(
  `切回「${firstTag}」后显示数 = 数据里属于它的条目数`,
  backToFirst.shown === backToFirst.expected && backToFirst.shown > 0,
  backToFirst,
);

/* ── 3c. 来源筛选（第二层） ───────────────────────────────── */
console.log('\n来源筛选');
const srcToTest = news.srcChips.find((c) => c.src); // 第一个真实来源（跳过「全部源」）
if (srcToTest) {
  await page.click(`#grid-news .chip[data-src="${srcToTest.src}"]`);
  await page.waitForTimeout(400);
  const sr = await page.evaluate((name) => {
    const items = Array.from(document.querySelectorAll('#grid-news .news-item'));
    const shown = items.filter((i) => !i.classList.contains('is-hidden'));
    return {
      shown: shown.length,
      total: items.length,
      allMatch: shown.every(
        (i) => (i.querySelector('.news-src')?.textContent || '') === name,
      ),
    };
  }, srcToTest.src);
  console.log(`  来源「${srcToTest.src}」→ 显示 ${sr.shown} / ${sr.total}`);
  chk('只显示该来源的条目', sr.allMatch);
  chk('该来源有内容', sr.shown > 0, String(sr.shown));
  chk('比当前分类的条目少', sr.shown < sr.total, `${sr.shown}/${sr.total}`);
  await page.click('#grid-news .chip[data-src=""]');
  await page.waitForTimeout(300);
}

/* ── 4. 切回照片 tab ───────────────────────────────────── */
console.log('\n切回照片 tab');
await page.click('.tab[data-key="jianxiao"]');
await page.waitForTimeout(1200);
const back = await page.evaluate(() => ({
  photoActive: document.querySelector('#grid-jianxiao')?.classList.contains('is-active'),
  newsActive: document.querySelector('#grid-news')?.classList.contains('is-active'),
  countPill: document.getElementById('countPill')?.textContent,
  imgsOk: Array.from(document.querySelectorAll('#grid-jianxiao .cell img')).filter(
    (i) => i.complete && i.naturalWidth > 0,
  ).length,
}));
chk('切回照片 tab', back.photoActive === true);
chk('见报网格收起', back.newsActive === false);
chk('计数回到「张」', /张$/.test(back.countPill || ''), back.countPill);
chk('照片正常渲染', back.imgsOk > 0, String(back.imgsOk));

chk('无控制台/网络错误', errors.length === 0, errors.slice(0, 3).join(' | '));

/* ── 5. 榜单的多层 chip（2026-11-16 v2）──────────────────
   条目必须带层级标签（data-lv，JSON 编码），前端才会画多层 chip。
   没有标签时前端会走**旧兼容路径**（单层 chip）——
   线上看着「正常」，但层级筛选其实是坏的 → 必须在这里拦。

   两个 tab 都是「有才查」：构建期没抓到数据时它们压根不存在。
   v3 起「追更」不再是独立 tab，频道更新 / 本地演出已经并进「看片」，
   所以这里查的 movie 就是五段合并后的看片 tab。 */
console.log('\n榜单的多层 chip');
for (const k of ['music', 'movie']) {
  const t = tabs.find((x) => x.key === k);
  if (!t) continue;
  await page.click(`.tab[data-key="${k}"]`);
  await page.waitForTimeout(800);
  const lv = await page.evaluate((key) => {
    const grid = document.querySelector('#grid-' + key);
    const caps = Array.from(grid.querySelectorAll('.chip-line .chips-cap')).map((c) => c.textContent);
    const items = Array.from(grid.querySelectorAll('.rank-item'));
    const withLv = items.filter((i) => {
      const raw = i.getAttribute('data-lv');
      if (!raw) return false;
      try {
        const a = JSON.parse(raw);
        return Array.isArray(a) && a.length > 0 && /^@\d+:.+/.test(a[0]);
      } catch (e) {
        return false;
      }
    });
    return { caps, total: items.length, withLv: withLv.length };
  }, k);
  console.log(`  ${t.label}：${lv.caps.join('/')} 层，条目带层级标签 ${lv.withLv}/${lv.total}`);
  chk(`${t.label} 有多层 chip 行（板块/分类…）`, lv.caps.length >= 2, lv.caps.join('/'));
  chk(
    `${t.label} 的条目都带层级标签 data-lv（没有就是走了旧兼容路径，层级筛选是坏的）`,
    lv.total > 0 && lv.withLv === lv.total,
    `${lv.withLv}/${lv.total}`,
  );
}

await browser.close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
