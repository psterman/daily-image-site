#!/usr/bin/env node
/**
 * 起定时任务台（独立进程、无控制台、**不在父进程的 Job Object 里**）。
 *
 * 跟 tools/start-review.mjs 同一个套路（**照抄它的结构**）：
 *   进程监督器给会话建了带 KILL_ON_JOB_CLOSE 的 Job，Job 一关里面的进程被强杀
 *   （无 stderr、无退出码 —— 症状跟「程序自己崩了」一模一样）。
 *   detached 挡不住（Node 的 spawn 没有 CREATE_BREAKAWAY_FROM_JOB），
 *   只有让 **explorer.exe 去起**（Explorer 本身不在任何 Job 里）才躲得开。
 *
 * ⚠️ **浏览器由「直接起服务的那个进程」来开**（规则就这一句，别搞出两个进程各开一次）：
 *   - `--direct`（根目录 .cmd 调的就是它）→ 起服务 + 等端口 + **开浏览器**
 *   - Windows 默认路径 → 经 explorer.exe → .cmd → `--direct` → **内层开浏览器**
 *     （外层只等端口、打印 URL，**不再开**，否则开两个标签页）
 *   - macOS / Linux 默认路径 → 没有内层 → 外层自己起 + 自己开
 *
 * 用法：
 *   node tools\start-dashboard.mjs            # 经 explorer.exe 脱身（推荐）
 *   node tools\start-dashboard.mjs --direct   # 直接起（由 起任务台.cmd 调用）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIRECT = process.argv.includes('--direct');
const PORT_FILE = path.join(ROOT, '.night-dashboard-port');
const PID_FILE = path.join(ROOT, '.night-dashboard.pid');
const SERVER = path.join(__dirname, 'night-dashboard.mjs');

/** 端口上有没有服务在应答。 */
function portAlive(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let done = false;
    const fin = (v) => { if (!done) { done = true; s.destroy(); resolve(v); } };
    s.on('connect', () => fin(true));
    s.on('error', () => fin(false));
    s.setTimeout(800, () => fin(false));
  });
}

function readPort() {
  try {
    const p = Number(fs.readFileSync(PORT_FILE, 'utf8').trim());
    return Number.isInteger(p) && p > 1023 && p < 65536 ? p : null;
  } catch {
    return null;
  }
}

/**
 * 打开页面。**照抄仓库既有惯例**（tools/review.mjs:1700-1709）：
 * Windows 用 `cmd /c start`，macOS 用 `open`，其他用 `xdg-open`。
 * ⚠️ 端口可能顺延 → 一定要用**实际端口**的 URL，不能写死 8801。
 * ⚠️ `start` 的第一个带引号参数会被当成标题 → 标题位置传空串 `''`（跟 review.mjs 一样）。
 */
function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {
    console.log('  （自动打开浏览器失败，手动打开 ' + url + '）');
  }
}

function startDirect() {
  const out = fs.openSync(path.join(ROOT, '.night-dashboard.out.log'), 'a');
  const err = fs.openSync(path.join(ROOT, '.night-dashboard.err.log'), 'a');
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT, detached: true, stdio: ['ignore', out, err],
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  return child.pid;
}

/** 等端口真的应答了才返回（端口文件是服务自己写的）。 */
async function waitForPort(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const p = readPort();
    if (p && await portAlive(p)) return p;
  }
  return null;
}

/** 已经有一个在跑就别起第二个 —— 直接把页面打开。 */
async function openExisting() {
  const existing = readPort();
  if (existing && await portAlive(existing)) {
    const url = 'http://127.0.0.1:' + existing + '/';
    console.log(url);
    openBrowser(url);
    return true;
  }
  return false;
}

async function startAndOpen() {
  startDirect();
  const p = await waitForPort(20000);
  if (!p) {
    console.error('任务台没能在 20 秒内起来（看 .night-dashboard.err.log）。');
    process.exit(1);
  }
  const url = 'http://127.0.0.1:' + p + '/';
  console.log(url);
  openBrowser(url);
}

if (DIRECT) {
  /* 根目录 .cmd 调的就是这条路径 → **双击入口必须能打开页面**。 */
  if (await openExisting()) process.exit(0);
  await startAndOpen();
  process.exit(0);
}

/* ---------- 默认路径 ---------- */

/* macOS / Linux：没有 Job Object 这回事，直接 detached 起。 */
if (process.platform !== 'win32') {
  if (await openExisting()) process.exit(0);
  await startAndOpen();
  process.exit(0);
}

/* ---------- Windows 默认路径：经 explorer.exe 脱身 Job Object ---------- */

const launcher = path.join(ROOT, '起任务台.cmd');
try {
  spawn('explorer.exe', [launcher], { detached: true, stdio: 'ignore' }).unref();
} catch (e) {
  console.error('调用 explorer.exe 失败：' + e.message + ' —— 退回直接启动。');
  if (await openExisting()) process.exit(0);
  await startAndOpen();   /* 退化路径：没有内层 --direct，浏览器得外层来开 */
  process.exit(0);
}

/* 外层只等端口、打印 URL —— **浏览器由内层的 --direct 进程开**，避免开两个标签页。 */
const p = await waitForPort(20000);
if (!p) {
  console.error('任务台没能在 20 秒内起来（看 .night-dashboard.err.log）。');
  process.exit(1);
}
console.log('http://127.0.0.1:' + p + '/');
process.exit(0);
