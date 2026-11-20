# 定时任务台（夜间发布任务本地 GUI）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在本机 `127.0.0.1:8801` 起一个常驻网页，打开就能看到夜间发布跑到哪一步、有没有问题，并能触发「立即跑一次」和「补发某一天」两个受控的写操作。

**Architecture:** 三层新增件 —— `tools/night-dashboard-state.mjs`（解析层：读磁盘 + 算状态，不碰网络）→ `tools/night-dashboard.mjs`（HTTP 服务，Node 内置 `http`）→ `tools/dashboard-ui/`（原生 JS 页面，零构建）。状态全部从磁盘推导，不调 Cloudflare API。生产链路只改 3 个 helper 的**输出格式**（加时间戳），不改任何逻辑。

**Tech Stack:** Node 22（内置 `http` / `fs` / `child_process`，**零新依赖**）· 原生 JS + CSS · PowerShell 5.1（既有 `.ps1` 链路）· Windows 计划任务

**Spec:** `docs/superpowers/specs/2026-11-20-night-publish-gui-design.md`

---

## Global Constraints

每个 Task 都隐含包含这一节。

### 工作目录与同步

- **实现主战场 = 母本** `E:\voice-pilot\daily-image-site`（真实凭据、真实 project/bucket、真实 `published/`）。
  公开副本 `E:\voice-pilot\daily-image-site-open` 的 `publish.ps1` 里是占位符（`your-project` / `your-bucket`），
  **不能在那里跑发布**。
- **母本已独立成仓**（2026-11-20 起）：`E:\voice-pilot\daily-image-site` 自己就是一个 git 仓库，
  分支 `feat/night-publish-gui`，初始快照提交是 `ca5078f`。
  → **每个 Task 的收尾步骤 = 在母本 `git add` 具体路径 + commit**（评审包靠 `git diff BASE..HEAD` 生成，
  commit 必须落在母本）。
  → **公开副本的同步推迟到 Task 9 一次性做**（Task 1–8 只在母本提交，不碰公开副本）。
- ⚠️ **同步时不能无脑覆盖**：公开副本的 `tools/publish.ps1` 里是**占位符**
  （`your-project` / `your-bucket`），母本里是真项目名（`daily-image-site` / `daily-images`）。
  `Copy-Item` 覆盖 = **把真项目名泄漏进公开仓**。
  → **规则**：*新文件*用 `Copy-Item`；*两仓本来就有差异的既有文件*（`tools/publish.ps1`、
  `AGENTS.md`、`README.md`…）**两边做同样的编辑**，**绝不覆盖文件** ——
  两仓的 `AGENTS.md` 差 4KB、`publish.ps1` 差占位符，覆盖就是毁掉公开副本自己的内容。
- ⚠️ 公开副本工作区里**另有 58 条别的未提交改动**（agent / portal 工作线）。
  **只 `git add` 本 Task 涉及的路径**，绝不 `git add -A`、绝不 `git commit -a`、**不 push**。
  ⚠️ 其中 `tools/publish.ps1` 也被那条工作线改过 —— 同步时**只做单行编辑，绝不覆盖整个文件**。

### 编码约定（逐字节）

| 扩展名 | 编码 | 行尾 |
|---|---|---|
| `.mjs` / `.js` / `.css` / `.html` / `.json` / `.md` | UTF-8 **无 BOM** | LF |
| `.ps1` | UTF-8 **有 BOM** | LF |
| `.cmd` | **纯 ASCII**（任何非 ASCII 字节都不行） | LF，无 BOM |

- 改 `.ps1` 用 `edit` / `write` 时**必须保留 BOM**。用 `edit` 工具改已有 `.ps1` 不会动 BOM；用 `write` 整体重写会丢 → 改完必须用
  `[System.IO.File]::ReadAllBytes($f)` 确认首三字节是 `EF BB BF`。
- 改 `.cmd` 改完必须断言：`每字节 < 128`、首三字节不是 `EF BB BF`、全文没有 `0x0D`。

### 功能约束

- **零新依赖**：不 `npm install` 任何东西，不碰 `package.json`。
- **不许硬编码 `powershell.exe`**：起子进程按平台分支 —— Windows 用 `powershell`（或 `powershell.exe`），
  macOS 用 `pwsh`（工程正明确迁 macOS，母本要装 pwsh 跑同一份 `.ps1`）。
  同仓既有惯例见 `tools/test-daily-review.mjs` 与 `tools/test-daily-rank-step.mjs` 的
  `IS_WIN ? 'powershell' : 'pwsh'`；`tools/test-portability.mjs` 把这条列为五类陷阱之一。
  护栏自己起 PowerShell 也不例外 —— 写死会让整块断言在 macOS 上变红。
- 服务**只绑 `127.0.0.1`**，端口 8801；占用则顺延到 8810；实际端口写 `.night-dashboard-port`。
- **Origin 白名单用动态端口**（服务实际监听的 `chosenPort`），**不许写死 8801**。
- 路径一律 `path.join` + 正斜杠（macOS 迁移）。
- **不改** `night-publish.ps1` / `publish.ps1` / `manual-publish.ps1` 的**逻辑**。
  只改 `daily.ps1` / `daily-review.ps1` / `publish.ps1` 三个 helper 的**输出格式**。
- `board.ps1` / `gate.ps1` / `setup-cloudflare.ps1` 也有同名 helper，**不在夜间链路上，不动**。

### 护栏纪律

- 输出格式：`<N> 通过 / <M> 失败`；有失败 → `process.exit(1)`。
- **锚点自检**：定位源码前先确认锚点唯一存在（命中 0 次或 >1 次都要在护栏里直接报出来）。
- **匹配源码前先剥注释**：逐行 `#` 注释 + `<# ... #>` 块注释都要剥掉再匹配（工程里已有 `tools/strip-comments.mjs`）。
- **期望红 + 期望绿双向声明**：变异套件里每条变异都要写明「应该红的断言」和「应该仍然绿的断言」。
- **统计按本次运行切分**：不要把上一轮的数字算进来。
- **干净地红，不是崩着红**：护栏的失败必须是**断言变红**（`✗ <label>`），不能是**整个套件抛异常崩掉**。
  崩掉的套件一条 `✗ <label>` 都不会有 → Task 8 按标签 grep 会误判成「没抓到」（假阴性）。
  → **写断言时不要直接下标**：`steps[0].key` 在 `steps` 变短时会抛 TypeError，
  要写成 `steps.length === 2 && steps[0].key === ...`。
  → **detail 对象是无条件求值的**：`{ a: cross[0].atMs }` 即使条件为假也会抛，
  下标取值要先落到安全变量上。
- **缺失时不能意外成立**：`indexOf` 找不到返回 `-1`，所以 `-1 < 3` 是**真** →
  「`===` 标记还在不在」这类断言必须先判 `indexOf(...) !== -1`。
  同理 `!/Get-Date/.test('')` 在 body 为空串时**恒真** → 条件里要带 `body !== ''`。

### 不可逆动作

- **发布是不可逆对外动作** → 实跑「立即跑一次」「补发」之前**必须先跟用户确认**（问用户，别自己决定）。
- 允许自由跑的：**只部署验证**（`-SkipBuild -SkipUpload -SkipDeploy` 等全跳过的组合）。

### 复用的既有资产（不要重造）

| 资产 | 位置 | 提供什么 |
|---|---|---|
| `tools/publish-state.mjs` | 已有 | `computePublishState` / `describeDeadState` / `PUBLISH_STALE_MS`(6分) / `PUBLISH_TIMEOUT_MS`(45分) / `PUBLISH_TOUCH_MS`(2分) |
| `tools/paths.mjs` | 已有 | `ROOT` / `IMAGE_ROOT` / `SRC_LOCAL` / `srcSearchRoots()` / `findDatedDir()` |
| `tools/review.mjs` | 已有（**只读参考，不改**） | `sendJson()` 的写法、端口顺延的写法、`freshEnv()` 的写法、`cmd /c start /b powershell` 的 spawn 写法、Origin 校验的写法 |

---

## 文件结构

**母本 `E:\voice-pilot\daily-image-site`：**

| 文件 | 动作 | 职责 |
|---|---|---|
| `tools/daily.ps1` | 改 `:76` | `Step` helper 加时间戳 |
| `tools/daily-review.ps1` | 改 `:98` | `Rule` helper 加时间戳 |
| `tools/publish.ps1` | 改 `:51` | `Step` helper 加时间戳 |
| `tools/night-dashboard-state.mjs` | 新建 | 解析层：读 `.done`/`.log`、剥 BOM、解析 15 节点、算状态与问题 |
| `tools/night-dashboard.mjs` | 新建 | HTTP 服务：静态托管 + 4 个 API + 写操作 |
| `tools/dashboard-ui/index.html` | 新建 | 页面骨架 |
| `tools/dashboard-ui/app.css` | 新建 | 素白文档风样式 + 暗色模式 |
| `tools/dashboard-ui/app.js` | 新建 | 轮询、渲染、两个确认条、浏览器通知 |
| `tools/start-dashboard.mjs` | 新建 | 启动器（explorer.exe 脱 Job / macOS 直起） |
| `起任务台.cmd` | 新建 | 根目录双击入口（纯 ASCII） |
| `tools/notify.ps1` | 新建 | Windows toast（服务端用） |
| `tools/test-night-dashboard.mjs` | 新建 | 护栏（逐 Task 追加断言） |
| `tools/test-night-dashboard-mutate.mjs` | 新建 | 变异护栏 |
| `.gitignore` | 改 | 加 `.night-dashboard-port` |
| `AGENTS.md` | 改 | 命令表 + 护栏表 |
| `CHECKPOINT.md` | 改 | 现状账本 |

**公开副本 `E:\voice-pilot\daily-image-site-open`：** 在 **Task 9 Step 6** 一次性同步上面除 `CHECKPOINT.md` 以外的全部；
`CHECKPOINT.md` 的对应物是 `CHANGELOG.md`（脱敏版）；另改 `AGENTS.md` / `README.md`。
Task 1–8 全程**只在母本提交**，不碰公开副本。

---

## Task 1: 三个 helper 加时间戳

**Files:**
- Modify: `tools/daily.ps1:76`
- Modify: `tools/daily-review.ps1:98`
- Modify: `tools/publish.ps1:51`
- Create: `tools/test-night-dashboard.mjs`（本 Task 只放骨架 + 3 条断言）

**Interfaces:**
- Consumes: 无（第一个 Task）
- Produces: 日志里的阶段标记行变成 `=== <msg> ===  [HH:mm:ss]`。
  Task 2 的解析器按这个格式写正则（同时兼容没有时间戳的老格式）。

- [ ] **Step 1: 建护栏骨架 + 3 条断言**

创建 `tools/test-night-dashboard.mjs`：

```js
#!/usr/bin/env node
/**
 * 定时任务台的护栏。
 *
 * 覆盖：三个 helper 的时间戳格式 · 解析层 · 状态与问题判定 · HTTP 层 · 启动器约定。
 *
 * 纪律：输出「N 通过 / M 失败」，有失败 exit 1（能被 tools/run-all-tests.mjs 收编）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** 取出 helper 的函数体（单行、无嵌套花括号）。返回空串 = 锚点没命中。 */
function helperBody(src, fn) {
  const m = new RegExp('function\\s+' + fn + '\\s*\\([^)]*\\)\\s*\\{([^}]*)\\}').exec(src);
  return m ? m[1] : '';
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
    check(`${file} 的 ${fn} 没用 Get-Date（时区会错位）`, !/Get-Date/.test(body), { body });
    check(`${file} 的 ${fn} 写了 HH:mm:ss 时间戳`, /ToString\('HH:mm:ss'\)/.test(body), { body });
  }
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: 跑测试，确认它红**

Run: `node tools\test-night-dashboard.mjs`
Expected: FAIL —— 12 条断言里，`Get-BjNow` / `HH:mm:ss` 那几条红的（helper 还是老格式，没有时间戳）。

- [ ] **Step 3: 改三个 helper**

`tools/daily.ps1` 的 `Step`（第 76 行）、`tools/publish.ps1` 的 `Step`（第 51 行）、`tools/daily-review.ps1` 的 `Rule`（第 98 行），
三处都改成下面这行（只是函数名不同）：

```powershell
function Step($msg) { Write-Host ("`n=== $msg ===  [" + (Get-BjNow).ToString('HH:mm:ss') + "]") -ForegroundColor Cyan }
```

`tools/daily-review.ps1` 那处：

```powershell
function Rule($t)  { Write-Host ("`n=== $t ===  [" + (Get-BjNow).ToString('HH:mm:ss') + "]") -ForegroundColor Cyan }
```

⚠️ 三个脚本都已经 dot-source `common.ps1`（`daily.ps1:74` / `daily-review.ps1:77` / `publish.ps1:49`），
`Get-BjNow` 直接可用，**不要**在这里改用 `Get-Date`。

改完立刻确认 BOM 还在：

```powershell
foreach ($f in 'tools\daily.ps1','tools\daily-review.ps1','tools\publish.ps1') {
  $b = [System.IO.File]::ReadAllBytes("E:\voice-pilot\daily-image-site\$f")
  $bom = ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
  $cr = ($b | Where-Object { $_ -eq 13 }).Count
  Write-Output "$f  BOM=$bom  CR=$cr"
}
```
Expected: 三行都是 `BOM=True  CR=0`。

- [ ] **Step 4: 跑测试，确认它绿**

Run: `node tools\test-night-dashboard.mjs`
Expected: PASS —— `12 通过 / 0 失败`。

- [ ] **Step 5: 实跑验证（不部署、不碰线上）**

`publish.ps1` 用 `Write-Host` 输出，**不进 stdout** → 必须用 `cmd` 的重定向把控制台输出落盘：

```powershell
Set-Location 'E:\voice-pilot\daily-image-site'
cmd /c "powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish.ps1 -Date 2026-11-20 -SkipBuild -SkipUpload -SkipDeploy -SkipReview -NoConvert -NoHeadlines > .tmp-ts-verify.log 2>&1"
Select-String -Path '.tmp-ts-verify.log' -Pattern '===.*===\s+\[\d{2}:\d{2}:\d{2}\]'
```

Expected: 至少 4 行，形如 `=== 6/6 跳过 Pages 部署 ===  [09:2x:xx]`。
如果**一行都没有** → 时间戳没生效，回 Step 3。

- [ ] **Step 6: 跑全量护栏（母本）**

Run: `node tools\run-all-tests.mjs`
Expected: 结尾 `总计 35 套件：35 绿 / 0 红 / 0 崩 / 0 跳过`。
（`tools/test-*.mjs` 共 46 个文件 = 35 个常规 + 11 个 `-mutate`；跑批器**默认排除** `-mutate`，
所以常规批次是 35 套。想连变异一起跑用 `node tools\run-all-tests.mjs --mutate` → 46 套。）
`test-webp.mjs` 要跑 15 分钟左右。

- [ ] **Step 7: 提交（母本）**

```powershell
Set-Location 'E:\voice-pilot\daily-image-site'
git add -- 'tools/daily.ps1' 'tools/daily-review.ps1' 'tools/publish.ps1' 'tools/test-night-dashboard.mjs'
git commit -m "feat: 三个 helper 的阶段标记加时间戳（定时任务台第一步）"
```
Expected: 提交里**只有这 4 个文件**。公开副本的同步在 Task 9 一次性做，这一轮**不碰公开副本**。
⚠️ 三个 `.ps1` 改完必须再查一次 BOM 和 CR：`BOM=True  CR=0`。

---

## Task 2: 解析层 `tools/night-dashboard-state.mjs`

**Files:**
- Create: `tools/night-dashboard-state.mjs`
- Modify: `tools/test-night-dashboard.mjs`（追加第 2 组断言）

**Interfaces:**
- Consumes: Task 1 的日志格式 `=== <msg> ===  [HH:mm:ss]`（同时兼容无时间戳的老格式）
- Produces（本 Task 导出，Task 3 / 4 依赖）：

```js
export const DONE_MARKERS;   // { night: RegExp, manual: RegExp, review: RegExp }
export const CANONICAL_STEPS; // 15 个节点的标准长相（按日志顺序）
export function stripBom(text)                  // → string
export function parseDone(raw)                  // → { date, at, exit, by } | null
export function parseSteps(text, baseDate)      // → [{ key, label, group, num, den, clock, atMs }]
export function parseLog(text, baseDate, endMs) // → { source, exitCode, steps }
export function median(nums)                    // → number | null
```

- [ ] **Step 1: 追加会失败的断言**

⚠️ 连接断言要用 `spawnSync` 真跑一次 PowerShell，**先在护栏骨架的 import 区加上**：

```js
import { spawnSync } from 'node:child_process';
```

在 `tools/test-night-dashboard.mjs` 里，把结尾的

```js
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
```

换成：

```js
/* ── 2. 解析层 ─────────────────────────────────────────── */
import * as ST from './night-dashboard-state.mjs';

