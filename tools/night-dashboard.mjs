#!/usr/bin/env node
/**
 * 定时任务台：本地 HTTP 服务。
 *
 * 只绑 127.0.0.1。状态全部从磁盘推导（见 night-dashboard-state.mjs）——
 * 不调 Cloudflare API，不花 token，线上挂了也不影响你看历史。
 *
 * 四个接口：
 *   GET  /api/state          今天的状态 + 15 节点 + 历史 + 可用操作
 *   GET  /api/log?date=      某天的日志尾部
 *   POST /api/run-now        立刻重跑今天这一期
 *   POST /api/republish      补发某一天
 *
 * 写操作是**不可逆对外动作** → 服务端只做「本机 + 跨站」两道门，
 * 不可逆性由页面上的二次确认条承担（文案见 spec §8.3）。
 *
 * ⚠️ 写操作默认**关着**（allowWrite 默认 false）。只有命令行入口显式打开 ——
 *    任何「import 了这个模块来测试」的场景都不会真的发起一次发布。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROOT, srcSearchRoots, findDatedDir } from './paths.mjs';
import {
  parseDone, buildCurrent, buildHistory, pickProblem, stepMedians,
} from './night-dashboard-state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, 'dashboard-ui');
const PORT_FILE = process.env.NIGHT_DASHBOARD_PORT_FILE || path.join(ROOT, '.night-dashboard-port');
const DEFAULT_PORT = 8801;
const TASK_NAME = 'DailyImageSite-NightPublish-0010';

/**
 * PowerShell 可执行文件 —— **不许硬编码 `powershell.exe`**。
 *
 * 为什么：macOS 上根本没有这个文件 → spawnSync 直接 ENOENT →
 * 探测「有没有发布在跑」永远返回 false → 撞上夜间任务时两道门形同虚设。
 * macOS 那边装的是 PowerShell 7（`pwsh`），跑的是同一份 .ps1。
 * （仓库既有惯例：tools/test-night-flow.mjs、tools/test-daily-review.mjs）
 */
const PS_EXE = process.platform === 'win32' ? 'powershell' : 'pwsh';

/**
 * 探测「有没有发布在跑」时，**只看进程名像 PowerShell 的那些**。
 *
 * ⚠️ 为什么用正则而不是一份按平台列出来的名字清单：
 *   Windows 上 PowerShell 的映像名带 `.exe`、macOS 上不带 —— 写成
 *   `'powershell.exe'` 那种字面量就会把平台绑死（而且 macOS 上永远匹配不到）。
 *   正则 `powershell|pwsh` 在两个平台上都覆盖得到：
 *     Windows → `powershell.exe` / `pwsh.exe`  ✓
 *     macOS   → `pwsh` / `powershell`          ✓
 */
const PS_PROC_NAME_RE = 'powershell|pwsh';

/**
 * 计划任务 `LastTaskResult` 里两个**不是失败**的码（Windows 的 `SCHED_S_*`）。
 *
 * ⚠️ **267009（0x41301 = SCHED_S_TASK_RUNNING）= 「它正在跑」** ——
 *   Windows 在任务**运行期间**就把 `LastTaskResult` 报成这个码。
 *   把它当成「上次跑挂了」→ **每晚发布进行中都会误报**（2026-11-21 实测）。
 * ⚠️ 267011（0x41303 = SCHED_S_TASK_HAS_NOT_RUN）= 「从未运行过」，也不是失败。
 */
const SCHED_RESULT_RUNNING = 267009;
const SCHED_RESULT_NEVER_RUN = 267011;

/** 同一个问题只通知一次，别每 3 秒弹一次。 */
const notifiedFor = new Set();
function problemKey(p) { return (p.title || '') + '|' + (p.detail || ''); }

