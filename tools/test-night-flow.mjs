#!/usr/bin/env node
/**
 * 护栏：夜间自动发布 + 早晨重发 这套流程
 *
 * 流程（2026-11-15 用户定的）
 * ----------------------------
 *   夜间（过了午夜、00:00–05:59，机器开着的话）：准备（抓图→榜→清洗→构建→自检）
 *           + 发布当期，**跳过审稿闸门**（用户明确接受未审稿先上线）
 *   早晨（人工）：审线上的当期 → 删坏图 → 重发当期（修图 + 刷新见报）
 *   桌面「上传图片」双击：同一套流程，手动触发，**没有时间闸门**
 *
 * 这些断言盯的是**流程契约**，不是实现细节。哪条被改坏，这里必须变红：
 *
 *   1. 夜间脚本必须**跳过闸门**（-SkipReview）—— 用户授权了，但只授权夜间那一次
 *   2. 夜间脚本必须**不开审稿台、不弹浏览器**（无人值守）
 *   3. 夜间脚本必须**幂等**（今天发过就别再发一遍）
 *   4. 夜间脚本必须写**结束标记**（否则没法判断它死没死）
 *   5. **不能调 `一键更新.cmd`** —— 末尾有 pause，无人值守会挂死
 *   6. publish.ps1 必须在**构建前**抓旧键集（构建会删旧 manifest，之后就抓不到了）
 *   7. publish.ps1 必须在**上传后**清孤儿，而且**清孤儿失败不许阻断发布**
 *   8. publish.ps1 刷新头条只许对**当期**（-Date == 北京今天）—— 往期补发绝不能
 *      把今天的热榜写进往期那一期
 *   9. 早晨脚本必须经 **start-review.mjs** 起审稿台（explorer.exe 脱 Job Object）
 *  10. 夜间的时间闸门必须是**过了午夜**（天亮前），不能是「20:00 之后」——
 *      因为期号 = 北京今天，23:00 跑算出来的是当天早上已经发过的那一期，
 *      而第二天早上审稿台审的期号会跟它差一天
 *  11. 手动脚本必须**没有时间闸门**（手动点就是有意的）
 *  12. 手动脚本必须跟夜间**共用幂等标记**（谁先发过另一边就不重复上传）
 *  13. 手动入口的 .cmd 必须是**纯 ASCII**（cmd.exe 的 chcp 65001 对中文正文不可靠）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function read(rel) {
  try {
    const p = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 剥掉注释行再断言。
 *
 * 为什么需要：这些脚本的注释里**故意**写着「不能裸调 & powershell」、
 * 「不能用 一键更新.cmd」这类反面示例 —— 不剥注释的话，
 * 断言会把自己的说明书当成违规。
 */
function stripComments(src) {
  return src
    .replace(/<#[\s\S]*?#>/g, '')      // 块注释
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))  // 行注释
    .join('\n');
}

// 变异测试入口：环境变量可以指向别的文件（这样验「护栏能抓住坏版本」
// 时不用碰真文件）。跟 test-publish-natives.mjs 的 PUBLISH_PS1 一个路子。
const night = read(process.env.NIGHT_PS1 || 'tools/night-publish.ps1');
const morning = read(process.env.MORNING_PS1 || 'tools/morning-review.ps1');
const publish = read(process.env.PUBLISH_PS1 || 'tools/publish.ps1');
const manual = read(process.env.MANUAL_PS1 || 'tools/manual-publish.ps1');
const manualCmd = read(process.env.MANUAL_CMD || '上传图片.cmd');
const nightCode = stripComments(night);
const morningCode = stripComments(morning);
const manualCode = stripComments(manual);

