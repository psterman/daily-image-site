/**
 * 点赞前端的 Playwright 测试
 *
 * 为什么要起一个假页面：
 *   本机的 workerd 跑不起来（VC++ 运行库问题），wrangler pages dev 用不了，
 *   所以这里用 Node 起一个静态服务器，把 site/template.html 渲染成测试页，
 *   再用 playwright 的 route 拦截把 /likes/api 换成假的响应。
 *   前端逻辑（访客 id、角标、点赞切换、localStorage）是真的在跑。
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
const ID = 'jianxiao_001';
const THUMB = '/img/' + DATE + '/jianxiao/ab12cd34ef_001_t.webp';

function manifest() {
  const item = (id) => ({
    id, w: 800, h: 800, tw: 400, th: 400,
    thumb: THUMB,
    full: '/img/' + DATE + '/jianxiao/ab12cd34ef_001.webp',
  });
  return {
    date: DATE,
    generatedAt: '2026-11-03T00:00:00.000Z',
    title: '测试',
    siteUrl: 'http://127.0.0.1:0',
    imageBase: '/img',
    defaultTab: 'jianxiao',
    tabs: [
      { key: 'jianwen', label: '见闻', accent: '#4a8cff', count: 1, type: 'images', items: [item('jianwen_001')] },
      { key: 'jianxiao', label: '见笑', accent: '#ffb02e', count: 1, type: 'images', items: [item(ID)] },
    ],
  };
}

function renderTemplate() {
  let html = fs.readFileSync(path.join(SITE, 'template.html'), 'utf8');
  const m = JSON.stringify(manifest()).replace(/</g, '\\u003c');
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
  if (req.url === '/' || req.url === '/index.html') {
    const html = renderTemplate();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  const file = path.join(SITE, path.basename(req.url.split('?')[0]));
  if (fs.existsSync(file)) {
    // 按扩展名给 MIME。别图省事全按 text/css 发 ——
    // app.js 能跑只是因为 Chrome 在没有 nosniff 时不强制校验经典脚本的 MIME，
    // 哪天加了 nosniff 或者换成会强制校验的内核，整个测试会红得莫名其妙。
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

// 假的点赞接口
let posted = [];
let getUrls = [];
let serverCounts = { [ID]: 3 };
/* 让 POST 失败用（测「点赞失败时计数不变、按钮恢复可用」） */
let failPosts = false;
/* 让 GET 返回「旧副本」用（counts 里没有当前这张图）——
   模拟浏览器缓存了 30 秒前的响应（GET 带 public, max-age=30） */
let staleCounts = false;
await page.route('**/likes/api*', async (route) => {
  const req = route.request();
  if (req.method() === 'POST') {
    const body = JSON.parse(req.postData() || '{}');
    posted.push({ ...body, vid: req.headers()['x-daily-visitor'] });
    if (failPosts) {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: '服务端炸了' }) });
      return;
    }
    serverCounts[body.id] = body.on ? (serverCounts[body.id] || 0) + 1 : Math.max(0, (serverCounts[body.id] || 0) - 1);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, id: body.id, count: serverCounts[body.id], on: body.on }) });
    return;
  }
  getUrls.push(req.url());
  const counts = staleCounts ? {} : serverCounts;
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, date: DATE, counts, comments: { [ID]: 2 } }) });
});
await page.route('**/img/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') }));

await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);