/**
 * 发 toast（尽力而为，失败静默）。
 *
 * ⚠️ **不许硬编码 `powershell.exe`** —— macOS 上根本没这个文件 → spawn ENOENT。
 *    Windows 用 `powershell`（PS 5.1），macOS 用 `pwsh`（PS 7）。
 *    复用 `night-dashboard.mjs` 里已有的 `PS_EXE` 常量。
 * ⚠️ macOS 走 `osascript`（spec §8.4）—— 那边没有 WinRT。
 * ⚠️⚠️ **Windows 上必须走 `detachedPowerShell()`**（Task 4 修复轮 2 实测）：
 *    直接 `spawn(PS_EXE, […], { detached: true })` 会让 PowerShell **立刻退出（exit 0）**
 *    → **toast 根本发不出去，而且不报错**（静默失败，最难查）。
 *    `detachedPowerShell` 是同一个模块里已 export 的函数，直接调即可。
 */
function notifyToast(title, body) {
  if (process.platform === 'darwin') {
    try {
      spawn('/usr/bin/osascript',
        ['-e', 'display notification ' + JSON.stringify(body) + ' with title ' + JSON.stringify(title)],
        { cwd: ROOT, detached: true, stdio: 'ignore' }).unref();
    } catch { /* 发不出去就算了 */ }
    return;
  }
  if (process.platform !== 'win32') return;
  const script = path.join(ROOT, 'tools', 'notify.ps1');
  try {
    const argv = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-Title', title, '-Body', body];
    const d = detachedPowerShell(PS_EXE, argv, { cwd: ROOT });
    spawn(d.cmd, d.args, d.opts).unref();
  } catch { /* 发不出去就算了 */ }
}