console.log('\n1) 夜间脚本存在且契约齐全');
{
  check('tools/night-publish.ps1 存在', night.length > 0);
  check('调准备脚本（只准备，不开审稿台、不弹浏览器）',
    /daily-review\.ps1/.test(night) && /-SkipReview/.test(night) && /-NoBrowser/.test(night),
    night.slice(0, 80));
  // 只看「调 publish.ps1 那一次」的参数 —— 准备那一次也带 -SkipReview
  //（daily-review.ps1 的 -SkipReview 是「不开审稿台」，不是同一个意思）
  const pubCall = nightCode.match(/publish\.ps1[\s\S]{0,220}/);
  check('发布时跳过审稿闸门（用户明确授权的那一次）',
    !!pubCall && /-SkipReview/.test(pubCall[0]), pubCall ? pubCall[0].slice(0, 120) : '没找到 publish.ps1 调用');
  check('复用已转码的图片（不重新转码，快 5 倍）', /-NoConvert/.test(night));
  check('幂等：今天发过就不再来一遍',
    /Test-Path\s+\$Marker/.test(nightCode) && /night-publish-.*\.done/.test(night));
  check('写结束标记（能判断它死没死）', /NIGHT_DONE/.test(night));
  check('只在过了午夜的窗口自动发（00:00–05:59，天亮就停）',
    /\$bjHour\s*-ge\s*6/.test(nightCode) && /Get-BjNow/.test(night),
    '期号=北京今天；23:00 跑算的是当天早上已发过的那一期，第二天早上审稿台会差一天');
  check('不用 pause 型的入口（一键更新.cmd 会挂死）',
    !/一键更新\.cmd/.test(nightCode) && !/^\s*pause\s*$/im.test(nightCode));
  check('子进程统一走 helper（不裸调 & powershell）',
    /function Invoke-Child/.test(night) && !/&\s*powershell\b/.test(nightCode),
    '裸 & powershell 会被子进程的 stderr 掀翻');
}

console.log('\n2) 早晨脚本：起审稿台审当期');
{
  check('tools/morning-review.ps1 存在', morning.length > 0);
  check('经 start-review.mjs 起审稿台（explorer.exe 脱 Job Object）',
    /start-review\.mjs/.test(morning));
  check('不是直接 node review.mjs（那样会被 Job Object 连坐杀掉）',
    !/node\s+tools[\\/]review\.mjs/.test(morningCode));
  check('期号默认是北京今天（当期）',
    /Get-BjDate/.test(morning) && /\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/.test(morning),
    '期号必须走 common.ps1 的 Get-BjDate（Windows 认 China Standard Time，macOS 认 Asia/Shanghai）');
}

console.log('\n3) publish.ps1：孤儿清理的两个钩子');
{
  check('构建前抓旧键集（capture）',
    /orphan-clean\.mjs/.test(publish) && /--capture/.test(publish));
  check('上传后清孤儿（sweep）', /--sweep/.test(publish));
  const capAt = publish.indexOf('--capture');
  const buildAt = publish.indexOf("tools/build.mjs");
  check('capture 在构建之前', capAt > 0 && buildAt > 0 && capAt < buildAt,
    `capture@${capAt} build@${buildAt}`);
  const sweepAt = publish.indexOf('--sweep');
  const uploadAt = publish.indexOf('upload-r2.mjs');
  check('sweep 在上传之后', sweepAt > 0 && uploadAt > 0 && sweepAt > uploadAt,
    `sweep@${sweepAt} upload@${uploadAt}`);
  const deployAt = publish.indexOf("'pages', 'deploy'");
  check('**sweep 在部署之后**（部署失败时线上不能裂图）',
    sweepAt > 0 && deployAt > 0 && sweepAt > deployAt,
    `sweep@${sweepAt} deploy@${deployAt} —— sweep 早于部署 = 线上还指着旧 manifest 时就删旧对象`);
  check('sweep 要求「既构建又上传又部署」（跳过部署时不能清）',
    /if\s*\(-not \$SkipUpload -and -not \$SkipBuild -and -not \$SkipDeploy\)/.test(publish),
    publish.slice(publish.indexOf('if (-not $SkipUpload'), 120));
  // 只看 sweep 所在的那一节（到下一个分节为止），别把后面部署段的 throw 算进来
  const sweepSeg = sweepAt >= 0 ? publish.slice(sweepAt, sweepAt + 900).split('# ──')[0] : '';
  check('清孤儿失败不阻断发布（站点已经发上去了）',
    /孤儿清理/.test(publish) && sweepSeg.length > 0 && !/\bthrow\b/.test(sweepSeg),
    sweepSeg.slice(0, 120));
}

