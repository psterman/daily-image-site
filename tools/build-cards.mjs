#!/usr/bin/env node
/**
 * 卡片图（当期）生成 —— 每张媒体图配一张 JPEG 缩略卡片，供微信分享卡片用。
 *
 * 为什么要有：
 *   微信分享卡片只认 og:image 那一张静态图，而单图页现在指向的是 .webp ——
 *   微信对 webp 只是「部分支持」，部分入口直接显示裂图。
 *   所以每张媒体图额外出一张 JPEG（等比长边 900），前端分享时改用它。
 *
 * 为什么输出到 published 而不是 R2：
 *   R2 那条管道只认 `<nonce>_<序号>.webp` 一种命名 ——
 *   upload-r2.mjs / orphan-clean.mjs / r2-prune.mjs 都按它扫，乱塞 .jpg 进去会被当垃圾清掉，
 *   线上就是裂图。卡片图是**静态资源**，跟页面产物一起走 published/ 就够了。
 *
 * 规格（别自作主张改）：
 *   等比缩到长边 900（不裁剪、不填充）、JPEG 质量 70、单帧。
 *
 * 失败策略：**一张图转码失败不许让整次构建失败** —— 跳过那一张、记一行日志，继续下一张。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

/** 卡片图长边上限（像素）。900 = 微信分享卡片缩略图够用，又不至于太大。 */
export const CARD_MAX_EDGE = 900;
/** 卡片图的 JPEG 质量（规格里的「质量 70」）。 */
export const CARD_QUALITY = 70;
/** 每批交给 ffmpeg 的输入个数（见下面「为什么批量」的说明）。 */
export const CARD_BATCH_SIZE = 12;
/** 卡片图放在 published/<日期>/ 下的目录名。 */
export const CARD_DIR_NAME = 'card';

/* ── 方形卡片图（微信缩略图专用）───────────────────────────────
   为什么要多一套：
     微信对 og:image **强制按 1:1 居中裁剪**，而长边版是「等比缩到长边 900、不裁剪」。
     实测 11-26 当期 201 张：裁剪后可见面积中位只有 68%，最差的 900×263 超宽图只剩 29%
     —— 对方在微信聊天里看到的就是「一条横带」，根本认不出是哪张图。
     方图版的面积 100% 可见（微信裁它等于不裁）。

   规格（别自作主张改）：
     640×640 正方形（微信缩略图硬下限 300×300，通行推荐 640×640），
     背景 = 原图放大铺满后居中裁方 + 模糊，主体 = 原图等比缩到画布内、居中叠上去。

   目录跟长边版**分开**（card-sq/）：
     tools/test-share-page.mjs 里有一条**既有**断言盯的是
     「card/ 里的图片数 = 该栏图片数」—— 两套混在一个目录会直接打破它。 */
export const CARD_SQUARE_SIZE = 640;
export const CARD_SQUARE_DIR_NAME = 'card-sq';
export const CARD_SQUARE_BLUR = 20;

/**
 * 「质量 70」怎么落到 ffmpeg 上。
 *
 * mjpeg 编码器的 -q:v **不是** 0~100 的质量值，而是 2~31 的 qscale（越小越好：
 * 2 ≈ 最好、31 ≈ 最差）。libwebp 那种 0~100 的 -quality 语义在这里不存在 ——
 * 实测传 50 / 70 / 90 出来的字节数一模一样（都被截到 31 = 最差）。
 *
 * 所以这里按 2~31 线性折算：质量 100 → qscale 2，质量 0 → qscale 31。
 * 质量 70 → qscale 11（实测 900px 长边的卡片图约 20~45KB）。
 *
 * @param {number} quality 0~100 的质量
 * @returns {number} ffmpeg 的 -q:v 值
 */
export function jpegQscaleForQuality(quality) {
  const q = Number(quality);
  if (!Number.isFinite(q)) return jpegQscaleForQuality(CARD_QUALITY);
  const clamped = Math.min(100, Math.max(0, q));
  const scale = Math.round(2 + ((100 - clamped) * 29) / 98);
  return Math.min(31, Math.max(2, scale));
}