{
  /* …解析层断言，见实现… */
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
```

> **本 Task 的断言组已在实施中落地 —— 实际代码见母本 `tools/test-night-dashboard.mjs`**，
> 不要照抄本计划里的样例（样例已被后续修复淘汰，照抄会把已修掉的 bug 抄回来）。
> 实施中确立的写法，**Task 3 起在同一个文件追加断言时必须沿用**：
>
> 1. **每条断言自带前置条件**，不要用 `if` 把断言圈起来跳过 ——
>    前置不满足时要**报红**，不是不执行（否则 Task 8 按标签 grep 会误判成「没抓到」）。
> 2. **detail 里的取值先落到安全变量** —— `{ a: cross[0].atMs }` 是无条件求值的，
>    条件为假也会抛。
> 3. **不直接下标** —— `steps[0].key` 在 `steps` 变短时抛 TypeError，
>    要写成 `steps.length === 2 && steps[0].key === ...`。
> 4. **`indexOf` 找不到返回 `-1`** —— `-1 < 3` 是**真**，
>    「`===` 标记还在不在」这类断言要先判 `indexOf(...) !== -1`。
> 5. **不硬编码 `powershell.exe`** —— 按平台分支（`process.platform === 'win32' ?
>    'powershell' : 'pwsh'`），macOS 上没有 `powershell.exe`。
> 6. **匹配源码前先剥注释** —— 工程里有 `tools/strip-comments.mjs`，
>    断言锚点唯一性也要报命中数（0 次或 >1 次都要红）。

- [ ] **Step 2: 跑测试，确认它红**

Run: `node tools\test-night-dashboard.mjs`
Expected: FAIL —— `ERR_MODULE_NOT_FOUND`（`night-dashboard-state.mjs` 还不存在）。
这一步的「红」是**崩**，跑批器会报「崩」不是「红」—— 这正是我们分开的意义。

- [ ] **Step 3: 写实现**

创建 `tools/night-dashboard-state.mjs`：

```js
#!/usr/bin/env node
/**
 * 定时任务台的解析层：把磁盘上的日志/标记变成结构化状态。
 *
 * 边界：这一层**只读文件 + 只算状态**，不碰网络、不 spawn 任何东西。
 * 状态全部从磁盘推导 —— 不调 Cloudflare API（不花 token、不触发限流，
 * 线上挂了也不影响你看历史）。
 *
 * 时间戳格式（2026-11-20 起，Task 1 改的三个 helper 产出）：
 *   === 1/6 刷新 Cloudflare token ===  [00:12:03]
 * 老日志没有方括号里的时间戳 —— 照样解析，只是阶段耗时显示不出来。
 */
import fs from 'node:fs';
import path from 'node:path';

/* ── 常量 ───────────────────────────────────────────────── */

/** 三个来源的结束标记。night / manual / review 各用各的，别混。 */
export const DONE_MARKERS = {
  night: /=== NIGHT_DONE exit=(-?\d+) ===/,
  manual: /=== MANUAL_DONE exit=(-?\d+) ===/,
  review: /=== PUBLISH_DONE exit=(-?\d+) ===/,
};

/**
 * 阶段标记行。
 * ① 编号 N/M  ② 文案  ③ 可选的 [HH:mm:ss]
 */
const STEP_RE = /^===\s+(\d+)\/(\d+)\s+(.+?)\s+===\s*(?:\[(\d{2}:\d{2}:\d{2})\])?\s*$/;

/** 界面上的三个组 */
export const GROUPS = [
  { key: 'prepare', label: '准备' },
  { key: 'verify', label: '校验与审稿' },
  { key: 'publish', label: '发布' },
];

/**
 * 15 个节点的「标准长相」，按日志里出现的顺序。
 *
 * 为什么要有这张表：日志只写**实际走过**的步骤（跳过的分支不写），
 * 界面却要一直显示 15 个位置。所以用这张表当骨架，
 * 再用日志里观察到的步骤覆盖 key 对应的那一格（文案以日志实际出现的为准）。
 */
export const CANONICAL_STEPS = [
  { key: 'prepare/1-3', label: '每日准备（抓图 → 头条 → 清洗 → 榜单/追更 → 构建）' },
  { key: 'prepare/0-5', label: '准备环境' },
  { key: 'prepare/1-5', label: '抓图 + 目录分流' },
  { key: 'prepare/2-5', label: '抓头条（见报的分类目录）' },
  { key: 'prepare/3-5', label: '清洗图片（剔广告 / 剔废图 / 剔重复）' },
  { key: 'prepare/4-5', label: '抓榜单 + 追更' },
  { key: 'prepare/5-5', label: '构建（本地，不上传）' },
  { key: 'verify/2-3', label: '校验构建产物' },
  { key: 'verify/3-3', label: '跳过审稿台（-SkipReview）' },
  { key: 'publish/1-6', label: '刷新 Cloudflare token' },
  { key: 'publish/2-6', label: '构建页面与图片' },
  { key: 'publish/3-6', label: '探测 R2 状态' },
  { key: 'publish/4-6', label: '跳过审稿闸门' },
  { key: 'publish/5-6', label: '上传图片到 R2' },
  { key: 'publish/6-6', label: '部署 Cloudflare Pages' },
];

/** 编号 → 组。1/3 是「每日准备」的开头，2/3、3/3 已经是后面两步了。 */
function groupOf(num, den) {
  if (den === 6) return 'publish';
  if (den === 5) return 'prepare';
  if (den === 3) return num === 1 ? 'prepare' : 'verify';
  return 'prepare';
}

/** 'HH:mm:ss' → 当天零点起的毫秒数 */
function clockToMs(clock) {
  const m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(String(clock || ''));
  if (!m) return NaN;
  return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000;
}

/* ── 纯函数 ─────────────────────────────────────────────── */

/**
 * 剥掉 UTF-8 BOM。
 * PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，
 * 而 `JSON.parse('\uFEFF{...}')` 直接抛 —— 不剥就整个页面挂掉。
 */
export function stripBom(text) {
  const s = typeof text === 'string' ? text : '';
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

/**
 * 解析 `.night-publish-<日期>.done`。
 * **JSON 坏了返回 null，不抛** —— 一个坏标记不该让整个页面挂掉。
 */
export function parseDone(raw) {
  const text = stripBom(raw);
  if (!text.trim()) return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  return {
    date: typeof obj.date === 'string' ? obj.date : null,
    at: typeof obj.at === 'string' ? obj.at : null,
    exit: Number.isFinite(obj.exit) ? obj.exit : null,
    by: typeof obj.by === 'string' ? obj.by : null,
  };
}

/**
 * 解析日志里的阶段标记。
 *
 * baseDate: 'YYYY-MM-DD'（这份日志属于哪天）—— 时间戳只有 HH:mm:ss，
 * 得靠 baseDate 拼成绝对时刻。**跨零点**：算出来比上一步还早就 +1 天
 * （手动跑可能在 23:50 起、跨过零点）。
 */
export function parseSteps(text, baseDate) {
  const raw = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = STEP_RE.exec(line.trim());
    if (!m) continue;
    raw.push({
      num: Number(m[1]),
      den: Number(m[2]),
      label: m[3],
      clock: m[4] || null,
    });
  }

  const base = baseDate ? Date.parse(baseDate + 'T00:00:00+08:00') : NaN;
  let prevMs = NaN;
  const steps = [];
  for (const r of raw) {
    let atMs = null;
    if (r.clock && Number.isFinite(base)) {
      atMs = base + clockToMs(r.clock);
      if (Number.isFinite(prevMs) && atMs < prevMs) atMs += 24 * 60 * 60 * 1000;
    }
    const group = groupOf(r.num, r.den);
    steps.push({
      key: group + '/' + r.num + '-' + r.den,
      label: r.label,
      group,
      num: r.num,
      den: r.den,
      clock: r.clock,
      atMs,
    });
    if (Number.isFinite(atMs)) prevMs = atMs;
  }
  return steps;
}

/**
 * 解析整份日志：阶段 + 结束标记。
 * endMs：这次运行的结束时刻（没有就传 null，阶段耗时只能算到下一步）。
 */
export function parseLog(text, baseDate, endMs) {
  const steps = parseSteps(text, baseDate);
  const lines = String(text || '').split(/\r?\n/);

  let source = null;
  let exitCode = null;
  for (const line of lines) {
    for (const [key, re] of Object.entries(DONE_MARKERS)) {
      const m = re.exec(line);
      if (m) {
        source = key;
        exitCode = Number(m[1]);
      }
    }
  }

  for (let i = 0; i < steps.length; i++) {
    const next = steps[i + 1];
    const to = next && Number.isFinite(next.atMs)
      ? next.atMs
      : (Number.isFinite(endMs) ? endMs : null);
    steps[i].durationMs = (Number.isFinite(steps[i].atMs) && to !== null)
      ? Math.max(0, to - steps[i].atMs)
      : null;
  }

  return { source, exitCode, steps };
}

/** 中位数。空数组 → null。偶数个取平均后四舍五入。 */
export function median(nums) {
  const a = (nums || []).filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
}
```

- [ ] **Step 4: 跑测试，确认它绿**

Run: `node tools\test-night-dashboard.mjs`
Expected: PASS —— `50 通过 / 0 失败`（41 条原断言 + 9 条连接断言）。

- [ ] **Step 5: 确认编码**

```powershell
$b = [System.IO.File]::ReadAllBytes('E:\voice-pilot\daily-image-site\tools\night-dashboard-state.mjs')
Write-Output ("BOM=" + ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) + "  CR=" + ($b | Where-Object { $_ -eq 13 }).Count)
```
Expected: `BOM=False  CR=0`。

- [ ] **Step 6: 提交（母本）**

```powershell
Set-Location 'E:\voice-pilot\daily-image-site'
git add -- 'tools/night-dashboard-state.mjs' 'tools/test-night-dashboard.mjs'
git commit -m "feat: 定时任务台解析层（剥 BOM / 解析 15 节点 / 阶段耗时）"
```
公开副本的同步在 Task 9 一次性做，这一轮**不碰公开副本**。

---

## Task 3: 状态判定 + 问题判定

**Files:**
- Modify: `tools/night-dashboard-state.mjs`（追加）
- Modify: `tools/test-night-dashboard.mjs`（追加第 3 组断言）

**Interfaces:**
- Consumes: Task 2 的 `parseDone` / `parseLog` / `median` / `CANONICAL_STEPS`
- Produces:

```js
export function mergeSteps(observed)          // → 15 个节点的完整数组（没走到的置 pending）
export function buildCurrent(input)           // → current 对象（见下）
export function buildHistory(entries)         // → history 数组
export function stepMedians(history)           // → Map<key, number>
export function pickProblem(current, history) // → problem | null
```

`buildCurrent(input)` 的 `input`：
```js
{ date, done, logText, logMtime, now }   // done = parseDone 的结果 | null；logMtime = 日志 mtime（ms）
```
`current` 的形状（跟 spec §7.1 一致）：
```js
{
  date, source, status, headline, startedAt, finishedAt, durationMs, exitCode,
  steps: [ 15 个 ], problem
}
```

- [ ] **Step 1: 追加会失败的断言**

在 `tools/test-night-dashboard.mjs` 的 `console.log(...)` 之前插入：

```js
/* ── 3. 状态与问题判定 ─────────────────────────────────── */
{
  const doneOk = { date: '2026-11-20', at: '2026-11-20T00:41:39+08:00', exit: 0, by: null };
  const log = [
    '=== 1/6 刷新 Cloudflare token ===  [00:10:10]',
    '=== 2/6 构建页面与图片 ===  [00:12:20]',
    '=== 6/6 部署 Cloudflare Pages（项目 daily-image-site） ===  [00:40:00]',
    '=== NIGHT_DONE exit=0 ===',
  ].join('\n');

  const cur = ST.buildCurrent({
    date: '2026-11-20', done: doneOk, logText: log,
    logMtime: Date.parse('2026-11-20T00:41:39+08:00'),
    now: Date.parse('2026-11-20T00:42:00+08:00'),
  });
  check('成功的夜 status = success', cur.status === 'success', { status: cur.status });
  check('来源认得出来', cur.source === 'night', { source: cur.source });
  check('总耗时 = 结束 − 开始', cur.durationMs === 31 * 60 * 1000 + 37 * 1000, { durationMs: cur.durationMs });
  check('退出码取得到', cur.exitCode === 0);
  check('步骤恒为 15 个', cur.steps.length === 15, { n: cur.steps.length });
  check('没走到的步骤是 pending', cur.steps.find((s) => s.key === 'publish/5-6').status === 'pending');
  check('走到的步骤是 done', cur.steps.find((s) => s.key === 'publish/1-6').status === 'done');
  check('文案以日志实际出现的为准',
    cur.steps.find((s) => s.key === 'publish/6-6').label.indexOf('项目 daily-image-site') >= 0);

  /* 失败夜 */
  const failed = ST.buildCurrent({
    date: '2026-11-19', done: { date: '2026-11-19', at: '2026-11-19T00:30:00+08:00', exit: 1, by: null },
    logText: '=== 5/6 上传图片到 R2 ===  [00:28:00]\n=== NIGHT_DONE exit=1 ===',
    logMtime: Date.parse('2026-11-19T00:30:00+08:00'),
    now: Date.parse('2026-11-19T00:31:00+08:00'),
  });
  check('失败的夜 status = failed', failed.status === 'failed');
  check('失败的那一步标 failed',
    failed.steps.find((s) => s.key === 'publish/5-6').status === 'failed');
  check('失败夜出 error 级问题', failed.problem && failed.problem.level === 'error', { problem: failed.problem });

  /* 没跑 */
  const notRun = ST.buildCurrent({
    date: '2026-11-21', done: null, logText: '', logMtime: 0,
    now: Date.parse('2026-11-21T09:00:00+08:00'),
  });
  check('没日志 → not-run', notRun.status === 'not-run');
  check('没跑出一条 info', notRun.problem && notRun.problem.level === 'info');

  /* 死了：日志停摆 10 分钟还没结束标记 */
  const dead = ST.buildCurrent({
    date: '2026-11-18', done: null,
    logText: '=== 6/6 部署 Cloudflare Pages ===  [00:30:00]',
    logMtime: Date.parse('2026-11-18T00:30:00+08:00'),
    now: Date.parse('2026-11-18T00:40:00+08:00'),
  });
  check('日志停摆 10 分钟 → dead', dead.status === 'dead', { status: dead.status });
  check('dead 出 error 级问题', dead.problem && dead.problem.level === 'error');

  /* 中位数只用成功的夜 */
  const history = [
    { date: '2026-11-16', status: 'success', durationMs: 15 * 60 * 1000, steps: [] },
    { date: '2026-11-17', status: 'success', durationMs: 16 * 60 * 1000, steps: [] },
    { date: '2026-11-18', status: 'success', durationMs: 14 * 60 * 1000, steps: [] },
    { date: '2026-11-19', status: 'failed', durationMs: 40 * 60 * 1000, steps: [] },
  ];
  const med = ST.stepMedians(history);
  check('中位数只用成功的夜（15 分，不是 22 分）',
    ST.median(history.filter((h) => h.status === 'success').map((h) => h.durationMs)) === 15 * 60 * 1000);

  /* 慢夜 → warn */
  const slow = ST.buildCurrent({
    date: '2026-11-20', done: { date: '2026-11-20', at: '2026-11-20T00:41:39+08:00', exit: 0, by: null },
    logText: '=== 1/6 刷新 Cloudflare token ===  [00:10:02]\n=== NIGHT_DONE exit=0 ===',
    logMtime: Date.parse('2026-11-20T00:41:39+08:00'),
    now: Date.parse('2026-11-20T00:42:00+08:00'),
  });
  const p = ST.pickProblem(slow, history);
  check('31 分 vs 中位数 15 分 → warn 级', p && p.level === 'warn', { problem: p });
  check('warn 文案里带平时多久',
    p && p.detail.indexOf('15') >= 0, { detail: p && p.detail });
}
```

- [ ] **Step 2: 跑测试，确认它红**

Run: `node tools\test-night-dashboard.mjs`
Expected: FAIL —— `ST.buildCurrent is not a function`。

- [ ] **Step 3: 写实现**

在 `tools/night-dashboard-state.mjs` 末尾追加：

```js
/* ── 状态与问题 ─────────────────────────────────────────── */

/**
 * 把「日志里观察到的步骤」和「15 个节点的标准骨架」合成一份完整数组。
 * 没走到的节点 = pending（灰）；文案以日志实际出现的为准（跳过变体如实呈现）。
 */
