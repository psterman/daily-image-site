/**
 * 见报（RSS 头条）前端的 Playwright 测试
 *
 * 测的是「两层筛选」这套交互：
 *   上层 chip = 大类（点它 = 汇总该大类下所有源的条目）
 *   下层 chip = **真实 RSS 源名**（点它 = 只看这个源）
 *
 * 为什么要有下层：
 *   manifest 里的 tag 是**配置里翻译过**的分类名 ——
 *   「科技」底下其实是驱动之家、「社区」是虎扑步行街、「数码」是爱范儿…
 *   两套名字对不上，用户看着「科技」根本不知道底下是哪个 RSS 源。
 *   源名从条目里统计出来，不依赖配置，所以永远是「真的那个源」。
 *
 * 跟别的测试一样起一个假页面：本机 workerd 起不来，
 * 所以用 Node 静态服务器 + playwright 的 route 拦截。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'site');

const DATE = '2026-11-03';

/* 故意造出「翻译过的大类名 vs 真实源名」的对立面：
     微博   ← 微博热搜    （1:1）
     科技   ← 驱动之家    （1:1，名字完全对不上）
     效率   ← 少数派 + 少数派发现  （1:N，真聚合）
   desc 是给关键词搜索用的 —— 搜索范围 = 标题 + 来源 + 摘要（不含标签）。 */
const NEWS = [
  { title: '微博一条', link: 'https://w.example.com/1', source: '微博热搜', tag: '微博', tags: ['微博'], time: '11-03 20:00' },
  { title: '科技一条', link: 'https://d.example.com/1', source: '驱动之家', tag: '科技', tags: ['科技'], time: '11-03 20:01', desc: '一篇讲显卡行情的资讯汇总' },
  { title: '效率一条', link: 'https://s.example.com/1', source: '少数派', tag: '效率', tags: ['效率'], time: '11-03 20:02', desc: '关于时间管理的深度好文' },
  { title: '效率两条', link: 'https://s2.example.com/1', source: '少数派发现', tag: '效率', tags: ['效率'], time: '11-03 20:03', desc: '另一个效率工具推荐' },
  /* 一条同时挂两个大类 —— 过滤要用「包含」而不是「等于」 */
  { title: '跨类一条', link: 'https://x.example.com/1', source: '跨类源', tag: '科技', tags: ['科技', '效率'], time: '11-03 20:04' },
];

/* ── 配图契约 ──
   manifest 里的新闻条目可能多一个 img 字段（站内绝对路径）。
   线上现在每一期都没有这个字段 —— 那种老数据必须**一个 <img> 都不渲染**，
   行为跟加这个功能之前完全一致。
   下面的 ?set=good / ?set=bad 两份数据就是为了把这三种情况都测到：
     不带参数 = 老 manifest（没有 img 字段）
     set=good = 有一条合法的 img
     set=bad  = img 值不合法（空串/空白/相对路径/外站/非字符串） */
const IMG_PATH = '/img/rss/2026-11-11/3f2a1b9c4d_t.webp';

/* 假图的字节（1x1 透明 gif） */
const GIF_BUF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
/* 慢图：故意拖 4 秒才回 —— 让请求一直处在「在途」状态。
   只有在途的请求才会被「切 tab 中止旧请求」那条逻辑碰到。 */
const SLOW_IMG = '/img/rss/slow.webp';
/* 快图：照片 tab 用它，验证切过去以后照片照常加载 */
const FAST_IMG = '/img/rss/fast.webp';

/* 带图的那份：只有「微博一条」有 img。
   微博是默认分类 —— 一进页面这条就在视口里，
   懒加载（IntersectionObserver）会立刻把它点亮。 */
function newsWithImg() {
  return NEWS.map((n) => (n.title === '微博一条' ? { ...n, img: IMG_PATH } : n));
}

/* 不合法的 img 值：一律当「无图」处理。
   覆盖空串、只有空白、相对路径、外站绝对地址、协议相对地址、非字符串。 */
const BAD_IMGS = ['', '   ', 'img/rss/x.webp', 'https://example.com/x.webp', '//example.com/x.webp', 123, null];
function newsWithBadImg() {
  return NEWS.map((n, i) => (i < BAD_IMGS.length ? { ...n, img: BAD_IMGS[i] } : n));
}

