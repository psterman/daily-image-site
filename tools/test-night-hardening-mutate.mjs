#!/usr/bin/env node
/**
 * 变异测试：证明 test-night-hardening.mjs 的护栏**真的有牙齿**
 *
 * 方法（跟 AGENTS.md 记的纪律一致）：
 *   1. 把真文件复制到临时目录，改坏，跑护栏（用环境变量指向改坏的副本）；
 *   2. 护栏必须**变红**，且红的正是指定的那些断言；
 *   3. 变体跑完自清。
 *
 * ⚠️ **锚点自检前置**：每个 `from` 必须在被改文件里**恰好命中 1 次**，
 *    否则 exit 1 报「脚本过期了（源码改了？）」——
 *    **不许混进「没抓到」的统计**（那会把「脚本坏了」伪装成「护栏通过」）。
 *
 * ⚠️ **expectFail + expectGreen 双向声明**：每条变异还要指定「必须保持绿」的断言，
 *    确保红的正好是指定那几条，而不是「反正红了一坨就算抓到」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tools', '.tmp-night-hardening-mut');

let pass = 0;
let fail = 0;

/* ── 环境变量 → 护栏读的文件路径映射 ────────────────────────── */
const ENV_MAP = {
  NIGHT_PS1: 'night-publish.ps1',
  COMMON_PS1: 'common.ps1',
  WATCHDOG_PS1: 'night-watchdog.ps1',
  WATCHDOG_CMD: 'night-watchdog.cmd',
  DAILY_PS1: 'daily.ps1',
  GRAB_PY: 'grab/daily_grab_all.py',
  RSS_CONFIG: 'rss.config.json',
  ROTATE_MJS: 'rotate-logs.mjs',
};

function srcOf(rel) {
  return fs.readFileSync(path.join(ROOT, 'tools', rel), 'utf8');
}

/** 锚点自检：from 必须在源文件里恰好命中 1 次 */
function anchorHits(src, from) {
  if (!from) return 0;
  let n = 0;
  let i = 0;
  while ((i = src.indexOf(from, i)) !== -1) { n++; i += from.length; }
  return n;
}