export function mergeSteps(observed) {
  const byKey = new Map((observed || []).map((s) => [s.key, s]));
  return CANONICAL_STEPS.map((c) => {
    const o = byKey.get(c.key);
    if (!o) {
      return {
        key: c.key, label: c.label, group: c.key.split('/')[0],
        status: 'pending', observed: false, clock: null, atMs: null, durationMs: null,
      };
    }
    return {
      key: c.key, label: o.label, group: o.group,
      status: o.status || 'done', observed: true,
      clock: o.clock, atMs: o.atMs, durationMs: o.durationMs ?? null,
    };
  });
}

/** 毫秒 → 「31 分 36 秒」 */
export function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return h + ' 时 ' + m + ' 分';
  if (m) return m + ' 分 ' + s + ' 秒';
  return s + ' 秒';
}

/**
 * 算某一天这一期的状态。
 *
 * input: { date, done, logText, logMtime, now }
 *   done     = parseDone() 的结果 | null
 *   logText  = 日志全文（读不到给空串）
 *   logMtime = 日志文件的 mtime（ms）；0 = 没有日志
 */
export function buildCurrent(input) {
  const { date, done, logText, logMtime, now = Date.now() } = input || {};
  const finishedAtMs = done && done.at ? Date.parse(done.at) : NaN;
  const endMs = Number.isFinite(finishedAtMs) ? finishedAtMs : now;

  const parsed = parseLog(logText || '', date, endMs);
  const doneFound = parsed.source !== null;

  const firstAt = parsed.steps.length ? parsed.steps[0].atMs : null;
  const startedAtMs = Number.isFinite(firstAt) ? firstAt : NaN;

  /* 「死没死 / 超时没超时」直接复用既有纯函数，不重造。 */
  const ps = computePublishState({
    done: doneFound,
    doneExitCode: parsed.exitCode,
    mtime: logMtime || 0,
    startedAt: Number.isFinite(startedAtMs) ? startedAtMs : null,
    running: false,
    now,
  });

  let status;
  if (doneFound) status = parsed.exitCode === 0 ? 'success' : 'failed';
  else if (!logText) status = 'not-run';
  else if (ps.dead) status = 'dead';
  else status = 'running';

  const steps = parsed.steps.map((s, i) => ({
    ...s,
    status: status === 'failed' && i === parsed.steps.length - 1
      ? 'failed'
      : (status === 'running' && i === parsed.steps.length - 1 ? 'running' : 'done'),
  }));
  const merged = mergeSteps(steps);

  const durationMs = Number.isFinite(finishedAtMs) && Number.isFinite(startedAtMs)
    ? Math.max(0, finishedAtMs - startedAtMs)
    : null;

  let headline;
  if (status === 'success') headline = '成功 · ' + fmtDuration(durationMs);
  else if (status === 'failed') headline = '失败 · 退出码 ' + parsed.exitCode;
  else if (status === 'running') headline = '正在跑 · ' + fmtDuration(now - (startedAtMs || now));
  else if (status === 'dead') headline = '卡住了';
  else if (status === 'not-run') headline = '还没跑';
  else headline = '状态未知';

  const current = {
    date: date || null,
    source: parsed.source,
    status,
    headline,
    startedAt: Number.isFinite(startedAtMs) ? new Date(startedAtMs).toISOString() : null,
    finishedAt: Number.isFinite(finishedAtMs) ? new Date(finishedAtMs).toISOString() : null,
    durationMs,
    exitCode: parsed.exitCode,
    steps: merged,
    problem: null,
    deadReason: status === 'dead' ? describeDeadState(ps) : '',
  };
  current.problem = pickProblem(current, []);
  return current;
}

/** 历史流水：按日期倒序。 */
export function buildHistory(entries) {
  return (entries || [])
    .filter((e) => e && e.date)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/**
 * 每个阶段的历史耗时中位数。
 * **只用成功的夜** —— 失败夜往往卡在某一步，会把中位数拉歪。
 */
export function stepMedians(history) {
  const acc = new Map();
  for (const h of history || []) {
    if (!h || h.status !== 'success') continue;
    for (const s of h.steps || []) {
      if (!Number.isFinite(s.durationMs)) continue;
      if (!acc.has(s.key)) acc.set(s.key, []);
      acc.get(s.key).push(s.durationMs);
    }
  }
  const out = new Map();
  for (const [k, v] of acc) out.set(k, median(v));
  return out;
}

/**
 * 挑出最该让人看到的那一条问题（只出一条，按严重度排序）。
 * current / history 见 buildCurrent / buildHistory。
 */
export function pickProblem(current, history) {
  if (!current) return null;
  const okNights = (history || []).filter((h) => h && h.status === 'success' && Number.isFinite(h.durationMs));
  const med = median(okNights.map((h) => h.durationMs));

  if (current.status === 'failed') {
    const step = (current.steps || []).find((s) => s.status === 'failed');
    return {
      level: 'error',
      title: (current.date || '') + ' 失败了',
      detail: step
        ? ('停在「' + step.label + '」，退出码 ' + current.exitCode)
        : ('退出码 ' + current.exitCode),
      stepKey: step ? step.key : null,
    };
  }
  if (current.status === 'dead') {
    return {
      level: 'error',
      title: current.deadReason || '发布进程已经不在了',
      detail: '日志 6 分钟没有更新，但一直没写结束标记。',
      stepKey: null,
    };
  }
  if (current.status === 'not-run') {
    return { level: 'info', title: '今天凌晨还没跑', detail: '计划任务应该在 00:10 启动。', stepKey: null };
  }
  if (current.status === 'success' && med && current.durationMs > med * 2) {
    return {
      level: 'warn',
      title: '这次花了 ' + fmtDuration(current.durationMs) + '，平时 ' + fmtDuration(med),
      detail: '比平时的中位数慢了一倍不止，值得看看是哪一段。',
      stepKey: null,
    };
  }
  return null;
}
```

⚠️ 上面用了 `computePublishState` 和 `describeDeadState` —— 文件顶部要加 import：

```js
import { computePublishState, describeDeadState } from './publish-state.mjs';
```

（`tools/publish-state.mjs` 是**零 I/O 的纯函数模块**，直接 import 即可，不需要改它。）

- [ ] **Step 4: 跑测试，确认它绿**

Run: `node tools\test-night-dashboard.mjs`
Expected: PASS —— `105 通过 / 0 失败`。

> **实施修订（2026-11-20，Task 3 四轮修复）**：
>
> **修复轮 1**（评审裁决「需要修」：1 Critical + 4 Important）——
> `.done` 与日志结束标记的权威性搞反了，导致一次**真实成功**的发布被判成「卡住了」、
> 一次失败夜被判成「还没跑」。修复后断言 68 → **87**。
>
> **修复轮 2**（scoped re-review 又挖出 1 条新引入的 Important）——
> `unknown` 的 problem 级别恒定 `error` → 对「已成功」的夜亮红；
> 外加补上 **spec §6.2 两条漏实现的判据**：
> 「某阶段 > 中位数 × 3 → warn」（阶段耗时算出来了却从不冒泡）与
> 「现在 > 06:00 且今天没有 `.done` → info」（每天 00:00–00:10 都会假报「今天凌晨还没跑」）。
> 修复后断言 87 → **96**。
>
> **修复轮 3**（复评通过，仅 3 条 Minor，母会话直接收尾）——
> ① 阶段级慢**只比闭合区间**；② `current.doneExists` → 完成记录**存在但 exit 读不出来**
> 与「没有完成记录」两种文案分开；③ 补 3 处护栏覆盖缺口。修复后断言 96 → **102**。
>
> **修复轮 4**（复评第 2 轮 PASS，3 条 Minor，母会话直接收尾）——
> ① 闭合区间的判据从「status 是不是 running/dead」改成
> 「**结束时刻知不知道**」（`finishedAt === null`）——
> 这样「`.done` 损坏但日志有结束标记」那条路也盖住了
> （那一夜 status 是 success，但尾段耗时同样被量到「轮询时刻」→ 告警数字每次都涨）；
> ② 补一条**走真实 `mergeSteps` 的 15 节点合并形状**的 fixture，
> 把「合并后数组最后一个元素 ≠ 最后一个观察到的步骤」这个坑钉死。
> 修复后断言 102 → **105**。
>
> 下游 Task 4–8 的期望值同步顺延（**105 → 115 → 120 → 142 → 144 → 151 → 158**）。
> 详见 `.superpowers/sdd/2026-11-20-night-publish-gui/task-3-fix-brief.md`、
> `task-3-fix-report.md`、`task-3-fix2-brief.md`、`task-3-fix2-report.md`。

- [ ] **Step 5: 提交（母本）**

```powershell
Set-Location 'E:\voice-pilot\daily-image-site'
git add -- 'tools/night-dashboard-state.mjs' 'tools/test-night-dashboard.mjs'
git commit -m "feat: 定时任务台状态判定与问题判定"
```
公开副本的同步在 Task 9 一次性做，这一轮**不碰公开副本**。

---

## Task 4: HTTP 服务 `tools/night-dashboard.mjs`

**Files:**
- Create: `tools/night-dashboard.mjs`
- Modify: `tools/test-night-dashboard.mjs`（追加第 4 组断言）

**Interfaces:**
- Consumes: Task 3 的 `buildCurrent` / `buildHistory` / `pickProblem`
- Produces: HTTP 服务。测试要能把它当模块 import，所以**服务必须导出 `createServer` 并支持 `PORT=0`**（让测试用随机端口，不跟真服务打架）：

```js
export function createServer(opts) // → { server, getChosenPort() }
```

- [ ] **Step 1: 追加会失败的断言**

```js
/* ── 4. HTTP 层 ────────────────────────────────────────── */
import { createServer } from './night-dashboard.mjs';
import http from 'node:http';

{
  /* allowWrite: false —— 测试里**绝不许**真的发起一次发布。
     写接口仍然会走「本机 + 跨站」两道门（所以 403 的断言是真的），
     只是过了门之后返回 503，不 spawn 任何东西。 */
  const inst = createServer({ port: 0, root: ROOT, schedule: false, allowWrite: false });
  await new Promise((res) => inst.server.listen(0, '127.0.0.1', res));
  const port = inst.getChosenPort();
  const base = 'http://127.0.0.1:' + port;

  async function req(path, opts = {}) {
    return await new Promise((resolve) => {
      const r = http.request(base + path, { method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      });
      r.on('error', () => resolve({ status: 0, body: '' }));
      r.end(opts.body || '');
    });
  }

  const st = await req('/api/state');
  check('/api/state → 200', st.status === 200, { status: st.status });
  let j = null;
  try { j = JSON.parse(st.body); } catch { /* 下面断言会红 */ }
  check('/api/state 是合法 JSON', !!j);
  check('/api/state 有 ok/serverTime/schedule/current/history/actions 五个键',
    !!j && j.ok === true && !!j.serverTime && !!j.schedule && !!j.current && !!j.history && !!j.actions,
    { keys: j && Object.keys(j) });
  check('/api/state 头里有 no-store', /no-store/.test(String(st.headers['cache-control'] || '')));

  const bad = await req('/api/log?date=不是日期');
  check('/api/log 非法日期 → 400', bad.status === 400, { status: bad.status });

  const far = await req('/api/log?date=2020-01-01');
  check('/api/log 不存在的日期 → 200 空列表（不是 500）', far.status === 200, { status: far.status });

  /* 跨站与本机判定 */
  const evil = await req('/api/run-now', {
    method: 'POST', headers: { Origin: 'http://evil.example.com' },
  });
  check('POST 跨站 Origin → 403', evil.status === 403, { status: evil.status });

  const same = await req('/api/run-now', {
    method: 'POST', headers: { Origin: 'http://127.0.0.1:' + port },
  });
  check('POST 同源 Origin（动态端口）→ 不是 403', same.status !== 403, { status: same.status });

  /* 静态资源的断言放在 Task 5 —— 那时才真的建出 tools/dashboard-ui/。
     本 Task 里页面还不存在，断言它 200 只会假红。 */

  /* 目录穿越：在 UI_DIR 外面**真的放一个金丝雀文件**。
     请求路径里的 .. 会被 URL 解析器提前归一化 —— 只断言 404 是**假绿**，
     必须看响应体里有没有金丝雀的内容。
     两条路径都要试：.. 形式（会被归一化）和 %2f 形式（服务器自己解码，才真走到防护分支）。 */
  const canaryFile = path.join(ROOT, '.tmp-canary.txt');
  fs.writeFileSync(canaryFile, 'CANARY-9f3a', 'utf8');
  try {
    const c1 = await req('/../.tmp-canary.txt');
    check('目录穿越（.. 形式）拿不到金丝雀', c1.body.indexOf('CANARY-9f3a') < 0,
      { status: c1.status, body: c1.body.slice(0, 80) });
    const c2 = await req('/%2f..%2f.tmp-canary.txt');
    check('目录穿越（%2f 形式）拿不到金丝雀', c2.body.indexOf('CANARY-9f3a') < 0,
      { status: c2.status, body: c2.body.slice(0, 80) });
  } finally {
    try { fs.unlinkSync(canaryFile); } catch { /* 清理 */ }
  }

  await new Promise((res) => inst.server.close(res));
}
```

⚠️ 顶层 `await` 需要 ESM —— 本文件本来就是 `.mjs`，顶层 await 合法 ✓。

- [ ] **Step 2: 跑测试，确认它红**

Run: `node tools\test-night-dashboard.mjs`
Expected: FAIL —— `ERR_MODULE_NOT_FOUND`（`night-dashboard.mjs` 还不存在）。

- [ ] **Step 3: 写实现**

创建 `tools/night-dashboard.mjs`：

```js
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
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROOT, srcSearchRoots, findDatedDir } from './paths.mjs';
import {
  parseDone, buildCurrent, buildHistory, pickProblem, stepMedians, fmtDuration,
} from './night-dashboard-state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, 'dashboard-ui');
const PORT_FILE = process.env.NIGHT_DASHBOARD_PORT_FILE || path.join(ROOT, '.night-dashboard-port');
const DEFAULT_PORT = 8801;
const TASK_NAME = 'DailyImageSite-NightPublish-0010';

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

/** 北京今天的 'YYYY-MM-DD'（Windows 认 'China Standard Time'，别的认 'Asia/Shanghai'）。 */
export function todayBj() {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(d);
}