function manifest(items) {
  return {
    date: DATE,
    generatedAt: '2026-11-03T00:00:00.000Z',
    title: '测试',
    siteUrl: 'http://127.0.0.1:0',
    imageBase: '/img',
    defaultTab: 'news',
    tabs: [
      {
        key: 'news', label: '见报', accent: '#3ddc97', count: items.length, type: 'headlines',
        tags: ['微博', '科技', '效率'],
        items,
      },
    ],
  };
}

/* 见报 + 照片两个 tab 的一份 manifest。
   用来验证「见报的配图不影响照片 tab 的加载」：
   见报那张图走慢图（一直在途），照片那两张走快图。 */
function manifestBoth() {
  return {
    date: DATE,
    generatedAt: '2026-11-03T00:00:00.000Z',
    title: '测试',
    siteUrl: 'http://127.0.0.1:0',
    imageBase: '/img',
    defaultTab: 'news',
    tabs: [
      {
        key: 'news', label: '见报', accent: '#3ddc97', count: 1, type: 'headlines',
        tags: ['微博'],
        items: [{
          title: '带图的新闻', link: 'https://w.example.com/1', source: '微博热搜',
          tag: '微博', tags: ['微博'], time: '11-03 20:00', img: SLOW_IMG,
        }],
      },
      {
        key: 'jx', label: '见闻', accent: '#ff6b6b', count: 2,
        items: [
          { id: 'jx_001', w: 1200, h: 1600, tw: 300, th: 400, thumb: FAST_IMG, full: FAST_IMG },
          { id: 'jx_002', w: 1200, h: 1600, tw: 300, th: 400, thumb: FAST_IMG, full: FAST_IMG },
        ],
      },
    ],
  };
}

function renderTemplate(mf) {
  let html = fs.readFileSync(path.join(SITE, 'template.html'), 'utf8');
  const m = JSON.stringify(mf).replace(/</g, '\\u003c');
  html = html
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
  return html;
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
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    // ?set=good 带图 / ?set=bad 不合法的图 / ?set=both 见报+照片两个 tab
    // 不带参数 = 老 manifest（没有 img 字段）
    const set = (req.url.match(/[?&]set=([^&]*)/) || [])[1] || '';
    let mf;
    if (set === 'good') mf = manifest(newsWithImg());
    else if (set === 'bad') mf = manifest(newsWithBadImg());
    else if (set === 'both') mf = manifestBoth();
    else mf = manifest(NEWS);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderTemplate(mf));
    return;
  }
  // 假的配图：1x1 透明 gif。够用 —— 测试只关心 src 有没有被正确赋上。
  if (url === IMG_PATH || url === FAST_IMG) {
    res.writeHead(200, { 'Content-Type': 'image/gif' });
    res.end(GIF_BUF);
    return;
  }
  // 慢图：故意拖住不回，让请求一直处在在途状态 ——
  // 只有在途的请求才会被「切 tab 中止」那条逻辑碰到。
  if (url === SLOW_IMG) {
    const t = setTimeout(() => {
      try { res.end(GIF_BUF); } catch (e) { /* 浏览器已经掐断了这条连接 */ }
    }, 4000);
    res.on('close', () => clearTimeout(t));
    return;
  }
  const file = path.join(SITE, path.basename(url));
  if (fs.existsSync(file)) {
    const mime = MIME[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(fs.readFileSync(file));
    return;
  }
  res.writeHead(404).end('404');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;

const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

// 假的点赞接口（见报页也会加载它）
await page.route('**/likes/api*', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, date: DATE, counts: {}, comments: {} }) }));

/* ── 小工具 ── */
const chipsOf = (sel) => page.locator(sel + ' .chip').allTextContents();
const shownTitles = () => page.locator('.news-item:not(.is-hidden) .news-title').allTextContents();
const chipByText = async (sel, text) => {
  const all = page.locator(sel + ' .chip');
  const n = await all.count();
  for (let i = 0; i < n; i++) {
    if ((await all.nth(i).textContent()).trim() === text) return all.nth(i);
  }
  return null;
};

/* 再开一个页面喂另一份 manifest。
   配图的三种情况（没有 img / 有 img / img 不合法）得分开测 ——
   同一份数据没法既是「有图」又是「没图」。
   报错的页面也共用 errors 数组：最后那句「没有未捕获的 JS 异常」要一起把关。 */
