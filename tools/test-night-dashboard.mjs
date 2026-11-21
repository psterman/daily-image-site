#!/usr/bin/env node
/**
 * 定时任务台的护栏。
 *
 * 覆盖：三个 helper 的时间戳格式 · 解析层 · 状态与问题判定 · HTTP 层 · 启动器约定。
 *
 * 纪律：输出「N 通过 / M 失败」，有失败 exit 1（能被 tools/run-all-tests.mjs 收编）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;

function check(label, ok, detail) {
  if (ok) {
    pass++;
    console.log('  ✓ ' + label);
  } else {
    fail++;
    console.log('  ✗ ' + label + (detail === undefined ? '' : '  ' + JSON.stringify(detail)));
  }
}

/**
 * 读文件；**读不到返回空串**（不抛）。
 *
 * ⚠️ 为什么必须这样：文件不存在时 `readFileSync` 会抛 ENOENT →
 *    整个套件崩掉，而崩掉的套件**没有 `✗` 行**（Task 8 按标签 grep 变异点时会误判「没抓到」）。
 *    返回空串 → 依赖它的断言**干净地红**。
 *
 * ⚠️ 这不会让既有断言假绿：现有的调用点后面都带空值前置
 *    （`body !== ''` / `!!stepLine`）—— 读不到 → 那几条**红**，不会空过。
 */
function read(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    return '';
  }
}

/** 取出 helper 的函数体（单行、无嵌套花括号）。返回空串 = 锚点没命中。 */
function helperBody(src, fn) {
  const m = new RegExp('function\\s+' + fn + '\\s*\\([^)]*\\)\\s*\\{([^}]*)\\}').exec(src);
  return m ? m[1] : '';
}

/**
 * 剥掉 PowerShell 注释再匹配源码（工程惯例，同 tools/test-night-flow.mjs）。
 *
 * 为什么必须剥：这些 .ps1 的注释里**故意**写着反面示例，
 * 不剥的话护栏会把自己的说明书当成「源码长这样」的证据。
 */
function stripPsComments(src) {
  return src
    .replace(/<#[\s\S]*?#>/g, '')                        // 块注释
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))    // 行注释
    .join('\n');
}

/**
 * 真跑一次 publish.ps1 里 Step helper 的那个 Write-Host 表达式，
 * 拿它 stdout 里 `^===` 开头的那一行。
 *
 * 返回 { outLine, stdout, stderr, exit, error }；跑不起来时 outLine = null。
 *
 * 为什么单独抽出来：连接断言组要「取不到就报红」而不是「取不到就跳过」，
 * 所以取值和判定必须分开 —— 这里只管跑，判不判由调用方的断言条件决定。
 *
 * error 也带出来：spawn 失败（比如目标平台没装 pwsh）时 stdout/stderr/exit
 * 全是空的，光看那几个字段猜不出「是没装 pwsh」还是「命令本身炸了」。
 */