/** 找出某一天的三种日志里最新的那一份。 */
function findLogFor(root, date) {
  const candidates = [
    { source: 'night', file: path.join(root, `.night-publish-${date}.log`) },
    { source: 'manual', file: path.join(root, `.manual-publish-${date}.log`) },
    { source: 'review', file: path.join(root, `.review-publish-${date}.log`) },
  ];
  for (const c of candidates) {
    try {
      const st = fs.statSync(c.file);
      if (st.size > 0) return { source: c.source, file: c.file, mtime: st.mtimeMs };
    } catch { /* 没有这份 */ }
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

/** 读计划任务状态。读不到就降级成 available:false —— 不许整页报错。 */
function readSchedule() {
  const empty = { available: false, name: TASK_NAME, state: null, lastRunTime: null, lastResult: null, nextRunTime: null };
  try {
    const ps = 'Get-ScheduledTask -TaskName ' + JSON.stringify(TASK_NAME) + ' -ErrorAction SilentlyContinue | ' +
      'Select-Object -First 1 | ForEach-Object { $i = Get-ScheduledTaskInfo -TaskName ' + JSON.stringify(TASK_NAME) + '; ' +
      '[pscustomobject]@{ state = $_.State.ToString(); lastRunTime = $i.LastRunTime.ToString("o"); ' +
      'lastResult = [int]$i.LastTaskResult; nextRunTime = $i.NextRunTime.ToString("o") } } | ConvertTo-Json -Compress';
    const out = execPowerShell(ps);
    if (!out || !out.trim()) return empty;
    const j = JSON.parse(out.trim().split(/\r?\n/).filter(Boolean).pop());
    return { available: true, name: TASK_NAME, state: j.state, lastRunTime: j.lastRunTime, lastResult: j.lastResult, nextRunTime: j.nextRunTime };
  } catch {
    return empty;
  }
}

/** 跑一段 PowerShell 并拿 stdout（同步，短命令）。 */
function execPowerShell(script, cwd) {
  const exe = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  const r = spawnSync(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { cwd: cwd || ROOT, encoding: 'utf8', timeout: 20000, windowsHide: true });
  return r.stdout || '';
}

/** 当前有没有发布在跑（写操作前要挡一下）。 */
function isBusy() {
  try {
    const out = execPowerShell(
      "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | " +
      "Where-Object { $_.CommandLine -match 'publish\\.ps1|night-publish\\.ps1|manual-publish\\.ps1' } | " +
      "Select-Object -First 1 -ExpandProperty ProcessId");
    return !!String(out || '').trim();
  } catch {
    return false;
  }
}

/* ── 状态组装 ───────────────────────────────────────────── */

function buildState(root, withSchedule) {
  const today = todayBj();
  const dates = scanDates(root);
  const withToday = dates.includes(today) ? dates : [today, ...dates];

  const history = [];
  const currents = new Map();          // date → 完整的 current（history 里只放摘要）
  for (const d of withToday.slice(0, 30)) {
    const done = parseDone(readText(path.join(root, `.night-publish-${d}.done`)));
    const log = findLogFor(root, d);
    const cur = buildCurrent({
      date: d,
      done,
      logText: log ? readText(log.file) : '',
      logMtime: log ? log.mtime : 0,
      now: Date.now(),
    });
    currents.set(d, cur);
    if (cur.status === 'not-run' && d !== today) continue;
    history.push({
      date: d, status: cur.status, durationMs: cur.durationMs,
      source: cur.source, headline: cur.headline,
      steps: cur.steps.map((s) => ({ key: s.key, durationMs: s.durationMs })),
    });
  }
  const hist = buildHistory(history);

  const todayCur = currents.get(today) || buildCurrent({
    date: today, done: null, logText: '', logMtime: 0, now: Date.now(),
  });

  /* 问题：今天的 + 历史的慢夜，取最重的一条。 */
  const med = stepMedians(hist);
  let problem = pickProblem(todayCur, hist);
  if (!problem || problem.level === 'info') {
    for (const h of hist) {
      if (h.date === today) continue;
      const p = pickProblem({ ...h, status: h.status, problem: null }, hist);
      if (p && (p.level === 'error' || p.level === 'warn')) { problem = p; break; }
    }
  }

  const republishDates = [];
  for (const d of withToday.slice(0, 30)) {
    if (findDatedDir(srcSearchRoots(), d)) republishDates.push(d);
  }

  todayCur.problem = problem;
  return {
    ok: true,
    serverTime: new Date().toISOString(),
    todayBj: today,
    schedule: withSchedule
      ? readSchedule()
      : { available: false, name: TASK_NAME, state: null, lastRunTime: null, lastResult: null, nextRunTime: null },
    current: todayCur,
    history: hist.map((h) => ({
      date: h.date, status: h.status, durationMs: h.durationMs,
      source: h.source, headline: h.headline,
    })),
    problems: problem ? [problem] : [],
    actions: {
      busy: isBusy(),
      canRunNow: true,
      republishDates,
      stepMedians: Object.fromEntries(med),
    },
  };
}

/* ── 写操作 ─────────────────────────────────────────────── */

/**
 * 本机 + 跨站两道门。
 * ⚠️ Origin 白名单用**服务实际监听的端口** —— 端口顺延后如果写死 8801，
 *    同源页面自己的 POST 会被判成跨站 403（审稿台踩过这个坑）。
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

/** 起一个后台任务，把输出落到日志文件。 */
function spawnPublish(runnerArgs) {
  const ps = path.join(ROOT, 'tools', 'publish.ps1');
  const exe = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, ...runnerArgs];
  const child = spawn(exe, args, {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
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
    rel = decodeURIComponent(urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, ''));
  } catch {
    rel = '';
  }
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
  let chosenPort = port;

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;

    if (p === '/api/state' && req.method === 'GET') {
      try {
        return sendJson(res, 200, buildState(root, withSchedule));
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
      }
    }

    if (p === '/api/log' && req.method === 'GET') {
      const date = u.searchParams.get('date') || '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return sendJson(res, 400, { ok: false, error: '日期格式不对（应为 YYYY-MM-DD）' });
      }
      const log = findLogFor(root, date);
      const text = log ? readText(log.file) : '';
      const lines = text.split(/\r?\n/);
      return sendJson(res, 200, {
        ok: true, date, source: log ? log.source : null, lines: lines.slice(-120),
      });
    }

    if ((p === '/api/run-now' || p === '/api/republish') && req.method === 'POST') {
      const deny = guard(req, chosenPort);
      if (deny) return sendJson(res, 403, { ok: false, error: deny });
      if (!allowWrite) return sendJson(res, 503, { ok: false, error: '这个实例禁用了写操作' });
      if (isBusy()) return sendJson(res, 409, { ok: false, error: '已经在跑了，等它跑完' });

      let args;
      if (p === '/api/run-now') {
        args = ['-Force', '-NoBrowser'];
        if (u.searchParams.get('date')) args.push('-Date', u.searchParams.get('date'));
      } else {
        const date = u.searchParams.get('date') || '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return sendJson(res, 400, { ok: false, error: '日期格式不对（应为 YYYY-MM-DD）' });
        }
        if (!findDatedDir(srcSearchRoots(), date)) {
          return sendJson(res, 400, { ok: false, error: '那一天的源图已经不在了，补发不了' });
        }
        args = ['-Date', date, '-SkipReview', '-NoConvert', '-NoHeadlines'];
      }
      const pid = spawnPublish(args);
      return sendJson(res, 202, { ok: true, pid, args });
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
    getChosenPort: () => {
      const a = server.address();
      return (a && typeof a === 'object') ? a.port : chosenPort;
    },
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
```

- [ ] **Step 4: 跑测试，确认它绿**

Run: `node tools\test-night-dashboard.mjs`
Expected: PASS —— `120 通过 / 0 失败`（115 + verifier 评审要求补的 5 条护栏）。

### 修复轮 2（母 agent 实测发现的真 bug：`spawnDetached` 在 Windows 上**起不来**发布进程）

⚠️ **2026-11-20 母 agent 实测**（不是推理）：
**Windows 上 Node 的 `spawn('powershell', [...], { detached: true })` 起的 PowerShell
会「立刻退出（exit 0）」，脚本根本没跑**（标记文件都没生成）。
所以「立即跑一次」/「补发某一天」会返回 **202 `{ok:true,pid}`** 看起来受理了，
**实际什么都没发生** —— 对不可逆的发布动作，这是最坏的失败模式。

| 形状 | 实测 |
|---|---|
| `node` + `detached` | ✅ 活着 |
| `cmd` + `detached` | ✅ 活着 |
| **`powershell` + `detached`** | ❌ **exit 0、脚本没跑** |
| `powershell` + **不** detached | ✅ 活着 |
| **`cmd /c start /b powershell -File x.ps1`** | ✅ **脚本真跑，父进程退出后还活着** |

**根因（推测）**：`detached` 在 Windows 上给子进程 `DETACHED_PROCESS` → 没有控制台 →
PowerShell 5.1 启动即罢工。node / cmd 不挑这个，**只有 PowerShell 有这个毛病**。

⚠️ **spec §4.3 原本写的就是 `cmd /c start /b`** —— 实现偏离了它，
评审把这条偏离判成「Minor / 功能等价」**但没实测**。现在有实测了：**不等价，而且坏**。
→ 修法：`spawnDetached` 在 Windows 走 `cmd /c start /b`，POSIX 保持直连。
→ 护栏 +2 条：**形状断言**（Windows 走 `cmd /c start /b`）+ **行为断言**
（真的起一个脱离的 PowerShell，看它是不是还在跑 —— 只查形状不够，形状对了照样秒退）。
→ 护栏 142 → **144**。

**母 agent 派活前的预检订正**（brief 已按这个改好，实施者照 brief 做）：

| 项 | 原 brief 的写法 | 预检后的结论 |
|---|---|---|
| Windows 形状 | `cmd /c start '' /b <exe> ...`（空标题） | ✅ **实测通过**，可以用。探针 `probe-fix2-shapes.mjs` / `probe-fix2-filepath.mjs` 亲测：空标题 + `-Command` ✅、空标题 + `-File "<带空格路径>"` ✅、无标题也 ✅，标记文件都写了、5.5 秒后进程都还活着 |
| 动态 import 的变量名 | `dash4` | ❌ 护栏里没有 `dash4`。第 4 组叫 `dash`、4b 组叫 `dash4b`、第 5 组叫 `dash5`。→ 新断言**另起一个块**自己 import（`dashFix2`），照本文件既有惯例 |
| `os` 模块 | 「可能要 import」 | ✅ **已经在文件头**（第 8 行）→ 不要再加（重复 import 同名 → SyntaxError → 整个套件崩，不是干净地红） |
| `spawn` | 「要补 import」 | ✅ 确实**还没** import。文件头第 11 行 `import { spawnSync } from 'node:child_process';` → **改成** `{ spawnSync, spawn }`（改那一行，别新加一行） |
| 行为断言的判据 | 只查「标记文件写了没」 | 加查**第二次（+3 秒）进程还在不在** —— 起一下就退的进程，第一次可能已经写完标记了 |

⚠️ **教训**：「detached + unref ≡ cmd start」这种推断**必须实测**。
凡是「子进程会不会活着 / 会不会真的跑起来」的问题，一律**真的起一个进程看它活不活**。

⚠️ **顺带记一条**：`Get-CimInstance` 那条「按命令行找进程」的探测命令**自己也会命中**
（它的命令行里就含探针标记）→ 查到 2 个 PID 不代表起了 2 个进程。

### 修复轮 1（verifier 评审结论「需要修」）

评审实测：**实现代码全部符合 spec，没有 Critical**；但护栏有 4 个洞。
最要紧的一条：brief 自己写着「测试里**绝不许**真的发起一次发布」，
却**没有任何断言保证这一点** —— 把 `if (!allowWrite)` 挪到 spawn 之后，
套件仍然 115/0 全绿，而真发布已经被拉起（评审的变异体 M3/M9 打桩命中）。

修复轮的完整 brief 在 `.superpowers/sdd/2026-11-20-night-publish-gui/task-4-fix1-brief.md`，要点：

- `createServer` 加**可注入的 spawn 钩子**（`opts.spawnFn`）→ 护栏能观测「写路径零副作用」
  而**绝不**真的发一次；测试的主实例**必须**挂这个钩子。
- 补 5 条断言：写路径零副作用 / allowWrite 判断在 spawn 之前（源码顺序）/ `by:'manual'` 那一夜取 manual 日志（合成 fixture）/ 只绑 `127.0.0.1` / `/api/log` 只读尾部 64KB。
- 3 处小修：`readSchedule()` 加 10 秒缓存 / 写接口 handler 加 try/catch / `/api/run-now` 不接受 `?date=`（spec §4.4：run-now 只管今天）。
- `tools/test-portability.mjs` 加 1 条（`night-dashboard.mjs` 不许硬编码 `powershell.exe`）→ 44 → 45。

- [ ] **Step 5: 手动起一下看看**

```powershell
node "E:\voice-pilot\daily-image-site\tools\night-dashboard.mjs"
```
Expected: 打印 `任务台：http://127.0.0.1:8801/`，且 `E:\voice-pilot\daily-image-site\.night-dashboard-port` 里写着 `8801`。
用 `Ctrl+C` 停掉。

- [ ] **Step 6: 提交（母本）**

```powershell
Set-Location 'E:\voice-pilot\daily-image-site'
git add -- 'tools/night-dashboard.mjs' 'tools/test-night-dashboard.mjs'
git commit -m "feat: 定时任务台 HTTP 服务（只读接口 + 两个受控写操作）"
```
公开副本的同步在 Task 9 一次性做，这一轮**不碰公开副本**。

---

## Task 5: 页面 `tools/dashboard-ui/`

**Files:**
- Create: `tools/dashboard-ui/index.html`
- Create: `tools/dashboard-ui/app.css`
- Create: `tools/dashboard-ui/app.js`
- Modify: `tools/test-night-dashboard.mjs`（追加第 5 组断言）

**Interfaces:**
- Consumes: Task 4 的 `GET /api/state`、`GET /api/log?date=`、`POST /api/run-now`、`POST /api/republish`
- Produces: 无代码接口（这是最后一层）。

**本轮订正（母 agent 独立核实过，别照抄旧 brief）：**
1. 旧 brief 的断言块里 `const css` 声明了**两次** → SyntaxError → 护栏**整个崩掉**（不是干净地红）。已改名。
2. 旧 brief 直接调 `createServer(...)` —— 但它是**第 4 组块内的局部变量**，第 5 组取不到 → ReferenceError → 崩。已改成第 5 组自己动态 import。
3. 旧 brief 期望「95 通过」是过期数 → 现在是 **142**（120 + 本组 22 条）。
4. 旧 brief 漏了 spec §8.1「**点一下展开该步的日志尾部**」→ 本 brief 补上（接 `/api/log`）。
5. 旧 brief 漏了 spec §8.3「源图被清掉的日期**禁用并注明「源图已清理」**」→ 本 brief 补上（前端从 `history − republishDates` 推出来，**不用改接口**）。
6. 旧 brief 漏了 spec §8.1「00:10:02 **开始** · 00:41:39 **结束**」→ 本 brief 补上 `finishedAt`。
7. 旧 brief 的历史表只有 4 列，spec §8.1 要 5 列（含「一句话结论」）→ 补上。
8. 旧 brief 没有「耗时无数值时显示 **—**」的护栏 → 真实数据 11-16~11-20 的 `durationMs` 全是 `null`（Task 1 加时间戳之前跑的），UI 必须优雅降级。
9. **「点开那一步看日志」在 `/api/log` 的契约下只能部分成立** —— 该接口按 spec §7.2 只返回
   **最后 120 行**，而 11-20 的日志有 **1274 行**、16 个阶段标记里有 **11 个在窗口外**。
   → 本 brief 改成**诚实降级**：那一步的标记不在窗口里时，明说「不在保留的尾部里」并给出
   完整日志的文件位置，**不把整个尾巴糊上去冒充那一步的日志**（会让人以为看到了这一步）。
   → **不改接口契约**（Task 9 会在 spec §8.1 上把这个边界写清）。

---

- [ ] **Step 0: 先把护栏的 `read()` 改成读不到返回空串**

```js
function read(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    return '';
  }
}
```

⚠️ **为什么必须先改**：不改的话，Step 1 的断言一读 `tools/dashboard-ui/index.html` 就抛 `ENOENT`，
**整个套件崩掉**（一条 `✗` 都不会打印）→ Task 8 按标签 grep 会误判「没抓到」。
改成返回空串之后，缺失会**干净地红**。

⚠️ 改这一处**不会**让既有断言假绿：现有两个调用点
（`helperBody(read(file), fn)` 和 `read('tools/publish.ps1')`）后面都带空值前置
（`body !== ''` / `!!stepLine`）—— 读不到 → 那些断言**红**，不会空过。

- [ ] **Step 1: 追加会失败的断言**

```js
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
```

⚠️ 每条静态资源断言都带 `!!inst5` 前置 —— 服务没起来时 `status` 是 `0`，
不加前置就会「0 !== 200」红掉但**理由是错的**；更糟的是有人图省事写成
`status !== 200` 就变成**假绿**（服务压根没起来，断言却通过）。

- [ ] **Step 2: 跑测试，确认它红**

Run: `node tools\test-night-dashboard.mjs`
Expected: FAIL —— **17 条**新断言里，文件不存在的那几条红；
「静态页 / → 200」这类要等文件建出来才可能绿。
**必须是 `✗ <label>` 的红，不是整个套件抛异常崩掉。**

- [ ] **Step 3: 写 `index.html`**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>任务台 · 大佬请批阅</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header class="top">
  <h1>任务台</h1>
  <div class="sched" id="sched">计划任务 —</div>
</header>

<main>
  <div class="unread hidden" id="unread"></div>

  <section class="hero" id="hero">
    <div class="hero-title" id="heroTitle">读取中…</div>
    <div class="hero-badge" id="heroBadge"></div>
    <div class="hero-sub" id="heroSub"></div>
  </section>

  <section id="steps"></section>

  <section class="problem hidden" id="problem">
    <span class="p-icon" id="pIcon">!</span>
    <div>
      <div class="p-title" id="pTitle"></div>
      <div class="p-detail" id="pDetail"></div>
    </div>
  </section>

  <section class="logbox hidden" id="logBox">
    <div class="log-head">
      <span id="logTitle"></span>
      <button class="link" id="logClose">收起 ✕</button>
    </div>
    <pre class="log-body" id="logBody"></pre>
  </section>

  <section class="history">
    <div class="h-head">最近 7 天 <button class="link" id="toggleHistory">展开历史 ▾</button></div>
    <div class="strip" id="strip"></div>
    <table class="h-table hidden" id="hTable">
      <thead><tr><th>日期</th><th>结果</th><th>耗时</th><th>来源</th><th>一句话结论</th></tr></thead>
      <tbody id="hBody"></tbody>
    </table>
  </section>
</main>

<footer class="bar">
  <button class="btn" id="runNow">立即跑一次</button>
  <select id="republishDate" class="pick"></select>
  <button class="btn" id="republish">补发某一天</button>
</footer>

<dialog id="confirm">
  <div class="d-title" id="dTitle"></div>
  <div class="d-body" id="dBody"></div>
  <div class="d-actions">
    <button class="btn ghost" id="dCancel">取消</button>
    <button class="btn" id="dOk">确认</button>
  </div>
</dialog>

<script src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 4: 写 `app.css`**

```css
/* 素白文档风：大留白、细分隔线、靠字重分层。
   暗色模式跟随系统 —— 半夜起来看是刚需。 */
:root {
  --bg: #ffffff;
  --ink: #1d1d1f;
  --ink-2: #86868b;
  --line: #e5e5e7;
  --ok: #34c759;
  --warn: #ff9f0a;
  --err: #ff3b30;
  --accent: #0071e3;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1d1d1f;
    --ink: #f5f5f7;
    --ink-2: #86868b;
    --line: #3d3d3f;
  }
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font: 14px/1.6 -apple-system, "Segoe UI", system-ui, "Microsoft YaHei", sans-serif;
  background: var(--bg);
  color: var(--ink);
  padding-bottom: 76px;
}
.top {
  display: flex; align-items: baseline; gap: 16px;
  padding: 18px 32px; border-bottom: 1px solid var(--line);
}
.top h1 { font-size: 15px; font-weight: 600; }
.sched { margin-left: auto; font-size: 12px; color: var(--ink-2); }
main { max-width: 900px; margin: 0 auto; padding: 32px; }
.hero { margin-bottom: 28px; }
.hero-title { font-size: 22px; font-weight: 600; }
.hero-badge {
  display: inline-block; margin-top: 8px; padding: 2px 10px;
  border-radius: 999px; font-size: 12px;
  border: 1px solid var(--line); color: var(--ink-2);
}
.hero-sub { color: var(--ink-2); font-size: 12px; margin-top: 6px; }
.group { margin-bottom: 18px; }
.group-name { font-size: 11px; color: var(--ink-2); letter-spacing: .06em; margin-bottom: 8px; }
.dots { display: flex; gap: 6px; }
.dot {
  flex: 1; height: 8px; border-radius: 4px; background: var(--line);
  position: relative; border: none; padding: 0; cursor: pointer;
}
.dot:hover { outline: 2px solid var(--ink-2); outline-offset: 2px; }
.dot.done { background: var(--ok); }
.dot.running { background: var(--accent); animation: breathe 1.4s ease-in-out infinite; }
.dot.skipped { background: var(--warn); }
.dot.failed { background: var(--err); }
@keyframes breathe { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
.labels { display: flex; gap: 6px; margin-top: 6px; }
.labels span { flex: 1; font-size: 10px; color: var(--ink-2); text-align: center; }
.problem {
  display: flex; gap: 10px; align-items: flex-start;
  border-left: 3px solid var(--warn); background: rgba(255,159,10,.09);
  padding: 10px 14px; border-radius: 0 8px 8px 0; margin-bottom: 24px;
}
.problem.error { border-left-color: var(--err); background: rgba(255,59,48,.09); }
.problem.info { border-left-color: var(--ink-2); background: rgba(134,134,139,.08); }
.unread {
  border: 1px solid rgba(255,159,10,.35); background: rgba(255,159,10,.10);
  border-radius: 8px; padding: 8px 14px; margin-bottom: 20px; font-size: 13px;
}
.p-icon { font-weight: 700; }
.p-title { font-weight: 600; }
.p-detail { color: var(--ink-2); font-size: 12px; margin-top: 2px; }
.logbox {
  margin-bottom: 24px; border: 1px solid var(--line);
  border-radius: 8px; overflow: hidden;
}
.log-head {
  display: flex; align-items: center; gap: 12px; padding: 8px 14px;
  background: rgba(134,134,139,.07); font-size: 12px;
}
.log-body {
  margin: 0; padding: 12px 14px; max-height: 320px; overflow: auto;
  font: 12px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace;
  white-space: pre-wrap; word-break: break-all;
}
.history { margin-top: 28px; }
.h-head { font-size: 12px; color: var(--ink-2); display: flex; align-items: center; gap: 12px; }
.strip { display: flex; gap: 4px; margin-top: 8px; }
.strip i { flex: 1; height: 8px; border-radius: 4px; background: rgba(52,199,89,.35); }
.strip i.warn { background: rgba(255,159,10,.5); }
.strip i.err { background: rgba(255,59,48,.5); }
.link { background: none; border: none; color: var(--accent); cursor: pointer; font-size: 12px; }
.h-table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px; }
.h-table th { text-align: left; color: var(--ink-2); font-weight: 500; border-bottom: 1px solid var(--line); }
.h-table td { padding: 6px 0; border-bottom: 1px solid var(--line); }
.bar {
  position: fixed; left: 0; right: 0; bottom: 0;
  display: flex; gap: 10px; justify-content: flex-end; align-items: center;
  padding: 14px 32px; border-top: 1px solid var(--line); background: var(--bg);
}
.btn {
  background: var(--accent); color: #fff; border: none;
  padding: 8px 14px; border-radius: 8px; font-size: 13px; cursor: pointer;
}
.btn.ghost { background: transparent; color: var(--ink); border: 1px solid var(--line); }
.btn:disabled { opacity: .45; cursor: default; }
.pick { padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); }
dialog {
  border: 1px solid var(--line); border-radius: 14px; padding: 22px;
  max-width: 460px; background: var(--bg); color: var(--ink);
}
dialog::backdrop { background: rgba(0,0,0,.35); }
.d-title { font-weight: 600; margin-bottom: 8px; }
.d-body { color: var(--ink); margin-bottom: 18px; line-height: 1.7; }
.d-actions { display: flex; gap: 10px; justify-content: flex-end; }
.hidden { display: none !important; }
```

- [ ] **Step 5: 写 `app.js`**

```js
/* 定时任务台的前端：3 秒轮询 /api/state，重绘。 */
'use strict';

const $ = (id) => document.getElementById(id);
let last = null;
let lastStepSig = '';

/** 不可逆动作的确认文案 —— 写不清不可逆性 = 不许发出去。 */
const CONFIRM = {
  runNow: {
    title: '立刻重跑今天这一期？',
    body: '立刻重跑今天的完整流程（抓图 → 头条 → 清洗 → 构建 → 上传 R2 → 部署 Pages）。\n' +
          '线上首页会立刻变成今天这一期。\n' +
          '撤回要等 24 小时边缘缓存，发出去的链接收不回来。',
    ok: '确认跑一次',
  },
  republish: {
    title: '补发某一天？',
    body: (d) => '补发 ' + d + '：重新构建并部署那一期。\n' +
          '线上首页会重新指向 ' + d + '；这一期之后的日期会下线，直到你再发一次新期。\n' +
          '撤回要等 24 小时边缘缓存。',
    ok: '确认补发',
  },
};

/**
 * 耗时：没有数值就显示「—」。
 * ⚠️ 不是装饰 —— 11-16~11-20 的真实日志是 Task 1 加时间戳**之前**跑的，
 *    `durationMs` 全是 null。显示 "NaN" 或 "null" 就是露怯。
 */
function fmtDur(ms) {
  if (!Number.isFinite(ms)) return '—';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return h + ' 时 ' + m + ' 分';
  if (m) return m + ' 分 ' + s + ' 秒';
  return s + ' 秒';
}

/**
 * 时刻：**按北京时间显示**。
 * ⚠️ 不能用 toLocaleTimeString() 的本地时区 —— 浏览器在别的时区时会错位，
 *    而整站的时基是北京时间（spec §5.4 / Get-BjNow）。
 */
function fmtAt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(d);
  } catch {
    return d.toISOString().slice(11, 19);
  }
}

const GROUP_LABEL = { prepare: '准备', verify: '校验与审稿', publish: '发布' };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** 阶段点。签名没变就不重画 —— 否则每 3 秒重建 DOM，点一下就闪。 */
function renderSteps(steps) {
  const sig = steps.map((s) => s.key + ':' + s.status).join('|');
  if (sig === lastStepSig) return;
  lastStepSig = sig;

  const groups = [];
  for (const s of steps) {
    let g = groups.find((x) => x.key === s.group);
    if (!g) { g = { key: s.group, label: GROUP_LABEL[s.group] || s.group, items: [] }; groups.push(g); }
    g.items.push(s);
  }
  $('steps').innerHTML = groups.map((g) =>
    '<div class="group"><div class="group-name">' + g.label + '（' + g.items.length + '）</div>' +
    '<div class="dots">' + g.items.map((s, i) =>
      '<button class="dot ' + (s.status || 'pending') + '" data-g="' + esc(g.key) +
      '" data-i="' + i + '" title="' + esc(s.label) + '"></button>').join('') +
    '</div><div class="labels">' + g.items.map((s) =>
      '<span>' + esc(s.label.replace(/（.*?）/g, '').slice(0, 6)) + '</span>').join('') +
    '</div></div>').join('');

  /* 阶段点可点：点一下展开那一步的日志尾部（spec §8.1）。 */
  for (const el of document.querySelectorAll('#steps .dot')) {
    el.addEventListener('click', () => {
      const g = groups.find((x) => x.key === el.getAttribute('data-g'));
      const item = g && g.items[Number(el.getAttribute('data-i'))];
      if (item) openStep(item);
    });
  }
}

/**
 * 点开某一步：取那一天的日志尾部，切出这一步的那一段。
 * 日志标记是 `=== 1/5 抓图 + 目录分流 ===`，step 的 label 与它**逐字对得上**。
 */
async function openStep(step) {
  const d = (last && last.current && last.current.date) || '';
  if (!d) return;
  $('logBox').classList.remove('hidden');
  $('logTitle').textContent = step.label + ' · ' + d;
  $('logBody').textContent = '读取中…';
  try {
    const r = await fetch('/api/log?date=' + encodeURIComponent(d), { cache: 'no-store' });
    const j = await r.json();
    const lines = (j && Array.isArray(j.lines)) ? j.lines : [];
    const seg = sliceStep(lines, step);
    if (seg.length) {
      $('logBody').textContent = seg.join('\n');
    } else if (lines.length) {
      /* ⚠️ **诚实降级**：这一步的标记不在接口返回的那 120 行里。
         /api/log 按契约只返回**最后 120 行**（spec §7.2「尾部 120 行」），
         而 11-20 的日志有 1274 行 —— 16 个阶段标记里有 **11 个在窗口外**。
         这里**不许**假装有内容，也不许把整个尾巴糊上去冒充「这一步的日志」——
         那会让人以为看到了这一步，其实看到的是别的步骤。
         直接说清楚在哪：完整日志在磁盘上的哪个文件。 */
      $('logBody').textContent =
        '这一步的日志不在保留的尾部里（/api/log 只返回最后 120 行）。\n' +
        '完整日志：' + (last && last.current ? last.current.date : '') + ' 的 .night-publish-<日期>.log\n' +
        '（下面是这次运行的最后 120 行）\n\n' + lines.join('\n');
    } else {
      $('logBody').textContent = '（这一天没有日志内容）';
    }
  } catch (e) {
    $('logBody').textContent = '读不到日志：' + (e && e.message ? e.message : e);
  }
}

/** 从日志尾部里切出「这一步」那一段：含这一步文案的 === 行 → 下一个 === 行之前。 */
function sliceStep(lines, step) {
  const label = step.label || '';
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (label && lines[i].indexOf(label) >= 0) { start = i; break; }
  }
  if (start < 0) return [];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    /* ⚠️ 分隔用的长横线是 `==========`（第三个 = 后面还是 =），
       不会命中 `=== ` —— 别把分隔线当阶段边界。 */
    if (/^\s*=== /.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end);
}

function render(st) {
  last = st;
  const c = st.current || {};

  $('heroTitle').textContent = (c.date || st.todayBj) + ' 夜间发布';
  $('heroBadge').textContent = c.headline || '—';
  $('heroSub').textContent = [
    c.startedAt ? ('开始 ' + fmtAt(c.startedAt)) : '',
    c.finishedAt ? ('结束 ' + fmtAt(c.finishedAt)) : '',
    ((c.steps || []).filter((s) => s.status === 'done').length) + '/' +
      ((c.steps || []).length) + ' 节点完成',
  ].filter(Boolean).join(' · ');

  const sc = st.schedule || {};
  $('sched').textContent = sc.available
    ? ('计划任务 ' + (sc.state || '') + ' · 上次 ' + (sc.lastRunTime || '—') + ' · 下次 ' + (sc.nextRunTime || '—'))
    : '计划任务：读不到';

  renderSteps(c.steps || []);

  const ps = st.problems || [];
  const p = ps[0] || null;
  if (p) {
    $('problem').className = 'problem ' + (p.level || 'info');
    $('pTitle').textContent = p.title || '';
    $('pDetail').textContent = p.detail || '';
  } else {
    $('problem').className = 'problem hidden';
    $('pTitle').textContent = '';
    $('pDetail').textContent = '';
  }

  /* 未读问题提示：页面关着的时候也会漏，所以下次打开要补一条。 */
  const unread = $('unread');
  unread.classList.toggle('hidden', ps.length === 0);
  if (ps.length) unread.textContent = '有 ' + ps.length + ' 条未读问题：' + (ps[0].title || '');

  const h = (st.history || []).slice(0, 7);
  $('strip').innerHTML = h.map((x) =>
    '<i class="' + (x.status === 'failed' ? 'err' : (x.status === 'success' ? '' : 'warn')) + '" title="' +
    esc(x.date + ' ' + (x.headline || '')) + '"></i>').join('');
  $('hBody').innerHTML = h.map((x) =>
    '<tr><td>' + esc(x.date) + '</td><td>' + esc(x.status) + '</td><td>' + esc(fmtDur(x.durationMs)) +
    '</td><td>' + esc(x.source || '—') + '</td><td>' + esc(x.headline || '') + '</td></tr>').join('');

  /* 补发日期：源图目录还在的才能选。
     源图被清掉的**显示但禁用**并注明「源图已清理」（spec §8.3）——
     哪些被清掉，从 `history − republishDates` 就能推出来，不用改接口。 */
  const pick = $('republishDate');
  const dates = (st.actions && st.actions.republishDates) || [];
  const cleaned = (st.history || []).map((x) => x.date).filter((d) => dates.indexOf(d) < 0);
  const sig = dates.join(',') + '|' + cleaned.join(',');
  if (pick.dataset.sig !== sig) {
    pick.dataset.sig = sig;
    pick.innerHTML = dates.map((d) => '<option value="' + esc(d) + '">' + esc(d) + '</option>').join('') +
      cleaned.map((d) => '<option value="' + esc(d) + '" disabled>' + esc(d) + '（源图已清理）</option>').join('');
  }

  /* 已经有发布在跑 → 把写按钮置灰（服务端还会再挡一道 409）。 */
  const busy = !!(st.actions && st.actions.busy);
  $('runNow').disabled = busy;
  $('republish').disabled = busy;
}

async function poll() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    const st = await r.json();
    if (st && st.ok) render(st);
  } catch (e) {
    $('heroTitle').textContent = '连不上任务台服务';
  }
}

/** 二次确认条：不可逆动作必须走这里。onOk 是真正发起请求的那个函数。 */
function confirm(title, body, okLabel, onOk) {
  const dlg = $('confirm');
  $('dTitle').textContent = title;
  $('dBody').textContent = body;
  $('dOk').textContent = okLabel;
  $('dOk').onclick = async () => {
    dlg.close();
    try {
      await onOk();
    } catch (e) {
      alert('没发出去：' + (e && e.message ? e.message : e));
    }
  };
  dlg.showModal();
}

$('dCancel').onclick = () => $('confirm').close();
$('logClose').onclick = () => $('logBox').classList.add('hidden');

$('runNow').onclick = () => {
  confirm(CONFIRM.runNow.title, CONFIRM.runNow.body, CONFIRM.runNow.ok, async () => {
    const r = await fetch('/api/run-now', { method: 'POST' });
    if (!r.ok) alert('没发出去：' + ((await r.json()).error || r.status));
  });
};

$('republish').onclick = () => {
  const d = $('republishDate').value;
  if (!d) { alert('没有可补发的日期（源图都不在了）'); return; }
  confirm('补发 ' + d + '？', CONFIRM.republish.body(d), CONFIRM.republish.ok + ' ' + d, async () => {
    const r = await fetch('/api/republish?date=' + encodeURIComponent(d), { method: 'POST' });
    if (!r.ok) alert('没发出去：' + ((await r.json()).error || r.status));
  });
};

$('toggleHistory').onclick = () => $('hTable').classList.toggle('hidden');

/* 浏览器桌面通知：只在页面开着时有效。 */
if ('Notification' in window && Notification.permission === 'default') {
  const b = document.createElement('button');
  b.textContent = '开启通知';
  b.className = 'btn ghost';
  b.style.marginLeft = '12px';
  b.onclick = () => Notification.requestPermission();
  document.querySelector('.top').appendChild(b);
}

let prevStatus = null;
let prevProblem = null;
setInterval(async () => {
  await poll();
  const st = last || {};
  const c = st.current || {};
  const ps = st.problems || [];
  const p = ps[0] || null;
  const pkey = p ? ((p.level || '') + '|' + (p.title || '')) : null;

  /* 触发点（spec §8.4）：跑完、出现 error/warn。 */
  const notify = (body) => {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('任务台', { body: body });
    }
  };
  const s = c.status;
  if (prevStatus && prevStatus !== s && s === 'success') {
    notify(c.headline || '这一期跑完了');
  }
  if (pkey && pkey !== prevProblem && (p.level === 'error' || p.level === 'warn')) {
    notify((p.title || '') + ' · ' + (p.detail || ''));
  }
  prevStatus = s;
  prevProblem = pkey;
}, 3000);

poll();
```

⚠️ 两个按钮各自把自己的 `fetch` 放进 `onOk` —— 确认条本身**只管确认和关闭**，
不藏着第二个 fetch 出口。

- [ ] **Step 6: 跑测试，确认它绿**

Run: `node tools\test-night-dashboard.mjs`
Expected: PASS —— `142 通过 / 0 失败`（120 + 本组 22 条）。

⚠️ 既有 120 条断言的**标签、条件、顺序一个字都不许动**。
新增的 22 条各自用**独立新标签**（Task 8 按标签 grep 变异点，重复标签会串）。

- [ ] **Step 7: 起服务看一眼**

```powershell
node "E:\voice-pilot\daily-image-site\tools\night-dashboard.mjs"
```
浏览器打开 `http://127.0.0.1:8801/`（端口从 `.night-dashboard-port` 读）。
确认：能看到「2026-11-20 夜间发布」、状态徽标「成功 · —」（旧日志没有时间戳，
耗时就是 **—**，这是对的）、三组 15 个点、最近 7 天的条带；
**点一下某个阶段点 → 下面弹出那一步的日志尾部**；
展开历史 → 5 列表格。
**只读，不点任何写按钮**（写按钮要等 Task 6 之后连着测）。

- [ ] **Step 8: 提交（母本）**

```powershell
Set-Location 'E:\voice-pilot\daily-image-site'
git add -- 'tools/dashboard-ui' 'tools/test-night-dashboard.mjs'
git commit -m "feat: 定时任务台页面（素白文档风 · 今日焦点 · 两个独立确认条）"
```
公开副本的同步在 Task 9 一次性做，这一轮**不碰公开副本**。

---
## Task 6: 启动器 `起任务台.cmd` + `tools/start-dashboard.mjs`

**Files:**
- Create: `tools/start-dashboard.mjs`
- Create: `起任务台.cmd`
- Modify: `tools/test-night-dashboard.mjs`（追加第 6 组断言）

**Interfaces:**
- Consumes: Task 4 的 `tools/night-dashboard.mjs`
- Produces: `起任务台.cmd`（双击入口）、`tools/start-dashboard.mjs`（脱 Job 起服务）

**⚠️ 母 agent 预检后的订正（照这个做，别照抄旧版本）：**

1. **浏览器必须开，而且只开一次。**
   旧版里 `.cmd` 走的是 `node tools\start-dashboard.mjs --direct`，而 `--direct` 分支
   **只起服务、不开浏览器** → **双击 `起任务台.cmd` 会「服务起来了，但没页面」** ——
   而「双击入口」的全部意义就是双击就有页面。
   → 现在的规则：**谁直接起服务，谁开浏览器。**
   `--direct`（.cmd 调的那条）→ 起服务 + 等端口 + **开浏览器**；
   Windows 默认路径 → 内层 `--direct` 开，**外层只打印 URL、不再开**（否则开两个标签页）；
   macOS / Linux 默认路径 → 没有内层 → 外层自己开。
2. **`ROOT` 用 `tools/paths.mjs` 导出的**，别自己 `path.resolve(__dirname, '..')` ——
   仓库惯例（`tools/start-review.mjs` 就是 `import { ROOT } from './paths.mjs';`），
   而且 `paths.mjs` 会 `loadEnv()`。
3. 端口**必须用实际值**（`.night-dashboard-port`），不能写死 8801 ——
   端口被占用时服务会顺延（8801→8810）。
4. 「已经在跑」要**只开页面、不起第二个服务**。
5. Step 1 的 8 条断言与 Step 3 的实现**已经对齐**（变量名、函数名逐字对应），
   照抄即可 —— 但 Step 1 的断言**一个字都不许改**。

---

- [ ] **Step 1: 追加会失败的断言**

```js
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
```

- [ ] **Step 2: 跑测试，确认它红**

Run: `node tools\test-night-dashboard.mjs`
Expected: FAIL —— Step 1 已经把读文件包了 `try/catch` → 读不到就是空 Buffer →
**5 条 .cmd 相关的断言全部干净地红**（每条都带了 `bytes.length > 0` 前置，
不会「文件不存在」却空过），另外 3 条 `start-dashboard.mjs` 的也红（文件还没建）。

⚠️ **不能崩**：崩掉的套件没有 `✗` 行 → Task 8 按标签 grep 会误判「没抓到」。

- [ ] **Step 3: 写 `tools/start-dashboard.mjs`**

```js
#!/usr/bin/env node
/**
 * 起定时任务台（独立进程、无控制台、**不在父进程的 Job Object 里**）。
 *
 * 跟 tools/start-review.mjs 同一个套路（**照抄它的结构**）：
 *   进程监督器给会话建了带 KILL_ON_JOB_CLOSE 的 Job，Job 一关里面的进程被强杀
 *   （无 stderr、无退出码 —— 症状跟「程序自己崩了」一模一样）。
 *   detached 挡不住（Node 的 spawn 没有 CREATE_BREAKAWAY_FROM_JOB），
 *   只有让 **explorer.exe 去起**（Explorer 本身不在任何 Job 里）才躲得开。
 *
 * ⚠️ **浏览器由「直接起服务的那个进程」来开**（规则就这一句，别搞出两个进程各开一次）：
 *   - `--direct`（根目录 .cmd 调的就是它）→ 起服务 + 等端口 + **开浏览器**
 *   - Windows 默认路径 → 经 explorer.exe → .cmd → `--direct` → **内层开浏览器**
 *     （外层只等端口、打印 URL，**不再开**，否则开两个标签页）
 *   - macOS / Linux 默认路径 → 没有内层 → 外层自己起 + 自己开
 *
 * 用法：
 *   node tools\start-dashboard.mjs            # 经 explorer.exe 脱身（推荐）
 *   node tools\start-dashboard.mjs --direct   # 直接起（由 起任务台.cmd 调用）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIRECT = process.argv.includes('--direct');
const PORT_FILE = path.join(ROOT, '.night-dashboard-port');
const PID_FILE = path.join(ROOT, '.night-dashboard.pid');
const SERVER = path.join(__dirname, 'night-dashboard.mjs');

/** 端口上有没有服务在应答。 */
function portAlive(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let done = false;
    const fin = (v) => { if (!done) { done = true; s.destroy(); resolve(v); } };
    s.on('connect', () => fin(true));
    s.on('error', () => fin(false));
    s.setTimeout(800, () => fin(false));
  });
}

function readPort() {
  try {
    const p = Number(fs.readFileSync(PORT_FILE, 'utf8').trim());
    return Number.isInteger(p) && p > 1023 && p < 65536 ? p : null;
  } catch {
    return null;
  }
}

/**
 * 打开页面。**照抄仓库既有惯例**（tools/review.mjs:1700-1709）：
 * Windows 用 `cmd /c start`，macOS 用 `open`，其他用 `xdg-open`。
 * ⚠️ 端口可能顺延 → 一定要用**实际端口**的 URL，不能写死 8801。
 * ⚠️ `start` 的第一个带引号参数会被当成标题 → 标题位置传空串 `''`（跟 review.mjs 一样）。
 */
function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {
    console.log('  （自动打开浏览器失败，手动打开 ' + url + '）');
  }
}

function startDirect() {
  const out = fs.openSync(path.join(ROOT, '.night-dashboard.out.log'), 'a');
  const err = fs.openSync(path.join(ROOT, '.night-dashboard.err.log'), 'a');
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT, detached: true, stdio: ['ignore', out, err],
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  return child.pid;
}

/** 等端口真的应答了才返回（端口文件是服务自己写的）。 */
async function waitForPort(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const p = readPort();
    if (p && await portAlive(p)) return p;
  }
  return null;
}

/** 已经有一个在跑就别起第二个 —— 直接把页面打开。 */
async function openExisting() {
  const existing = readPort();
  if (existing && await portAlive(existing)) {
    const url = 'http://127.0.0.1:' + existing + '/';
    console.log(url);
    openBrowser(url);
    return true;
  }
  return false;
}

async function startAndOpen() {
  startDirect();
  const p = await waitForPort(20000);
  if (!p) {
    console.error('任务台没能在 20 秒内起来（看 .night-dashboard.err.log）。');
    process.exit(1);
  }
  const url = 'http://127.0.0.1:' + p + '/';
  console.log(url);
  openBrowser(url);
}

if (DIRECT) {
  /* 根目录 .cmd 调的就是这条路径 → **双击入口必须能打开页面**。 */
  if (await openExisting()) process.exit(0);
  await startAndOpen();
  process.exit(0);
}

/* ---------- 默认路径 ---------- */

/* macOS / Linux：没有 Job Object 这回事，直接 detached 起。 */
if (process.platform !== 'win32') {
  if (await openExisting()) process.exit(0);
  await startAndOpen();
  process.exit(0);
}

/* ---------- Windows 默认路径：经 explorer.exe 脱身 Job Object ---------- */

const launcher = path.join(ROOT, '起任务台.cmd');
try {
  spawn('explorer.exe', [launcher], { detached: true, stdio: 'ignore' }).unref();
} catch (e) {
  console.error('调用 explorer.exe 失败：' + e.message + ' —— 退回直接启动。');
  if (await openExisting()) process.exit(0);
  await startAndOpen();   /* 退化路径：没有内层 --direct，浏览器得外层来开 */
  process.exit(0);
}

/* 外层只等端口、打印 URL —— **浏览器由内层的 --direct 进程开**，避免开两个标签页。 */
const p = await waitForPort(20000);
if (!p) {
  console.error('任务台没能在 20 秒内起来（看 .night-dashboard.err.log）。');
  process.exit(1);
}
console.log('http://127.0.0.1:' + p + '/');
process.exit(0);
```

- [ ] **Step 4: 写 `起任务台.cmd`**

⚠️ **纯 ASCII**（一个非 ASCII 字节都不行）、LF、无 BOM。

⚠️ **文件内容里不许出现中文文件名**！`起任务台.cmd` 这个名字本身有中文，
一旦写进内容（比如 `rem explorer.exe "<project-root>\起任务台.cmd"`）
→ 整个文件不再是纯 ASCII → **「起任务台.cmd 是纯 ASCII」那条断言必红**。
既有 `起审稿台.cmd` 就是用 `<this file>` 绕开这一条的，照抄那个写法。

```
@echo off
rem Task dashboard launcher.
rem
rem IMPORTANT: launch this file through explorer.exe, so the server escapes
rem the caller's Windows Job Object. A Job with KILL_ON_JOB_CLOSE kills its
rem processes with no stderr and no exit code.
rem
rem   explorer.exe "<project-root>\<this file>"
rem
rem This is only the first hop. It runs the .mjs in --direct mode, which spawns
rem the server detached (no console window).
cd /d "%~dp0"
node tools\start-dashboard.mjs --direct
```

- [ ] **Step 5: 跑测试，确认它绿**

Run: `node tools\test-night-dashboard.mjs`
Expected: PASS —— `151 通过 / 0 失败`。

- [ ] **Step 6: 双击路径验证（命令行等价）**

```powershell
explorer.exe "E:\voice-pilot\daily-image-site\起任务台.cmd"
Start-Sleep -Seconds 4
Get-Content 'E:\voice-pilot\daily-image-site\.night-dashboard-port'
Invoke-WebRequest -Uri ("http://127.0.0.1:" + (Get-Content 'E:\voice-pilot\daily-image-site\.night-dashboard-port')) -UseBasicParsing | Select-Object StatusCode
```
Expected: 端口文件里是一个 4 位数端口，HTTP 200。

- [ ] **Step 7: 提交（母本）**

```powershell
Set-Location 'E:\voice-pilot\daily-image-site'
git add -- 'tools/start-dashboard.mjs' '起任务台.cmd' 'tools/test-night-dashboard.mjs'
git commit -m "feat: 定时任务台启动器（explorer.exe 脱 Job + 纯 ASCII 入口）"
```
公开副本的同步在 Task 9 一次性做，这一轮**不碰公开副本**。

---
## Task 7: 服务端 toast `tools/notify.ps1`

**Files:**
- Create: `tools/notify.ps1`
- Modify: `tools/test-night-dashboard.mjs`（追加第 7 组断言）
- Modify: `tools/night-dashboard.mjs`（在问题变成 error 时调用 notify）

**Interfaces:**
- Consumes: `tools/night-dashboard.mjs` 的 `buildState()`
- Produces: `tools/notify.ps1 -Title <标题> -Body <正文>` —— 发一条 Windows toast，失败就静默退出 0。

**护栏数**：Task 6 落地后是 **151** 条 → 本轮 +8 = **159 通过 / 0 失败**。

**⚠️ 母 agent 预检后的订正（照这个做，别照抄旧版本 —— 旧版本有 5 处会让「正确的实现」被判红）：**

1. **断言「失败时静默退出」的正则跟实现对不上。**
   旧写法 `/-ErrorAction\s+SilentlyContinue/` —— 实现里写的是 `$ErrorActionPreference = 'SilentlyContinue'`
   （`-ErrorAction` 后面跟的是 `Preference`，**没有空格**）→ **那条正则永远匹配不上**，
   也就是说**正确的实现也会被判红**。→ 改成判「静默」这三件事：偏好 + `catch` + `exit 0`。
2. **字节断言必须兜住读取 + 带长度前置。**
   ① 直接 `fs.readFileSync` 一个还不存在的文件 → 抛 ENOENT → **整个套件崩掉**
   （崩掉的套件一条 `✗` 都没有 → Task 8 按标签 grep 会误判「没抓到」）；
   ② 空 Buffer 的 `!b.includes(0x0d)` **恒为 true** → 「文件不存在」却空过。
3. **🔴 toast 必须走 `detachedPowerShell()`，不能直接 `spawn(PS_EXE, …, { detached: true })`。**
   这是 Task 4 修复轮 2 **实测**出来的：Windows 上这样起的 PowerShell **立刻退出（exit 0）**
   → **toast 根本发不出去，而且不报错**（静默失败，最难查的那种）。
   → 本轮加一条断言**钉死**这一点（见 Step 1 的第 8 条）。
4. **BOM 必须在「跑测试」之前补。** 旧 brief 把补 BOM 排在 Step 6、跑测试排在 Step 5
   → Step 5 的 BOM 断言必红（`write` 工具默认不带 BOM，而 `param()` 默认值里有中文「任务台」）。
   → 现在补 BOM 紧跟在写文件之后（Step 3b）。
5. 护栏里的变量叫 `dash7`（不要叫 `dash`，第 4 组已经有一个 `dash` 了，会遮蔽）。

---

- [ ] **Step 1: 追加会失败的断言**

```js
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
```

⚠️ `read()` 是护栏文件里现成的辅助函数，**读不到返回空串** → Step 1 不会崩，缺失会**干净地红**。
⚠️ Step 1 的断言**一个字都不许改**（母 agent 逐条核实过它们跟实现是对得上的）。

- [ ] **Step 2: 跑测试，确认它红**

Run: `node tools\test-night-dashboard.mjs`
Expected: FAIL —— 8 条**全部干净地红**（`notify.ps1` 还不存在 → `read()` 返回空串 → 长度断言红；
字节断言因为有 `nb.length > 0` 前置而红；`dash7` 里还没有 `notify.ps1` / `osascript` / `notifyToast` → 红）。

⚠️ **不能崩**：崩掉的套件没有 `✗` 行 → Task 8 按标签 grep 会误判「没抓到」。

- [ ] **Step 3: 写 `tools/notify.ps1`**

⚠️ `.ps1` 要 **UTF-8 with BOM**（Step 3b 立刻补）—— `write` 工具默认不带 BOM。

```powershell
param(
  [string]$Title = '任务台',
  [string]$Body = ''
)

# 用 WinRT 发一条 Windows toast —— 页面关着也能收到。
# 失败一律静默：通知是补位，不是主功能，绝不能因为它掀翻主流程。
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

try {
  if (-not $Body) { exit 0 }

  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null

  # PowerShell 自己的 AUMID —— 没有它 toast 发不出去。
  $aumid = '{1AC14E77-02E7-4E5D-B744-2EB1AE519E7B}\WindowsPowerShell\v1.0\powershell.exe'

  $xml = @"
<toast scenario="reminder">
  <visual>
    <binding template="ToastGeneric">
      <text>$([System.Security.SecurityElement]::Escape($Title))</text>
      <text>$([System.Security.SecurityElement]::Escape($Body))</text>
    </binding>
  </visual>
</toast>
"@

  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($xml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid)
  $notifier.Show($toast)
} catch {
  # 发不出去就算了 —— 静默降级
}

exit 0
```

- [ ] **Step 3b: 立刻补 BOM（必须在 Step 5 跑测试之前）**

```powershell
$f = 'E:\voice-pilot\daily-image-site\tools\notify.ps1'
$txt = [System.IO.File]::ReadAllText($f, [System.Text.Encoding]::UTF8)
[System.IO.File]::WriteAllText($f, $txt, (New-Object System.Text.UTF8Encoding($true)))
$b = [System.IO.File]::ReadAllBytes($f)
Write-Output ("BOM=" + ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) + "  CR=" + ($b | Where-Object { $_ -eq 13 }).Count)
```

Expected: `BOM=True  CR=0`。

⚠️ `.ps1` = **UTF-8 带 BOM** + LF；`.mjs` = UTF-8 **不带 BOM** + LF。别搞反。

- [ ] **Step 4: 在任务台里接上**

在 `tools/night-dashboard.mjs` 的 `buildState()` 结尾（`return { ... }` 之前）加：

```js
  /* 出 error 级问题时，从服务端发一条 Windows toast —— 页面关着也收得到。 */
  try {
    if (problem && problem.level === 'error' && !notifiedFor.has(problemKey(problem))) {
      notifiedFor.add(problemKey(problem));
      notifyToast(problem.title, problem.detail || '');
    }
  } catch { /* 通知是补位，不影响主流程 */ }
```

并在文件顶部加：

```js
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
```

⚠️ `buildState()` 这个函数名**已核实存在**（母 agent 查过：`function buildState` 在 `tools/night-dashboard.mjs` 里）。
⚠️ `detachedPowerShell` 也**已核实是 export 的**（Task 4 修复轮 2 加的），同模块直接调。
⚠️ 顶层函数声明会提升 → `notifyToast` 写在文件靠前位置也能调到后面的 `detachedPowerShell`。

- [ ] **Step 5: 跑测试，确认它绿**

Run: `node tools\test-night-dashboard.mjs`
Expected: PASS —— `159 通过 / 0 失败`。

⚠️ 必须是 `✗ <label>` 的红，**不是崩**。

- [ ] **Step 6: 实跑一次 toast（弹不弹出来都行，绝不能报错）**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File 'E:\voice-pilot\daily-image-site\tools\notify.ps1' -Title '任务台' -Body '这是一条测试通知'
Write-Output ("exit=" + $LASTEXITCODE)
```

Expected: `exit=0`。

⚠️ 本机 toast 可能因为「操作中心里没登记过这个 AUMID」而**根本不弹** —— 那是正常的，
**只要 exit=0 且没有任何报错**就算通过。**不要**为了让它弹出来去改系统注册表。

- [ ] **Step 7: 提交（母本）**

```powershell
Set-Location 'E:\voice-pilot\daily-image-site'
git add -- 'tools/notify.ps1' 'tools/night-dashboard.mjs' 'tools/test-night-dashboard.mjs'
git commit -m "feat: 定时任务台服务端 toast（页面关着也能收到）"
```
公开副本的同步在 Task 9 一次性做，这一轮**不碰公开副本**。

---

### 验收标准（母 agent 会独立复核）

1. `node tools\test-night-dashboard.mjs` → **159 通过 / 0 失败**，exit 0。
2. 既有 151 条断言**逐条逐字未变**（`git diff` 里只能看到新增）。
3. 运行时 159 个标签**零重复**（源码级也不许重复）。
4. `tools/notify.ps1` → **BOM=True, CR=0**，且 `node --check` 等价的语法检查过
   （用 PowerShell 的 `[System.Management.Automation.Language.Parser]::ParseFile` 查）。
5. **实跑一次 notify.ps1 → exit=0 且无报错**。
6. `git status` 干净，提交里**只有 3 个点名文件**。
7. 编码：`tools/*.mjs` 无 BOM + LF；`tools/notify.ps1` **有** BOM + LF。

---
## Task 8: 变异护栏 `tools/test-night-dashboard-mutate.mjs`

**Files:**
- Create: `tools/test-night-dashboard-mutate.mjs`

**Interfaces:**
- Consumes: `tools/test-night-dashboard.mjs`（被验的护栏）、`tools/night-dashboard-state.mjs`、`tools/night-dashboard.mjs`（被变异的目标）
- Produces: 证明护栏有牙齿 —— 改坏解析层**和 HTTP 层**都必须被抓住。

**本轮订正（母 agent 独立核实）**：

1. **旧版只变异解析层**（6 组全在 `night-dashboard-state.mjs`）。
   但 verifier 评审实测**评审自己发现的 4 个存活变异体全在 HTTP 层**
   （`allowWrite` 顺序 / `allowWrite` 硬编码 / `findLogFor` 固定顺序 / `listen 0.0.0.0` / `/api/log` 读整份）
   —— 旧版这套脚本**一个都覆盖不到**。→ 本轮加 HTTP 层变异。
2. **旧版的「变异在副本上做，源码不动」是假的** —— 代码其实**原地改写源文件**再还原。
   中途被 Ctrl+C / 崩了 / 超时 → **源文件留在变异状态**，仓库就坏了。
   → 本轮加 `try/finally` + 退出兜底 + **还原后 sha256 校验**。
3. **期望红/绿改成子串匹配** —— 标签改了不必重写脚本（护栏的标签由实现者定，脚本不该因此报废）。

- [ ] **Step 1: 写变异脚本**

```js
#!/usr/bin/env node
/**
 * 变异测试：证明 test-night-dashboard.mjs 真的有牙齿。
 *
 * 规矩：
 *   ① 每条变异都要写明「应该红的断言」和「应该仍然绿的断言」；
 *   ② 变异点必须**恰好命中一次** —— 命中 0 次说明脚本过期了（源码改了），
 *      命中 2 次说明锚点不唯一 —— 直接 exit 1，别把「脚本坏了」混进「没抓到」；
 *   ③ **必须还原**：改的是**源文件本身**（护栏要 import 它），
 *      所以跑完必须逐字节还原，并校验 sha256。
 *      中途被打断（Ctrl+C / 崩了 / 超时）也要还原 → finally + exit 兜底。
 *   ④ **期望红 / 期望绿都用子串匹配** —— 护栏的标签以后可能会改，
 *      不该因为改了措辞就把这套脚本报废。
 *
 * ⚠️ HTTP 层的变异**绝不许真的发起一次发布**：
 *    护栏的主测试实例挂了**假的 spawn 钩子**（Task 4 修复轮加的 `opts.spawnFn`），
 *    所以即使 `allowWrite` 被改坏，也只是钩子被调用 → 不会真的 spawn。
 *    ⚠️ 别把护栏里那个 spawnFn 钩子删了 —— 删了之后这套脚本就可能真发一次。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GUARD = path.join(ROOT, 'tools', 'test-night-dashboard.mjs');
const TARGETS = {
  state: path.join(ROOT, 'tools', 'night-dashboard-state.mjs'),
  http: path.join(ROOT, 'tools', 'night-dashboard.mjs'),
};

const MUTANTS = [
  /* ── 解析层 ─────────────────────────────────────────────── */
  {
    id: 'M1', file: 'state', name: '不再剥 BOM（JSON.parse 遇到 \\uFEFF 直接抛）',
    from: 's.charCodeAt(0) === 0xFEFF ? s.slice(1) : s',
    to: 's',
    expectFail: ['stripBom 剥掉 U+FEFF', '.done 能剥 BOM 并解析'],
    expectGreen: ['stripBom 对没有 BOM 的原样返回'],
  },
  {
    id: 'M2', file: 'state', name: '时间戳正则不再允许缺省（老日志全解析不了）',
    from: "const STEP_RE = /^===\\s+(\\d+)\\/(\\d+)\\s+(.+?)\\s+===\\s*(?:\\[(\\d{2}:\\d{2}:\\d{2})\\])?\\s*$/;",
    to: "const STEP_RE = /^===\\s+(\\d+)\\/(\\d+)\\s+(.+?)\\s+===\\s+\\[(\\d{2}:\\d{2}:\\d{2})\\]\\s*$/;",
    expectFail: ['老日志（无时间戳）也能解析'],
    expectGreen: ['新格式解析出 2 个步骤'],
  },
  {
    id: 'M3', file: 'state', name: '跨零点不再 +1 天（时长会算成负数）',
    from: 'if (Number.isFinite(prevMs) && atMs < prevMs) atMs += 24 * 60 * 60 * 1000;',
    to: '/* 变异：去掉跨零点处理 */',
    expectFail: ['跨零点：后一步自动 +1 天'],
    expectGreen: ['新格式有时间戳'],
  },
  {
    id: 'M4', file: 'state', name: '阶段耗时算反了（会变成负数）',
    from: 'Math.max(0, to - steps[i].atMs)',
    to: 'steps[i].atMs - to',
    expectFail: ['阶段耗时 = 下一步时刻 − 本步时刻', '阶段耗时不会算出负数'],
    expectGreen: ['新格式解析出 2 个步骤'],
  },
  {
    id: 'M5', file: 'state', name: '分组规则把 2/3、3/3 也算进「准备」',
    from: "if (den === 3) return num === 1 ? 'prepare' : 'verify';",
    to: "if (den === 3) return 'prepare';",
    expectFail: ['2/3、3/3 归「校验与审稿」'],
    expectGreen: ['1/3 与 N/5 归「准备」'],
  },
  {
    id: 'M6', file: 'state', name: 'median 用了平均数（一个异常值就能把基准拉歪）',
    from: 'return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);',
    to: 'return Math.round(a.reduce((x, y) => x + y, 0) / a.length);',
    expectFail: ['median 用中位数不是平均数（一个异常值不能拉歪基准）'],
    expectGreen: ['median 取奇数个的中位数'],
  },

  /* ── HTTP 层（评审实测这 5 个以前全绿存活） ─────────────── */
  {
    id: 'M7', file: 'http', name: 'allowWrite 的闸门失效（写路径不再被拦）',
    from: 'if (!allowWrite)',
    to: 'if (false)',
    expectFail: ['不产生任何发布副作用'],
    expectGreen: ['/api/state → 200', '跨站 Origin → 403'],
  },
  {
    id: 'M8', file: 'http', name: 'allowWrite 被硬编码成 true（测试也会真发）',
    from: 'const allowWrite = opts.allowWrite === true;',
    to: 'const allowWrite = true;',
    expectFail: ['不产生任何发布副作用'],
    expectGreen: ['/api/state → 200', '跨站 Origin → 403'],
  },
  {
    id: 'M9', file: 'http', name: 'findLogFor 改回固定顺序（by:manual 那一夜取错日志）',
    from: "const want = done && done.by === 'manual' ? 'manual' : 'night';",
    to: "const want = 'night';",
    expectFail: ['manual 日志'],
    expectGreen: ['/api/state → 200'],
  },
  {
    id: 'M10', file: 'http', name: '服务绑到 0.0.0.0（不再只对本机）',
    from: "server.listen(chosenPort, '127.0.0.1');",
    to: "server.listen(chosenPort, '0.0.0.0');",
    expectFail: ['只绑 127.0.0.1'],
    expectGreen: ['/api/state → 200'],
  },
  {
    id: 'M11', file: 'http', name: '/api/log 读整份日志（不再只读尾部 64KB）',
    from: "const text = log ? readTail(log.file, 64 * 1024) : '';",
    to: "const text = log ? readText(log.file) : '';",
    expectFail: ['只读尾部 64KB'],
    expectGreen: ['/api/state → 200'],
  },
  {
    id: 'M12', file: 'http', name: '去掉目录穿越防护（金丝雀会漏出来）',
    from: 'if (target !== UI_DIR && !target.startsWith(UI_DIR + path.sep)) {',
    to: 'if (false) {',
    expectFail: ['目录穿越（%2f 形式）拿不到金丝雀'],
    expectGreen: ['/api/state → 200'],
  },
];