async function openPage(query, viewport) {
  const p = await ctx.newPage();
  if (viewport) await p.setViewportSize(viewport);
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.route('**/likes/api*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, date: DATE, counts: {}, comments: {} }) }));
  await p.goto(base + query, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(800);
  return p;
}

await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(700);

console.log('\n── 两层筛选区都在 ──');
{
  check('上层（大类）chip 有一排', (await page.locator('.chips-tags .chip').count()) === 3);
  check('下层（源名）chip 有一排', (await page.locator('.chips-srcs .chip').count()) > 0);
  check('下层带「来源」标注', (await page.locator('.chips-srcs .chips-cap').textContent()).trim() === '来源');
  const tagChips = await chipsOf('.chips-tags');
  /* 2026-11-06 起没有「全部」了 —— 只留分类本身 */
  check('上层只有分类名，没有「全部」', tagChips.join(',') === '微博,科技,效率', tagChips);
  check('**没有**「全部」这个 chip', tagChips.indexOf('全部') < 0, tagChips);
  const active = await page.locator('.chips-tags .chip.is-active').allTextContents();
  check('默认选中第一个分类', active.length === 1 && active[0] === '微博', active);
  check('默认只显示第一个分类的条目（1 条）', (await shownTitles()).length === 1, await shownTitles());
}

console.log('\n── 下层显示的是真实 RSS 源名 ──');
{
  /* 下层是「当前大类下的源」—— 没有「全部」大类了，源行永远跟着当前分类走 */
  const srcChips = await chipsOf('.chips-srcs');
  check('默认（微博）下的源 = 全部·微博 + 微博热搜', srcChips.length === 2, srcChips);
  check('第一个是「全部·微博」', srcChips[0] === '全部·微博', srcChips[0]);
  check('有「微博热搜」', srcChips.some((t) => t.indexOf('微博热搜') === 0), srcChips);
  check('源名 chip 带条数', srcChips.some((t) => /\s\d+$/.test(t)), srcChips);

  /* 切到「效率」—— 它底下聚合了 3 个源（少数派 / 少数派发现 / 跨类源） */
  const tag = await chipByText('.chips-tags', '效率');
  await tag.click();
  await page.waitForTimeout(300);
  const s2 = await chipsOf('.chips-srcs');
  check('切到「效率」后源行有 4 个（含「全部·效率」）', s2.length === 4, s2);
  check('第一个是「全部·效率」', s2[0] === '全部·效率', s2[0]);
  const hasReal = (n) => s2.some((t) => t.indexOf(n) === 0);
  check('有「少数派」', hasReal('少数派'), s2);
  check('有「少数派发现」', hasReal('少数派发现'), s2);
  check('**没有**翻译过的大类名「效率」', !hasReal('效率'), s2);
}

console.log('\n── 点大类 = 汇总该大类所有源 ──');
{
  const tag = await chipByText('.chips-tags', '科技');
  check('能点到「科技」chip', !!tag);
  await tag.click();
  await page.waitForTimeout(300);

  const srcChips = await chipsOf('.chips-srcs');
  check('下层收窄成该大类下的源', srcChips.length === 3, srcChips);
  check('下层含「驱动之家」', srcChips.some((t) => t.indexOf('驱动之家') === 0), srcChips);
  check('下层含「跨类源」（它也挂在科技下）', srcChips.some((t) => t.indexOf('跨类源') === 0), srcChips);
  check('下层不含「微博热搜」', !srcChips.some((t) => t.indexOf('微博热搜') === 0), srcChips);
  check('「全部」按钮文案说清范围', srcChips[0] === '全部·科技', srcChips[0]);

  const titles = await shownTitles();
  check('显示该大类下的全部条目（2 条）', titles.length === 2, titles);
  check('包含跨类的那条（过滤用包含不是等于）', titles.indexOf('跨类一条') >= 0, titles);
}

console.log('\n── 点源名 = 只看这个源 ──');
{
  /* 切到「效率」大类 —— 它的下层才有「少数派」这个源
     （上一步选的是「科技」，底下只有驱动之家和跨类源） */
  const tag = await chipByText('.chips-tags', '效率');
  await tag.click();
  await page.waitForTimeout(300);
  const srcChips = await chipsOf('.chips-srcs');
  check('「效率」下的源有 3 个（含跨类源）', srcChips.length === 4, srcChips);
  check('含「少数派」', srcChips.some((t) => t.indexOf('少数派 1') === 0), srcChips);
  check('含「少数派发现」', srcChips.some((t) => t.indexOf('少数派发现 1') === 0), srcChips);

  const src = await chipByText('.chips-srcs', '少数派 1');
  check('能点到「少数派」这个源 chip', !!src);
  await src.click();
  await page.waitForTimeout(300);
  const titles = await shownTitles();
  check('只剩这个源的条目（1 条）', titles.length === 1, titles);
  check('是「效率一条」', titles[0] === '效率一条', titles);
  check('不含同大类的其它源', titles.indexOf('效率两条') < 0, titles);
}

console.log('\n── 换分类 = 换掉源的选择 ──');
{
  /* 换大类时第二层的源选择要重置（不然会停在「上一个分类的源」上，
     结果是空列表 —— 看着像页面坏了） */
  const tag = await chipByText('.chips-tags', '微博');
  await tag.click();
  await page.waitForTimeout(300);
  const srcChips = await chipsOf('.chips-srcs');
  check('源选择被重置成「全部·微博」', srcChips[0] === '全部·微博' && srcChips.length === 2, srcChips);
  const titles = await shownTitles();
  check('显示微博下的条目（1 条）', titles.length === 1 && titles[0] === '微博一条', titles);
}

console.log('\n── 条目上的源名 / 大类 / 时间 ──');
{
  const meta = await page.evaluate(() => {
    const li = document.querySelector('.news-item');
    if (!li) return null;
    const src = li.querySelector('.news-src');
    const tag = li.querySelector('.news-tag');
    const tm = li.querySelector('.news-time');
    const cs = (el) => (el ? getComputedStyle(el) : null);
    return {
      srcText: src ? src.textContent : null,
      tagText: tag ? tag.textContent : null,
      timeText: tm ? tm.textContent : null,
      srcBg: src ? cs(src).backgroundColor : null,
      tagBg: tag ? cs(tag).backgroundColor : null,
      tagBorder: tag ? cs(tag).borderTopWidth : null,
    };
  });
  check('源名徽章有文字', !!meta && !!meta.srcText, meta);
  check('大类徽章有文字', !!meta && !!meta.tagText, meta);
  check('时间单独一行元素', !!meta && !!meta.timeText, meta);
  /* 源名是实心胶囊（accent 底）、大类是描边 —— 视觉上源名为主 */
  check('源名徽章是实心底色', !!meta && meta.srcBg && meta.srcBg !== 'rgba(0, 0, 0, 0)', meta && meta.srcBg);
  check('大类徽章是描边（无底色）', !!meta && meta.tagBg === 'rgba(0, 0, 0, 0)', meta && meta.tagBg);
  check('大类徽章有边框', !!meta && meta.tagBorder && meta.tagBorder !== '0px', meta && meta.tagBorder);
}

console.log('\n── 关键词搜索 ──');
{
  const searchInput = page.locator('.news-search-input');
  const clearBtn = page.locator('.news-search-clear');
  const countEl = page.locator('.news-search-count');

  check('有搜索框', (await searchInput.count()) === 1);
  /* type="text" + inputmode="search"，不是 type="search" ——
     type="search" 会自带一个原生清空按钮，跟我们自己的 ✕ 并排出现（页面上两个清空按钮）。
     inputmode="search" 让手机键盘照样出「搜索」键。 */
  check('搜索框是 type=text（不要原生清空按钮）', (await searchInput.getAttribute('type')) === 'text', await searchInput.getAttribute('type'));
  check('搜索框 inputmode=search（手机键盘出搜索键）', (await searchInput.getAttribute('inputmode')) === 'search', await searchInput.getAttribute('inputmode'));
  check('页面只有一个清空控件', (await page.locator('.news-search-clear').count()) === 1);
  check('搜索框有 aria-label', !!(await searchInput.getAttribute('aria-label')));
  check('清空按钮一开始是隐藏的', await clearBtn.isHidden());
  check('没有搜索词时不显示计数', (await countEl.textContent()).trim() === '');

  /* 计数单独占一行（不跟输入框挤）—— 窄屏上那句提示很长。
     结构上：计数不在 .news-search-row 里；几何上：有内容时确实在下一行。 */
  const countStruct = await page.evaluate(() => {
    const c = document.querySelector('.news-search-count');
    return c ? { inRow: !!c.closest('.news-search-row'), parent: c.parentElement.className } : null;
  });
  check('计数不在输入框那一行里（结构）', !!countStruct && !countStruct.inRow, countStruct);

  /* 切到「效率」—— 底下有 3 条，够搜出不同维度 */
  await (await chipByText('.chips-tags', '效率')).click();
  await page.waitForTimeout(250);
  check('切到「效率」后有 3 条', (await shownTitles()).length === 3, await shownTitles());

  /* 按标题搜 */
  await searchInput.fill('跨类');
  await page.waitForTimeout(200);
  check('按标题搜命中 1 条', (await shownTitles()).join(',') === '跨类一条', await shownTitles());
  check('计数是「找到 1 条」', (await countEl.textContent()).trim() === '找到 1 条', await countEl.textContent());
  check('有词时计数可见', await countEl.isVisible());
  check('有词时清空按钮可见', await clearBtn.isVisible());

  const countGeom = await page.evaluate(() => {
    const c = document.querySelector('.news-search-count');
    const i = document.querySelector('.news-search-input');
    if (!c || !i) return null;
    return c.getBoundingClientRect().top >= i.getBoundingClientRect().bottom - 1;
  });
  check('有词时计数在输入框下一行（几何）', countGeom === true, countGeom);

  /* 按来源搜（来源名是真实 RSS 源名，比如「少数派发现」） */
  await searchInput.fill('少数派发现');
  await page.waitForTimeout(200);
  check('按来源搜命中「效率两条」', (await shownTitles()).join(',') === '效率两条', await shownTitles());

  /* 按摘要搜（desc 里有「时间管理」） */
  await searchInput.fill('时间管理');
  await page.waitForTimeout(200);
  check('按摘要搜命中「效率一条」', (await shownTitles()).join(',') === '效率一条', await shownTitles());

  /* 搜不到：全局也没有 */
  await searchInput.fill('这个词全站都没有');
  await page.waitForTimeout(200);
  check('搜不到时 0 条', (await shownTitles()).length === 0, await shownTitles());
  check('全局也没有时说「找到 0 条」', (await countEl.textContent()).trim() === '找到 0 条', await countEl.textContent());

  /* 「当前筛选 0 条 · 全局 N 条」——
     在微博分类下搜「效率」：微博分类下没有，但全局有 2 条（标题里带「效率」）。 */
  await (await chipByText('.chips-tags', '微博')).click();
  await page.waitForTimeout(200);
  await searchInput.fill('效率');
  await page.waitForTimeout(200);
  check('当前分类下 0 条', (await shownTitles()).length === 0, await shownTitles());
  check('提示「当前筛选 0 条 · 全局 2 条」',
    (await countEl.textContent()).trim() === '当前筛选 0 条 · 全局 2 条', await countEl.textContent());

  /* 换分类不清搜索词 —— 搜索是第三个 AND 维度，是持久状态 */
  await (await chipByText('.chips-tags', '效率')).click();
  await page.waitForTimeout(200);
  check('换分类后搜索词还在', (await searchInput.inputValue()) === '效率', await searchInput.inputValue());
  check('换分类后立刻有结果', (await shownTitles()).length === 2, await shownTitles());
  check('计数变「找到 2 条」', (await countEl.textContent()).trim() === '找到 2 条', await countEl.textContent());
}

console.log('\n── 搜索不搜标签 ──');
{
  /* 「跨类一条」挂在 科技+效率 两个大类下，但标题/来源/摘要里都没有「科技」。
     如果搜索把标签也算进去，搜「科技」它会冒出来 —— 它不该冒出来。 */
  const searchText = await page.evaluate(() => {
    const lis = document.querySelectorAll('.news-item');
    for (const li of lis) {
      if ((li.querySelector('.news-title') || {}).textContent === '跨类一条') {
        return { ds: li.getAttribute('data-search'), tags: li.getAttribute('data-tags') };
      }
    }
    return null;
  });
  check('data-search 里没有标签文字', !!searchText && searchText.ds.indexOf('科技') < 0, searchText);
  check('data-search 里含标题和来源', !!searchText && searchText.ds.indexOf('跨类一条') >= 0 && searchText.ds.indexOf('跨类源') >= 0, searchText);

  const searchInput = page.locator('.news-search-input');
  await (await chipByText('.chips-tags', '科技')).click();
  await page.waitForTimeout(200);
  await searchInput.fill('科技');
  await page.waitForTimeout(200);
  const titles = await shownTitles();
  check('搜「科技」只命中标题里带科技的', titles.join(',') === '科技一条', titles);
  check('标签挂着「科技」的「跨类一条」不因为标签而命中', titles.indexOf('跨类一条') < 0, titles);
}

console.log('\n── 搜索 × 来源 也是 AND ──');
{
  const searchInput = page.locator('.news-search-input');
  const countEl = page.locator('.news-search-count');
  await (await chipByText('.chips-tags', '效率')).click();
  await page.waitForTimeout(200);
  const src = await chipByText('.chips-srcs', '少数派 1');
  await src.click();
  await page.waitForTimeout(200);
  check('已选源「少数派」', (await page.locator('.chips-srcs .chip.is-active').textContent()).trim() === '少数派 1');

  await searchInput.fill('时间管理');
  await page.waitForTimeout(200);
  check('源 ∩ 关键词 命中', (await shownTitles()).join(',') === '效率一条', await shownTitles());

  await searchInput.fill('跨类');
  await page.waitForTimeout(200);
  check('源 ∩ 关键词 = 0 条', (await shownTitles()).length === 0, await shownTitles());
  check('全局有命中时给提示', (await countEl.textContent()).trim() === '当前筛选 0 条 · 全局 1 条', await countEl.textContent());
}

console.log('\n── 清空搜索 ──');
{
  const searchInput = page.locator('.news-search-input');
  const clearBtn = page.locator('.news-search-clear');
  const countEl = page.locator('.news-search-count');

  await searchInput.fill('跨类');
  await page.waitForTimeout(200);
  check('先确认有词状态', (await shownTitles()).length === 0, await shownTitles());

  await clearBtn.click();
  await page.waitForTimeout(200);
  check('点 ✕ 后输入框空了', (await searchInput.inputValue()) === '', await searchInput.inputValue());
  check('点 ✕ 后计数空了', (await countEl.textContent()).trim() === '', await countEl.textContent());
  check('点 ✕ 后清空按钮又藏起来了', await clearBtn.isHidden());
  check('点 ✕ 后条目恢复（源仍收窄着 → 1 条）', (await shownTitles()).join(',') === '效率一条', await shownTitles());
  check('点 ✕ 后源的选择还在（少数派）',
    (await page.locator('.chips-srcs .chip.is-active').textContent()).trim() === '少数派 1');

  /* Esc 清空 —— 两条路径分开测：
   *   1) 合成 keydown（不可信事件）：浏览器默认动作不会跑，测的确实是我们自己的 JS。
   *      （2026-11-09 变异测试 M5 就是在这儿漏的：当时用 type="search"，
   *       Chrome 原生就会清空输入框并触发 input，真实按键的断言被浏览器顶掉了 ——
   *       改坏了实现，测试照样全绿。现在换成 type="text"，浏览器不再插手，
   *       但合成事件这条断言仍然留着当护栏。）
   *   2) 真实按键：端到端的用户可见保证（微信 X5 / 老安卓 WebView 走的就是这条）。 */
  await searchInput.fill('少数派');
  await page.waitForTimeout(200);
  check('填词后有结果', (await shownTitles()).length === 1, await shownTitles());

  await searchInput.dispatchEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true });
  await page.waitForTimeout(200);
  check('合成 Esc 后输入框空了', (await searchInput.inputValue()) === '', await searchInput.inputValue());
  check('合成 Esc 后计数空了', (await countEl.textContent()).trim() === '', await countEl.textContent());
  check('合成 Esc 后清空按钮藏起来了', await clearBtn.isHidden());

  await searchInput.fill('少数派');
  await page.waitForTimeout(200);
  await searchInput.press('Escape');
  await page.waitForTimeout(200);
  check('真按 Esc 后输入框空了', (await searchInput.inputValue()) === '', await searchInput.inputValue());
  check('真按 Esc 后计数空了', (await countEl.textContent()).trim() === '', await countEl.textContent());
  check('真按 Esc 后条目恢复', (await shownTitles()).join(',') === '效率一条', await shownTitles());
}