console.log('\n── 角标 ──');
{
  // 必须锁定「当前激活的那个 tab」的格子。
  // 所有 tab 的格子是一起建进 DOM 的，顺序跟 tab 顺序一致，
  // 而没激活的 .grid 是 display:none —— 所以 .cell.first() 点的是
  // 未激活 tab 里的隐藏格子，Playwright 会一直等到超时。
  const badge = page.locator('#grid-jianxiao .like-badge').first();
  check('角标元素存在', await badge.count() > 0);
  check('角标显示赞数', (await badge.textContent()) === '👍 3', await badge.textContent());
  check('角标不可点', (await badge.evaluate((el) => getComputedStyle(el).pointerEvents)) === 'none');
  // GET 必须带 date —— 单图键是「<日期>/<栏目_序号>」，日期丢了就是跨期串味。
  // route 的匹配模式盖不住这个（**/likes/api* 什么查询串都收），所以要单独断言。
  check('GET 带上了 date', getUrls.length > 0 && getUrls[0].indexOf('date=' + DATE) >= 0, getUrls);

  // 0 赞的图不画角标 —— 见报/其它栏目那些没被赞过的图，
  // 每个都挂一个空角标的话，一屏就是几百个空壳。
  const jwBadge = page.locator('#grid-jianwen .like-badge').first();
  check('0 赞的图不画角标', (await jwBadge.count()) > 0 && (await jwBadge.evaluate((el) => el.hidden === true)));
  check('0 赞的图角标是空的', (await jwBadge.textContent()) === '', await jwBadge.textContent());
}

console.log('\n── 查看器操作栏 ──');
// 同上：点当前激活 tab 里的第一格
await page.locator('#grid-jianxiao .cell').first().click();
await page.waitForTimeout(300);
{
  check('点赞按钮可见', await page.locator('#viewerLike').isVisible());
  check('赞数同步到查看器', (await page.locator('#viewerLikeCount').textContent()) === '3');
  check('评论数同步到查看器', (await page.locator('#viewerCommentCount').textContent()) === '2');
  // 图标是「文案」而不只是 class —— 只断言 is-on 的话，
  // 把 🤍/👍 的文本切换弄坏了测试不会红（class 还在，图标纹丝不动）。
  check('未赞时图标是 🤍', (await page.locator('#viewerLikeIco').textContent()) === '🤍', await page.locator('#viewerLikeIco').textContent());
  const href = await page.locator('#viewerComment').getAttribute('href');
  check('评论链接带图上下文', href && href.indexOf('img=' + DATE) >= 0 && href.indexOf('id=' + ID) >= 0, href);
  check('评论链接指到留言板', href && href.indexOf('/board/') === 0, href);
  // thumb 是 Task 4 要原样塞进 board API 的字段，必须过 IMG_THUMB_RE 白名单 ——
  // 取错（比如写成 imgThumb）这里会放行，留言板那边会返回 400「图片信息格式不对」。
  check('评论链接带了缩略图', href && href.indexOf('thumb=' + encodeURIComponent(THUMB)) >= 0, href);
}

console.log('\n── 版面 ──');
{
  // 实测过的坑：操作栏一开始写成 position:absolute; bottom:0，
  // 结果正好盖住 .viewer-hint 整条（重叠 46px）——
  // 「左右滑动切换 · 长按可保存」这个提示就永远看不见了。
  // 这里量盒模型，把「不重叠」锁死。
  const g = await page.evaluate(() => {
    const r = (s) => {
      const e = document.querySelector(s);
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom };
    };
    return { hint: r('.viewer-hint'), acts: r('.viewer-actions') };
  });
  const overlap = g.hint && g.acts
    ? Math.max(0, Math.min(g.hint.bottom, g.acts.bottom) - Math.max(g.hint.top, g.acts.top))
    : -1;
  check('操作栏没盖住滑动提示', overlap === 0, { overlap, hint: g.hint, acts: g.acts });
}

// 评论按钮里是三个相邻元素：图标 / 数字 / 文案。
// flex gap 时代三段之间都有 6px；改成 margin 之后如果只补了「图标→数字」那一段，
// 「数字→文案」就会贴成 0px，按钮显示成「💬 0评论这张图」。
{
  const g = await page.evaluate(() => {
    const cnt = document.querySelector('#viewerCommentCount');
    if (!cnt) return null;
    const cr = cnt.getBoundingClientRect();
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let textLeft = null;
    while (w.nextNode()) {
      const n = w.currentNode;
      if (n.nodeValue && n.nodeValue.indexOf('评论这张图') >= 0) {
        const rg = document.createRange();
        rg.selectNodeContents(n);
        textLeft = rg.getBoundingClientRect().left;
        break;
      }
    }
    return { countRight: cr.right, textLeft: textLeft };
  });
  check('评论按钮里数字和文案没贴死', !!g && g.textLeft !== null && g.textLeft - g.countRight >= 3, g);
}

