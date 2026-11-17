#!/usr/bin/env node
/**
 * 「一键更新」护栏测试（桌面快捷方式 -> 一键更新.cmd -> tools/daily-review.ps1）
 *
 * 用法：node tools/test-daily-review.mjs
 * 退出码：0 = 全过；1 = 有失败
 *
 * 测的都是「坏了很难发现」的东西：
 *   - .cmd 的编码：BOM / CRLF / 非 ASCII 任一出现，cmd.exe 就可能整个跑不起来
 *   - 一键更新**绝不能**碰发布 —— 发布不可逆（撤回要等 24 小时边缘缓存），
 *     必须是审稿台里另一个独立按钮的事
 *   - daily.ps1 的原生命令必须接 `| Out-Host`：
 *     PS 5.1 里原生命令的 stdout 是直接写控制台句柄的，
 *     Start-Transcript 抓不到 —— 不接的话日志会静默少掉一大半，
 *     而屏幕上一行都不少，看着一切正常
 *   - 原生命令那几行不能出现 `2>&1`：PS 5.1 会把 stderr 转成 ErrorRecord，
 *     而 daily.ps1 是 $ErrorActionPreference='Stop'，python 打一行无害的
 *     warning 就能把整轮准备干掉
 *   - daily-review.ps1 必须是 UTF-8 with BOM，且能被 PowerShell 解析
 *
 * 2026-11-08 追加（审稿台被 Job Object 连坐杀掉之后）：
 *   - 审稿台必须**不在任何 Windows Job Object 里**。本机的 openclaw 进程监督器
 *     给会话建了带 KILL_ON_JOB_CLOSE 的 Job（service-child-windows-job-anchor.js
 *     里的 SetInformationJobObject / TerminateJobObject），Job 一关，里面的进程
 *     被强杀：无 stderr、无退出码、无事件日志 —— 跟「程序自己崩了」一模一样。
 *     detached（DETACHED_PROCESS）**不能**脱离 Job，所以必须经 explorer.exe 起
 *     （Explorer 本身不在任何 Job 里）
 *   - 起审稿台.cmd 的编码同样必须是纯 ASCII / LF / 无 BOM
 *   - 起审稿台必须幂等：已经在跑就别起第二个（端口会顺延到 8790，
 *     用户以为「审稿台没了」）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const CMD = path.join(ROOT, '一键更新.cmd');
const WRAP = path.join(ROOT, 'tools', 'daily-review.ps1');
const DAILY = path.join(ROOT, 'tools', 'daily.ps1');
const REVIEW_CMD = path.join(ROOT, '起审稿台.cmd');
const STARTER = path.join(ROOT, 'tools', 'start-review.mjs');

/**
 * 平台分支。
 *
 * macOS 上跑的是**同一份 .ps1**（PowerShell 7），但**入口不一样**：
 *   Windows → 一键更新.cmd / 起审稿台.cmd（cmd.exe 专用）
 *   macOS   → tools/macos/*.sh（bash）
 * 所以 .cmd 那几条断言在 macOS 上没有意义，改为检查 .sh 那套。
 *
 * ⚠️ 但「审稿台不能被连坐杀掉」这条**在两个平台都要查**：
 *   Windows → 必须经 explorer.exe 脱 Job Object
 *   macOS   → 必须**不碰** explorer.exe（那儿没这东西），直接 detached 起
 */
const IS_WIN = process.platform === 'win32';
const PS = IS_WIN ? 'powershell' : 'pwsh';
const MACOS_DIR = path.join(ROOT, 'tools', 'macos');

let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  -> ' + extra : ''}`);
  }
}

function read(p) {
  return fs.readFileSync(p);
}

/**
 * 只留「代码」，把注释去掉。
 *
 * 为什么需要：doc 里到处都在解释「发布是不可逆的，publish.ps1 会 exit=1」，
 * 直接全文搜 'publish.ps1' 会把这些说明也算进去 ——
 * 护栏要卡的是**真的去调它**，不是提到它。
 */
function codeOnly(ps) {
  return ps
    .replace(/<#[\s\S]*?#>/g, '')            // 块注释 <# ... #>
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))         // 行注释
    .join('\n');
}