/* ── 小工具 ─────────────────────────────────────────────── */

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function fileExists(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

/**
 * 只读文件**尾部** n 字节（spec §9「日志变大」→ 每次只读尾部 64KB）。
 * 用 fs.stat 拿大小再定位读，不要 readFileSync 整份。
 */
function readTail(file, n) {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, n);
    const start = Math.max(0, st.size - len);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** 北京今天的 'YYYY-MM-DD'（按北京时间，不按机器本地时区）。 */
export function todayBj() {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(d);
}

/* ── PowerShell ─────────────────────────────────────────── */

/** 跑一段 PowerShell 并拿 stdout（同步，短命令）。 */
function execPowerShell(script, cwd) {
  const r = spawnSync(PS_EXE, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { cwd: cwd || ROOT, encoding: 'utf8', timeout: 20000, windowsHide: true });
  return r.stdout || '';
}

/**
 * 当前有没有发布在跑（写操作前要挡一下）。
 *
 * ⚠️ **五个脚本名都要认**：
 *   夜间流程的「1/2 准备」阶段跑的是 `daily-review.ps1`（真实数据约 15 分钟，
 *   是整个夜间最长的一段），只认 `publish*.ps1` 会在准备阶段漏判「没在跑」→
 *   于是允许在准备阶段再起一次发布 → 两个进程同时往线上推。
 *
 * ⚠️ 结果**缓存 10 秒**：页面会轮询（3 秒一次），每次都 spawn 一次
 *   PowerShell 扛不住（Get-CimInstance Win32_Process 单次约 0.2–0.5 秒）。
 */
let _busyCache = { at: 0, value: false };
function isBusy() {
  const now = Date.now();
  if (now - _busyCache.at < 10000) return _busyCache.value;
  let value = false;
  try {
    const out = execPowerShell(
      'Get-CimInstance Win32_Process | ' +
      "Where-Object { $_.Name -match '" + PS_PROC_NAME_RE + "' -and " +
      "$_.CommandLine -match 'publish\\.ps1|night-publish\\.ps1|manual-publish\\.ps1|daily-review\\.ps1|daily\\.ps1' } | " +
      'Select-Object -First 1 -ExpandProperty ProcessId');
    value = !!String(out || '').trim();
  } catch {
    value = false;
  }
  _busyCache = { at: now, value };
  return value;
}

/**
 * 计划任务「上次结果码」这条 info 判据（spec §6.2）。
 *
 * ⚠️⚠️ **267009（0x41301 = SCHED_S_TASK_RUNNING）不是「上次跑挂了」，是「它正在跑」** ——
 *   Windows 在计划任务**运行期间**就把 `LastTaskResult` 报成这个码
 *   （2026-11-21 00:23 实测：今晚这一轮正在跑，`LastTaskResult` 就是 267009）。
 *   不排除掉的话，**每天晚上发布进行中**任务台都会弹一条
 *   「上一次运行没有正常结束」→ **天天误报**，用户还以为出事了。
 * ⚠️ 267011（0x41303 = SCHED_S_TASK_HAS_NOT_RUN，「从未运行」）也不是失败。
 * ⚠️ `sched.state` 也是 `'Running'` → 两条判据互为印证。
 *
 * ⚠️ 这是**纯函数**（不读系统、不碰 I/O）→ 护栏能单独把它拿出来测，
 *   不用真的去动计划任务。
 *
 * @returns {null|{level:string,title:string,detail:string,stepKey:null}}
 */
export function scheduleProblem(sched) {
  if (!sched || !sched.available) return null;
  const r = sched.lastResult;
  if (!Number.isFinite(r) || r === 0) return null;
  if (r === SCHED_RESULT_RUNNING || r === SCHED_RESULT_NEVER_RUN) return null;
  if (sched.state === 'Running') return null;   /* 正在跑 → 这不是「上次」的结果 */
  return {
    level: 'info',
    title: '计划任务上次结果码 ' + r,
    detail: '计划任务「' + sched.name + '」上一次运行没有正常结束。',
    stepKey: null,
  };
}

/**
 * 读计划任务状态（真读，不带缓存）。读不到就降级成 available:false —— 不许整页报错。
 */
function readScheduleFresh() {
  const empty = {
    available: false, name: TASK_NAME, state: null,
    lastRunTime: null, lastResult: null, nextRunTime: null,
  };
  try {
    /* 用模板串拼：里面的 PowerShell 单引号不用转义。
       （别写成 `${...}` —— PowerShell 的子表达式是 `$(`，模板串里安全。） */
    const ps = `
$ErrorActionPreference = 'Stop'
$t = Get-ScheduledTask -TaskName ${JSON.stringify(TASK_NAME)} -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $t) { exit 0 }
$i = Get-ScheduledTaskInfo -TaskName ${JSON.stringify(TASK_NAME)} -ErrorAction SilentlyContinue
[pscustomobject]@{
  state       = [string]$t.State
  lastRunTime = $(if ($i -and $i.LastRunTime) { $i.LastRunTime.ToString('o') } else { '' })
  lastResult  = $(if ($i) { [int]$i.LastTaskResult } else { 0 })
  nextRunTime = $(if ($i -and $i.NextRunTime) { $i.NextRunTime.ToString('o') } else { '' })
} | ConvertTo-Json -Compress`;
    const out = execPowerShell(ps);
    if (!out || !out.trim()) return empty;
    const j = JSON.parse(out.trim().split(/\r?\n/).filter(Boolean).pop());
    return {
      available: true, name: TASK_NAME, state: j.state,
      lastRunTime: j.lastRunTime || null, lastResult: j.lastResult,
      nextRunTime: j.nextRunTime || null,
    };
  } catch {
    return empty;
  }
}

/**
 * 读计划任务状态 —— **带 10 秒缓存**（评审 m-1）。
 *
 * ⚠️ 为什么必须缓存：页面 3 秒轮询一次 `/api/state`，不缓存的话
 *    每 3 秒就 spawn 一次 PowerShell（实测单次 0.2–0.5 秒）——
 *    一半的轮询时间都花在等子进程上。
 *    跟 `isBusy()` 同一个套路。计划任务状态晚 10 秒才更新，没有副作用。
 */
let _schedCache = { at: 0, value: null };
function readSchedule() {
  const now = Date.now();
  if (now - _schedCache.at < 10000 && _schedCache.value) return _schedCache.value;
  const value = readScheduleFresh();
  _schedCache = { at: now, value };
  return value;
}

/* ── 找日志 ─────────────────────────────────────────────── */

/**
 * 找出某一天该看哪份日志。
 *
 * ⚠️ **必须按 `.done` 的 `by` 来选，不能「按固定顺序取第一个存在的」。**
 *   `manual-publish.ps1` 与夜间流程**共用同一个** `.night-publish-<日期>.done`
 *   （手动那次带 `by:'manual'`）。若某日期 night log 与 manual log 同时存在，
 *   按固定顺序会取到 night log，而 `.done` 说的是 manual
 *   → **步骤与完成记录来自不同的那一次跑**（Task 3 评审实测出这个自相矛盾：
 *     `status="success"` + `durationMs=23 时 19 分` + 手动那次 `exit=1` 被丢弃）。
 *
 * 顺序：先按 `done.by` 匹配 → 再按「night → manual → review」退化。
 */
function findLogFor(root, date, done) {
  const candidates = [
    { source: 'night', file: path.join(root, `.night-publish-${date}.log`) },
    { source: 'manual', file: path.join(root, `.manual-publish-${date}.log`) },
    { source: 'review', file: path.join(root, `.review-publish-${date}.log`) },
  ];
  const exists = (c) => {
    try {
      const st = fs.statSync(c.file);
      return st.size > 0 ? { source: c.source, file: c.file, mtime: st.mtimeMs } : null;
    } catch { return null; }
  };
  const want = done && done.by === 'manual' ? 'manual' : 'night';
  for (const c of candidates) {
    if (c.source !== want) continue;
    const hit = exists(c);
    if (hit) return hit;
  }
  for (const c of candidates) {
    const hit = exists(c);
    if (hit) return hit;
  }
  return null;
}

/** 扫工程根，把有 .done 的日期全找出来（历史）。 */
function scanDates(root) {
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const dates = [];
  for (const n of names) {
    const m = /^\.night-publish-(\d{4}-\d{2}-\d{2})\.done$/.exec(n);
    if (m) dates.push(m[1]);
  }
  return dates.sort().reverse();
}

/* ── 状态组装 ───────────────────────────────────────────── */

function buildState(root, withSchedule) {
  const now = Date.now();
  const today = todayBj();
  const dates = scanDates(root);
  const withToday = dates.includes(today) ? dates : [today, ...dates];

  /* 进程探测**只做一次**（一次 PowerShell 调用），且**只用于今天这一夜** ——
     历史日期不可能还在跑。而且探测结果要**缓存 10 秒**：
     页面会轮询，每次都 spawn 一次 PowerShell 扛不住。 */
  const alive = isBusy();

  const history = [];
  for (const d of withToday.slice(0, 30)) {
    const done = parseDone(readText(path.join(root, `.night-publish-${d}.done`)));
    /* ⚠️ 传 done 进去：按 `.done` 的 `by` 选日志，别按固定顺序取第一个存在的。 */
    const log = findLogFor(root, d, done);
    const cur = buildCurrent({
      date: d,
      done,
      /* ⚠️ `/api/state` 要的是**全部 15 个阶段标记**（第一个标记在日志最前面），
         读尾部会把前面的步骤丢掉 → 这里必须读**整份**。
         （`/api/log` 才是只读尾部 64KB 的那一个。） */
      logText: log ? readText(log.file) : '',
      logMtime: log ? log.mtime : 0,
      now,
      /* 「进程还活着」这个**直接信号**要压过「日志没动」这个代理信号
         （Task 3 的 F7）—— 长静默的步骤（比如上传 R2）不该被判成「卡住了」。 */
      running: d === today ? alive : false,
    });
    if (cur.status === 'not-run' && d !== today) continue;
    history.push({
      date: d, status: cur.status, durationMs: cur.durationMs,
      source: cur.source, headline: cur.headline,
      /* exitCode 也要带进摘要：历史里某夜失败时，
         `pickProblem({...h}, hist)` 要靠它说清「退出码 1」，
         不带就只能显示「退出码未知」（Task 3 的 F4 兜底）。 */
      exitCode: cur.exitCode,
      /* steps 要带 `status`：Task 3 的 `pickProblem` 靠 `s.status === 'failed'`
         找「卡在哪一步」。摘要只有 `{key,durationMs}` 的话，
         历史条目里的 dead/failed 就点不出步骤名了。 */
      steps: cur.steps.map((s) => ({
        key: s.key, status: s.status, durationMs: s.durationMs, label: s.label,
      })),
    });
  }
  const hist = buildHistory(history);

  /* 今天这一份**带历史重算一次**：`buildCurrent` 里的 `pickProblem` 拿不到
     历史就算不出慢夜告警（Task 3 的 F6 —— 不传 history 时成功夜恒为 problem=null）。 */
  const todayDone = parseDone(readText(path.join(root, `.night-publish-${today}.done`)));
  const todayLog = findLogFor(root, today, todayDone);
  const todayCur = buildCurrent({
    date: today,
    done: todayDone,
    logText: todayLog ? readText(todayLog.file) : '',
    logMtime: todayLog ? todayLog.mtime : 0,
    now,
    running: alive,
    history: hist,
  });

  /* ⚠️ spec §9 有一条降级是**本 Task 的活**：「标记文件损坏」。
     `parseDone` 对坏 JSON 返回 null —— 但「文件不存在」和「文件坏了」是两回事：
     前者 = 这一夜还没跑；后者 = 跑过了但记录读不出来（得让人知道）。
     `current.doneExists` 只表示「**解析出来的**记录存在」，≠「文件存在」。
     → 这一层要在 HTTP 层自己判（读文件时看它到底在不在）。 */
  const donePath = path.join(root, `.night-publish-${today}.done`);
  const doneFileExists = fileExists(donePath);
  const doneBroken = doneFileExists && !todayDone;

  /* 问题：今天的 + 历史的慢夜，取最重的一条。 */
  /* 基线**排除今天**（Task 3 的 F5）：否则今天参与了自己基准的计算，
     慢夜告警会被自己盖掉。 */
  const med = stepMedians(hist, today);
  /* ⚠️ 第三参 `now` 要传（Task 3 修复轮 2 的 F5）：
     「今天凌晨还没跑」只在**北京时间 06:00 之后**才算问题 ——
     计划任务 00:10:10 才启动，00:00–00:10 那 10 分钟里报「没跑」是每天一次的假警报。 */
  let problem = pickProblem(todayCur, hist, { now });
  if (!problem || problem.level === 'info') {
    for (const h of hist) {
      if (h.date === today) continue;
      const p = pickProblem({ ...h, status: h.status, problem: null }, hist, { now });
      if (p && (p.level === 'error' || p.level === 'warn')) { problem = p; break; }
    }
  }

  const sched = withSchedule ? readSchedule() : null;

  /* spec §6.2 那条 info 判据（计划任务上次结果码）→ 抽成纯函数 `scheduleProblem()`，
     这样它能**单独被测**（2026-11-21 实测发现它天天误报，见下）。 */
  if (!problem || problem.level === 'info') {
    const sp = scheduleProblem(sched);
    if (sp) problem = sp;
  }
  /* spec §9「标记文件损坏」→ 也要说一句（info 级）。 */
  if (doneBroken && (!problem || problem.level === 'info')) {
    problem = {
      level: 'info',
      title: '标记文件坏了',
      detail: '`.night-publish-' + today + '.done` 存在但解析不出来 —— 这一夜跑过了，但退出码读不到。',
      stepKey: null,
    };
  }

  const republishDates = [];
  for (const d of withToday.slice(0, 30)) {
    if (findDatedDir(srcSearchRoots(), d)) republishDates.push(d);
  }

  todayCur.problem = problem;

  /* 出 error 级问题时，从服务端发一条 Windows toast —— 页面关着也收得到。 */
  try {
    if (problem && problem.level === 'error' && !notifiedFor.has(problemKey(problem))) {
      notifiedFor.add(problemKey(problem));
      notifyToast(problem.title, problem.detail || '');
    }
  } catch { /* 通知是补位，不影响主流程 */ }

  return {
    ok: true,
    serverTime: new Date().toISOString(),
    todayBj: today,
    /* 标记文件的三态（spec §9「标记文件损坏」）：
       missing = 这一夜还没跑 · broken = 跑过了但记录读不出来 · ok = 正常 */
    marker: { exists: doneFileExists, broken: doneBroken },
    schedule: sched || {
      available: false, name: TASK_NAME, state: null,
      lastRunTime: null, lastResult: null, nextRunTime: null,
    },
    current: todayCur,
    history: hist.map((h) => ({
      date: h.date, status: h.status, durationMs: h.durationMs,
      source: h.source, headline: h.headline,
    })),
    problems: problem ? [problem] : [],
    actions: {
      busy: alive,
      canRunNow: true,
      republishDates,
      stepMedians: Object.fromEntries(med),
    },
  };
}

/* ── 写操作 ─────────────────────────────────────────────── */

/**
 * 本机 + 跨站两道门。
 *
 * ⚠️ Origin 白名单用**服务实际监听的端口** —— 端口顺延后如果写死 8801，
 *    同源页面自己的 POST 会被判成跨站 403（审稿台 `tools/review.mjs` 踩过这个坑：
 *    那里把 8789 写死了）。
 *
 * @param chosenPort 服务**实际**监听的端口（不是配置里那个默认端口）
 */
function guard(req, chosenPort) {
  const remote = req.socket.remoteAddress || '';
  if (!/^(::1|::ffff:127\.|127\.)/.test(remote)) return '只允许本机触发';
  const origin = req.headers.origin;
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch { host = ''; }
    const allowed = new Set(['localhost:' + chosenPort, '127.0.0.1:' + chosenPort]);
    if (!allowed.has(host)) return '跨站请求被拒绝';
  }
  return null;
}