/**
 * 卡片图的文件名 —— 跟全尺寸 webp 产物同名，只换扩展名。
 *
 * 为什么沿用 webp 的名字（<nonce>_<序号3位>）：
 *   一张图的全图和卡片图一一对应，同名最好认 ——
 *   前端只要把 manifest 里的 .webp 换成同名 .jpg 就能定位到卡片图。
 *
 * @param {string} webpName 全尺寸 webp 的文件名
 * @returns {string}
 */
export function cardFileName(webpName) {
  const base = path.basename(String(webpName || ''));
  return base.replace(/\.[A-Za-z0-9]+$/, '') + '.jpg';
}

/**
 * 卡片图在 published 里的相对路径 —— card/<栏key>/<nonce>_<序号3位>.jpg。
 *
 * @param {string} tabKey  栏 key（jianxiao / jianshe / jianwen）
 * @param {string} webpName 全尺寸 webp 的文件名
 * @returns {string}
 */
export function cardRelPath(tabKey, webpName) {
  return path.join(CARD_DIR_NAME, String(tabKey || ''), cardFileName(webpName));
}

/**
 * 方形卡片图在 published 里的相对路径 —— card-sq/<栏key>/<nonce>_<序号3位>.jpg。
 *
 * ⚠️ **文件名跟长边版一模一样**（只是目录不同）：
 *   两套图一一对应、同名最好认，护栏/校验脚本按名字对就行。
 *   靠目录区分（card/ = 长边版，card-sq/ = 方图版），别在文件名上加后缀 ——
 *   加后缀会让「按 manifest 反查卡片图」的那套匹配规则多出一个分支。
 *
 * @param {string} tabKey  栏 key（jianxiao / jianshe / jianwen）
 * @param {string} webpName 全尺寸 webp 的文件名
 * @returns {string}
 */
export function cardSquareRelPath(tabKey, webpName) {
  return path.join(CARD_SQUARE_DIR_NAME, String(tabKey || ''), cardFileName(webpName));
}

/** 把错误压成一行能读的文案。 */
function errText(err) {
  if (!err) return '未知错误';
  const s = err.stderr || err.message || String(err);
  return String(s).trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' | ') || '未知错误';
}

/** 产物字节数；文件不在就是 0。 */
async function sizeOf(file) {
  try {
    const st = await fs.stat(file);
    return st.size;
  } catch {
    return 0;
  }
}

/** 缩放滤镜：等比缩到长边 maxEdge，不裁剪不填充（跟 build.mjs 的 toWebPCover 同一套写法）。 */
function scaleFilter(maxEdge) {
  return `scale=${maxEdge}:${maxEdge}:force_original_aspect_ratio=decrease:flags=lanczos`;
}

/**
 * 一次 ffmpeg 调用转一批图。
 *
 * 为什么必须**批量**：
 *   一期 201 张图各起一个 ffmpeg 进程 ≈ +50 秒构建时间
 *   （Windows 上每个进程光初始化就 ~250ms，还要算编码器冷启动）。
 *   仓库里 LQIP 那批图已经踩过同一个坑（见 tools/build-lqip.mjs 的说明）。
 *
 * ⚠️ ffmpeg 的 **per-output 选项规则**：写在某个 output 文件名**之后**的选项属于**下一个** output。
 *   所以每个 output 的编码参数必须紧挨着写在它自己的输出文件名前面，否则参数会串到别的 output 上。
 *
 * @param {string} ffmpeg
 * @param {Array<{src:string,out:string}>} batch
 * @param {number} qscale
 * @param {number} maxEdge
 */
async function runBatch(ffmpeg, batch, qscale, maxEdge) {
  const args = ['-y', '-nostdin', '-loglevel', 'error'];
  for (const j of batch) args.push('-i', j.src);
  const filters = batch
    .map((_, i) => `[${i}:v]${scaleFilter(maxEdge)}[c${i}]`)
    .join(';');
  args.push('-filter_complex', filters);
  batch.forEach((j, i) => {
    args.push(
      '-map', `[c${i}]`,
      '-c:v', 'mjpeg',
      '-q:v', String(qscale),
      '-frames:v', '1',
      j.out,
    );
  });
  await execFileAsync(ffmpeg, args, {
    maxBuffer: 32 * 1024 * 1024, // 报错时 stderr 可能很长，别让它撑爆默认缓冲
    windowsHide: true, // Windows 上别弹黑框
  });
}

