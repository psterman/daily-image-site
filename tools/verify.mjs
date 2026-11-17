/**
 * 移动端视口验证：模拟微信内置浏览器 UA + iPhone 尺寸，检查图片是否真的加载
 *
 * 用法：node tools/verify.mjs [url] [输出目录]
 */
import { chromium, devices } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const URL_ = process.argv[2] || 'http://localhost:8788/2026-10-25/';
const OUT = process.argv[3] || path.join(ROOT, '.verify');

// 微信内置浏览器 UA（安卓 X5 内核）
const WECHAT_UA =
  'Mozilla/5.0 (Linux; Android 10; V1938CT Build/QP1A.190711.020; wv) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Version/4.0 Chrome/78.0.3904.108 Mobile Safari/537.36 ' +
  'MicroMessenger/8.0.32.2180(0x28002037) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64';

const PROFILE = {
  name: 'wechat-iphone',
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: WECHAT_UA,
};

async function run() {
  await fs.mkdir(OUT, { recursive: true });

  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext(PROFILE);
  const page = await ctx.newPage();

  const errors = [];
  const failed = [];
  const imgReqs = [];
  const httpErrs = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => failed.push(`${r.url()} :: ${r.failure()?.errorText}`));
  page.on('response', (r) => {
    if (r.url().includes('/img/')) {
      imgReqs.push(`${r.status()} ${r.url().replace(URL_, '/')}`);
      if (r.status() >= 400) httpErrs.push(`${r.status()} ${r.url().replace(URL_, '/')}`);
    }
  });

  const t0 = Date.now();
  await page.goto(URL_, { waitUntil: 'load', timeout: 30000 });
  const loadMs = Date.now() - t0;

  // 首屏截图（不等懒加载完，看真实首屏）
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, '01-first-screen.png') });

  // 滚动触发懒加载
  await page.evaluate(async () => {
    const h = document.body.scrollHeight;
    for (let y = 0; y < h; y += 600) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, '02-after-scroll.png'), fullPage: false });

  const stats = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('.cell img'));
    const withSrc = imgs.filter((i) => i.getAttribute('src'));
    const loaded = document.querySelectorAll('.cell.is-loaded').length;
    const cells = document.querySelectorAll('.cell').length;
    // 关键：HTTP 404 不会触发 requestfailed，必须看 naturalWidth
    const broken = withSrc.filter((i) => i.complete && i.naturalWidth === 0).length;
    const okImgs = withSrc.filter((i) => i.naturalWidth > 0).length;
    const tabs = Array.from(document.querySelectorAll('.tab')).map((t) => ({
      label: t.textContent.trim(),
      active: t.classList.contains('is-active'),
    }));
    const activeGrid = document.querySelector('.grid.is-active');
    return {
      cells,
      imgsTotal: imgs.length,
      imgsWithSrc: withSrc.length,
      imgsOk: okImgs,
      imgsBroken: broken,
      cellsLoaded: loaded,
      tabs,
      activeGridId: activeGrid?.id,
      activeGridItems: activeGrid?.querySelectorAll('.cell').length,
      pageHeight: document.body.scrollHeight,
      firstImgNatural: withSrc[0] ? withSrc[0].naturalWidth + 'x' + withSrc[0].naturalHeight : 'n/a',
    };
  });

  // 计算样式诊断：图片到底为什么看不见
  const diag = await page.evaluate(() => {
    const grid = document.querySelector('.grid.is-active');
    const cell = grid && grid.querySelector('.cell');
    if (!cell) return { err: 'no cell' };
    const img = cell.querySelector('img');
    const cs = getComputedStyle(img);
    const cc = getComputedStyle(cell);
    const r = img.getBoundingClientRect();
    const cr = cell.getBoundingClientRect();
    return {
      cellClass: cell.className,
      cellRect: `${cr.width.toFixed(1)}x${cr.height.toFixed(1)} @${cr.top.toFixed(0)}`,
      cellOverflow: cc.overflow,
      cellPaddingTop: cc.paddingTop,
      imgSrc: img.getAttribute('src'),
      imgComplete: img.complete,
      imgNatural: `${img.naturalWidth}x${img.naturalHeight}`,
      imgRect: `${r.width.toFixed(1)}x${r.height.toFixed(1)} @${r.top.toFixed(0)},${r.left.toFixed(0)}`,
      imgOpacity: cs.opacity,
      imgDisplay: cs.display,
      imgVisibility: cs.visibility,
      imgPosition: cs.position,
      imgWidth: cs.width,
      imgHeight: cs.height,
      imgObjectFit: cs.objectFit,
      imgZIndex: cs.zIndex,
      gridDisplay: getComputedStyle(grid).display,
      gridColumnCount: getComputedStyle(grid).columnCount,
      sheetCount: document.styleSheets.length,
    };
  });

  // 切到「见闻」tab 截图
  await page.click('.tab[data-key="jianwen"]');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, '03-tab-jianwen.png') });

  // 点开第一张大图
  await page.click('.grid.is-active .cell');
  // 等大图真正解码完成再截图。
  // 固定 sleep 会在缓存冷/网络慢时误判成「图片加载不出来」——
  // 之前就因为固定等 1800ms 出现过 natural 0x0 的假警报。
  await page
    .waitForFunction(
      () => {
        const i = document.getElementById('viewerImg');
        return !!i && i.complete && i.naturalWidth > 0;
      },
      { timeout: 20000 },
    )
    .catch(() => console.log('  !! 等待大图解码超时（20s）'));
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, '04-viewer.png') });
  const viewerState = await page.evaluate(() => {
    const v = document.getElementById('viewer');
    const im = document.getElementById('viewerImg');
    const hint = document.getElementById('viewerHint');
    const hs = getComputedStyle(hint);
    const hr = hint.getBoundingClientRect();
    return {
      visible: !v.hidden,
      count: document.getElementById('viewerCount').textContent,
      imgSrc: im.getAttribute('src'),
      natural: im.naturalWidth + 'x' + im.naturalHeight,
      hintClass: hint.className,
      hintOpacity: hs.opacity,
      hintRect: `${hr.width.toFixed(0)}x${hr.height.toFixed(0)} @${hr.top.toFixed(0)}`,
      hintText: hint.textContent.trim(),
    };
  });

  await page.click('#viewerClose');
  await page.waitForTimeout(400);

  // 切到「见她」tab
  await page.click('.tab[data-key="jianshe"]');
  await page.waitForTimeout(1200);
  // 等这一屏的缩略图实际解码完，避免最后跳归档页时把在途请求取消掉、
  // 被误记成 net::ERR_ABORTED
  await page
    .waitForFunction(
      () => {
        const imgs = Array.from(document.querySelectorAll('.grid.is-active .cell img'));
        const withSrc = imgs.filter((i) => i.getAttribute('src'));
        return withSrc.length > 0 && withSrc.every((i) => i.complete);
      },
      { timeout: 20000 },
    )
    .catch(() => console.log('  !! 等待「见她」缩略图解码超时'));
  await page.screenshot({ path: path.join(OUT, '05-tab-jianshe.png') });

  // 标题 / 分享卡片 / logo —— 必须在日期页上取，不能在跳归档页之后取
  const meta = await page.evaluate(() => {
    const og = (p) => document.querySelector(`meta[property="${p}"]`)?.content || '(缺)';
    const logo = document.querySelector('.brand-mark');
    return {
      title: document.title,
      h1: document.querySelector('.brand-text h1')?.textContent,
      ogTitle: og('og:title'),
      ogDesc: og('og:description'),
      ogImage: og('og:image'),
      ogUrl: og('og:url'),
      logoSrc: logo?.getAttribute('src'),
      logoComplete: logo?.complete,
      logoNatural: logo ? `${logo.naturalWidth}x${logo.naturalHeight}` : 'n/a',
      logoVisible: logo ? getComputedStyle(logo).display !== 'none' : false,
    };
  });

  // 归档页（群友收藏的主入口）
  // 先把失败请求快照下来：跳归档页会取消日期页还在途的请求，
  // 那些 ERR_ABORTED 是导航行为造成的，不是图片本身的问题
  const failedSnapshot = [...failed];
  const imgReqSnapshot = [...imgReqs];
  const httpErrSnapshot = [...httpErrs];

  // 往期列表在 /archive/（根路径现在是「今天」）
  const rootUrl = new URL('/archive/', URL_).toString();
  await page.goto(rootUrl, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, '06-archive.png') });
  const archiveState = await page.evaluate(() => ({
    title: document.title,
    h1: document.querySelector('.head h1')?.textContent,
    latest: document.querySelector('.latest .date')?.textContent,
    latestHref: document.querySelector('.latest')?.getAttribute('href'),
    logoOk: (() => { const l = document.querySelector('.logo'); return l ? l.complete && l.naturalWidth > 0 : false; })(),
    ogImage: document.querySelector('meta[property="og:image"]')?.content,
  }));

  console.log('========== 移动端验证 ==========');
  console.log('UA           :', PROFILE.userAgent.slice(0, 60) + '...');
  console.log('视口         :', PROFILE.viewport.width + 'x' + PROFILE.viewport.height);
  console.log('首屏加载     :', loadMs + 'ms');
  console.log('页面高度     :', stats.pageHeight);
  console.log('单元格       :', stats.cells, '已加载:', stats.cellsLoaded);
  console.log('img 有 src   :', stats.imgsWithSrc + ' / ' + stats.imgsTotal);
  console.log('img 真正渲染 :', stats.imgsOk, ' 损坏(404/解码失败):', stats.imgsBroken);
  if (stats.imgsBroken > 0) console.log('  !! 有图片没渲染出来，检查路径或服务器');
  console.log('首图实际尺寸 :', stats.firstImgNatural);
  console.log('Tab          :', stats.tabs.map((t) => `${t.label}${t.active ? '*' : ''}`).join(' '));
  console.log('当前网格     :', stats.activeGridId, '项数', stats.activeGridItems);
  console.log('查看器       :', JSON.stringify(viewerState));
  console.log('图片请求数   :', imgReqSnapshot.length);
  console.log('  前5条:', imgReqSnapshot.slice(0, 5).join(' | '));
  console.log('失败请求     :', failedSnapshot.length);
  failedSnapshot.slice(0, 8).forEach((f) => console.log('  !', f));
  console.log('图片 HTTP 错误:', httpErrSnapshot.length);
  httpErrSnapshot.slice(0, 5).forEach((f) => console.log('  !', f));
  console.log('控制台错误   :', errors.length);
  errors.slice(0, 10).forEach((e) => console.log('  !', e));
  console.log('截图目录     :', OUT);
  console.log('\n---- 归档页 ----');
  console.log(JSON.stringify(archiveState, null, 2));
  console.log('\n---- 标题 / 分享卡片 / logo ----');
  console.log(JSON.stringify(meta, null, 2));
  console.log('\n---- 计算样式诊断 ----');
  console.log(JSON.stringify(diag, null, 2));

  await browser.close();
}

run().catch((e) => {
  console.error('验证失败:', e);
  process.exit(1);
});
