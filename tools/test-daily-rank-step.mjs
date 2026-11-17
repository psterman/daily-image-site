#!/usr/bin/env node
/**
 * 护栏：daily.ps1 的「第 4 步 · 抓榜单 + 追更」
 *
 * 用法：node tools/test-daily-rank-step.mjs
 * 退出码：0 = 全过；1 = 有失败
 *
 * ── 为什么需要这一步 ─────────────────────────────────────────
 * 2026-11-16 之前，daily.ps1 只有三步（抓图 / 头条 / 清洗）+ 构建，
 * **榜单和追更从来没被抓过**。这两块都是**构建期静态数据**：
 * build.mjs 只读 src\<期号>\rank_<期号>.json 和 follow_<期号>.json，
 * 它自己不会去抓 —— 源目录里没有，构建就静默跳过。
 *
 * 后果：23 期里 22 期线上只有 4 个 tab（见闻/见她/见笑/见报），
 * 只有手工跑过抓取器的 11-16 那一期是 7 个 tab。
 *
 * 看片 v3 把「频道更新 / 本地演出」并进看片之后，漏抓的后果从
 * 「tab 不存在」变成「看片只有 2~3 个目录」—— 看着像网站坏了，
 * 更看不出是漏抓了一次数据。所以第 4 步必须钉死。
 *
 * ── 这些断言盯的是「坏了很难发现」的东西 ───────────────────
 *   1. 第 4 步必须**真的调两个抓取器**（漏一个 → 看片少一大段）
 *   2. 必须传 **--date $publishDate**（期号）而不是 $ContentDate（内容日期）
 *      —— 传错了，文件会落到别的目录，构建照样「没有数据」地跳过
 *   3. 失败**只警告不中断**（图片才是主体，抓不到不该让整期发不出去）
 *   4. 原生命令必须接 `| Out-Host`（PS 5.1 的 transcript 抓不到原生 stdout）
 *      且不能有 `2>&1`（stderr→ErrorRecord→掀翻 $ErrorActionPreference='Stop'）
 *   5. 位置：**清洗之后 → 抓取 → 构建之前**（构建完再抓就来不及进产物了）
 *   6. 必须有 **-NoRank** 逃生口（网络不通时能手动跳过）
 *   7. daily-review.ps1（桌面「一键更新」那条链）必须把 -NoRank **透传**下去
 *      —— 不透传的话，逃生口在桌面入口上根本够不着
 *
 * ⚠️ 断言一律看**剥掉注释后的代码**：
 *    daily.ps1 的注释里本来就写着「fetch-rank.mjs」「只警告不中断」这类说明，
 *    全文匹配的话护栏会把自己的说明书当成合规 —— 那样变异测试就抓不到东西了。
 *
 * 变异测试入口：DAILY_PS1 / DAILY_REVIEW_PS1 环境变量可以指向别的文件
 * （这样验「护栏能抓住坏版本」时不用碰真文件）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;

function check(label, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? '  —— ' + detail : ''}`);
  }
}

function readFile(rel) {
  const p = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

function readText(rel) {
  const b = readFile(rel);
  return b === null ? '' : b.toString('utf8');
}

/**
 * 剥掉注释，只留代码。
 * PowerShell 的块注释 <# ... #> 和行注释 #。
 */