console.log('\n── 见报配图（manifest 带 img） ──');
{
  const p2 = await openPage('/?set=good');

  check('带 img 的条目渲染出了 <img>', (await p2.locator('.news-item img').count()) === 1,
    await p2.locator('.news-item img').count());
  check('别的条目还是纯文字（没有多出 <img>）',
    (await p2.locator('.news-item').count()) === 5 && (await p2.locator('.news-item img').count()) === 1);

  // 这张图必须挂在带 img 的那一条上，不能张冠李戴
  const owner = await p2.evaluate(() => {
    const i = document.querySelector('.news-item img');
    const li = i ? i.closest('.news-item') : null;
    return li ? li.querySelector('.news-title').textContent : null;
  });
  check('图挂在带 img 的那条上', owner === '微博一条', owner);

  /* 懒加载是 IntersectionObserver 自己实现的：
     进视口之前真实地址只在 data-src 上，进了视口才赋给 src。
     这里等它赋值 —— 等不到就说明懒加载没生效。 */
  await p2.waitForFunction(
    (p) => {
      const i = document.querySelector('.news-item img');
      return !!i && (i.getAttribute('src') || '').indexOf(p) >= 0;
    },
    IMG_PATH,
    { timeout: 8000 },
  ).catch(() => {});

  const info = await p2.evaluate(() => {
    const i = document.querySelector('.news-item img');
    if (!i) return null;
    const wrap = i.closest('.news-thumb');
    const r = i.getBoundingClientRect();
    return {
      attrSrc: i.getAttribute('src'),
      propSrc: i.src,
      dataSrc: i.getAttribute('data-src'),
      alt: i.getAttribute('alt'),
      loading: i.getAttribute('loading'),
      srcset: i.getAttribute('srcset'),
      sizes: i.getAttribute('sizes'),
      w: r.width,
      h: r.height,
      opacity: getComputedStyle(i).opacity,
      wrapLoaded: wrap ? wrap.classList.contains('is-loaded') : null,
    };
  });

  check('src 最终被赋成了正确的地址', !!info && String(info.propSrc).endsWith(IMG_PATH), info && info.propSrc);
  check('src 属性就是那个地址', !!info && String(info.attrSrc).indexOf(IMG_PATH) >= 0, info && info.attrSrc);
  check('真实地址先存在 data-src 上', !!info && info.dataSrc === IMG_PATH, info && info.dataSrc);
  /* 装饰性图片：内容都在标题里。alt 必须留空，
     否则读屏软件会念出图片文件名（微信里外链文件名很长）。 */
  check('alt 为空（读屏不念图片文件名）', !!info && info.alt === '', info && info.alt);
  /* 微信 X5：loading="lazy" 完全无效（会一次性触发全部请求），
     srcset/sizes 也会被忽略 —— 用了就等于没用。 */
  check('没有用 loading="lazy"（X5 上无效）', !!info && info.loading === null, info && info.loading);
  check('没有用 srcset / sizes（X5 会忽略）', !!info && info.srcset === null && info.sizes === null, info);
  /* 尺寸写死：图片到位前位置就占好了，页面不会跳（CLS） */
  check('图片有明确尺寸（加载时不跳版）', !!info && info.w > 0 && info.h > 0, info);
  check('图片加载完才显影', !!info && info.wrapLoaded === true && Number(info.opacity) === 1, info);

  await p2.close();
}

