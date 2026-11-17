/**
 * 留言板「跟图评论」的 Playwright 测试
 *
 * 为什么要起一个假页面：
 *   本机的 workerd 跑不起来（VC++ 运行库问题），wrangler pages dev 用不了，
 *   所以这里用 Node 起一个静态服务器，把 site/board.html 原样端上来，
 *   再用 playwright 的 route 拦截把 /board/api 换成假的响应。
 *   留言板页的前端逻辑（读 ?img=&id=&thumb=、白名单、按图过滤、缩略图、
 *   提交时带上图上下文）都是真的在跑。
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
const IMG_ID = 'jianxiao_012';
const THUMB = '/img/' + DATE + '/jianxiao/ab12cd34ef_012_t.webp';

const MESSAGES = [
  { id: 'm1', ts: 1750000000000, name: 'A', body: '这张图绝了', link: '', cat: '',
    imgDate: DATE, imgId: IMG_ID, imgThumb: THUMB, mine: false },
  { id: 'm2', ts: 1750000001000, name: 'B', body: '跟图留言', link: '', cat: '',
    imgDate: DATE, imgId: IMG_ID, imgThumb: THUMB, mine: false },
  { id: 'm3', ts: 1750000002000, name: 'C', body: '普通留言', link: '', cat: '',
    imgDate: '', imgId: '', imgThumb: '', mine: false },
  /* 缩略图合法、但日期非法 —— 服务端写不出这种数据（写入时两边都校验过），
     但前端必须能扛住：缩略图照样显示、照样跟正文同一行，只是不给链接。 */
  { id: 'm4', ts: 1750000003000, name: 'D', body: '坏日期的留言', link: '', cat: '',
    imgDate: 'bad-date', imgId: 'jianxiao_013', imgThumb: '/img/' + DATE + '/jianxiao/cc12cd34ef_013_t.webp', mine: false },
];

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
  // board.html 是自包含页面（样式脚本都内联），只有 favicon 指向 /assets/logo.jpg（404 无所谓）。
  // 必须在 / 和 /board/ 上都返回它 —— 下面的断言是 page.goto(base + '/board/?img=...') 去的，
  // 只在 / 提供服务的话会 404，报错会指向「页面元素不存在」这种误导性的地方。
  const pathname = req.url.split('?')[0];
  if (pathname === '/' || pathname === '/index.html' || pathname === '/board/' || pathname === '/board') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(SITE, 'board.html'), 'utf8'));
    return;
  }
  const file = path.join(SITE, path.basename(pathname));
  if (fs.existsSync(file)) {
    // 按扩展名给 MIME。别图省事全按 text/css 发 ——
    // 将来加了 nosniff 或者换到会强制校验 MIME 的内核，测试会红得莫名其妙。
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

// 假的留言接口
let posted = [];
await page.route('**/board/api*', async (route) => {
  const req = route.request();
  if (req.method() === 'POST') {
    posted.push(JSON.parse(req.postData() || '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    return;
  }
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: MESSAGES }) });
});
// 缩略图用 1x1 png 顶着
await page.route('**/img/**', (route) => route.fulfill({
  status: 200, contentType: 'image/png',
  body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
}));

