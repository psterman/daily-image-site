#!/usr/bin/env node
/**
 * 变异验证：证明 test-daily-rank-step.mjs 真的有牙齿。
 *
 * 护栏自己「全绿」说明不了它能抓住坏版本 —— 只会说明它没坏。
 * 所以这里把被保护的文件**故意改坏**，再跑护栏，要求它**必须变红**。
 *
 * 变异体不碰真文件：写到 tools/.tmp-daily-rank-mut/ 下，跑完删掉。
 * （不用系统 temp 目录 —— 出问题时得能在工程里翻到它。）
 *
 * 每个变异体写三件事：
 *   · from → to     —— 改哪一段（锚点必须在目标文件里**唯一命中一次**）
 *   · expectFail    —— 期望变红的那几条断言（子串匹配）
 *   · expectGreen   —— 期望仍然绿的那几条断言（子串匹配；它们变红就是**误伤**，
 *                       说明护栏的判据太粗，改坏一处把不相干的东西也判成坏的）
 *
 * ⚠️ **必须「干净地红」**：护栏变红是因为**断言不成立**，
 *    不是护栏自己抛异常。所以这里同时检查：
 *      ① 护栏跑出了「N 通过 / M 失败」的统计行（崩了就没有这行）
 *      ② stderr 里没有调用栈
 *    崩出来的红会把真缺口盖住 —— 那不算抓到。
 *
 * 用法：node tools/test-daily-rank-step-mutate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(__dirname, '.tmp-daily-rank-mut');

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

// ⚠️ 用 utf8 读（不是 latin1）—— BOM 会以 \uFEFF 留在字符串开头，
//    写回去时又变回 EF BB BF，变异体的编码跟真文件保持一致。
//    否则护栏里「是 UTF-8 with BOM」那条会因为变异体本身没 BOM 而恒红，
//    红得没有意义（那不叫「抓到了」，那叫「自己坏掉了」）。
const DAILY = fs.readFileSync(path.join(ROOT, 'tools/daily.ps1'), 'utf8');
const REVIEW = fs.readFileSync(path.join(ROOT, 'tools/daily-review.ps1'), 'utf8');
const FETCH_RANK = fs.readFileSync(path.join(ROOT, 'tools/fetch-rank.mjs'), 'utf8');
const FETCH_FOLLOW = fs.readFileSync(path.join(ROOT, 'tools/fetch-follow.mjs'), 'utf8');

/* daily.ps1 第 4 步 + 第 5 步的原文（顺序变异要整块换位） */
const STEP4_BLOCK = `if (-not $NoRank) {
  Step '4/5 抓榜单 + 追更（听乐 / 看片 五段的大目录数据）'
  foreach ($fetcher in @('tools/fetch-rank.mjs', 'tools/fetch-follow.mjs')) {
    & node $fetcher --date $publishDate | Out-Host
    if ($LASTEXITCODE -ne 0) {
      Warn "$fetcher 失败（exit $LASTEXITCODE）—— 看片会少几段，继续（图片是主体）"
    }
  }
} else {
  Step '4/5 跳过抓榜单 + 追更（-NoRank）'
}`;

const BUILD_BLOCK = `# ── 5. 构建（只构建，不上传不部署）────────────────────────────
# 上传之前必须有人审稿，所以这一步到构建为止就停。
Step '5/5 构建（本地，不上传）'
$buildArgs = @('tools/build.mjs', '--date', $publishDate)
if ($NoConvert) { $buildArgs += '--no-convert' }
& node @buildArgs | Out-Host
if ($LASTEXITCODE -ne 0) { throw "构建失败（exit $LASTEXITCODE）" }`;