console.log('\n── 见报配图（manifest 不带 img） ──');
{
  /* 这一条最容易被写成假断言 —— 注意别用「数量 <= 1」这种糊弄的写法。
     这里断言的是**一个都没有**：老 manifest 里一条图都不能渲染。 */
  check('见报条目里一个 <img> 都没有', (await page.locator('.news-item img').count()) === 0,
    await page.locator('.news-item img').count());
  check('整个见报列表里没有 <img>', (await page.locator('.news-list img').count()) === 0,
    await page.locator('.news-list img').count());
  check('条目上没有配图容器', (await page.locator('.news-item .news-thumb').count()) === 0);
  check('条目不是两栏版式（没有 has-thumb）', (await page.locator('.news-item .news-link.has-thumb').count()) === 0);
  /* 光「没有图」不够 —— 还得跟以前长得一样：文字都还在 */
  check('条目还是纯文字（标题都在）', (await page.locator('.news-item .news-title').count()) === 5,
    await page.locator('.news-item .news-title').count());
  check('摘要也还在', (await page.locator('.news-item .news-desc').count()) === 3,
    await page.locator('.news-item .news-desc').count());
  /* 老数据要跟加这个功能之前**结构一样**：
     标题直接挂在链接上，中间没有多一层文字栏（.news-body）。
     以后有人「顺手」把所有条目都包一层，这两条会变红。 */
  const shape = await page.evaluate(() => {
    const li = document.querySelector('.news-item');
    const link = li ? li.querySelector('.news-link') : null;
    const title = link ? link.querySelector('.news-title') : null;
    return {
      titleIsDirectChild: !!(title && title.parentElement === link),
      hasBody: !!(link && link.querySelector('.news-body')),
      hasThumb: !!(link && link.querySelector('.news-thumb')),
    };
  });
  check('没有配图时标题直接挂在链接上（DOM 结构没变）', shape.titleIsDirectChild === true, shape);
  check('没有配图时不套文字栏 .news-body', shape.hasBody === false, shape);
  check('没有配图时不挂配图容器', shape.hasThumb === false, shape);
}