/** 护栏输出里所有「红了的断言」标签（子串匹配用）。 */
function redLabels(out) {
  return out.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('✗ '))
    .map((l) => l.slice(2));
}
function isRed(out, needle) {
  return redLabels(out).some((l) => l.includes(needle));
}
function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/* ── 还原保险 ─────────────────────────────────────────────── */
const original = new Map();
for (const [k, f] of Object.entries(TARGETS)) original.set(k, fs.readFileSync(f, 'utf8'));

let restored = false;
function restoreAll() {
  if (restored) return;
  restored = true;
  for (const [k, f] of Object.entries(TARGETS)) {
    try { fs.writeFileSync(f, original.get(k), 'utf8'); } catch { /* 还原不了就靠下面的校验报错 */ }
  }
}
/* 进程被 Ctrl+C / 崩了 / 超时 → 也要还原。 */
process.on('exit', restoreAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { restoreAll(); process.exit(1); });
}

let caught = 0;
let broken = 0;
const failed = [];

try {
  for (const m of MUTANTS) {
    const file = TARGETS[m.file];
    const src = original.get(m.file);

    /* 锚点自检：必须恰好命中一次。 */
    const hits = src.split(m.from).length - 1;
    if (hits !== 1) {
      console.log(`  ✗ ${m.id} ${m.name} —— 锚点命中 ${hits} 次（应该恰好 1 次；源码改了？）`);
      broken++;
      failed.push(m.id);
      continue;
    }
    const mutated = src.replace(m.from, m.to);
    if (mutated === src) {
      console.log(`  ✗ ${m.id} ${m.name} —— 变异没落地`);
      broken++;
      failed.push(m.id);
      continue;
    }

    fs.writeFileSync(file, mutated, 'utf8');
    let r;
    try {
      r = spawnSync(process.execPath, [GUARD], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
    } finally {
      /* 每条变异跑完立刻还原 —— 别攒到最后。 */
      fs.writeFileSync(file, src, 'utf8');
    }
    const out = `${r.stdout || ''}${r.stderr || ''}`;

    /* 护栏自己崩了 = 假红，不算「抓到」。 */
    if (/SyntaxError|Cannot find module|ReferenceError|TypeError/.test(out)) {
      console.log(`  ✗ ${m.id} ${m.name} —— 变异把护栏自己搞崩了（假红，不算抓到）`);
      broken++;
      failed.push(m.id);
      continue;
    }

    const missed = m.expectFail.filter((label) => !isRed(out, label));
    /* 期望绿的那几条**不能**跟着变红 —— 否则说明这条变异把护栏整体掀翻了，
       那是「脚本坏了」，不是「有牙齿」。 */
    const broke = m.expectGreen.filter((label) => isRed(out, label));

    if (missed.length === 0 && broke.length === 0) {
      caught++;
      console.log(`  ✓ ${m.id} ${m.name} —— 被抓住`);
    } else if (missed.length === 0) {
      console.log(`  ✗ ${m.id} ${m.name} —— 抓到了，但把不该红的弄红了：${broke.join('、')}`);
      failed.push(m.id);
    } else {
      console.log(`  ✗ ${m.id} ${m.name} —— 没抓到（应该红的没红：${missed.join('、')}）`);
      failed.push(m.id);
    }
  }
} finally {
  restoreAll();
}

/* ── 还原校验：源文件必须跟跑之前**逐字节**一样 ── */
const bad = [];
for (const [k, f] of Object.entries(TARGETS)) {
  const now = fs.readFileSync(f, 'utf8');
  if (sha256(now) !== sha256(original.get(k))) bad.push(k);
}
if (bad.length) {
  console.log(`  ✗ 源文件没还原干净：${bad.join('、')} —— 手动 git checkout 一下`);
  process.exit(1);
}

console.log(`\n变异测试：${caught}/${MUTANTS.length} 被抓到` + (broken ? `，${broken} 条脚本坏了` : ''));
if (failed.length) console.log('没过的：' + failed.join('、'));
process.exit(caught === MUTANTS.length && broken === 0 ? 0 : 1);
```

- [ ] **Step 2: 跑它，确认全抓**

Run: `node tools\test-night-dashboard-mutate.mjs`
Expected: `变异测试：12/12 被抓到`。

**如果某条没抓到**：先看是「护栏缺口」还是「锚点旧了」——
打开 `tools/test-night-dashboard.mjs` 看那条断言期望的是新结构还是旧结构：
期望**新**结构 → 锚点旧了，改 `MUTANTS` 里的 `from`；
期望**旧**结构 → 护栏真的缺这条断言，补断言。

⚠️ **锚点自检报了「命中 0 次」** → 那是**脚本过期了**（源码改了），**不是**护栏有缺口。
   别去改护栏。先看源码现在那行长什么样，把 `from` 改成新的**唯一**片段。

- [ ] **Step 3: 确认源码没被改坏**

```powershell
node tools\test-night-dashboard.mjs
```
Expected: PASS —— `159 通过 / 0 失败`（变异脚本会还原源码）。

再确认工作区干净：
```powershell
git -C 'E:\voice-pilot\daily-image-site' status --short
```
Expected: **空**（只有 Task 8 自己新建的那个文件是未跟踪的）。

- [ ] **Step 4: 提交（母本）**

```powershell
Set-Location 'E:\voice-pilot\daily-image-site'
git add -- 'tools/test-night-dashboard-mutate.mjs'
git commit -m "test: 定时任务台护栏的变异体（解析层 + HTTP 层，证明有牙齿）"
```
公开副本的同步在 Task 9 一次性做，这一轮**不碰公开副本**。

---
## Task 9: 文档 + 两仓收尾

**Files:**
- Modify: `AGENTS.md`（两仓）
- Modify: `CHECKPOINT.md`（母本）
- Modify: `CHANGELOG.md`（公开副本）
- Modify: `README.md`（公开副本）
- Modify: `.gitignore`（两仓）
- Modify: `docs/superpowers/specs/2026-11-20-night-publish-gui-design.md`（两仓）
- **本 Task 还要把 Task 1–8 的全部新增/改动文件一次性同步到公开副本**（见 Step 6）

- [ ] **Step 1: `.gitignore` 补任务台的运行时文件**

⚠️ **母本在 Task 4 里已经加好了**（4 行，别重复加）：

```
# 任务台（定时任务 GUI）的运行时文件
.night-dashboard-port
.night-dashboard.pid
.night-dashboard.out.log
.night-dashboard.err.log
```

**公开副本还没有**（已核实）→ 那边补同样这 4 行：

```powershell
$p = 'E:\voice-pilot\daily-image-site-open\.gitignore'
$txt = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)
$add = "# 任务台（定时任务 GUI）的运行时文件`n.night-dashboard-port`n.night-dashboard.pid`n.night-dashboard.out.log`n.night-dashboard.err.log`n"
if (-not $txt.Contains('.night-dashboard-port')) {
  [System.IO.File]::WriteAllText($p, $txt.TrimEnd() + "`n`n" + $add, (New-Object System.Text.UTF8Encoding($false)))
}
```

⚠️ `.gitignore` 是 **UTF-8 无 BOM + LF**（不是 `.ps1`，别带 BOM）。

- [ ] **Step 2: `AGENTS.md` 加命令表与护栏表两行（两仓）**

命令表加：

```
| **起定时任务台（默认端口 8801，占用时顺延，实值写 `.night-dashboard-port`）** | `node tools\start-dashboard.mjs`（双击根目录 `起任务台.cmd` 同样） |
| **从任何 Job Object 之外起任务台** | `node tools\start-dashboard.mjs` → Windows 内部经 `explorer.exe` 转交给根目录的 `起任务台.cmd` |
```

护栏表加：

```
| `test-night-dashboard.mjs` | 159 | 定时任务台：三个 helper 的时间戳格式 + 解析层（剥 BOM / 15 节点 / 老日志兼容 / 跨零点）+ 状态与问题判定（中位数只用成功的夜 / **`.done` 优先于日志标记 / dead 点名步骤 / 格式变了退化为 unknown 并按完成记录分级 / 阶段级慢 > 中位数 × 3（只比闭合区间）/ 06:00 闸门 / 阶段级只比闭合区间**）+ HTTP 层（本机 / 动态端口 Origin / 目录穿越金丝雀 / **写路径零副作用** / **by:manual 取 manual 日志** / **只绑 127.0.0.1** / **`/api/log` 只读尾部 64KB**）+ 启动器约定 + 服务端 toast |
| `test-portability.mjs` | 45 | 平台可移植性（**含任务台：PowerShell 可执行名按平台分，不许硬编码 `powershell.exe`**） |
| `test-night-dashboard-mutate.mjs` | 12 组变异 | 改坏**解析层和 HTTP 层**都必须被抓住（剥 BOM / 时间戳正则 / 跨零点 / 负耗时 / 分组 / median / allowWrite 顺序 / by:manual / 绑 0.0.0.0 / 读整份日志） |
```

- [ ] **Step 3: 母本 `CHECKPOINT.md` + 公开副本 `CHANGELOG.md`**

两边的「现状」段落里写清：

- 定时任务台是什么、怎么起（双击 `起任务台.cmd`）、在哪个端口
- 夜间发布的状态从哪来（`.night-publish-<日期>.log` + `.done`）
- 三个 helper 现在带 `[HH:mm:ss]` 时间戳了（Task 1），11-20 及之前的老日志没有
- 「补发某一天」会让线上首页重新指向那一天（不可逆）
- 桌面通知的边界：页面开着走浏览器通知，页面关着走服务端 Windows toast（尽力而为）

⚠️ `CHECKPOINT.md`（母本）无 BOM + LF；`CHANGELOG.md`（公开副本）是母本的**脱敏版**，无 BOM + LF。
两边都**不要**出现凭据、项目名以外的内部路径。

- [ ] **Step 4: 公开副本 `README.md`**

加一小节「本地任务台」：

```markdown
### 本地任务台（看夜间发布跑到哪了）