function cmdCodeOnly(text) {
  return text
    .split(/\r?\n/)
    .filter((l) => !/^\s*rem\b/i.test(l))    // cmd 的注释是 rem
    .join('\n');
}

/* ────────────────────── 文件在不在 ────────────────────── */
console.log('\n文件');
check('tools/daily-review.ps1 存在', fs.existsSync(WRAP));
check('tools/daily.ps1 存在', fs.existsSync(DAILY));
if (!fs.existsSync(WRAP) || !fs.existsSync(DAILY)) {
  console.log('\n缺文件，后面没法测了。');
  process.exit(1);
}

/* ────────────────────── .cmd 的编码 ──────────────────────
 * cmd.exe 对 .cmd 的编码比想象中挑剔：
 *   - 带 BOM：开头会多出 0xEF 0xBB 0xBF，第一行命令直接报错
 *   - CRLF/LF 混用：goto/label 会跑飞（本文件没用 label，但保持一致）
 *   - 非 ASCII：cmd 按 OEM 代码页解释，中文注释会变成乱码甚至被当成命令
 *
 * 这一段只在 Windows 上有意义（macOS 的入口是 .sh，不是 .cmd）。
 */
console.log('\n一键更新.cmd 的编码');
if (IS_WIN) {
  const cmdBytes = read(CMD);
  check('一键更新.cmd 存在', fs.existsSync(CMD));
  check('纯 ASCII（没有非 ASCII 字节）', cmdBytes.every((b) => b < 128),
    `有 ${cmdBytes.filter((b) => b >= 128).length} 个非 ASCII 字节`);
  check('无 BOM', !(cmdBytes[0] === 0xef && cmdBytes[1] === 0xbb && cmdBytes[2] === 0xbf));
  check('只有 LF，没有 CR', !cmdBytes.includes(0x0d),
    `有 ${cmdBytes.filter((b) => b === 0x0d).length} 个 CR`);
  const cmdText = cmdBytes.toString('latin1');
  const cmdCode = cmdCodeOnly(cmdText);

  /* ────────────────────── 一键更新做什么 / 不做什么 ────────────────────── */
  console.log('\n一键更新.cmd 的行为');
  check('调的是 tools\\daily-review.ps1', /tools\\daily-review\.ps1/i.test(cmdCode));
  check('不碰 publish.ps1（发布是独立一步，不可逆）', !/publish\.ps1/i.test(cmdCode));
  check('不直接调 build.mjs（交给 daily-review.ps1 统一编排）', !/build\.mjs/i.test(cmdCode));
} else {
  console.log('\n（macOS：入口是 tools/macos/*.sh，不查 .cmd）');
  const sh = path.join(MACOS_DIR, 'run-night-publish.sh');
  check('tools/macos/run-night-publish.sh 存在', fs.existsSync(sh));
  if (fs.existsSync(sh)) {
    const shBytes = read(sh);
    check('shell 脚本无 BOM（否则 shebang 失效）',
      !(shBytes[0] === 0xef && shBytes[1] === 0xbb && shBytes[2] === 0xbf));
    check('shell 脚本只有 LF，没有 CR', !shBytes.includes(0x0d));
    check('shell 脚本用 #!/bin/bash', shBytes.toString('utf8').startsWith('#!/bin/bash'));
  }
}

const wrapText = read(WRAP).toString('utf8');
const wrapCode = codeOnly(wrapText);

/* start-review.mjs 的代码（去注释）—— 审稿台的启动机制全在里面 */
const starterText = read(STARTER).toString('utf8');
const starterCode = starterText
  .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
  .split(/\r?\n/)
  .filter((l) => !/^\s*(\/\/|\*)/.test(l))  // 行注释
  .join('\n');

console.log('\ntools/daily-review.ps1 的行为');
check('不碰 publish.ps1（准备阶段绝不发布）', !/publish\.ps1/i.test(wrapCode));
check('不碰 upload / deploy（只做本地准备）', !/\bwrangler\b/i.test(wrapCode));
check('用 tools\\start-review.mjs 起审稿台（不直接 Start-Process node）',
  /start-review\.mjs/.test(wrapCode));
check('没有 detached（Windows 上 detached=true 会让 powershell.exe 137ms 假成功）',
  !/detached/i.test(wrapCode));