/**
 * 起一个**脱离本进程**的 PowerShell。
 *
 * ⚠️ **Windows 必须走 `cmd /c start /b`**（2026-11-20 实测）：
 *   `spawn('powershell', [...], { detached: true })` 会让 PowerShell **立刻退出（exit 0）**、
 *   脚本根本没跑 —— DETACHED_PROCESS 给了它一个没有控制台的运行环境，PowerShell 5.1 直接罢工。
 *   `cmd /c start /b` 则：cmd 立刻返回，被拉起的 PowerShell **正常跑，而且父进程退出后它还活着**。
 *   （node / cmd 自己的 detached 没问题，**只有 PowerShell 有这个毛病**。）
 *
 * ⚠️ `start` 的**第一个带引号的参数会被当成标题** → 标题位置传空串 `''`，
 *   这样路径里带空格也不会被误吞。
 *
 * ⚠️ macOS / Linux：POSIX 的 `detached`（setsid）没问题，直接起，不用绕 cmd。
 */
export function detachedPowerShell(exe, argv, extra = {}) {
  if (process.platform === 'win32') {
    return {
      cmd: 'cmd',
      args: ['/c', 'start', '', '/b', exe, ...argv],
      opts: { ...extra, detached: true, stdio: 'ignore', windowsHide: true },
    };
  }
  return {
    cmd: exe,
    args: argv,
    opts: { ...extra, detached: true, stdio: 'ignore' },
  };
}