console.log('\n── 见报配图（img 值不合法 = 当没有） ──');
{
  const p3 = await openPage('/?set=bad');
  check('不合法的 img 一个 <img> 都不渲染', (await p3.locator('.news-item img').count()) === 0,
    await p3.locator('.news-item img').count());
  check('不合法时也不挂配图容器', (await p3.locator('.news-item .news-thumb').count()) === 0);
  check('不合法时条目还是纯文字', (await p3.locator('.news-item .news-title').count()) === 5);
  await p3.close();
}

console.log('\n── 窄屏 375px 不横向溢出（带配图） ──');
{
  const p4 = await openPage('/?set=good', { width: 375, height: 812 });

  const overflow = await p4.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('375px 下页面没有横向滚动', overflow <= 0, overflow);

  const box = await p4.evaluate(() => {
    const li = document.querySelector('.news-item');
    const link = li ? li.querySelector('.news-link') : null;
    const thumb = li ? li.querySelector('.news-thumb') : null;
    const body = li ? li.querySelector('.news-body') : null;
    const r = (el) => (el ? el.getBoundingClientRect() : null);
    return {
      vw: document.documentElement.clientWidth,
      linkLeft: r(link) ? r(link).left : null,
      linkRight: r(link) ? r(link).right : null,
      linkW: r(link) ? r(link).width : null,
      thumbW: r(thumb) ? r(thumb).width : null,
      bodyW: r(body) ? r(body).width : null,
    };
  });
  check('375px 下卡片没超出视口', !!box && box.linkRight !== null && box.linkRight <= box.vw + 0.5, box);
  check('375px 下卡片宽度不超过视口', !!box && box.linkW !== null && box.linkW <= box.vw + 0.5, box);
  /* 配图是固定尺寸：既不能被挤成一条线，也不能宽到把文字挤没 */
  check('375px 下配图宽度在合理区间（60~120）', !!box && box.thumbW > 60 && box.thumbW <= 120, box);
  check('375px 下文字栏还有宽度（没被挤没）', !!box && box.bodyW > 100, box);
  check('375px 下两栏加起来没超出视口',
    !!box && box.bodyW !== null && box.thumbW !== null && box.bodyW + box.thumbW <= box.vw, box);

  await p4.close();
}

