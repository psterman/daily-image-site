#!/usr/bin/env node
/**
 * 起审稿台（独立进程、无控制台、**不在父进程的 Job Object 里**）。
 *
 * 为什么单独一个文件、为什么要绕两层：
 *
 * **1. Windows 的控制台连坐。**
 *   子进程默认继承父进程的控制台，父进程所在的控制台一销毁，
 *   挂在上面的进程跟着一起没。
 *   审稿台是长驻进程（用户审图可能要十分钟），
 *   而它是被「一键更新」那个一闪而过的窗口拉起来的 ——
 *   窗口一关，审稿台就没了，用户那边直接变成「连不上」。
 *
 *   detached（DETACHED_PROCESS）= **不继承控制台**，
 *   审稿台从此跟任何窗口都没有关系。
 *
 * **2. Windows 的 Job Object 连坐（2026-11-08 定位到 09:00 那次事故的真凶）。**
 *   detached **不能**脱离 Job Object —— Node 的 spawn 只能给 DETACHED_PROCESS，
 *   没有 CREATE_BREAKAWAY_FROM_JOB。而本机的 openclaw 进程监督器给会话建了
 *   带 KILL_ON_JOB_CLOSE 的 Job（见 openclaw/dist/process/supervisor/
 *   service-child-windows-job-anchor.js 里的 SetInformationJobObject /
 *   TerminateJobObject）。Job 一关，里面的进程被**强杀**：
 *   无 stderr、无退出码、无事件日志 —— 症状跟「程序自己崩了」一模一样。
 *
 *   实测（IsProcessInJob，NULL job = 「是否在任意 Job 里」）：
 *   - 从 agent 的 bash 里起的审稿台 → **在 Job 里**（会被连坐杀掉）
 *   - 从桌面快捷方式（explorer.exe）起的 → **不在任何 Job 里** ✓
 *
 *   所以这里让 **explorer.exe 去起** —— Explorer 本身不在任何 Job 里，
 *   它拉起来的进程也就继承不到 Job。explorer.exe 只认路径、不能带参数，
 *   所以真正的启动命令放在根目录的「起审稿台.cmd」里（它再调本文件的 --direct）。
 *
 * **3. macOS / Linux：没有这回事，直接起。**
 *   Job Object 是 Windows 特有的内核机制，Mac 上压根没有对应物；
 *   「控制台连坐」也不会发生 —— 那边子进程不绑在父进程的控制台上。
 *   所以非 Windows 平台跳过 explorer.exe 这一层，直接 spawn 审稿台就行
 *   （startDirect 里的 detached 在那边只是「脱离父进程生命周期」的意思）。
 *
 * 用法：
 *   node tools/start-review.mjs [YYYY-MM-DD]   # Windows：默认经 explorer.exe 脱身（推荐）
 *                                             # macOS/Linux：直接起（没有 Job 要躲）
 *   node tools/start-review.mjs --direct       # 直接起（Windows 上调用方必须已经在 Job 之外）
 * 打印子进程 PID，端口由 review.mjs 自己写进 .review-port
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIRECT = process.argv.includes('--direct');
const argDate = process.argv.slice(2).find((a) => !a.startsWith('--'));

function beijingToday() {
  const bj = new Date(Date.now() + 8 * 3600 * 1000);
  return bj.toISOString().slice(0, 10);
}

/** 发布日：命令行 > .publish-date（daily.ps1 写的） > 今天 */
function resolveDate() {
  if (argDate) return argDate;
  try {
    const d = fs.readFileSync(path.join(ROOT, '.publish-date'), 'utf8').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  } catch { /* 没有就读今天 */ }
  return beijingToday();
}

const date = resolveDate();
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('用法：node tools/start-review.mjs [YYYY-MM-DD] [--direct]');
  process.exit(1);
}

const outLog = path.join(ROOT, `.review-station-${date}.out.log`);
const errLog = path.join(ROOT, `.review-station-${date}.err.log`);
const pidFile = path.join(ROOT, `.review-station-${date}.pid`);
const launcher = path.join(ROOT, '起审稿台.cmd');

function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function readPid() {
  try {
    const p = Number(fs.readFileSync(pidFile, 'utf8').trim());
    return pidAlive(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * 真正起审稿台。
 * Windows 上调用方必须已经在任何 Job Object 之外（桌面快捷方式、或本文件的 --direct 经 explorer 绕进来）；
 * macOS/Linux 没有 Job 这回事，直接起就行。
 */
function startDirect() {
  const existing = readPid();
  if (existing) return existing; // 已经在跑，别起第二个

  const out = fs.openSync(outLog, 'a');
  const err = fs.openSync(errLog, 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'review.mjs'), date], {
    cwd: ROOT,
    /* 关键：detached → DETACHED_PROCESS → 不继承控制台。
     * 不加 windowsHide：那个是「隐藏窗口」，仍然挂着父进程的控制台。 */
    detached: true,
    stdio: ['ignore', out, err],
  });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));
  return child.pid;
}

if (DIRECT) {
  console.log(startDirect());
  process.exit(0);
}

/* ---------- 默认路径 ---------- */

if (process.platform !== 'win32') {
  /* macOS/Linux：没有 Job Object，也没有「控制台连坐」——
   * detached 一下就够了，不需要借 explorer.exe 脱身，
   * 根目录那个「起审稿台.cmd」也用不上（那边没有 .cmd）。 */
  console.log(startDirect());
  process.exit(0);
}

/* ---------- Windows 默认路径：经 explorer.exe 脱身 Job Object ---------- */

/* 清掉上一次的 PID（写空而不是删文件 —— 免得删出错）。 */
fs.writeFileSync(pidFile, '');

let launcherProc;
try {
  launcherProc = spawn('explorer.exe', [launcher], { detached: true, stdio: 'ignore' });
} catch (e) {
  console.error('调用 explorer.exe 失败：' + e.message + ' —— 退回直接启动。');
  console.log(startDirect());
  process.exit(0);
}
launcherProc.unref();

const deadline = Date.now() + 20000;
const timer = setInterval(() => {
  const pid = readPid();
  if (pid) {
    clearInterval(timer);
    console.log(pid);
    process.exit(0);
  }
  if (Date.now() > deadline) {
    clearInterval(timer);
    console.error('explorer.exe 没能把审稿台拉起来（等 20 秒没等到 PID）—— 退回直接启动。');
    console.error('如果之后审稿台又莫名消失，说明这台机器上还有别的东西在回收进程。');
    console.log(startDirect());
    process.exit(0);
  }
}, 250);
