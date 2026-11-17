#!/usr/bin/env node
/**
 * 变异验证：证明护栏真的有牙齿。
 *
 * 护栏自己「全绿」说明不了它能抓住坏版本 —— 只会说明它没坏。
 * 所以这里把被保护的文件**故意改坏**，再跑护栏，要求它**必须变红**。
 *
 * 变异体不碰真文件：写到 tools/.tmp-night-mut/ 下，跑完删掉。
 *
 * 用法：node tools/test-night-flow-mutate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(__dirname, '.tmp-night-mut');

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

const PUBLISH = fs.readFileSync(path.join(ROOT, 'tools/publish.ps1'), 'utf8');
const NIGHT = fs.readFileSync(path.join(ROOT, 'tools/night-publish.ps1'), 'utf8');
const ORPHAN = fs.readFileSync(path.join(ROOT, 'tools/orphan-clean.mjs'), 'utf8');
const MANUAL = fs.readFileSync(path.join(ROOT, 'tools/manual-publish.ps1'), 'utf8');
const MANUAL_CMD = fs.readFileSync(path.join(ROOT, '上传图片.cmd'), 'utf8');
const COMMON = fs.readFileSync(path.join(ROOT, 'tools/common.ps1'), 'utf8');
const CLEAN = fs.readFileSync(path.join(ROOT, 'tools/grab/clean_images.py'), 'utf8');
const GRAB = fs.readFileSync(path.join(ROOT, 'tools/grab/daily_grab_all.py'), 'utf8');
const BUILD = fs.readFileSync(path.join(ROOT, 'tools/build.mjs'), 'utf8');
const REFRESH = fs.readFileSync(path.join(ROOT, 'tools/refresh-token.mjs'), 'utf8');
const STARTER = fs.readFileSync(path.join(ROOT, 'tools/start-review.mjs'), 'utf8');
const PLIST = fs.readFileSync(
  path.join(ROOT, 'tools/macos/com.your-project.night-publish.plist'), 'utf8');
const PATHS = fs.readFileSync(path.join(ROOT, 'tools/paths.mjs'), 'utf8');
const FINAL_VERIFY = fs.readFileSync(path.join(ROOT, 'tools/final-verify.mjs'), 'utf8');

/**
 * 每个变异体：把某个文件里的 from 换成 to，然后要求对应护栏变红。
 * guard = 跑哪个护栏；env = 用哪个环境变量把变异体喂给它。
 */
