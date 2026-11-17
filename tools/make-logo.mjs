#!/usr/bin/env node
/**
 * 生成站点 logo 的两套尺寸
 *
 *   site/assets/logo.jpg   640x640 —— 微信分享卡片缩略图（og:image）
 *   site/assets/logo.webp  96x96  —— 页面顶部的行内小图标
 *
 * 用法：node tools/make-logo.mjs [源图路径]
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SRC = process.argv[2] || path.join(ROOT, 'site', 'assets', 'logo-source.jpg');
const OUT_DIR = path.join(ROOT, 'site', 'assets');

/**
 * 找 ffmpeg。
 *
 * Windows 用 `where`（cmd.exe 内建命令），macOS/Linux 用 `which`（那边没有 `where`）；
 * 可执行文件名也跟着平台走：Windows 是 ffmpeg.exe，macOS/Linux 是 ffmpeg。
 */
async function findBin(name) {
  const isWin = process.platform === 'win32';
  const candidates = [];
  try {
    const { stdout } = isWin
      ? await execFileAsync('where', [name], { shell: 'cmd.exe' })
      : await execFileAsync('which', [name]);
    candidates.push(...stdout.split(/\r?\n/).filter(Boolean));
  } catch { /* not on PATH */ }
  if (isWin) {
    const wingetRoot = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const pkg of await fs.readdir(wingetRoot)) {
        if (!pkg.toLowerCase().includes('ffmpeg')) continue;
        candidates.push(path.join(wingetRoot, pkg, 'ffmpeg-9.0.2-full_build', 'bin', `${name}.exe`));
      }
    } catch { /* no winget dir */ }
    candidates.push('C:\\Program Files\\ffmpeg\\bin', 'C:\\ffmpeg\\bin');
  } else {
    candidates.push(
      '/opt/homebrew/bin',        // Apple Silicon 上的 Homebrew
      '/usr/local/bin',           // Intel 上的 Homebrew
      '/opt/local/bin',           // MacPorts
      '/usr/bin',                 // 系统自带目录
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
    ? `找不到 ${name}.exe`
    : `找不到 ${name}（macOS 上用 brew install ffmpeg）`);
}

async function main() {
  try {
    await fs.access(SRC);
  } catch {
    throw new Error(`源图不存在：${SRC}`);
  }

  const ffmpeg = await findBin('ffmpeg');
  await fs.mkdir(OUT_DIR, { recursive: true });

  // 卡片图：640 方形，JPEG 白底
  await execFileAsync(ffmpeg, [
    '-y', '-loglevel', 'error',
    '-i', SRC,
    '-vf', 'scale=640:640:flags=lanczos',
    '-q:v', '3',
    path.join(OUT_DIR, 'logo.jpg'),
  ]);

  // 行内小图：96 方形，WebP
  await execFileAsync(ffmpeg, [
    '-y', '-loglevel', 'error',
    '-i', SRC,
    '-vf', 'scale=96:96:flags=lanczos',
    '-c:v', 'libwebp', '-quality', '92', '-compression_level', '6',
    path.join(OUT_DIR, 'logo.webp'),
  ]);

  const jpg = await fs.stat(path.join(OUT_DIR, 'logo.jpg'));
  const webp = await fs.stat(path.join(OUT_DIR, 'logo.webp'));
  console.log(`logo.jpg  ${(jpg.size / 1024).toFixed(1)} KB  (分享卡片)`);
  console.log(`logo.webp ${(webp.size / 1024).toFixed(1)} KB  (页内图标)`);
}

main().catch((e) => {
  console.error('生成失败:', e.message);
  process.exit(1);
});
