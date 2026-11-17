#!/usr/bin/env node
/**
 * LQIP（Low Quality Image Placeholder，模糊占位图）批量生成。
 *
 * 为什么需要它：
 *   站内图片网格是懒加载的 —— <img> 的 src 一直空着，等 IntersectionObserver
 *   判定进视口才赋值。所以**首屏是一格格空的深色方块**，要等 3~4 秒图片才淡入。
 *   LQIP = 每张图额外带一张**极小的**缩略图，以 base64 data URI **内联**在 manifest 里，
 *   浏览器零额外请求就能立刻画出一个模糊的小图，大图到位后再盖上去 → 首屏立刻有内容感。
 *
 * 关键成本约束 —— **绝对不能一个文件起一个 ffmpeg 进程**：
 *   一期 182 张图 = 182 个进程 ≈ +45 秒构建时间（Windows 上每个进程光初始化就 ~250ms，
 *   还要算 WebP 编码器冷启动）。所以这里**批量**：一次 ffmpeg 调用处理一批输入
 *   （filter_complex + 多个 output），默认 12 张一批 → 182 张只要 16 次调用。
 *
 * 用法（当库用）：
 *   import { makeLqipDataUris } from './build-lqip.mjs';
 *   const map = await makeLqipDataUris({ ffmpeg, files: thumbPaths });
 *   // map: Map<原文件绝对路径, 'data:image/webp;base64,...'>
 *
 * 自测（直接跑本文件）：
 *   node tools/build-lqip.mjs --ffmpeg "<ffmpeg 路径>" --input "<a.webp>" --input "<b.webp>"
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

/** LQIP 小图宽度（像素）。24px 宽实测 ≈ 150~400 字节的 webp —— 够糊出色彩块，不够看清内容。 */
const DEFAULT_WIDTH = 24;
/**
 * 每批交给 ffmpeg 的输入个数。
 * 12 是实测平衡点：再小则进程启动开销占比上升（182/12=16 次），再大则 Windows 命令行长度吃紧。
 */
const DEFAULT_BATCH_SIZE = 12;
/** libwebp 有损质量。40 = 肉眼只看得见色块 —— 占位图要的正是色块。 */
const QUALITY = 40;
/** libwebp 压缩等级 0~6。6 = 最慢最小；LQIP 只有几十像素，重编码不亏那点时间。 */
const COMPRESSION_LEVEL = 6;

/**
 * 统计（跨多次调用累加，方便调用方/测试断言「ffmpeg 起了几次」）。
 * 验收标准之一就是「不能一个文件一个进程」，这个计数器就是证据。
 */
const stats = { spawns: 0, batches: 0, ok: 0, failed: 0 };

/** 读一份统计快照。 */
export function getLqipStats() {
  return { ...stats };
}

/**
 * 临时目录的基准目录。
 *
 * 为什么不用 node:os.tmpdir()：本模块只允许用 node:fs/promises、node:path、
 * node:child_process、node:util、node:url 这几个内置模块，os 不在其中。
 * TMPDIR（macOS/Linux）、TEMP/TMP（Windows）这组环境变量足够定位临时目录。
 */
function tmpBase() {
  return process.env.TMPDIR || process.env.TEMP || process.env.TMP || process.cwd();
}

/** 把错误压成一行能读的文案。 */
function errText(err) {
  if (!err) return '未知错误';
  const s = err.stderr || err.message || String(err);
  return String(s).trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' | ') || '未知错误';
}

/**
 * 拼一批的 ffmpeg 参数。
 *
 * ⚠️ ffmpeg 的 **per-output 选项规则**：写在某个 output 文件名**之后**的选项，
 * 属于**下一个** output。所以每个 output 的编码参数必须紧挨着写在它自己的输出文件名前面，
 * 否则参数会串到别的 output 上（典型症状：第一个 output 没编码参数，编成了原始格式）。
 */