双击根目录的 `起任务台.cmd`（或 `node tools\start-dashboard.mjs`），
浏览器会打开 `http://127.0.0.1:8801/`（端口占用时顺延，实际值写在 `.night-dashboard-port`）。

它只读本机的发布日志和标记文件，显示每天的阶段进度、耗时和异常；
两个写操作（立即跑一次 / 补发某一天）都会先弹确认条 —— **发布不可逆**。
```

- [ ] **Step 5: 跑全量护栏（母本 + 公开副本）**

```powershell
Set-Location 'E:\voice-pilot\daily-image-site'
node tools\run-all-tests.mjs
```
Expected: `总计 35 套件：35 绿 / 0 红 / 0 崩 / 0 跳过`（34 原有常规 + 新增 `test-night-dashboard`）。
跑批器默认**不含**变异套件 —— 变异那套要单独跑：
`node tools\run-all-tests.mjs --mutate` → 46 套（35 常规 + 11 个 `-mutate`，含新增的 `test-night-dashboard-mutate`）。

```powershell
Set-Location 'E:\voice-pilot\daily-image-site-open'
node tools\run-all-tests.mjs
```
Expected: 公开副本里那 5 套**既有**环境性失败仍在（`test-rss` / `test-rss-images` / `test-product-validity` / `test-retag` / `test-webp`）——
**与本次改动无关**（已用 stash 对照实验证明过）。新增的 2 套必须绿。

- [ ] **Step 6: 一次性同步到公开副本 + 两仓提交（最后一批）**

Task 1–8 全程只在母本提交。现在把**全部新增/改动文件**一次性同步到公开副本。

```powershell
$src = 'E:\voice-pilot\daily-image-site'; $dst = 'E:\voice-pilot\daily-image-site-open'

