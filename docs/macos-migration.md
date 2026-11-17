# 迁移到 macOS（Mac mini）

> 状态：**代码已改完并在本机（Windows）验证过；macOS 侧的真机验收还没做**。
> 没在 Mac mini 上跑通之前，不要把 Windows 那台停掉。

---

## 一、这次迁移的思路：不是「重写一套」，是「拆掉 5 处 Windows 绑定」

这个工程的入口全是 `.ps1`（`night-publish.ps1` / `manual-publish.ps1` / `publish.ps1` / `daily.ps1` …）。

macOS 那边**不另写一套 `.sh` 流程**——装 **PowerShell 7（`pwsh`）**，跑**同一份 `.ps1`**。
理由：

- 流程逻辑（期号算法、闸门、幂等标记、清孤儿顺序、发布钩子）**只有一份**，
  不会出现「两边行为慢慢分叉」；
- 已经在 Windows 上踩过的坑（stderr 掀翻、`$marker` 撞名、期号错位一天、清孤儿排在部署前）
  都留在同一份代码里，不用两边各修一次；
- 护栏（`tools/test-*.mjs`）也只需要维护一份。

代价是：`.ps1` 里所有 Windows 特有的东西必须拆掉。这些改动**全部收敛到
`tools/common.ps1`** 一个文件里，其余 `.ps1` 只调 helper。

### 拆掉的 5 处绑定

| # | Windows 写法 | macOS 上的问题 | 现在的解法 |
|---|---|---|---|
| ① | `[TimeZoneInfo]::ConvertTimeBySystemTimeZoneId(..., 'China Standard Time')` | Unix 认不出 Windows 的时区名 → **期号差一天** | `common.ps1` 的 `Get-BjNow`：两个时区 ID 都试（`China Standard Time` / `Asia/Shanghai`） |
| ② | 起子进程用 `powershell.exe` | macOS 上没这个命令 | `common.ps1` 的 `Get-ShellExe`：Windows → `powershell.exe`，其他 → `pwsh` |
| ③ | `Join-Path $Root 'tools\xxx.ps1'` | 反斜杠在 Unix 上是**合法文件名字符**，会被当成一个文件名 → 「找不到文件」 | `common.ps1` 的 `Get-ToolPath`；所有 `.ps1` 里不再出现反斜杠路径 |
| ④ | python 候选写死 `C:\Python3*`、`%LOCALAPPDATA%\Programs\Python` | macOS 上全不存在 | `daily.ps1` / `publish.ps1` 按平台分支（macOS 补 `/opt/homebrew/bin`、`/usr/local/bin`） |
| ⑤ | 图像根目录写死 `~/image-root` | macOS 上没 D 盘 | `common.ps1` 的 `Get-ImageRoot`：macOS → `~/image-root` |

另外还拆了两处**行为差异**（不是路径，但一样会让 macOS 上出怪事）：

- **审稿台的启动方式**：Windows 上要借 `explorer.exe` 脱 Job Object；
  macOS/Linux **没有 Job Object**，所以那边是反过来 —— 绝对不能调 `explorer.exe`，直接 `detached` 起。
- **原生命令退出码的语义**：PowerShell 7.4 起 `$PSNativeCommandUseErrorActionPreference` 默认 `$true`，
  「原生命令退出码非 0」会变成**终止性错误**；本工程到处是「跑一下看退出码，不行就跳过」的
  PS 5.1 老语义。`common.ps1` 把它压回 `$false`，两个平台行为才对得上。

---

## 二、前置依赖

```bash
# Homebrew 没有先装
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 必需
brew install --cask powershell     # PowerShell 7（pwsh）—— 整套流程的运行时
brew install node                  # 站点构建 + wrangler
brew install python@3.12           # 抓图 / 清洗
brew install ffmpeg                # 转码 + 见报配图
```

验证：

```bash
pwsh --version      # 期望 7.x
node --version
python3 --version
ffmpeg -version
```

### OCR 引擎（macOS 上是**新装**的）

Windows 上用的是系统内置的 WinRT OCR（`winsdk`），macOS 上没有这东西。
现在 `clean_images.py` 会按平台选：

- Windows → WinRT（**行为不变**）
- macOS/Linux → **RapidOCR**：`pip3 install rapidocr-onnxruntime`

不装也能跑 —— 会**降级**（跳过 OCR 规则 = 带广告文案的图不会被自动过滤），只是质量掉一档。
装完要单独验一次：

```bash
python3 -c "from rapidocr_onnxruntime import RapidOCR; RapidOCR()"
```

> ⚠️ **已知风险**：onnxruntime 在**这台 Windows 机器**上原生崩溃，所以 Windows 那边
> 没有装、也不该装。macOS 上是否稳定**必须在 Mac mini 上单独验**（这一条我无法在本机验证）。