const MUTANTS = [
  {
    label: 'publish.ps1：不抓旧键集了（构建后孤儿就找不回来）',
    guard: 'test-night-flow.mjs',
    env: 'PUBLISH_PS1',
    file: 'publish.ps1',
    src: PUBLISH,
    from: "  Invoke-NativeCmd 'node' @('tools/orphan-clean.mjs', '--date', $Date, '--capture')",
    to: '  # mutated: capture removed',
  },
  {
    label: 'publish.ps1：不清孤儿了（旧对象一直占着空间）',
    guard: 'test-night-flow.mjs',
    env: 'PUBLISH_PS1',
    file: 'publish.ps1',
    src: PUBLISH,
    from: "  Invoke-NativeCmd 'node' @('tools/orphan-clean.mjs', '--date', $Date, '--sweep')",
    to: '  # mutated: sweep removed',
  },
  {
    label: 'publish.ps1：去掉日期守卫（往期补发也会刷今天的热榜）',
    guard: 'test-night-flow.mjs',
    env: 'PUBLISH_PS1',
    file: 'publish.ps1',
    src: PUBLISH,
    from: '} elseif ($Date -ne $bjToday) {',
    to: '} elseif ($false) {',
  },
  {
    label: 'night-publish.ps1：发布时不再跳过审稿闸门',
    guard: 'test-night-flow.mjs',
    env: 'NIGHT_PS1',
    file: 'night-publish.ps1',
    src: NIGHT,
    from: "    '-Date', $Date, '-SkipReview', '-NoConvert', '-NoHeadlines'",
    to: "    '-Date', $Date, '-NoConvert', '-NoHeadlines'",
  },
  {
    label: 'night-publish.ps1：去掉幂等检查（今天会重复发布一遍）',
    guard: 'test-night-flow.mjs',
    env: 'NIGHT_PS1',
    file: 'night-publish.ps1',
    src: NIGHT,
    from: 'if (-not $Force -and (Test-Path $Marker)) {',
    to: 'if ($false) {',
  },
  {
    label: 'night-publish.ps1：改用带 pause 的一键更新.cmd（无人值守会挂死）',
    guard: 'test-night-flow.mjs',
    env: 'NIGHT_PS1',
    file: 'night-publish.ps1',
    src: NIGHT,
    from: "'-File', (Get-ToolPath -Root $Root -Name 'daily-review.ps1'),",
    to: "'-File', (Join-Path $Root '一键更新.cmd'),",
  },
  {
    label: 'night-publish.ps1：裸调 & powershell（子进程一行 stderr 就能掀翻它）',
    guard: 'test-night-flow.mjs',
    env: 'NIGHT_PS1',
    file: 'night-publish.ps1',
    src: NIGHT,
    from: '& $Exe @ChildArgs 2>&1',
    to: '& powershell @ChildArgs 2>&1',
  },
  {
    label: 'night-publish.ps1：标记变量又改回 $marker（PowerShell 大小写不敏感 → 路径被 JSON 覆盖，标记写不出来）',
    guard: 'test-night-flow.mjs',
    env: 'NIGHT_PS1',
    file: 'night-publish.ps1',
    src: NIGHT,
    from: '$markerJson = @{ date = $Date; exit = $exitCode; at = (Get-Date).ToString(\'o\') } | ConvertTo-Json',
    to: '$marker = @{ date = $Date; exit = $exitCode; at = (Get-Date).ToString(\'o\') } | ConvertTo-Json',
  },
  {
    label: 'manual-publish.ps1：标记变量又改回 $marker（同上，幂等会失效）',
    guard: 'test-night-flow.mjs',
    env: 'MANUAL_PS1',
    file: 'manual-publish.ps1',
    src: MANUAL,
    from: '$markerJson = @{ date = $Date; exit = $exitCode; at = (Get-Date).ToString(\'o\'); by = \'manual\' } | ConvertTo-Json',
    to: '$marker = @{ date = $Date; exit = $exitCode; at = (Get-Date).ToString(\'o\'); by = \'manual\' } | ConvertTo-Json',
  },
  {
    label: 'publish.ps1：把清孤儿挪回上传之后（部署一失败，线上就永久裂图）',
    guard: 'test-night-flow.mjs',
    env: 'PUBLISH_PS1',
    file: 'publish.ps1',
    src: PUBLISH,
    from: "      $r = Invoke-NativeCmdCapture 'npx' @('--yes', 'wrangler@latest', 'pages', 'deploy', 'published', '--project-name', $Project, '--branch', 'main', '--commit-dirty=true')",
    to: "      Invoke-NativeCmd 'node' @('tools/orphan-clean.mjs', '--date', $Date, '--sweep')\n      $r = Invoke-NativeCmdCapture 'npx' @('--yes', 'wrangler@latest', 'pages', 'deploy', 'published', '--project-name', $Project, '--branch', 'main', '--commit-dirty=true')",
  },
  {
    label: 'publish.ps1：清孤儿不再要求「部署过」（跳部署时会删掉线上正在用的图）',
    guard: 'test-night-flow.mjs',
    env: 'PUBLISH_PS1',
    file: 'publish.ps1',
    src: PUBLISH,
    from: 'if (-not $SkipUpload -and -not $SkipBuild -and -not $SkipDeploy) {',
    to: 'if (-not $SkipUpload -and -not $SkipBuild) {',
  },
  {
    label: 'night-publish.ps1：时间闸门又改回「20:00 之后」（期号会跟第二天早上审的那期差一天）',
    guard: 'test-night-flow.mjs',
    env: 'NIGHT_PS1',
    file: 'night-publish.ps1',
    src: NIGHT,
    from: 'if (-not $Force -and $bjHour -ge 6) {',
    to: 'if (-not $Force -and $bjHour -lt 20) {',
  },
  {
    label: 'manual-publish.ps1：手动入口也加上了夜间时间闸门（白天点就发不出去）',
    guard: 'test-night-flow.mjs',
    env: 'MANUAL_PS1',
    file: 'manual-publish.ps1',
    src: MANUAL,
    from: 'if (-not $Force -and (Test-Path $Marker)) {',
    to: 'if (-not $Force -and $bjHour -ge 6) { throw \'night only\' }\nif (-not $Force -and (Test-Path $Marker)) {',
  },
  {
    label: 'manual-publish.ps1：幂等标记不跟夜间共用（两边会各发一遍，重复上传 600 多个对象）',
    guard: 'test-night-flow.mjs',
    env: 'MANUAL_PS1',
    file: 'manual-publish.ps1',
    src: MANUAL,
    from: '$Marker = Join-Path $Root ".night-publish-$Date.done"',
    to: '$Marker = Join-Path $Root ".manual-publish-$Date.done"',
  },
  {
    label: '上传图片.cmd：正文里混进中文（cmd.exe 的 chcp 65001 会显示成乱码）',
    guard: 'test-night-flow.mjs',
    env: 'MANUAL_CMD',
    file: '上传图片.cmd',
    src: MANUAL_CMD,
    from: 'echo   Upload now',
    to: 'echo   上传图片',
  },
  {
    label: 'orphan-clean.mjs：删了但不记账（护栏以为没删）',
    guard: 'test-orphan-clean.mjs',
    env: 'ORPHAN_CLEAN',
    file: 'orphan-clean.mjs',
    src: ORPHAN,
    from: 'if (ok) deleted.push(key);',
    to: 'if (ok) { /* mutated: 不记账 */ }',
  },
  {
    label: 'orphan-clean.mjs：CLI 入口判断写坏（脚本变死的，exit 0 但没输出）',
    guard: 'test-orphan-clean.mjs',
    env: 'ORPHAN_CLEAN',
    file: 'orphan-clean.mjs',
    src: ORPHAN,
    from: 'if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {',
    to: 'if (import.meta.url === `file://${process.argv[1]}`) {',
  },
  {
    label: 'orphan-clean.mjs：manifest 的 hash 又改回只认 hex（base-36 的 glbf83 读不到）',
    guard: 'test-orphan-clean.mjs',
    env: 'ORPHAN_CLEAN',
    file: 'orphan-clean.mjs',
    src: ORPHAN,
    from: '/^manifest\\.[0-9a-z]+\\.js$/i',
    to: '/^manifest\\.[0-9a-f]+\\.js$/',
  },
  {
    label: 'orphan-clean.mjs：--date 的空格写法不认了（publish.ps1 传的就是这种）',
    guard: 'test-orphan-clean.mjs',
    env: 'ORPHAN_CLEAN',
    file: 'orphan-clean.mjs',
    src: ORPHAN,
    from: "else if (a === '--date') out.date = argv[++i] || '';",
    to: "// mutated: 不认空格写法",
  },

  /* ── 跨平台那一组（第 7 组断言）───────────────────────────────
   * 这些变异体模拟「有人图省事把跨平台的处理改回 Windows 写法」——
   * 在这台 Windows 机器上**跑起来完全正常**，只有到 macOS 上才会炸：
   *   - 时区认不出来 → 期号差一天 → 整个「夜里发/早上审」错位
   *   - powershell.exe 在 macOS 上不存在 → 子进程起不来
   *   - 反斜杠在 Unix 上是合法文件名字符 → 报「找不到文件」
   * 正因为「在这台机上测不出来」，才必须靠静态护栏钉住。
   */
  {
    label: 'common.ps1：去掉 Asia/Shanghai 兜底（macOS 上认不出时区 → 期号差一天）',
    guard: 'test-night-flow.mjs',
    env: 'COMMON_PS1',
    file: 'common.ps1',
    src: COMMON,
    from: "foreach ($tzId in @('China Standard Time', 'Asia/Shanghai')) {",
    to: "foreach ($tzId in @('China Standard Time')) {",
  },
  {
    label: 'common.ps1：起子进程只认 powershell.exe（macOS 上没有这个命令）',
    guard: 'test-night-flow.mjs',
    env: 'COMMON_PS1',
    file: 'common.ps1',
    src: COMMON,
    from: "  if (Test-IsWindowsHost) { return 'powershell.exe' }\n  return 'pwsh'",
    to: "  return 'powershell.exe'",
  },
  {
    label: 'night-publish.ps1：又自己写时区换算（绕开 common.ps1 → macOS 上期号差一天）',
    guard: 'test-night-flow.mjs',
    env: 'NIGHT_PS1',
    file: 'night-publish.ps1',
    src: NIGHT,
    from: '$bjNow = Get-BjNow',
    to: "$bjNow = [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId((Get-Date), 'China Standard Time')",
  },
  {
    label: 'night-publish.ps1：起子进程又硬编码 powershell.exe（macOS 上起不来）',
    guard: 'test-night-flow.mjs',
    env: 'NIGHT_PS1',
    file: 'night-publish.ps1',
    src: NIGHT,
    from: 'Invoke-Child (Get-ShellExe) @(',
    to: "Invoke-Child 'powershell.exe' @(",
  },
  {
    label: 'night-publish.ps1：路径又用反斜杠拼（macOS 上当成文件名 → 找不到文件）',
    guard: 'test-night-flow.mjs',
    env: 'NIGHT_PS1',
    file: 'night-publish.ps1',
    src: NIGHT,
    from: "(Get-ToolPath -Root $Root -Name 'daily-review.ps1')",
    to: "(Join-Path $Root 'tools\\daily-review.ps1')",
  },
  {
    label: 'manual-publish.ps1：不 dot-source common.ps1（helper 函数全都没有 → 立刻崩）',
    guard: 'test-night-flow.mjs',
    env: 'MANUAL_PS1',
    file: 'manual-publish.ps1',
    src: MANUAL,
    from: ". (Join-Path $PSScriptRoot 'common.ps1')",
    to: '# mutated: 不 dot-source helper',
  },

  /* ── 可移植性护栏（tools/test-portability.mjs）─────────────────
   * 这些变异体把「跨平台处理」改回「只认 Windows」——
   * 在这台 Windows 机器上**完全跑得通**，只有到 macOS 上才炸。
   */
  {
    label: 'clean_images.py：OCR 不按平台选了（macOS 上没 winsdk → OCR 规则整条静默失效）',
    guard: 'test-portability.mjs',
    env: 'CLEAN_PY',
    file: 'clean_images.py',
    src: CLEAN,
    from: 'choice = "winsdk" if sys.platform == "win32" else "rapidocr"',
    to: 'choice = "winsdk"',
  },
  {
    label: 'daily_grab_all.py：默认输出目录又写回别人机器的路径（Mac mini 上凭空造个目录）',
    guard: 'test-portability.mjs',
    env: 'GRAB_PY',
    file: 'daily_grab_all.py',
    src: GRAB,
    from: 'return os.path.join(os.path.expanduser("~"), "image-root", "src")',
    to: 'return "/Users/test/Desktop/memes_daily"',
  },
  {
    label: 'build.mjs：PATH 探测只用 where（macOS 上没有 where → 找不到 ffmpeg）',
    guard: 'test-portability.mjs',
    env: 'BUILD_MJS',
    file: 'build.mjs',
    src: BUILD,
    from: "      : await execFileAsync('which', [name]);",
    to: "      : await execFileAsync('where', [name], { shell: 'cmd.exe' });",
  },
  {
    label: 'refresh-token.mjs：wrangler 配置只用 Windows 那条路（macOS 上续不了 token）',
    guard: 'test-portability.mjs',
    env: 'REFRESH_MJS',
    file: 'refresh-token.mjs',
    src: REFRESH,
    from: "const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');",
    to: "const xdg = path.join(os.homedir(), 'nope-not-a-config-dir');",
  },
  {
    label: 'start-review.mjs：不按平台分支（非 Windows 上会去调 explorer.exe → 直接挂）',
    guard: 'test-portability.mjs',
    env: 'STARTER_MJS',
    file: 'start-review.mjs',
    src: STARTER,
    from: "if (process.platform !== 'win32') {",
    to: "if (false) {",
  },
  {
    label: 'launchd plist：定时点从 00:10 改成 00:30（跟 Windows 那个计划任务错开）',
    guard: 'test-portability.mjs',
    env: 'MACOS_PLIST',
    file: 'com.your-project.night-publish.plist',
    src: PLIST,
    from: '<key>Minute</key>\n        <integer>10</integer>',
    to: '<key>Minute</key>\n        <integer>30</integer>',
  },
  {
    // ⚠️ 这个变异点跟着 2026-11-17 的脱敏改造改过：
    //   原来 paths.mjs 的默认值是「按平台分」（win32 → 盘符路径），
    //   脱敏后统一成「落在家目录」，**代码里不再出现盘符字面量**。
    //   护栏（test-portability.mjs）也同步改成盯「不许出现盘符字面量」——
    //   所以这里要改的是**变异体**（把盘符塞回去），不是护栏。
    label: 'paths.mjs：IMAGE_ROOT 默认值又写死盘符了（macOS 上没这个盘 → 静默拿到空目录）',
    guard: 'test-portability.mjs',
    env: 'PATHS_MJS',
    file: 'paths.mjs',
    src: PATHS,
    from: ": path.join(os.homedir(), 'image-root')",
    to: ": 'D:\\some-root'",
  },
  {
    label: 'paths.mjs：旧路径候选 LEGACY_SRC 不限 Windows 了（macOS 上留个不存在的候选）',
    guard: 'test-portability.mjs',
    env: 'PATHS_MJS',
    file: 'paths.mjs',
    src: PATHS,
    from: "const LEGACY_SRC = process.platform === 'win32' ?",
    to: 'const LEGACY_SRC = true ?',
  },
  {
    label: 'final-verify.mjs：又写死工程根（拷到 macOS 上什么都验不出来）',
    guard: 'test-portability.mjs',
    env: 'FINAL_VERIFY_MJS',
    file: 'final-verify.mjs',
    src: FINAL_VERIFY,
    from: "import { ROOT, R2_LOCAL } from './paths.mjs';",
    to: "const ROOT = 'X'; const R2_LOCAL = 'Y';",
  },
];