function runRealHelper(expr) {
  /* $msg 用赋值语句喂进去（跟 publish.ps1 里 Step '1/6 刷新 Cloudflare token'
     的真实调用形式一样）。**不**再给 $t 赋值 —— 真实表达式
     （publish.ps1:51）里的钟是**内联算**的 (Get-BjNow).ToString('HH:mm:ss')，
     从头到尾没引用过 $t；给它造一个桩只会让人以为 $t 是时间戳变量。 */
  const enc = Buffer.from(
    "$ErrorActionPreference='Stop'; . '" + path.join(ROOT, 'tools', 'common.ps1') +
    "'; $msg='1/6 刷新 Cloudflare token'; Write-Output (" + expr + ")",
    'utf16le').toString('base64');
  /* 按平台选可执行文件 —— 仓库既有惯例（tools/test-daily-review.mjs、
     tools/test-daily-rank-step.mjs 都是 `IS_WIN ? 'powershell' : 'pwsh'`）。
     为什么不能硬编码 'powershell.exe'：macOS 上根本没有这个文件 →
     spawnSync 直接 ENOENT → 输出行取不到 → 连接断言整组变红 →
     护栏在**目标平台**上 exit 1。macOS 那边装 PowerShell 7（pwsh），
     跑的是同一份 .ps1。 */
  const PS = process.platform === 'win32' ? 'powershell' : 'pwsh';
  const ps = spawnSync(PS,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
    { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  const outLine = String(ps.stdout || '').split(/\r?\n/).map((s) => s.trim())
    .find((s) => /^===/.test(s)) || null;
  return { outLine, stdout: ps.stdout, stderr: ps.stderr, exit: ps.status, error: ps.error ? String(ps.error.message || ps.error) : null };
}

/* ── 1. 三个 helper 的时间戳 ─────────────────────────────── */
{
  const cases = [
    ['tools/daily.ps1', 'Step'],
    ['tools/daily-review.ps1', 'Rule'],
    ['tools/publish.ps1', 'Step'],
  ];
  for (const [file, fn] of cases) {
    const body = helperBody(read(file), fn);
    check(`${file} 里找得到 ${fn} helper（锚点自检）`, body !== '', { file, fn });
    check(`${file} 的 ${fn} 用 Get-BjNow 取时间`, /Get-BjNow/.test(body), { body });
    /* ⚠️ 这里的 body !== '' 不是多余的：body 为空时（helper 没找到）
       `!/Get-Date/.test('')` 会**空过** —— 护栏会声称「没用 Get-Date」成立，
       实际它什么都没查。跟连接断言那两条「顺序」断言是同一类假阴性。
       加上之后：body 为空 → 这条也红（不会假装通过）。 */
    check(`${file} 的 ${fn} 没用 Get-Date（时区会错位）`, body !== '' && !/Get-Date/.test(body), { body });
    check(`${file} 的 ${fn} 写了 HH:mm:ss 时间戳`, /ToString\('HH:mm:ss'\)/.test(body), { body });
  }
}

/* ── 2. 解析层 ─────────────────────────────────────────── */
import * as ST from './night-dashboard-state.mjs';

{
  check('stripBom 剥掉 U+FEFF', ST.stripBom('\uFEFF{"a":1}') === '{"a":1}');
  check('stripBom 对没有 BOM 的原样返回', ST.stripBom('{"a":1}') === '{"a":1}');

  const done = ST.parseDone('\uFEFF{\r\n  "date": "2026-11-20",\r\n  "at": "2026-11-20T00:41:39.4382066+08:00",\r\n  "exit": 0\r\n}');
  check('.done 能剥 BOM 并解析', !!done && done.date === '2026-11-20' && done.exit === 0, { done });
  /* parseDone 对坏 JSON 返回 null → 直接 .by 会抛 TypeError。
     护栏失败必须是**断言变红**，不能是整个套件抛异常崩掉
     （崩掉的套件一条 `✗ <label>` 都没有 → Task 8 按标签 grep 会误判「没抓到」）。 */
  const done2 = ST.parseDone('{"date":"2026-11-20","at":"x","exit":0,"by":"manual"}');
  check('.done 的 by 字段（手动跑才有）', !!done2 && done2.by === 'manual', { done: done2 });
  check('.done JSON 坏了 → null，不抛', ST.parseDone('{ 坏掉的') === null);
  check('.done 空 → null', ST.parseDone('') === null);

  const steps = ST.parseSteps(
    '=== 1/6 刷新 Cloudflare token ===  [00:12:03]\n=== 2/6 构建页面与图片 ===  [00:14:20]\n',
    '2026-11-20');
  check('新格式解析出 2 个步骤', steps.length === 2, { steps });
  /* 下面每条都自己带长度前置 —— 断言之间互相独立，
     不能靠「上一条已经报过红」来避免越界下标。 */
  check('步骤 key 用编号不用文案',
    steps.length === 2 && steps[0].key === 'publish/1-6' && steps[1].key === 'publish/2-6',
    { n: steps.length, steps });
  check('步骤文案取日志里的原话',
    steps.length >= 1 && steps[0].label === '刷新 Cloudflare token', { n: steps.length, steps });
  check('步骤分组正确',
    steps.length >= 1 && steps[0].group === 'publish', { n: steps.length, steps });
  check('新格式有时间戳',
    steps.length >= 1 && steps[0].clock === '00:12:03' && Number.isFinite(steps[0].atMs),
    { n: steps.length, steps });

  const old = ST.parseSteps('=== 1/6 刷新 Cloudflare token ===\n=== 2/6 构建页面与图片 ===\n', '2026-11-20');
  check('老日志（无时间戳）也能解析', old.length === 2 && old[0].clock === null && old[0].atMs === null);
  check('老日志的 key 一样对',
    old.length >= 1 && old[0].key === 'publish/1-6', { n: old.length, old });

  const mixed = ST.parseSteps([
    '=== 1/3 每日准备（抓图 → 头条 → 清洗 → 榜单/追更 → 构建） ===',
    '=== 0/5 准备环境 ===',
    '=== 5/5 构建（本地，不上传） ===',
    '=== 2/3 校验构建产物 ===',
    '=== 3/3 跳过审稿台（-SkipReview） ===',
    '=== 6/6 部署 Cloudflare Pages（项目 daily-image-site） ===',
  ].join('\n'), '2026-11-20');
  check('1/3 与 N/5 归「准备」',
    mixed.length >= 2 && mixed[0].group === 'prepare' && mixed[1].group === 'prepare',
    { n: mixed.length, mixed });
  check('2/3、3/3 归「校验与审稿」',
    mixed.length >= 5 && mixed[3].group === 'verify' && mixed[4].group === 'verify',
    { n: mixed.length, mixed });
  check('N/6 归「发布」',
    mixed.length >= 6 && mixed[5].group === 'publish', { n: mixed.length, mixed });
  check('样本里的 6 个标记都解析出来', mixed.length === 6);

  const variants = ST.parseSteps([
    '=== 2/6 跳过构建（复用 published/ 现有产物） ===',
    '=== 4/6 跳过审稿闸门 ===',
    '=== 5/6 暂存图片到静态产物（R2 兜底） ===',
  ].join('\n'), '2026-11-20');
  check('同一编号的不同变体都认得',
    variants.length === 3 && variants[0].key === 'publish/2-6' && variants[0].label.indexOf('跳过构建') >= 0);

  check('认 NIGHT_DONE', ST.parseLog('=== NIGHT_DONE exit=0 ===', '2026-11-20').source === 'night');
  check('认 MANUAL_DONE', ST.parseLog('=== MANUAL_DONE exit=1 ===', '2026-11-20').source === 'manual');
  check('认 PUBLISH_DONE', ST.parseLog('=== PUBLISH_DONE exit=0 ===', '2026-11-20').source === 'review');
  check('DONE 的退出码取得到', ST.parseLog('=== NIGHT_DONE exit=1 ===', '2026-11-20').exitCode === 1);

  const cross = ST.parseSteps('=== 1/6 a ===  [23:58:00]\n=== 2/6 b ===  [00:03:00]\n', '2026-11-20');
  /* ⚠️ detail 是**无条件求值**的 —— `{ a: cross[0].atMs }` 即使条件为假也会抛。
     所以先把下标落到安全变量，条件里再判 null。 */
  const crossA = cross.length >= 2 ? cross[0].atMs : null;
  const crossB = cross.length >= 2 ? cross[1].atMs : null;
  check('跨零点：后一步自动 +1 天',
    crossA !== null && crossB !== null && crossB - crossA === 5 * 60 * 1000,
    { a: crossA, b: crossB, n: cross.length });

  const dur = ST.parseLog(
    '=== 1/6 a ===  [00:00:00]\n=== 2/6 b ===  [00:02:30]\n',
    '2026-11-20', Date.parse('2026-11-20T00:05:00+08:00'));
  check('阶段耗时 = 下一步时刻 − 本步时刻',
    dur.steps.length >= 1 && dur.steps[0].durationMs === 150000, { n: dur.steps.length, steps: dur.steps });
  check('最后一步的耗时算到结束时刻',
    dur.steps.length >= 2 && dur.steps[1].durationMs === 150000, { n: dur.steps.length, steps: dur.steps });
  check('阶段耗时不会算出负数',
    dur.steps.every((s) => s.durationMs === null || s.durationMs >= 0));

  check('median 取奇数个的中位数', ST.median([3, 1, 2]) === 2);
  check('median 用中位数不是平均数（一个异常值不能拉歪基准）', ST.median([1, 2, 3, 100]) === 3);
  check('median 空数组 → null', ST.median([]) === null);

  /* ── 连接断言：真实 helper 输出必须能被解析器认出来 ──────────
     为什么必须有这一组：Task 1 的护栏只查**源码里有没有记号**，
     查不出「时间戳被挪到 === 前面」或「=== 标记被改写」这两种改法。
     而 Task 2 的护栏查的是**字面样本**能不能解析。
     两头都不接 → 格式漂移了没人拦，线上任务台静默显示 0 个阶段。
     这一组把两头接上：从 publish.ps1 里取出真实 helper 源码行，
     真的跑一遍拿到输出行，再喂给 parseSteps。 */
  const psSrc = read('tools/publish.ps1');
  const psCode = stripPsComments(psSrc);
  const stepHits = psCode.split(/\r?\n/).filter((l) => /function\s+Step\s*\(/.test(l));
  const stepLine = stepHits.length === 1 ? stepHits[0] : null;
  check('publish.ps1 里找得到 Step helper 源码行（连接断言的前置）', !!stepLine, { hits: stepHits.length });

  /* 只取函数体里 Write-Host 的那个表达式，替掉 $msg 变量后真跑一次。
     用 -EncodedCommand 避开 PowerShell 层的引号地狱（可执行文件按平台选，
     见上面 runRealHelper 里的 PS 常量 —— 不硬编码 powershell.exe）。 */
  const exprMatch = stepLine
    ? /Write-Host\s*\((.*)\)\s*-ForegroundColor/.exec(stepLine)
    : null;
  check('Step 里的 Write-Host 是带括号的拼接形式（连接断言的前置）',
    !!exprMatch, { stepLine });

  /* $msg 用**赋值语句**喂进去（跟 publish.ps1 里 Step '1/6 刷新 Cloudflare token'
     的真实调用形式一模一样），**不**把它塞回双引号字面量里 ——
     塞回去的话单引号会原样出现在输出里，解析器的 `^\d+/\d+` 锚点就断了。
     Write-Output 在 PS 5.1 没有 -NoNewline 这个参数（会被当成位置参数
     多吐一个字），尾随换行无所谓 —— 下面 split + trim 之后照样找得到那一行。 */
  const expr = exprMatch ? exprMatch[1] : '';

  /* 真跑一次。拿不到表达式就不跑（跑不了），但**不因此短路后面的断言** ——
     判红还是跳过由下面的断言条件决定，不由这里决定。 */
  const run = exprMatch
    ? runRealHelper(expr)
    : { outLine: null, stdout: null, stderr: null, exit: null, error: null };
  const outLine = run.outLine;
  check('真实 helper 输出行拿到了（连接断言的前置）',
    !!outLine, { ran: !!exprMatch, stdout: run.stdout, stderr: run.stderr, exit: run.exit, error: run.error });

  const real = outLine ? ST.parseSteps(outLine, '2026-11-20') : [];

  /* ⚠️ 下面 6 条 ★ 断言**无条件执行** —— 前置不满足时报红，不是整块跳过。
     条件里显式带上各自的前置（!!outLine / !!exprMatch）。
     为什么必须这样：Task 8 的变异护栏按 `✗ <label>` 判定「这条变异被抓到了」。
     前置一坏就整块跳过 → 这些断言变成「跳过」而不是「失败」→
     变异套件误报「没抓到」→ **假阴性**（护栏明明拦住了，套件却说没拦住）。 */

  /* ⚠️ 两条「顺序」断言要**两个位置都存在**才算成立。
     `String.indexOf` 找不到时返回 **-1**，而 `-1 < 正数` 是成立的 ——
     于是「`===` 整个不见了」会被判成「`===` 在时间戳前面」→ **错误地绿**。
     这跟「跳过」是同一类假阴性：护栏声称这条属性成立，其实它根本不成立。
     所以先把 -1 显式挡掉，再比大小。 */
  const eqAt = outLine ? outLine.indexOf('===') : -1;
  const brAt = outLine ? outLine.indexOf('[') : -1;
  const eqAtSrc = expr ? expr.indexOf('===') : -1;
  const brAtSrc = expr ? expr.indexOf('[') : -1;

  check('★ 真实 helper 输出能被解析器认出来（连接断言）',
    !!outLine && real.length === 1 && real[0].key === 'publish/1-6', { outLine, real });
  check('★ 真实 helper 输出的文案解析得对（连接断言）',
    !!outLine && real.length === 1 &&
    (real[0].num + '/' + real[0].den + ' ' + real[0].label) === '1/6 刷新 Cloudflare token',
    { outLine });
  check('★ 真实 helper 输出带出了时间戳（连接断言）',
    !!outLine && real.length === 1 && /^\d{2}:\d{2}:\d{2}$/.test(String(real[0].clock || '')),
    { outLine, clock: real[0] && real[0].clock });
  check('★ 真实 helper 输出里 === 标记在时间戳前面（连接断言）',
    eqAt !== -1 && brAt !== -1 && eqAt < brAt, { outLine, eqAt, brAt });
  check('★ 真实 helper 源码里 === 标记也在时间戳前面（连接断言）',
    eqAtSrc !== -1 && brAtSrc !== -1 && eqAtSrc < brAtSrc, { expr, eqAt: eqAtSrc, brAt: brAtSrc });
  check('★ 真实 helper 输出的 key 在 CANONICAL_STEPS 里有位置（连接断言）',
    !!outLine && real.length === 1 && ST.CANONICAL_STEPS.some((s) => s.key === real[0].key),
    { outLine });
}

/* ── 3. 状态与问题判定 ─────────────────────────────────── */
{
  const doneOk = { date: '2026-11-20', at: '2026-11-20T00:41:39+08:00', exit: 0, by: null };
  const log = [
    '=== 1/6 刷新 Cloudflare token ===  [00:10:02]',
    '=== 2/6 构建页面与图片 ===  [00:12:20]',
    '=== 6/6 部署 Cloudflare Pages（项目 daily-image-site） ===  [00:40:00]',
    '=== NIGHT_DONE exit=0 ===',
  ].join('\n');

  /* ⚠️ 实现还没写出来时（buildCurrent / stepMedians / pickProblem 不存在），
     下面每条断言要**报红**，不能整个套件抛 TypeError 崩掉 ——
     崩掉的套件一条 `✗ <label>` 都没有，Task 8 按标签 grep 会误判「没抓到」→ 假阴性。
     所以取值全部先落到安全变量（cur / curSteps / cur5 / pDetail …），
     条件里再判存在性 —— 前置不满足就是一条红，不是跳过。 */
  const hasBuild = typeof ST.buildCurrent === 'function';
  const build = hasBuild ? ST.buildCurrent : () => null;

  const cur = build({
    date: '2026-11-20', done: doneOk, logText: log,
    logMtime: Date.parse('2026-11-20T00:41:39+08:00'),
    now: Date.parse('2026-11-20T00:42:00+08:00'),
  });
  const curSteps = cur && Array.isArray(cur.steps) ? cur.steps : [];
  const cur1 = curSteps.find((s) => s && s.key === 'publish/1-6') || null;
  const cur5 = curSteps.find((s) => s && s.key === 'publish/5-6') || null;
  const cur6 = curSteps.find((s) => s && s.key === 'publish/6-6') || null;
  check('成功的夜 status = success', !!cur && cur.status === 'success', { status: cur ? cur.status : null });
  check('来源认得出来', !!cur && cur.source === 'night', { source: cur ? cur.source : null });
  check('总耗时 = 结束 − 开始', !!cur && cur.durationMs === 31 * 60 * 1000 + 37 * 1000, { durationMs: cur ? cur.durationMs : null });
  check('退出码取得到', !!cur && cur.exitCode === 0);
  check('步骤恒为 15 个', !!cur && curSteps.length === 15, { n: curSteps.length });
  check('没走到的步骤是 pending', !!cur5 && cur5.status === 'pending');
  check('走到的步骤是 done', !!cur1 && cur1.status === 'done');
  check('文案以日志实际出现的为准',
    !!cur6 && cur6.label.indexOf('项目 daily-image-site') >= 0);

  /* 失败夜 */
  const failed = build({
    date: '2026-11-19', done: { date: '2026-11-19', at: '2026-11-19T00:30:00+08:00', exit: 1, by: null },
    logText: '=== 5/6 上传图片到 R2 ===  [00:28:00]\n=== NIGHT_DONE exit=1 ===',
    logMtime: Date.parse('2026-11-19T00:30:00+08:00'),
    now: Date.parse('2026-11-19T00:31:00+08:00'),
  });
  const failedSteps = failed && Array.isArray(failed.steps) ? failed.steps : [];
  const failed5 = failedSteps.find((s) => s && s.key === 'publish/5-6') || null;
  check('失败的夜 status = failed', !!failed && failed.status === 'failed');
  check('失败的那一步标 failed',
    !!failed5 && failed5.status === 'failed');
  check('失败夜出 error 级问题',
    !!failed && !!failed.problem && failed.problem.level === 'error',
    { problem: failed ? failed.problem : null });

  /* 没跑 */
  const notRun = build({
    date: '2026-11-21', done: null, logText: '', logMtime: 0,
    now: Date.parse('2026-11-21T09:00:00+08:00'),
  });
  check('没日志 → not-run', !!notRun && notRun.status === 'not-run');
  check('没跑出一条 info',
    !!notRun && !!notRun.problem && notRun.problem.level === 'info');

  /* 死了：日志停摆 10 分钟还没结束标记 */
  const dead = build({
    date: '2026-11-18', done: null,
    logText: '=== 6/6 部署 Cloudflare Pages ===  [00:30:00]',
    logMtime: Date.parse('2026-11-18T00:30:00+08:00'),
    now: Date.parse('2026-11-18T00:40:00+08:00'),
  });
  check('日志停摆 10 分钟 → dead', !!dead && dead.status === 'dead', { status: dead ? dead.status : null });
  check('dead 出 error 级问题', !!dead && !!dead.problem && dead.problem.level === 'error');

  /* 中位数只用成功的夜 */
  const history = [
    { date: '2026-11-16', status: 'success', durationMs: 15 * 60 * 1000, steps: [{ key: 'publish/1-6', durationMs: 60 * 1000 }] },
    { date: '2026-11-17', status: 'success', durationMs: 16 * 60 * 1000, steps: [{ key: 'publish/1-6', durationMs: 80 * 1000 }] },
    { date: '2026-11-18', status: 'success', durationMs: 14 * 60 * 1000, steps: [{ key: 'publish/1-6', durationMs: 40 * 1000 }] },
    { date: '2026-11-19', status: 'failed', durationMs: 40 * 60 * 1000, steps: [{ key: 'publish/1-6', durationMs: 39 * 60 * 1000 }] },
  ];
  /* 阶段中位数也得只用成功的夜 —— 失败夜那 39 分钟不能混进去
     （混进去的话中位数会从 60 秒变成 70 秒）。 */
  const med = typeof ST.stepMedians === 'function' ? ST.stepMedians(history) : null;
  const medStep = med instanceof Map ? med.get('publish/1-6') : null;
  check('中位数只用成功的夜（15 分，不是 22 分）',
    ST.median(history.filter((h) => h.status === 'success').map((h) => h.durationMs)) === 15 * 60 * 1000
    && medStep === 60 * 1000,
    { medStep });

  /* 慢夜 → warn
     ⚠️ 这份样本要有**两个**阶段标记：只写一个的话，那一步的耗时 = 整夜的总耗时
     （最后一个阶段的耗时是「结束时刻 − 本阶段开始」= 31 分 37 秒），
     于是 F4 的阶段级慢（该步 > 基线 × 3）会抢在夜级慢前面 ——
     真实的夜有 15 个阶段，最后一段只是一部分，不是整夜。 */
  const slow = build({
    date: '2026-11-20', done: { date: '2026-11-20', at: '2026-11-20T00:41:39+08:00', exit: 0, by: null },
    logText: '=== 1/6 刷新 Cloudflare token ===  [00:10:02]\n=== 2/6 构建页面与图片 ===  [00:12:20]\n=== NIGHT_DONE exit=0 ===',
    logMtime: Date.parse('2026-11-20T00:41:39+08:00'),
    now: Date.parse('2026-11-20T00:42:00+08:00'),
  });
  const p = typeof ST.pickProblem === 'function' ? ST.pickProblem(slow, history) : null;
  const pDetail = p && typeof p.detail === 'string' ? p.detail : null;
  check('31 分 vs 中位数 15 分 → warn 级', !!p && p.level === 'warn', { problem: p });
  check('warn 文案里带平时多久',
    !!pDetail && pDetail.indexOf('平时中位数 15 分 0 秒') >= 0, { detail: pDetail });
}

/* ── 3b. 事实校正（F1–F10 + 真实数据回归） ────────────────── */
{
  /* ⚠️ 同第 3 组：实现还没写出来时，下面每条断言要**报红**，不能整个套件崩掉。
     取值全部先落到安全变量，条件里再判存在性 —— 前置不满足就是一条红。 */
  const hasBuild = typeof ST.buildCurrent === 'function';
  const build = hasBuild ? ST.buildCurrent : () => null;
  const hasPick = typeof ST.pickProblem === 'function';
  const pick = hasPick ? ST.pickProblem : () => null;

  /* ── F1：`.done` 是权威完成记录（脚本先写 `.done`、后写日志标记） ── */

  /* F1-1：`.done` 存在（exit=1）但日志没有结束标记 → 按 `.done` 判 failed。
     形状：老版本脚本写完 `.done` 就被杀（磁盘满 / 被腰斩），日志里没有结束标记。 */
  const f1a = build({
    date: '2026-11-19', done: { date: '2026-11-19', at: '2026-11-19T00:30:00+08:00', exit: 1, by: null },
    logText: '', logMtime: 0, now: Date.parse('2026-11-19T00:31:00+08:00'),
  });
  check('`.done` 存在但日志没有结束标记 → 按 `.done` 的 exit 判 failed',
    !!f1a && f1a.status === 'failed' && f1a.exitCode === 1,
    { status: f1a ? f1a.status : null, exitCode: f1a ? f1a.exitCode : null });

  /* F1-2：`.done` exit=0 → success，即使日志缺结束标记。 */
  const f1b = build({
    date: '2026-11-15', done: { date: '2026-11-15', at: '2026-11-15T19:45:21+08:00', exit: 0, by: 'manual' },
    logText: '=== 6/6 部署 Cloudflare Pages（项目 daily-image-site） ===',
    logMtime: Date.parse('2026-11-15T19:43:28+08:00'), now: Date.parse('2026-11-15T19:46:00+08:00'),
  });
  check('`.done` 存在且 exit=0 → status=success，即使日志缺结束标记',
    !!f1b && f1b.status === 'success', { status: f1b ? f1b.status : null });

  /* F1-3：`.done` 的 exit 覆盖日志里的 exit（两者不同源时以 `.done` 为准）。 */
  const f1c = build({
    date: '2026-11-20', done: { date: '2026-11-20', at: '2026-11-20T00:41:39+08:00', exit: 1, by: null },
    logText: '=== 1/6 刷新 Cloudflare token ===  [00:10:02]\n=== NIGHT_DONE exit=0 ===',
    logMtime: Date.parse('2026-11-20T00:41:39+08:00'), now: Date.parse('2026-11-20T00:42:00+08:00'),
  });
  check('`.done` 的 exit 覆盖日志里的 exit',
    !!f1c && f1c.exitCode === 1 && f1c.status === 'failed',
    { exitCode: f1c ? f1c.exitCode : null, status: f1c ? f1c.status : null });

  /* F1-4：`.done` 的 by 决定 source（by=manual → manual；by=null → night）。 */
  const f1d = build({
    date: '2026-11-15', done: { date: '2026-11-15', at: '2026-11-15T19:45:21+08:00', exit: 0, by: 'manual' },
    logText: '=== 6/6 部署 Cloudflare Pages ===', logMtime: 0, now: Date.parse('2026-11-15T19:46:00+08:00'),
  });
  const f1e = build({
    date: '2026-11-20', done: { date: '2026-11-20', at: '2026-11-20T00:41:39+08:00', exit: 0, by: null },
    logText: '=== 6/6 部署 Cloudflare Pages ===', logMtime: 0, now: Date.parse('2026-11-20T00:42:00+08:00'),
  });
  check('`.done` 的 by 决定 source',
    !!f1d && f1d.source === 'manual' && !!f1e && f1e.source === 'night',
    { manual: f1d ? f1d.source : null, night: f1e ? f1e.source : null });

  /* F1-5：`.done` 不存在且日志空 → 仍然 not-run（防过度修正）。 */
  const f1f = build({
    date: '2026-11-21', done: null, logText: '', logMtime: 0,
    now: Date.parse('2026-11-21T09:00:00+08:00'),
  });
  check('`.done` 不存在且日志空 → 仍然 not-run',
    !!f1f && f1f.status === 'not-run', { status: f1f ? f1f.status : null });

  /* ── F2：dead 时最后一个观察到的步骤标 failed，文案点名 ── */
  const f2 = build({
    date: '2026-11-18', done: null,
    logText: '=== 5/6 上传图片到 R2 ===  [00:28:00]\n=== 6/6 部署 Cloudflare Pages ===  [00:30:00]',
    logMtime: Date.parse('2026-11-18T00:30:00+08:00'), now: Date.parse('2026-11-18T00:40:00+08:00'),
  });
  const f2Steps = f2 && Array.isArray(f2.steps) ? f2.steps : [];
  const f2Last = f2Steps.find((s) => s && s.key === 'publish/6-6') || null;
  const f2Prev = f2Steps.find((s) => s && s.key === 'publish/5-6') || null;
  check('dead 状态最后一个观察到的步骤标 failed',
    !!f2 && f2.status === 'dead'
    && !!f2Last && f2Last.status === 'failed'
    && !!f2Prev && f2Prev.status === 'done',
    {
      status: f2 ? f2.status : null,
      last: f2Last ? f2Last.status : null,
      prev: f2Prev ? f2Prev.status : null,
    });
  const f2Detail = f2 && f2.problem && typeof f2.problem.detail === 'string' ? f2.problem.detail : null;
  check('dead 的问题文案点名了最后那个步骤',
    !!f2Detail && f2Detail.indexOf('部署 Cloudflare Pages') >= 0, { detail: f2Detail });

  /* ── F3：日志格式变了 → unknown（不假装一切正常） ── */
  const f3 = build({
    date: '2026-11-19', done: { date: '2026-11-19', at: '2026-11-19T00:30:00+08:00', exit: 0, by: null },
    logText: '这是一份格式完全变了的日志：没有阶段标记，也没有结束标记。\n第二行还是一样。',
    logMtime: Date.parse('2026-11-19T00:30:00+08:00'), now: Date.parse('2026-11-19T00:31:00+08:00'),
  });
  check('日志有内容但没有阶段标记 → unknown（不是 running 也不是 dead）',
    !!f3 && f3.status === 'unknown', { status: f3 ? f3.status : null });
  const f3Detail = f3 && f3.problem && typeof f3.problem.detail === 'string' ? f3.problem.detail : null;
  check('unknown 的文案明说「日志格式变了」',
    !!f3Detail && f3Detail.indexOf('日志格式变了') >= 0, { detail: f3Detail });

  /* ── F4：pickProblem 对摘要条目不得产出 undefined ── */
  /* 摘要条目就是 Task 4 往 history 里放的那种：只有 date/status/durationMs/steps，
     **根本没有 exitCode 这个字段**（current.exitCode 是 undefined，不是 null）。 */
  const f4Summary = {
    date: '2026-11-19', status: 'failed', durationMs: 40 * 60 * 1000,
    steps: [{ key: 'publish/5-6', durationMs: 120000 }],
  };
  const f4 = pick(f4Summary, []);
  const f4Detail = f4 && typeof f4.detail === 'string' ? f4.detail : null;
  check("pickProblem 作用在 status='failed' 的摘要条目上，detail 里不出现 'undefined'",
    !!f4Detail && f4Detail.indexOf('undefined') < 0 && f4Detail.indexOf('退出码未知') >= 0,
    { detail: f4Detail });

  /* ── F5：中位数基线排除当前这一夜 ── */
  const f5Current = { date: '2026-11-20', status: 'success', durationMs: 1850000, exitCode: 0, steps: [] };
  const f5Clean = [
    { date: '2026-11-16', status: 'success', durationMs: 900000, steps: [] },
    { date: '2026-11-17', status: 'success', durationMs: 960000, steps: [] },
    { date: '2026-11-18', status: 'success', durationMs: 840000, steps: [] },
  ];
  const f5WithToday = f5Clean.concat([
    { date: '2026-11-20', status: 'success', durationMs: 1850000, steps: [] },
  ]);
  const f5a = pick(f5Current, f5Clean);
  const f5b = pick(f5Current, f5WithToday);
  check('今天的夜慢到 30 分 50 秒、干净基线中位数 15 分 → warn 级',
    !!f5a && f5a.level === 'warn', { problem: f5a });
  check('把今天自己也放进 history 后，仍然 warn',
    !!f5b && f5b.level === 'warn', { problem: f5b });

  /* ── F6：buildCurrent 传入历史 → current.problem 能出慢夜告警 ── */
  const f6 = build({
    date: '2026-11-20', done: { date: '2026-11-20', at: '2026-11-20T00:41:39+08:00', exit: 0, by: null },
    logText: '=== 1/6 刷新 Cloudflare token ===  [00:10:02]\n=== NIGHT_DONE exit=0 ===',
    logMtime: Date.parse('2026-11-20T00:41:39+08:00'), now: Date.parse('2026-11-20T00:42:00+08:00'),
    history: f5Clean,
  });
  check('buildCurrent 传入历史后，慢夜的 current.problem.level = warn',
    !!f6 && !!f6.problem && f6.problem.level === 'warn',
    { problem: f6 ? f6.problem : null });

  /* ── F7：running=true 时不判 dead ── */
  const f7 = build({
    date: '2026-11-20', done: null,
    logText: '=== 1/6 刷新 Cloudflare token ===  [00:30:00]',
    logMtime: Date.parse('2026-11-20T00:30:00+08:00'), now: Date.parse('2026-11-20T00:45:00+08:00'),
    running: true,
  });
  check('running=true 时不判 dead（长静默步骤不误报）',
    !!f7 && f7.status === 'running', { status: f7 ? f7.status : null });

  /* ── F8：startedAt / finishedAt 输出北京时间（带 +08:00），不是 UTC ── */
  const f8 = build({
    date: '2026-11-20', done: { date: '2026-11-20', at: '2026-11-20T00:41:39+08:00', exit: 0, by: null },
    logText: '=== 1/6 刷新 Cloudflare token ===  [00:10:02]\n=== NIGHT_DONE exit=0 ===',
    logMtime: Date.parse('2026-11-20T00:41:39+08:00'), now: Date.parse('2026-11-20T00:42:00+08:00'),
  });
  check('startedAt / finishedAt 带 +08:00',
    !!f8
    && typeof f8.startedAt === 'string' && f8.startedAt.indexOf('+08:00') >= 0
    && typeof f8.finishedAt === 'string' && f8.finishedAt.indexOf('+08:00') >= 0
    && f8.startedAt === '2026-11-20T00:10:02+08:00',
    { startedAt: f8 ? f8.startedAt : null, finishedAt: f8 ? f8.finishedAt : null });

  /* ── 真实数据回归：母本真实的 11-15（本次修复的牙齿） ──────────
     `.night-publish-2026-11-15.done` 原文（带 BOM）：
       { "date": "2026-11-15", "by": "manual",
         "at": "2026-11-15T19:45:21.4467543+08:00", "exit": 0 }
     同晚日志 `.manual-publish-2026-11-15.log`（老版本 manual-publish.ps1）
     **全文搜 DONE 零命中** —— 那一次发布是真成功的，但按「只看日志标记」判会变「卡住了」。 */
  const realDoneRaw = '\uFEFF{\n    "date":  "2026-11-15",\n    "by":  "manual",\n    "at":  "2026-11-15T19:45:21.4467543+08:00",\n    "exit":  0\n}';
  const realDone = ST.parseDone(realDoneRaw);
  const realLog = [
    '=== 1/3 每日准备（抓图 → 头条 → 清洗 → 构建） ===',
    '=== 0/4 准备环境 ===',
    '=== 1/4 抓图 + 目录分流 ===',
    '=== 6/6 部署 Cloudflare Pages（项目 daily-image-site） ===',
  ].join('\n');
  const realCur = build({
    date: '2026-11-15', done: realDone, logText: realLog,
    logMtime: Date.parse('2026-11-15T19:43:28+08:00'), now: Date.parse('2026-11-20T09:00:00+08:00'),
  });
  check('真实 11-15：`.done` exit=0 但日志没有结束标记 → status=success',
    !!realCur && realCur.status === 'success', { status: realCur ? realCur.status : null });
  check('真实 11-15：source=manual（由 `.done` 的 by 决定）',
    !!realCur && realCur.source === 'manual', { source: realCur ? realCur.source : null });
  check('真实 11-15：exitCode=0',
    !!realCur && realCur.exitCode === 0, { exitCode: realCur ? realCur.exitCode : null });
  const realProblem = realCur && realCur.problem ? realCur.problem : null;
  check('真实 11-15：problem 不是 error 级（不误报红色告警）',
    !realProblem || realProblem.level !== 'error', { problem: realProblem });
}

/* ── 3c. 事实校正第二轮（F1–F5） ───────────────────────── */
{
  /* ⚠️ 同前：实现不存在时下面每条断言要**报红**，不能整个套件崩掉。
     取值先落到安全变量，条件里再判存在性 —— 前置不满足就是一条红。 */
  const hasBuild = typeof ST.buildCurrent === 'function';
  const build = hasBuild ? ST.buildCurrent : () => null;
  const hasPick = typeof ST.pickProblem === 'function';
  const pick = hasPick ? ST.pickProblem : () => null;

  /* ── F1：unknown 的级别按完成记录分级（exit≠0 才 error） ── */
  const noMarkerLog = '这是一份格式完全变了的日志：没有阶段标记，也没有结束标记。';
  const f1a = build({
    date: '2026-11-19', done: { date: '2026-11-19', at: '2026-11-19T00:30:00+08:00', exit: 0, by: null },
    logText: noMarkerLog,
    logMtime: Date.parse('2026-11-19T00:30:00+08:00'), now: Date.parse('2026-11-19T00:31:00+08:00'),
  });
  const f1aProblem = f1a && f1a.problem ? f1a.problem : null;
  check('`.done` 说 exit=0 的 unknown → 不是 error 级',
    !!f1a && f1a.status === 'unknown' && !!f1aProblem && f1aProblem.level !== 'error',
    { status: f1a ? f1a.status : null, level: f1aProblem ? f1aProblem.level : null });

  const f1b = build({
    date: '2026-11-19', done: { date: '2026-11-19', at: '2026-11-19T00:30:00+08:00', exit: 1, by: null },
    logText: noMarkerLog,
    logMtime: Date.parse('2026-11-19T00:30:00+08:00'), now: Date.parse('2026-11-19T00:31:00+08:00'),
  });
  const f1bProblem = f1b && f1b.problem ? f1b.problem : null;
  check('`.done` 说 exit≠0 的 unknown → error 级',
    !!f1b && f1b.status === 'unknown' && !!f1bProblem && f1bProblem.level === 'error',
    { status: f1b ? f1b.status : null, level: f1bProblem ? f1bProblem.level : null });

  const f1c = build({
    date: '2026-11-19', done: null, logText: noMarkerLog,
    logMtime: Date.parse('2026-11-19T00:30:00+08:00'), now: Date.parse('2026-11-19T00:31:00+08:00'),
  });
  const f1cProblem = f1c && f1c.problem ? f1c.problem : null;
  check('没有 `.done` 的 unknown → 不是 error 级',
    !!f1c && f1c.status === 'unknown' && !!f1cProblem && f1cProblem.level !== 'error',
    { status: f1c ? f1c.status : null, level: f1cProblem ? f1cProblem.level : null });

  /* ── F2：`.done` 的 exit 坏了 → 不从日志兜底（同源不破） ── */
  const f2Done = ST.parseDone('\uFEFF{ "date": "2026-11-19", "at": "2026-11-19T00:30:00+08:00", "exit": "x" }');
  const f2 = build({
    date: '2026-11-19', done: f2Done,
    logText: '=== 1/6 刷新 Cloudflare token ===  [00:10:02]\n=== NIGHT_DONE exit=0 ===',
    logMtime: Date.parse('2026-11-19T00:30:00+08:00'), now: Date.parse('2026-11-19T00:31:00+08:00'),
  });
  check('`.done` 的 exit 坏了 → exitCode 取 null，不从日志兜底',
    !!f2 && f2.exitCode === null,
    { exitCode: f2 ? f2.exitCode : null });

  /* ── F3：dead 的死因（stale / timeout）措辞要跟 title 一致 ── */
  /* timeout 造法：日志刚动过（不是 stale：age < 6 分钟）+ 距开始超过 45 分钟。 */
  const f3 = build({
    date: '2026-11-18', done: null,
    logText: '=== 6/6 部署 Cloudflare Pages ===  [00:30:00]',
    logMtime: Date.parse('2026-11-18T01:15:00+08:00'),   // 日志 5 分钟前刚动过 → 不 stale
    now: Date.parse('2026-11-18T01:20:00+08:00'),         // 距开始 50 分钟 → 超时
  });
  const f3Detail = f3 && f3.problem && typeof f3.problem.detail === 'string' ? f3.problem.detail : null;
  check('dead 是 timeout 死因 → detail 说 45 分钟，不说 6 分钟',
    !!f3 && f3.status === 'dead'
    && !!f3Detail && f3Detail.indexOf('45 分钟') >= 0 && f3Detail.indexOf('6 分钟') < 0,
    { status: f3 ? f3.status : null, detail: f3Detail });

  /* ── F4：阶段级慢告警（spec §6.2：某阶段 > 中位数 × 3） ── */
  const f4Hist = [
    { date: '2026-11-16', status: 'success', durationMs: 900000, steps: [{ key: 'publish/5-6', durationMs: 60000 }] },
    { date: '2026-11-17', status: 'success', durationMs: 960000, steps: [{ key: 'publish/5-6', durationMs: 80000 }] },
    { date: '2026-11-18', status: 'success', durationMs: 840000, steps: [{ key: 'publish/5-6', durationMs: 40000 }] },
  ];
  /* 今夜：publish/5-6 用了 200 秒，平时中位数 60 秒 → 3.3 倍 → 命中；
     夜级总耗时 900000 = 夜级中位数 → 不触发夜级慢（只测阶段级这一条路）。
     finishedAt 要给：阶段级只比**闭合区间**（结束时刻已知）→
     结束时刻未知时最后那一段不参与比较。成功的夜一定有 `.done` → 结束时刻已知。 */
  const f4Current = {
    date: '2026-11-20', status: 'success', durationMs: 900000, exitCode: 0,
    finishedAt: '2026-11-20T00:41:39+08:00',
    steps: [{ key: 'publish/5-6', label: '上传图片到 R2', status: 'done', durationMs: 200000 }],
  };
  const f4Problem = pick(f4Current, f4Hist);
  check('某阶段 > 中位数 × 3 → warn 级',
    !!f4Problem && f4Problem.level === 'warn', { problem: f4Problem });
  const f4Title = f4Problem && typeof f4Problem.title === 'string' ? f4Problem.title : null;
  check('阶段慢的文案点名了那个阶段',
    !!f4Title && f4Title.indexOf('上传图片到 R2') >= 0, { title: f4Title });

  /* ── F5：06:00 闸门（spec §6.2：现在 > 06:00 且今天没有 .done → info） ── */
  const f5NotRun = { date: '2026-11-21', status: 'not-run', exitCode: null, durationMs: null, steps: [] };
  /* now 与 nowBjHour 都给：实现认哪个都能得到确定的结果（不依赖跑护栏的真实时刻）。 */
  const f5Early = pick(f5NotRun, [], { now: Date.parse('2026-11-21T05:30:00+08:00'), nowBjHour: 5 });
  check('06:00 之前没跑 → 不算问题',
    hasPick && f5Early === null, { problem: f5Early });
  const f5Late = pick(f5NotRun, [], { now: Date.parse('2026-11-21T09:00:00+08:00'), nowBjHour: 9 });
  const f5LateProblem = f5Late || null;
  check('06:00 之后今天没跑 → info 级',
    !!f5LateProblem && f5LateProblem.level === 'info', { problem: f5LateProblem });
}

/* ── 3d. 复评加固（3 条 Minor） ─────────────────────────── */
{
  /* ⚠️ 同前：实现不存在时每条断言要**报红**，不能整个套件崩掉。 */
  const hasBuild = typeof ST.buildCurrent === 'function';
  const build = hasBuild ? ST.buildCurrent : () => null;
  const hasPick = typeof ST.pickProblem === 'function';
  const pick = hasPick ? ST.pickProblem : () => null;

  /* 阶段基线：publish/5-6 平时 60 秒。 */
  const dHist = [
    { date: '2026-11-16', status: 'success', durationMs: 900000, steps: [{ key: 'publish/5-6', durationMs: 60000 }] },
    { date: '2026-11-17', status: 'success', durationMs: 960000, steps: [{ key: 'publish/5-6', durationMs: 80000 }] },
    { date: '2026-11-18', status: 'success', durationMs: 840000, steps: [{ key: 'publish/5-6', durationMs: 40000 }] },
  ];

  /* ── M-2-a：running 的夜，最后那一段的耗时是「到目前为止」，
     还在涨 → 不能拿去和历史基线比（否则会出现一条数字一直变的告警）。 ── */
  const dRunning = {
    date: '2026-11-20', status: 'running', durationMs: null, exitCode: null,
    steps: [{ key: 'publish/5-6', label: '上传图片到 R2', status: 'running', durationMs: 900000 }],
  };
  const dRunningProblem = pick(dRunning, dHist) || null;
  check('running 的夜不拿「还在涨」的那一段去比基线',
    hasPick && dRunningProblem === null, { problem: dRunningProblem });

  /* ── M-2-b：running 的夜里**已经走完**的那一段是闭合的 → 照常比基线。
     闭合的那段必须是**有基线**的 publish/5-6（基线 60 秒）；
     还在跑的那段是 publish/6-6（它没有基线，也会被「只比闭合区间」规则挡掉）。 ── */
  const dRunning2 = {
    date: '2026-11-20', status: 'running', durationMs: null, exitCode: null,
    steps: [
      { key: 'publish/5-6', label: '上传图片到 R2', status: 'done', durationMs: 600000 },
      { key: 'publish/6-6', label: '部署 Cloudflare Pages', status: 'running', durationMs: 900000 },
    ],
  };
  const dRunning2Problem = pick(dRunning2, dHist) || null;
  check('running 的夜里已经走完的那一段照常比基线',
    !!dRunning2Problem && dRunning2Problem.level === 'warn'
    && typeof dRunning2Problem.title === 'string'
    && dRunning2Problem.title.indexOf('上传图片到 R2') >= 0,
    { problem: dRunning2Problem });

  /* ── M-1：`.done` 存在但 `exit` 读不出来 → 完成记录**在**，只是读不出退出码。
     文案不能说「没有完成记录」—— 那与事实相反。 ── */
  const dBadExit = build({
    date: '2026-11-19',
    done: { date: '2026-11-19', at: '2026-11-19T00:30:00+08:00', exit: null, by: null },
    logText: '这是一份格式完全变了的日志：没有阶段标记，也没有结束标记。',
    logMtime: Date.parse('2026-11-19T00:30:00+08:00'), now: Date.parse('2026-11-19T00:31:00+08:00'),
  });
  const dBadExitDetail = dBadExit && dBadExit.problem && typeof dBadExit.problem.detail === 'string'
    ? dBadExit.problem.detail : null;
  check('`.done` 的 exit 读不出来 → 文案说「完成记录 exit 读不出来」',
    !!dBadExit && dBadExit.status === 'unknown'
    && !!dBadExitDetail && dBadExitDetail.indexOf('完成记录 exit 读不出来') >= 0
    && dBadExitDetail.indexOf('没有完成记录') < 0,
    { status: dBadExit ? dBadExit.status : null, detail: dBadExitDetail });

  /* ── M-3-a：阶段基线全是 0 → **不判**（否则「平时 0 秒」→ 任何耗时都超 3 倍）。 ── */
  const dZeroHist = [
    { date: '2026-11-16', status: 'success', durationMs: 900000, steps: [{ key: 'publish/5-6', durationMs: 0 }] },
    { date: '2026-11-17', status: 'success', durationMs: 960000, steps: [{ key: 'publish/5-6', durationMs: 0 }] },
  ];
  const dZero = {
    date: '2026-11-20', status: 'success', durationMs: 900000, exitCode: 0,
    finishedAt: '2026-11-20T00:41:39+08:00',
    steps: [{ key: 'publish/5-6', label: '上传图片到 R2', status: 'done', durationMs: 100000 }],
  };
  const dZeroProblem = pick(dZero, dZeroHist) || null;
  check('阶段基线是 0 → 不判阶段级慢',
    hasPick && dZeroProblem === null, { problem: dZeroProblem });

  /* ── M-3-b：只给 `opts.now`（不给 `nowBjHour`）→ bjHour 推导通路要成立。 ── */
  const dOnlyNow = pick(
    { date: '2026-11-21', status: 'not-run', exitCode: null, durationMs: null, steps: [] },
    [], { now: Date.parse('2026-11-21T05:30:00+08:00') });
  check('只给 opts.now 也能推出北京时 05:30 → 不算问题',
    hasPick && dOnlyNow === null, { problem: dOnlyNow || null });

  /* ── M-3-c：unknown 的文案要如实说出完成记录的退出码。 ── */
  const dOkExit = build({
    date: '2026-11-19',
    done: { date: '2026-11-19', at: '2026-11-19T00:30:00+08:00', exit: 0, by: null },
    logText: '这是一份格式完全变了的日志：没有阶段标记，也没有结束标记。',
    logMtime: Date.parse('2026-11-19T00:30:00+08:00'), now: Date.parse('2026-11-19T00:31:00+08:00'),
  });
  const dOkExitDetail = dOkExit && dOkExit.problem && typeof dOkExit.problem.detail === 'string'
    ? dOkExit.problem.detail : null;
  check('unknown 的文案带出「完成记录 exit=0」',
    !!dOkExit && dOkExit.status === 'unknown'
    && !!dOkExitDetail && dOkExitDetail.indexOf('完成记录 exit=0') >= 0,
    { status: dOkExit ? dOkExit.status : null, detail: dOkExitDetail });
}

/* ── 3e. 合并形状与「结束时刻未知」（复评第 2 轮 Minor） ── */
{
  const hasBuild = typeof ST.buildCurrent === 'function';
  const build = hasBuild ? ST.buildCurrent : () => null;

  /* publish/5-6 的历史基线 = 60 秒。 */
  const eHist = [
    { date: '2026-11-16', status: 'success', durationMs: 900000, steps: [{ key: 'publish/5-6', durationMs: 60000 }] },
    { date: '2026-11-17', status: 'success', durationMs: 960000, steps: [{ key: 'publish/5-6', durationMs: 80000 }] },
    { date: '2026-11-18', status: 'success', durationMs: 840000, steps: [{ key: 'publish/5-6', durationMs: 40000 }] },
  ];

  /* ── E1：走**真实 mergeSteps** 的 running 夜 ——
     合并后的 steps 恒为 15 个节点（pending 在后面），
     所以「最后一个观察到的步骤」**不是数组最后一个元素**。
     开放尾段（publish/5-6，还在涨）不参与阶段级比较 → 没有任何告警。
     这条同时钉死两个变异：
     ① 把「最后一个有耗时的步骤」改成「数组最后一个元素」
     ② 把 pending 的 durationMs 从 null 改成 0 ── */
  const e1 = build({
    date: '2026-11-20', done: null,
    logText: [
      '=== 1/6 刷新 Cloudflare token ===  [00:10:02]',
      '=== 5/6 上传图片到 R2 ===  [00:20:00]',
    ].join('\n'),
    logMtime: Date.parse('2026-11-20T00:46:00+08:00'),   /* 4 分钟前刚动过 → 还在跑，不是 dead */
    now: Date.parse('2026-11-20T00:50:00+08:00'),
    history: eHist,
  });
  const e1Steps = e1 && Array.isArray(e1.steps) ? e1.steps : [];
  const e1Problem = e1 && e1.problem ? e1.problem : null;
  check('走真实 mergeSteps 的 running 夜：开放尾段不参与阶段级比较',
    !!e1 && e1Steps.length === 15 && e1.status === 'running' && e1Problem === null,
    { n: e1Steps.length, status: e1 ? e1.status : null, problem: e1Problem });

  /* ── E2：同一夜里**已经走完**的那一段（闭合）照常比基线。 ── */
  const e2 = build({
    date: '2026-11-20', done: null,
    logText: [
      '=== 5/6 上传图片到 R2 ===  [00:10:02]',
      '=== 6/6 部署 Cloudflare Pages ===  [00:20:00]',
    ].join('\n'),
    logMtime: Date.parse('2026-11-20T00:46:00+08:00'),   /* 4 分钟前刚动过 → 还在跑 */
    now: Date.parse('2026-11-20T00:50:00+08:00'),
    history: eHist,
  });
  const e2Problem = e2 && e2.problem ? e2.problem : null;
  check('走真实 mergeSteps 的 running 夜：已闭合的中段照常比基线',
    !!e2Problem && e2Problem.level === 'warn'
    && typeof e2Problem.title === 'string'
    && e2Problem.title.indexOf('上传图片到 R2') >= 0,
    { problem: e2Problem });

  /* ── E3：`.done` 坏了（结束时刻未知）→ 开放尾段同样不参与比较。
     不修的话这一夜会出一条**每次轮询都涨**的告警
     （尾段耗时被量到「轮询时刻」而不是真正的结束时刻）。 ── */
  const e3Log = [
    '=== 5/6 上传图片到 R2 ===  [00:10:02]',
    '=== NIGHT_DONE exit=0 ===',
  ].join('\n');
  const e3a = build({
    date: '2026-11-20', done: null,          /* 模拟 `.done` 损坏 → parseDone 返回 null */
    logText: e3Log,
    logMtime: Date.parse('2026-11-20T00:10:02+08:00'),
    now: Date.parse('2026-11-20T00:10:02+08:00'),
    history: eHist,
  });
  const e3b = build({
    date: '2026-11-20', done: null,
    logText: e3Log,
    logMtime: Date.parse('2026-11-20T00:10:02+08:00'),
    now: Date.parse('2026-11-20T00:40:02+08:00'),   /* 30 分钟后的另一次轮询 */
    history: eHist,
  });
  const e3aProblem = e3a && e3a.problem ? e3a.problem : null;
  const e3bProblem = e3b && e3b.problem ? e3b.problem : null;
  check('`.done` 坏了（结束时刻未知）→ 告警数字不随轮询涨',
    !!e3a && !!e3b && e3a.status === 'success' && e3b.status === 'success'
    && e3aProblem === null && e3bProblem === null,
    { a: e3aProblem, b: e3bProblem });
}

/* ── 4. HTTP 层 ────────────────────────────────────────── */
{
  /* ⚠️ **动态 import + try/catch**，不用静态 import：
     实现文件还不存在时，静态 import 会让整个套件抛 ERR_MODULE_NOT_FOUND **崩掉**
     （一条断言都没跑）—— 护栏必须**一条条报红**，不能崩（同第 3 组那条纪律）。
     动态 import 失败 → createServer 取不到 → 下面每条断言的**前置**都不满足
     → 每条各自报红。
     （另：`import` 声明不能写在 `{ }` 块里 —— 那是 SyntaxError，
       会让整个套件直接崩掉，连红都看不到。所以 `http` 放在文件头的 import 区。） */
  let dash = null;
  try {
    dash = await import('./night-dashboard.mjs');
  } catch {
    dash = null;
  }
  const hasCreateServer = !!(dash && typeof dash.createServer === 'function');
  const createServer = hasCreateServer ? dash.createServer : null;

  /* allowWrite: false —— 测试里**绝不许**真的发起一次发布。
     写接口仍然会走「本机 + 跨站」两道门（所以 403 的断言是真的），
     只是过了门之后返回 503，不 spawn 任何东西。

     ⚠️ I-1（评审最高优先级）：写路径在 allowWrite:false 下必须**没有任何发布副作用**。
     用注入的 spawn 钩子观测 —— 这样即使实现被改坏（把 allowWrite 判断挪到 spawn 之后、
     或把 allowWrite 强制 true），套件最多只是**红**，**绝不会真的发一次发布**。

     ⚠️ 这个钩子必须挂在**主测试实例**上（不是另开一个实例）：
        现有的同源 POST 断言打的就是主实例 —— 主实例不挂钩子的话，
        一次「实现被改坏」的回归测试就会真的把发布拉起来。 */
  const spawnCalls = [];
  const inst = hasCreateServer
    ? createServer({
      port: 0, root: ROOT, schedule: false, allowWrite: false,
      spawnFn: (script, args) => { spawnCalls.push({ script, args }); return -1; },
    })
    : null;
  if (inst) {
    await new Promise((res) => inst.server.listen(0, '127.0.0.1', res));
  }
  const port = inst && typeof inst.getChosenPort === 'function' ? inst.getChosenPort() : 0;
  const base = 'http://127.0.0.1:' + port;

  async function req(path, opts = {}) {
    return await new Promise((resolve) => {
      const r = http.request(base + path, { method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      });
      r.on('error', () => resolve({ status: 0, body: '', headers: {} }));
      r.end(opts.body || '');
    });
  }

  const st = await req('/api/state');
  check('/api/state → 200', st.status === 200, { status: st.status });

  let j = null;
  try { j = JSON.parse(st.body); } catch { /* 下面断言会红 */ }
  check('/api/state 是合法 JSON', !!j);

  const jKeys = j ? Object.keys(j) : [];
  check('/api/state 有 ok/serverTime/schedule/current/history/actions 五个键',
    !!j && j.ok === true && !!j.serverTime && !!j.schedule && !!j.current && !!j.history && !!j.actions,
    { keys: jKeys });

  const cacheControl = st.headers && st.headers['cache-control'] ? String(st.headers['cache-control']) : '';
  check('/api/state 头里有 no-store', /no-store/.test(cacheControl), { cacheControl });

  const bad = await req('/api/log?date=不是日期');
  check('/api/log 非法日期 → 400', bad.status === 400, { status: bad.status });

  const far = await req('/api/log?date=2020-01-01');
  let farLines = null;
  try {
    const farJson = JSON.parse(far.body);
    farLines = farJson && Array.isArray(farJson.lines) ? farJson.lines : null;
  } catch { /* 下面断言会红 */ }
  check('/api/log 不存在的日期 → 200 空列表（不是 500）',
    far.status === 200 && !!farLines && farLines.length === 0,
    { status: far.status, lines: farLines });

  /* 跨站与本机判定 */
  const evil = await req('/api/run-now', {
    method: 'POST', headers: { Origin: 'http://evil.example.com' },
  });
  check('POST 跨站 Origin → 403', evil.status === 403, { status: evil.status });

  const same = await req('/api/run-now', {
    method: 'POST', headers: { Origin: 'http://127.0.0.1:' + port },
  });
  /* ⚠️ 前置（服务真的起来了）必须写在条件里：
     服务没起来时 same.status 是 0，「0 !== 403」会**空过** ——
     那是一条假绿（护栏会声称「同源没被拦」，其实它什么都没问）。 */
  check('POST 同源 Origin（动态端口）→ 不是 403',
    !!inst && same.status !== 403, { status: same.status, port });

  /* 静态资源的断言放在 Task 5 —— 那时才真的建出 tools/dashboard-ui/。
     本 Task 里页面还不存在，断言它 200 只会假红。 */

  /* 目录穿越：在受保护范围（UI_DIR = tools/dashboard-ui）**外面**真的放一个金丝雀文件。
     请求路径里的 .. 会被 URL 解析器提前归一化 —— 只断言 404 是**假绿**，
     必须看响应体里有没有金丝雀的内容。
     两条路径都要试：.. 形式（会被归一化）和 %2f 形式（服务器自己解码，才真走到防护分支）。

     ⚠️ 金丝雀放**两个位置**：
       ① `tools/.tmp-canary.txt` —— UI_DIR 的**上一级**，`%2f..%2f` 解出来正好指到它。
          只放这一个，`..` 形式那条断言才是有牙齿的（否则请求路径根本到不了这个文件）。
       ② 根目录 `.tmp-canary.txt` —— 多一层保险（万一 UI_DIR 变了）。
     两个都是「受保护范围之外」，都带同一个唯一标记。 */
  const canaryFiles = [
    path.join(ROOT, 'tools', '.tmp-canary.txt'),
    path.join(ROOT, '.tmp-canary.txt'),
  ];
  for (const f of canaryFiles) {
    try { fs.writeFileSync(f, 'CANARY-9f3a', 'utf8'); } catch { /* 写不了就让它红 */ }
  }
  try {
    const c1 = await req('/../.tmp-canary.txt');
    check('目录穿越（.. 形式）拿不到金丝雀',
      !!inst && c1.body.indexOf('CANARY-9f3a') < 0,
      { status: c1.status, body: c1.body.slice(0, 80) });
    const c2 = await req('/%2f..%2f.tmp-canary.txt');
    check('目录穿越（%2f 形式）拿不到金丝雀',
      !!inst && c2.body.indexOf('CANARY-9f3a') < 0,
      { status: c2.status, body: c2.body.slice(0, 80) });
  } finally {
    for (const f of canaryFiles) {
      try { fs.unlinkSync(f); } catch { /* 清理 */ }
    }
  }

  /* ① 写路径零副作用（I-1）—— 最要紧的一条。 */
  check('写接口在 allowWrite:false 下**不产生任何发布副作用**',
    !!inst && spawnCalls.length === 0, { spawnCalls });

  /* ② allowWrite 的判断在 spawn 之前（I-1 的第二道网，静态顺序）。
        行为断言已经能抓住，但万一有人把 spawnFn 的默认值改回「真 spawn」，
        静态顺序这条还在。
        ⚠️ 读源码要包 try/catch：`read()` 读不到会**抛异常** → 整个套件崩掉，
           而崩掉的套件**没有 `✗` 行**（Task 8 按标签 grep 变异点时会误判「没抓到」）。
           读不到 → 空串 → 下面两条源码级断言各自干净地红。 */
  let dashSrc = '';
  try { dashSrc = read('tools/night-dashboard.mjs'); } catch { dashSrc = ''; }
  const dashCode = dashSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')                                  // 块注释
    .split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n'); // 行注释
  const iAllow = dashCode.indexOf('if (!allowWrite)');
  const iSpawnCall = dashCode.indexOf('spawnFn(');
  check('allowWrite 的判断在 spawn 调用之前（源码顺序）',
    iAllow >= 0 && iSpawnCall >= 0 && iAllow < iSpawnCall,
    { iAllow, iSpawnCall });

  /* ③ 只绑本机（I-3 · spec §10 第一条）。
        ⚠️ **必须是源码级断言**：护栏是自己 listen 的，查自己的 socket 恒为 127.0.0.1
        —— 源码改成 0.0.0.0 它照样绿（假绿，变异体 M6 照样存活）。
        要查的是**源码里那些 listen 调用**。 */
  const listenCalls = dashCode.split('\n').filter((l) => /\.listen\(/.test(l));
  check('服务只绑 127.0.0.1（源码里每个 listen 都带 127.0.0.1，且没有 0.0.0.0）',
    listenCalls.length > 0 &&
    listenCalls.every((l) => l.indexOf("'127.0.0.1'") >= 0) &&
    dashCode.indexOf('0.0.0.0') < 0,
    { listenCalls });

  if (inst) {
    await new Promise((res) => inst.server.close(res));
  }
}

/* ── 4c. 两道门 + 409（终审 Important-2 / Important-3） ───── */
{
  /* ⚠️ 需要 `dash`（第 4 组里 import 进来的模块）—— 这里自己再 import 一次，
     免得依赖别的块的块内变量（它们在块外取不到）。 */
  let dash4c = null;
  try { dash4c = await import('./night-dashboard.mjs'); } catch { dash4c = null; }
  const createServer4c = (dash4c && typeof dash4c.createServer === 'function') ? dash4c.createServer : null;

  /* ① guard() 的三件事（终审：这两条以前**一条断言都写不了** ——
        `guard` 没导出 → 只能拿源码去 grep，grep 不到就红 —— 那是「形状断言」，
        不是「行为断言」。本轮把 `export function guard` 导出（**行为一个字没改**）。 */
  const g = (dash4c && typeof dash4c.guard === 'function') ? dash4c.guard : null;
  const fakeReq = (addr, origin) => ({ socket: { remoteAddress: addr }, headers: origin ? { origin } : {} });
  const denyRemote = g ? g(fakeReq('10.1.2.3'), 8801) : '（guard 没导出）';
  check('guard() 挡掉非本机来源的写请求（只允许本机触发）',
    denyRemote === '只允许本机触发', { got: denyRemote });
  const denyOrigin = g ? g(fakeReq('127.0.0.1', 'http://evil.example.com'), 8801) : '（guard 没导出）';
  check('guard() 挡掉跨站 Origin 的写请求',
    denyOrigin === '跨站请求被拒绝', { got: denyOrigin });
  const allowLocal = g ? g(fakeReq('127.0.0.1', 'http://127.0.0.1:8801'), 8801) : '（guard 没导出）';
  check('guard() 放行本机同源请求（别把正常路径也一起挡了）',
    allowLocal === null, { got: allowLocal });

  /* ② 「已经有发布在跑 → 409」这道门（终审 Important-3：以前**零覆盖**）。
     ⚠️ **另开一个实例**：`allowWrite:true` + **假 spawn 钩子** + **假 busy 钩子**。
     即使 409 那道门被改坏，最坏也只是**记录到一次假 spawn**，
     **绝不可能真的发起一次发布**（spawnFn 是假的）。
     ⚠️ `isBusyFn` 是本轮新加的注入缝（跟 spawnFn 一个套路）：
        没有它，`isBusy()` 每次都要 spawn 一次 PowerShell 去看有没有发布在跑，
        这条断言根本没法写。 */
  const busySpawns = [];
  let instBusy = null;
  if (createServer4c) {
    try {
      instBusy = createServer4c({
        port: 0, root: ROOT, schedule: false, allowWrite: true,
        spawnFn: (script, args) => { busySpawns.push({ script, args }); return -1; },
        isBusyFn: () => true,
      });
    } catch { instBusy = null; }
  }
  let busyStatus = 0;
  if (instBusy) {
    await new Promise((res) => instBusy.server.listen(0, '127.0.0.1', res));
    const pb = instBusy.getChosenPort();
    const r = await new Promise((resolve) => {
      const rq = http.request('http://127.0.0.1:' + pb + '/api/run-now',
        { method: 'POST', headers: { origin: 'http://127.0.0.1:' + pb } }, (res) => {
          let b = ''; res.on('data', (c) => { b += c; });
          res.on('end', () => resolve({ status: res.statusCode, body: b }));
        });
      rq.on('error', () => resolve({ status: 0, body: '' }));
      rq.end();
    });
    busyStatus = r.status;
    try { instBusy.server.close(); } catch { /* 关不掉就算了 */ }
  }
  check('已经有发布在跑时写操作返回 409（并且一个发布都没起）',
    busyStatus === 409 && busySpawns.length === 0,
    { status: busyStatus, spawnCalls: busySpawns.length });
}

/* ── 4b. HTTP 层的三个洞（verifier 评审 I-2 / m-2） ─────── */
{
  /* ⚠️ 需要 `os` 模块：文件头加一行 `import os from 'node:os';`
        （加 import 不算改既有断言）。 */
  /* ⚠️ 建临时目录 / 写 fixture 都要包 try/catch：抛异常 → 整个套件崩掉，
     而崩掉的套件**没有 `✗` 行**（Task 8 按标签 grep 变异点时会误判「没抓到」）。
     建不出来 → 下面的断言靠 `!!instM` / `!!instB` 前置各自干净地红。 */
  const mk = (prefix) => {
    try { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); } catch { return null; }
  };
  const writeFixture = (file, text) => {
    try { fs.writeFileSync(file, text, 'utf8'); return true; } catch { return false; }
  };

  /* ⚠️ 这两条 fixture 断言必须用 `createServer` 的**动态 import** 结果
     （第 4 组里那个 `dash` / `createServer` 变量在块内，第 4b 组取不到）
     → 在第 4b 组里自己再 import 一次。 */
  let dash4b = null;
  try { dash4b = await import('./night-dashboard.mjs'); } catch { dash4b = null; }
  const createServer4b = (dash4b && typeof dash4b.createServer === 'function') ? dash4b.createServer : null;

  /* ④ by:'manual' 的那一夜，日志必须取 manual 那份（I-2）。
        ⚠️ 真实数据里**暴露不出**这个差别：2026-11-15 有 by:'manual' 的 .done
        和 .manual-publish 日志，但**没有** .night-publish 日志 → 按固定顺序
        也恰好选中 manual → 变异体照样全绿。必须用**合成 fixture**。 */
  const tmpM = mk('dash-manual-');
  const DM = '2026-01-02';
  let instM = null;
  let mjson = null;
  let mStatus = 0;
  if (tmpM) {
    writeFixture(path.join(tmpM, '.night-publish-' + DM + '.done'),
      '\uFEFF{"date":"' + DM + '","at":"2026-01-02T01:00:00+08:00","exit":0,"by":"manual"}');
    writeFixture(path.join(tmpM, '.night-publish-' + DM + '.log'),
      '=== 1/5 抓图 + 目录分流 ===\n=== 2/5 抓头条 ===\n=== NIGHT_DONE exit=0 ===\n');
    writeFixture(path.join(tmpM, '.manual-publish-' + DM + '.log'),
      '=== 1/5 抓图 + 目录分流 ===\n=== 2/5 抓头条 ===\n=== MANUAL_DONE exit=0 ===\n');

    instM = createServer4b
      ? createServer4b({ port: 0, root: tmpM, schedule: false, allowWrite: false, spawnFn: () => -1 })
      : null;
    if (instM) {
      await new Promise((res) => instM.server.listen(0, '127.0.0.1', res));
      const pm = instM.getChosenPort();
      const mj = await new Promise((resolve) => {
        const r = http.request('http://127.0.0.1:' + pm + '/api/log?date=' + DM, (res) => {
          let b = ''; res.on('data', (c) => { b += c; });
          res.on('end', () => resolve({ status: res.statusCode, body: b }));
        });
        r.on('error', () => resolve({ status: 0, body: '' }));
        r.end();
      });
      mStatus = mj.status;
      try { mjson = JSON.parse(mj.body); } catch { /* 下面断言会红 */ }
      await new Promise((res) => instM.server.close(res));
    }
  }
  /* ⚠️ 这条断言**必须在 if 外面**：前置不满足时它要**红**，
     不是被 if 跳过（护栏纪律：前置不满足就是一条红，不是跳过、不是崩）。 */
  check('by:manual 那一夜取的是 manual 日志（不是夜间日志）',
    !!tmpM && !!instM && !!mjson && mjson.source === 'manual',
    { source: mjson && mjson.source, status: mStatus });

  /* ⑤ /api/log 只读**尾部 64KB**（m-2 · spec §9「日志变大」）。
        ⚠️ 怎么测才不是假绿？光看返回行数**没用** —— 整份读也是取最后 120 行，
        两边一模一样。要让**最后 120 行本身就超过 64KB**：
          正确实现（只读 64KB）→ 返回的行数**少于** 120；
          读整份（变异体）      → 返回 120 行。
        差得开，才测得出。 */
  const tmpB = mk('dash-big-');
  const DB = '2026-01-03';
  let instB = null;
  let blines = null;
  let bStatus = 0;
  if (tmpB) {
    const big = Array.from({ length: 200 }, (_, i) =>
      ('L' + i + ' ' + 'x'.repeat(1000)).padEnd(1010, 'y')).join('\n') + '\n';
    writeFixture(path.join(tmpB, '.night-publish-' + DB + '.log'), big);

    instB = createServer4b
      ? createServer4b({ port: 0, root: tmpB, schedule: false, allowWrite: false, spawnFn: () => -1 })
      : null;
    if (instB) {
      await new Promise((res) => instB.server.listen(0, '127.0.0.1', res));
      const pb = instB.getChosenPort();
      const bj = await new Promise((resolve) => {
        const r = http.request('http://127.0.0.1:' + pb + '/api/log?date=' + DB, (res) => {
          let b = ''; res.on('data', (c) => { b += c; });
          res.on('end', () => resolve({ status: res.statusCode, body: b }));
        });
        r.on('error', () => resolve({ status: 0, body: '' }));
        r.end();
      });
      bStatus = bj.status;
      let bjson = null;
      try { bjson = JSON.parse(bj.body); } catch { /* 下面断言会红 */ }
      blines = bjson && Array.isArray(bjson.lines) ? bjson.lines : null;
      await new Promise((res) => instB.server.close(res));
    }
  }
  /* ⚠️ 这条断言**必须在 if 外面**：前置不满足时它要**红**，
     不是被 if 跳过（护栏纪律：前置不满足就是一条红，不是跳过、不是崩）。 */
  check('/api/log 只读尾部 64KB（不读整份）',
    !!tmpB && !!instB && !!blines && blines.length > 0 && blines.length < 120,
    { lines: blines ? blines.length : null, status: bStatus });

  for (const d of [tmpM, tmpB]) {
    if (!d) continue;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 清理 */ }
  }
}

/* ── 4c. 脱离式起 PowerShell（2026-11-20 实测发现的 bug）──────────── */
let dashFix2 = null;
try { dashFix2 = await import('./night-dashboard.mjs'); } catch { dashFix2 = null; }

{
  /* ④ 脱离式起 PowerShell 的形状（2026-11-20 实测发现的 bug）。
        ⚠️ 直接 `spawn('powershell', …, {detached:true})` 会让 PowerShell **立刻退出（exit 0）**、
        脚本根本没跑 —— 那样「立即跑一次」会返回 202 却**什么都没做**。
        → Windows 必须走 `cmd /c start /b`（spec §4.3 原本就是这么写的）。
        ⚠️ `start` 的第一个带引号参数会被当成标题 → 标题位置传空串 `''`。 */
  const dShape = (dashFix2 && typeof dashFix2.detachedPowerShell === 'function')
    ? dashFix2.detachedPowerShell('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 3'])
    : null;
  check('脱离式起 PowerShell：Windows 走 cmd /c start /b（直连 detached 会让 PowerShell 秒退）',
    !!dShape && (process.platform !== 'win32' ||
      (dShape.cmd === 'cmd' && dShape.args.indexOf('/c') >= 0 &&
       dShape.args.indexOf('start') >= 0 && dShape.args.indexOf('/b') >= 0)),
    { cmd: dShape && dShape.cmd, args: dShape && dShape.args });

  /* ⑤ **行为实测**：真的起一个脱离的 PowerShell，看它是不是**真的在跑**。
        ⚠️ 只断言形状不够 —— 形状对了但 PowerShell 照样秒退，那发布路径还是死的。
        ⚠️ 别用 Node 的 `spawn('powershell', …)` 来起「假进程」做这个测试：
           本机实测那个会**静默起不来**（进程根本不出现）→ 探针自己假失败。
        这里起的是**无害**的（写个标记文件 + 睡几秒），不碰任何发布脚本。 */
  {
    const marker = path.join(os.tmpdir(), 'dash-detached-probe-' + Date.now() + '.txt');
    const dRun = (dashFix2 && typeof dashFix2.detachedPowerShell === 'function')
      ? dashFix2.detachedPowerShell('powershell',
        ['-NoProfile', '-Command',
          "Set-Content -LiteralPath '" + marker.replace(/'/g, "''") + "' -Value 'alive'; Start-Sleep -Seconds 8"])
      : null;
    if (dRun) {
      const probe = spawn(dRun.cmd, dRun.args, dRun.opts);
      await new Promise((r) => setTimeout(r, 2500));
      const ran = fs.existsSync(marker);
      /* 再等 3 秒查一次：起一下就退的进程，第二次查就该查不到了 */
      await new Promise((r) => setTimeout(r, 3000));
      const stillUp = (() => {
        try {
          /* ⚠️ **必须排除探测进程自己**（`-ne $PID`）：
             这条探测命令的命令行里也含探针标记 → 不排除的话「查到了」恒真，
             `stillUp` 会**永远为真** → 断言⑤ 变成假绿，测不出「起一下就退」。 */
          const q = spawnSync('powershell', ['-NoProfile', '-Command',
            "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'powershell|pwsh' -and " +
            "$_.CommandLine -like '*dash-detached-probe*' -and $_.ProcessId -ne $PID } | " +
            "Select-Object -ExpandProperty ProcessId"],
            { encoding: 'utf8', timeout: 20000 });
          return String(q.stdout || '').trim().split(/\r?\n/).filter((s) => s.trim()).length > 0;
        } catch { return false; }
      })();
      check('脱离式起的 PowerShell 真的在跑（不是秒退）',
        ran && stillUp, { pid: probe.pid, cmd: dRun.cmd, wrote: ran, alive: stillUp });
      try { fs.unlinkSync(marker); } catch { /* 清理 */ }
      /* ⚠️ 同样排除自己（`-ne $PID`）：否则这条清理命令会把自己也匹配上 →
         先把自己杀了 → 真正的探针进程留在后台。 */
      try { spawn('powershell', ['-NoProfile', '-Command',
        'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "dash-detached-probe" -and ' +
        '$_.ProcessId -ne $PID } | ' +
        'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'],
      { stdio: 'ignore', windowsHide: true }); } catch { /* 清理 */ }
    } else {
      check('脱离式起的 PowerShell 真的在跑（不是秒退）· detachedPowerShell 没导出', false, { reason: 'detachedPowerShell 没导出' });
    }
  }
}

/* ── 4d. 计划任务「上次结果码」这条判据（2026-11-21 实测发现的误报）───── */
let dashFix3 = null;
try { dashFix3 = await import('./night-dashboard.mjs'); } catch { dashFix3 = null; }

{
  /* ⚠️ **267009（0x41301 = SCHED_S_TASK_RUNNING）不是「上次跑挂了」，是「它正在跑」** ——
     Windows 在任务运行期间就把 `LastTaskResult` 报成这个码。
     不排除掉的话，**每天晚上发布进行中**任务台都会弹一条
     「上一次运行没有正常结束」→ **天天误报**，用户还以为出事了。
     （2026-11-21 00:23 实测：今晚这一轮正在跑，任务台就报了这条。）
     267011（0x41303 = SCHED_S_TASK_HAS_NOT_RUN，「从未运行」）同样不是失败。 */
  const schedRunning = (dashFix3 && typeof dashFix3.scheduleProblem === 'function')
    ? dashFix3.scheduleProblem({ available: true, name: 'T', state: 'Running', lastResult: 267009 })
    : '（scheduleProblem 没导出）';
  check('计划任务「正在运行」（结果码 267009）不算「上次没正常结束」',
    schedRunning === null, { got: schedRunning });

  /* ⚠️ 反向那条：**真的失败了仍然要报** —— 防止「一刀切返回 null」把这条判据整个废掉。 */
  const schedFailed = (dashFix3 && typeof dashFix3.scheduleProblem === 'function')
    ? dashFix3.scheduleProblem({ available: true, name: 'T', state: 'Ready', lastResult: 267014 })
    : null;
  check('计划任务真的失败时仍然要报（结果码 267014）',
    !!schedFailed && schedFailed.level === 'info' && /267014/.test(schedFailed.title || ''),
    { got: schedFailed });

  /* ⚠️⚠️ **终审实测抓到的「假护栏」**：上面那条 267009 的断言**同时**给了
     `state:'Running'` → 而实现里 `state === 'Running'` 那一行排在**码排除之后**
     → 就算有人把**码排除那一行删了**，这条断言照样绿 → **码判断压根没被单独测过**，
     修复轮 3 那个「每晚误报」的回归**不会被抓住**。
     → 这两条专门测**码排除本身**：状态不是 Running，只靠结果码也必须判成「不是失败」。
     （终审变异 N1：删掉码排除 → 这两条红。） */
  const schedCodeOnly = (dashFix3 && typeof dashFix3.scheduleProblem === 'function')
    ? dashFix3.scheduleProblem({ available: true, name: 'T', state: 'Ready', lastResult: 267009 })
    : '（scheduleProblem 没导出）';
  check('计划任务 267009 只靠结果码也判成「不是失败」（不依赖 state==Running）',
    schedCodeOnly === null, { got: schedCodeOnly });
  const schedNever = (dashFix3 && typeof dashFix3.scheduleProblem === 'function')
    ? dashFix3.scheduleProblem({ available: true, name: 'T', state: 'Ready', lastResult: 267011 })
    : '（scheduleProblem 没导出）';
  check('计划任务 267011「从未运行」也不算失败（不依赖 state==Running）',
    schedNever === null, { got: schedNever });
}

/* ── 5. 页面 ───────────────────────────────────────────── */
{
  const idx = read('tools/dashboard-ui/index.html');
  check('index.html 存在且非空', idx.length > 200, { len: idx.length });
  check('index.html 引了 app.css 和 app.js', /app\.css/.test(idx) && /app\.js/.test(idx));
  check('index.html 有「立即跑一次」和「补发某一天」两个独立入口',
    idx.indexOf('立即跑一次') >= 0 && idx.indexOf('补发某一天') >= 0);

  const cssSrc = read('tools/dashboard-ui/app.css');
  check('app.css 里有暗色模式', /prefers-color-scheme/.test(cssSrc));
  check('app.css 里有素白文档风的三个底色',
    /#ffffff/i.test(cssSrc) && /#1d1d1f/i.test(cssSrc) && /#86868b/i.test(cssSrc));

  const jsSrc = read('tools/dashboard-ui/app.js');
  check('app.js 轮询 /api/state', /\/api\/state/.test(jsSrc));
  check('app.js 调两个写接口',
    /\/api\/run-now/.test(jsSrc) && /\/api\/republish/.test(jsSrc));
  check('app.js 请求了通知权限', /Notification/.test(jsSrc));
  check('app.js 用 <dialog> 做确认条', /dialog/i.test(jsSrc) || /dialog/i.test(idx));
  /* 不可逆文案必须写清楚 */
  check('确认条写清了「24 小时边缘缓存」',
    jsSrc.indexOf('24 小时') >= 0 || idx.indexOf('24 小时') >= 0);
  check('补发确认条写清了「线上首页会重新指向」',
    jsSrc.indexOf('线上首页会重新指向') >= 0 || idx.indexOf('线上首页会重新指向') >= 0);
  check('页面有未读问题提示', /未读/.test(jsSrc) || /未读/.test(idx));

  /* ↓↓ spec §8 的三条漏实现，逐条钉死 ↓↓ */
  check('app.js 会取日志尾部（点了阶段点能看那一步的日志；拿不到时明说，不假装有）',
    /\/api\/log/.test(jsSrc) && /不在保留的尾部里/.test(jsSrc));
  check('app.js 把「源图已清理」的日期禁用并注明',
    /源图已清理/.test(jsSrc) && /disabled/.test(jsSrc));
  check('app.js 把没有数值的耗时显示成「—」（旧日志没有时间戳）',
    /fmtDur/.test(jsSrc) && /—/.test(jsSrc));
  check('app.js 首屏显示结束时刻（spec §8.1 的「开始 · 结束」）',
    /finishedAt/.test(jsSrc));
  check('历史表有「一句话结论」这一列（spec §8.1 要 5 列）',
    /一句话结论/.test(idx));

  /* 静态资源真能伺服 —— Task 5 才建出 dashboard-ui/，所以断言放在这儿。
     ⚠️ createServer 是第 4 组里的**块内局部变量**，这里取不到 →
        必须在本组自己动态 import（跟第 4 组同一个 try/catch 模式）。
        ⚠️ `http` 在文件头的 import 区（第 4 组的注释说明了原因）。 */
  let dash5 = null;
  try {
    dash5 = await import('./night-dashboard.mjs');
  } catch {
    dash5 = null;
  }
  const inst5 = (dash5 && typeof dash5.createServer === 'function')
    ? dash5.createServer({ port: 0, root: ROOT, schedule: false, allowWrite: false })
    : null;
  if (inst5) {
    await new Promise((res) => inst5.server.listen(0, '127.0.0.1', res));
  }
  const port5 = inst5 && typeof inst5.getChosenPort === 'function' ? inst5.getChosenPort() : 0;
  const base5 = 'http://127.0.0.1:' + port5;

  async function req5(p) {
    return await new Promise((resolve) => {
      const r = http.request(base5 + p, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      });
      r.on('error', () => resolve({ status: 0, body: '', headers: {} }));
      r.end();
    });
  }

  const html5 = await req5('/');
  check('静态页 / → 200', !!inst5 && html5.status === 200, { status: html5.status });
  check('静态页带正确的 content-type',
    !!inst5 && /text\/html/.test(String(html5.headers['content-type'] || '')),
    { ct: html5.headers['content-type'] });
  const css5 = await req5('/app.css');
  check('/app.css → 200', !!inst5 && css5.status === 200, { status: css5.status });
  check('/app.css 带正确的 content-type',
    !!inst5 && /text\/css/.test(String(css5.headers['content-type'] || '')),
    { ct: css5.headers['content-type'] });
  const js5 = await req5('/app.js');
  check('/app.js → 200', !!inst5 && js5.status === 200, { status: js5.status });

  if (inst5) {
    await new Promise((res) => inst5.server.close(res));
  }
}

/* ── 6. 启动器约定 ─────────────────────────────────────── */
{
  const cmdPath = path.join(ROOT, '起任务台.cmd');
  let bytes = Buffer.alloc(0);
  try { bytes = fs.readFileSync(cmdPath); } catch { /* 文件还不存在 */ }
  /* ⚠️ 每条都带 `bytes.length > 0` 前置 —— **空 Buffer 会让这些断言空过**：
       `Buffer.alloc(0).every(...)` 恒为 true、`bytes[0]` 是 undefined →
       「无 BOM」「只有 LF」两条会**假装通过**，护栏会说「文件格式没问题」，
       实际它压根没看见文件。跟 Task 1 那条「body !== ''」是同一类假阴性。 */
  const cmdExists = bytes.length > 0;
  check('起任务台.cmd 是纯 ASCII', cmdExists && bytes.every((b) => b < 128),
    { nonAscii: bytes.filter((b) => b >= 128).length, bytes: bytes.length });
  check('起任务台.cmd 无 BOM',
    cmdExists && !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf),
    { bytes: bytes.length });
  check('起任务台.cmd 只有 LF，没有 CR', cmdExists && !bytes.includes(0x0d),
    { cr: bytes.filter((b) => b === 13).length, bytes: bytes.length });
  const cmd = bytes.toString('latin1');
  check('起任务台.cmd 调 start-dashboard.mjs', /start-dashboard\.mjs/.test(cmd));

  const starter = read('tools/start-dashboard.mjs');
  check('start-dashboard.mjs 有非 Windows 的直起分支',
    /process\.platform\s*!==\s*['"]win32['"]/.test(starter),
    '要求按 process.platform 分支处理启动方式');
  check('start-dashboard.mjs 在 Windows 上经 explorer.exe 脱 Job',
    /explorer\.exe/.test(starter));
  check('start-dashboard.mjs 用实际端口打开页面（不写死 8801）',
    /\.night-dashboard-port/.test(starter));
}

/* ── 7. 服务端 toast ───────────────────────────────────── */
{
  const notify = read('tools/notify.ps1');
  check('notify.ps1 存在且非空', notify.length > 200, { len: notify.length });
  check('notify.ps1 用 WinRT 发 toast', /ToastNotificationManager/.test(notify));
  /* ⚠️ 这里**不能**用 `/-ErrorAction\s+SilentlyContinue/`：
       实现里是 `$ErrorActionPreference = 'SilentlyContinue'`（中间没有空格）
       → 旧正则**永远匹配不上**，正确的实现也会被判红。
     要判的是「失败时静默」这三件事：偏好设成 SilentlyContinue + 有 catch + 最后 exit 0。 */
  check('notify.ps1 失败时静默退出（不让它掀翻主流程）',
    /ErrorActionPreference\s*=\s*['"]SilentlyContinue['"]/.test(notify) &&
    /catch\s*\{/.test(notify) && /exit\s+0/.test(notify));

  /* ⚠️ 字节断言：**兜住读取**（文件还没建）**且带长度前置**：
       ① 直接 fs.readFileSync 不存在的文件 → ENOENT → 整个套件崩掉；
       ② 空 Buffer 的 `!nb.includes(0x0d)` 恒为 true → 「文件不存在」却空过。 */
  let nb = Buffer.alloc(0);
  try { nb = fs.readFileSync(path.join(ROOT, 'tools/notify.ps1')); } catch { /* 文件还不存在 */ }
  check('notify.ps1 有 UTF-8 BOM',
    nb.length > 0 && nb[0] === 0xef && nb[1] === 0xbb && nb[2] === 0xbf,
    { bytes: nb.length });
  check('notify.ps1 只有 LF，没有 CR',
    nb.length > 0 && !nb.includes(0x0d),
    { cr: nb.filter((x) => x === 13).length, bytes: nb.length });

  /* ── AUMID 归位：平台字面量只放 common.ps1 ──────────────────
     由来：notify.ps1 原来自己写死了 AUMID，那个字面量同时含
     **反斜杠路径**和**硬编码的 powershell.exe** → 撞上
     test-night-flow.mjs 那两条扫描（tools/ 下不许有 .ps1 在代码里
     拼反斜杠路径 / 不许硬编码 powershell.exe）。
     工程约定是「平台字面量只放 common.ps1 一个文件」
     （那两条扫描都显式豁免 common.ps1）→ AUMID 搬进 common.ps1。
     ⚠️ 搬完必须钉住：不然以后有人「顺手搬回来」没人拦。 */
  const commonPs1 = read('tools/common.ps1');
  const AUMID_GUID = '{1AC14E77-02E7-4E5D-B744-2EB1AE519E7B}';
  const hasAumidCall = notify.includes('Get-ToastAumid');
  check('notify.ps1 的 AUMID 走 common.ps1 的 Get-ToastAumid（AUMID 字面量不留在 notify.ps1）',
    notify.length > 0 && hasAumidCall && !notify.includes(AUMID_GUID),
    { hasCall: hasAumidCall, hasLiteral: notify.includes(AUMID_GUID) });
  check('common.ps1 定义了 Get-ToastAumid（AUMID 字面量住在这儿）',
    commonPs1.length > 0 && /function\s+Get-ToastAumid\s*\{/.test(commonPs1) && commonPs1.includes(AUMID_GUID),
    { hasFn: /function\s+Get-ToastAumid\s*\{/.test(commonPs1), hasLiteral: commonPs1.includes(AUMID_GUID) });
  /* ⚠️ 把**整串** AUMID 钉住（不只是 GUID 前缀）——
     尾号一个字符写错，toast 就发不出去，而且**不报错**（CreateToastNotifier
     对「非空但未登记」的 AUMID 照样返回，只有空串才抛）。
     实测（2026-11-21）：真发一次 toast，
     `Microsoft-Windows-PushNotification-Platform/Operational` 日志里出现
     3052「已将…Toast 传送到会话 1 上的 {AUMID}」→ **确实送到桌面**。
     ⚠️ 顺带记一笔：`Get-StartApps` 里登记的是**另一个**尾号（5198B7），
     两者都能投递（Windows 对同一个 exe 有多套登记）→ **别按它去「修正」**。 */
  const AUMID_FULL = '{1AC14E77-02E7-4E5D-B744-2EB1AE519E7B}\\WindowsPowerShell\\v1.0\\powershell.exe';
  check('common.ps1 的 AUMID 是完整一整串（实测 Windows 会投递，尾号写错就静默发不出）',
    commonPs1.length > 0 && commonPs1.includes(AUMID_FULL),
    { hasFullAumid: commonPs1.includes(AUMID_FULL) });
  const dotSource = /^\s*\.\s*\(Join-Path\s+\$PSScriptRoot\s+'common\.ps1'\)/m;
  check('notify.ps1 dot-source 了 common.ps1（不 dot-source 就拿不到 Get-ToastAumid）',
    notify.length > 0 && dotSource.test(notify),
    { hasDotSource: dotSource.test(notify) });

  /* ⚠️ notify.ps1 语法坏了 = toast **静默**失效（它自己的设计就是
     「失败一律静默」）→ 属于最难查的一类，所以这里真跑一次解析检查。
     不带 -Body → 脚本走 `if (-not $Body) { exit 0 }` 分支，
     **不会真的发 toast**（WinRT 那几行在 exit 之后）。
     ⚠️ 不能硬编码 powershell.exe —— macOS 上没这个文件 → ENOENT → 护栏在
     目标平台上 exit 1。按平台分支（仓库既有惯例，同 runRealHelper）。 */
  const PS_NOTIFY = process.platform === 'win32' ? 'powershell' : 'pwsh';
  const psNotify = spawnSync(PS_NOTIFY,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'notify.ps1')],
    { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  check('notify.ps1 能被 PowerShell 解析（dot-source 之后语法不能坏）',
    psNotify.status === 0,
    {
      exit: psNotify.status,
      stderr: String(psNotify.stderr || '').trim().slice(0, 200),
      error: psNotify.error ? String(psNotify.error.message || psNotify.error) : null,
    });

  const dash7 = read('tools/night-dashboard.mjs');
  check('任务台在出错时会调 notify', /notify\.ps1/.test(dash7));
  check('notify 有 macOS 的 osascript 分支（spec §8.4「按 process.platform 分支换 osascript」）',
    /osascript/.test(dash7) && /darwin/.test(dash7));

  /* ⚠️🔴 这条是本轮新增的「牙齿」：通知必须走 detachedPowerShell。
        直接 `spawn('powershell', …, {detached:true})` 会让 PowerShell **立刻退出**、
        toast 根本发不出去（Task 4 修复轮 2 实测：2026-11-20）。
        → 这条要是红了，说明通知路径是死的（而且不报错）。 */
  const nt = (dash7.match(/function notifyToast[\s\S]*?\n\}/) || [''])[0];
  check('任务台发 toast 走 detachedPowerShell（直连 detached 会让 PowerShell 秒退、通知发不出去）',
    nt.length > 0 && /detachedPowerShell\s*\(/.test(nt) && !/spawn\s*\(\s*PS_EXE/.test(nt),
    { hasNotifyToast: nt.length > 0 });
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