---

## 三、迁移步骤

### 1. 把工程搬过去

整个工程目录拷到 Mac mini（例：`~/Sites/your-project`）。
**不要**只拷 `tools/` —— `site/`、`functions/`、`lib/`、`assets/`、`wrangler.toml`、
`package.json` 都得在。

### 2. 配 `.env.local`

```bash
cp .env.local.example .env.local    # 没有 example 的话，从 Windows 那台拷过来
chmod 600 .env.local
```

至少要有：

```
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...      # 会自动续期，见下
R2_BUCKET=your-bucket
PAGES_PROJECT=your-project
SITE_URL=https://example.com
IMAGE_ROOT=/Users/<你>/image-root
```

> `IMAGE_ROOT` **建议显式写**。现在 `tools/paths.mjs` 的默认值已经按平台分了
> （Windows `~/image-root` / macOS `~/image-root`），
> 但默认路径在**两台机器上不是同一个目录** → 显式写死同一个语义，两边才看得到同一批图。

### 2b. 只跑「审稿」的话，Mac 上需要带哪些东西

**先回答一个常见疑问：审稿台和抓图机制都是纯源码，没有可执行发行版**，
所以 Mac 上要跑，**必须把源代码搬过去**。但不是「读一遍源码才能跑」——
搬过去就能跑，理解机制看文档就行。

| 环节 | 需要带什么 | 说明 |
|---|---|---|
| **审稿台**（`node tools/review.mjs`） | `tools/review.mjs` + `tools/paths.mjs` + `tools/env.mjs` + `tools/publish-state.mjs` | 4 个文件是模块依赖，缺一个就起不来 |
| | **源图目录** `IMAGE_ROOT/src/<日期>/<分类>/` | 审稿台的缩略图**直接给源图**（不用 r2 母本）—— 母本文件名是「构建时的序号」，审稿时可能还没构建，按序号反查会 404 一片 |
| | `.env.local` | Cloudflare 凭据（发布按钮要用） |
| | 工程根可写 | 凭证 `.review-passed-<日期>`、发布日志 `.review-publish-<日期>.log` 都写在工程根 |
| **审稿台的「通过审核并发布」按钮** | **整个工程** | 这个按钮会拉起 `tools/publish.ps1` → 重建 → 传 R2 → 部署 → 清孤儿 → 还需要 `build.mjs` / `upload-r2.mjs` / `orphan-clean.mjs` / `refresh-token.mjs` / `wrangler.toml` / `site/` / `functions/` / `lib/` / `published/`。**所以「只搬审稿台」是不够的** |
| **抓图** | `tools/grab/` 整个目录 | `daily_grab_all.py` + `fetch_ledger.py`（台账）+ `clean_images.py` + `daily_headlines.py` |
| | python 依赖 | `requests beautifulsoup4 lxml Pillow imagehash opencv-python-headless<5`（opencv 锁 4.x —— 5.x 删掉了 Haar 级联） |
| | 工程根的 `.fetch-ledger.json` | **抓取台账**。它会**跟着工程一起拷过去** → 两台机器共用一份，就不重复抓同一个 URL。要让 Mac 从头抓就把它改名/删掉（各有取舍） |

> **一句话**：想在 Mac 上跑审稿 = **整个工程 + 源图目录 + `.env.local`**。
> 审稿台本身只是工程里的一小块，但它那个「发布」按钮会把整条发布链拉起来，
> 所以工程得完整。

### 3. Cloudflare 凭据

`wrangler` 的 OAuth 配置按平台分：

| 平台 | 路径 |
|---|---|
| Windows | `%USERPROFILE%\AppData\Roaming\xdg.config\.wrangler\config\default.toml` |
| macOS/Linux | `$XDG_CONFIG_HOME` 或 `~/.config/.wrangler/config/default.toml` |

在 Mac mini 上跑一次（**要人开浏览器**，没法无人值守）：

```bash
npx --yes wrangler@latest login
```

然后验证续期链路通不通：

```bash
node tools/refresh-token.mjs --check
```

> ⚠️ **不要**拿 `refresh_token` 去打一次 OAuth 端点「试一下能不能换」——
> Cloudflare **每次刷新都会轮换 refresh_token**，换了不写回 = 唯一能续期的凭据作废，
> 只能重新 `wrangler login`（要人开浏览器）。用 `--check`（只读，不刷新）。

### 4. 图像目录

```bash
mkdir -p ~/image-root/src ~/image-root/r2
```

### 5. 装 launchd 定时任务

```bash
cd ~/Sites/your-project
bash tools/macos/install-launchd.sh
```