console.log('\n4) publish.ps1：见报（头条）的刷新规则');
{
  check('有 -NoHeadlines 开关（能手动关掉）', /\[switch\]\$NoHeadlines/.test(publish));
  check('刷新的判据是「发布日期 == 北京今天」（有日期守卫）',
    /Get-BjDate/.test(publish) && /\$Date\s*-ne\s*\$bjToday/.test(publish));
  check('刷新失败不阻断发布（网络抖动时沿用旧快照）',
    /daily_headlines\.py/.test(publish));
  check('往期补发不会被写进今天的热榜（有日期守卫）',
    /NoHeadlines/.test(publish) && !/daily_headlines\.py\s+--date\s+\$Date/.test(publish));
}

console.log('\n5) 手动上传入口（桌面双击「上传图片」）');
{
  check('tools/manual-publish.ps1 存在', manual.length > 0);
  check('调准备脚本（只准备，不开审稿台、不弹浏览器）',
    /daily-review\.ps1/.test(manual) && /-SkipReview/.test(manual) && /-NoBrowser/.test(manual));
  const mPub = manualCode.match(/publish\.ps1[\s\S]{0,220}/);
  check('发布时跳过审稿闸门',
    !!mPub && /-SkipReview/.test(mPub[0]), mPub ? mPub[0].slice(0, 120) : '没找到 publish.ps1 调用');
  check('复用已转码的图片（不重新转码，快 5 倍）', /-NoConvert/.test(manual));
  check('**没有时间闸门**（手动点就是有意的，任何时候都能跑）',
    !/\$bjHour\s*-ge\s*6/.test(manualCode) && !/\$bjHour\s*-lt\s*20/.test(manualCode),
    '手动入口不能有「晚上才发」的闸门');
  check('跟夜间共用同一个幂等标记（谁先发过另一边就不重复上传）',
    /night-publish-.*\.done/.test(manual) && /Test-Path\s+\$Marker/.test(manualCode));
  check('写结束标记（能判断它死没死）', /MANUAL_DONE/.test(manual));
  check('子进程统一走 helper（不裸调 & powershell）',
    /function Invoke-Child/.test(manual) && !/&\s*powershell\b/.test(manualCode));
  check('工程根的「上传图片.cmd」存在', manualCmd.length > 0);
  check('.cmd 指向手动脚本', /manual-publish\.ps1/.test(manualCmd));
  check('.cmd 是纯 ASCII（cmd.exe 的 chcp 65001 对中文正文不可靠）',
    !/[^\x00-\x7F]/.test(manualCmd), '中文会变成乱码');
  check('.cmd 末尾有 pause（手动双击，窗口不能一闪而过）',
    /^\s*pause\s*$/im.test(manualCmd));
}