/** 单张转码（批次失败后的退路 —— 把「一张坏图」和「一批全废」分开）。 */
async function runOne(ffmpeg, job, qscale, maxEdge) {
  const args = [
    '-y', '-nostdin', '-loglevel', 'error',
    '-i', job.src,
    '-vf', scaleFilter(maxEdge),
    '-c:v', 'mjpeg',
    '-q:v', String(qscale),
    '-frames:v', '1',
    job.out,
  ];
  await execFileAsync(ffmpeg, args, {
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
}

/**
 * 方形卡片图的滤镜链（一张图）。
 *
 * 背景：放大铺满 → 居中裁成方 → 模糊
 * 主体：等比缩到画布内 → 居中叠在背景上
 *
 * ⚠️ 微信是 **1:1 居中裁剪** —— 直接把长边版裁成方会把主体切掉
 *   （实测最差的一张只剩 29% 面积）。所以主体整张缩进来，
 *   缺的地方用「自己放大模糊后的底」补上，而不是把主体裁掉。
 *
 * @param {number} index 这张图在批次里的序号（用来给滤镜节点起唯一名字）
 * @param {number} size  画布边长
 * @param {number} blur  背景模糊半径（gblur 的 sigma）
 * @returns {string} 一条 filter_complex 片段，输出节点名固定是 c<index>out
 */
export function squareCardFilter(index, size = CARD_SQUARE_SIZE, blur = CARD_SQUARE_BLUR) {
  const p = `c${index}`;
  return [
    `split=2[${p}bg][${p}fg]`,
    `[${p}bg]scale=${size}:${size}:force_original_aspect_ratio=increase:flags=lanczos,` +
      `crop=${size}:${size},gblur=sigma=${blur}[${p}bg2]`,
    `[${p}fg]scale=${size}:${size}:force_original_aspect_ratio=decrease:flags=lanczos[${p}fg2]`,
    `[${p}bg2][${p}fg2]overlay=(W-w)/2:(H-h)/2[${p}out]`,
  ].join(';');
}

/**
 * 一次 ffmpeg 调用转一批方图。
 *
 * ⚠️ 滤镜节点名必须**按序号区分**（c0bg / c1bg …）：
 *   filter_complex 里所有节点名是全局的，同名会互相串。
 *
 * @param {string} ffmpeg
 * @param {Array<{src:string,out:string}>} batch
 * @param {number} qscale
 * @param {number} size
 * @param {number} blur
 */
async function runSquareBatch(ffmpeg, batch, qscale, size, blur) {
  const args = ['-y', '-nostdin', '-loglevel', 'error'];
  for (const j of batch) args.push('-i', j.src);
  args.push('-filter_complex', batch.map((_, i) => squareCardFilter(i, size, blur)).join(';'));
  batch.forEach((j, i) => {
    args.push(
      '-map', `[c${i}out]`,
      '-c:v', 'mjpeg',
      '-q:v', String(qscale),
      '-frames:v', '1',
      j.out,
    );
  });
  await execFileAsync(ffmpeg, args, {
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
}

/** 单张方图转码（批次失败后的退路 —— 跟长边版一个路数）。 */
async function runSquareOne(ffmpeg, job, qscale, size, blur) {
  const args = [
    '-y', '-nostdin', '-loglevel', 'error',
    '-i', job.src,
    '-filter_complex', squareCardFilter(0, size, blur),
    '-map', '[c0out]',
    '-c:v', 'mjpeg',
    '-q:v', String(qscale),
    '-frames:v', '1',
    job.out,
  ];
  await execFileAsync(ffmpeg, args, {
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
}

/**
 * 生成一批卡片图。
 *
 * @param {object} opts
 * @param {string} opts.ffmpeg                     ffmpeg 可执行文件路径（**由调用方传**，本模块不猜也不写死）
 * @param {Array<{src:string,out:string}>} opts.jobs  每项 = {源 webp 绝对路径, 输出 jpg 绝对路径}
 * @param {number} [opts.quality=CARD_QUALITY]     JPEG 质量（0~100）
 * @param {number} [opts.maxEdge=CARD_MAX_EDGE]    长边上限（像素）
 * @param {number} [opts.batchSize=CARD_BATCH_SIZE] 每批几张
 * @returns {Promise<{total:number,ok:number,failed:number,bytes:number}>}
 *
 * 失败策略：单张失败就跳过那一张、记一行日志，**不抛异常**。
 */
export async function buildCards({
  ffmpeg,
  jobs,
  quality = CARD_QUALITY,
  maxEdge = CARD_MAX_EDGE,
  batchSize = CARD_BATCH_SIZE,
} = {}) {
  const qscale = jpegQscaleForQuality(quality);
  return runCardJobs({
    label: '卡片图',
    ffmpeg,
    jobs,
    qscale,
    batchSize,
    runBatch: (batch) => runBatch(ffmpeg, batch, qscale, maxEdge),
    runOne: (job) => runOne(ffmpeg, job, qscale, maxEdge),
  });
}

/**
 * 生成一批**方形**卡片图（微信缩略图用）。
 *
 * 与长边版的唯一区别是滤镜链：背景模糊 + 主体居中叠加，输出恒为 size×size 正方形。
 * 失败策略跟长边版一致：单张失败就跳过那一张，不让整次构建失败。
 *
 * @param {object} opts
 * @param {string} opts.ffmpeg
 * @param {Array<{src:string,out:string}>} opts.jobs
 * @param {number} [opts.quality=CARD_QUALITY]
 * @param {number} [opts.size=CARD_SQUARE_SIZE]     正方形边长
 * @param {number} [opts.blur=CARD_SQUARE_BLUR]     背景模糊半径
 * @param {number} [opts.batchSize=CARD_BATCH_SIZE]
 * @returns {Promise<{total:number,ok:number,failed:number,bytes:number}>}
 */
export async function buildSquareCards({
  ffmpeg,
  jobs,
  quality = CARD_QUALITY,
  size = CARD_SQUARE_SIZE,
  blur = CARD_SQUARE_BLUR,
  batchSize = CARD_BATCH_SIZE,
} = {}) {
  const qscale = jpegQscaleForQuality(quality);
  return runCardJobs({
    label: '方形卡片图',
    ffmpeg,
    jobs,
    qscale,
    batchSize,
    runBatch: (batch) => runSquareBatch(ffmpeg, batch, qscale, size, blur),
    runOne: (job) => runSquareOne(ffmpeg, job, qscale, size, blur),
  });
}

/**
 * 两套卡片图（长边版 / 方形版）共用的批量循环。
 *
 * ⚠️ **为什么抽出来**：两套的失败策略必须一模一样 ——
 *   「一张图转码失败就跳过它、别把整次构建拖下水」这条是硬要求，
 *   写两遍早晚会长歪（长边版那套已经被护栏和 33 期产物钉住了，不能动）。
 *   滤镜链不同 → 传进来的 runBatch / runOne 不同，循环本身共用。
 *
 * @param {object} opts
 * @param {string} opts.label      日志前缀（「卡片图」/「方形卡片图」）
 * @param {string} opts.ffmpeg
 * @param {Array<{src:string,out:string}>} opts.jobs
 * @param {number} opts.qscale
 * @param {number} opts.batchSize
 * @param {(batch:Array)=>Promise<void>} opts.runBatch
 * @param {(job:object)=>Promise<void>} opts.runOne
 */
async function runCardJobs({ label, ffmpeg, jobs, qscale, batchSize, runBatch, runOne }) {
  const stat = { total: 0, ok: 0, failed: 0, bytes: 0 };
  if (!ffmpeg || typeof ffmpeg !== 'string') {
    console.warn(`  ! ${label}：没拿到 ffmpeg 路径，跳过（不影响出图）`);
    return stat;
  }
  const list = (Array.isArray(jobs) ? jobs : []).filter((j) => j && j.src && j.out);
  stat.total = list.length;
  if (!list.length) return stat;

  const size = Math.max(1, Math.floor(Number(batchSize) || CARD_BATCH_SIZE));

  // 输出目录按第一个任务的路径建（同一个栏的卡片都在一个目录里）
  await fs.mkdir(path.dirname(list[0].out), { recursive: true });

  for (let i = 0; i < list.length; i += size) {
    const batch = list.slice(i, i + size);
    let batchOk = true;
    try {
      await runBatch(batch);
    } catch (err) {
      batchOk = false;
      console.warn(`  ! ${label}批次失败（${batch.length} 张，转成单张重试）：${errText(err)}`);
    }

    for (const job of batch) {
      if (batchOk) {
        const bytes = await sizeOf(job.out);
        if (bytes > 0) {
          stat.ok += 1;
          stat.bytes += bytes;
          continue;
        }
        // ffmpeg 退出码 0 不代表每个文件都写出来了 —— 空文件跟没有一样是裂图。
        console.warn(`  ! ${label} ${path.basename(job.out)} 没写出来，改成单张重试`);
      }
      // 单张退路：这一张真的不行就跳过它，别把整批拖下水。
      try {
        await runOne(job);
        const bytes = await sizeOf(job.out);
        if (bytes > 0) {
          stat.ok += 1;
          stat.bytes += bytes;
          continue;
        }
        throw new Error('产物是空文件');
      } catch (err) {
        stat.failed += 1;
        console.warn(`  ! ${label}跳过 ${path.basename(job.out)}：${errText(err)}`);
        // 别把 0 字节的产物留在目录里 —— 线上看着像有图，其实是裂的。
        await fs.rm(job.out, { force: true }).catch(() => {});
      }
    }
  }
  return stat;
}

/* ------------------------------------------------------------ CLI 自测入口 */

function usage() {
  console.log(`卡片图批量生成（自测入口）

  node tools/build-cards.mjs --ffmpeg "<ffmpeg 路径>" --out-dir "<输出目录>" --input "<a.webp>" [--input "<b.webp>" ...]

  --ffmpeg   ffmpeg 可执行文件的绝对路径（必填）
  --out-dir  卡片图的输出目录（必填）
  --input    输入 webp 的绝对路径，可重复给多次
  --quality  JPEG 质量（默认 ${CARD_QUALITY}）
  --max-edge 长边上限（默认 ${CARD_MAX_EDGE}）`);
}

async function main() {
  const argv = process.argv.slice(2);
  let ffmpeg = '';
  let outDir = '';
  let quality = CARD_QUALITY;
  let maxEdge = CARD_MAX_EDGE;
  const inputs = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ffmpeg') ffmpeg = argv[++i] || '';
    else if (a === '--out-dir') outDir = argv[++i] || '';
    else if (a === '--input') inputs.push(argv[++i] || '');
    else if (a === '--quality') quality = Number(argv[++i]);
    else if (a === '--max-edge') maxEdge = Number(argv[++i]);
    else if (a === '--help' || a === '-h') { usage(); return 0; }
    else { console.error(`不认识的参数：${a}`); usage(); return 1; }
  }
  if (!ffmpeg || !outDir || !inputs.length) {
    console.error('缺少 --ffmpeg / --out-dir / --input');
    usage();
    return 1;
  }

  const jobs = inputs.map((src) => ({
    src,
    out: path.join(outDir, cardFileName(src)),
  }));
  const res = await buildCards({ ffmpeg, jobs, quality, maxEdge });
  console.log('');
  console.log(`处理 ${res.total} 张：成功 ${res.ok}，失败 ${res.failed}`);
  console.log(`合计 ${(res.bytes / 1024).toFixed(1)} KB`);
  for (const j of jobs) {
    const bytes = await sizeOf(j.out);
    console.log(`  ${path.basename(j.out).padEnd(24)} ${String(bytes).padStart(8)} 字节`);
  }
  return res.failed ? 1 : 0;
}

// ⚠️ Windows 上必须用 pathToFileURL(process.argv[1]).href ——
// 手写 `file://${argv[1]}` 会得到三个斜杠（file:///E:/...），入口根本不跑（exit 0 但零输出）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error('卡片图自测失败：', err && err.message ? err.message : err);
      process.exitCode = 1;
    });
}