const MUTANTS = [
  {
    label: 'daily.ps1：第 4 步只抓榜单、漏了追更（看片少「频道更新 / 本地演出」两段）',
    env: 'DAILY_PS1',
    file: 'daily.ps1',
    src: DAILY,
    from: "foreach ($fetcher in @('tools/fetch-rank.mjs', 'tools/fetch-follow.mjs')) {",
    to: "foreach ($fetcher in @('tools/fetch-rank.mjs')) {",
    expectFail: ['两个抓取器在同一个列表里', '代码里有 fetch-follow.mjs'],
    expectGreen: ['代码里有 fetch-rank.mjs', '抓取器拿的是期号 $publishDate'],
  },
  {
    label: 'daily.ps1：抓取器传的是内容日期 $ContentDate（文件落到别的目录，构建照样跳过）',
    env: 'DAILY_PS1',
    file: 'daily.ps1',
    src: DAILY,
    from: '    & node $fetcher --date $publishDate | Out-Host',
    to: '    & node $fetcher --date $ContentDate | Out-Host',
    expectFail: ['抓取器拿的是期号 $publishDate', '抓取器不拿内容日期 $ContentDate'],
    expectGreen: ['抓取器那行接了 | Out-Host', '抓取器那行没有 2>&1'],
  },
  {
    label: 'daily.ps1：警告之后又 throw（抓不到榜单就把整期准备掀翻）',
    env: 'DAILY_PS1',
    file: 'daily.ps1',
    src: DAILY,
    from: '      Warn "$fetcher 失败（exit $LASTEXITCODE）—— 看片会少几段，继续（图片是主体）"',
    to: '      Warn "$fetcher 失败（exit $LASTEXITCODE）—— 看片会少几段，继续（图片是主体）"\n      throw "$fetcher 失败（exit $LASTEXITCODE）"',
    expectFail: ['第 4 步失败只警告不中断（没有 throw）'],
    expectGreen: ['第 4 步失败时会警告', '第 4 步判了退出码'],
  },
  {
    label: 'daily.ps1：抓取器那行漏了 | Out-Host（transcript 抓不到 stdout，日志少一大半）',
    env: 'DAILY_PS1',
    file: 'daily.ps1',
    src: DAILY,
    from: '    & node $fetcher --date $publishDate | Out-Host',
    to: '    & node $fetcher --date $publishDate',
    expectFail: ['抓取器那行接了 | Out-Host'],
    expectGreen: ['抓取器那行没有 2>&1', '抓取器拿的是期号 $publishDate'],
  },
  {
    label: 'daily.ps1：抓取器那行加了 2>&1（PS 5.1 下 stderr 变成 ErrorRecord，一行 warning 掀翻整轮）',
    env: 'DAILY_PS1',
    file: 'daily.ps1',
    src: DAILY,
    from: '    & node $fetcher --date $publishDate | Out-Host',
    to: '    & node $fetcher --date $publishDate | Out-Host 2>&1',
    expectFail: ['抓取器那行没有 2>&1'],
    expectGreen: ['抓取器那行接了 | Out-Host', '抓取器拿的是期号 $publishDate'],
  },
  {
    label: 'daily.ps1：-NoRank 开关的声明被删（逃生口没了）',
    env: 'DAILY_PS1',
    file: 'daily.ps1',
    src: DAILY,
    from: '  [switch]$NoRank,\n',
    to: '',
    expectFail: ['daily.ps1 声明了 -NoRank 逃生开关'],
    expectGreen: ['第 4 步被 -NoRank 守卫（-NoRank 时不抓）', '第 4 步的主标题是「4/5 抓榜单…」（不是 else 分支那句「跳过」）'],
  },
  {
    label: 'daily.ps1：守卫写成 if ($true)（-NoRank 形同虚设）',
    env: 'DAILY_PS1',
    file: 'daily.ps1',
    src: DAILY,
    from: 'if (-not $NoRank) {',
    to: 'if ($true) {',
    expectFail: ['第 4 步被 -NoRank 守卫（-NoRank 时不抓）'],
    expectGreen: ['daily.ps1 声明了 -NoRank 逃生开关', '第 4 步失败只警告不中断（没有 throw）'],
  },
  {
    label: 'daily.ps1：第 4 步的阶段标题被删（这一步在日志里没影子，出错时看不出跑到哪）',
    env: 'DAILY_PS1',
    file: 'daily.ps1',
    src: DAILY,
    from: "  Step '4/5 抓榜单 + 追更（听乐 / 看片 五段的大目录数据）'\n",
    to: '',
    expectFail: ['第 4 步的主标题是「4/5 抓榜单…」（不是 else 分支那句「跳过」）'],
    expectGreen: ['抓取在清洗之后', '抓取在构建之前', '第 4 步失败只警告不中断（没有 throw）'],
  },
  {
    label: 'daily.ps1：抓取整块挪到了构建之后（构建时数据还没抓到 → 这一期照样少几段）',
    env: 'DAILY_PS1',
    file: 'daily.ps1',
    src: DAILY,
    from: `${STEP4_BLOCK}\n\n${BUILD_BLOCK}`,
    to: `${BUILD_BLOCK}\n\n${STEP4_BLOCK}`,
    expectFail: ['抓取在构建之前'],
    expectGreen: ['抓取在清洗之后', '抓取在期号算出来之后', '抓取器拿的是期号 $publishDate'],
  },
  {
    label: 'daily-review.ps1：-NoRank 没透传给 daily.ps1（桌面「一键更新」那条链上够不着逃生口）',
    env: 'DAILY_REVIEW_PS1',
    file: 'daily-review.ps1',
    src: REVIEW,
    from: "  if ($NoRank)        { $dailyArgs['NoRank']        = $true }\n",
    to: '',
    expectFail: ['daily-review.ps1 把 -NoRank 透传给 daily.ps1'],
    expectGreen: ['daily-review.ps1 有 -NoRank 开关', 'daily-review.ps1 的步骤说明里带了「榜单/追更」'],
  },
  {
    label: 'daily-review.ps1：-NoRank 开关的声明被删（透传的是一个不存在的参数）',
    env: 'DAILY_REVIEW_PS1',
    file: 'daily-review.ps1',
    src: REVIEW,
    from: '  [switch]$NoRank,\n',
    to: '',
    expectFail: ['daily-review.ps1 有 -NoRank 开关'],
    expectGreen: ['daily-review.ps1 把 -NoRank 透传给 daily.ps1', 'daily-review.ps1 的步骤说明里带了「榜单/追更」'],
  },
  {
    label: 'daily.ps1：说明里不再写「第 4 步」（下一个人会以为流程里没有这一步）',
    env: 'DAILY_PS1',
    file: 'daily.ps1',
    src: DAILY,
    from: '    ⚠️ 第 4 步是 2026-11-16 补上的 —— **以前这一步根本不在流程里**。',
    to: '    ⚠️ 这一步是 2026-11-16 补上的 —— **以前这一步根本不在流程里**。',
    expectFail: ['daily.ps1 的说明里写了「第 4 步是补上的」'],
    expectGreen: ['daily.ps1 的说明里提了两个抓取器'],
  },
  {
    label: 'fetch-rank.mjs：--date 改名成 --period（daily.ps1 传的参数抓取器不认，期号成了默认值）',
    env: 'RANK_FETCH_MJS',
    file: 'fetch-rank.mjs',
    src: FETCH_RANK,
    from: "if (a === '--date') out.date = String(argv[++i] || '').trim();",
    to: "if (a === '--period') out.date = String(argv[++i] || '').trim();",
    expectFail: ['fetch-rank.mjs 认 --date'],
    expectGreen: ['fetch-follow.mjs 认 --date', 'fetch-rank.mjs 把文件写到 <期号> 目录'],
  },
  {
    label: 'fetch-rank.mjs：落盘文件名改了（build.mjs 读的还是老名字 → 永远读不到）',
    env: 'RANK_FETCH_MJS',
    file: 'fetch-rank.mjs',
    src: FETCH_RANK,
    from: 'path.join(SRC_LOCAL, String(date), `rank_${date}.json`)',
    to: 'path.join(SRC_LOCAL, String(date), `rank_${date}.v2.json`)',
    expectFail: ['fetch-rank.mjs 把文件写到 <期号> 目录'],
    expectGreen: ['fetch-rank.mjs 认 --date', 'fetch-follow.mjs 把文件写到 <期号> 目录'],
  },
  {
    label: 'fetch-follow.mjs：落盘文件名改了（build.mjs 读的还是老名字 → 永远读不到）',
    env: 'FOLLOW_FETCH_MJS',
    file: 'fetch-follow.mjs',
    src: FETCH_FOLLOW,
    from: 'path.join(root, String(date), `follow_${String(date)}.json`)',
    to: 'path.join(root, String(date), `follow_${String(date)}.v2.json`)',
    expectFail: ['fetch-follow.mjs 把文件写到 <期号> 目录'],
    expectGreen: ['fetch-follow.mjs 认 --date', 'fetch-rank.mjs 把文件写到 <期号> 目录'],
  },
];