它会：
1. 检查 `pwsh` / `node` / `python3` / `ffmpeg` 在不在；
2. 把 `tools/macos/com.your-project.night-publish.plist` 里的 `__PROJECT_DIR__`
   换成真实路径，写到 `~/Library/LaunchAgents/`；
3. `launchctl bootstrap` 装载；
4. 打印当前的电源设置和「怎么让它不休眠」。

对标关系：

| Windows | macOS |
|---|---|
| 计划任务 `DailyImageSite-NightPublish-0010`（DAILY 00:10） | `StartCalendarInterval` 00:10 |
| 启动文件夹 `your-project-night.cmd`（登录补跑） | `RunAtLoad = true` |

### 6. ⚠️ 两条「必须满足」的前提

**① 机器不能睡眠**

macOS 息屏只关显示器，后台任务照跑 —— **真正打断它的是「系统睡眠」**。

```bash
sudo pmset -c sleep 0        # 接电时永不睡眠
```

查当前设置：`pmset -g custom`（看 `sleep` 那一行）。

> Windows 那边的对应物是「高性能电源计划 + 睡眠=0 + 不启用休眠」。
> macOS 上的好处是**没有「快速启动」那类玄学**，只要不睡就一直在跑。

**② 用户不能注销**

LaunchAgent 属于用户会话 —— **注销登录后它就不跑了**（锁屏无妨）。
Mac mini 一般不会注销，但如果开了「自动登录 / 快速用户切换」要注意。

### 7. 关掉 Windows 那台的定时任务（**验收通过之后再做**）

```powershell
schtasks /delete /tn "DailyImageSite-NightPublish-0010" /f
```

> ⚠️ 两台机器同时跑 = 同一期发两遍（后跑的覆盖先跑的）。
> **验收清单全绿之前，别删 Windows 那边的任务。**

---

## 四、验收清单（跟 Windows 对照）

在 Mac mini 上逐条跑，**每条都要跟 Windows 那边对得上**。

### A. 环境

```bash
cd ~/Sites/your-project
bash tools/macos/run-night-publish.sh          # 现在是白天 → 应该被时间闸门挡住
```

- [ ] 打印「现在是 HH:mm —— 天亮了，不自动发。」，退出码 0
- [ ] **没有**产生任何上传/部署动作
- [ ] 没有生成 `.night-publish-<今天>.done`（闸门挡住时不该写标记）

### B. 护栏

```bash
node tools/test-night-flow.mjs          # 期望 50 通过 / 0 失败
node tools/test-night-flow-mutate.mjs   # 期望 28 通过 / 0 失败
node tools/test-daily-review.mjs        # 期望 41 通过 / 0 失败
node tools/test-portability.mjs         # 期望 N 通过 / 0 失败
node tools/test-orphan-clean.mjs
node tools/test-publish-natives.mjs
node tools/test-publish-state.mjs
node tools/test-contract.mjs
node tools/test-review-keys.mjs
node tools/test-build-taxonomy.mjs
```

> ⚠️ 护栏里有几条断言是**平台相关**的（`.cmd` 编码、`explorer.exe`），
> 在 macOS 上会自动走另一条分支 —— **那几条在 macOS 上数量会不一样**，属正常。

### C. 手动发布（**最关键的一条**）

```bash
pwsh -NoProfile -File tools/manual-publish.ps1
```

- [ ] 期号 = 北京今天（不是昨天）
- [ ] 抓图落在 `~/image-root/src/<期号>/`
- [ ] 构建产物 manifest 与 Windows 那边**同一天**的内容一致
      （同一天同一批源图 → manifest 的 hash 应当相同）
- [ ] 上传成功（`tools/upload-r2.mjs` 报的对象数对得上）
- [ ] Pages 部署成功
- [ ] **清孤儿排在部署之后**（日志里 sweep 在 deploy 后面）
- [ ] `.night-publish-<日期>.done` 写出来了，内容是完整 JSON
- [ ] `.manual-publish-<日期>.log` 末尾有 `=== MANUAL_DONE exit=0 ===`

### D. 线上核验

```bash
node tools/verify-news.mjs https://example.com/
```

- [ ] 跟 Windows 那边**同样的数字**（例如 53 通过 / 0 失败）
- [ ] 打开 `https://example.com/` —— 期号、图片、见报都在
- [ ] archive 目录连续，没有断期

### E. 无人值守（launchd）

```bash
# 手动触发一次 launchd 任务
launchctl kickstart -p gui/$(id -u)/com.your-project.night-publish
sleep 5
tail -30 ~/.config/../Sites/your-project/.night-publish-console.log
```