function buildArgs(batch, width, outDir) {
  const args = ['-y', '-nostdin', '-loglevel', 'error'];
  // 先把所有输入摆出来
  for (const f of batch) args.push('-i', f);
  // 一条 filter_complex 串起所有缩放：scale=W:-2 —— -2 = 高度按比例取偶数
  // （webp 编码器对奇数高个别版本会挑刺，取偶数最省事）。
  //
  // ⚠️ flags 的值必须是 **fast_bilinear**，不是 fast：
  //   ffmpeg 9.0.2 的 sws_flags 只认 fast_bilinear / bilinear / bicubic / lanczos …
  //   写 flags=fast 会报 "Undefined constant or missing '(' in 'fast'" →
  //   整条 filter_complex 初始化失败（每一批都废）。
  const filters = batch.map((_, i) => `[${i}:v]scale=${width}:-2:flags=fast_bilinear[b${i}]`).join(';');
  args.push('-filter_complex', filters);
  // 再逐个 output：-map 各自的 filter 输出，编码参数写在该 output 之前。
  batch.forEach((_, i) => {
    args.push(
      '-map', `[b${i}]`,
      '-c:v', 'libwebp',
      '-quality', String(QUALITY),
      '-compression_level', String(COMPRESSION_LEVEL),
      '-frames:v', '1',
      path.join(outDir, `o${i}.webp`),
    );
  });
  return args;
}

/**
 * 跑一批：一次 ffmpeg 调用 → 读回全部小图 → base64。
 *
 * 临时目录的生命周期：**读完 base64 立刻删**（用 fs.rm，不用 Remove-Item / rm）。
 * 删不掉也不该让整期发不出去 —— LQIP 是锦上添花。
 *
 * @returns {Promise<Map<string,string>>} 原文件绝对路径 → data URI
 */
