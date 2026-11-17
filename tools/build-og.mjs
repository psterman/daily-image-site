#!/usr/bin/env node
/**
 * 分享图（og.jpg）合成 —— 把当期几张图拼成一张 1200x630 的分享卡片。
 *
 * 为什么要有这个：
 *   微信 / X 的分享卡片只认 og:image 这一张静态图。站点以前只有 logo，
 *   分享出去是一个小方块，点进去还得自己翻当期内容。
 *   一张 1200x630 的当期拼图，能让人在信息流里一眼看清「今天有什么」。
 *
 * 为什么**一次** ffmpeg 调用搞定：
 *   每张图各起一个进程再拼 = 解码 N 次 + 中间编码 N-1 次，图一多就慢；
 *   一次调用里用 filter_complex + hstack，只解码一次、直接出成品。
 *
 * 为什么图里不画字：
 *   ffmpeg 的 drawtext 必须指定字体文件路径，Windows 和 macOS 的系统字体
 *   目录完全不同、字体也不保证带 —— 跨平台没法写死。
 *   所以文字交给调用方放进 og:title / og:description，图只管好看。
 *
 * 为什么转码完还要 stat 一下：
 *   这个仓库踩过「ffmpeg 退出码 0 但产物是 0 字节」的线上事故 ——
 *   退出码 0 只代表没崩，不代表写出了东西。字节数必须验。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

/** 底色 —— 跟站点深色底一致，缺图补位时看不出是补丁。 */
const OG_BG = '#0b0b10';

/** 分享图最多几列（当期就三栏：见闻 / 见她 / 见笑）。 */
const MAX_SLOTS = 3;

/**
 * 文件在不在。读不到就算没有 ——
 * 缺一张图要降级成底色补位，不能让整张分享图出不来。
 */