console.log('\n0) 基线：没改坏之前，护栏必须全绿');
{
  const r = spawnSync(process.execPath, [path.join(__dirname, 'test-night-flow.mjs')], {
    encoding: 'utf8',
  });
  check('test-night-flow.mjs 基线绿', r.status === 0, (r.stdout || '').trim().split('\n').pop());
  const r2 = spawnSync(process.execPath, [path.join(__dirname, 'test-orphan-clean.mjs')], {
    encoding: 'utf8',
  });
  check('test-orphan-clean.mjs 基线绿', r2.status === 0, (r2.stdout || '').trim().split('\n').pop());
  const r3 = spawnSync(process.execPath, [path.join(__dirname, 'test-portability.mjs')], {
    encoding: 'utf8',
  });
  check('test-portability.mjs 基线绿', r3.status === 0, (r3.stdout || '').trim().split('\n').pop());
}

console.log('\n1) 变异：每改坏一处，对应护栏必须变红');

fs.mkdirSync(TMP, { recursive: true });

for (const m of MUTANTS) {
  if (!m.src.includes(m.from)) {
    check(m.label, false, '变异点没在原文件里找到（源文件变了？）');
    continue;
  }
  const mutant = m.src.replace(m.from, m.to);
  const file = path.join(TMP, m.file);
  fs.writeFileSync(file, mutant, 'utf8');

  const r = spawnSync(process.execPath, [path.join(__dirname, m.guard)], {
    encoding: 'utf8',
    env: { ...process.env, [m.env]: file },
  });
  const lastLine = (r.stdout || '').trim().split('\n').pop();
  check(m.label, r.status !== 0, `护栏居然还是绿的（exit 0，末行：${lastLine}）`);
}

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* 临时目录留着也不影响 */
}
check('临时目录清掉了', !fs.existsSync(TMP));

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