console.log('\n── 见报的图不影响照片 tab ──');
{
  /* 见报的配图跟照片走的是**同一个**加载队列（key 分别是 news / 照片 tab 的 key）。
   * 浏览器同域只开 6 条连接 —— 见报要是能一直占着连接不放，
   * 照片 tab 的缩略图就加载不出来（老坑：切 tab 后等 38~62 秒）。
   * 所以切 tab 时在途的请求必须被中止。 */
  const p5 = await openPage('/?set=both');

  // 等见报那张慢图真的开始请求（它 4 秒才回，这段时间里一直是在途状态）
  await p5.waitForFunction(
    () => {
      const i = document.querySelector('.news-item img');
      return !!i && (i.getAttribute('src') || '').indexOf('slow.webp') >= 0;
    },
    null,
    { timeout: 5000 },
  ).catch(() => {});

  // 切到照片 tab
  await p5.locator('.tab[data-key="jx"]').click();
  await p5.waitForTimeout(400);

  const st = await p5.evaluate(() => {
    const n = document.querySelector('.news-item img');
    const cells = Array.from(document.querySelectorAll('#grid-jx .cell img'));
    return {
      newsSrc: n ? n.getAttribute('src') : null,
      photoSrcs: cells.map((c) => c.getAttribute('src')),
      photoCount: cells.length,
    };
  });

  /* 中止的做法是把 src 指向 1x1 的中止 gif ——
     浏览器会立刻取消当前下载（app.js 里 ABORT_SRC 那套）。 */
  check('切走后见报的在途请求被中止（连接让给照片 tab）',
    !!st && !!st.newsSrc && st.newsSrc.indexOf('data:image/gif;base64') === 0, st && st.newsSrc);
  check('照片 tab 的图照常加载', !!st && st.photoCount === 2 &&
    st.photoSrcs.every((s) => !!s && s.indexOf('fast.webp') >= 0), st);

  await p5.close();
}

console.log('\n── 移动端不横向溢出 ──');
{
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('页面没有横向滚动', overflow <= 0, overflow);
}

console.log('\n── 报错检查 ──');
check('没有未捕获的 JS 异常', errors.length === 0, errors);

await browser.close();
server.close();

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
if (fail) process.exit(1);