console.log('\n0) 基线：没改坏之前，护栏必须全绿');
{
  const r = spawnSync(process.execPath, [path.join(__dirname, 'test-daily-rank-step.mjs')], {
    encoding: 'utf8',
  });
  check('test-daily-rank-step.mjs 基线绿', r.status === 0,
    (r.stdout || '').trim().split('\n').pop());
}

console.log('\n1) 变异：每改坏一处，对应护栏必须变红');

fs.mkdirSync(TMP, { recursive: true });

for (const m of MUTANTS) {
  // ── 锚点自检 ────────────────────────────────────────────────
  // 锚点必须**恰好命中一次**。
  //   命中 0 次 = 源码改了、脚本过期了（这时候红不代表抓到了）
  //   命中 2 次 = 锚点不唯一，改一处会改两处（红得没有说服力）
  const hits = m.src.split(m.from).length - 1;
  if (hits !== 1) {
    check(m.label, false,
      hits === 0
        ? '锚点在原文件里找不到（源文件变了？脚本过期了？）'
        : `锚点在原文件里命中 ${hits} 次（必须恰好 1 次）`);
    continue;
  }

  const mutant = m.src.replace(m.from, m.to);
  const file = path.join(TMP, m.file);
  fs.writeFileSync(file, mutant, 'utf8');

  const r = spawnSync(process.execPath, [path.join(__dirname, 'test-daily-rank-step.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, [m.env]: file },
  });
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';

  // ── 干净地红 ────────────────────────────────────────────────
  const hasStats = /(\d+) 通过 \/ (\d+) 失败/.test(stdout);
  const hasStack = /\n\s+at\s+\S/.test(stderr);
  if (!hasStats || hasStack) {
    check(m.label, false,
      !hasStats
        ? '护栏没跑出统计行（它是崩的，不是断言不成立）'
        : 'stderr 里有调用栈（是崩出来的红，不算抓到）');
    continue;
  }
  if (r.status === 0) {
    const lastLine = stdout.trim().split('\n').pop();
    check(m.label, false, `护栏居然还是绿的（exit 0，末行：${lastLine}）`);
    continue;
  }

  // ── 期望红的那几条，必须真的红 ──────────────────────────────
  const redLines = stdout.split('\n').filter((l) => l.trim().startsWith('✗')).join('\n');
  const greenLines = stdout.split('\n').filter((l) => l.trim().startsWith('✓')).join('\n');
  const missingFail = (m.expectFail || []).filter((label) => !redLines.includes(label));
  if (missingFail.length) {
    check(m.label, false, '这些断言该红却没红：' + missingFail.join(' | '));
    continue;
  }
  // ── 期望仍然绿的那几条，不许被误伤 ──────────────────────────
  const wronglyRed = (m.expectGreen || []).filter((label) => redLines.includes(label));
  if (wronglyRed.length) {
    check(m.label, false, '这些断言被误伤了：' + wronglyRed.join(' | '));
    continue;
  }
  check(m.label, true);
}

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* 临时目录留着也不影响 */
}
check('临时目录清掉了', !fs.existsSync(TMP));

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