const MUTANTS = [
  {
    id: 'M1',
    file: 'night-publish.ps1',
    name: '失败分支不调 Send-Alert（告警链路又断回去）',
    // ⚠️ 变异体只改**调用点那一处**，把 Send-Alert 换成别的东西。
    //    这会同时让两条断言变红：
    //      · 「失败分支调 Send-Alert」（预期）
    //      · 「成功路径不该发」（因为它要求全文只有一处 Send-Alert -Root）
    //    两条都红是**正确的**（调用点确实没了）→ 期望里写上两条。
    from: '    Send-Alert -Root $Root -Title \'夜间发布失败\' -Body (',
    to: '    Write-Host (\'夜间发布失败\' + \'',
    expectFail: [
      '夜间脚本的失败分支调 Send-Alert',
      '夜间脚本在失败时才发（成功路径不该发）',
    ],
  },
  {
    id: 'M2',
    file: 'night-publish.ps1',
    name: '成功路径也发通知（每晚一条 toast，一周就烦了）',
    from: 'Write-Host ("  夜间发布完成（$Date）。日志：$LogFile") -ForegroundColor Green',
    to: 'Write-Host ("  夜间发布完成（$Date）。日志：$LogFile") -ForegroundColor Green; Send-Alert -Root $Root -Title \'x\' -Body \'y\'',
    expectFail: ['夜间脚本在失败时才发（成功路径不该发）'],
  },
  {
    id: 'M3',
    file: 'common.ps1',
    name: 'Send-Alert 里 throw（通知发不出去就把主流程掀翻）',
    from: '    # 静默降级：通知永远不影响主流程',
    to: '    throw "通知失败"\n    # 静默降级：通知永远不影响主流程',
    expectFail: ['Send-Alert 内部吞掉所有异常（通知发不出去不能掀翻主流程）'],
  },
  {
    id: 'M4',
    file: 'night-watchdog.cmd',
    name: '.cmd 里混进中文（cmd.exe 的 chcp 65001 对中文正文不可靠）',
    from: 'rem Night publish watchdog entry for the scheduled task.',
    to: 'rem 夜间发布看门狗入口 for the scheduled task.',
    expectFail: ['看门狗的 .cmd 是纯 ASCII / LF / 无 BOM'],
  },
  {
    id: 'M5',
    file: 'night-watchdog.cmd',
    name: '.cmd 里出现交互式等待（无人值守会挂死）',
    from: 'setlocal',
    to: 'setlocal\npause',
    expectFail: ['看门狗的 .cmd 里没有交互式等待命令（无人值守会挂死）'],
  },
  {
    id: 'M6',
    file: 'night-watchdog.cmd',
    name: '.cmd 不透传参数（看门狗只能查今天那期）',
    from: 'night-watchdog.ps1" %* >>',
    to: 'night-watchdog.ps1" >>',
    expectFail: ['看门狗的 .cmd 把额外参数透传给 ps1'],
  },
  {
    id: 'M7',
    file: 'grab/daily_grab_all.py',
    name: '抓图预算开关被删（又变成无限时长）',
    from: 'GRAB_BUDGET_SEC = int(os.environ.get("MEMES_GRAB_BUDGET_SEC", "0") or 0)',
    to: 'GRAB_BUDGET_SEC = 0',
    expectFail: ['抓图脚本里有总预算的环境变量开关'],
  },
  {
    id: 'M8',
    file: 'grab/daily_grab_all.py',
    name: '某个源不查预算了（那个源仍会拖到关机）',
    from: '    if not _grab_budget_exhausted("喷嚏图卦"):',
    to: '    if True:',
    expectFail: ['每个源之前都查一次预算'],
  },
  {
    id: 'M9',
    file: 'grab/daily_grab_all.py',
    name: '缓存键去掉 size（同名文件被覆盖会拿到过期 hash → 误删真图）',
    from: 'cached[0] == key[0] and cached[1] == key[1]',
    to: 'cached[0] == key[0]',
    expectFail: ['缓存键含 mtime 和 size（只按 path 缓存会拿到过期 hash → 误删真图）'],
  },
  {
    id: 'M10',
    file: 'grab/daily_grab_all.py',
    name: '缓存写入不是原子的（写一半被 kill 会留下坏缓存）',
    from: 'os.replace(tmp, p)',
    to: 'shutil.copyfile(tmp, p)',
    expectFail: ['缓存写盘是原子的（先写临时文件再改名）'],
  },
  {
    id: 'M11',
    file: 'grab/daily_grab_all.py',
    name: '新下载的图不登记进缓存（缓存永远缺当天的图）',
    from: '    _phash_cache_register(path, new_h)',
    to: '    pass',
    expectFail: ['新下载的图也登记进缓存（否则缓存永远缺当天的图）'],
  },
  {
    id: 'M12',
    file: 'rss.config.json',
    name: 'V2EX 热榜换回 RSS屋镜像（那个地址 TLS 被拦死）',
    from: '"url": "https://www.v2ex.com/feed/tab/hot.xml"',
    to: '"url": "https://rss.mifaw.com/articles/5c8bb11a3c41f61efd36683e/5c923e953882afa09dff573a"',
    expectFail: ['V2EX 热榜改用官方 feed（官方比 RSS屋镜像更稳）'],
  },
  {
    id: 'M13',
    file: 'rss.config.json',
    name: '把被 DNS 污染的德国之声中文加回来',
    from: '    {\n      "name": "法广中文",',
    to: '    {\n      "name": "德国之声中文",\n      "url": "https://rss.dw.com/rdf/rss-chi-all"\n    },\n    {\n      "name": "法广中文",',
    expectFail: ['被 DNS 污染的德国之声中文已删除'],
  },
  {
    id: 'M14',
    file: 'rss.config.json',
    name: '镜像换成已被风控的 rsshub.app 公共实例',
    from: 'https://rsshub.bestblogs.dev/rfi/cn',
    to: 'https://rsshub.app/rfi/cn',
    expectFail: ['走镜像的源用的是 bestblogs 实例（rsshub.app 公共实例已被风控 403）'],
  },
  {
    id: 'M15',
    file: 'rotate-logs.mjs',
    name: '轮转改成删文件（cmd >> 占着句柄会失败）',
    from: '      fs.renameSync(p, path.join(ROOT, `${target.file}.1`));\n      // 重新建一个空的（cmd >> 靠它存在才追加）\n      fs.writeFileSync(p, \'\');',
    to: '      fs.unlinkSync(p);',
    expectFail: ['轮转是「切历史 + 原地清空」而不是删文件（cmd >> 占着句柄删不掉）'],
  },
  {
    id: 'M16',
    file: 'night-publish.ps1',
    name: '不调日志轮转（console log 只增不减）',
    // ⚠️ 改**调用那一行**（`& $node.Source $rotate` → 不执行），
    //    不要改文件名 —— 改了文件名会让「Get-ToolPath 拼路径」那条也跟着红，
    //    红的就不是指定的那一条了。
    from: '      & $node.Source $rotate | Out-Null',
    to: '      # 轮转被去掉了',
    expectFail: ['夜间流程在最后调轮转（成功失败都轮）'],
  },
  {
    id: 'M17',
    file: 'grab/daily_grab_all.py',
    name: 'main() 收尾少了 global 声明（→ UnboundLocalError，流程最后一步崩）',
    // ⚠️ 这是**真踩过的 bug**（2026-11-25 端到端实测）：
    //    Python 里赋值即声明局部变量 → 少了 global → 末尾读未赋值的局部变量
    //    → UnboundLocalError → 整轮抓图在最后一步崩，前面抓的图全白抓。
    from: '    global _PHASH_CACHE_DIRTY\n    if _PHASH_CACHE_DIRTY:',
    to: '    if _PHASH_CACHE_DIRTY:',
    expectFail: ['改模块级缓存标志的函数都有 global 声明（防 UnboundLocalError）'],
  },
  {
    id: 'M18',
    file: 'grab/daily_grab_all.py',
    name: '注册函数少了 global 声明（→ 缓存攒一晚永远不落盘）',
    from: '    global _PHASH_CACHE_DIRTY\n    try:\n        st = os.stat(path)',
    to: '    try:\n        st = os.stat(path)',
    expectFail: ['改模块级缓存标志的函数都有 global 声明（防 UnboundLocalError）'],
  },
];