async function runBatch(ffmpeg, batch, width) {
  const dir = await fs.mkdtemp(path.join(tmpBase(), 'lqip-'));
  try {
    const args = buildArgs(batch, width, dir);
    stats.spawns += 1;
    await execFileAsync(ffmpeg, args, {
      maxBuffer: 32 * 1024 * 1024, // 报错时 stderr 可能很长，别让它撑爆默认缓冲
      windowsHide: true, // Windows 上别弹黑框
    });
    const map = new Map();
    for (let i = 0; i < batch.length; i++) {
      const buf = await fs.readFile(path.join(dir, `o${i}.webp`));
      map.set(batch[i], `data:image/webp;base64,${buf.toString('base64')}`);
    }
    return map;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * 批量生成 LQIP data URI。
 *
 * @param {object} opts
 * @param {string} opts.ffmpeg            ffmpeg 可执行文件的绝对路径（**由调用方传**，本模块不猜也不写死）
 * @param {string[]} opts.files           本地 webp 文件的绝对路径数组（调用方传已转码好的缩略图）
 * @param {number} [opts.width=24]        小图宽度（像素），高度按比例
 * @param {number} [opts.batchSize=12]    每批几张
 * @param {boolean} [opts.verbose=true]   是否打印每批的进度
 * @returns {Promise<Map<string,string>>} 原文件绝对路径 → 'data:image/webp;base64,...'
 *
 * 失败策略：**单批失败不许让整个构建挂掉** —— 那一批整批跳过（不产出条目），
 * 打一行中文警告继续下一批。全部失败时返回空 Map，不抛异常。
 */
export async function makeLqipDataUris({
  ffmpeg,
  files,
  width = DEFAULT_WIDTH,
  batchSize = DEFAULT_BATCH_SIZE,
  verbose = true,
} = {}) {
  const out = new Map();
  if (!ffmpeg || typeof ffmpeg !== 'string') {
    console.warn('  ! LQIP：没拿到 ffmpeg 路径，跳过模糊占位图（不影响出图）');
    return out;
  }
  const list = (Array.isArray(files) ? files : []).filter((f) => typeof f === 'string' && f.trim());
  if (list.length === 0) return out;

  const w = Math.max(1, Math.floor(Number(width) || DEFAULT_WIDTH));
  const size = Math.max(1, Math.floor(Number(batchSize) || DEFAULT_BATCH_SIZE));
  const totalBatches = Math.ceil(list.length / size);

  for (let i = 0; i < list.length; i += size) {
    const batch = list.slice(i, i + size);
    const no = Math.floor(i / size) + 1;
    stats.batches += 1;
    try {
      const map = await runBatch(ffmpeg, batch, w);
      for (const [k, v] of map) out.set(k, v);
      stats.ok += map.size;
      if (verbose) {
        console.log(`  · LQIP 批次 ${no}/${totalBatches}：${batch.length} 张 → ${map.size} 张（1 次 ffmpeg 调用）`);
      }
    } catch (err) {
      stats.failed += batch.length;
      console.warn(`  ! LQIP 批次 ${no}/${totalBatches} 失败（${batch.length} 张整批跳过）：${errText(err)}`);
    }
  }
  return out;
}

/* ---------------------------------------------------------------- 自测入口 */

function usage() {
  console.log(`LQIP 批量生成（自测入口）

  node tools/build-lqip.mjs --ffmpeg "<ffmpeg 路径>" --input "<a.webp>" [--input "<b.webp>" ...]
                            [--width 24] [--batch-size 12]

  --ffmpeg      ffmpeg 可执行文件的绝对路径（必填）
  --input       输入 webp 的绝对路径，可重复给多次
  --width       LQIP 宽度（像素），默认 ${DEFAULT_WIDTH}
  --batch-size  每批几张，默认 ${DEFAULT_BATCH_SIZE}`);
}

async function main() {
  const argv = process.argv.slice(2);
  let ffmpeg = '';
  let width = DEFAULT_WIDTH;
  let batchSize = DEFAULT_BATCH_SIZE;
  const inputs = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ffmpeg') ffmpeg = argv[++i] || '';
    else if (a === '--input') inputs.push(argv[++i] || '');
    else if (a === '--width') width = Number(argv[++i]);
    else if (a === '--batch-size') batchSize = Number(argv[++i]);
    else if (a === '--help' || a === '-h') { usage(); return 0; }
    else { console.error(`不认识的参数：${a}`); usage(); return 1; }
  }
  if (!ffmpeg) { console.error('缺少 --ffmpeg'); usage(); return 1; }
  if (!inputs.length) { console.error('至少给一个 --input'); usage(); return 1; }

  const map = await makeLqipDataUris({ ffmpeg, files: inputs, width, batchSize });
  const sizes = [...map.values()].map((v) => Buffer.byteLength(v, 'utf8'));
  const sum = sizes.reduce((a, b) => a + b, 0);

  console.log('');
  console.log(`处理 ${inputs.length} 张（每批 ${batchSize} 张 → ${Math.ceil(inputs.length / batchSize)} 批）`);
  console.log(`成功 ${map.size} 张，失败 ${inputs.length - map.size} 张`);
  console.log(`ffmpeg 实际调用 ${stats.spawns} 次（一个文件一个进程的话应该是 ${inputs.length} 次）`);
  console.log('每个 data URI 的字节数：');
  for (const [k, v] of map) {
    console.log(`  ${path.basename(k).padEnd(24)} ${String(Buffer.byteLength(v, 'utf8')).padStart(6)} 字节`);
  }
  if (sizes.length) {
    const avg = Math.round(sum / sizes.length);
    console.log(`体积：合计 ${sum} 字节（${(sum / 1024).toFixed(1)} KB），平均 ${avg} 字节/张`);
    console.log(`估算 182 张：约 ${Math.round((avg * 182) / 1024)} KB`);
  }
  return map.size === inputs.length ? 0 : 1;
}

// ⚠️ Windows 上必须用 pathToFileURL(process.argv[1]).href ——
// 手写 `file://${argv[1]}` 会得到三个斜杠（file:///E:/...），入口根本不跑（exit 0 但零输出）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error('LQIP 自测失败：', err && err.message ? err.message : err);
      process.exitCode = 1;
    });
}
