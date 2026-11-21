#!/usr/bin/env node
/**
 * 可移植性护栏：Windows / macOS 跑的是**同一份**代码
 *
 * 背景（2026-11-15）
 * ------------------
 * 用户要把这套东西从 Windows 迁到 Mac mini。做法不是重写一套 .sh，
 * 而是装 PowerShell 7（pwsh）跑**同一份 .ps1** —— 流程逻辑只有一份，
 * 不会出现两边行为慢慢分叉。
 *
 * 代价是：所有 Windows 特有的写法必须拆掉。而这些拆不掉的地方，
 * **在这台 Windows 机器上完全测不出来** —— 跑得好好的，一到 macOS 就炸。
 * 所以只能静态钉住。
 *
 * 这些断言盯的全是「在 Windows 上看不出问题、到 macOS 上就出事」的写法：
 *
 *   1. 反斜杠路径：'tools\review.mjs' 在 macOS 上是一个**文件名**，不是路径
 *   2. 时区 ID：'China Standard Time' 在 Unix 上抛异常 → 期号差一天
 *   3. 可执行名：'powershell.exe' / 'node.exe' / 'explorer.exe' 在 macOS 上不存在
 *   4. 平台专属的默认路径：'/Users/test/...'（别人机器上的路径）
 *   5. launchd 部署包本身：定时点必须跟 Windows 那个计划任务对齐（00:10）
 *
 * 用法：node tools/test-portability.mjs
 * 退出码：0 = 全过；1 = 有失败
 *
 * 所有输入都支持环境变量覆盖 —— 变异测试靠这个把「坏版本」喂进来。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;

function check(label, cond, detail = '') {
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

function readBytes(rel) {
  try {
    const p = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

/** 剥掉注释，只留代码（跟别的护栏一个路子）。 */
function stripComments(src) {
  return src
    .replace(/<#[\s\S]*?#>/g, '')          // PowerShell 块注释
    .replace(/\/\*[\s\S]*?\*\//g, '')       // JS 块注释
    .replace(/"""[\s\S]*?"""/g, '')        // Python 三引号
    .split(/\r?\n/)
    .filter((l) => !/^\s*(#|\/\/)/.test(l))
    .join('\n');
}

const BUILD = read(process.env.BUILD_MJS || 'tools/build.mjs');
const STARTER = read(process.env.STARTER_MJS || 'tools/start-review.mjs');
const REVIEW = read(process.env.REVIEW_MJS || 'tools/review.mjs');
const REFRESH = read(process.env.REFRESH_MJS || 'tools/refresh-token.mjs');
const CLEAN = read(process.env.CLEAN_PY || 'tools/grab/clean_images.py');
const GRAB = read(process.env.GRAB_PY || 'tools/grab/daily_grab_all.py');
const HEADLINES = read(process.env.HEADLINES_PY || 'tools/grab/daily_headlines.py');

const MACOS_DIR = path.join(ROOT, 'tools', 'macos');
const PLIST = read(process.env.MACOS_PLIST || path.join(MACOS_DIR, 'com.your-project.night-publish.plist'));

/* ────────────────────── 1. macOS 部署包 ────────────────────── */
console.log('\n1) macOS 部署包');
{
  const sh = readBytes(path.join(MACOS_DIR, 'run-night-publish.sh'));
  const install = readBytes(path.join(MACOS_DIR, 'install-launchd.sh'));
  const uninstall = readBytes(path.join(MACOS_DIR, 'uninstall-launchd.sh'));

  check('tools/macos/run-night-publish.sh 存在', !!sh);
  check('tools/macos/install-launchd.sh 存在', !!install);
  check('tools/macos/uninstall-launchd.sh 存在', !!uninstall);

  for (const [name, bytes] of [['run-night-publish.sh', sh], ['install-launchd.sh', install], ['uninstall-launchd.sh', uninstall]]) {
    if (!bytes) continue;
    // BOM 会让 shebang 失效（内核只认前两个字节 "#!"）
    check(`${name} 无 BOM（否则 shebang 失效）`,
      !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf));
    check(`${name} 只有 LF，没有 CR`, !bytes.includes(0x0d),
      `有 ${bytes.filter((b) => b === 0x0d).length} 个 CR`);
  }

  if (sh) {
    const text = sh.toString('utf8');
    check('run-night-publish.sh 用 #!/bin/bash', text.startsWith('#!/bin/bash'));
    check('run-night-publish.sh 会找 pwsh（launchd 的 PATH 不可靠）',
      /pwsh/.test(text) && /(opt\/homebrew|usr\/local|\.dotnet)/.test(text));
    check('run-night-publish.sh 跑的是同一份 night-publish.ps1',
      /night-publish\.ps1/.test(text));
  }

  if (install) {
    const text = install.toString('utf8');
    check('install-launchd.sh 写到 ~/Library/LaunchAgents',
      /Library\/LaunchAgents/.test(text));
    check('install-launchd.sh 替换掉 __PROJECT_DIR__ 占位符',
      /__PROJECT_DIR__/.test(text) && /sed/.test(text));
    check('install-launchd.sh 用 launchctl 装载（bootstrap / load）',
      /launchctl/.test(text) && /(bootstrap|load)/.test(text));
    check('install-launchd.sh 提醒「系统睡眠」才是真打断（息屏不影响）',
      /pmset/.test(text) && /sleep/.test(text));
  }

  if (uninstall) {
    const text = uninstall.toString('utf8');
    check('uninstall-launchd.sh 会 bootout 并删掉 plist',
      /launchctl/.test(text) && /rm\s+-f/.test(text));
  }
}

/* ────────────────────── 2. launchd 定时点对齐 ────────────────────── */
console.log('\n2) launchd 定时点必须跟 Windows 那个计划任务对齐');
{
  check('plist 是合法 XML（能被 launchctl 读）', PLIST.includes('<plist') && PLIST.includes('</plist>'));
  check('Label 是 com.your-project.night-publish',
    /<key>Label<\/key>\s*<string>com\.your-project\.night-publish<\/string>/.test(PLIST));
  // Windows：DailyImageSite-NightPublish-0010 → DAILY 00:10
  check('StartCalendarInterval 是 00:10（跟 Windows 计划任务同一个点）',
    /<key>Hour<\/key>\s*<integer>0<\/integer>/.test(PLIST) &&
    /<key>Minute<\/key>\s*<integer>10<\/integer>/.test(PLIST),
    'Windows 那边是 DAILY 00:10；两边错开会导致连着发两期或者都不发');
  check('RunAtLoad = true（对应 Windows 的启动文件夹补跑）',
    /<key>RunAtLoad<\/key>\s*<true\/>/.test(PLIST));
  check('ProgramArguments 指向 run-night-publish.sh',
    /run-night-publish\.sh/.test(PLIST));
  check('有 StandardOutPath / StandardErrorPath（launchd 收得到日志才判得了死活）',
    /<key>StandardOutPath<\/key>/.test(PLIST) && /<key>StandardErrorPath<\/key>/.test(PLIST));
  check('EnvironmentVariables 里给了 Homebrew 的 PATH（launchd 不继承登录 shell 的）',
    /<key>PATH<\/key>/.test(PLIST) && /opt\/homebrew\/bin/.test(PLIST));
  check('plist 里没有 $HOME（launchd 不做变量展开，写了就是字面量）',
    !/\$HOME/.test((PLIST.match(/<string>[\s\S]*?<\/string>/g) || []).join('\n')),
    '只查 <string> 的值 —— 注释里提一嘴 $HOME 是解释，不是配置');
}

/* ────────────────────── 3. Python 侧 ────────────────────── */
console.log('\n3) Python 侧');
{
  const all = [GRAB, HEADLINES, CLEAN].map(stripComments).join('\n');
  check('没有残留别人机器上的路径 /Users/test/...（只看代码，注释里提一嘴不算）',
    !/\/Users\/test\//.test(all),
    '/Users/test/Desktop/memes_daily 是别人机器上的路径，在 Mac mini 上会凭空造个目录');

  for (const [name, src] of [['daily_grab_all.py', GRAB], ['daily_headlines.py', HEADLINES]]) {
    const code = stripComments(src);
    check(`${name} 的默认输出目录落在用户家目录（且不含盘符字面量）`,
      /expanduser/.test(code) && /image-root/.test(code) &&
      !/['"][A-Za-z]:[\\/]/.test(code),
      '写死盘符的话，macOS 上会凭空造个不存在的目录，而且没有任何报错');
  }

  const cleanCode = stripComments(CLEAN);
  check('clean_images.py 的 OCR 引擎按平台选（Windows 用 WinRT，其他用 RapidOCR）',
    /sys\.platform\s*==\s*["']win32["']\s*else\s*["']rapidocr["']/.test(cleanCode),
    'macOS 上没 winsdk，不做分支的话整条 OCR 规则静默失效');
  check('clean_images.py 的 OCR 有降级路径（拿不到引擎不崩，只是跳过 OCR 规则）',
    /_OCR_ENGINE\s*=\s*False/.test(cleanCode) && /return None/.test(cleanCode));
  check('clean_images.py 的 --src-root 默认值也落在用户家目录（且不含盘符字面量）',
    /expanduser/.test(cleanCode) && /image-root/.test(cleanCode) &&
    !/['"][A-Za-z]:[\\/]/.test(cleanCode));
}

/* ────────────────────── 4. Node 侧 ────────────────────── */
console.log('\n4) Node 侧');
{
  const buildCode = stripComments(BUILD);
  check('build.mjs 的 PATH 探测按平台分（Windows 用 where，其他用 which）',
    /execFileAsync\(\s*['"]where['"]/.test(buildCode) && /execFileAsync\(\s*['"]which['"]/.test(buildCode));
  check('build.mjs 认 macOS 的 ffmpeg 路径（Homebrew / MacPorts）',
    /opt\/homebrew\/bin/.test(buildCode) && /usr\/local\/bin/.test(buildCode));
  check('build.mjs 的可执行名按平台分（Windows 加 .exe，其他不加）',
    /\.exe/.test(buildCode) && /isWin|platform/.test(buildCode));
  check('build.mjs 的 winget 分支限定在 Windows',
    /win32/.test(buildCode) && /WinGet/.test(buildCode));

  const starterCode = stripComments(STARTER);
  check('start-review.mjs 按 process.platform 分支',
    /process\.platform/.test(starterCode));
  check('start-review.mjs 在非 Windows 分支里**不碰** explorer.exe',
    /explorer\.exe/.test(starterCode) && /win32/.test(starterCode),
    'macOS 没有 explorer.exe，调了必挂（那边也不需要脱 Job Object）');

  const reviewCode = stripComments(REVIEW);
  check('review.mjs 的「点发布」spawn 按平台分（Windows 用 cmd start，其他用 pwsh）',
    /process\.platform/.test(reviewCode) && /pwsh|cmd\.exe/.test(reviewCode));

  /* 定时任务台 —— 同一个坑：PowerShell 的可执行名在 macOS 上是 pwsh，
     写死 powershell.exe → spawn ENOENT → 「有没有发布在跑」永远返回 false
     → 撞上夜间任务时两道门形同虚设。 */
  const dashCode = stripComments(read(process.env.DASHBOARD_MJS || 'tools/night-dashboard.mjs'));
  check('night-dashboard.mjs 的 PowerShell 可执行名按平台分（不硬编码 powershell.exe）',
    /process\.platform/.test(dashCode) && /pwsh/.test(dashCode) &&
    !/['"]powershell\.exe['"]/.test(dashCode),
    'macOS 上没有 powershell.exe，spawn 会 ENOENT');

  const refreshCode = stripComments(REFRESH);
  check('refresh-token.mjs 的 wrangler 配置路径按平台分',
    /win32/.test(refreshCode) && /XDG_CONFIG_HOME/.test(refreshCode) && /\.config/.test(refreshCode) &&
    /AppData/.test(refreshCode),
    'Windows 是 AppData/Roaming/xdg.config/…，macOS 是 ~/.config/.wrangler/…');

  /* 路径真源（tools/paths.mjs）——
   * 这一处的默认值如果写死盘符路径，症状是**静默**的：
   * macOS 上审稿台一张图都不显示（源图目录读的是不存在的目录），
   * 构建会以为「今天没图」，而**没有任何报错**。
   * 所以默认值必须落在用户家目录，且代码里不得出现盘符字面量。 */
  const pathsSrc = read(process.env.PATHS_MJS || 'tools/paths.mjs');
  const pathsCode = stripComments(pathsSrc);
  // 只看 IMAGE_ROOT 那一段 —— 整个文件里「win32」还出现在 LEGACY_SRC 那行，
  // 全文匹配（或窗口开太宽）的话，护栏会以为 IMAGE_ROOT 也还分着平台。
  const imgRootBlock = (pathsCode.match(/export const IMAGE_ROOT[\s\S]*?\n\);/) || [''])[0];
  check('paths.mjs 的 IMAGE_ROOT 默认值落在用户家目录（且不含盘符字面量）',
    /homedir\(\)/.test(imgRootBlock) && /image-root/.test(imgRootBlock) &&
    !/[A-Za-z]:[\\/]{1,2}/.test(imgRootBlock),
    '写死盘符的话，macOS 上审稿台会一张图都不显示且不报错');
  check('paths.mjs 的旧路径候选只在 Windows 上存在',
    /LEGACY_SRC\s*=\s*process\.platform\s*===\s*['"]win32['"]/.test(pathsCode) &&
    /\.filter\(Boolean\)/.test(pathsCode),
    'LEGACY_SRC 是家目录下的 Downloads —— macOS 上不存在，留着当候选是噪音');

  /* 验收工具 final-verify.mjs 也要能搬到 macOS 上跑 —— 它是手册 D 段的字节级比对工具 */
  const fvSrc = read(process.env.FINAL_VERIFY_MJS || 'tools/final-verify.mjs');
  const fvCode = stripComments(fvSrc);
  check('final-verify.mjs 的工程根/图像根走 paths.mjs（不再写死 E:\\ 和 D:\\）',
    /from\s+['"]\.\/paths\.mjs['"]/.test(fvCode) &&
    !/['"][A-Za-z]:(?:\\{1,2})/.test(fvCode),
    '写死 PROJECT_ROOT 的话，拷到 macOS 上什么都验不出来');
}

/* ────────────────────── 5. 全局：无残留的 Windows 专属调用 ────────────────────── */
console.log('\n5) 全局扫描');
{
  const pyFiles = ['tools/grab/daily_grab_all.py', 'tools/grab/daily_headlines.py', 'tools/grab/clean_images.py'];
  const bad = pyFiles.filter((f) => /\/Users\/test\//.test(stripComments(read(f))));
  check('Python 文件里没有别人机器上的路径（只看代码）', bad.length === 0, bad.join(', '));

  // 关键：.ps1 的反斜杠路径已经由 test-night-flow.mjs 第 7 组盯着，
  // 这里只做一条交叉确认（两边规则不同，避免单点失守）。
  const ps1 = fs.readdirSync(path.join(ROOT, 'tools')).filter((n) => n.endsWith('.ps1') && n !== 'common.ps1');
  const backslash = ps1.filter((f) => {
    const code = stripComments(read(path.join('tools', f)));
    return /['"][^'"]*\\[^'"]*\.(?:ps1|mjs|cmd|py)['"]/.test(code);
  });
  check('没有 .ps1 在代码里用反斜杠拼路径', backslash.length === 0, backslash.join(', '));
}

/* ────────────────────── 结果 ────────────────────── */
console.log('');
console.log(`  ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
