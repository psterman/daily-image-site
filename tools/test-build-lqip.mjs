#!/usr/bin/env node
/**
 * 护栏：模糊占位（LQIP / blur-up）这条链不许被改坏。
 *
 * 用法：node tools/test-build-lqip.mjs
 * 退出码：0 = 全过；1 = 有失败
 *
 * ── 这条链是什么 ─────────────────────────────────────────────
 * 站内图片是懒加载的（img.src 一直空着，等进视口才赋值），
 * 所以首屏是一格格空的深色方块，要等 3~4 秒缩略图才淡入。
 * LQIP = 每张照片额外带一张 24px 宽的小图，以 base64 data URI **内联**进 manifest：
 *   · 零额外请求、零额外 R2 对象
 *     （走 R2 的话多出来的对象要进「上传 / 孤儿清理 / 代理放行」三条管道，少改一处就线上裂图）
 *   · 24px 放大到 400px 时浏览器自己的插值已经足够模糊，
 *     所以**刻意不用** CSS 的 filter: blur()（182 个模糊图层，手机上掉帧）
 *
 * ── 这些断言盯的是「坏了很难发现」的地方 ─────────────────────
 *   1. ffmpeg 的 flags 必须是 fast_bilinear —— 写 flags=fast 在 ffmpeg 9.0.2 上是**非法值**：
 *      整批 182 张全废，报的还是「Undefined constant or missing '(' in 'fast'」这种不像样的错。
 *   2. 必须批量：一图一进程 = 182 个 ffmpeg 进程 ≈ +45 秒构建（批量 12 张只要 16 次）。
 *   3. 宽度必须 24px（96px 的占位图会让 manifest 暴涨，模糊占位就变成负担了）。
 *   4. LQIP 失败只降级不阻断构建（它是锦上添花，不是发布的前提）。
 *   5. 只给三栏照片做 —— 见报 RSS 配图也做的话 manifest 会涨到 ~150KB。
 *   6. CSS 里不能出现 filter: blur(（182 个格子各建一个模糊图层，手机上明显掉帧）。
 *
 * ⚠️ 断言一律看**剥掉注释后的代码**：
 *    build.mjs / app.css 的注释里就写着 "LQIP"、"模糊占位"、"24px" 这些词，
 *    全文匹配的话护栏会把自己的说明书当成合规证据 —— 代码改坏了也照样全绿。
 *    app.css 里那句「为什么**不加** filter: blur()」就是活例子：不剥注释它会被当成真用了 blur。
 *
 * 变异测试入口：BUILD_LQIP_MJS / BUILD_MJS / APP_JS / APP_CSS 可以指向别的文件
 * （这样验「护栏能抓住坏版本」时不用碰真文件）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripJsComments, stripHtmlComments, stripCssComments } from './strip-comments.mjs';
// 整组导入（工程约定）。本护栏只用得上 JS 与 CSS 两个剥法 ——
// 这条链里没有 HTML 目标（manifest 是 JS，样式是 CSS），所以 stripHtmlComments 在这儿是备用的。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;

/**
 * 记一条断言。
 *
 * ⚠️ 这个函数**不能抛异常**：护栏的红必须是「断言不成立」，
 *    不是「护栏自己崩了」——崩出来的红会把真缺口盖住（变异测试认这个）。
 */