- [ ] 有输出（不是「找不到 pwsh」）
- [ ] **等到 00:10 真实触发一次**，然后查：
  ```bash
  grep 'NIGHT_DONE' .night-publish-<日期>.log
  ```
  **没有这一行 = 中途死了**，不是「成功但没写」。这时候要看
  `.night-publish-console.err.log`。

### F. 对照基准（Windows ↔ macOS）

| 对比项 | Windows 基准（2026-11-15） |
|---|---|
| 期号语义 | 期号 = 北京今天，内容 = 北京昨天 |
| 见报条目 | 232 RSS + 140 头条 / 8 分类 |
| 照片张数 | 331 张（见闻21 / 见她113 / 见笑197） |
| `verify-news` | 53 通过 / 0 失败 |
| archive | 22 期（10-25 ~ 11-15） |

macOS 上跑同一天的内容，**上面这些数字应当完全一致**。
不一致 = 抓图源或清洗规则在平台上跑出了差异（最可能是 OCR：Windows 有 WinRT，macOS 要装 RapidOCR）。

---

## 五、已知坑（macOS 特有）

1. **反斜杠**。`tools\xxx.ps1` 在 macOS 上是一个**文件名**，不是路径。
   护栏 `test-night-flow.mjs` 第 7 组专门盯这个。
2. **时区 ID**。`China Standard Time` 在 Unix 上抛异常 → 期号差一天 → 整个
   「夜里发 / 早上审」错位。护栏同样盯着。
3. **`explorer.exe`**。macOS 上没有，调用会直接抛。`start-review.mjs` 现在按平台分支。
4. **`powershell.exe`**。macOS 上没有。要用 `pwsh`。
5. **执行策略**。Unix 上没有执行策略这回事，`-ExecutionPolicy Bypass` 加了也没意义
   （`run-night-publish.sh` 里就没加）。
6. **`.cmd` 不能用**。`一键更新.cmd` / `起审稿台.cmd` / `上传图片.cmd` 是 cmd.exe 专用；
   macOS 上用 `tools/macos/*.sh`。
7. **`.ps1` 必须是 UTF-8 with BOM**。PS 5.1 没 BOM 会按 ANSI 解码 → 中文全乱码；
   **PowerShell 7 没有这个坑**（它默认 UTF-8），但两边共用同一批文件，
   所以**统一保留 BOM**，别在 Mac 上「顺手清理掉」。
8. **`onnxruntime`**。这台 Windows 机器上原生崩溃；macOS 上未验证。
9. **`.fetch-ledger.json`（抓取台账）**。它在工程根目录，**会跟着工程一起拷过去**。
   如果你希望 Mac mini 从头抓（而不是跳过 Windows 抓过的 URL），**把它改名或删掉**。
   反过来，共享它 = 两台机器不会重复抓同一个 URL —— 各有取舍。
10. **`~/image-root` → `~/image-root`**。源图和母本 `r2/` 都要在新位置，
    `IMAGE_ROOT` 要指对。
11. **`tools/paths.mjs` 的路径真源**。工程根和图像根都从它出（`ROOT` / `IMAGE_ROOT` /
    `R2_LOCAL` / `SRC_LOCAL`），**别在别的脚本里再写死一遍路径**。
    `IMAGE_ROOT` 的默认值现在按平台分（Windows `~/image-root` / macOS `~/image-root`）；
    写死的后果是**静默**的：macOS 上审稿台一张图都不显示、构建以为「今天没图」，
    而**没有任何报错**。

---

## 六、回滚

macOS 那边出问题，**不用改任何代码**：

```bash
bash tools/macos/uninstall-launchd.sh
```

Windows 那边的任务只要没删，随时接着跑。

---

## 七、这一轮**没有**验证的东西（重要）

- 上面**整张验收清单都还没跑过**（我碰不到那台 Mac mini）。
- RapidOCR 在 macOS 上的识别质量、onnxruntime 在 macOS 上稳不稳定 —— 未验证。
- `launchd` 真的在 00:10 触发过一次 —— 未验证（这是**最该先验**的一条）。
- macOS 上跑出来的 manifest 跟 Windows **字节级一致** —— 未验证。
- `build.mjs` 的转码产物在两个平台是否一致 —— 未验证（ffmpeg 版本可能不同，
  WebP 编码参数有细微差别的话 manifest 里的 hash 会不同 —— 那不影响正确性，
  但**不能用 hash 相等当验收标准**，要看图片张数和 `verify-news` 的数字）。

> 判定「能不能把 Windows 那台停掉」的标准：
> **C 段（手动发布）+ D 段（线上核验）+ E 段（launchd 真实触发）三条全绿**。
> 只跑通 A、B 段不算数 —— 那是「环境对了」，不是「流程对了」。
