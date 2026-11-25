#!/usr/bin/env node
/**
 * 护栏：2026-11-25 那轮「夜间发布加固」改动的契约
 *
 * 背景（2026-11-25 体检发现的四个问题）
 * ------------------------------------------------
 *   A. **告警链路是断的**
 *      toast 只有「定时任务台」（night-dashboard.mjs）在它自己判定出错时才发，
 *      而任务台是**手动起的 GUI 进程**、没有任何自启动（机器每次重启就没了）
 *      → 夜里发布失败时**一个通知都不会发**。
 *      现在：夜间脚本自己发（失败才发），另外加一个**看门狗**计划任务，
 *      专门覆盖「进程被硬杀」这条**完全静默**的路径（没有 catch、没有 toast、
 *      连结束标记都没写）。
 *
 *   B. **任务超时 72 小时**
 *      `ExecutionTimeLimit = PT72H` + `MultipleInstances = IgnoreNew`
 *      → 一次卡死 = 之后 3 天的触发全被忽略，且既不报错也没告警。
 *      现在收紧到 2 小时。
 *
 *   C. **抓图阶段没有总预算**
 *      抓图耗时随上游剧烈波动（实测 446 / 573 / 675 / 638 / **1701** 秒），
 *      而这台机器每晚 01:12~03:12 自动关机、发布 00:10 起跑
 *      → 上游一慢就可能**跑到一半被关机硬杀**（历史上 11-14/11-15 就是这个形态）。
 *      现在给抓图一个总预算：超了就带着已有素材继续。
 *
 *   D. **pHash 索引每晚全量重扫**
 *      实测 7414 张要 **94~116 秒**，而且随图库线性增长（9 天涨 42%）
 *      → 改成按 (path, mtime, size) 的**持久化增量缓存**。
 *
 *   E. **RSS 源被网络层拦死**
 *      `rss.dw.com` DNS 被污染成 0.0.0.0；`cn.nytimes.com` / `rss.mifaw.com` /
 *      `www.rfi.fr` 全部 TLS 握手失败 → 连续三晚抓不到。
 *      换地址后：V2EX 用**官方** feed（比镜像更稳）、纽约时报中文和法广中文
 *      走 `rsshub.bestblogs.dev` 镜像；**德国之声中文删除**
 *      （DNS 被污染且 RSSHub 无对应中文路由，dw/news 是英文源违反只收中文）。
 *
 * 这些断言盯的是**契约**（行为边界），不是实现细节。
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
 * 剥掉注释再断言。
 *
 * 为什么需要：这些脚本的注释里**故意**写着反面示例
 * （比如「绝不能有 pause」「不能用 一键更新.cmd」）——
 * 不剥注释的话，断言会把自己的说明书当成违规。
 */