console.log('\n── 带图参数进入 ──');
await page.goto(base + '/board/?img=' + DATE + '&id=' + IMG_ID + '&thumb=' + encodeURIComponent(THUMB), { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
{
  check('显示目标图上下文', await page.locator('#imgCtx').isVisible());
  check('目标图缩略图已渲染', await page.locator('#imgCtx img').count() > 0);
  const src = await page.locator('#imgCtx img').first().getAttribute('src');
  check('缩略图用的是白名单里的那张', src === THUMB, src);
  check('列表只剩这张图的评论', (await page.locator('p.msg-body').allTextContents()).filter((t) => t.includes('普通留言')).length === 0);
  check('这张图的两条评论都在', (await page.locator('p.msg-body').allTextContents()).filter((t) => t.indexOf('图') >= 0).length >= 2);
  check('有「看全部留言」入口', await page.locator('#showAll').isVisible());
  check('留言带缩略图', await page.locator('img.msg-thumb').count() >= 1);

  // 副标题给用户看的是中文栏目名，不是内部 id（jianxiao_012）
  const sub = await page.locator('#imgCtxSub').textContent();
  check('副标题显示中文栏目名', sub === '见笑 · 012', sub);
  check('副标题不含内部 id', sub.indexOf('jianxiao') < 0, sub);

  // 缩略图包在 <a> 里 —— 原生链接才有键盘可聚焦 / 回车可点 / 右键新标签 / 长按保存。
  // <img> 挂 click 处理这四样一个都没有。
  {
    const link = await page.evaluate(() => {
      const a = document.querySelector('a.msg-thumb-link');
      if (!a) return null;
      const img = a.querySelector('img.msg-thumb');
      return {
        href: a.getAttribute('href'),
        hasImg: !!img,
        tabbable: a.tabIndex >= 0,
        imgAlt: img ? img.getAttribute('alt') : null,
      };
    });
    check('留言缩略图是真正的链接', !!link && link.hasImg, link);
    check('链接指向那张图的日期页', !!link && link.href === '/' + DATE + '/', link && link.href);
    check('链接可被键盘聚焦', !!link && link.tabbable, link);
    /* alt 是这个链接唯一的可访问名 —— <a> 里只有一张图，alt 空了屏幕阅读器就只会读出「链接」。
       把 alt 置空，早先没有任何断言会发现（变异 M25）。 */
    check('缩略图 alt 文本非空', !!link && !!link.imgAlt, link);
    check('缩略图 alt 说明这是跳转链接', !!link && link.imgAlt === '跳到这张图', link && link.imgAlt);
  }
  // 缩略图要跟正文**同一行**。挂在 li 上（li 里 p 是块级元素）的话，
  // 缩略图会自己独占一行、把正文挤到下面 —— CSS 里的 vertical-align / margin-right 就白写了。
  {
    const g = await page.evaluate(() => {
      const t = document.querySelector('img.msg-thumb');
      const p = document.querySelector('p.msg-body');
      if (!t || !p) return null;
      const tr = t.getBoundingClientRect();
      let textLeft = null;
      for (const n of p.childNodes) {
        if (n.nodeType === 3 && n.nodeValue.trim()) {
          const rg = document.createRange();
          rg.selectNodeContents(n);
          textLeft = rg.getBoundingClientRect().left;
          break;
        }
      }
      return { thumbRight: tr.right, textLeft: textLeft };
    });
    check('缩略图跟正文同一行', !!g && g.textLeft !== null && g.textLeft > g.thumbRight, g);
  }
  const tip = await page.locator('#countTip').textContent();
  check('计数按过滤后的条数', tip === '这张图 2 条评论', tip);
  const showAllHref = await page.locator('#showAll').getAttribute('href');
  check('「看全部留言」指向留言板', showAllHref === '/board/', showAllHref);
}

console.log('\n── 不带图参数（行为跟现在完全一样）──');
await page.goto(base + '/board/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
{
  check('不带参数时列出全部留言', (await page.locator('p.msg-body').allTextContents()).some((t) => t.includes('普通留言')));
  check('不带参数时不显示图上下文', !(await page.locator('#imgCtx').isVisible()));
  const tip = await page.locator('#countTip').textContent();
  check('不带参数时计数是全部', tip === '共 4 条留言', tip);

  /* 日期非法的那条：缩略图还得跟正文同一行。
     早先只有「日期合法」那条分支包了 <a>，非法分支把 <img> 直接塞进 p，
     而 .msg-thumb 是 display:block（为了让 <a> 里的图不撑出基线间隙）
     —— 那条分支上缩略图就自己独占一行、正文被挤到下面
     （真实 Chrome 实测：间距 -48、不同行）。 */
  {
    const g = await page.evaluate(() => {
      const ps = Array.from(document.querySelectorAll('p.msg-body'));
      const p = ps.find((x) => x.textContent.indexOf('坏日期的留言') >= 0);
      if (!p) return null;
      const t = p.querySelector('img.msg-thumb');
      if (!t) return { noThumb: true };
      const tr = t.getBoundingClientRect();
      let textLeft = null;
      let textTop = null;
      let textBottom = null;
      for (const n of p.childNodes) {
        if (n.nodeType === 3 && n.nodeValue.trim()) {
          const rg = document.createRange();
          rg.selectNodeContents(n);
          const r = rg.getBoundingClientRect();
          textLeft = r.left; textTop = r.top; textBottom = r.bottom;
          break;
        }
      }
      const link = p.querySelector('a.msg-thumb-link');
      const img = p.querySelector('img.msg-thumb');
      return {
        thumbRight: tr.right, thumbTop: tr.top, thumbBottom: tr.bottom,
        textLeft, textTop, textBottom,
        hasHref: !!(link && link.getAttribute('href')),
        imgAlt: img ? img.getAttribute('alt') : null,
        gap: textLeft === null ? null : +(textLeft - tr.right).toFixed(2),
      };
    });
    check('日期非法时缩略图仍然渲染', !!g && !g.noThumb, g);
    check('日期非法时缩略图跟正文同一行', !!g && g.textTop !== null && g.textTop < g.thumbBottom && g.textBottom > g.thumbTop, g);
    check('日期非法时缩略图跟正文间距 8px', !!g && g.gap === 8, g);
    check('日期非法时不给链接', !!g && g.hasHref === false, g);
    /* 不给链接不等于没有可访问名 —— alt 照样得有 */
    check('日期非法时缩略图 alt 文本仍非空', !!g && !!g.imgAlt, g);
  }
}

console.log('\n── 栏目中文名：见报也要有 ──');
{
  /* TAB_LABELS 里如果漏了 news，留言板就会显示一串没人看得懂的 news_001，
     而且没有任何报错（变异 M21：删掉 news 键，全套断言照样绿）。
     这条不依赖 manifest 里有没有见报栏目 —— 纯文字期次也得能显示中文名。 */
  await page.goto(base + '/board/?img=' + DATE + '&id=news_001&thumb=' + encodeURIComponent('/img/' + DATE + '/news/ab12cd34ef_001_t.webp'), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  check('见报栏目显示图上下文', await page.locator('#imgCtx').isVisible());
  const sub = await page.locator('#imgCtxSub').textContent();
  check('见报栏目的副标题是「见报 · 001」', sub === '见报 · 001', sub);
  check('见报栏目的副标题不含内部 id', sub.indexOf('news') < 0, sub);
}

console.log('\n── 伪造的 thumb 不得被当成图片渲染 ──');
await page.goto(base + '/board/?img=' + DATE + '&id=' + IMG_ID + '&thumb=' + encodeURIComponent('https://evil.example.com/x.png'), { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
{
  check('伪造 thumb 时不显示图上下文', !(await page.locator('#imgCtx').isVisible()));
  // 扫全页所有 img 的 src —— 不只是图上下文里那一张：
  // 万一 evil URL 被写进了「留言前的缩略图」，这条也要挡住。
  const srcs = await page.locator('img').evaluateAll((els) => els.map((e) => e.getAttribute('src')));
  check('伪造 thumb 不出现在任何 img src 里', srcs.every((s) => !s || s.indexOf('evil.example.com') < 0), srcs);
  // 图上下文那张 img 的 src 应当压根没被写进去。
  // 不能只写 every(s => !s)：#imgCtxImg 万一从模板里消失了，
  // 匹配数就变成 0 -> [] -> every 恒真 -> 这条断言静默通过。
  // 所以必须同时锁住「恰好有一张」和「它的 src 是空的」。
  const ctxSrcs = await page.locator('#imgCtx img').evaluateAll((els) => els.map((e) => e.getAttribute('src')));
  check('图上下文里恰好一张 img', ctxSrcs.length === 1, ctxSrcs);
  check('伪造 thumb 没有写进图上下文的 img', ctxSrcs.length === 1 && ctxSrcs[0] === null, ctxSrcs);
}

console.log('\n── 这张图还没有评论 ──');
{
  await page.goto(base + '/board/?img=' + DATE + '&id=jianxiao_099&thumb=' + encodeURIComponent('/img/' + DATE + '/jianxiao/ab12cd34ef_099_t.webp'), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  check('空列表时显示空状态提示', await page.locator('#emptyTip').isVisible());
  const t = await page.locator('#emptyTip').textContent();
  check('空状态文案说的是「这张图」', t.indexOf('这张图') >= 0, t);
  check('空列表时计数为空', (await page.locator('#countTip').textContent()) === '');
}

console.log('\n── 参数不全时退回普通留言板 ──');
{
  await page.goto(base + '/board/?img=' + DATE + '&id=' + IMG_ID, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  check('没有 thumb 时不显示图上下文', !(await page.locator('#imgCtx').isVisible()));
  check('没有 thumb 时列出全部留言', (await page.locator('p.msg-body').allTextContents()).some((t) => t.includes('普通留言')));
}

console.log('\n── 点缩略图跳回那天的日期页 ──');
{
  await page.goto(base + '/board/?img=' + DATE + '&id=' + IMG_ID + '&thumb=' + encodeURIComponent(THUMB), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  await page.locator('img.msg-thumb').first().click();
  await page.waitForTimeout(600);
  check('点缩略图跳到那天的日期页', page.url().indexOf('/' + DATE + '/') >= 0, page.url());
}

console.log('\n── 提交时带上图上下文 ──');
{
  // 带图上下文时提交，payload 要带那三个键
  await page.goto(base + '/board/?img=' + DATE + '&id=' + IMG_ID + '&thumb=' + encodeURIComponent(THUMB), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  posted.length = 0;
  await page.locator('#bodyInput').fill('测试留言');
  await page.locator('#submitBtn').click();
  await page.waitForTimeout(500);
  const p = posted[0] || {};
  check('提交带上了 imgDate', p.imgDate === DATE, p);
  check('提交带上了 imgId', p.imgId === IMG_ID, p);
  check('提交带上了 imgThumb', p.imgThumb === THUMB, p);
  check('提交也带了正文', p.body === '测试留言', p);

  // 不带图上下文时提交，payload 里不能有那三个键
  // （后端约定「要么都不给，要么都给」）
  await page.goto(base + '/board/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  posted.length = 0;
  await page.locator('#bodyInput').fill('普通留言');
  await page.locator('#submitBtn').click();
  await page.waitForTimeout(500);
  const q = posted[0] || {};
  check('不带上下文时没有 imgDate', !('imgDate' in q), q);
  check('不带上下文时没有 imgId', !('imgId' in q), q);
  check('不带上下文时没有 imgThumb', !('imgThumb' in q), q);
}

await browser.close();
server.close();

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
if (fail) process.exit(1);
