#!/usr/bin/env node
/**
 * 每日图片站构建脚本
 *
 * 流程：扫描三个分类文件夹 -> ffmpeg 转 WebP(full + thumb) -> 生成 manifest -> 产出独立日期页
 *
 * 用法：
 *   node tools/build.mjs
 *   node tools/build.mjs --src "C:\Users\<user>\Downloads\2026-10-25"
 *   node tools/build.mjs --date 2026-10-25 --image-base /img
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fetchHeadlines, loadConfig } from './fetch-rss.mjs';
import { dedupeNewsItems } from './news-dedupe.mjs';
import { webpSize } from './webp.mjs';
import { runWithFormatFallback } from './media-fallback.mjs';
import { loadHeadlines } from './headlines.mjs';
import { markAuth } from './link-auth.mjs';
import { loadTaxonomy, classifyItem, orderCategories } from './news-taxonomy.mjs';
import { fetchRssImages } from './rss-images.mjs';
import { isMediaTab, isTextTab } from './tab-kinds.mjs';
import { composeOgImage, ogImageUrl } from './build-og.mjs';
import { buildFeedXml } from './build-feed.mjs';
import { makeLqipDataUris } from './build-lqip.mjs';
import {
  ROOT,
  R2_LOCAL,
  SRC_LOCAL,
  r2SearchRoots,
  srcSearchRoots,
  findLatestDatedDir,
  findDatedDir,
} from './paths.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------------------------------------------------------------- 配置 */

const TABS = [
  { dir: '见闻', key: 'jianwen', label: '见闻', quality: 86, accent: '#4a8cff' },
  { dir: '见她', key: 'jianshe', label: '见她', quality: 80, accent: '#ff6b9d' },
  // default: true —— 打开页面时默认落在这个 tab。
  //
  // 这里必须是「见笑」而不是「数量最多的分类」：
  // 分享策略是「发归档入口，让群友自己点 tab」，这样群友的第一眼是梗图而不是写真，
  // 举报冲动最低。但如果默认落点跟着数量走，哪天「见她」的照片比「见笑」多，
  // 第一眼就变成写真了 —— 而且不会有任何报错，很难察觉。
  { dir: '见笑', key: 'jianxiao', label: '见笑', quality: 84, accent: '#ffb020', default: true },
];

const FULL_MAX_W = 1080; // 全尺寸图最长边（宽度上限）
const THUMB_MAX_W = 400; // 缩略图宽度上限
const WEBP_QUALITY_FULL = 6; // libwebp compression_level 0-6
const WEBP_QUALITY_THUMB = 6;

/* 看片应有的五个大目录（2026-11-16 v3，用户拍板的顺序）。
 *
 * **为什么写死一份**：段名本来全来自数据（条目的 @1 标签），
 * 缺了源数据构建就少几段 —— 但光看「看片 440 条」根本看不出少了哪一档，
 * 而「看片只有 2 段」看着像网站坏了，不像「漏抓了一次数据」。
 * 写死这份清单，构建才能**点名**说缺了什么。
 *
 * ⚠️ 顺序 = 用户拍板的目录顺序（频道更新放第一个），
 * 别自己重排 —— 前端 chip 按数据出现顺序渲染，这份清单是唯一的核对基准。
 *
 * 护栏：tools/test-rank-tab.mjs 钉住这五个字面量和顺序，
 * tools/test-rank-tab-mutate.mjs 有「改掉一个段名」的变异盯着它。 */
const WATCH_SECTIONS = ['频道更新', '电影', 'B站热门', '抖音热门', '本地演出'];

// 源图位置不再写死 —— 走 tools/paths.mjs 的候选列表：
//   新：<IMAGE_ROOT>\src\<日期>\   （默认 ~/image-root\src）
//   旧：C:\Users\<user>\Downloads\<日期>\  （仍然认，保证挪盘前后行为一致）
/* 站点标题 —— 改标题只改这一行。
   它会出现在：页头 <h1>、浏览器标签页 <title>、微信分享卡片的 og:title、
   往期列表页的标题，以及 manifest 的 title 字段。
   （og:site_name 现在是模板变量 {{TITLE}}，不用再手改第二处。） */
const SITE_TITLE = '每日图片站';
const DEFAULT_SITE_URL = 'https://example.com';

/* ---------------------------------------------------------------- 参数 */

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--src') args.src = argv[++i];
    else if (a === '--date') args.date = argv[++i];
    else if (a === '--image-base') args.imageBase = argv[++i];
    else if (a === '--site-url') args.siteUrl = argv[++i];
    else if (a === '--no-convert') args.skipConvert = true;
    else if (a === '--no-rss') args.skipRss = true;
    else if (a === '--keep-manifest') args.keepManifest = true;
    else if (a === '--retag') args.retag = true;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--rss-images') args.rssImages = true;
    else if (a === '--no-rss-images') args.rssImages = false;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const args = parseArgs(process.argv);
if (args.help) {
  console.log(`每日图片站构建

  --src <dir>        源目录（含 见闻/见她/见笑 三个子目录），默认在候选根里找最新的日期目录
                     候选根：<IMAGE_ROOT>\\src  和  C:\\Users\\<user>\\Downloads（认旧路径）
  --date <YYYY-MM-DD>  日期，默认从源目录名推断
  --image-base <s>   图片 URL 前缀，默认 /img
  --site-url <s>    站点公开地址，用于 og: 分享卡片，默认 https://example.com
  --no-convert       跳过转码，只重建页面（复用已转好的图）
  --keep-manifest    沿用这一期已发布的 manifest（内容一个字都不改），只重建页面与前端资源
                     用在「只改样式/只改前端」的场景：见报内容是构建期实时抓的，
                     普通构建会顺手把内容换掉（RSS 在轮换），跟本次改动无关。
                     如果这一期的源图跟已发布的 manifest 对不上，构建会直接拒绝 ——
                     那说明图被动过，得走正常流程重新审稿。
  --retag           往期重分类：沿用这一期**已发布**的条目（含照片 tab），只按
                    news-taxonomy.json 重算见报的分类标签。内容一个字都不改。
                    用途：分类体系改了以后，把往期也统一过来（避免新旧两套分类并存）。
                    与 --keep-manifest 互斥（一个要重算分类，一个要原样沿用）。
                    旧 manifest 永远从工程里的 published/<日期>/ 读（**不跟 --out 走** ——
                    否则 --out 指到空目录，上哪儿读旧 manifest 去）；
                    产物写进 --out 指定的位置，不给就写回 published/<日期>/。
                    照片 tab 从旧 manifest 原样搬过来，**不转码、不碰源图**。
  --out <dir>        把产物写到这个目录，而不是工程里的 published/
                     **做试验一定要用它** —— published/ 是部署面，
                     在审稿台开着的时候往里重建，用户的「发布」会把你那份试验版一起推上线
                     （2026-11-11 出过这个事故，见 AGENTS.md 第 8 条硬约束）
  --rss-images       强制开/关见报配图（默认按 tools/rss-images.json 的 enabled）
  --no-rss-images
`);
  process.exit(0);
}

const imageBase = (args.imageBase ?? '/img').replace(/\/$/, '');
const siteUrl = (args.siteUrl || process.env.SITE_URL || DEFAULT_SITE_URL).replace(/\/$/, '');

/* ---------------------------------------------------------------- 工具 */

/**
 * 找 ffmpeg / ffprobe 的可执行文件。
 *
 * Windows 的候选顺序（PATH → winget → 常见手动安装路径）保持原样，
 * 只有两处跟着平台走：
 *   1. PATH 探测 —— Windows 用 `where`（cmd.exe 内建命令），
 *      macOS/Linux 用 `which`（那边根本没有 `where` 这东西）。
 *   2. 可执行文件名 —— Windows 是 xxx.exe，macOS/Linux 是 xxx（不带后缀）。
 * 顺带一提，winget 这条支线只在 Windows 有意义（Mac 上是 Homebrew / MacPorts），
 * 非 Windows 直接跳过。
 */
async function findBin(name) {
  const isWin = process.platform === 'win32';
  const candidates = [];
  // 1. PATH
  try {
    const { stdout } = isWin
      ? await execFileAsync('where', [name], { shell: 'cmd.exe' })
      : await execFileAsync('which', [name]);
    candidates.push(...stdout.split(/\r?\n/).filter(Boolean));
  } catch { /* not on PATH */ }
  // 2. winget 安装的 ffmpeg（Windows 独有）
  if (isWin) {
    const wingetRoot = path.join(
      process.env.LOCALAPPDATA || '',
      'Microsoft', 'WinGet', 'Packages',
    );
    try {
      for (const pkg of await fs.readdir(wingetRoot)) {
        if (!pkg.toLowerCase().includes('ffmpeg')) continue;
        const bin = path.join(wingetRoot, pkg, 'ffmpeg-9.0.2-full_build', 'bin', `${name}.exe`);
        candidates.push(bin);
      }
    } catch { /* no winget dir */ }
  }
  // 3. 常见手动安装路径
  if (isWin) {
    candidates.push(
      'C:\\Program Files\\ffmpeg\\bin',
      'C:\\ffmpeg\\bin',
      path.join(ROOT, 'tools', 'bin'),
    );
  } else {
    candidates.push(
      '/opt/homebrew/bin',        // Apple Silicon 上的 Homebrew
      '/usr/local/bin',           // Intel 上的 Homebrew
      '/opt/local/bin',           // MacPorts
      '/usr/bin',                 // 系统自带目录
      path.join(ROOT, 'tools', 'bin'),
    );
  }

  const exeName = isWin ? `${name}.exe` : name;
  for (const c of candidates) {
    /* c 要么已经是可执行文件的完整路径（where / which 给的就是这种），
     * 要么是个目录 —— 目录得再拼一个文件名。 */
    let exe;
    try {
      exe = (await fs.stat(c)).isFile() ? c : path.join(c, exeName);
    } catch {
      exe = path.join(c, exeName);
    }
    try {
      await fs.access(exe);
      return exe;
    } catch { /* keep looking */ }
  }
  throw new Error(isWin
    ? `找不到 ${name}.exe，请先安装 ffmpeg 并加入 PATH`
    : `找不到 ${name}，请先安装 ffmpeg 并加入 PATH（macOS 上用 brew install ffmpeg）`);
}

/**
 * ffmpeg / ffprobe 的「自动格式探测」偶尔会认不出某些源图 ——
 * 福利吧的图是「后缀 .gif、内容 JPEG」，336 张里会有一张挑不出解复用器。
 * 细节和实测数据见 tools/media-fallback.mjs（回退逻辑也住在那儿）。
 */
async function ffprobeSize(ffprobe, file) {
  const base = [
    '-v', 'quiet',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0:s=x',
  ];
  // 文件名是最后一个参数，下标 = base.length
  const r = await runWithFormatFallback(ffprobe, [...base, file], base.length, `读尺寸失败: ${file}`);
  if (r.fallback) {
    console.log(`  ! ${path.basename(file)} 格式探测失败，改用 image2pipe 硬解（能读出尺寸）`);
  }
  const [w, h] = String(r.stdout).trim().split('x').map(Number);
  if (!w || !h) throw new Error(`无法解析尺寸: ${file}`);
  return { w, h };
}

/**
 * 直接从 WebP 文件头读宽高，不起 ffprobe 进程。
 * 实现在 tools/webp.mjs（抽出来是为了能单独跑测试对比 ffprobe 的结果）。
 */

async function toWebP(ffmpeg, src, dest, targetW, targetH, quality) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const args = [
    '-y', '-loglevel', 'error',
    '-i', src,
    '-vf', `scale=${targetW}:${targetH}:flags=lanczos`,
    '-c:v', 'libwebp',
    '-quality', String(quality),
    '-compression_level', String(WEBP_QUALITY_FULL),
    '-frames:v', '1',
    dest,
  ];
  // '-i' 在第 3 位
  const r = await runWithFormatFallback(ffmpeg, args, 3, `转码失败: ${src}`);
  if (r.fallback) {
    console.log(`  ! ${path.basename(src)} 自动格式探测失败，改用 image2pipe 硬解`);
  }
}

/**
 * 转码 + 确认产物真的落盘了。
 *
 * 为什么要在转码之后再查一遍：
 *   ffmpeg 退出码是 0，不代表输出文件一定在（Windows 上偶发文件被占用、
 *   写入被吞的情况见过）。少一个缩略图，线上就是一个空白格子 ——
 *   而且 manifest 照样会写进去，构建日志照样报「成功」。
 *   所以：转完立刻 stat 一下，缺了就重转一次，还缺就报错停手。
 */
async function toWebPChecked(ffmpeg, src, dest, targetW, targetH, quality, label) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    await toWebP(ffmpeg, src, dest, targetW, targetH, quality);
    try {
      const st = await fs.stat(dest);
      if (st.size > 0) return st.size;
      console.warn(`  ! ${label} 转码后是空文件，重转（${attempt}/2）`);
    } catch {
      console.warn(`  ! ${label} 转码后文件不存在，重转（${attempt}/2）`);
    }
  }
  throw new Error(`转码产物缺失：${dest}`);
}

