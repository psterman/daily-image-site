#!/usr/bin/env node
/**
 * WebP 尺寸解析器测试：把 tools/webp.mjs 的解析结果和 ffprobe 逐个文件对比。
 *
 * 为什么要有这个测试：webpSize 是手写的字节偏移解析，
 * 偏移写错一位不会报错，只会安静地给出错的宽高 ——
 * 页面上的图片会按错误的尺寸排版（缩略图裁切位置不对），
 * 而构建日志一切正常。所以必须和 ffprobe 对答案。
 *
 * 用法：
 *   node tools/test-webp.mjs
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webpSize } from './webp.mjs';
import { ROOT, R2_LOCAL } from './paths.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 找 ffprobe。
 *
 * Windows 用 `where`（cmd.exe 内建命令），macOS/Linux 用 `which`（那边没有 `where`）；
 * 可执行文件名也跟着平台走：Windows 是 ffprobe.exe，macOS/Linux 是 ffprobe。
 */
async function findFfprobe() {
  const isWin = process.platform === 'win32';
  const candidates = [];
  try {
    const { stdout } = isWin
      ? await execFileAsync('where', ['ffprobe'], { shell: 'cmd.exe' })
      : await execFileAsync('which', ['ffprobe']);
    candidates.push(...stdout.split(/\r?\n/).filter(Boolean));
  } catch { /* not on PATH */ }
  if (isWin) {
    const wingetRoot = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const pkg of await fs.readdir(wingetRoot)) {
        if (!pkg.toLowerCase().includes('ffmpeg')) continue;
        candidates.push(path.join(wingetRoot, pkg, 'ffmpeg-9.0.2-full_build', 'bin', 'ffprobe.exe'));
      }
    } catch { /* no winget dir */ }
  } else {
    candidates.push(
      '/opt/homebrew/bin',        // Apple Silicon 上的 Homebrew
      '/usr/local/bin',           // Intel 上的 Homebrew
      '/opt/local/bin',           // MacPorts
      '/usr/bin',                 // 系统自带目录
    );
  }
  const exeName = isWin ? 'ffprobe.exe' : 'ffprobe';
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
    ? '找不到 ffprobe.exe，无法做对照测试'
    : '找不到 ffprobe，无法做对照测试（macOS 上用 brew install ffmpeg）');
}

async function ffprobeSize(ffprobe, file) {
  const { stdout } = await execFileAsync(ffprobe, [
    '-v', 'quiet',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0:s=x',
    file,
  ]);
  const [w, h] = stdout.trim().split('x').map(Number);
  return { w, h };
}

async function collectWebp(dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await collectWebp(p, out);
    else if (/\.webp$/i.test(e.name)) out.push(p);
  }
  return out;
}

async function main() {
  let ffprobe;
  try {
    ffprobe = await findFfprobe();
  } catch (err) {
    // ffprobe 是**前置依赖**，不是代码坏了 → 跳过（退出码 2），别报红。
    // 红表示「有东西不对」，跳过表示「条件不具备」—— 两回事，别混。
    console.error('跳过：' + (err && err.message ? err.message : String(err)));
    process.exit(2);
  }
  console.log(`ffprobe : ${ffprobe}\n`);

  const files = [
    ...(await collectWebp(R2_LOCAL)),
    ...(await collectWebp(path.join(ROOT, 'published', 'img'))),
  ];
  if (!files.length) {
    // 0 个文件 = **什么都没测** → 报绿就是假绿。
    // 显式跳过（退出码 2），跟「跑批器」里的「跳过」单列对上。
    console.log('跳过：没有可测的 webp 文件（先跑一次构建，或把 IMAGE_ROOT 指到有母本的目录）');
    process.exit(2);
  }
  console.log(`待测文件 : ${files.length} 个\n`);

  let pass = 0;
  const fails = [];
  const variants = new Map();
  const t0 = Date.now();

  for (const f of files) {
    let mine;
    let theirs;
    try {
      mine = await webpSize(f);
    } catch (err) {
      fails.push({ f, reason: `解析失败: ${err.message}` });
      continue;
    }
    try {
      theirs = await ffprobeSize(ffprobe, f);
    } catch (err) {
      fails.push({ f, reason: `ffprobe 失败: ${err.message}` });
      continue;
    }
    const fd = await fs.open(f, 'r');
    const buf = Buffer.alloc(16);
    await fd.read(buf, 0, 16, 0);
    await fd.close();
    const fourcc = buf.toString('ascii', 12, 16);
    variants.set(fourcc, (variants.get(fourcc) || 0) + 1);

    if (mine.w === theirs.w && mine.h === theirs.h) pass++;
    else fails.push({ f, reason: `尺寸不一致: 解析 ${mine.w}x${mine.h} vs ffprobe ${theirs.w}x${theirs.h}` });
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`变体分布 : ${[...variants].map(([k, v]) => `${k}=${v}`).join('  ')}`);
  console.log(`解析耗时 : ${secs}s（含 ffprobe 对照）\n`);

  if (fails.length) {
    console.log(`✗ 失败 ${fails.length}/${files.length}`);
    for (const x of fails.slice(0, 10)) console.log(`  ${path.relative(ROOT, x.f)}  ${x.reason}`);
    process.exit(1);
  }
  console.log(`✓ 全部通过：${pass}/${files.length} 个文件的宽高与 ffprobe 完全一致`);
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