function stripComments(src) {
  return src
    .replace(/<#[\s\S]*?#>/g, '')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

const dailyPath = process.env.DAILY_PS1 || path.join('tools', 'daily.ps1');
const reviewPath = process.env.DAILY_REVIEW_PS1 || path.join('tools', 'daily-review.ps1');

const dailyBytes = readFile(dailyPath);
const dailyText = dailyBytes === null ? '' : dailyBytes.toString('utf8');
const dailyCode = stripComments(dailyText);

const reviewBytes = readFile(reviewPath);
const reviewText = reviewBytes === null ? '' : reviewBytes.toString('utf8');
const reviewCode = stripComments(reviewText);

console.log('\n0) 文件在不在');
{
  check('tools/daily.ps1 存在', dailyBytes !== null, dailyPath);
  check('tools/daily-review.ps1 存在', reviewBytes !== null, reviewPath);
  if (dailyBytes === null || reviewBytes === null) {
    console.log('\n缺文件，后面没法测了。');
    process.exit(1);
  }
}

console.log('\n1) 第 4 步存在、有开关、位置对');
{
  check('daily.ps1 声明了 -NoRank 逃生开关', /\[switch\]\$NoRank/.test(dailyCode));
  check('第 4 步被 -NoRank 守卫（-NoRank 时不抓）',
    /if\s*\(\s*-not\s+\$NoRank\s*\)/.test(dailyCode),
    '守卫写成 if ($true) 就等于没有逃生口');
  check('第 4 步的主标题是「4/5 抓榜单…」（不是 else 分支那句「跳过」）',
    /Step\s+'4\/5\s+抓榜单/.test(dailyCode),
    'else 分支里也有一句 Step 4/5，只看有没有标题会把它当成主标题');

  const cleanAt = dailyCode.indexOf('$cleanArgs');
  const fetchAt = dailyCode.indexOf('fetch-rank.mjs');
  const buildAt = dailyCode.indexOf('tools/build.mjs');
  const dateAt = dailyCode.indexOf('$publishDate =');

  check('抓取在清洗之后', cleanAt > 0 && fetchAt > cleanAt,
    `清洗@${cleanAt} 抓取@${fetchAt}`);
  check('抓取在构建之前', fetchAt > 0 && buildAt > fetchAt,
    `抓取@${fetchAt} 构建@${buildAt} —— 构建完再抓就进不了这一期产物了`);
  check('抓取在期号算出来之后', dateAt > 0 && fetchAt > dateAt,
    `期号@${dateAt} 抓取@${fetchAt}`);
}

console.log('\n2) 真的调了两个抓取器');
{
  check('代码里有 fetch-rank.mjs', /fetch-rank\.mjs/.test(dailyCode));
  check('代码里有 fetch-follow.mjs', /fetch-follow\.mjs/.test(dailyCode));
  check('两个抓取器在同一个列表里',
    /@\(\s*'tools\/fetch-rank\.mjs'\s*,\s*'tools\/fetch-follow\.mjs'\s*\)/.test(dailyCode),
    '两个都调了但不在同一个循环里 = 只有一个会跑');
  check('抓取器拿的是期号 $publishDate',
    /&\s+node\s+\$fetcher\s+--date\s+\$publishDate/.test(dailyCode));
  check('抓取器不拿内容日期 $ContentDate',
    !/&\s+node\s+\$fetcher[^\n]*\$ContentDate/.test(dailyCode),
    '内容日期是「昨天」，期号才是目录名 —— 传错了文件落到别的目录，构建照样跳过');
}

console.log('\n3) 失败只警告不中断（图片才是主体）');
{
  const s4 = dailyCode.indexOf("Step '4/5");
  const s5 = dailyCode.indexOf("Step '5/5");
  const region = s4 >= 0 && s5 > s4 ? dailyCode.slice(s4, s5) : '';
  check('第 4 步失败只警告不中断（没有 throw）',
    region.length > 0 && !/\bthrow\b/.test(region),
    region.slice(0, 160));
  check('第 4 步判了退出码', /\$LASTEXITCODE\s+-ne\s+0/.test(region));
  check('第 4 步失败时会警告', /\bWarn\b/.test(region));
}

console.log('\n4) 原生命令纪律（PS 5.1 的两个坑）');
{
  const nodeLine = dailyCode.split('\n').find((l) => /&\s+node\s+\$fetcher/.test(l)) || '';
  check('抓取器那行接了 | Out-Host', /\|\s*Out-Host/.test(nodeLine),
    nodeLine.trim() || '没找到抓取器那一行');
  check('抓取器那行没有 2>&1', nodeLine.length > 0 && !/2>&1/.test(nodeLine),
    'PS 5.1 会把 stderr 转成 ErrorRecord，$ErrorActionPreference=Stop 下一行 warning 就能掀翻整轮');
}

console.log('\n5) 桌面那条链能透传 -NoRank');
{
  check('daily-review.ps1 有 -NoRank 开关', /\[switch\]\$NoRank/.test(reviewCode));
  check('daily-review.ps1 把 -NoRank 透传给 daily.ps1',
    /\$dailyArgs\['NoRank'\]\s*=\s*\$true/.test(reviewCode),
    '不透传的话，桌面「一键更新」那条链上根本没有逃生口');
  check('daily-review.ps1 的步骤说明里带了「榜单/追更」',
    /榜单\/追更/.test(reviewCode),
    '说明跟实现对不上 = 下一个人会按说明理解流程');
  check('daily-review.ps1 的参数说明里写了 NoRank',
    /\.PARAMETER\s+NoRank/.test(reviewText));
}

console.log('\n6) 跟抓取器自己的参数对得上');
{
  const rank = readText(process.env.RANK_FETCH_MJS || path.join('tools', 'fetch-rank.mjs'));
  const follow = readText(process.env.FOLLOW_FETCH_MJS || path.join('tools', 'fetch-follow.mjs'));
  check('fetch-rank.mjs 认 --date', /'--date'/.test(rank));
  check('fetch-follow.mjs 认 --date', /'--date'/.test(follow));
  check('fetch-rank.mjs 把文件写到 <期号> 目录',
    /path\.join\(SRC_LOCAL,\s*String\(date\),\s*`rank_\$\{date\}\.json`\)/.test(rank),
    '落盘路径跟 build.mjs 读的不一致 = 抓了也白抓');
  check('fetch-follow.mjs 把文件写到 <期号> 目录',
    /path\.join\(root,\s*String\(date\),\s*`follow_\$\{String\(date\)\}\.json`\)/.test(follow));
}

console.log('\n7) 说明别骗人');
{
  check('daily.ps1 的说明里写了「第 4 步是补上的」', /第 4 步是/.test(dailyText),
    '「第 4 步」在文件里出现两处，断言必须认准说明里那一句');
  check('daily.ps1 的说明里提了两个抓取器',
    /fetch-rank\.mjs/.test(dailyText) && /fetch-follow\.mjs/.test(dailyText));
}

console.log('\n8) 编码与语法');
{
  const hasBom = (b) => b && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
  const hasCr = (b) => b && b.includes(0x0d);
  check('daily.ps1 是 UTF-8 with BOM', hasBom(dailyBytes));
  check('daily.ps1 只有 LF，没有 CR', dailyBytes && !hasCr(dailyBytes));
  check('daily-review.ps1 是 UTF-8 with BOM', hasBom(reviewBytes));
  check('daily-review.ps1 只有 LF，没有 CR', reviewBytes && !hasCr(reviewBytes));

  const PS = process.platform === 'win32' ? 'powershell' : 'pwsh';
  for (const [label, p] of [['daily.ps1', dailyPath], ['daily-review.ps1', reviewPath]]) {
    const abs = path.isAbsolute(p) ? p : path.join(ROOT, p);
    const cmd = [
      '$errs = $null',
      `[System.Management.Automation.Language.Parser]::ParseFile('${abs.replace(/\\/g, '\\\\')}', [ref]$null, [ref]$errs) | Out-Null`,
      'if ($errs -and $errs.Count) { exit 1 } else { exit 0 }',
    ].join('; ');
    const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' });
    check(`${label} 能被 PowerShell 解析（无语法错误）`, r.status === 0,
      `exit=${r.status} ${(r.stdout || '').trim()} ${(r.stderr || '').trim()}`);
  }
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