/* ── 跑一个变体 ────────────────────────────────────────────── */
function runMutant(m) {
  // ① 锚点自检：必须在源文件里恰好命中 1 次
  const src = srcOf(m.file);
  const hits = anchorHits(src, m.from);
  if (hits !== 1) {
    console.log(`  ✗ ${m.id} 脚本过期了：锚点在 ${m.file} 命中 ${hits} 次（应为 1 次）`);
    fail++;
    return;
  }

  // ② 准备临时目录：把要改的文件复制过去改坏
  fs.mkdirSync(TMP, { recursive: true });
  for (const rel of Object.values(ENV_MAP)) {
    const dst = path.join(TMP, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'tools', rel), dst);
  }
  const target = path.join(TMP, m.file);
  const mutated = fs.readFileSync(target, 'utf8').replace(m.from, m.to);
  fs.writeFileSync(target, mutated);

  // ③ 跑护栏（环境变量指向改坏的副本）
  const env = { ...process.env };
  for (const [k, rel] of Object.entries(ENV_MAP)) env[k] = path.join(TMP, rel);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'test-night-hardening.mjs')],
    { env, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');

  // ④ 判定
  const redLines = out.split('\n').filter((l) => l.includes('✗'));
  const redLabels = redLines.map((l) => (l.match(/✗\s+(.+?)(?:\s+——|$)/) || ['', ''])[1].trim());

  const expected = m.expectFail;
  const allExpectedRed = expected.every((e) => redLabels.includes(e));
  const noUnexpectedRed = redLabels.every((l) => expected.includes(l));

  if (r.status === 0) {
    console.log(`  ✗ ${m.id} 没被抓到：护栏全绿！  ${m.name}`);
    fail++;
  } else if (!allExpectedRed) {
    console.log(`  ✗ ${m.id} 抓到了但红的不是指定的：期望红 [${expected.join(', ')}]，实际红 [${redLabels.join(', ')}]  ${m.name}`);
    fail++;
  } else if (!noUnexpectedRed) {
    console.log(`  ✗ ${m.id} 红的范围超了：期望 [${expected.join(', ')}]，实际 [${redLabels.join(', ')}]  ${m.name}`);
    fail++;
  } else {
    console.log(`  ✓ ${m.id} 被抓住：${m.name}`);
    pass++;
  }
}

console.log(`\n变异测试：${MUTANTS.length} 个变体`);

// 先跑一次原版，确认护栏是绿的（否则「抓到红」没有意义）
{
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'test-night-hardening.mjs')], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.log('\n✗ 原版护栏就不绿 —— 先修护栏，变异测试没有意义。');
    console.log((r.stdout || '').split('\n').filter((l) => l.includes('✗')).join('\n'));
    process.exit(1);
  }
  console.log('  ✓ 原版护栏绿（基线成立）');
}

for (const m of MUTANTS) runMutant(m);

// 自清
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log(`\n结果：${pass} 抓到 / ${fail} 没抓到`);
process.exit(fail > 0 ? 1 : 0);