/**
 * 产物「能不能用」：**存在** 且 **是能读出尺寸的 WebP**。
 *
 * 为什么不能只查存不存在（2026-11-15 线上事故）：
 *   转码被中断会在母本里留下 0 字节的 WebP。`fs.access` 只看「在不在」，
 *   0 字节也算在 → --no-convert 把它当成可复用的产物 → 0 字节一路传到 R2 →
 *   线上代理照吐 HTTP 200 / Content-Length: 0 / Content-Type: image/webp →
 *   2026-11-14 归档页那一格是裂图（而且状态码 200，监控看不出来）。
 *   所以复用前必须真读一下文件头。
 *
 * 为什么用 webpSize 而不是自己解析：偏移写错一位不会报错，只会安静地给出错的宽高
 *   （tools/webp.mjs 的解析器有 test-webp.mjs 拿 ffprobe 逐个文件对答案）。
 *   它直接读字节、不起进程（微秒级），几百张图扫一遍不心疼。
 *
 * @returns {Promise<string|null>} null = 有效；字符串 = 出问题的原因（中文）
 */
async function productProblem(file) {
  let st;
  try {
    st = await fs.stat(file);
  } catch {
    return '不存在';
  }
  if (st.size === 0) return '是 0 字节的空文件';
  try {
    await webpSize(file);
  } catch (err) {
    // webpSize 的报错形如「WebP 文件过短: <路径>」—— 只取前半句，路径另处已经说了
    return `不是有效的 WebP（${String(err.message || '').split(':')[0]}）`;
  }
  return null;
}

/** 按宽度上限等比缩放，永不放大 */
function fit(w, h, maxW) {
  const f = Math.min(1, maxW / w);
  return { W: Math.max(1, Math.round(w * f)), H: Math.max(1, Math.round(h * f)) };
}

function pad(n) {
  return String(n).padStart(3, '0');
}

/**
 * 内容哈希（做缓存击穿，文件名随内容变）。
 *
 * 放在模块级：普通构建和 --retag 都要用它算 manifest / css / js 的文件名，
 * 两边算出同一个名字，页面引用才对得上。
 */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).slice(0, 8);
}

/**
 * 产物根目录：--out 指到别处，否则是工程里的 published/（部署面）。
 *
 * --out 做试验时**必须**用它 ——
 * published/ 是部署面，在审稿台开着的时候往里重建，
 * 用户的「发布」会把你那份试验版一起推上线（2026-11-11 出过这个事故）。
 */
function resolvePublishedRoot() {
  return args.out ? path.resolve(args.out) : path.join(ROOT, 'published');
}

/**
 * 按模板渲染页面（占位符替换）。
 *
 * 同一套模板要出现在两个地方，路径深度不同：
 *   published/<date>/index.html  —— 某天的永久链接（资源 ../assets，首页入口 ../archive/）
 *   published/index.html         —— 根路径 = 今天（资源 assets，首页入口 archive/）
 * 所以所有随深度变化的路径都走占位符，不在模板里写死。
 */
function renderPage(template, v) {
  return template
    .replaceAll('{{PAGE_TITLE}}', v.pageTitle)
    .replaceAll('{{PAGE_DESC}}', v.pageDesc)
    .replaceAll('{{OG_URL}}', v.ogUrl)
    // 分享卡片的三件套：图片本身 + 它的真实宽高。
    // 宽高要跟着实际产物走 —— 分享图合成失败退回 logo 时是 640x640，
    // 写死成 1200x630 会让某些爬虫按错的宽高渲染。
    .replaceAll('{{OG_IMAGE}}', v.ogImage)
    .replaceAll('{{OG_IMAGE_W}}', v.ogImageW)
    .replaceAll('{{OG_IMAGE_H}}', v.ogImageH)
    .replaceAll('{{ASSET_BASE}}', v.assetBase)
    .replaceAll('{{HOME}}', v.home)
    .replaceAll('{{DATE}}', v.date)
    .replaceAll('{{TITLE}}', v.title)
    .replaceAll('{{SITE_URL}}', v.siteUrl)
    .replaceAll('{{CSS}}', v.cssHref)
    .replaceAll('{{JS}}', v.jsSrc)
    .replaceAll('{{MANIFEST}}', v.manifestSrc);
}

/* ------------------------------------------------------------ 已转码产物回退 */

/**
 * 找出本地已经构建过（有已转码产物）的最新日期。
 *
 * 用途：原图被清理之后，靠它定位「上一次发的是哪一期」。
 * 母本目录可能有两处（新的 IMAGE_ROOT\r2 和旧的工程内 r2/），都扫。
 */
async function latestBuiltDate() {
  const dirs = new Set();
  const bases = [...r2SearchRoots(), path.join(ROOT, 'published', 'img')];
  for (const base of bases) {
    try {
      for (const d of await fs.readdir(base, { withFileTypes: true })) {
        if (d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name)) dirs.add(d.name);
      }
    } catch {
      /* 目录不存在 */
    }
  }
  const list = [...dirs].sort();
  return list.length ? list[list.length - 1] : null;
}

/**
 * 源目录缺失时，从已经转好的 webp 重建一个 tab 的 manifest。
 *
 * 为什么需要：发完一版把原图清掉是常见习惯，但「只改 RSS 重新发一版」
 * 这种日常操作不该被原图缺失卡死 —— 图还在，尺寸量一下就能用。
 *
 * 产物文件名自带随机段（<nonce>_<序号>.webp / <nonce>_<序号>_t.webp），
 * 而 URL 里用的就是这个文件名，所以重建出来的 URL 和原来完全一致：
 * 已经发出去的链接不会因为重新构建而失效。
 */
async function rebuildTabFromConverted(destDir, tab, imageBase, date) {
  let names = [];
  try {
    names = await fs.readdir(destDir);
  } catch {
    return null;
  }

  const fullMap = new Map();
  const thumbMap = new Map();
  for (const n of names) {
    let m = /^([0-9a-f]{10})_(\d{3})\.webp$/.exec(n);
    if (m) {
      fullMap.set(m[2], n);
      continue;
    }
    m = /^([0-9a-f]{10})_(\d{3})_t\.webp$/.exec(n);
    if (m) thumbMap.set(m[2], n);
  }
  if (!fullMap.size) return null;

  const ids = [...fullMap.keys()].sort((a, b) => Number(a) - Number(b));
  const items = [];
  for (const id of ids) {
    const fullName = fullMap.get(id);
    const thumbName = thumbMap.get(id);
    // 缺缩略图就跳过：页面首屏用的是缩略图，缺了会出现空格子
    if (!thumbName) continue;
    const dim = await webpSize(path.join(destDir, fullName));
    const td = await webpSize(path.join(destDir, thumbName));
    items.push({
      id: `${tab.key}_${id}`,
      w: dim.w,
      h: dim.h,
      tw: td.w,
      th: td.h,
      thumb: `${imageBase}/${date}/${tab.key}/${thumbName}`,
      full: `${imageBase}/${date}/${tab.key}/${fullName}`,
    });
  }
  if (!items.length) return null;

  return {
    key: tab.key,
    label: tab.label,
    accent: tab.accent,
    count: items.length,
    items,
  };
}

/* ---------------------------------------------------------------- 随机盐 */

/**
 * 图片 URL 里的「不可猜段」。
 *
 * 为什么需要：只把 manifest 拆成外部 JS 是不够的 —— 爬虫虽然从 HTML 里
 * 发现不了图片路径，但 /img/<日期>/<分类>/<序号>.webp 这个规律是完全可猜的，
 * 只要知道日期和分类名，490 次请求就能把当天所有图片全抓走
 * （实测：猜 /img/2026-10-25/jianshe/001.webp 直接 200）。
 *
 * 做法：在 URL 里插一段由「持久化随机盐 + 分类 + 序号」算出来的十六进制段，
 * 代理剥掉它再去找 R2 / 静态资源。
 *
 * 关键设计：R2 和 published/img 里的**文件名完全不变**（还是 001.webp），
 * 只有 URL 变了。所以：
 *   - 撤回逻辑不受影响（删 r2/<日期>/<分类>/ 整目录就行）
 *   - upload-r2 / stage-static 一行都不用改
 *   - 盐丢了也不要紧：R2 文件名没变，老页面照样能看，只是新 URL 与旧的不同
 */
const SALT_FILE = path.join(ROOT, '.img-salt');

let saltCache = null;

async function getSalt() {
  if (saltCache) return saltCache;
  try {
    const s = (await fs.readFile(SALT_FILE, 'utf8')).trim();
    if (s) {
      saltCache = s;
      return s;
    }
  } catch {
    /* 没有就新建 */
  }
  saltCache = crypto.randomBytes(16).toString('hex');
  await fs.writeFile(SALT_FILE, saltCache + '\n', 'utf8');
  console.log(`  已生成新的图片随机盐：${SALT_FILE}`);
  console.log('  ⚠ 这个文件请留好 —— 删掉它会让新生成的图片 URL 全部改变');
  return saltCache;
}

/**
 * 图片 URL 里的「不可猜段」。
 *
 * 为什么不是「按位置」算（salt|tabKey|序号）：
 *   按位置算的话，清洗掉第 1 张图后，第 2 张会前移到位置 1，
 *   但它的 nonce 不变 —— URL 没变，边缘缓存里还留着旧内容。
 *   实测过：删图后线上返回的是「上一张图」的内容，
 *   cf-cache-status: HIT，Age 8400 秒，R2 里数据是对的但缓存没刷新。
 *
 *   而且用户已经把带旧图的链接发到群里了，那种链接必须立刻失效、
 *   换成新图 —— 靠「位置」做不到这件事。
 *
 * 改成按「内容」算：
 *   nonce = sha256(salt|tabKey|文件名|文件内容哈希)
 *   内容变了 -> 随机段变了 -> URL 变了 -> 边缘缓存自然失效（新的 key）。
 *   内容没变（比如只改了 RSS 配置重新发一版）-> URL 不变 -> 缓存继续命中，不浪费流量。
 *
 * 顺带的好处：同一张图重复出现也不会撞名。
 */
async function nonceFor(salt, tabKey, id, filePath) {
  let contentHash = '';
  try {
    const st = await fs.stat(filePath);
    const h = crypto.createHash('sha256');
    // 只读文件前 64KB + 大小：够区分不同的图，又不用把整张读完
    const buf = await fs.readFile(filePath);
    h.update(buf.subarray(0, 65536));
    h.update(String(st.size));
    contentHash = h.digest('hex').slice(0, 16);
  } catch {
    contentHash = 'nofile';
  }
  return crypto
    .createHash('sha256')
    .update(`${salt}|${tabKey}|${id}|${contentHash}`)
    .digest('hex')
    .slice(0, 10);
}

/* ---------------------------------------------------------------- 本地封面本地化 */

/**
 * 本地封面在 R2 母本里的类别目录名。
 *
 * 为什么封面也必须套用**现有的产物命名**（<10位随机段>_<3位序号>.webp）：
 *   R2 那条管道上到处都写死了这个格式 ——
 *     · tools/upload-r2.mjs 只上传符合 PRODUCT_RE 的文件
 *     · functions/img/[[path]].js 的代理只放行这个格式
 *     · tools/orphan-clean.mjs / tools/r2-prune.mjs 只认这个格式
 *   封面要是换个命名（比如 <hash>.jpg），上传时会被跳过、代理会 404、
 *   r2-prune 还会把它当垃圾删掉 —— 三处都得改，改漏一处线上就裂图。
 *   所以这里直接把封面**改名成产物格式**，整条管道一点都不用动。
 */
const COVER_CATEGORY = 'covers';
/** 封面最长边（像素）。榜单里封面只显示 56~160px，留 300 够 retina。 */
const COVER_MAX_EDGE = 300;
const COVER_QUALITY = 80;

/**
 * 封面转码：等比缩到最长边，不裁剪、不变形。
 *
 * 为什么不用 toWebPChecked：那个函数是 scale=W:H —— 强制拉成目标尺寸。
 * 电影海报是 2:3、豆瓣演出海报是 175x260，拉成正方形会把人拉胖。
 * 这里用 force_original_aspect_ratio=decrease，只缩不裁。
 */
async function toWebPCover(ffmpeg, src, dest, label) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const args = [
    '-y', '-loglevel', 'error',
    '-i', src,
    '-vf',
    `scale=${COVER_MAX_EDGE}:${COVER_MAX_EDGE}:force_original_aspect_ratio=decrease:flags=lanczos`,
    '-c:v', 'libwebp',
    '-quality', String(COVER_QUALITY),
    '-compression_level', String(WEBP_QUALITY_FULL),
    '-frames:v', '1',
    dest,
  ];
  const r = await runWithFormatFallback(ffmpeg, args, 3, `封面转码失败: ${label}`);
  if (r.fallback) console.log(`  ! ${label} 格式探测失败，改用 image2pipe 硬解`);
  const st = await fs.stat(dest);
  if (!st.size) throw new Error('转码产物是空文件');
  return st.size;
}

/**
 * 封面产物文件名 —— <10位随机段>_<3位序号>.webp。
 *
 * 随机段按**内容**算，不按位置：跟图片产物一个道理 ——
 * 位置一变（条目排序变了）URL 就变，边缘缓存里留着的旧内容会被继续命中；
 * 按内容算的话，封面内容没变 URL 就不变，缓存继续命中。
 * 序号同样从内容哈希里取，不随列表顺序变。
 */