/**
 * 起一个后台发布进程。
 *
 * ⚠️ 脚本名按 spec §4.4：
 *   「立即跑一次」→ `manual-publish.ps1 -Force -NoBrowser`
 *     （`-Force` 必须带：当天已发过时它会 `Read-Host` 提问，无控制台时抛异常
 *       → 被 catch → 跳过 → 静默 exit 0，用户以为跑了，其实啥也没干；
 *      `-NoBrowser` 必须带：否则跑完会 `Start-Process` 打开线上站点抢焦点。）
 *   「补发某一天」→ `publish.ps1 -Date <该日> -SkipReview -NoConvert -NoHeadlines`
 *
 * 脚本自己写日志和 `.done` 标记（`manual-publish.ps1:68/130/167-168`），
 * 所以这里 `stdio: 'ignore'` 就行。
 *
 * ⚠️ root 是**实例的** root（`createServer({ root })` 传进来的那个），
 *    不是模块级的 ROOT —— 两者不是一回事（评审 m-4）。
 */
function spawnDetached(scriptName, args, root) {
  const base = root || ROOT;
  const ps = path.join(base, 'tools', scriptName);
  const argv = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, ...args];
  const d = detachedPowerShell(PS_EXE, argv, { cwd: base, env: { ...process.env } });
  const child = spawn(d.cmd, d.args, d.opts);
  child.unref();
  return child.pid;
}