check('审稿台输出重定向到文件 —— 重定向现在在 start-review.mjs 里（stdio 落盘）',
  /review-station-.*\.out\.log/.test(starterCode) && /review-station-.*\.err\.log/.test(starterCode));
check('复用已有审稿台时会核对日期（页面上有「审稿台 · <日期>」）',
  /审稿台 · /.test(wrapCode));

/* ────────────────────── 审稿台不能被 Job Object 连坐杀掉 ──────────────────────
 * 2026-11-08 09:00 的真凶：审稿台和发布子进程同时静默消失。
 * detached 只能解决「控制台销毁」，解决不了「Job 关闭」——
 * Node 的 spawn 没有 CREATE_BREAKAWAY_FROM_JOB。
 * 唯一实测有效的脱身方式：让 explorer.exe 去起（Explorer 不在任何 Job 里）。
 *
 * macOS 上没有 Job Object 这回事，所以那边是**反过来**的要求：
 * 绝对不能去调 explorer.exe（那儿根本没这个命令），直接 detached 起就行。
 */
console.log('\n审稿台的 Job Object 脱身');
if (IS_WIN && fs.existsSync(REVIEW_CMD)) {
  const rc = read(REVIEW_CMD);
  check('起审稿台.cmd 纯 ASCII', rc.every((b) => b < 128),
    `有 ${rc.filter((b) => b >= 128).length} 个非 ASCII 字节`);
  check('起审稿台.cmd 无 BOM', !(rc[0] === 0xef && rc[1] === 0xbb && rc[2] === 0xbf));
  check('起审稿台.cmd 只有 LF，没有 CR', !rc.includes(0x0d));
  const rcCode = cmdCodeOnly(rc.toString('latin1'));
  check('起审稿台.cmd 调 start-review.mjs --direct', /start-review\.mjs\s+--direct/.test(rcCode));
  check('起审稿台.cmd 不碰 publish.ps1', !/publish\.ps1/i.test(rcCode));
}
if (IS_WIN) {
  check('start-review.mjs 经 explorer.exe 起（脱身 Job Object）',
    /spawn\(\s*['"]explorer\.exe['"]/.test(starterCode),
    '注意：要匹配真正的 spawn 调用，不能只搜 explorer.exe 这几个字（错误提示里也有）');
} else {
  check('start-review.mjs **不碰** explorer.exe（macOS 没这东西，调了必挂）',
    !/spawn\(\s*['"]explorer\.exe['"]/.test(starterCode),
    'macOS/Linux 没有 Job Object，直接 detached 起就行');
  check('start-review.mjs 有非 Windows 的直起分支',
    /process\.platform\s*!==\s*['"]win32['"]/.test(starterCode) ||
    /process\.platform\s*===\s*['"]darwin['"]/.test(starterCode),
    '要求按 process.platform 分支处理启动方式');
}
check('start-review.mjs 有 --direct 直起路径（explorer 转进来的那一次）',
  /includes\(\s*['"]--direct['"]/.test(starterCode),
  '注意：要匹配真正的参数判断，不能只搜 --direct 这几个字（用法提示里也有）');
check('start-review.mjs 仍用 detached 起审稿台本身（不继承控制台）',
  /detached:\s*true/.test(starterCode));
check('start-review.mjs 不用 windowsHide（那是「隐藏窗口」，仍挂父进程控制台）',
  !/windowsHide/.test(starterCode));
check('start-review.mjs 写 PID 文件（explorer 那一层拿不到子进程 PID）',
  /pidFile\s*=/.test(starterCode));
check('起审稿台幂等：已经在跑就不起第二个',
  /readPid\(\)|existing/.test(starterCode));

/* ────────────────────── daily.ps1 的原生命令 ──────────────────────
 * 这几条是「日志少一大半」的根因，坏了也不会报错，只是日志里少了东西。
 */
console.log('\ntools/daily.ps1 的原生命令');
const dailyText = read(DAILY).toString('utf8');
/**
 * 所有对 python / node 的直接调用。
 *
 * ⚠️ **不要限定参数形态**。早先的正则只认 `& node @(...)`（数组展开），
 * 结果 2026-11-16 新增的第 4 步 `& node $fetcher --date $publishDate`
 * （直接传参，不展开数组）整个漏在外面 —— 它的 Out-Host / 2>&1 纪律谁都没盯。
 * 现在按「调用了哪个可执行文件」认，不看参数长什么样。
 */
const nativeLines = dailyText
  .split(/\r?\n/)
  .filter((l) => /^\s*&\s+(\$py|node)\s+/.test(l));
check('找到 7 条原生命令调用', nativeLines.length === 7, `实际 ${nativeLines.length} 条`);

/**
 * 两条是「环境准备」用的，输出本来就不该进流水线：
 *   -c "import X"   依赖自检，故意把 stderr 丢掉（2>$null，不是 2>&1）
 *   -m pip install  装依赖，装的过程不重要
 * 除这两条外，每一条都必须接 `| Out-Host` 且不许有 `2>&1`。
 */
const SETUP_CALL = /&\s+\$py\s+(-c\s+"|-m\s+pip\s+install)/;
for (const line of nativeLines) {
  if (SETUP_CALL.test(line)) continue;
  const tag = line.trim().replace(/\s+/g, ' ').slice(0, 46);
  check(`接了 | Out-Host：${tag}`, /\|\s*Out-Host/.test(line));
  check(`没有 2>&1：${tag}`, !/2>&1/.test(line));
}

/* ────────────────────── 编码 + 语法 ────────────────────── */
console.log('\n编码与语法');
const wrapBytes = read(WRAP);
check('daily-review.ps1 是 UTF-8 with BOM',
  wrapBytes[0] === 0xef && wrapBytes[1] === 0xbb && wrapBytes[2] === 0xbf);
const dailyBytes = read(DAILY);
check('daily.ps1 是 UTF-8 with BOM',
  dailyBytes[0] === 0xef && dailyBytes[1] === 0xbb && dailyBytes[2] === 0xbf);

const psCmd = [
  `$errs = $null`,
  `[System.Management.Automation.Language.Parser]::ParseFile('${WRAP.replace(/\\/g, '\\\\')}', [ref]$null, [ref]$errs) | Out-Null`,
  `if ($errs -and $errs.Count) { exit 1 } else { exit 0 }`,
].join('; ');
const parsed = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
  encoding: 'utf8',
});
check('daily-review.ps1 能被 PowerShell 解析（无语法错误）',
  parsed.status === 0, `exit=${parsed.status} ${(parsed.stdout || '').trim()} ${(parsed.stderr || '').trim()}`);

const psCmd2 = [
  `$errs = $null`,
  `[System.Management.Automation.Language.Parser]::ParseFile('${DAILY.replace(/\\/g, '\\\\')}', [ref]$null, [ref]$errs) | Out-Null`,
  `if ($errs -and $errs.Count) { exit 1 } else { exit 0 }`,
].join('; ');
const parsed2 = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', psCmd2], {
  encoding: 'utf8',
});
check('daily.ps1 能被 PowerShell 解析（无语法错误）',
  parsed2.status === 0, `exit=${parsed2.status} ${(parsed2.stdout || '').trim()} ${(parsed2.stderr || '').trim()}`);

/* ────────────────────── common.ps1 也要能解析 ──────────────────────
 * 所有 .ps1 都 dot-source 它 —— 它语法错了，全线都起不来。
 */
const commonPath = path.join(ROOT, 'tools', 'common.ps1');
const commonBytes = read(commonPath);
check('tools/common.ps1 是 UTF-8 with BOM',
  commonBytes[0] === 0xef && commonBytes[1] === 0xbb && commonBytes[2] === 0xbf);
const psCmd3 = [
  `$errs = $null`,
  `[System.Management.Automation.Language.Parser]::ParseFile('${commonPath.replace(/\\/g, '\\\\')}', [ref]$null, [ref]$errs) | Out-Null`,
  `if ($errs -and $errs.Count) { exit 1 } else { exit 0 }`,
].join('; ');
const parsed3 = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', psCmd3], {
  encoding: 'utf8',
});
check('tools/common.ps1 能被 PowerShell 解析（无语法错误）',
  parsed3.status === 0, `exit=${parsed3.status} ${(parsed3.stdout || '').trim()} ${(parsed3.stderr || '').trim()}`);

/* ────────────────────── 结果 ────────────────────── */
console.log('');
console.log(`  ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