function check(label, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? '  —— ' + detail : ''}`);
  }
}

/** 环境变量给的是绝对路径就用它，给相对路径就按工程根算。 */
function resolvePath(rel) {
  return path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
}

/** 读原始字节（编码断言要用字节，不能用字符串）。 */
function readBytes(rel) {
  try {
    return fs.readFileSync(resolvePath(rel));
  } catch {
    return null;
  }
}

/** 读文本。读不到就返回空串 —— 后面的断言自然会红，而不是让护栏崩。 */
function readText(rel) {
  const b = readBytes(rel);
  return b === null ? '' : b.toString('utf8');
}

/**
 * 从 idx 处开始找一个花括号块，返回块**内**的文本。
 *
 * 为什么不用正则：块里可能有模板串 `${...}`（自带花括号），
 * 正则数不准就会把 catch 块的范围算错。
 */
function blockAt(src, idx) {
  const open = src.indexOf('{', idx);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return '';
}

/** 全部命中位置。 */
function allIdx(src, re) {
  return [...src.matchAll(re)].map((m) => m.index);
}

const LQIP_REL = process.env.BUILD_LQIP_MJS || path.join('tools', 'build-lqip.mjs');
const BUILD_REL = process.env.BUILD_MJS || path.join('tools', 'build.mjs');
const APPJS_REL = process.env.APP_JS || path.join('site', 'app.js');
const CSS_REL = process.env.APP_CSS || path.join('site', 'app.css');

const lqipBytes = readBytes(LQIP_REL);
const buildBytes = readBytes(BUILD_REL);
const appJsBytes = readBytes(APPJS_REL);
const appCssBytes = readBytes(CSS_REL);

const lqipText = lqipBytes === null ? '' : lqipBytes.toString('utf8');
const buildText = buildBytes === null ? '' : buildBytes.toString('utf8');
const appJsText = appJsBytes === null ? '' : appJsBytes.toString('utf8');
const appCssText = appCssBytes === null ? '' : appCssBytes.toString('utf8');

/** 匹配只认「剥掉注释后的代码」—— 说明书不算证据。 */
const lqipCode = stripJsComments(lqipText);
const buildCode = stripJsComments(buildText);
const appJsCode = stripJsComments(appJsText);
const appCssCode = stripCssComments(appCssText);

console.log('\n0) 文件在不在');
{
  check('tools/build-lqip.mjs 存在', lqipBytes !== null, LQIP_REL);
  check('tools/build.mjs 存在', buildBytes !== null, BUILD_REL);
  check('site/app.js 存在', appJsBytes !== null, APPJS_REL);
  check('site/app.css 存在', appCssBytes !== null, CSS_REL);
  if (lqipBytes === null || buildBytes === null || appJsBytes === null || appCssBytes === null) {
    console.log('\n缺文件，后面没法测了。');
    process.exit(1);
  }
}

console.log('\n1) build-lqip.mjs 的对外契约');
let makeLqipDataUris = null;
let getLqipStats = null;
{
  // ⚠️ 必须 import **被测的那个文件**（路径可能来自环境变量），
  //    不能 import 真的那个 —— 否则变异测试改坏了也测不出来。
  try {
    const mod = await import(pathToFileURL(resolvePath(LQIP_REL)).href);
    makeLqipDataUris = mod?.makeLqipDataUris ?? null;
    getLqipStats = mod?.getLqipStats ?? null;
  } catch (err) {
    check('build-lqip.mjs 能被 import（模块本身没坏）', false, String(err?.message ?? err));
  }
  check('build-lqip.mjs 导出 makeLqipDataUris', typeof makeLqipDataUris === 'function');
  check('build-lqip.mjs 导出 getLqipStats', typeof getLqipStats === 'function');
}

console.log('\n2) 批量：一批只起一次 ffmpeg');
{
  check('build-lqip.mjs 默认 batchSize = 12',
    /const\s+DEFAULT_BATCH_SIZE\s*=\s*12\s*;/.test(lqipCode),
    '12 是实测平衡点：再小进程启动开销占比上升，再大 Windows 命令行长度吃紧');
  check('build-lqip.mjs 的批次循环按 size 步进（不是一图一进程）',
    /for\s*\(\s*let\s+i\s*=\s*0\s*;\s*i\s*<\s*list\.length\s*;\s*i\s*\+=\s*size\s*\)/.test(lqipCode),
    '按 1 步进 = 182 个 ffmpeg 进程 ≈ +45 秒构建');
  const spawnSites = (lqipCode.match(/execFileAsync\s*\(/g) || []).length;
  check('build-lqip.mjs 一批一次 ffmpeg 调用（只有一个调用点）',
    spawnSites === 1,
    `找到 ${spawnSites} 个调用点 —— 多于一个就说明有地方在逐图起进程`);
  check('build-lqip.mjs 把整批图拼进同一次调用（多 input + 一条 filter_complex）',
    /for\s*\(\s*const\s+f\s+of\s+batch\s*\)\s*args\.push\(\s*'-i'\s*,\s*f\s*\)/.test(lqipCode) &&
    /args\.push\(\s*'-filter_complex'\s*,\s*filters\s*\)/.test(lqipCode) &&
    /\.join\(\s*';'\s*\)/.test(lqipCode),
    '一批多张必须共用一条 filter_complex，不能一张一条 filter');
}

console.log('\n3) 目标宽度 24px');
{
  check('build-lqip.mjs 的 LQIP 宽度默认 24px',
    /const\s+DEFAULT_WIDTH\s*=\s*24\s*;/.test(lqipCode),
    '24px 的 webp 约 150~400 字节；再大 manifest 就被占位图撑起来了');
  check('build-lqip.mjs 的缩放用 scale=宽度:-2（高度按比例）',
    /scale=\$\{width\}:-2/.test(lqipCode),
    '-2 = 高度取偶数（webp 编码器对奇数高个别版本会挑刺）');
}

console.log('\n4) ffmpeg 的 flags —— 这里真踩过坑');
{
  check('build-lqip.mjs 用 flags=fast_bilinear',
    /flags=fast_bilinear/.test(lqipCode),
    'ffmpeg 9.0.2 的 sws_flags 只认 fast_bilinear / bilinear / bicubic / lanczos');
  // 负向断言：flags=fast 后面不跟下划线 = 非法值 = 整批 182 张全废。
  // ⚠️ 这条必须看剥掉注释后的代码 —— 源码注释里就写着「写 flags=fast 会报…」，
  //    不剥注释的话护栏会把自己人写的坑说明当成违规。
  const badFlag = lqipCode.match(/flags\s*=\s*fast(?!_)/);
  check('build-lqip.mjs 没有非法的 flags=fast（ffmpeg 9.0.2 会整批失败）',
    badFlag === null,
    badFlag ? `出现非法 flags：${badFlag[0]}` : '');
}

console.log('\n5) 输出是 data URI（零额外请求、零额外 R2 对象）');
{
  check('build-lqip.mjs 输出 data:image/webp;base64, 前缀',
    /data:image\/webp;base64,/.test(lqipCode));
  check('makeLqipDataUris 返回的是 Map（key = 文件路径）',
    /const\s+out\s*=\s*new Map\(\s*\)/.test(lqipCode) &&
    /\.set\(\s*k\s*,\s*v\s*\)/.test(lqipCode) &&
    /return\s+out\s*;/.test(lqipCode));
  check('getLqipStats 返回统计快照（spawns / batches 计数）',
    (() => {
      try {
        const s = getLqipStats?.();
        return !!s && typeof s.spawns === 'number' && typeof s.batches === 'number';
      } catch {
        return false;
      }
    })());
}

console.log('\n6) 真跑一次：全失败必须只降级不阻断');
{
  // 用一个**不存在**的 ffmpeg 路径 —— 离线安全（不联网、不碰生产文件），
  // 但能真实走完「起进程 → 失败 → 降级」这条路径。
  const bogusFfmpeg = path.join(ROOT, 'tools', 'no-such-ffmpeg-for-lqip-guardrail');
  let map = null;
  let threw = null;
  try {
    // 模块里的警告会打到 stderr，把 stdout 留给断言输出（好让变异脚本按行解析）。
    const origWarn = console.warn;
    const warnings = [];
    console.warn = (...a) => { warnings.push(a.map(String).join(' ')); };
    try {
      map = await makeLqipDataUris({
        ffmpeg: bogusFfmpeg,
        files: ['a.webp', 'b.webp'],
        verbose: false,
      });
    } finally {
      console.warn = origWarn;
    }
  } catch (err) {
    threw = err;
  }
  check('makeLqipDataUris 全失败时返回空 Map 且不抛异常（只降级不阻断）',
    threw === null && map instanceof Map && map.size === 0,
    threw ? `抛异常了：${String(threw?.message ?? threw)}` : '返回的不是空 Map');
}

console.log('\n7) 真跑一次：24 张图应该只起 2 次 ffmpeg');
{
  // 这是「批量」的**运行时**证据：getLqipStats 数的是真正起过的进程。
  // 拿一个不存在的 ffmpeg 也算数 —— spawns 在 exec 之前就记了。
  const bogusFfmpeg = path.join(ROOT, 'tools', 'no-such-ffmpeg-for-lqip-guardrail');
  const files = Array.from({ length: 24 }, (_, i) => `fake-${i}.webp`);
  const before = getLqipStats?.() ?? {};
  let threw = null;
  try {
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      await makeLqipDataUris({ ffmpeg: bogusFfmpeg, files, verbose: false });
    } finally {
      console.warn = origWarn;
    }
  } catch (err) {
    threw = err;
  }
  const after = getLqipStats?.() ?? {};
  const batches = (after.batches ?? 0) - (before.batches ?? 0);
  const spawns = (after.spawns ?? 0) - (before.spawns ?? 0);
  check('makeLqipDataUris 24 张图只起 2 次 ffmpeg（批量 12）',
    threw === null && batches === 2 && spawns === 2,
    threw ? `抛异常了：${String(threw?.message ?? threw)}`
          : `批次 ${batches} 次 / ffmpeg ${spawns} 次（应该是 2 / 2 —— 一图一进程会是 24 / 24）`);
}

console.log('\n8) build.mjs 集成');
{
  check('build.mjs import 了 makeLqipDataUris',
    /import\s*\{[^}]*\bmakeLqipDataUris\b[^}]*\}\s*from\s*['"]\.\/build-lqip\.mjs['"]/.test(buildCode));

  const mapName = (buildCode.match(/const\s+(\w+)\s*=\s*await\s+makeLqipDataUris\s*\(/) || [])[1] ?? null;
  check('build.mjs 的 lqipMap 就是 makeLqipDataUris 的返回值（值是 data URI，不是文件路径）',
    !!mapName,
    '没找到 makeLqipDataUris 的返回值 —— 拿到的可能不是 data URI，而是文件路径');

  // 「写进 lqip 字段的」必须就是「从 lqipMap 里 .get 出来的那个值」，
  // 不能是另一个字符串（比如文件路径，或者空串）。
  const fromMap = mapName
    ? new Set([...buildCode.matchAll(new RegExp(`const\\s+(\\w+)\\s*=\\s*${mapName}\\.get\\s*\\(`, 'g'))].map((m) => m[1]))
    : new Set();
  const assigns = [...buildCode.matchAll(/(\w+)\.lqip\s*=\s*([^;]+);/g)];
  const goodAssign = assigns.find((m) => fromMap.has(m[2].trim()));
  check('build.mjs 把 LQIP 写进 manifest 条目的 lqip 字段',
    !!goodAssign,
    assigns.length === 0
      ? 'manifest 条目上根本没有 lqip 字段'
      : `写进去的值不是从 lqipMap 取的：${assigns.map((m) => m[0]).join(' | ')}`);

  // 失败不许掀翻构建：调用点必须在 try 里，catch 里不许 throw / exit。
  const callAt = buildCode.indexOf('makeLqipDataUris(');
  const tryAt = allIdx(buildCode, /\btry\s*\{/g).filter((i) => i < callAt).pop() ?? -1;
  const catchAt = allIdx(buildCode, /\bcatch\b/g).filter((i) => i > callAt)[0] ?? -1;
  const catchBody = catchAt > 0 ? blockAt(buildCode, catchAt) : '';
  check('build.mjs 的 LQIP 失败只降级不阻断构建',
    callAt > 0 && tryAt > 0 && tryAt < callAt && catchAt > callAt &&
    catchBody.length > 0 && !/\bthrow\b/.test(catchBody) && !/process\s*\.\s*exit/.test(catchBody),
    catchBody ? `catch 块里有不该有的东西：${catchBody.trim().slice(0, 80)}`
              : '调用点没被 try/catch 包住（或者 catch 块没找到）');

  // 只给三栏照片做：见报 RSS 配图也做的话 manifest 会涨到 ~150KB。
  const declAt = buildCode.indexOf('const lqipJobs = []');
  const newsAt = buildCode.indexOf('const newsItems = []');
  const region = declAt >= 0 && newsAt > declAt ? buildCode.slice(declAt, newsAt) : '';
  const pushes = (region.match(/lqipJobs\.push\s*\(/g) || []).length;
  const photoTabs = /dir:\s*'见闻'/.test(buildCode) && /dir:\s*'见她'/.test(buildCode) && /dir:\s*'见笑'/.test(buildCode);
  const noRss = !/newsItems|fetchRssImages|rssImg/.test(region);
  check('build.mjs 只给三栏照片收集 LQIP（不含见报 RSS 配图）',
    photoTabs && pushes === 1 && noRss &&
    /lqipJobs\.push\s*\(\s*\{\s*item\s*,\s*file\s*:\s*destThumb\s*\}\s*\)/.test(region),
    !photoTabs ? 'TABS 里不是三栏照片'
      : pushes !== 1 ? `lqipJobs.push 出现了 ${pushes} 次`
      : !noRss ? 'LQIP 收集区里混进了见报 / RSS 的东西'
      : 'push 的不是照片缩略图 destThumb');
}

console.log('\n9) app.js：把 lqip 写进 CSS 变量');
{
  check('app.js 把 item.lqip 写进 --lqip 变量',
    /cell\.style\.setProperty\(\s*['"]--lqip['"]/.test(appJsCode));
  check('app.js 的 --lqip 值是 url("...") 形式',
    // 源码写的是 'url("' + item.lqip + '")' —— 尾巴是 '")' 三个字符，别写成 ')'
    /setProperty\(\s*['"]--lqip['"]\s*,\s*['"]url\("['"]\s*\+\s*item\.lqip\s*\+\s*['"]"\)['"]\s*\)/.test(appJsCode),
    'data URI 里带逗号和分号，必须用 url("...") 包起来，否则整条声明作废');
  // 没有 lqip 时什么都不设 —— 写空串会产生 url("") 请求。
  const writeIdxs = allIdx(appJsCode, /setProperty\(\s*['"]--lqip['"]/g);
  const guardIdxs = allIdx(appJsCode, /if\s*\(\s*item\.lqip\s*\)/g);
  let guarded = true;
  for (const wi of writeIdxs) {
    const gi = [...guardIdxs].reverse().find((x) => x < wi);
    if (gi === undefined || appJsCode.slice(gi, wi).includes('}')) { guarded = false; break; }
  }
  check('app.js 没有 lqip 时不写变量（不产生 url("") 请求）',
    guardIdxs.length > 0 && guarded &&
    !/setProperty\(\s*['"]--lqip['"]\s*,\s*['"]['"]\s*\)/.test(appJsCode),
    !guardIdxs.length ? '没有 if (item.lqip) 这样的守卫'
      : !guarded ? '有 --lqip 的写入不在守卫里（没 lqip 的条目也会被写）'
      : '有地方往 --lqip 写了空串');
}

console.log('\n10) app.css：模糊层怎么画、怎么藏');
{
  check('app.css 的 .cell::before 用 background-image: var(--lqip, none)',
    /\.cell::before\s*\{[^}]*background-image\s*:\s*var\(\s*--lqip\s*,\s*none\s*\)/.test(appCssCode),
    '没有 lqip 的格子必须完全不画这一层');
  check('app.css 的 .cell.is-loaded::before 是 opacity: 0',
    /\.cell\.is-loaded::before\s*\{\s*opacity\s*:\s*0\s*;?\s*\}/.test(appCssCode),
    '图加载完就得把模糊层藏掉，否则它永远盖在图上面');
  // 「不做什么」的护栏：182 个格子各建一个模糊图层，手机上会明显掉帧。
  // ⚠️ 只认**独立的** filter: blur( —— backdrop-filter: blur( 是顶栏/浮层的合法用法，
  //    不能连它一起禁掉（否则这条断言在基线上就是红的）。
  const blurHit = appCssCode.match(/(^|[^-\w])filter\s*:\s*blur\s*\(/m);
  check('app.css 里没有 filter: blur(（182 个模糊图层掉帧）',
    blurHit === null,
    blurHit ? `出现 ${blurHit[0].trim()}` : '');
}

console.log('\n11) 剥注释自检：护栏没有把自己的说明书当证据');
{
  check('app.css 剥掉注释后不再含「模糊占位」（那段只在注释里）',
    !appCssCode.includes('模糊占位'));
  check('app.js 剥掉注释后不再含「模糊占位」（那段只在注释里）',
    !appJsCode.includes('模糊占位'));
  check('build-lqip.mjs 剥掉注释后不再含 ffmpeg 的报错原文（那段只在注释里）',
    !lqipCode.includes('Undefined constant'));
}

console.log('\n12) 编码');
{
  const hasBom = (b) => !!b && b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
  const hasCr = (b) => !!b && b.includes(0x0d);
  for (const [label, b] of [
    ['site/app.js', appJsBytes],
    ['site/app.css', appCssBytes],
    ['tools/build-lqip.mjs', lqipBytes],
  ]) {
    check(`${label} 无 BOM`, !hasBom(b));
    check(`${label} 只有 LF，没有 CR`, !hasCr(b));
  }
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