function stripComments(src) {
  return src
    .replace(/<#[\s\S]*?#>/g, '')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

/**
 * 抹掉 Python 源码里的**注释和字符串字面量**（保留行数与列宽）。
 *
 * 为什么需要：
 *   ① 注释/docstring 里**故意**写着反面示例 ——
 *      daily_grab_all.py 的 docstring 里就有
 *      「下面这行 `_PHASH_CACHE_DIRTY = True` 会创建函数局部变量」，
 *      不抹掉的话扫描会把**说明文字**当成真赋值。
 *   ② docstring 是三引号字符串，**不是注释** —— 只按 `#` 切会漏掉一大片。
 */
function stripPyNoise(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === '#') {                       // 注释到行尾
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if ((ch === '"' || ch === "'") && src[i + 1] === ch && src[i + 2] === ch) {
      const q = ch.repeat(3);              // 三引号（docstring / 多行字符串）
      i += 3; out += '   ';
      while (i < n) {
        if (src.startsWith(q, i)) { i += 3; out += '   '; break; }
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {        // 单行字符串
      const q = ch;
      i++; out += ' ';
      while (i < n) {
        if (src[i] === '\\') {             // 转义：整体吃掉两个字符
          const c1 = src[i + 1] ?? '';
          out += c1 === '\n' ? ' \n' : '  ';
          i += 2;
          continue;
        }
        if (src[i] === q) { i++; out += ' '; break; }
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * 找出「在函数里给模块级变量赋值、却没写 global 声明」的函数名。
 *
 * Python 里**赋值即声明局部变量** —— 少了 `global` 就会：
 *   · 函数里读它 → UnboundLocalError
 *   · 函数里写它 → 写的是局部副本，模块级那个纹丝不动
 *
 * 实现要点（三个都踩过）：
 *   ① 先抹注释和字符串（docstring 里的反面示例不算赋值）；
 *   ② **按缩进**算「这行属于哪个函数」——
 *      按 `\ndef\s+` 切字符串会把**模块顶层**的赋值也算成「某个函数改了它」→ 误报红；
 *   ③ 模块顶层的赋值**本来就不需要** global，不能算违规。
 *
 * @returns {string[]} 有问题的函数名（空数组 = 没毛病）
 */
function pyMissingGlobal(src, varName) {
  const lines = stripPyNoise(src).split('\n');
  const owner = new Array(lines.length).fill(null);  // null = 模块级
  const stack = [];                                  // { indent, name }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    // 缩进回退 → 之前的块结束（Python 用缩进表达作用域）
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const m = line.match(/^(\s*)def\s+([A-Za-z_]\w*)/);
    if (m && m[1].length === indent) {
      stack.push({ indent, name: m[2] });
      owner[i] = m[2];
      continue;
    }
    owner[i] = stack.length ? stack[stack.length - 1].name : null;
  }

  const assigns = new Set();     // 改了变量的函数
  const declares = new Set();    // 声明了 global 的函数
  const assignRe = new RegExp('^\\s*' + varName + '\\s*(?:[+\\-*/%|&^]|<<|>>)?=(?!=)');
  const globalRe = /^\s*global\s+(.*)$/;

  for (let i = 0; i < lines.length; i++) {
    const fn = owner[i];
    if (!fn) continue;                       // 模块顶层：不需要 global
    const line = lines[i];
    if (assignRe.test(line)) assigns.add(fn);
    const g = line.match(globalRe);
    if (g && g[1].split(',').map((s) => s.trim()).includes(varName)) declares.add(fn);
  }

  return [...assigns].filter((fn) => !declares.has(fn));
}

const night = read(process.env.NIGHT_PS1 || 'tools/night-publish.ps1');
const common = read(process.env.COMMON_PS1 || 'tools/common.ps1');
const watchdog = read(process.env.WATCHDOG_PS1 || 'tools/night-watchdog.ps1');
const watchdogCmd = read(process.env.WATCHDOG_CMD || 'tools/night-watchdog.cmd');
const daily = read(process.env.DAILY_PS1 || 'tools/daily.ps1');
const grabPy = read(process.env.GRAB_PY || 'tools/grab/daily_grab_all.py');
const rssCfg = read(process.env.RSS_CONFIG || 'tools/rss.config.json');
const rotate = read(process.env.ROTATE_MJS || 'tools/rotate-logs.mjs');

const nightCode = stripComments(night);
const commonCode = stripComments(common);
const watchdogCode = stripComments(watchdog);
const dailyCode = stripComments(daily);

console.log('\n1) 告警下沉：夜间脚本失败时自己发 toast（不依赖任务台 GUI 进程）');
{
  check('common.ps1 里有 Send-Alert 这个公共函数',
    /function\s+Send-Alert/.test(commonCode));
  check('Send-Alert 调 notify.ps1（走 Get-ToolPath 拼路径，不写死反斜杠）',
    /Get-ToolPath/.test(commonCode) && /notify\.ps1/.test(commonCode));
  check('Send-Alert 用 Invoke-PsScript 起子进程（PS 5.1 的 stderr 会掀翻调用方）',
    /Invoke-PsScript/.test(commonCode));
  check('Send-Alert 内部吞掉所有异常（通知发不出去不能掀翻主流程）',
    /catch/.test(commonCode) && !/throw/.test(
      (commonCode.match(/function\s+Send-Alert[\s\S]*?\n}/) || [''])[0]));
  check('夜间脚本的失败分支调 Send-Alert',
    /Send-Alert/.test(nightCode));
  check('夜间脚本在失败时才发（成功路径不该发）',
    // ⚠️ 不能只数「Send-Alert 出现几次」—— 那样把**调用**换成别的名字
    //    也会跟着变红（变异 M1），红的就不是「成功路径也发」这条。
    //    要判的是**结构**：Send-Alert 的调用只出现在 catch 块里。
    //
    // ⚠️ 找 catch 块不能取「第一个 catch」—— 脚本开头就有
    //    `try { [Console]::OutputEncoding = ... } catch { }`，
    //    取错块 → 误判成「不在 catch 里」。
    //    办法：找**最后一个** catch（失败分支在脚本末尾附近）。
    (() => {
      const calls = nightCode.match(/Send-Alert\s+-Root/g) || [];
      if (calls.length !== 1) return false;
      // ⚠️ **不能按「第一个/最后一个 catch」找**：
      //    · 第一个 catch 是 `try { OutputEncoding } catch { }`（开头）
      //    · 最后一个 catch 是轮转那个 `try { 轮转 } catch { }`（结尾）
      //    两个都不是失败分支 → 会误判成「不在 catch 里」。
      //    正确做法：找**失败分支那个 catch** —— 它紧跟在
      //    「夜间流程失败：」那句后面。
      const failIdx = nightCode.indexOf('夜间流程失败：');
      if (failIdx < 0) return false;
      const block = nightCode.slice(failIdx, failIdx + 900);
      return /Send-Alert\s+-Root/.test(block);
    })(),
    'Send-Alert 的调用必须且只能在失败分支（catch 块）里');
  check('夜间脚本发告警时带上期号和日志路径（要能直接定位）',
    /\$Date/.test(nightCode) && /\$LogFile/.test(nightCode));
}

console.log('\n2) 看门狗：覆盖「进程被硬杀」这条完全静默的路径');
{
  check('tools/night-watchdog.ps1 存在', watchdog.length > 0);
  check('看门狗按 .done 标记判定「发没发出去」',
    /\.night-publish-.*\.done/.test(watchdog) || /\.done/.test(watchdogCode));
  check('看门狗判「exit 非 0 时不重复告警」（夜间脚本已经发过了）',
    /exit/.test(watchdogCode));
  check('看门狗发告警时用 Send-Alert（同一套通知通道）',
    /Send-Alert/.test(watchdogCode));
  check('看门狗有 Quiet 开关（只判不发，供测试用）',
    /\$Quiet/.test(watchdog));
  check('看门狗读日志用 -Tail（只看尾部，不改 mtime）',
    /-Tail/.test(watchdogCode));
  check('看门狗的 .cmd 是纯 ASCII / LF / 无 BOM',
    (() => {
      if (!watchdogCmd) return false;
      const buf = Buffer.from(watchdogCmd, 'utf8');
      // 纯 ASCII：没有 >= 0x80 的字节
      for (const b of buf) if (b > 127) return false;
      // 无 BOM
      if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return false;
      // 只有 LF，没有 CRLF
      return !buf.includes('\r\n');
    })());
  check('看门狗的 .cmd 里没有交互式等待命令（无人值守会挂死）',
    !/^\s*pause\s*$/im.test(watchdogCmd));
  check('看门狗的 .cmd 把额外参数透传给 ps1',
    /%\*/.test(watchdogCmd));
}

console.log('\n3) 抓图总时间预算（防关机硬杀）');
{
  check('抓图脚本里有总预算的环境变量开关',
    /MEMES_GRAB_BUDGET_SEC/.test(grabPy));
  check('抓图脚本有「预算用尽就跳过这个源」的判据函数',
    /def\s+_grab_budget_exhausted/.test(grabPy));
  check('预算用尽时记一笔警告（不能静默少图）',
    /budget/.test(grabPy) && /warning|log\.warning/i.test(grabPy));
  check('每个源之前都查一次预算',
    // ⚠️ 只数出现次数是不够的 —— 变异测试 M8 把某个源的检查换成 `if True:`，
    // 次数没变（还是 5 次）→ 护栏全绿 → **假的**。
    // 必须逐个点名：TG 三个源 + 喷嚏图卦 + 福利吧 + 煎蛋女装区，
    // 每个都出现在「查预算」的那一行上。
    (() => {
      const need = ['"TG " + ch["label"]', '"喷嚏图卦"', '"福利吧"', '"煎蛋网女装区"'];
      for (const n of need) {
        if (!new RegExp('_grab_budget_exhausted\\(' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(grabPy)) {
          return false;
        }
      }
      return true;
    })(),
    '每个源（TG×3 + 喷嚏图卦 + 福利吧 + 煎蛋女装区）都要有 _grab_budget_exhausted 检查');
  check('夜间流程给抓图设了预算（1500 秒 = 25 分钟）',
    /MEMES_GRAB_BUDGET_SEC\s*=\s*'?1500/.test(nightCode));
  check('daily.ps1 把预算透传给抓图脚本',
    /MEMES_GRAB_BUDGET_SEC/.test(dailyCode));
}

console.log('\n4) pHash 增量缓存（省掉每晚的全量重扫）');
{
  check('抓图脚本有 pHash 缓存的读函数',
    /def\s+_phash_cache_load/.test(grabPy));
  check('抓图脚本有 pHash 缓存的写函数',
    /def\s+_phash_cache_save/.test(grabPy));
  check('缓存键含 mtime 和 size（只按 path 缓存会拿到过期 hash → 误删真图）',
    // ⚠️ 不能只查「代码里出现过 st_mtime_ns 和 st_size」——
    //    变异 M9 把 `cached[1] == key[1]` 删掉后，那两个词还在（只是不参与判断了）
    //    → 只查词 presence 的护栏是**假的**。
    //    必须查**判断式本身**同时用到了两者。
    /cached\[0\]\s*==\s*key\[0\]\s*and\s*cached\[1\]\s*==\s*key\[1\]/.test(grabPy),
    '缓存命中的判断式必须同时比 mtime 和 size');  check('缓存命中时用 hex_to_hash 复用，不重新打开图片',
    /hex_to_hash/.test(grabPy));
  check('缓存写盘是原子的（先写临时文件再改名）',
    // ⚠️ 不能只查「os.replace 出现过」—— 变异 M10 把它换成 shutil.copyfile 后，
    //    os.replace 这个词还在文件里（别处也可能用）→ 假的。
    //    必须查**写盘那一步**真的调了 os.replace。
    /json\.dump\([\s\S]{0,200}os\.replace\(tmp,\s*p\)/.test(grabPy),
    '写盘路径必须是 dump 到 tmp 再 os.replace(tmp, p)');
  check('缓存读不出来时退回全量重算，不抛异常（缓存只是加速器）',
    /except[\s\S]{0,200}return\s+\{\}/.test(grabPy));
  check('新下载的图也登记进缓存（否则缓存永远缺当天的图）',
    // ⚠️ 不能只查「_phash_cache_register 这个函数名出现过」——
    //    变异 M11 把**调用**换成了 pass，函数定义还在 → 假的。
    //    必须查**调用点**存在（且不在函数定义里）。
    /_phash_cache_register\(/.test(grabPy) &&
    (grabPy.match(/_phash_cache_register\(/g) || []).length >= 2,
    '要有定义 + 至少一个调用点');
  check('文件被移动时缓存条目跟着换路径',
    /_phash_cache_move/.test(grabPy));
  const missingGlobal = pyMissingGlobal(grabPy, '_PHASH_CACHE_DIRTY');
  check('改模块级缓存标志的函数都有 global 声明（防 UnboundLocalError）',
    // ⚠️ 这条是**真 bug 的护栏**（2026-11-25 端到端实测踩到）：
    //    Python 里**赋值即声明局部变量** —— 少了 `global` 声明时：
    //      · `main()` 末尾的 `if _PHASH_CACHE_DIRTY:` → UnboundLocalError
    //        （而且是**流程最后一步**崩 → 前面抓的图全白抓）
    //      · `_phash_cache_register()` 里的赋值 → 传不到模块级
    //        → 攒了一晚的缓存永远不落盘 → 新图白算
    //
    // ⚠️ 不能用「按 def 切字符串」那种糙办法（第一版就是这么写的，红了）：
    //    ① 模块顶层的 `_PHASH_CACHE_DIRTY = False`（真正的模块级赋值）
    //       会被算成「某个函数改了它」→ **误报红**；
    //    ② docstring 里写着「下面这行 `_PHASH_CACHE_DIRTY = True`」
    //       —— 那是**说明文字**，不是赋值 → 也误报。
    //    所以要先抹掉注释和字符串，再按缩进算出「这行属于哪个函数」。
    missingGlobal.length === 0,
    '这些函数改了 _PHASH_CACHE_DIRTY 却没写 global：' + missingGlobal.join('、'));
}

console.log('\n5) RSS 源：换掉被网络层拦死的地址');
{
  let cfg = null;
  try { cfg = JSON.parse(rssCfg); } catch { /* 留给下面的断言报错 */ }
  check('rss.config.json 能解析', !!cfg);
  const feeds = (cfg && Array.isArray(cfg.feeds)) ? cfg.feeds : [];
  const byName = (n) => feeds.find((f) => f.name === n);
  const allUrls = feeds.map((f) => f.url).join(' ');

  check('纽约时报中文不再用被 TLS 拦死的直连地址',
    !allUrls.includes('cn.nytimes.com/rss/'));
  check('V2EX 热榜改用官方 feed（官方比 RSS屋镜像更稳）',
    (byName('V2EX 热榜') || {}).url === 'https://www.v2ex.com/feed/tab/hot.xml');
  check('法广中文不再用被 TLS 拦死的直连地址',
    !allUrls.includes('www.rfi.fr/cn/rss'));
  check('被 DNS 污染的德国之声中文已删除',
    !byName('德国之声中文'));
  check('删除的源已在 _doc 里留痕（为什么删、谁接替）',
    /2026-11-25/.test(rssCfg) && /德国之声/.test(rssCfg));
  check('走镜像的源用的是 bestblogs 实例（rsshub.app 公共实例已被风控 403）',
    allUrls.includes('rsshub.bestblogs.dev') && !allUrls.includes('rsshub.app/'));
  check('这轮换掉的源没有借镜像把用户移除过的源混回来',
    // ⚠️ **不能断言「整个源目录里没有这些源」** —— 副本是 899 源的大目录，
    //    里面**本来就有「极客公园」**（BestBlogs 目录扩源的既有内容，不是这轮加的），
    //    拿整个目录去断言会**误报红**。
    //    这条护栏要守的是「**这轮同步/换源**别把用户移除过的源借镜像混回来」→
    //    所以只查**这轮动过的那几个源**的地址。
    (() => {
      const touched = ['纽约时报中文', '法广中文', 'V2EX 热榜', '德国之声中文'];
      const urls = feeds
        .filter((f) => touched.includes(f.name))
        .map((f) => f.url)
        .join(' ');
      return !/ithome\.com|geekpark\.net|solidot\.org|oschina\.net/.test(urls);
    })(),
    '这轮换的地址里不能出现用户移除过的源（ithome / geekpark / solidot / oschina）');
}

console.log('\n6) 日志轮转');
{
  check('tools/rotate-logs.mjs 存在', rotate.length > 0);
  check('轮转是「切历史 + 原地清空」而不是删文件（cmd >> 占着句柄删不掉）',
    /renameSync/.test(rotate) && /writeFileSync/.test(rotate));
  check('轮转保留有限份历史',
    /keep/.test(rotate));
  check('轮转只处理只追加型的日志，不碰每天一份的 .night-publish-<日期>.log',
    !/night-publish-\$/.test(rotate) && /\.night-publish-console\.log/.test(rotate));
  check('轮转支持 dry-run',
    /--dry/.test(rotate));
  check('夜间流程在最后调轮转（成功失败都轮）',
    // ⚠️ 查「rotate-logs.mjs 这个词在不在」不够 ——
    //    变异 M16 把**调用**去掉后这个词还在（在路径拼接那行）→ 护栏假绿。
    //    要查**真的执行了**：必须是 `& $node.Source $rotate` 这种调用形态，
    //    且 $rotate 是用 Get-ToolPath 拼出来的（不是写死路径）。
    /Get-ToolPath[^\n]*rotate-logs\.mjs/.test(nightCode) &&
    /&\s*\$node\.Source\s+\$rotate/.test(nightCode),
    '轮转要真的执行（& $node.Source $rotate，路径用 Get-ToolPath 拼）');
  check('轮转失败不影响发布结果（包在 try 里）',
    /try[\s\S]{0,400}rotate-logs\.mjs[\s\S]{0,200}catch/.test(nightCode));
}

console.log('\n7) 计划任务设置（读实机，不是读源码）');
{
  // ⚠️ 计划任务的设置**不在源码里**（schtasks 的属性），
  //    所以这一组只在能查到实机状态时才断言 —— 查不到就跳过，
  //    不让护栏因为「跑测试的机器没建这个任务」而变红。
  const settings = read(process.env.SCHED_SETTINGS_FILE || '');
  if (settings) {
    check('计划任务 ExecutionTimeLimit 不再是 72 小时',
      !/PT72H/.test(settings), settings.slice(0, 200));
    check('计划任务 MultipleInstances 仍是 IgnoreNew',
      /IgnoreNew/.test(settings));
  } else {
    console.log('  · 跳过（没提供 SCHED_SETTINGS_FILE，护栏不读实机状态）');
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