async function coverProductName(salt, rel, filePath, used) {
  let contentHash = 'nofile';
  try {
    const st = await fs.stat(filePath);
    const buf = await fs.readFile(filePath);
    const h = crypto.createHash('sha256');
    h.update(buf.subarray(0, 65536));
    h.update(String(st.size));
    contentHash = h.digest('hex').slice(0, 16);
  } catch {
    /* 读不到就按 nofile 算，名字照样唯一 */
  }

  const digest = crypto
    .createHash('sha256')
    .update(`${salt}|cover|${rel}|${contentHash}`)
    .digest('hex');
  const nonce = digest.slice(0, 10);
  let seq = parseInt(digest.slice(10, 14), 16) % 1000;
  let name = `${nonce}_${String(seq).padStart(3, '0')}.webp`;
  /* 万一撞名（哈希碰撞）：换个序号重试 —— 两个封面共用一个文件就是错图 */
  let guard = 0;
  while (used.has(name)) {
    seq = (seq + 1) % 1000;
    name = `${nonce}_${String(seq).padStart(3, '0')}.webp`;
    if (++guard > 999) throw new Error('封面命名撞名太多次');
  }
  used.add(name);
  return name;
}

/**
 * 把「local:」开头的封面变成站内可访问的路径。
 *
 * 背景：豆瓣图床对**不带 Referer** 的请求一律返回 418（2026-11-16 实测，
 * 给不给 UA 都一样）。浏览器 <img> 带的是本站域名 —— 生产环境也救不了，
 * 所以豆瓣封面必须自己存。
 *
 * 抓取端（fetch-follow.mjs）用带 Referer 的请求把封面**下载到本地**，
 * manifest 里只留一个 local:<相对路径> 标记；
 * 这里在构建期转成 WebP 存进 R2 母本，再换成 /img/<日期>/covers/... 的站内路径。
 *
 * 远程 URL（猫眼、B站、网易云…）原样保留 —— 它们不查 Referer，热链没问题。
 *
 * 失败只降级（这条没封面），不抛 —— 一张封面不该让整期构建失败。
 */
async function localizeCovers(items, opts) {
  const { ffmpeg, salt, date, r2Dir, imageBase, usedNames } = opts;
  const out = [];
  let localized = 0;
  let failed = 0;

  for (const it of items) {
    const raw = typeof it.cover === 'string' ? it.cover : '';
    if (!raw) { out.push({ ...it, cover: '' }); continue; }
    if (raw.indexOf('local:') !== 0) { out.push({ ...it, cover: raw }); continue; }

    const rel = raw.slice(6).replace(/\\/g, '/');
    if (!rel || rel.includes('..') || path.isAbsolute(rel)) {
      console.warn(`  ! 封面标记格式不对，跳过：${raw}`);
      out.push({ ...it, cover: '' });
      failed++;
      continue;
    }
    const src = path.join(SRC_LOCAL, date, ...rel.split('/'));
    try {
      const st = await fs.stat(src);
      if (!st.size) throw new Error('本地封面是空文件');
      const name = await coverProductName(salt, rel, src, usedNames);
      const dest = path.join(r2Dir, COVER_CATEGORY, name);
      let have = false;
      try { have = (await fs.stat(dest)).size > 0; } catch { have = false; }
      if (!have) await toWebPCover(ffmpeg, src, dest, rel);
      out.push({ ...it, cover: `${imageBase}/${date}/${COVER_CATEGORY}/${name}` });
      localized++;
    } catch (err) {
      console.warn(`  ! 封面本地化失败（${rel}）：${err.message} —— 这条先没有封面`);
      out.push({ ...it, cover: '' });
      failed++;
    }
  }
  return { items: out, localized, failed };
}

/**
 * 榜单/追更条目的 manifest 字段（**9 个**，顺序固定）。
 *
 * tags 是第 9 个字段：层级标签数组，格式 '@<层号>:<值>'
 *   @1 = 板块（全部 / 频道更新 / 本地演出 / 电影 / B站热门 / 抖音热门 / 中文榜 …）
 *   @2 = 分类（平台 / 城市 / 榜单名 …）
 *   @3 = 细分（语言 / 行政区 …）
 *   @4 = 类型（演出类型 …）
 *
 * 为什么值里**不能有空格**：前端靠 data-tags（空格分隔）拆标签，
 * 值里带空格会被拆成两半，筛选就废了。抓取端要保证这一点。
 */
/**
 * 把 tags 数组摊平、去重。
 *
 * 抓取端要是写成 '@1:中文榜|@1:国际榜' 这种串在一格里的形式，
 * 这里拆开 —— 拆完前端就能当成两个独立的层级取值。
 * 顺带去重：同一条内容重复挂同一个标签没有意义。
 */
function flattenTags(tags) {
  const flat = [];
  for (const t of Array.isArray(tags) ? tags : []) {
    if (typeof t !== 'string' || !t) continue;
    for (const part of t.split('|')) {
      const p = part.trim();
      if (p && flat.indexOf(p) < 0) flat.push(p);
    }
  }
  return flat;
}

/**
 * 榜单/追更条目的 manifest 字段（**9 个**，顺序固定）。
 *
 * tags 是第 9 个字段：层级标签数组，格式 '@<层号>:<值>'
 *   @1 = 板块（全部 / 频道更新 / 本地演出 / 电影 / B站热门 / 抖音热门 / 中文榜 …）
 *   @2 = 分类（平台 / 城市 / 榜单名 …）
 *   @3 = 细分（语言 / 行政区 …）
 *   @4 = 类型（演出类型 …）
 *
 * ⚠️ 值里**可以有空格**（平台名 Prime Video、语言 English）——
 * 前端用 JSON 编码这些标签，不是空格分隔，所以不受影响。
 */
function rankItem(it) {
  return {
    rank: it.rank,
    title: it.title || '',
    subtitle: it.subtitle || '',
    meta: it.meta || '',
    cover: it.cover || '',
    link: it.link || '',
    source: it.source || '',
    tag: it.tag || '',
    tags: flattenTags(it.tags),
  };
}

/**
 * 从条目的层级标签里取出「第 1 层（板块）」的取值，做成 chip。
 *
 * 只给「条目没有 tags 的旧 manifest」兜底用 ——
 * 新前端的 chip 是从条目现推的（换城市、换平台都不用改前端），
 * 这份只是旧 manifest 走兼容路径时不让 chip 整排消失。
 *
 * ⚠️ 值里不能有空格：前端靠空格分隔 data-tags，值里带空格会被拆坏。
 */
function level1Chips(items) {
  const seen = new Set();
  const out = [];
  for (const it of items || []) {
    for (const t of flattenTags(it && it.tags)) {
      if (t.indexOf('@1:') !== 0) continue;
      const v = t.slice(3);
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push({ tag: v, label: v });
    }
  }
  /* 兜底：条目**没有**层级标签时（旧的追更数据），
     退回按 tag 去重 —— 旧数据的 tag 语义正好就是那一层
     （剧集更新的 tag = '剧集更新'，演出的 tag = 城市名）。
     不兜底的话旧数据会得到一个空 chips，
     前端走兼容路径时整排 chip 都不出现。 */
  if (!out.length) {
    for (const it of items || []) {
      const v = (it && it.tag) || '';
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push({ tag: v, label: v });
    }
  }
  return out;
}

/* ---------------------------------------------------------------- manifest 读写 */

/**
 * 读出某一期已生成的 manifest；还没生成过就返回 null。
 *
 * 文件形如 window.__DAILY_MANIFEST__={...};
 */
async function readManifestFile(dir) {
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  const name = names.find((n) => /^manifest\..*\.js$/.test(n));
  if (!name) return null;
  try {
    const raw = await fs.readFile(path.join(dir, name), 'utf8');
    const i = raw.indexOf('=');
    if (i < 0) return null;
    return JSON.parse(raw.slice(i + 1).replace(/;\s*$/, '').trim());
  } catch {
    return null;
  }
}

/**
 * 读出某个指定的 manifest 文件。
 *
 * 和 readManifestFile 的区别：那个按 readdir 顺序挑「第一个」manifest.*.js，
 * 这个认准文件名 —— --retag 必须读**页面正在引用的那一个**，
 * 不然目录里一旦有残留文件，读到的就未必是线上在加载的那份。
 */
async function readManifestPath(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const i = raw.indexOf('=');
    if (i < 0) return null;
    return JSON.parse(raw.slice(i + 1).replace(/;\s*$/, '').trim());
  } catch {
    return null;
  }
}

/**
 * 找出这一期**真正在加载**的 manifest 文件名。
 *
 * index.html 里 <script src="manifest.xxx.js"> 指的那个才是线上生效的；
 * 对不上（页面被手改过 / 没有 index.html）就退回第一个，跟 readManifestFile 的老行为一致。
 */
async function findLiveManifestName(dir) {
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  const manifests = names.filter((n) => /^manifest\..*\.js$/.test(n)).sort();
  if (!manifests.length) return null;
  try {
    const html = await fs.readFile(path.join(dir, 'index.html'), 'utf8');
    const m = html.match(/manifest\.[A-Za-z0-9]+\.js/);
    if (m && manifests.includes(m[0])) return m[0];
  } catch {
    /* 没有 index.html */
  }
  return manifests[0];
}

/**
 * 比对两版的「图片 tab」是否完全一致（见报不算 —— 那是内容，不是图片）。
 *
 * --keep-manifest 的意义是「只改前端、内容一个字都不动」。
 * 所以图片一旦变了就必须拒绝：那说明这一期在审完之后被动过（删过/移过图），
 * 继续沿用旧 manifest 会让线上挂出跟审稿结论不符的内容 ——
 * 更糟的是 build.mjs 开头会先清空 published/<日期>/，失败了就只剩半个目录。
 */
function diffImageTabs(oldM, newM) {
  const diffs = [];
  const oldTabs = (oldM.tabs || []).filter(isMediaTab);
  const newTabs = (newM.tabs || []).filter(isMediaTab);
  if (oldTabs.length !== newTabs.length) {
    diffs.push(`tab 数：${oldTabs.length} -> ${newTabs.length}`);
  }
  for (const nt of newTabs) {
    const ot = oldTabs.find((t) => t.key === nt.key);
    if (!ot) {
      diffs.push(`新增 tab ${nt.key}`);
      continue;
    }
    if (ot.count !== nt.count) diffs.push(`${nt.key} 张数：${ot.count} -> ${nt.count}`);
    const oItems = new Map((ot.items || []).map((i) => [i.id, i]));
    for (const it of nt.items || []) {
      const oi = oItems.get(it.id);
      if (!oi) {
        diffs.push(`${nt.key} 多了一张 ${it.id}`);
        continue;
      }
      if (oi.full !== it.full || oi.thumb !== it.thumb) {
        diffs.push(`${nt.key}/${it.id} 图片地址变了`);
      } else if (oi.w !== it.w || oi.h !== it.h || oi.tw !== it.tw || oi.th !== it.th) {
        diffs.push(`${nt.key}/${it.id} 尺寸变了`);
      }
    }
    for (const id of oItems.keys()) {
      if (!(nt.items || []).some((i) => i.id === id)) diffs.push(`${nt.key} 少了一张 ${id}`);
    }
  }
  return diffs;
}

/* ---------------------------------------------------------------- --retag */

/**
 * 往期重分：只按新 taxonomy 重算见报条目的分类标签，别的什么都不改。
 *
 * 为什么单独一条路（不跟普通构建合流）：
 *   普通构建要扫源图、转码、重新抓 RSS —— 那三件事都会改内容。
 *   往期重分的前提恰恰是「一个字节都不改」，所以这里：
 *     · 不找源图目录（往期的源图早被清掉了）
 *     · 不转码（照片 tab 直接从旧 manifest 原样搬过来）
 *     · 不抓 RSS（条目直接从旧 manifest 搬过来）
 *
 * 旧 manifest 的来源是**工程里的 published/<日期>/**，永远不跟 --out 走 ——
 * 否则用 --out 做试验时根本读不到旧 manifest（--out 指到空目录，上哪儿读去）。
 */