console.log('\n6) PowerShell 变量名大小写不敏感 → 路径变量不能被 JSON 覆盖');
{
  /**
   * 这个坑非常阴：
   *   $Marker  = Join-Path $Root ".night-publish-$Date.done"   ← 路径
   *   $marker = @{ date=...; exit=... } | ConvertTo-Json       ← 同一个变量！
   *   Set-Content -Path $Marker -Value $marker -Encoding UTF8
   * → 路径被覆盖成 JSON 字符串，`Set-Content` 把 JSON 当路径用，
   *   报「找不到与参数名称"Encoding"匹配的参数」（带换行和 { 的路径绑不上参数集），
   *   **标记文件根本写不出来** → 幂等失效 → 每次都重发一遍。
   * 真实踩过：2026-11-15 傍晚手动上传，发布成功但结束标记写不出来，exit 1。
   */
  function collidingVars(src) {
    const assigns = [...src.matchAll(/^\s*\$(\w+)\s*=\s*@\{/gim)].map((m) => m[1].toLowerCase());
    const pathVars = [...src.matchAll(/-(?:Path|LiteralPath)\s+\$(\w+)/g)].map((m) => m[1].toLowerCase());
    return assigns.filter((v) => pathVars.includes(v));
  }
  for (const [label, src] of [['night-publish.ps1', night], ['manual-publish.ps1', manual]]) {
    const hits = collidingVars(src);
    check(`${label}：没有「同一个变量既当路径又当 JSON」`,
      hits.length === 0, hits.length ? '撞名的变量：' + hits.join(', ') : '');
  }
  check('两个脚本都用 $markerJson 存 JSON（跟 $Marker 路径变量区分开）',
    /\$markerJson\s*=\s*@\{/.test(night) && /\$markerJson\s*=\s*@\{/.test(manual));
}

console.log('\n7) 跨平台 helper（Windows / macOS 跑的是同一份 .ps1）');
{
  /*
   * 为什么这一组很重要：
   *   迁 macOS 的做法**不是**重写一套 .sh，而是装 PowerShell 7（pwsh）跑同一份 .ps1。
   *   代价是：所有 Windows 绑定点必须收敛到 tools/common.ps1 一个文件里。
   *   这几处一旦漏掉，症状都是「Windows 上好好的，macOS 上期号差一天 / 找不到文件」，
   *   而且**在 Windows 上测不出来** —— 所以只能静态钉住。
   */
  const common = read(process.env.COMMON_PS1 || 'tools/common.ps1');
  const commonCode = stripComments(common);
  check('tools/common.ps1 存在', common.length > 0);
  // ⚠️ 下面这些断言一律看**代码**（剥掉注释）——
  //    注释里本来就写着这些关键词（「见 common.ps1」「认 'Asia/Shanghai'」），
  //    用全文匹配的话，护栏会把自己的说明书当成合规 → 变异测不出来。
  check('北京时间认得两种时区 ID（Windows 的 China Standard Time / Unix 的 Asia/Shanghai）',
    /@\(\s*'China Standard Time'\s*,\s*'Asia\/Shanghai'\s*\)/.test(commonCode),
    '认错时区 → 期号差一天 → 整个「夜里发/早上审」的循环错位');
  check('起子进程按平台选 shell（Windows 的 powershell.exe / Unix 的 pwsh）',
    /return\s+'powershell\.exe'/.test(commonCode) && /return\s+'pwsh'/.test(commonCode));
  check('图像根目录落在用户家目录（Windows 用 $env:USERPROFILE，其他用 $HOME，且不含盘符字面量）',
    /Join-Path\s+\$env:USERPROFILE\s+'image-root'/.test(commonCode) &&
    /Join-Path\s+\$HOME\s+'image-root'/.test(commonCode) &&
    !/['"][A-Za-z]:[\\/]{1,2}/.test(commonCode),
    '写死盘符的话，macOS 上审稿台会一张图都不显示且不报错');
  check('common.ps1 统一了「只认退出码、不认 stderr」的子进程入口',
    /function Invoke-PsScript/.test(commonCode));
  check('两个发布脚本都 dot-source 了 common.ps1（不 dot-source 就没有那些函数）',
    /^\s*\.\s*\(Join-Path \$PSScriptRoot 'common\.ps1'\)/m.test(nightCode) &&
    /^\s*\.\s*\(Join-Path \$PSScriptRoot 'common\.ps1'\)/m.test(manualCode));
  check('两个发布脚本的期号都走 helper（不再各写各的时区换算）',
    /Get-Bj(?:Now|Date)/.test(nightCode) && /Get-Bj(?:Now|Date)/.test(manualCode));
  check('两个发布脚本起子进程都走 helper（不再硬编码 powershell.exe）',
    /Get-ShellExe/.test(nightCode) && /Get-ShellExe/.test(manualCode));

  // 扫全部 .ps1。⚠️ 关键：用**环境变量喂进来的那份**（可能是变异体）覆盖磁盘上的 ——
  // 否则变异测试会「改了文件但护栏读的是原文件」，护栏就是假的。
  // common.ps1 例外：它是**唯一允许**放平台字面量的地方（'China Standard Time'），
  // 所以这三项扫描都跳过它。
  const ps1Files = fs.readdirSync(path.join(ROOT, 'tools')).filter((n) => n.endsWith('.ps1'));
  const codeMap = new Map();
  for (const f of ps1Files) codeMap.set(f, stripComments(read(path.join('tools', f))));
  const provided = {
    'night-publish.ps1': night,
    'morning-review.ps1': morning,
    'manual-publish.ps1': manual,
    'publish.ps1': publish,
    'common.ps1': common,
  };
  for (const [f, src] of Object.entries(provided)) codeMap.set(f, stripComments(src));
  const others = [...codeMap].filter(([f]) => f !== 'common.ps1');

  // ① 不许自己换算时区 —— 一旦有人图省事写回 ConvertTimeBySystemTimeZoneId，
  //    macOS 上就会认不出 'China Standard Time'，期号直接差一天。
  const rawTz = others.filter(([, code]) => code.includes('ConvertTimeBySystemTimeZoneId')).map(([f]) => f);
  check('没有 .ps1 自己换算时区（全都走 common.ps1 的 Get-BjNow）',
    rawTz.length === 0, rawTz.length ? '这些文件自己换算了：' + rawTz.join(', ') : '');

  // ② 不许硬编码起子进程的 shell —— 'powershell.exe' 在 macOS 上不存在。
  const rawShell = others.filter(([, code]) => /['"]powershell\.exe['"]/.test(code)).map(([f]) => f);
  check('没有 .ps1 硬编码 powershell.exe（起子进程都走 Get-ShellExe）',
    rawShell.length === 0, rawShell.length ? '这些文件硬编码了：' + rawShell.join(', ') : '');

  // ③ 最阴的一个坑：反斜杠在 Unix 上是**合法文件名字符**，不是分隔符。
  //    'tools/review.mjs' 这种在 macOS 上会被当成一个文件名 → 报「找不到文件」。
  //
  //    判据要**精确**，不能简单粗暴地「代码里有反斜杠就报错」——
  //    这个工程里到处是正则（'\d{4}-\d{2}-\d{2}$'、'\s*'），那些反斜杠没问题。
  //    所以只抓「看起来像路径」的：
  //      a) 引号里带反斜杠 + 已知文件扩展名   → tools\review.mjs
  //      b) 引号里带盘符                     → D:\image-root
  //      c) 引号里带反斜杠 + 已知 Windows 目录段 → $env:LOCALAPPDATA\Programs\Python
  const WIN_PATH_LIKE = new RegExp(
    '[\'"][^\'"]*\\\\[^\'"]*\\.(?:ps1|mjs|cmd|py|js|json|toml|txt|exe)[\'"]' +   // a
    '|[\'"][A-Za-z]:\\\\[^\'"]*[\'"]' +                                           // b
    '|[\'"][^\'"]*\\\\[^\'"]*(?:LOCALAPPDATA|APPDATA|Program Files|Users|AppData' +
    '|Python|image-root|wrangler|Windows)[^\'"]*[\'"]',                        // c
    'i',
  );
  const backslashPaths = others
    .filter(([, code]) => WIN_PATH_LIKE.test(code))
    .map(([f]) => f);
  check('tools/ 下没有任何 .ps1 在代码里拼反斜杠路径（macOS 上会当成文件名）',
    backslashPaths.length === 0,
    backslashPaths.length ? '这些文件还在拼反斜杠：' + backslashPaths.join(', ') : '');
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