# ① 新文件：直接覆盖（公开副本里不存在，覆盖不会毁掉任何东西）
#    ⚠️ `tools\dashboard-ui\` 是**目录** —— 公开副本里还没有（已核实），
#       不先建的话 Copy-Item 会因为「找不到路径」失败。
New-Item -ItemType Directory -Force -Path "$dst\tools\dashboard-ui" | Out-Null
foreach ($f in 'tools\night-dashboard-state.mjs','tools\night-dashboard.mjs','tools\start-dashboard.mjs',
                'tools\notify.ps1','tools\test-night-dashboard.mjs','tools\test-night-dashboard-mutate.mjs',
                'tools\dashboard-ui\index.html','tools\dashboard-ui\app.css','tools\dashboard-ui\app.js',
                '起任务台.cmd') {
  Copy-Item -LiteralPath "$src\$f" -Destination "$dst\$f" -Force
}

# ② 既有文件：**绝不覆盖** —— 两边做同样的单行编辑
#    publish.ps1 在公开副本里是占位符 your-project / your-bucket，覆盖 = 泄漏真项目名。
#    而且公开副本的 publish.ps1 还被 agent/portal 工作线改过，整体覆盖会毁掉那些改动。
#
#    ⚠️ `tools/test-portability.mjs` 也在这个列表里 —— Task 4 的修复轮给它加了 1 条断言
#       （night-dashboard.mjs 不许硬编码 powershell.exe）。**别漏**：漏了的话公开副本的
#       portability 护栏就少了这条覆盖。
#       它的改法是**追加一段断言**，不是改既有断言 —— 两边各自追加同样的内容即可。
foreach ($f in 'tools\daily.ps1','tools\daily-review.ps1','tools\publish.ps1') {
  $p = Join-Path $dst $f
  $txt = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)
  $old  = 'function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }'
  $old2 = 'function Rule($t)  { Write-Host "`n=== $t ===" -ForegroundColor Cyan }'
  $new  = 'function Step($msg) { Write-Host ("`n=== $msg ===  [" + (Get-BjNow).ToString(''HH:mm:ss'') + "]") -ForegroundColor Cyan }'
  $new2 = 'function Rule($t)  { Write-Host ("`n=== $t ===  [" + (Get-BjNow).ToString(''HH:mm:ss'') + "]") -ForegroundColor Cyan }'
  if ($txt.Contains($old))  { $txt = $txt.Replace($old,  $new) }
  if ($txt.Contains($old2)) { $txt = $txt.Replace($old2, $new2) }
  [System.IO.File]::WriteAllText($p, $txt, (New-Object System.Text.UTF8Encoding($true)))
}