async function exists(file) {
  try {
    const st = await fs.stat(file);
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * 把子进程错误里的 stderr 变成字符串。
 * execFile 给的可能是 Buffer，也可能是 string —— 两种都要接住。
 */
function errText(e) {
  const raw = e && e.stderr != null ? e.stderr : (e && e.message) || '';
  return Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
}

/**
 * 子进程的退出码。
 *
 * 为什么还要还原成有符号：Windows 上 Node 给的是无符号 32 位，
 * 失败码 -30 会显示成 4294967262 —— 报给人看要看得懂。
 */
function exitCodeOf(e) {
  const raw = e && e.code != null ? e.code : null;
  // ENOENT 这种是字符串（ffmpeg 路径不存在）—— 直接报出来比「未知」有用。
  if (typeof raw === 'string') return raw;
  if (typeof raw !== 'number') return '未知';
  if (raw > 2147483647) return raw - 4294967296;
  return raw;
}

/**
 * 合成分享图。
 *
 * @param {object} o
 * @param {string} o.ffmpeg     ffmpeg 可执行文件路径（调用方传入，代码里不写死）
 * @param {string[]} o.inputs   本地图片绝对路径，1~3 张
 * @param {string} o.outFile    输出 jpg 的绝对路径
 * @param {number} [o.width=1200]
 * @param {number} [o.height=630]
 * @returns {Promise<{width:number,height:number,bytes:number,file:string}>}
 */
export async function composeOgImage({ ffmpeg, inputs, outFile, width = 1200, height = 630 }) {
  if (!ffmpeg) throw new Error('缺少 ffmpeg 路径（由调用方传入，代码里不写死）');
  if (!outFile) throw new Error('缺少输出路径 outFile');

  const slots = Array.isArray(inputs) ? inputs.length : 0;
  if (slots < 1) throw new Error('至少要传一张图（inputs 是图片路径数组）');
  if (slots > MAX_SLOTS) throw new Error(`最多 ${MAX_SLOTS} 张图，收到 ${slots} 张`);

  const colW = Math.floor(width / slots);
  const colH = height;

  // yuv420p 要求宽高都是偶数；万一调用方传了奇数尺寸就退到 yuv444p，
  // 不然 crop 这一步会直接报错（mjpeg 两种都收）。
  const pixFmt = colW % 2 === 0 && colH % 2 === 0 ? 'yuv420p' : 'yuv444p';

  const inputArgs = [];
  const chains = [];
  const labels = [];
  let vi = 0; // ffmpeg 输入序号：只有真实存在的图才占一个
  for (let i = 0; i < slots; i++) {
    const src = typeof inputs[i] === 'string' ? inputs[i].trim() : '';
    const label = `c${i}`;
    labels.push(label);
    if (src && (await exists(src))) {
      inputArgs.push('-i', src);
      // scale 先「放大到盖住」再 crop 居中裁掉 —— 保证每列都是满的，不留黑边。
      chains.push(
        `[${vi}:v]scale=${colW}:${colH}:force_original_aspect_ratio=increase,` +
          `crop=${colW}:${colH},format=${pixFmt}[${label}]`,
      );
      vi++;
    } else {
      // 图不足 N 张时用 color 源补齐 —— 宁可少一张图，也不能整张分享图出不来。
      chains.push(`color=c=${OG_BG}:s=${colW}x${colH}:d=1:r=1,format=${pixFmt}[${label}]`);
      console.warn(`  ! 第 ${i + 1} 张图不可用（${src || '空'}），用底色补位`);
    }
  }

  // hstack 出来的宽度是 slots * colW；width 除不尽 slots 时会差几个像素，
  // 所以最后统一 pad 到正好 width x height —— 分享卡片的尺寸是硬指标。
  //
  // 注意：ffmpeg 的 hstack 至少要两个输入（inputs=1 直接报 out of range），
  // 所以只有一张图时不能走 hstack，直接用那一路。
  const pad = `pad=${width}:${colH}:(ow-iw)/2:(oh-ih)/2:color=${OG_BG}`;
  const filter =
    slots === 1
      ? [...chains, `[${labels[0]}]${pad}[out]`].join(';')
      : [
          ...chains,
          `[${labels.join('][')}]hstack=inputs=${slots}:shortest=1,${pad}[out]`,
        ].join(';');

  await fs.mkdir(path.dirname(outFile), { recursive: true });

  const args = [
    '-y',
    '-nostdin', // 不让 ffmpeg 去读 stdin，否则在无人值守的脚本里可能挂住
    '-loglevel',
    'error',
    ...inputArgs,
    '-filter_complex',
    filter,
    '-map',
    '[out]',
    '-frames:v',
    '1',
    '-c:v',
    'mjpeg',
    '-q:v',
    '2',
    outFile,
  ];

  try {
    await execFileAsync(ffmpeg, args, { maxBuffer: 10 * 1024 * 1024 });
  } catch (e) {
    const detail = errText(e).trim().slice(0, 300);
    throw new Error(
      `ffmpeg 合成分享图失败（退出码 ${exitCodeOf(e)}）：${detail || '没有 stderr 输出'}`,
    );
  }

  // 退出码 0 不代表写出了东西 —— 这个仓库真出过 0 字节产物上线的事故。
  let st = null;
  try {
    st = await fs.stat(outFile);
  } catch {
    st = null;
  }
  if (!st || st.size <= 0) {
    throw new Error(`ffmpeg 退出码 0，但产物是空文件：${outFile}`);
  }

  return { width, height, bytes: st.size, file: outFile };
}

/**
 * 分享卡的 og:image 绝对地址。
 *
 * 为什么必须是绝对 URL：微信 / X 的爬虫只认完整地址，
 * 相对路径它们拼不出来（页面里的 og:image 也必须是完整 https 地址）。
 *
 * @param {object} o
 * @param {string} o.siteUrl  站点根地址
 * @param {string} o.date     期号（YYYY-MM-DD）
 * @returns {string}
 */
export function ogImageUrl({ siteUrl, date }) {
  const base = String(siteUrl || '').replace(/\/+$/, '');
  const day = String(date || '');
  if (!base) throw new Error('ogImageUrl 需要 siteUrl');
  if (!day) throw new Error('ogImageUrl 需要 date');
  return `${base}/${day}/og.jpg`;
}

/* ------------------------------------------------------------ CLI 自测 */

function parseArgs(argv) {
  const out = { inputs: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ffmpeg') out.ffmpeg = argv[++i];
    else if (a === '--out') out.outFile = argv[++i];
    else if (a === '--input') out.inputs.push(argv[++i]);
    else if (a === '--width') out.width = Number(argv[++i]);
    else if (a === '--height') out.height = Number(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

/** ffprobe 跟 ffmpeg 装在同一个目录 —— 不写死路径，从传进来的 ffmpeg 推。 */
function ffprobePathOf(ffmpeg) {
  return path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
}

/** 读产物的宽高。 */
async function probeSize(file, probe) {
  const { stdout } = await execFileAsync(probe, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'json',
    file,
  ]);
  const info = JSON.parse(stdout);
  const s = info && info.streams && info.streams[0];
  if (!s) throw new Error(`ffprobe 没读出尺寸：${file}`);
  return { width: Number(s.width), height: Number(s.height) };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.ffmpeg || !args.outFile || !args.inputs.length) {
    console.log(`用法：
  node tools/build-og.mjs --ffmpeg "<ffmpeg 路径>" --out "<输出.jpg>" --input "<图1>" [--input "<图2>" ...]

  --width  <n>   输出宽，默认 1200
  --height <n>   输出高，默认 630
`);
    process.exit(args.help ? 0 : 1);
  }

  const res = await composeOgImage({
    ffmpeg: args.ffmpeg,
    inputs: args.inputs,
    outFile: args.outFile,
    width: args.width,
    height: args.height,
  });
  console.log(`输出文件 : ${res.file}`);
  console.log(`字节数   : ${res.bytes}`);

  // 用 ffprobe 验一遍尺寸 —— 分享卡片的尺寸是硬指标，肉眼看不出来。
  const probe = ffprobePathOf(args.ffmpeg);
  const size = await probeSize(res.file, probe);
  console.log(`尺寸     : ${size.width}x${size.height}`);
  if (size.width !== res.width || size.height !== res.height) {
    throw new Error(`尺寸不对：要 ${res.width}x${res.height}，实际 ${size.width}x${size.height}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`✗ ${e && e.message ? e.message : String(e)}`);
    process.exit(1);
  });
}