/* ── 静态文件 ───────────────────────────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, urlPath) {
  /* 目录穿越两道：
     ① **自己解码** %2f —— 不解码的话 `%2f..%2f` 会被当成一个普通文件名，
        压根走不到下面的防护分支（那才是假绿）；
     ② 归一之后确认结果仍在 UI_DIR 里。 */
  let rel;
  try {
    rel = decodeURIComponent(urlPath === '/' ? 'index.html' : urlPath);
  } catch {
    rel = '';
  }
  /* ⚠️ 解码**之后**再归一前导斜杠：%2f 解出来就是 '/'，
     先 strip 再解码的话，`/%2f..%2f.x` 解出来是 `/../.tmp-canary.txt`
     —— 那是**绝对路径**，path.resolve 会拿它相对 cwd 解析（不是相对 UI_DIR），
     防护分支就成了「看 cwd 心情」。先解码再 strip，rel 一定是相对的。 */
  rel = rel.replace(/^[\\/]+/, '');
  const target = path.resolve(UI_DIR, rel);
  if (target !== UI_DIR && !target.startsWith(UI_DIR + path.sep)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  let body;
  try {
    body = fs.readFileSync(target);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/* ── 服务 ───────────────────────────────────────────────── */

export function createServer(opts = {}) {
  const root = opts.root || ROOT;
  const port = Number.isFinite(opts.port) ? opts.port : DEFAULT_PORT;
  const withSchedule = opts.schedule !== false;
  /* 写操作默认**关着** —— 只有命令行入口显式打开。
     这样任何「import 了这个模块来测试」的场景都不会真的发起一次发布。 */
  const allowWrite = opts.allowWrite === true;
  /* ⚠️ spawn 钩子：默认就是**真的** spawnDetached（行为不变），
     但测试可以注入一个假的 → 护栏就能断言「写路径没产生任何发布副作用」，
     而**不必**真的发起一次发布。
     （评审实测：没有这道缝，把 allowWrite 挪到 spawn 之后就会真发一次。） */
  const spawnFn = typeof opts.spawnFn === 'function' ? opts.spawnFn : spawnDetached;
  let chosenPort = port;

  /** 服务**实际**监听的端口。 */
  function currentPort() {
    const a = server.address();
    return (a && typeof a === 'object' && Number.isFinite(a.port)) ? a.port : chosenPort;
  }

  const server = http.createServer((req, res) => {
    let u = null;
    try {
      u = new URL(req.url, 'http://127.0.0.1');
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('bad request');
      return;
    }
    const p = u.pathname;

    if (p === '/api/state' && req.method === 'GET') {
      try {
        return sendJson(res, 200, buildState(root, withSchedule));
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
      }
    }

    if (p === '/api/log' && req.method === 'GET') {
      const date = u.searchParams.get('date') || '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return sendJson(res, 400, { ok: false, error: '日期格式不对（应为 YYYY-MM-DD）' });
      }
      /* ⚠️ 与 `/api/state` 用**同一份**日志：这里也要传 `.done`，
         否则 `by:'manual'` 的那一夜会拿到夜间日志，与首屏显示的来源对不上。 */
      const done = parseDone(readText(path.join(root, `.night-publish-${date}.done`)));
      const log = findLogFor(root, date, done);
      /* ⚠️ 只读**尾部 64KB**（spec §9「日志变大」），
         且**只取完整行**（spec §9「日志正被写（读到半行）」→ 末尾不完整那行丢掉）。
         —— 但这条**只适用于 /api/log 这个「给人看日志」的接口**：
         /api/state 要的是**全部** 15 个阶段标记（第一个标记在日志最前面），
         读尾部会把前面的步骤丢掉 → 那里必须读整份。 */
      const text = log ? readTail(log.file, 64 * 1024) : '';
      let complete = [];
      if (text) {
        const lines = text.split(/\r?\n/);
        /* 末尾那行如果是被写了一半的（没有换行结尾），丢掉。 */
        complete = text.endsWith('\n') ? lines : lines.slice(0, -1);
        /* split 会在结尾的 '\n' 后面留一个空串 —— 那是切出来的，不是日志里的一行。 */
        while (complete.length && complete[complete.length - 1] === '') complete.pop();
      }
      return sendJson(res, 200, {
        ok: true, date, source: log ? log.source : null, lines: complete.slice(-120),
      });
    }

    if ((p === '/api/run-now' || p === '/api/republish') && req.method === 'POST') {
      /* ⚠️ 整个 handler 包 try/catch（评审 m-5）：
         `/api/state` 有 try/catch（抛异常 → 500），写接口原来没有 ——
         handler 里抛异常会变成 `uncaughtException` → **整个任务台进程崩掉**。
         这里抛 → 500，页面至少还能显示「没发出去」。 */
      try {
        const deny = guard(req, currentPort());
        if (deny) return sendJson(res, 403, { ok: false, error: deny });
        /* ⚠️ allowWrite 必须在 spawn 之前判 —— 测试里**绝不许**真的发起一次发布。 */
        if (!allowWrite) return sendJson(res, 503, { ok: false, error: '这个实例禁用了写操作' });
        if (isBusy()) return sendJson(res, 409, { ok: false, error: '已经在跑了，等它跑完' });

        let script;
        let args;
        if (p === '/api/run-now') {
          /* ⚠️ run-now **只管今天**（评审 m-6 · spec §4.4「立即跑一次 = 北京今天」/
             spec §7.3「立刻重跑今天这一期」）。原来还收 `?date=` → 能指定过去日期，
             那是**超出 spec 的口子**（补发那一天的正经入口是 `/api/republish`）。 */
          script = 'manual-publish.ps1';
          args = ['-Force', '-NoBrowser'];
        } else {
          const date = u.searchParams.get('date') || '';
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return sendJson(res, 400, { ok: false, error: '日期格式不对（应为 YYYY-MM-DD）' });
          }
          if (!findDatedDir(srcSearchRoots(), date)) {
            return sendJson(res, 400, { ok: false, error: '那一天的源图已经不在了，补发不了' });
          }
          script = 'publish.ps1';
          args = ['-Date', date, '-SkipReview', '-NoConvert', '-NoHeadlines'];
        }
        const pid = spawnFn(script, args, root);
        return sendJson(res, 202, { ok: true, pid, args });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
      }
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(res, p);
    }

    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('method not allowed');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && chosenPort < port + 9) {
      const prev = chosenPort;
      chosenPort += 1;
      console.log('  端口 ' + prev + ' 被占用，改用 ' + chosenPort);
      server.listen(chosenPort, '127.0.0.1');
      return;
    }
    console.error('任务台启动失败：' + err.message);
    process.exit(1);
  });

  return {
    server,
    /* 实际监听的端口。测试里用 listen(0) 让系统随机给一个，
       所以这里要问 server.address()，不能只回 chosenPort。 */
    getChosenPort: () => currentPort(),
  };
}

/* ── 直接起（node tools/night-dashboard.mjs） ───────────── */

/* ⚠️ Windows 上必须用 pathToFileURL 比较：
   手拼 'file://' + 'E:/xxx' 只有两个斜杠，而 import.meta.url 是三个
   （file:///E:/xxx）—— 直接拼字符串永远不相等，入口就永远不跑。 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const inst = createServer({ port: DEFAULT_PORT, allowWrite: true });
  inst.server.listen(DEFAULT_PORT, '127.0.0.1', () => {
    const p = inst.getChosenPort();
    try { fs.writeFileSync(PORT_FILE, String(p), 'utf8'); } catch { /* 写不了不影响用 */ }
    console.log('  任务台：http://127.0.0.1:' + p + '/');
  });
}