# ③ 公开副本提交：只 add 本次涉及的路径
Set-Location $dst
git add -- 'tools/night-dashboard-state.mjs' 'tools/night-dashboard.mjs' 'tools/start-dashboard.mjs' `
          'tools/notify.ps1' 'tools/test-night-dashboard.mjs' 'tools/test-night-dashboard-mutate.mjs' `
          'tools/test-portability.mjs' `
          'tools/dashboard-ui' '起任务台.cmd' `
          'tools/daily.ps1' 'tools/daily-review.ps1' 'tools/publish.ps1' `
          'AGENTS.md' '.gitignore' 'README.md' 'CHANGELOG.md' `
          'docs/superpowers/specs/2026-11-20-night-publish-gui-design.md'
git commit -m "feat: 定时任务台（本地 GUI + 三个 helper 时间戳）"
```

⚠️ **spec 也已经两边各自改好了**（母 agent 2026-11-21 已把 §7.2 / §8.1 / §9 三处边界写进两仓，
两仓 SHA256 一致）→ **不要 Copy-Item spec**，只把它 add 进去提交。

⚠️ **不要 Copy-Item `AGENTS.md` / `README.md` / `CHANGELOG.md`** —— 两仓的 `AGENTS.md` 差 4KB（母本 149KB / 公开副本 153KB），
覆盖会毁掉公开副本自己的内容。Step 1–4 已经让两个仓**各自**改好了同样的内容，这里只提交公开副本这一边。

⚠️ 公开副本工作区里另有 **76 条**别的未提交改动（agent / portal 工作线，2026-11-20 实测）。
**只 `git add` 上面列出的路径**，绝不 `git add -A`、绝不 `git commit -a`、**不 push**。
提交后核对：`git show --stat HEAD` 里只有上面列出的文件。

⚠️ 写回 `.ps1` 用的是 **UTF8Encoding($true)**（带 BOM）—— 改完必须再查一次 BOM 和 CR：
`BOM=True  CR=0`。公开副本的 `publish.ps1` 改完后仍然必须留着 `your-project` / `your-bucket`。

```powershell
# 母本也提交 Task 9 的文档改动
Set-Location 'E:\voice-pilot\daily-image-site'
git add -- 'AGENTS.md' 'CHECKPOINT.md' '.gitignore'
git commit -m "docs: 定时任务台（命令表 / 护栏表 / 现状账本）"
```

- [ ] **Step 7: 端到端验收（只读）**

```powershell
node "E:\voice-pilot\daily-image-site\tools\night-dashboard.mjs"
```
浏览器打开 `http://127.0.0.1:8801/`，逐项核对：

- [ ] 顶部显示计划任务的上次/下次运行时间
- [ ] 主状态显示今天这一期的结论和总耗时
- [ ] 三组共 15 个节点，已走过的绿、没走的灰
- [ ] 有问题时有问题卡，没有时不占地方
- [ ] 最近 7 天的条带 + 展开历史表格
- [ ] 「立即跑一次」和「补发某一天」是**两个独立按钮**，点开都是带不可逆文案的确认条
- [ ] 补发的日期下拉里：源图还在的**可选**，源图已清理的**显示但禁用**并注明「源图已清理」

**这一轮只读，不点确认。**

- [ ] **Step 8: 可选 —— 开机自启（要用户同意再做）**

在 `C:\Users\pstem\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\`
放一个**指到仓库里那个 .cmd 的快捷方式**。

⚠️ **不要把 `起任务台.cmd` 本身复制过去** —— 它里面是 `cd /d "%~dp0"`，
   `%~dp0` = 文件自己所在的目录。复制到 Startup 之后它就 `cd` 到 Startup 目录 →
   找不到 `tools\start-dashboard.mjs` → **开机自启会静默失败**。
   要么放快捷方式（目标 = 仓库里那个 .cmd），要么在 Startup 里另写一个
   指向**绝对路径**的 .cmd。

（跟夜间发布走同一条路 —— 本机非管理员，`ONSTART`/`ONLOGON` 触发器用不了。）

---

## 自查（写完计划后对着 spec 过一遍）

| spec 章节 | 对应 Task |
|---|---|
| §4.1 组件 | Task 2 / 4 / 5 / 6 / 7 |
| §4.2 数据流 | Task 4 `buildState()` |
| §4.3 写操作链路 | Task 4 `guard()` + `spawnDetached()`（**不是** `spawnPublish` —— 实现里没这个函数） |
| §4.4 三个写操作的脚本与开关 | Task 4（`-Force -NoBrowser` / `-SkipReview -NoConvert -NoHeadlines`） |
| §4.5 怎么打开页面 | Task 6 |
| §5.1 三种日志源 | Task 2 `DONE_MARKERS` |
| §5.2 `.done` 的 BOM 与失败也写 | Task 2 `stripBom` / `parseDone`；Task 3 `buildCurrent` 区分 failed 与 not-run |
| §5.3 15 节点 / 3 组 / 编号做 key | Task 2 `CANONICAL_STEPS` / `groupOf` / `mergeSteps` |
| §5.4 三个 helper 加时间戳 | Task 1 |
| §6 状态机与问题判定 | Task 3 |
| §6.3 中位数只用成功的夜 | Task 3 `stepMedians` / `pickProblem` |
| §7 四个接口 + 状态码 | Task 4 |
| §8.1 首屏 | Task 5 |
| §8.2 素白文档风 + 暗色 | Task 5 `app.css` |
| §8.3 两个独立确认条 + 不可逆文案 | Task 5 `app.js` 的 `CONFIRM` |
| §8.4 通知三条腿 | Task 5（浏览器通知 + 未读问题挂条）+ Task 7（服务端 toast） |
| §9 错误处理与降级 | Task 3（状态降级）+ Task 4（HTTP 降级）+ Task 7（toast 降级） |
| §10 安全 | Task 4 `guard()`（动态端口）+ 目录穿越 `serveStatic()` |
| §11 护栏（`test-night-dashboard.mjs` **159** 条 + `test-portability.mjs` **45** 条） | Task 1/2/3/4/5/6/7 各带一组 + Task 8 变异体 |
| §12 落地顺序 | Task 1→9 顺序一致 |

**没有任务的 spec 条目**：无。§8.4 的「未读问题提示」在 Task 5 的页面里以「有 N 条未读问题」实现（`st.problems` 已有数据源）。

---

## 已知要跟用户确认的两处

1. **Task 5 Step 7 / Task 9 Step 7 之后要实跑「立即跑一次」** —— 那是**真的发布一次**，不可逆。
   → 实跑前必须先问用户。
2. **公开副本那 5 套既有红**（`test-rss` 等）—— 与本次无关，别顺手去修（那是另一条工作线）。