console.log('\n── 点赞 ──');
await page.locator('#viewerLike').click();
await page.waitForTimeout(400);
{
  check('POST 发出去了', posted.length === 1, posted);
  check('POST 带上了 on=true', posted[0] && posted[0].on === true, posted[0]);
  check('POST 带上了 16 位访客 id', posted[0] && /^[0-9a-f]{16}$/.test(posted[0].vid || ''), posted[0] && posted[0].vid);
  check('查看器赞数 +1', (await page.locator('#viewerLikeCount').textContent()) === '4');
  check('按钮进入已赞态', await page.locator('#viewerLike').evaluate((el) => el.classList.contains('is-on')));
  check('赞过的图标切成 👍', (await page.locator('#viewerLikeIco').textContent()) === '👍', await page.locator('#viewerLikeIco').textContent());
  const stored = await page.evaluate(() => localStorage.getItem('like-mine-v1'));
  check('localStorage 记住了', stored && stored.indexOf(ID) >= 0, stored);
}

console.log('\n── 重复点 = 取消赞 ──');
await page.locator('#viewerLike').click();
await page.waitForTimeout(400);
{
  check('第二次 POST 是取消', posted[1] && posted[1].on === false, posted[1]);
  check('赞数回到 3', (await page.locator('#viewerLikeCount').textContent()) === '3');
  check('取消后图标回到 🤍', (await page.locator('#viewerLikeIco').textContent()) === '🤍');
  check('取消后按钮退出已赞态', !(await page.locator('#viewerLike').evaluate((el) => el.classList.contains('is-on'))));
}

console.log('\n── 点赞失败时不能把界面搞坏 ──');
{
  failPosts = true;
  await page.locator('#viewerLike').click();
  await page.waitForTimeout(600);
  failPosts = false;
  // 计数不能变（服务端没写成，前端也不该自己加）
  check('失败后计数不变', (await page.locator('#viewerLikeCount').textContent()) === '3', await page.locator('#viewerLikeCount').textContent());
  // 按钮必须恢复可用 —— 不然用户再点就没反应了
  check('失败后按钮恢复可用', !(await page.locator('#viewerLike').evaluate((el) => el.disabled)));
  // 也不能记成「我赞过」
  const mine = await page.evaluate(() => localStorage.getItem('like-mine-v1'));
  check('失败后不记进 localStorage', !mine || mine.indexOf(ID) < 0, mine);
}

console.log('\n── 计数缓存过期时不能出现「👍 0」 ──');
{
  // GET 带 public, max-age=30，浏览器可能存着 30 秒前的旧副本。
  // 「我赞过」在 localStorage 里，旧计数在缓存里 —— 两者对不上时
  // 会出现「👍 0」这种自相矛盾的状态（全局评审实测过）。
  // 我赞过 = 至少 1 个赞（我自己的那个就在里面），所以下限是 1。
  await page.evaluate((d) => localStorage.setItem('like-mine-v1', JSON.stringify({ [d]: ['jianxiao_001'] })), DATE);
  staleCounts = true;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  const badge = await page.locator('#grid-jianxiao .like-badge').first().textContent();
  check('旧副本下角标仍显示我那一个赞', badge === '👍 1', badge);
  await page.locator('#grid-jianxiao .cell').first().click();
  await page.waitForTimeout(300);
  check('旧副本下查看器数字是 1 不是 0', (await page.locator('#viewerLikeCount').textContent()) === '1', await page.locator('#viewerLikeCount').textContent());
  check('旧副本下图标仍是 👍', (await page.locator('#viewerLikeIco').textContent()) === '👍');
  staleCounts = false;
}

await browser.close();
server.close();

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
if (fail) process.exit(1);