async function runRetag() {
  const t0 = Date.now();

  if (args.keepManifest) {
    throw new Error('--retag 与 --keep-manifest 互斥：一个要重算分类，一个要原样沿用');
  }

  const date = args.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('--retag 必须用 --date 指定要重分的期数（YYYY-MM-DD）');
  }

  const publishedRoot = resolvePublishedRoot();
  const srcDir = path.join(ROOT, 'published', date); // 旧 manifest 的唯一来源
  const outDir = path.join(publishedRoot, date); // 产物写这儿

  console.log(`重分期数  : ${date}`);
  console.log(`旧 manifest: ${srcDir}`);
  console.log(`输出      : ${outDir}`);
  console.log('');

  const taxonomy = loadTaxonomy(ROOT);

  /* --- 读旧 manifest --- */
  const oldName = await findLiveManifestName(srcDir);
  if (!oldName) {
    throw new Error(
      `--retag 需要这一期已发布的 manifest，但 ${srcDir} 里没有。\n` +
        '  没有已发布产物就没法「沿用」，直接拒绝（不猜、不退化成普通构建）。'
    );
  }
  const oldManifest = await readManifestPath(path.join(srcDir, oldName));
  if (!oldManifest) {
    throw new Error(`读不出 ${path.join(srcDir, oldName)} 的内容（JSON 解析失败？）`);
  }

  const oldTabs = Array.isArray(oldManifest.tabs) ? oldManifest.tabs : [];
  const oldNews = oldTabs.find((t) => t.key === 'news');
  if (!oldNews || !Array.isArray(oldNews.items) || !oldNews.items.length) {
    throw new Error(`旧 manifest（${oldName}）里没有见报条目 —— 没有条目可重分，拒绝执行`);
  }

  /* --- 预校验：源没配分类就抛错（在做任何写操作之前）---
     「源没配分类」是最常见的接线错误：加了个新源，忘了在 taxonomy 里配。
     静默归到「其它」会让人以为分类没问题，其实是新源漏配了 —— 所以响亮地失败。 */
  const sources = [...new Set(oldNews.items.map((it) => it.source).filter(Boolean))];
  const missing = sources.filter((s) => !taxonomy.sourceCategory[s]);
  if (missing.length) {
    throw new Error(
      `见报源「${missing.join('、')}」没有配分类（news-taxonomy.json 的 sourceCategory 缺这一项）。\n` +
        `  配了才能重分 —— 分类配错会静默发错内容，不降级。\n` +
        `  已配的源：${Object.keys(taxonomy.sourceCategory).join('、')}`
    );
  }

  /* --- 重算分类 ---
     内容零改动：只覆盖 tag / tags 两个字段，其余字段连顺序都照旧
     （展开旧对象再覆盖同名键 —— 键的位置不变）。 */
  const newsItems = oldNews.items.map((it) => {
    const c = classifyItem(it, taxonomy);
    return { ...it, tag: c.tag, tags: c.tags };
  });

  const cats = orderCategories(taxonomy, newsItems);
  const ordered = cats.map((c) => c.label);

  // 照片 tab 原样沿用；见报 tab 只换 items / tags / count，其余字段（label/accent/type）照旧
  const newTabs = oldTabs.map((t) =>
    t.key === 'news' ? { ...t, count: newsItems.length, tags: ordered, items: newsItems } : t
  );
  const newManifest = { ...oldManifest, generatedAt: new Date().toISOString(), tabs: newTabs };

  console.log(
    `  · 沿用已发布的 manifest（${oldName}，生成于 ${oldManifest.generatedAt}，${oldTabs.length} 个 tab）`
  );
  console.log(`  · 见报 ${newsItems.length} 条，只重算分类标签`);

  /* --- 写产物 ---
     顺序很重要：先写新 manifest -> 确认写成功 -> 再删旧 manifest -> 最后改页面引用。
     反过来的话中途失败就只剩半个目录（线上已验过的产物弄不回来）。 */
  const manifestJson = JSON.stringify(newManifest).replace(/</g, '\\u003c');
  const manifestName = `manifest.${hash(manifestJson)}.js`;

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(
    path.join(outDir, manifestName),
    `window.__DAILY_MANIFEST__=${manifestJson};`,
    'utf8'
  );
  console.log(`  ✓ 新 manifest 已写入：${path.join(outDir, manifestName)}`);

  /* --- index.html ---
     已经有 index.html 就只改 manifest 的文件名（别的字节一律不动 ——
     页面壳是上线时审过的，重分不该顺手把它换成新版）；
     没有（--out 指到空目录）才按模板渲染一份完整的。 */
  const htmlPath = path.join(outDir, 'index.html');
  let html = null;
  try {
    html = await fs.readFile(htmlPath, 'utf8');
  } catch {
    html = null;
  }
  if (html && oldName !== manifestName && html.includes(oldName)) {
    await fs.writeFile(htmlPath, html.split(oldName).join(manifestName), 'utf8');
    console.log(`  · index.html：只改了 manifest 引用（${oldName} -> ${manifestName}）`);
  } else if (html && oldName === manifestName) {
    console.log('  · index.html：manifest 文件名没变，页面不用改');
  } else {
    const template = await fs.readFile(path.join(ROOT, 'site', 'template.html'), 'utf8');
    const css = await fs.readFile(path.join(ROOT, 'site', 'app.css'), 'utf8');
    const js = await fs.readFile(path.join(ROOT, 'site', 'app.js'), 'utf8');
    const cssName = `app.${hash(css)}.css`;
    const jsName = `app.${hash(js)}.js`;
    const dateCn = date.replace(
      /^(\d{4})-(\d{2})-(\d{2})$/,
      (_, _y, mm, dd) => `${Number(mm)}月${Number(dd)}日`
    );
    const dayHtml = renderPage(template, {
      pageTitle: `${SITE_TITLE} · ${date}`,
      pageDesc: `${dateCn} · 见闻 · 见她 · 见笑，每日一阅。`,
      ogUrl: `${siteUrl}/${date}/`,
      assetBase: '../assets',
      home: '../archive/',
      date,
      title: SITE_TITLE,
      siteUrl,
      cssHref: cssName,
      jsSrc: jsName,
      manifestSrc: manifestName,
    });
    await fs.writeFile(htmlPath, dayHtml, 'utf8');
    await fs.writeFile(path.join(outDir, cssName), css, 'utf8');
    await fs.writeFile(path.join(outDir, jsName), js, 'utf8');
    console.log('  · index.html：这一期原来没有页面，按模板渲染了一份');
  }

  /* --- 删掉旧 manifest ---
     必须删：readManifestFile 按 readdir 顺序找第一个 manifest.*.js，
     留两个的话「线上加载的是哪个」就变成不确定的事了。 */
  for (const n of await fs.readdir(outDir)) {
    if (!/^manifest\..*\.js$/.test(n) || n === manifestName) continue;
    await fs.rm(path.join(outDir, n), { force: true });
    console.log(`  · 删掉旧 manifest：${n}`);
  }

  /* --- 根路径页面 ---
     published/index.html 引用的是「最新一期」的 manifest。
     只有当它引用的正是这一期的旧 manifest 时才跟着改 —— 否则根页面不该动。 */
  try {
    const rootHtml = await fs.readFile(path.join(publishedRoot, 'index.html'), 'utf8');
    if (oldName !== manifestName && rootHtml.includes(oldName)) {
      await fs.writeFile(
        path.join(publishedRoot, 'index.html'),
        rootHtml.split(oldName).join(manifestName),
        'utf8'
      );
      console.log(`  · 根路径页面：manifest 引用已更新（${oldName} -> ${manifestName}）`);
    }
  } catch {
    /* 没有根页面（--out 指到空目录）就无所谓 */
  }

  printRetagDiff(oldNews.items, newsItems);
  console.log('');
  console.log(`产物目录  : ${outDir}`);
  console.log(`耗时      : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

/**
 * 打印重分前后的分类分布对比 —— 一眼看出重分生效了。
 */
function printRetagDiff(beforeItems, afterItems) {
  const dist = (items) => {
    const m = new Map();
    for (const it of items) m.set(it.tag, (m.get(it.tag) || 0) + 1);
    return m;
  };
  const before = dist(beforeItems);
  const after = dist(afterItems);
  const labels = [...new Set([...before.keys(), ...after.keys()])];
  // 中文按两列宽算，不然表格会歪
  const width = (s) => [...s].reduce((n, c) => n + (/[\u2e80-\uffef]/.test(c) ? 2 : 1), 0);
  const padL = (s, n) => ' '.repeat(Math.max(0, n - width(s))) + s;
  const padR = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));

  console.log('');
  console.log('──────────── 分类分布 前后对比 ────────────');
  console.log(`${padR('分类', 14)}${padL('重分前', 8)}${padL('重分后', 8)}`);
  for (const l of labels) {
    console.log(
      `${padR(l, 14)}${padL(String(before.get(l) || 0), 8)}${padL(String(after.get(l) || 0), 8)}`
    );
  }
  let changed = 0;
  for (let i = 0; i < afterItems.length; i++) {
    if (beforeItems[i] && beforeItems[i].tag !== afterItems[i].tag) changed++;
  }
  console.log('');
  console.log(`条目数 : ${beforeItems.length} -> ${afterItems.length}（主分类变了的 ${changed} 条）`);
}

/* ---------------------------------------------------------------- 主流程 */

async function main() {
  const t0 = Date.now();

  /* --- --retag：往期重分，走独立分支 ---
     必须在下面所有流程之前分流：
       · 不找源图目录（往期的源图早被清掉了）
       · 不转码（照片 tab 从旧 manifest 原样搬）
       · 不走 fs.rm(publishedDir) 那一段（那会把已验过的产物删掉）
     旧 manifest 的来源永远是工程里的 published/<日期>/，不跟 --out 走。 */
  if (args.retag) {
    await runRetag();
    return;
  }

  // --- 定位源目录 ---
  //
  // 原图会被清理（发完一版删掉源图是常见习惯），所以这里必须有回退路径：
  // 找不到源目录时不报错退出，而是回到「已转码产物」那一期，
  // 从母本目录里把尺寸量回来重建 manifest。
  // 否则「只改 RSS 重新发一版」会被原图缺失直接卡死。
  //
  // 源目录在多个候选根里找（新的 IMAGE_ROOT\src 和旧的 Downloads），
  // 谁有日期目录就用谁 —— 挪盘前后的行为完全一致。
  const srcRoots = srcSearchRoots();
  let srcRoot = args.src;
  if (!srcRoot) {
    // 给了 --date 就优先用它去找同名目录 ——
    // 否则「页面日期」和「实际读的源目录」可能不是同一个日期，
    // 结果是页面写着 10-26，图却是 10-25 的。
    const dated = args.date ? findDatedDir(srcRoots, args.date) : findLatestDatedDir(srcRoots);
    if (dated) {
      srcRoot = dated;
    } else {
      const built = await latestBuiltDate();
      if (!built) {
        throw new Error(
          `没有找到源图目录。试过：\n` +
            srcRoots.map((r) => `  ${r}`).join('\n') +
            `\n请把图片放进 <根目录>\\<YYYY-MM-DD>\\{见闻,见她,见笑}，或用 --src 指定。`
        );
      }
      srcRoot = path.join(R2_LOCAL, built);
      console.log(`  ! 未找到源图目录，改用已构建过的 ${built} 重建`);
    }
  }
  srcRoot = path.resolve(srcRoot);

  const date = args.date || path.basename(srcRoot);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`无法推断日期（目录名 "${path.basename(srcRoot)}" 不含 YYYY-MM-DD），请用 --date 指定`);
  }

  /* --- 产物根目录 ---
     默认是工程里的 published/，也就是**部署面**。
     --out 可以指到别处 —— 做试验时必须用它，
     否则试验产物会混进部署面，被用户的「发布」一起推上线。 */
  const publishedRoot = resolvePublishedRoot();
  const publishedDir = path.join(publishedRoot, date);

  console.log(`源目录 : ${srcRoot}`);
  console.log(`日期   : ${date}`);
  console.log(`输出   : ${publishedDir}`);
  console.log('');

  const ffmpeg = await findBin('ffmpeg');
  const ffprobe = await findBin('ffprobe');
  console.log(`ffmpeg : ${ffmpeg}`);

  /* --- 分类配置 ---
     提前加载：配置写错要在构建开头就报，而不是等到拼 manifest 时才炸。
     加载失败直接抛错中止 —— 分类配错会静默发错内容，不能降级。 */
  const taxonomy = loadTaxonomy(ROOT);

  /* --- 见报配图配置 ---
     enabled=false 时，下面整段配图逻辑直接跳过，构建结果跟没有这个功能一模一样。
     配图是**可选增强**，不是见报的前提 —— 所以它的开关独立于其它任何配置。 */
  let rssImgCfg = null;
  try {
    rssImgCfg = JSON.parse(
      await fs.readFile(path.join(ROOT, 'tools', 'rss-images.json'), 'utf8'),
    );
  } catch {
    rssImgCfg = null;
  }
  // 命令行开关优先于配置文件 —— 试验时用 --rss-images 打开，
  // 不用去改配置文件（改完还得记得改回来）。
  if (rssImgCfg && typeof args.rssImages === 'boolean') {
    rssImgCfg.enabled = args.rssImages;
  }

  const r2Dir = path.join(R2_LOCAL, date);

  /* 封面产物文件名占位表 —— 榜单和追更共用一份，
     免得两个 tab 各自算出来的名字撞在一起（撞了就是两个封面共用一个文件 = 错图）。 */
  const usedCoverNames = new Set();

  /* --- 沿用已发布的 manifest（--keep-manifest）---
     必须在清空 published/<日期>/ 之前读 —— 下面那行 fs.rm 会把目录整个删掉。

     什么时候需要它：
       「只改前端/样式」这种改动，跟内容一点关系都没有。
       但见报是构建期实时抓的，普通构建会顺手把内容换掉
       （RSS 一直在轮换，源站还会时不时抽风），
       于是「改个 CSS」变成了「顺手换了 3 条新闻」—— 跟本次改动无关的变更，
       线上还没验证过就发出去，是自找麻烦。

     所以：先把上一版的 manifest 读出来留着，最后原样写回去。
     写回去时字节一致 -> 内容哈希一致 -> 文件名一致 -> 页面引用不用改，
     真正变的只有 app.js / app.css。 */
  let keptManifest = null;
  if (args.keepManifest) {
    keptManifest = await readManifestFile(publishedDir);
    if (keptManifest) {
      console.log(
        `  · 沿用已发布的 manifest（生成于 ${keptManifest.generatedAt}，` +
          `${(keptManifest.tabs || []).length} 个 tab）`
      );
    } else {
      console.log('  ! 这一期还没有 manifest，退回正常构建（内容会重新抓取）');
    }
  }

  /* --- 见报源名的分类预校验（必须在清空 published/<日期>/ 之前）---
     「源没配分类」是最常见的接线错误：加了个新 RSS 源，忘了在 taxonomy 里配。
     这个失败必须发生在删产物**之前** ——
     那一期的 published/<日期>/ 是审过、发过、线上验过的，删了回不来，
     连 --retag 的往期重分类都做不了了（它要读旧 manifest）。

     源清单从哪来（都不依赖会被删掉的目录）：
       - 普通构建：RSS 源名（rss.config.json 的 feeds[].name）+ 头条源名（headlines JSON）
       - --keep-manifest 且这一期已有 manifest：整份原样沿用，不重算分类 -> 不用校验
         （keep-manifest 但这一期还没有 manifest -> 退回普通构建，照样要校验）
       - --retag：源名是旧 manifest 里条目的 source，在 runRetag() 里单独校验
         （那边更早 —— 在任何写操作之前就抛错）

     头条顺手在这里读一次，下面组装段直接复用 ——
     读两遍的话中间文件要是变了，预校验过的源和真正分类的源就不是同一批了。 */
  let preTops = null;
  if (!keptManifest) {
    const sources = [];

    // RSS 源名：rss.config.json 的 feeds[].name
    if (!args.skipRss) {
      const cfg = loadConfig();
      if (cfg.enabled) {
        for (const f of cfg.feeds || []) {
          if (!f || !f.name) {
            throw new Error(
              'rss.config.json 里有个源没有 name 字段 —— 源名是分类的依据，没名字就没法分类'
            );
          }
          sources.push(f.name);
        }
      }
    }
    // 头条源名：headlines JSON（读 <IMAGE_ROOT>\src\<日期>\headlines\）
    preTops = await loadHeadlines(srcRoot, date);
    for (const it of (preTops && preTops.items) || []) {
      if (it.source) sources.push(it.source);
    }

    // 没配分类就在删产物之前失败 —— 不静默归到「其它」
    const missing = [...new Set(sources)].filter((s) => !taxonomy.sourceCategory[s]);
    if (missing.length) {
      throw new Error(
        `见报源「${missing.join('、')}」没有配分类（news-taxonomy.json 的 sourceCategory 缺这一项）。\n` +
          `  配了才能构建 —— 分类配错会静默发错内容，不降级。\n` +
          `  已配的源：${Object.keys(taxonomy.sourceCategory).join('、')}`
      );
    }
  }

  // 清掉上一次构建留下的旧 hash 资源（app.<hash>.css / .js），否则会越堆越多
  await fs.rm(publishedDir, { recursive: true, force: true });
  await fs.mkdir(publishedDir, { recursive: true });

  let manifest = {
    date,
    generatedAt: new Date().toISOString(),
    title: SITE_TITLE,
    siteUrl,
    imageBase,
    // 默认落点写死，不跟数量走（见 TABS 里 default 字段的说明）
    defaultTab: (TABS.find((t) => t.default) || {}).key || 'jianxiao',
    tabs: [],
  };

  let totalFull = 0;
  let totalThumb = 0;
  let totalSrc = 0;
  let rebuiltMode = false;

  const salt = await getSalt();

  /* ── 模糊占位（LQIP）与分享图（OG 卡片）的素材 ──
     LQIP：每张缩略图额外缩一张 24px 的小图，以 base64 内联进 manifest。
     OG 卡片：三栏照片各取第一张，拼成一张 1200x630 的分享图。 */
  const lqipJobs = [];
  const ogPhotos = [];

  for (const tab of TABS) {
    const tabSrcDir = path.join(srcRoot, tab.dir);
    const destDir = path.join(r2Dir, tab.key);
    let files = [];
    try {
      files = (await fs.readdir(tabSrcDir, { withFileTypes: true }))
        .filter((d) => d.isFile() && /\.(jpe?g|png|gif|webp|bmp)$/i.test(d.name))
        .map((d) => d.name)
        .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
    } catch {
      // 源图不在了 —— 从已转码的 webp 重建这一期，URL 保持不变
      const rebuilt = await rebuildTabFromConverted(destDir, tab, imageBase, date);
      if (rebuilt) {
        console.log(`  ~ ${tab.dir}/ 源图缺失，从已转码产物重建 ${rebuilt.count} 张`);
        manifest.tabs.push(rebuilt);
        rebuiltMode = true;
        continue;
      }
      console.log(`  ! ${tab.dir}/ 不存在，跳过`);
      continue;
    }

    const items = [];
    // 本轮产出的文件名白名单（用于清理上一轮的孤儿产物，见下方注释）
    const produced = new Set();
    // 本轮是否真的转码了（决定要不要清旧产物）
    let didConvert = !args.skipConvert;
    // 「复用模式回退成真转码」只提示一次
    let fallbackNoted = false;
    for (let i = 0; i < files.length; i++) {
      const name = files[i];
      const src = path.join(tabSrcDir, name);
      const id = pad(i + 1);
      // 文件名里带上不可猜的随机段：<nonce>_001.webp
      //
      // 为什么不能只是「URL 里多一段、存储键不变」—— 那样随机段不参与查找，
      // 任何格式正确的随机段都能命中同一张图，随机段等于白加（单元测试抓到过）。
      // 把随机段编进文件名后，存储键与 URL 完全一致：
      //   - 代理不需要重组路径
      //   - upload-r2 / stage-static 一行都不用改
      //   - 旧格式 001.webp 不符合新命名规则，代理直接 404（枚举的口子被堵死）
      //
      // 随机段按「内容」算（见 nonceFor 的说明）——
      // 内容变了 URL 就变，边缘缓存自动失效，不会把上一张图的内容发给用户。
      const nFull = await nonceFor(salt, tab.key, id, src);
      const nThumb = await nonceFor(salt, tab.key, id + 't', src);
      const relFull = `${tab.key}/${nFull}_${id}.webp`;
      const relThumb = `${tab.key}/${nThumb}_${id}_t.webp`;
      const destFull = path.join(r2Dir, relFull);
      const destThumb = path.join(r2Dir, relThumb);

      // 旧命名（001.webp）-> 新命名（<nonce>_001.webp）的兼容处理。
      // 老文件留着的话代理会按命名规则挡掉（404），但 R2 里会多一份没人引用的对象。
      const oldFull = path.join(destDir, `${id}.webp`);
      const oldThumb = path.join(destDir, `${id}_t.webp`);
      if (args.skipConvert) {
        // 复用已转码的图片：把旧命名的搬过来
        for (const [oldPath, newPath] of [[oldFull, destFull], [oldThumb, destThumb]]) {
          try {
            await fs.access(newPath);
          } catch {
            try {
              await fs.rename(oldPath, newPath);
            } catch {
              /* 没有旧文件就算了 */
            }
          }
        }
      } else {
        // 重新转码：旧命名的残留清掉，避免 R2 里留一堆没人引用的对象
        try {
          for (const f of await fs.readdir(destDir)) {
            if (/^[0-9]{3}(_t)?\.webp$/.test(f)) {
              await fs.rm(path.join(destDir, f), { force: true });
            }
          }
        } catch {
          /* 目录还没建 */
        }
      }
      const srcStat = await fs.stat(src);
      totalSrc += srcStat.size;

      const { w: sw, h: sh } = await ffprobeSize(ffprobe, src);
      const full = fit(sw, sh, FULL_MAX_W);
      const thumb = fit(sw, sh, THUMB_MAX_W);

      // 复用模式的前提是「产物已经存在 **而且能用**」。
      // 但随机段现在按内容算 —— 清洗掉几张图之后，
      // 剩下那些图的内容虽然没变、序号却前移了，
      // 对应的产物文件名也跟着变（nonce 里有序号），
      // 于是 --no-convert 找不到文件了。
      // 这时必须回退成真转码，否则 stat 会在下面直接抛错。
      //
      // ⚠️ 光「存在」还不够（2026-11-15 线上事故）：
      //   转码被中断会留下 0 字节的母本 —— fs.access 判定「存在」→
      //   0 字节被当成合法产物复用 → 一路传到 R2 → 线上代理照吐
      //   200 / Content-Length: 0 → 归档页那一格裂图。
      //   所以复用前要真读一下文件头（productProblem 用 webpSize，起不了进程）。
      let needConvert = !args.skipConvert;
      if (args.skipConvert) {
        const pFull = await productProblem(destFull);
        const pThumb = await productProblem(destThumb);
        if (pFull || pThumb) {
          needConvert = true;
          if (!fallbackNoted) {
            fallbackNoted = true;
            const why = pFull
              ? `全图 ${path.basename(destFull)} ${pFull}`
              : `缩略图 ${path.basename(destThumb)} ${pThumb}`;
            console.log(`  ! 部分产物缺失或损坏（${why}），自动回退为重新转码`);
          }
        }
      }

      if (needConvert) {
        await toWebPChecked(ffmpeg, src, destFull, full.W, full.H, tab.quality, `${tab.label} ${id} 全图`);
        await toWebPChecked(ffmpeg, src, destThumb, thumb.W, thumb.H, 72, `${tab.label} ${id} 缩略图`);
        didConvert = true;
      }

      // 记入白名单 —— 清理旧产物时用它判断「这个文件本轮还在用」
      produced.add(path.basename(destFull));
      produced.add(path.basename(destThumb));

      const fullSize = (await fs.stat(destFull)).size;
      const thumbSize = (await fs.stat(destThumb)).size;
      totalFull += fullSize;
      totalThumb += thumbSize;

      const item = {
        id: `${tab.key}_${id}`,
        w: full.W,
        h: full.H,
        tw: thumb.W,
        th: thumb.H,
        // URL 里文件名自带不可猜的随机段，路径无法被枚举
        thumb: `${imageBase}/${date}/${relThumb}`,
        full: `${imageBase}/${date}/${relFull}`,
      };
      items.push(item);
      /* 模糊占位（LQIP）的素材：**缩略图**文件 ——
         网格里显示的就是它，小图从它缩出来最省事。
         注意是母本里的本地路径，不是 manifest 里的 URL。 */
      lqipJobs.push({ item, file: destThumb });
      /* 分享图（OG 卡片）的素材：三栏照片各取第一张（见闻/见她/见笑）。 */
      if (i === 0) ogPhotos.push({ tabKey: tab.key, file: destFull });

      process.stdout.write(
        `\r  ${tab.label} ${i + 1}/${files.length}  ` +
        `${full.W}x${full.H} ${(fullSize / 1024).toFixed(0)}KB   `,
      );
    }
    process.stdout.write('\n');

    // 旧产物清理：按「本轮实际产出的文件名白名单」删，
    // 不是按「序号 > 新数量」删。
    //
    // 为什么：清洗掉中间一张图后，后面所有图的序号会前移，
    // 随机段（nonce）也跟着变 —— 旧文件名一个都不再被 manifest 引用。
    // 但它们的序号可能仍落在新数量以内（删了第 3 张，旧的 004 还在 <= 20），
    // 按序号判断就清不掉，R2 里会留一堆没人要的孤儿对象。
    //
    // 做法：本轮转码时记下每个产物的文件名，最后拿目录里的文件对白名单。
    //
    // 只在真的转码时清理：纯复用模式（--no-convert 且产物齐全）
    // 产物文件名一个都没变，清了反而会误伤。
    if (didConvert) {
      let removed = 0;
      const removedNames = [];
      try {
        for (const f of await fs.readdir(destDir)) {
          if (!/^[0-9a-f]{10}_\d{3}(_t)?\.webp$/.test(f)) continue;
          if (!produced.has(f)) {
            await fs.rm(path.join(destDir, f), { force: true });
            removed++;
            removedNames.push(f);
          }
        }
      } catch {
        /* 目录还没建 */
      }
      if (removed) {
        console.log(`    清掉 ${removed} 个不再被引用的旧产物`);
        // 把删掉的名字打出来：万一里面混进了本轮还要用的文件，
        // 光看数量是发现不了的（2026-10-28 就这么丢了 6 个缩略图）。
        for (const n of removedNames.slice(0, 20)) console.log(`      - ${n}`);
        if (removedNames.length > 20) console.log(`      … 还有 ${removedNames.length - 20} 个`);
      }
    }

    manifest.tabs.push({
      key: tab.key,
      label: tab.label,
      accent: tab.accent,
      count: items.length,
      items,
    });
  }

  /* --- 模糊占位（LQIP）：批量缩图 → base64 内联进 manifest ---
     为什么内联而不是给每张图多传一张小图到 R2：
       内联 = **零额外请求、零额外对象**；
       走 R2 的话多出来的对象要进「上传 / 孤儿清理 / 代理放行」三条管道，
       少改一处就是线上裂图。
     代价是 manifest 变大（24px 的 webp 约 200~400 字节，base64 后再多三成）。

     为什么必须**批量**：182 张图各起一个 ffmpeg 进程就是 +45 秒构建时间。
     批处理在 tools/build-lqip.mjs 里。

     失败只降级：LQIP 是锦上添花，没有它页面照常显示（只是首屏没有模糊占位）。 */
  if (lqipJobs.length) {
    let lqipCount = 0;
    try {
      const lqipMap = await makeLqipDataUris({
        ffmpeg,
        files: lqipJobs.map((j) => j.file),
      });
      for (const j of lqipJobs) {
        const uri = lqipMap.get(j.file);
        if (!uri) continue;
        j.item.lqip = uri;
        lqipCount++;
      }
    } catch (e) {
      console.log(`  ! 模糊占位生成失败（${e.message}）—— 不影响发布`);
    }
    console.log(`  · 模糊占位：${lqipCount}/${lqipJobs.length} 张带 LQIP`);
  }

  /* --- 产物自检：manifest 引用的每个文件都必须真的在母本里 ---
     为什么必须有这一道：
     「随机段」是按「内容 + 序号」算的。删掉中间一张图之后，后面所有图的
     序号会前移，产物文件名也跟着变；而 --no-convert 复用模式只在
     「文件名正好对得上」时才复用，对不上就会回退成真转码。
     这中间只要有一点没对上，manifest 就会指向不存在的文件 ——
     上线后的表现是「一堆裂图」，而构建日志全程报「成功」。

     真实踩过的坑（2026-10-28）：10-28 的 manifest 引用了 21 个
     在 r2 母本里根本不存在的产物（14 个全图 + 7 个缩略图），
     如果直接发出去就是 21 张裂图。所以这里直接把「引用 ↔ 磁盘」
     对齐一次，对不上就让构建失败 —— 宁可不发布，也不能发一版裂图。 */
  {
    const missing = [];
    for (const tab of manifest.tabs) {
      if (isTextTab(tab)) continue;
      const dir = path.join(r2Dir, tab.key);
      for (const it of tab.items || []) {
        if (!it.full || !it.thumb) continue;
        for (const u of [it.full, it.thumb]) {
          const fn = path.basename(u);
          try {
            await fs.access(path.join(dir, fn));
          } catch {
            missing.push(`${tab.key}/${fn}`);
          }
        }
      }
    }
    if (missing.length) {
      console.error('');
      console.error(`  ✗ 产物自检失败：manifest 引用的 ${missing.length} 个文件在母本里不存在`);
      for (const m of missing.slice(0, 12)) console.error(`      ${m}`);
      if (missing.length > 12) console.error(`      … 还有 ${missing.length - 12} 个`);
      throw new Error('产物不完整，拒绝生成 manifest（防止上线后出现裂图）');
    }
    console.log(`  ✓ 产物自检通过：manifest 引用的文件全部存在`);
  }

  /* --- 见报（新闻）---
     在构建期抓（不是运行时）：Pages Functions 没有 Cron，定时抓必须另起 Worker；
     而且构建期是在本机（国内 IP）跑的，国内源从国内拉通顺得多。
     抓到的标题直接烘进当天的 manifest —— 静态、零 Function、零 CORS、不占 Workers 额度。

     两个来源：
       1. RSS（fetch-rss）—— 15 个订阅源
       2. 头条（headlines.json）—— 5 个热榜源，由 daily_headlines.py 抓

     ── 目录模型 ──────────────────────────────────────────────
     以前是「头条」+「热榜」两个伞标签：头条把 9 个源拍平成一个大类，
     热榜 = 头条 + 全部 RSS 混排（内容等于「全部」，chip 完全重复）。
     后来拆成按领域分目录（知乎 / 微博 / 科技 …），但那些目录名是**三套轴混排**
     —— 平台名、内容领域、内容形态并列一行，用户建不起心智模型。

     现在**分类只按用户思维**（= 我想看什么）：
       热议 / 科技数码 / AI / 效率工具 / 技术社区 / 深度阅读
     分类表在 tools/news-taxonomy.json（唯一真相源），归属由它算 ——
     RSS 的 tag、头条的 category 都只是线索，不参与决策。
     一条内容可以属于多个领域（源的主分类 + 关键词命中的额外分类）。

     前端 app.js 用 data-tags（空格分隔）做包含匹配，点哪个目录都切得动。 */
  let rssCount = 0;
  let topCount = 0;
  const newsItems = [];

  /* ── 见报的来源分支 ──
       1. 普通构建：RSS + 头条都重新抓
       2. --keep-manifest：整份 manifest 原样沿用，压根不碰见报
     分类归属统一在下面重算，不看 RSS 的 tag、不看头条的 category。

     --retag 不走这一段：它在 runRetag() 里单独跑（不碰源图、不转码、不抓 RSS），
     main() 到不了这里。 */
  if (!args.skipRss && !keptManifest) {
    const cfg = loadConfig();
    if (cfg.enabled) {
      const r = await fetchHeadlines(cfg);
      rssCount = r.items.length;
      for (const f of r.failures) {
        console.log(`  ! RSS 源 ${f.name} 抓取失败：${f.error}（不影响其他源）`);
      }
      for (const s of r.stale || []) {
        console.log(
          `  ! RSS 源 ${s.name} 丢弃了 ${s.dropped}/${s.total} 条过期条目（最新条目 ${s.ageDays} 天前）`
        );
      }
      for (const it of r.items) {
        newsItems.push({
          title: it.title,
          link: it.link,
          source: it.source,
          tag: it.tag,
          tags: [it.tag],
          time: it.time,
          ts: it.ts || 0,
          desc: (it.desc || '').slice(0, 120),
          // 候选配图地址。**这里必须显式带过去** ——
          // 上面是逐字段重建对象，没列的字段一律不跟着走。
          // 漏了这一行，配图那边收到的候选就是 0 个（构建日志会写「尝试 0 个候选」）。
          imgs: it.imgs || [],
        });
      }
    } else {
      console.log('  · RSS 已关闭（rss.config.json: enabled=false）');
    }
  }

  // 头条：读 daily_headlines.py 落的 JSON。没有这个文件就跳过，不报错。
  //
  // --keep-manifest 时不读：内容要原样沿用上一版，重新读一遍只会引入差异。
  // 用的就是预校验时读的那一份（preTops）—— 读两遍的话中间文件变了，
  // 预校验过的源和真正分类的源就不是同一批了。
  const tops = keptManifest ? null : preTops;
  if (tops && tops.items.length) {
    topCount = tops.items.length;
    newsItems.push(...tops.items);
    console.log(`  · 头条 ${topCount} 条（${tops.sources.length} 个源）`);
  } else if (!args.skipRss && !keptManifest) {
    console.log(`  · 没有找到头条 JSON（${path.join(srcRoot, 'headlines')}）—— 跳过头条部分`);
  }

  // 跨源去重：RSS 源和头条源可能收录**同一篇文章**。
  //   V2EX 热榜就是这种情况 —— 头条那边 Python 抓 www.v2ex.com/?tab=hot，
  //   RSS 那边走 RSS屋 的镜像，两边是同一份热榜、同一个链接
  //   （头条那个源时好时坏：11 期里只成功过 2 期）。
  // 保留先出现的那条（RSS 先入队，所以留 RSS 的那份 —— 它带摘要）。
  {
    const { items: uniq, duplicates } = dedupeNewsItems(newsItems);
    if (duplicates) {
      console.log(`  · 跨源去重去掉 ${duplicates} 条重复（同一篇文章被两个渠道收录）`);
      newsItems.length = 0;
      newsItems.push(...uniq);
    }
  }

  if (newsItems.length) {
    // 时间倒序：新的在前。没有时间的排最后。
    newsItems.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    // 标出「点进去需要登录」的源（知乎/微博/X）—— 纯静态域名判定，不发请求。
    markAuth(newsItems);

    // ── 分类归属重算 ──
    // 一律以 news-taxonomy.json 为准：RSS 的 tag 和头条的 category 只是线索。
    // 源没配分类 -> classifyItem 抛错 -> 整个构建失败（不静默归到「其它」）。
    for (const it of newsItems) {
      const c = classifyItem(it, taxonomy);
      it.tag = c.tag;
      it.tags = c.tags;
    }

    /* ── 见报配图（可选，默认关） ──
       开关在 tools/rss-images.json 的 enabled。
       关掉时**这一整段都不执行** —— manifest 不带 img 字段，
       页面上一个字都不会变。这条是硬要求：配图是增强，不是前提。

       为什么图片要在这里抓（而不是前端直接引外链）：
         防盗链（博海拾贝不带 Referer 直接 403）、
         http:// 混合内容（每日环球视野 99/100 条是 http）、
         源站改 URL 就全裂。
       所以图必须落到自己这边，顺手缩到 400px（原始体积 5.9KB~2.1MB）。

       --keep-manifest 时**不抓**：那一条路子的定义就是「内容一个字都不改」，
       抓图会改 manifest 的字节，文件名跟着变，等于把「不改内容」破坏了。 */
    if (rssImgCfg && rssImgCfg.enabled && !keptManifest) {
      // 落盘目录必须跟**照片那套同构**：
      //   <R2母本>/<日期>/rss/<10位hex>_001_t.webp
      // 这样三处**一行都不用改**就能认：
      //   · upload-r2 的 walk 递归进 rss/ → R2 key = <日期>/rss/<文件>
      //     （代理 /img/[[path]].js 的路径正则正好是这个形状）
      //   · stage-static 的静态兜底也照抄同一层结构
      //   · 撤回时删 r2/<日期>/rss/ 整目录即可
      //
      // 之前踩过的坑：一度写成 r2/rss/<日期>/，那是**多一层**，
      // upload-r2 会把 "rss" 当成一个日期目录，R2 key 变成 rss/<日期>/<文件>，
      // 代理的正则认不出来 —— 全都 404，而且不报错，很难查。
      const imgOutDir =
        rssImgCfg.outDir === 'r2'
          ? path.join(R2_LOCAL, date, 'rss')
          : path.join(publishedRoot, 'img', date, 'rss');
      const got = await fetchRssImages({
        items: newsItems,
        date,
        outDir: imgOutDir,
        ffmpeg,
        config: rssImgCfg,
        salt,
        imageBase,
      });
      for (const [idx, url] of got.map) {
        if (newsItems[idx]) newsItems[idx].img = url;
      }
      console.log(
        `  · 配图：命中 ${got.stats.picked} 条 / 尝试 ${got.stats.candidates} 个候选` +
          `（失败 ${got.stats.failed}，无图 ${got.stats.noImage}，` +
          `非白名单源 ${got.stats.skippedSource} 条）` +
          `，共 ${(got.stats.bytes / 1024).toFixed(0)} KB -> ${imgOutDir}`,
      );
      if (got.stats.reasons && Object.keys(got.stats.reasons).length) {
        const top = Object.entries(got.stats.reasons)
          .slice(0, 5)
          .map(([k, v]) => `${k}×${v}`)
          .join('  ');
        console.log(`    失败原因：${top}`);
      }
    }

    // 分类列表：按 taxonomy 的**固定顺序**，只列当天有内容的。
    // 不按条数排 —— 按条数排的话 chip 位置天天乱跳，用户的肌肉记忆就废了。
    const cats = orderCategories(taxonomy, newsItems);
    const ordered = cats.map((c) => c.label);

    console.log(
      `  · 目录 ${ordered.length} 个（固定顺序）：` +
        cats.map((c) => `${c.label}(${c.count})`).join(' '),
    );
    manifest.tabs.push({
      key: 'news',
      label: '见报',
      accent: '#3ddc97',
      count: newsItems.length,
      type: 'headlines',
      tags: ordered,
      items: newsItems.map((it) => ({
        title: it.title,
        link: it.link,
        source: it.source,
        tag: it.tag,
        tags: it.tags,
        time: it.time,
        desc: it.desc,
        // 配图是**可选**的：只有抓到了才写这个字段。
        // 老 manifest 没这个字段 -> 前端渲染成纯文字，跟以前一模一样。
        ...(it.img ? { img: it.img } : {}),
        // 知乎/微博/X 点进去要登录 —— 前端提前标出来，
        // 免得用户以为链接坏了。
        needLogin: it.needLogin === true,
      })),
    });
  }

  /* --- 音乐榜 / 影视榜（榜单型 tab）---
     数据由 tools/fetch-rank.mjs 在构建前抓好，落在源图目录里（rank_<日期>.json）。
     **构建期抓、运行时零请求** —— 榜单是静态内容，烘进 manifest 后
     不占任何 Workers 额度，也不占 R2（封面是对方的远程 URL，热链）。

     没有这个文件就不加这两个 tab：
       · 往期重构建（往期目录里没有这个文件）
       · 只改前端的 --keep-manifest 构建
     这样「加新 tab」不会反过来把老流程弄坏。

     ⚠️ key / label 必须写成**字符串字面量**，不能写 { key: rt.key }：
       tools/test-contract.mjs 靠正则从 build.mjs 源码里抠出「栏目 key → 中文名」
       逐个去 site/board.html 的 TAB_LABELS 里核对。写成变量的话正则抠不到，
       新栏目就**不受契约保护** —— 留言板上会显示内部 key 而不是中文名，
       而且没有任何报错。 */

  /* 榜单 / 追更两块的**数据**先读进来，再由下面的「看片五段合并」统一拼。
     变量提到块外面，是因为「看片」这一个 tab 现在同时吃
     榜单的三段（音乐 / 电影 / 视频）和追更的两段（频道更新 / 本地演出）——
     读数据和拼 tab 必须分成两步，否则先读的那块会被后面覆盖掉。 */
  let musicList = [];
  let movieList = [];
  let videoList = [];
  let followSchedule = [];
  let followEvents = [];

  {
    let rank = null;
    let rankFrom = null;
    for (const root of srcSearchRoots()) {
      const p = path.join(root, date, `rank_${date}.json`);
      try {
        rank = JSON.parse(await fs.readFile(p, 'utf8'));
        rankFrom = p;
        break;
      } catch {
        /* 试下一个候选根（源图挪过盘的情况） */
      }
    }

    /* 单个 tab 最多放多少条。
       榜单条目每条约 150 字节，manifest 会肉眼可见地变大，
       而首屏要整个下载 + JSON.parse。所以每个 tab 砍到上限。

       ⚠️ 上限必须**按 tab 分别设**：
       影视榜的顺序是「豆瓣 250 条在前、B站 50 条在后」，
       统一卡 200 条的话，B站那 50 条视频会被整段砍掉 ——
       影视 tab 就只剩电影，没有视频了（2026-11-16 实踩）。

       2026-11-16 v2：听乐改成多榜（中文榜 + 国际榜 + 场景榜），
       看片拆成电影段 + 视频段，所以上限也跟着分项调大。 */
    const MAX_RANK_ITEMS = { music: 600, movie: 400, video: 200 };

    if (rank) {
      const musicRaw = Array.isArray(rank.music) ? rank.music.slice(0, MAX_RANK_ITEMS.music) : [];
      const movie = Array.isArray(rank.movie) ? rank.movie.slice(0, MAX_RANK_ITEMS.movie) : [];
      const video = Array.isArray(rank.video) ? rank.video.slice(0, MAX_RANK_ITEMS.video) : [];

      /* 多榜合并后统一重编号。
         听乐现在是多张榜（中文榜 + 国际榜 + 场景榜），
         每张榜的序号都是自己从 1 开始的 —— 直接拼起来，
         列表里会看到「1,2,3…49,1,2,3…」这种跳号。 */
      musicList = musicRaw.map((it, i) => ({ ...it, rank: i + 1 }));

      /* 电影段和视频段（v3 起视频段自己拆成 B站热门 / 抖音热门 两个大目录，
         由 fetch-rank.mjs 直接打 @1 标签，这里不再二次加工）。
         段内顺序不动 —— 「有图的靠前」是抓取端排好的。 */
      movieList = movie;
      videoList = video;

      console.log(`  · 榜单数据：${rankFrom}`);
      if (Array.isArray(rank.errors) && rank.errors.length) {
        for (const e of rank.errors) console.log(`    ! 榜单源异常：${e}`);
      }
    } else {
      console.log('  · 榜单：没有 rank_' + date + '.json，跳过（这一期只有图片和见报）');
    }
  }

  /* --- 追更数据（2026-11-16 v3：不再单开 tab，整体并入「看片」）---
     数据由 tools/fetch-follow.mjs 在构建前抓好，落在源图目录里（follow_<日期>.json）。
     跟听乐/看片一样是**构建期抓、运行时零请求**的静态内容。

     它本来有两块 —— schedule（频道更新）和 events（本地演出）——
     v3 起这两块整体搬进「看片」当大目录用，不再自己占一个「追更」tab。

     这两块的上限必须**分项**：截完再拼，不是拼完再截。
     拼完再截的话，后半段会被整段砍掉
     （影视榜 2026-11-16 实踩过：豆瓣 250 + B站 50 统一卡 200 → B站那 50 条全没了）。

     payload 不存在 / 解析失败 / 两块都空 → 当作没有这两段，不报错
     （跟榜单一样的降级：往期重构建、只改前端的 --keep-manifest 构建都没有它）。 */
  {
    let payload = null;
    let payloadFrom = null;
    for (const root of srcSearchRoots()) {
      const p = path.join(root, date, `follow_${date}.json`);
      try {
        payload = JSON.parse(await fs.readFile(p, 'utf8'));
        payloadFrom = p;
        break;
      } catch {
        /* 试下一个候选根（源图挪过盘的情况） */
      }
    }

    /* 分项上限：两个数**故意不一样**。
       统一成一个数，等于把「哪一块被砍掉了」这件事藏起来 ——
       砍掉的是整块还是零头，从代码上就看不出来了。
       schedule 是全球剧集更新（单一来源、密度高），上限给大一些；
       events 是各城市的演出（按城市拼接，尾部城市被砍 → 那个城市 chip 点进去是空的），
       所以它单独一个数。 */
    const MAX_FOLLOW_ITEMS = { schedule: 500, events: 300 };

    if (payload) {
      followSchedule = Array.isArray(payload.schedule)
        ? payload.schedule.slice(0, MAX_FOLLOW_ITEMS.schedule)
        : [];
      followEvents = Array.isArray(payload.events)
        ? payload.events.slice(0, MAX_FOLLOW_ITEMS.events)
        : [];
      console.log(`  · 追更数据：${payloadFrom}`);
      if (Array.isArray(payload.errors) && payload.errors.length) {
        for (const e of payload.errors) console.log(`    ! 追更源异常：${e}`);
      }
    } else {
      console.log('  · 追更：没有 follow_' + date + '.json，跳过（这一期没有追更内容）');
    }
  }

  /* --- 看片：五段合并（2026-11-16 v3）---
     段顺序 = 大目录（@1 chip）顺序 —— 前端的 chip 是**按条目在列表里的出现顺序**
     现推的（site/app.js 的 renderChips 只去重、不排序），
     所以这里的拼接顺序就是用户看到的目录顺序：

       频道更新 → 电影 → B站热门 → 抖音热门 → 本地演出

     每段各自从 1 开始编号 → 直接拼起来会出现两个「1」。
     合成后统一重编号成 1..K，序号才是唯一的列表位置。 */
  const watchList = [...followSchedule, ...movieList, ...videoList, ...followEvents]
    .map((it, i) => ({ ...it, rank: i + 1 }));

  /* 本地封面（豆瓣抓下来的）→ 转 WebP 存 R2 母本 → 换成站内路径。
     远程 URL（猫眼/B站/网易云/TVmaze）原样保留。 */
  const coverOpts = { ffmpeg, salt, date, r2Dir, imageBase, usedNames: usedCoverNames };
  const locMusic = await localizeCovers(musicList, coverOpts);
  const locWatch = await localizeCovers(watchList, coverOpts);
  const coverTotal = locMusic.localized + locWatch.localized;
  const coverFail = locMusic.failed + locWatch.failed;
  if (coverTotal || coverFail) {
    console.log(`  · 榜单封面：本地化 ${coverTotal} 张${coverFail ? `，${coverFail} 张失败（那条先空着）` : ''}`);
  }

  const rankTabs = [];
  if (locMusic.items.length) {
    rankTabs.push({
      key: 'music',
      label: '听乐',
      accent: '#a78bfa',
      type: 'rank',
      search: { placeholder: '搜歌名或歌手 · 回车全网搜', itunes: true },
      list: locMusic.items,
    });
  }
  if (locWatch.items.length) {
    rankTabs.push({
      key: 'movie',
      label: '看片',
      accent: '#fb923c',
      type: 'rank',
      search: { placeholder: '搜剧名/片名/演出名 · 回车去豆瓣搜', douban: true },
      list: locWatch.items,
    });
  }

  for (const rt of rankTabs) {
    manifest.tabs.push({
      key: rt.key,
      label: rt.label,
      accent: rt.accent,
      count: rt.list.length,
      type: rt.type,
      /* chips 用 tag 字段而不是 key —— 正则 key:\s*'([a-z]+)'
         会把任何 key 字段当成「栏目定义」抠走，chips 不是栏目。
         新前端的 chip 是**从条目的 tags 现推**的，这里这份只是
         给「条目没有 tags 的旧 manifest」兜底用的。 */
      chips: level1Chips(rt.list),
      search: rt.search,
      items: rt.list.map(rankItem),
    });
    console.log(`  · ${rt.label}：${rt.list.length} 条（榜单）`);
  }

  /* --- --keep-manifest 的闸门：图片必须跟已发布的版本一模一样 ---
     上一版 manifest 是「审过、发过、线上验过」的内容。
     如果这一期的源图跟它对不上，说明期间动过图（删过/移过）——
     那就不能沿用旧 manifest：线上会挂出跟审稿结论不符的东西。
     这种情况必须走正常流程：重新构建 -> 重新审稿 -> 再发。

     注意这个检查必须放在「比对」之后、「写产物」之前，
     而且失败时目录已经被清空了 —— 所以调用方（publish.ps1）会把这次构建
     当成失败处理，不会拿半成品去部署。 */
  if (keptManifest) {
    const diffs = diffImageTabs(keptManifest, manifest);
    if (diffs.length) {
      console.error('');
      console.error(`  ✗ 图片跟已发布的 manifest 对不上（${diffs.length} 处差异），--keep-manifest 已拒绝：`);
      for (const d of diffs.slice(0, 12)) console.error(`      ${d}`);
      if (diffs.length > 12) console.error(`      … 还有 ${diffs.length - 12} 处`);
      throw new Error('图片变了，不能沿用旧 manifest（请走正常构建 + 审稿流程）');
    }
    // 原样换回去：连 generatedAt 都用旧的，
    // 这样序列化出来的字节完全一致 -> 内容哈希一致 -> 文件名一致 -> 页面引用不用改。
    manifest = keptManifest;
    const newsTab = (manifest.tabs || []).find((t) => t.key === 'news');
    console.log(
      `  ✓ 图片与已发布版本完全一致，沿用旧 manifest` +
        (newsTab ? `（见报 ${newsTab.count} 条，内容一字未改）` : '')
    );
  }

  /* --- 渲染页面 --- */
  const template = await fs.readFile(path.join(ROOT, 'site', 'template.html'), 'utf8');
  const css = await fs.readFile(path.join(ROOT, 'site', 'app.css'), 'utf8');
  const js = await fs.readFile(path.join(ROOT, 'site', 'app.js'), 'utf8');

  // 站点级静态资源（logo 等）放到 published 根目录，日期页用 ../assets/ 引用，
  // og:image 也指这里 -> SITE_URL/assets/logo.jpg
  const assetsSrc = path.join(ROOT, 'site', 'assets');
  const assetsDst = path.join(publishedRoot, 'assets');
  await fs.rm(assetsDst, { recursive: true, force: true });
  await fs.mkdir(assetsDst, { recursive: true });
  let assetCount = 0;
  for (const name of await fs.readdir(assetsSrc)) {
    if (!/\.(jpg|jpeg|png|webp|gif|svg|ico)$/i.test(name)) continue;
    if (/-source\./i.test(name)) continue; // 源图只是 make-logo 的输入，不进产物
    await fs.copyFile(path.join(assetsSrc, name), path.join(assetsDst, name));
    assetCount++;
  }

  // 留言板页面（静态外壳）。
  // 放在 published/board.html 而不是 published/board/index.html：
  // /board/ 这个路径归 functions/board/index.js 管（Pages 里 Function 优先于静态资源），
  // 静态文件放同路径会取不到。Function 用 ASSETS.fetch('/board.html') 取它。
  await fs.copyFile(path.join(ROOT, 'site', 'board.html'), path.join(publishedRoot, 'board.html'));

  // 内容哈希做缓存击穿，文件名随内容变（hash 在模块级，--retag 也用它）
  const cssName = `app.${hash(css)}.css`;
  const jsName = `app.${hash(js)}.js`;

  // manifest 拆成独立 .js：微信分享卡片的爬虫只解析 HTML、不执行 JS，
  // 内联的话它能把 490 个图片 URL 全抓下来做图像审核。拆出去就抓不到了。
  const manifestJson = JSON.stringify(manifest).replace(/</g, '\\u003c');
  const manifestName = `manifest.${hash(manifestJson)}.js`;

  const dateCn = date.replace(/^(\d{4})-(\d{2})-(\d{2})$/, (_, _y, mm, dd) => `${Number(mm)}月${Number(dd)}日`);

  /* --- 分享图（OG 卡片）：每期一张 1200x630 的拼图 ---
     为什么不能继续用 logo：分享到群里时，卡片是**唯一的预览** ——
     群友点开之前只能看到这一张图。现在 og:image 恒等于 640x640 的 logo，
     完全看不出今天更新了什么。

     ⚠️ 合成失败**不许阻断构建**：退回 logo（老行为）就行 ——
     卡片难看总比没有图强。
     ⚠️ 图片里**不写文字**：字体要绑到具体平台的字体文件路径
     （Windows 的 C:\\Windows\\Fonts、macOS 的 /System/Library/Fonts 各一套），
     文字放在 og:title / og:description 里。 */
  let ogImage = `${siteUrl}/assets/logo.jpg`;
  let ogImageW = '640';
  let ogImageH = '640';
  if (ogPhotos.length) {
    try {
      const og = await composeOgImage({
        ffmpeg,
        inputs: ogPhotos.map((p) => p.file),
        outFile: path.join(publishedDir, 'og.jpg'),
      });
      ogImage = ogImageUrl({ siteUrl, date });
      ogImageW = String(og.width);
      ogImageH = String(og.height);
      console.log(`  · 分享图：og.jpg（${(og.bytes / 1024).toFixed(0)}KB，${ogPhotos.length} 张拼图）`);
    } catch (e) {
      console.log(`  ! 分享图合成失败（${e.message}）—— 退回 logo 当 og:image`);
    }
  }

  /* 各 tab 的条数摘要 —— 分享卡片的描述里用它，
     让人在点开之前就知道今天有多少内容。 */
  const countsSummary = manifest.tabs
    .filter((t) => t.count)
    .map((t) => `${t.label} ${t.count}`)
    .join(' · ');

  // 某天的永久链接：标题带日期（URL 唯一，微信每次都会重新抓，卡片不会过期）
  const dayHtml = renderPage(template, {
    pageTitle: `${SITE_TITLE} · ${date}`,
    pageDesc: countsSummary
      ? `${dateCn} · ${countsSummary}，每日一阅。`
      : `${dateCn} · 见闻 · 见她 · 见笑，每日一阅。`,
    ogUrl: `${siteUrl}/${date}/`,
    ogImage,
    ogImageW,
    ogImageH,
    assetBase: '../assets',
    home: '../archive/',
    date,
    title: SITE_TITLE,
    siteUrl,
    cssHref: cssName,
    jsSrc: jsName,
    manifestSrc: manifestName,
  });
  await fs.writeFile(path.join(publishedDir, 'index.html'), dayHtml, 'utf8');
  await fs.writeFile(path.join(publishedDir, cssName), css, 'utf8');
  await fs.writeFile(path.join(publishedDir, jsName), js, 'utf8');
  await fs.writeFile(
    path.join(publishedDir, manifestName),
    `window.__DAILY_MANIFEST__=${manifestJson};`,
    'utf8',
  );

  /* --- 历史索引页 → /archive/ --- */
  const dates = (await fs.readdir(publishedRoot, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
    .map((d) => d.name)
    .sort()
    .reverse();
  const archiveDir = path.join(publishedRoot, 'archive');
  await fs.mkdir(archiveDir, { recursive: true });
  await fs.writeFile(
    path.join(archiveDir, 'index.html'),
    buildIndexHtml(dates, SITE_TITLE, siteUrl),
    'utf8',
  );

  /* --- RSS：每期一条 item 的日报 ---
     为什么要有：站内一个 feed 都没有 —— /feed.xml 会落到 Pages 的 404 兜底页
     （返回 200 + text/html，那不是 feed）。订阅者没法「今天更新了」自动收到。

     为什么放**根目录**：feed 的内容是**所有往期**，每期构建时重新扫一遍
     published/<日期>/ 的 manifest 汇总一次。

     item 的 link 必须是**绝对 URL** —— 相对路径在阅读器里点不开。
     每期一条 item（不是每条内容一条）：这是一份日报，
     3 万多条内容全塞进去会让阅读器卡住，也没人会逐条读。 */
  {
    const issues = [];
    for (const d of dates) {
      const dir = path.join(publishedRoot, d);
      const name = await findLiveManifestName(dir);
      if (!name) continue;
      const m = await readManifestPath(path.join(dir, name));
      if (!m) continue;
      const counts = {};
      for (const t of m.tabs || []) {
        counts[t.key] = t.count != null ? t.count : (t.items || []).length;
      }
      issues.push({
        date: d,
        pubDate: m.generatedAt || `${d}T08:00:00+08:00`,
        counts,
      });
    }
    const feedXml = buildFeedXml({ siteUrl, siteTitle: SITE_TITLE, issues });
    await fs.writeFile(path.join(publishedRoot, 'feed.xml'), feedXml, 'utf8');
    console.log(`  · RSS：published/feed.xml（${issues.length} 期）`);
  }

  /* --- 根路径 = 今天 ---
     这是对外分享的固定链接，不用带日期，每天自动指向最新一期。
     og:title / og:description 刻意**不带日期**：微信按 URL 缓存分享卡片，
     标题带日期的话卡片会永远停在第一天。 */
  const rootHtml = renderPage(template, {
    pageTitle: SITE_TITLE,
    // 根页的 og:description 刻意**不带日期也不带条数** ——
    // 根 URL 是固定链接，微信按 URL 缓存分享卡片，
    // 描述里带日期的话缓存下来的卡片会永远显示第一天。
    // （og:image 指向当期那张分享图：缓存过期重抓时就是当期的。）
    pageDesc: '见闻 · 见她 · 见笑 · 见报 · 听乐 · 看片，每日一阅。',
    ogUrl: `${siteUrl}/`,
    ogImage,
    ogImageW,
    ogImageH,
    assetBase: 'assets',
    home: 'archive/',
    date,
    title: SITE_TITLE,
    siteUrl,
    cssHref: `/${date}/${cssName}`,
    jsSrc: `/${date}/${jsName}`,
    manifestSrc: `/${date}/${manifestName}`,
  });
  await fs.writeFile(path.join(publishedRoot, 'index.html'), rootHtml, 'utf8');

  /* --- 汇总 --- */
  const mb = (b) => (b / 1024 / 1024).toFixed(2);
  console.log('');
  console.log('──────────── 汇总 ────────────');
  console.log(`图片总数   : ${manifest.tabs.filter(isMediaTab).reduce((s, t) => s + t.count, 0)}`);
  if (rebuiltMode) {
    console.log('构建模式   : 源图缺失，复用已转码产物重建（图 URL 保持不变）');
  } else {
    console.log(`原始体积   : ${mb(totalSrc)} MB`);
    console.log(`全尺寸 WebP: ${mb(totalFull)} MB  (压缩比 1:${(totalSrc / totalFull).toFixed(2)})`);
    console.log(`缩略图     : ${mb(totalThumb)} MB`);
  }
  console.log(`R2 待上传  : ${path.join(R2_LOCAL, date)}`);
  console.log(`页面产物   : ${publishedDir}`);
  console.log(`站点地址   : ${siteUrl}/            (根路径 = 今天，自动指向最新一期)`);
  console.log(`当天页面   : ${siteUrl}/${date}/`);
  console.log(`往期列表   : ${siteUrl}/archive/`);
  console.log(`静态资源   : ${assetCount} 个 -> published/assets/`);
  const keptNewsTab = (manifest.tabs || []).find((t) => t.key === 'news');
  console.log(
    keptManifest
      ? `RSS 见报   : 沿用已发布版本（${keptNewsTab ? keptNewsTab.count : 0} 条，内容一字未改）`
      : `RSS 见报   : ${rssCount} 条${topCount ? ` + 头条 ${topCount} 条` : ''}`
  );
  const rankTabList = (manifest.tabs || []).filter((t) => t.type === 'rank');
  if (rankTabList.length) {
    console.log(`榜单       : ${rankTabList.map((t) => `${t.label} ${t.count} 条`).join(' + ')}`);
  }
  /* 看片内部五段（频道更新 / 电影 / B站热门 / 抖音热门 / 本地演出）单开一行：
     只给一个总数的话，哪段抓少了、哪段被上限砍了，从汇总里看不出来。 */
  const watchTab = (manifest.tabs || []).find((t) => t.key === 'movie');
  if (watchTab) {
    /* v3：看片自己就有五个大目录，板块在 tags 的 '@1:' 里。
       按**出现顺序**统计 —— 顺序就是用户看到的目录顺序，
       哪一段是 0 条，一眼就能看出来。 */
    const sect = {};
    for (const it of watchTab.items || []) {
      const t1 = flattenTags(it.tags).find((t) => t.indexOf('@1:') === 0);
      const name = t1 ? t1.slice(3) : '未分类';
      sect[name] = (sect[name] || 0) + 1;
    }
    console.log(
      `看片分段   : ${Object.keys(sect).map((k) => `${k} ${sect[k]} 条`).join(' + ')}（共 ${watchTab.count} 条）`,
    );
    /* 缺段要**点名**说出来。
       源数据没抓到时构建只会少几段，光看「看片 440 条」发现不了少了哪一档 ——
       而「看片只有 2 个目录」看着像网站坏了，不像「漏抓了一次数据」。
       段名清单见文件头的 WATCH_SECTIONS。 */
    const missing = WATCH_SECTIONS.filter((s) => !sect[s]);
    if (missing.length) {
      console.log(
        `  ! 看片缺 ${missing.length} 段：${missing.join('、')} —— 对应的源数据没抓到` +
          `（rank_<日期>.json / follow_<日期>.json；抓取器是 tools\\fetch-rank.mjs / fetch-follow.mjs，` +
          `daily.ps1 的第 4 步会自动跑）`,
      );
    }
  }
  console.log(`可用天数   : ${dates.length}`);
  console.log(`耗时       : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

function buildIndexHtml(dates, title, siteUrl) {
  const latest = dates[0];
  // 往期列表**包含最新一期**。
  //
  // 之前是 dates.slice(1) —— 理由是「根路径就是它」，最新一期单独做卡片。
  // 但实际后果是：在「全部日期」里**根本点不到今天**，
  // 列表第一条是昨天那一期，点进去看到的自然是昨天（乃至前天）的见报内容。
  // 「进入11月11日的内容，却看到11月9日的内容」就是这么来的 ——
  // 不是内容错了，是**今天那期没出现在列表里**，人只能去点昨天那期。
  //
  // 上面那张「最新一期」大卡片保留（那是快捷入口），
  // 下面是**完整**的日期索引，两处并存不矛盾。
  // 这个页面在 /archive/ 下，比根路径深一层，相对路径都要多一个 ../
  //
  // ⚠️ 日期条目**必须带 class="row"** ——
  // 这个页面里的卡片样式（背景、圆角、右边的 › 箭头、日期的等宽数字）
  // 全挂在 `a.row` 上；漏了这个 class，日期列表就是一排**裸蓝色下划线链接**，
  // 看着像没做完的半成品（留言板那条 `<a class="row">` 反而是对的）。
  const items = dates
    .map(
      (d) =>
        `<li><a class="row" href="../${d}/"><span class="d">${d}</span><span class="arrow">›</span></a></li>`,
    )
    .join('\n      ');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#0b0b0f">
<meta name="format-detection" content="telephone=no">
<title>${title}</title>
<meta name="description" content="见闻 · 见她 · 见笑，每日一阅。">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${title}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="见闻 · 见她 · 见笑，每日一阅。">
<meta property="og:image" content="${siteUrl}/assets/logo.jpg">
<meta property="og:image:width" content="640">
<meta property="og:image:height" content="640">
<meta property="og:url" content="${siteUrl}/archive/">
<!-- RSS：往期页也要能被阅读器自动发现 ——
     这个页面**自带一份 <head>**（不走 site/template.html），
     所以模板里那条 <link rel="alternate"> 不会自动出现在这儿。
     漏了它，读者从「全部日期」进来就没有订阅入口。 -->
<link rel="alternate" type="application/rss+xml" title="${title} · 每日更新" href="/feed.xml">
<link rel="icon" href="../assets/logo.jpg" type="image/jpeg">
<link rel="apple-touch-icon" href="../assets/logo.jpg">
<style>
  html,body{background:#0b0b0f;color:#e8e8ee;-webkit-text-size-adjust:100%;text-size-adjust:100%}
  *{-webkit-tap-highlight-color:rgba(0,0,0,0)}
  body{margin:0;padding:0;font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
       padding-bottom:calc(40px + env(safe-area-inset-bottom,0px))}
  .wrap{max-width:560px;margin:0 auto;padding:22px 16px 0}

  .head{display:-webkit-flex;display:flex;-webkit-align-items:center;align-items:center;margin-bottom:20px}
  .logo{width:38px;height:38px;border-radius:9px;background:#fff;margin-right:12px;
        -webkit-flex-shrink:0;flex-shrink:0;-webkit-object-fit:contain;object-fit:contain}
  .head h1{margin:0;font-size:20px;font-weight:600;letter-spacing:.3px;line-height:1.25}
  .head p{margin:3px 0 0;font-size:12px;color:#8b8b99;font-variant-numeric:tabular-nums}

  .latest{display:block;text-decoration:none;color:inherit;margin-bottom:24px;
          background:linear-gradient(135deg,#17171f 0%,#1d1d28 100%);
          border:1px solid #2a2a36;border-radius:16px;padding:18px 18px 16px;position:relative;overflow:hidden}
  .latest:active{background:#1e1e29}
  .latest .kicker{display:inline-block;font-size:11px;color:#0b0b0f;background:#4a8cff;
                  padding:3px 9px;border-radius:999px;font-weight:600;margin-bottom:10px}
  .latest .date{font-size:24px;font-weight:600;letter-spacing:.4px;font-variant-numeric:tabular-nums;margin-bottom:4px}
  .latest .tip{font-size:13px;color:#8b8b99;margin-bottom:14px}
  .latest .go{display:inline-flex;align-items:center;font-size:14px;color:#4a8cff;font-weight:500}
  .latest .go span{margin-left:6px;font-size:17px;line-height:1}

  .label{font-size:12px;color:#6f6f7d;letter-spacing:1px;margin:0 0 10px 2px}

  ul{list-style:none;margin:0;padding:0}
  li{margin:0 0 8px}
  a.row{display:-webkit-flex;display:flex;-webkit-align-items:center;align-items:center;
        -webkit-box-sizing:border-box;box-sizing:border-box;
        padding:13px 14px;background:#16161d;border:1px solid #24242f;border-radius:12px;
        color:#e8e8ee;text-decoration:none}
  a.row:active{background:#1e1e28}
  a.row .d{font-variant-numeric:tabular-nums;letter-spacing:.3px}
  a.row .arrow{margin-left:auto;color:#4a8cff;font-size:18px;line-height:1}
</style>
</head>
<body>
  <div class="wrap">
    <div class="head">
      <img class="logo" src="../assets/logo.webp" alt="" width="38" height="38">
      <div>
        <h1>${title}</h1>
        <p>见闻 · 见她 · 见笑 · 每日一阅</p>
      </div>
    </div>

    <a class="latest" href="../">
      <span class="kicker">最新一期</span>
      <div class="date">${latest}</div>
      <div class="tip">共 ${dates.length} 天 · 点进去看今天的三个分类</div>
      <div class="go">进入<span>›</span></div>
    </a>

    ${items.length ? `<p class="label">全部期数</p>
    <ul>
      ${items}
    </ul>` : ''}

    <!-- 留言板入口。用绝对路径 /board/ —— 这个页面在 /archive/ 下，
         相对路径会指到 /archive/board/，那个路由不存在。 -->
    <p class="label">其它</p>
    <ul>
      <li><a class="row" href="/board/"><span class="d">留言板</span><span class="arrow">›</span></a></li>
    </ul>
  </div>
</body>
</html>
`;
}

main().catch((err) => {
  console.error('\n构建失败:', err.message);
  process.exit(1);
});
