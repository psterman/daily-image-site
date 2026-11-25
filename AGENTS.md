# AGENTS.md — 每日图片站（your-project）

每日自动出图 → 人工审 → 发布到 https://example.com/ 的中文图片站。
三栏照片（**见闻 / 见她 / 见笑**）+ 一栏 **见报**（RSS 热榜 + 头条）。

---

## 先读这 8 条

1. **本仓库是脱敏后的独立副本**（`psterman/daily-image-site`，MIT）—— 原站那套工程是私有的，两边**不自动同步**。改动先落在这边，再按需同步回线上。
2. **跨平台**：Windows（PowerShell 5.1 自带）+ macOS / Linux（装 pwsh 7），**跑同一份 `.ps1`**，见「macOS 迁移」一节。Node 22+ / Python 3.10+。
3. **图片不在工程目录**（由 `.env.local` 的 `IMAGE_ROOT` 决定，默认 `~/image-root`）：
   源图 `src\<发布日>\{见闻,见她,见笑}\`，转码母本 `r2\<发布日>\<分类>\*.webp`。
   目录名 = **发布日**（北京时间今天），里面装的是**昨天**的内容。
4. **审稿是硬闸门**：上传前校验凭证 `.review-passed-<日期>` —— **日期 / 总数 / 每个分类张数 / 非旧格式**四项全过才放行。
   没凭证 → `publish.ps1` exit 1，**R2 一张都不传**。删图 / 移图后凭证自动作废。
5. **不可逆动作必须拆成两个入口**：「通过审核」只生成凭证（可反复点、不上传）；
   「通过审核并发布」才推公网 + 二次确认条。`一键更新.cmd` 永远不上传不部署。
6. **改了源图（删过 / 挪过）就必须完整重建，不能 `-SkipBuild`** —— 序号前移会改产物文件名，旧产物即裂图。
7. **只改前端必须用 `--keep-manifest`** —— 见报是**构建期实时抓**的，普通 `node tools\build.mjs` 会顺手把线上内容换掉（实测一次「只改 CSS」的普通构建把 173 条里的 3 条换掉了：抽屉热榜换 1、即刻掉 2、阮一峰+知乎日报各补 1）。正确写法 `node tools\build.mjs --date <日期> --no-convert --keep-manifest`：内容字节不变 → manifest 文件名不变 → 真正变的只有 app.js/app.css。它有闸门：源图跟已发布 manifest 对不上就**拒绝构建**（说明审完动过图）。**逐期重建时最新一期放最后** —— 根路径永远指向最后构建的那一期
8. **`published/` 是部署面，不是实验区** —— `publish.ps1` 部署的是**整个 `published/` 目录**（不是只有 `--date` 那一期），所以**只要你在审稿台开着的时候重建 `published/` 里的任何一期，你那份实验版就会被用户的「发布」一起推上线**，而且根路径会跟着你重建的最后一期倒回去（2026-11-11 出过事故，见「已知坑」）。**做分类/源/前端的试验一律在 `published/` 之外建目录**（例如 `exp/`），跑完只留截图，不进 `published/`；实在要试就先把审稿台停掉、或把试验期放在最后构建并立刻还原

> **续接检查点**：同目录 `CHANGELOG.md` —— 会话被压缩 / 换人接手时读那一个就够。

---

## 每日流程

工作目录一律是工程根 `PROJECT_ROOT`。

| 做什么 | 命令 |
|---|---|
| 准备（抓图→头条→清洗→构建→自检→开审稿台） | `powershell -ExecutionPolicy Bypass -File tools\daily.ps1` |
| 准备 + 校验 + 开审稿台（桌面「一键更新」走这条） | `powershell -ExecutionPolicy Bypass -File tools\daily-review.ps1` |
| 只准备不开审稿台 | `powershell -ExecutionPolicy Bypass -File tools\daily-review.ps1 -SkipReview` |
| 指定内容日期（≠ 发布日期） | `powershell -ExecutionPolicy Bypass -File tools\daily.ps1 -ContentDate 2026-11-07` |
| 跳过抓图 / 跳过清洗 | `-NoGrab` / `-NoClean` |
| 起审稿台（默认端口 8789，占用时顺延，实值写 `.review-port`） | `node tools\review.mjs` |
| 起审稿台 + 自动开浏览器 | `node tools\review.mjs 2026-11-08 --open` |
| **从任何 Job Object 之外起审稿台**（agent / 脚本里用这个） | `node tools\start-review.mjs 2026-11-08` → 内部经 `explorer.exe` 转交给根目录的 `起审稿台.cmd`（发布日从 `.publish-date` 读） |
| 发布（续 token→构建→探 R2→闸门→上传→部署） | `powershell -ExecutionPolicy Bypass -File tools\publish.ps1 -Date 2026-11-08` |
| 只改前端、内容一个字不动 | `node tools\build.mjs --date 2026-11-08 --no-convert --keep-manifest` |
| 只重跑部署（不重建不重传图） | `powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish.ps1 -Date 2026-11-08 -SkipBuild -SkipUpload` |
| 清洗（**先干跑**） | `& python tools\grab\clean_images.py --date 2026-11-08 --dry` |
| **只刷新热榜（头条），不动图片** | `python tools\grab\daily_headlines.py` → 覆盖 `~/image-root\src\<今天>\headlines\headlines_<今天>.json`（**构建期只读不重抓**，不跑它热榜就停在早上那次） |
| 本地预览 | `node tools\dev-server.mjs 8788` |
| **构建到 `published/` 之外**（做试验**必须**用这条） | `node tools\build.mjs --date 2026-11-11 --no-convert --out PROJECT_ROOT\.exp\out` |
| **往期重分**（分类规则改了，要重算已发布各期的 tag/tags；**内容一个字节不动**） | `node tools\build.mjs --retag --date 2026-11-04` —— 旧 manifest **恒从工程 `published/<日期>/` 读**（不跟 `--out` 走），产物写回同一目录；**先写新 manifest → 再删旧 manifest → 最后改 index.html 引用**，不 rm 目录。**跟 `--keep-manifest` 互斥**；缺 `--date`、缺旧 manifest、源没配分类 → **一律 exit 1 且什么都不写**。试验用 `--out PROJECT_ROOT\.exp\retag-test` |
| 预览 `--out` 出来的产物（页面伺服它，图仍从 R2 母本取） | `node tools\dev-server.mjs 8790 PROJECT_ROOT\.exp\out r2` |
| **长驻本地预览（8790，经 explorer.exe 脱身 Job）** | `node .exp\start-preview.mjs` —— **`.exp\out` 在就伺服它，不在就伺服 `published\`**（2026-11-11 改：试验产物清掉后预览不能跟着一起废） |
| **起定时任务台（默认端口 8801，占用时顺延，实值写 `.night-dashboard-port`）** | `node tools\start-dashboard.mjs`（双击根目录 `起任务台.cmd` 同样） |
| **从任何 Job Object 之外起任务台** | `node tools\start-dashboard.mjs` → Windows 内部经 `explorer.exe` 转交给根目录的 `起任务台.cmd` |

**发布挂了直接重跑 `tools\publish.ps1 -Date <日期>`** —— 凭证是落盘的，审稿台死了也不丢。
重跑前核对凭证总数 / 分类数与源目录一致。

桌面快捷方式 `C:\Users\<user>\Desktop\一键更新.lnk` → 工程根 `一键更新.cmd` → `tools\daily-review.ps1`。
**桌面那个只是入口，逻辑只有一份。**

### 各源的时间窗口（「整理」到底覆盖哪一段时间）

**期号 = 发布日（北京今天），内容 = 内容日（北京昨天）** —— `daily.ps1:130-134`、`daily_grab_all.py:203-207`。
窗口 = **内容日的北京时区 00:00:00 → 次日 00:00:00**（`start_utc = 内容日 00:00 (BJ)`，`end_utc = start + 1 天`）。

| 源 | 分类 | 时间语义 | 代码位置 |
|---|---|---|---|
| Telegram 三频道 | 见笑 | **严格窗口**：消息时间戳必须 ∈ [内容日 00:00, 次日 00:00)，窗口外直接丢 | `daily_grab_all.py:581` `in_day(...)` |
| 煎蛋网女装区 | 见她 | 从最新页往前翻，**翻到整页都早于目标日为止**，再按日期前缀取内容日那天的帖 | `daily_grab_all.py:746-748` |
| 喷嚏图卦 | 见闻 | 按**标题里的期号**【喷嚏图卦20261104】选：① 正好等于内容日 ② 否则取「不晚于内容日」的最新一期 ③ 再没有就取最新并**告警「会提前发布」** | `daily_grab_all.py:888-945` |
| **福利吧** | 见她 / 见笑 | **没有日期窗口** —— 从 RSS 取 id 最大的**最新一期**，跟内容日无关 | `daily_grab_all.py:978-1003` |
| 头条热榜 | 见报·热议 | 抓取时刻的**快照**（构建期只读不重抓，2 小时 TTL 会告警） | `tools/headlines.mjs:68` |
| 见报 RSS | 见报 | **每次构建实时重抓** → 时间戳新鲜（相对构建时刻） | `tools/fetch-rss.mjs` |

⚠️ **推论（2026-11-15 实测）**：

- **「凌晨整理」与「早上 8 点整理」对图片是等价的** —— 窗口固定在内容日，不看运行时刻。差别只有三处：① 头条 + 见报 RSS 会停在凌晨（早上重跑一次构建就刷新）② 福利吧抓最新期，凌晨跑**更早**拿到夜里刚发的新期 ③ **上线滞后**：一张 11-15 08:00 发布的图，凌晨 02:00 跑 → 11-16 02:00 上线（滞后 18h）；早上 08:00 跑 → 11-16 08:00 上线（滞后 24h）。
- **内容日 00:00–24:00 之外发的内容不在这期里**：11-16 凌晨 0~8 点发的图属于内容日 11-16 → 要等 **11-17 那期**才上线。
- 福利吧是唯一**不受日期约束**的源 → 11-08/11-09 缺福利吧第 157 期是**源站一直没发**（`2026157.html` 404），跟抓取窗口无关。

---

### 夜间自动发布 + 早晨重发（2026-11-15 加）

**形态（用户拍板）**：夜里（**过了午夜**）自动把当期**未审稿**发出去 → 第二天早上起审稿台，审完删掉坏图后**重发一遍**（同时刷新见报）。
**已知代价**：撤回要等 24 小时边缘缓存，链接发出去就收不回来 —— 用户明确接受。

⚠️ **为什么是「过了午夜」而不是「晚上 23:00」**（2026-11-15 晚改，这是本轮最关键的修正）：

- 站点的**期号 = 发布日 = 北京今天**，而**抓图落盘的目录 = `bj_today`（下载当天）**，跟内容日无关 —— 也就是说**期号由「跑的那一刻是几号」决定**。
- 于是 **23:00 跑算出来的是「当天早上已经发过」的那一期**（白跑一遍，还会把早上那一期重新抓一遍）；而第二天早上审稿台审的是「北京今天」那期，**跟夜里发的差一天** —— 审的其实是**还没发出去**的一期。
- **过了午夜再跑**，「北京今天」才正好等于「第二天早上要审的那一期」✓ 而且内容窗口（昨天 00:00–24:00）到午夜才关闭，这时抓才是完整的。
- 顺带结论：**「明天那期」不需要额外实现** —— 凌晨 00:10 发出去的期号就是「明天那期」，因为过了午夜「北京今天」已经翻页了。

| 时点 | 谁触发 | 做什么 | 闸门 |
|---|---|---|---|
| 过了午夜 00:10 | 计划任务 `DailyImageSite-NightPublish-0010`（DAILY） | `tools\night-publish.ps1` → 准备 + 发布当期 | 时间闸门（**BJ 00:00–05:59**）+ 幂等标记 |
| 开机 / 登录 | Startup 文件夹 `your-project-night.cmd` | 同上（包 `tools\night-publish.cmd`） | 同上（天亮后被闸门挡掉，exit 0） |
| **随时（手动）** | **桌面「上传图片」双击** | `tools\manual-publish.ps1` → 准备 + 发布当期 | **无时间闸门**（手动点就是有意的） |
| 早上 | 人（或 `tools\morning-review.ps1`） | 起审稿台 → 审 → 点「通过审核并发布」 | 审稿闸门（凭证 `.review-passed-<日期>`） |

**脚本**

- `tools\night-publish.ps1` —— 夜间主脚本（UTF-8 BOM / LF）：① 时间闸门（**BJ 00:00–05:59**，`-Force` 可越过）② 幂等（`.night-publish-<日期>.done` 里 `"exit":0` → 跳过）③ `daily-review.ps1 -SkipReview -NoBrowser`（准备：抓图→头条→清洗→构建→自检）④ `publish.ps1 -Date <D> -SkipReview -NoConvert -NoHeadlines`（发布，跳过审稿闸门）⑤ 写标记 + `=== NIGHT_DONE exit=N ===`
- `tools\morning-review.ps1` —— 早晨起审稿台（期号默认北京今天）→ `node tools\start-review.mjs <日期>`（**经 explorer.exe 脱 Job Object**）→ 开浏览器 → 提示「审完点通过审核并发布」
- `tools\manual-publish.ps1` —— **手动上传**（桌面双击入口）：跟夜间同一套流程，差三件事 —— **没有时间闸门**、当天已发过会**先问一句**、日志另开一份（`.manual-publish-<日期>.log` + `=== MANUAL_DONE exit=N ===`）。**幂等标记跟夜间共用同一个文件**（`.night-publish-<日期>.done`）→ 谁先发过另一边就不重复上传
- `tools\night-publish.cmd` —— 计划任务入口（**纯 ASCII / LF / 无 BOM**；**绝不能有 `pause`** —— 无人值守会永远挂在那儿）
- 工程根 `上传图片.cmd` + 桌面 `上传图片.lnk` —— **手动上传的双击入口**（`.cmd` 必须是**纯 ASCII**：cmd.exe 的 `chcp 65001` 对中文正文不可靠；末尾**有** `pause` —— 手动双击的窗口不能一闪而过）
- Startup 入口：`C:\Users\<user>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\your-project-night.cmd`

**手动入口发的是哪一期**：**今天该发的那一期**（期号 = 北京今天，内容 = 北京昨天→今天）。早上点最自然。**重复抓图不会把用户删掉的图带回来** —— 抓取台账（`.fetch-ledger.json`）在发请求前就跳过「以前抓过的 URL」✓

**早晨重发顺手把热榜刷成最新的** —— 审稿台的发布走 `publish.ps1 -Date <日期>`（**不带** `-NoHeadlines`），而 publish.ps1 的榜刷新只在 `-Date == 北京今天` 时触发 → 早上那次重发**顺带刷新热榜**（榜从「58 分钟旧」变「2 分钟旧」）。夜里那次带 `-NoHeadlines`（准备那步已经抓过，再抓一次白等 4 分钟）。

**`publish.ps1` 本轮新增**

- `[switch]$NoHeadlines` —— 跳过「构建前重抓头条」
- `Find-Python` helper —— 真的跑一次 `--version` 判活（WindowsApps 那个是占位壳，会 exit 9009）
- **1a 榜刷新**（**仅** `-Date == 北京今天`；往期补发**绝不刷**，否则内容时间倒错）→ `python tools\grab\daily_headlines.py`，失败只告警不阻断
- **1b 孤儿 capture**（构建前）→ `node tools\orphan-clean.mjs --date <D> --capture`
- **4.5 孤儿 sweep**（**部署成功之后**）→ `node tools\orphan-clean.mjs --date <D> --sweep`；**只在「既构建又上传又部署」时清** —— 否则删掉的可能是线上正在用的图 = 裂图。失败只告警不阻断发布。⚠️ **清孤儿必须排在 Pages 部署之后**（2026-11-15 晚改）：上传完那一刻线上还指着**旧 manifest**，这时删旧对象 = 把线上正在用的图删了；**部署要是失败，线上就会一直裂着**，直到下次发布成功才恢复。部署成功后再删才安全

**R2 孤儿清理（`tools\orphan-clean.mjs`，新增）**

孤儿 = **旧 manifest 引用过、新 manifest 不再引用**的 R2 对象。审稿删图会让序号平移 → 整期换名 → 旧对象成孤儿（实测约 25 MB/天）。

| 命令 | 作用 |
|---|---|
| `--capture` | 构建前抓旧 manifest 的键集 → 状态文件 `ROOT/.orphan-<日期>.json` |
| `--plan` | 干跑：只报「会删哪些」，不真删 |
| `--sweep` | 上传后删差集里的孤儿；成功后自清状态文件 |
| `--probe-delete` | 删一个不存在的键，验证 REST 链路通不通 |

⚠️ 三个坑：

- **manifest 的 hash 是 base-36 不是 hex**（`manifest.glbf83.js` / `2kxqkw.js` 带 g/l/k/x/q/w）→ 找文件用 `[0-9a-z]+`；用 `[0-9a-f]` **一个都匹配不上** → 键集 0 个 → 清理**静默不干活**
- **删除成功要看响应体，不能只看 HTTP 码** —— Cloudflare REST DELETE 一个不存在的键返回 **HTTP 200 + `success:false` + `code 10007`** → 那是幂等成功；`code 10000` 才是真失败
- **R2 REST 没有 list 接口** → 孤儿只能靠「旧 manifest vs 新 manifest 差集」定位，列举不了整个 bucket

**计划任务**

- ✅ `DailyImageSite-NightPublish-0010` —— DAILY **00:10**，`Task To Run = PROJECT_ROOT\tools\night-publish.cmd`，`StartWhenAvailable = True`（**错过了会在下次开机时补跑** —— 补跑时若还没到 06:00 就照常发）
- ❌ **ONSTART / ONLOGON 建不了** —— 本机不是管理员，`schtasks` 报 `Access is denied`（DAILY 不需要管理员）→ 开机触发改用 **Startup 文件夹**（语义是「用户登录」，不是「系统启动」）
- 机器重启会带走长驻进程 → 计划任务会重投，但**审稿台不会自动起来**（早晨要么人起，要么跑 `tools\morning-review.ps1`）

**护栏（都有牙齿）**

- `tools\test-orphan-clean.mjs` —— **46/0**
- `tools\test-night-flow.mjs` —— **50/0**（用 `stripComments` 剥掉注释再断言，避免脚本里的反面示例误伤；第 7 组是跨平台那一组）
- `tools\test-portability.mjs` —— **44/0**（跨平台护栏，见下节）
- `tools\test-night-flow-mutate.mjs` —— **38/0**（**37 处变异全被抓**；变异体写在 `tools\.tmp-night-mut\`，跑完自清）—— 变异体包括「闸门又改回 20:00」「手动入口也加上夜间闸门」「幂等标记不跟夜间共用」「.cmd 里混进中文」「去掉 Asia/Shanghai 兜底」「路径又用反斜杠拼」
- `tools\test-night-hardening.mjs` —— **46/0**（2026-11-25 那轮夜间加固的契约：告警下沉（`Send-Alert` 在 common.ps1 / 失败才发 / 通知失败不掀翻主流程）+ 看门狗（`.done` 判定 / exit≠0 不重复告警 / `.cmd` 纯 ASCII 无 pause / 参数透传）+ 抓图总预算（**每个源都查**）+ pHash 增量缓存（**mtime+size 都要比** / 原子写盘 / 新图登记进缓存 / **改模块级标志位的函数必须有 `global` 声明**）+ RSS 换源（**V2EX 官方 / NYT中文+法广中文走 bestblogs / DW 中文已删 / 不许加回用户移除过的源**）+ 日志轮转（切历史不删文件 / 夜间流程最后调）。第 7 组读实机计划任务设置，**只在传 `SCHED_SETTINGS_FILE` 时才断言**，否则跳过）
- `tools\test-night-hardening-mutate.mjs` —— **18/18 全被抓**（证明上面那套护栏**真的有牙齿**：改坏告警链路 / 看门狗 `.cmd` / 抓图预算 / pHash 缓存键 / **两处 `global` 声明** / RSS 地址 / 日志轮转。⚠️ 第一版有 **4 个假绿** —— 只查「函数名出现过」，变异把**调用**换掉也不红 → 已改成**查结构不查词 presence**）
- `tools\test-product-validity.mjs` —— **43/0**（产物有效性三道闸门，见「产物有效性」一节；**真跑**三份脚本，临时工程在 `tools\.tmp-product-validity\`；全程用夹具把 `fetch` 换掉 —— **一个网络请求都发不出去**）
- `tools\test-product-validity-mutate.mjs` —— **10/10 全被抓**（每条变异还指定了「必须保持绿」的断言 —— 红的正好是指定的那几条，不是别的断言碰巧红了）

**踩过的坑**

- **⚠️ PowerShell 变量名**大小写不敏感** → `$marker` 和 `$Marker` 是同一个变量** —— 2026-11-15 傍晚真踩了：
  ```powershell
  $Marker  = Join-Path $Root ".night-publish-$Date.done"   # 路径
  $marker = @{ date=...; exit=... } | ConvertTo-Json       # ← 同一个变量！路径被覆盖
  Set-Content -Path $Marker -Value $marker -Encoding UTF8  # 报「找不到与参数名称"Encoding"匹配的参数」
  ```
  路径被换成一段 JSON（带换行和 `{`）→ 参数绑不上 → **标记文件根本写不出来** → 幂等失效 → 每次都重发一遍，而且脚本 exit 1。**修法：JSON 变量改名 `$markerJson`**（护栏 `test-night-flow.mjs` 第 6 组专门盯这个撞名）
- **PS 5.1 子进程 stderr → ErrorRecord** —— 顶着 `$ErrorActionPreference='Stop'` 会被掀翻（和 11-14/11-15 两次发布死掉的是同一个坑）→ 夜间脚本所有子进程统一走 `Invoke-Child`（内部降 Continue、只看 `$LASTEXITCODE`）
- **node CLI 入口在 Windows 必须用 `pathToFileURL(process.argv[1]).href`** —— 手写 `file://${argv[1]}` 得到 `file:///E:/...`（三个斜杠）→ `main()` 根本不跑 → **exit 0 但零输出**（脚本变死的）。再加 `process.argv[1] &&` 防 import 时炸
- **`--date` 空格写法和 `--date=` 都要认** —— publish.ps1 传的是空格写法，只认 `--date=` 会直接报用法退出
- **`daily_grab_all.py --out` 只能换输出根目录，换不了日期目录** —— 日期目录恒为 `OUT_BASE/<bj_today>/`（`cat_dir_for`，`daily_grab_all.py:284-285`）。所以「晚上点、提前发明天那期」**光靠参数做不到**，得改抓图脚本
- **构建前抓的「旧键集」在「准备步已经构建过」的情况下是空的** —— 夜间/手动流程里 `daily-review.ps1` 先构建了一次，`publish.ps1` 再 capture 时拿到的已经是**新 manifest** → 差集为空 → 这次没东西可清（正常，**没有孤儿**）。**孤儿真正出现是在「早晨审稿删图 → publish.ps1 重建」那条路径上**（capture 拿到的是删图前那一代）

✅ **夜间链路（无人值守）已真跑通** —— **2026-11-16 00:10:01 起跑 → 00:21:40 结束，`=== NIGHT_DONE exit=0 ===`**（耗时 11 分 40 秒）。这是这套流程**第一次**由计划任务无人值守地跑完整条链（抓图 → 头条 → 清洗 → 构建 → 自检 → token 续期 → 重建 → 传 R2 → 部署 → 清孤儿 → 写标记）。部署快照 `https://074b1231.your-project.pages.dev`，线上与本地 manifest **SHA256 逐字节一致**，archive 23 期。

> 首次真跑暴露的两个**非致命**现象（都符合预期）：
> - **福利吧 116 张全被台账跳过** → 日志提示「这一期 2026-11-14 已经抓过 —— 源站大概率还没发新一期」。福利吧只取最新一期，**源站不出新期 → 见笑数量会掉**（11-16 的见笑 99 张 vs 11-15 的 197 张）。这不是 bug。
> - **知乎 401** → cookie 过期的老问题，不影响发布。

### 夜间链路的加固（2026-11-25 加）

体检发现四个问题，都已修掉。**根因都不是「代码写错了」，是「环境变了但没人管」**。

**① 告警链路是断的 —— 夜里失败时一个通知都不会发**

- 原来 toast **只有定时任务台**（`night-dashboard.mjs`）在它自己判定出错时才发，而任务台是**手动起的 GUI 进程**（`起任务台.cmd`）、**没有任何自启动**（Startup 文件夹 / Run 注册表 / 计划任务里都没有）→ 机器每次重启就没了。
- 现在 `common.ps1` 加了 `Send-Alert`（**公共 helper**，走 `Get-ToolPath` 拼路径 + `Invoke-PsScript` 起子进程），`night-publish.ps1` 的**失败分支**自己发 toast（**成功不发** —— 每晚一条没人受得了）。
- ⚠️ **「进程被硬杀」这条路径本来是完全静默的**（没有 catch、没有 toast、连 `=== NIGHT_DONE ===` 都没写）→ 新增 `tools\night-watchdog.ps1` + `tools\night-watchdog.cmd`，计划任务 **`DailyImageSite-NightWatchdog-0130`**（DAILY **01:30**）在发布窗口之后查一次：`.done` 不存在 → 告警。**刻意不判「日志停摆多久」**（那类判据会误报，见「读日志的坑」）。
- ⚠️ **机器每晚定时关机**（用户习惯，不是计划任务）→ 01:30 的看门狗**有可能压根没机会跑**。这是已知缺口，不假装解决。

**② 计划任务 `ExecutionTimeLimit` 从 `PT72H` 改成 `PT2H`**

- 原来 `PT72H`（3 天）+ `MultipleInstances = IgnoreNew` → **一次卡死 = 之后 3 天的触发全被忽略**，既不报错也没告警。
- 实测最慢的一晚是 34 分 47 秒 → 2 小时留得够。顺带开了 `AllowStartIfOnBatteries` + `DontStopIfGoingOnBatteries`（笔记本合盖/切换电源时不该把夜间链路掐掉）。
- ⚠️ 改之前 `schtasks` 的这些设置**不在源码里**（是计划任务属性），所以护栏钉不到 —— `test-night-hardening.mjs` 第 7 组**只在传入 `SCHED_SETTINGS_FILE` 时才断言**，否则跳过（不让「跑测试的机器没建这个任务」把护栏搞红）。

**③ 抓图阶段加了总时间预算（防关机硬杀）**

- 抓图耗时随上游剧烈波动：实测 **446 / 573 / 675 / 638 / 1701 秒**（最慢那晚是 t.me `read timeout=20` 反复出现）。
- 而机器定时关机、发布 00:10 起跑 —— 有一次发布 00:22:16 结束、00:27:37 关机，**余量只有 5.3 分钟**。
- 现在 `tools/grab/daily_grab_all.py` 支持 `MEMES_GRAB_BUDGET_SEC`（环境变量），`night-publish.ps1` 设 **1500 秒（25 分钟）**。**超了就带着已抓到的素材继续，剩下的源跳过** → 宁可少几张图，这一期也要按时发出去。
- 判据**只在源之间检查**（不是每张图都查）—— 单个源内部中断会留下不完整的素材。

**④ pHash 索引改持久化增量缓存**

- 原来每晚把整个图库（跨所有日期目录）逐张打开算 pHash：实测 7414 张要 **94~116 秒**，而且**随图库线性增长**（9 天涨 42%：5269 → 7504 张）→ 这段纯 CPU 开销每天都在涨，却对「当天发什么」毫无贡献。
- 改成按 **(path, mtime, size)** 缓存 hash（`.phash-cache.json`，工程根）：文件没变就复用，变了才重算。**实测 116.7 秒 → 1.9 秒（61 倍）**，缓存 hash 与重算**逐字一致**。
- ⚠️ **缓存键必须含 mtime 和 size**：只按 path 缓存的话，同名文件被覆盖（审稿台删图重发）会拿到**过期 hash** → 用错的 hash 判重 → **真重复漏拦 / 误删真图**。
- ⚠️ 缓存读不出来（文件坏了 / JSON 坏了）→ **退回全量重算**，绝不抛异常（缓存只是加速器）。
- ⚠️⚠️ **改模块级标志位必须写 `global`** —— **2026-11-25 端到端实测真踩过**：Python 里**赋值即声明局部变量**，少了 `global _PHASH_CACHE_DIRTY` 就会：① `main()` 末尾的 `if _PHASH_CACHE_DIRTY:` 报 **`UnboundLocalError`**（而且是**流程最后一步**崩 → 前面抓的图全白抓）② `_phash_cache_register()` 里的赋值传不到模块级 → **缓存攒一晚永远不落盘** → 新图白算。护栏 `test-night-hardening.mjs` 专门盯着这条（`pyMissingGlobal()`：先抹注释和字符串、再按缩进算作用域 —— ⚠️ **别用「按 `\ndef\s+` 切字符串」的糙办法**：模块顶层的赋值会被算成「某个函数改了它」→ 误报红；docstring 里写的反面示例也会被当成真赋值）。

**⑤ 三个中文 RSS 源被网络层拦死 → 换掉**

- **根因不是源坏了，是这台机器的网络层拦的**（Node 与 PowerShell 两种运行时实测一致）：`rss.dw.com` DNS 解析成 **0.0.0.0**（污染）；`cn.nytimes.com` / `rss.mifaw.com` / `www.rfi.fr` 全部 **`ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE`**。**换域名解决不了**，必须走国内通道。
- 换法：**V2EX 热榜 → 官方 `www.v2ex.com/feed/tab/hot.xml`**（官方比 RSS屋镜像更稳）、**纽约时报中文 → `rsshub.bestblogs.dev/nytimes/world`**、**法广中文 → `rsshub.bestblogs.dev/rfi/cn`**。
- ⚠️ **`德国之声中文` 已删除**：DNS 被污染，且 RSSHub 上没有对应中文路由（`dw/zh` / `dw/chinese` / `dw/chi` 全 404，`dw/news` 是**英文**源违反「只收中文」硬约束）→ 它的位置由**法广中文**接替（同为欧洲国际广播机构、同样有中文节目）。
- ⚠️ **`rsshub.app` 公共实例已被风控（403）**，能用的是 `rsshub.bestblogs.dev`。
- ⚠️ 删源要**同步删 `tools/news-taxonomy.json` 里的 `sourceCategory` 映射**（`test-news-taxonomy.mjs` 断言「源数量 == 映射数量」且「没有已下线的源」）。
- ⚠️⚠️ **RSSHub 镜像源要按 host 放宽超时**（**2026-11-26 夜跑实测**）：换源后第一晚「**法广中文**」就**超时丢了** —— 根因是 **RSSHub 的路由是现生成的**，缓存过期后第一次访问要重新生成，**冷启动可能跑几十秒**，而全局 `timeoutMs` 只有 15 秒 → 连超时 3 次（15s × 3 + 退避 ≈ 47 秒）仍失败 → **该源当晚贡献 0 条**（不是源坏了，几小时后复探又是 44 条 / 2.4 秒）。
  - **解法**：新增顶层 **`timeoutMsByHost`**（按 host 设默认超时），`rsshub.bestblogs.dev` → **45 秒**；单个源还能用 `timeoutMs` 字段再单独覆盖。**优先级：单源 > 按 host > 全局**。
  - **为什么按 host 设而不逐个源写**：同一 host 下行为完全一样（这个 host 上有十几个源），逐个写要多十几行重复配置；**公开副本这边同一个 host 下有几百个源 —— 一行顶几百行**。
  - ⚠️ 抓取是**限流并发**的（`mapPool`）→ 放宽某个 host 的超时**不会**把总时长乘以源数量，墙钟最多多等一轮超时。
  - ⚠️ `--probe` 也走同一套规则 —— 否则会出现「探测 3 秒过了、夜里 15 秒超时」的假象。
  - **护栏**：`test-rss.mjs` 里那组是**真跑出来的**（本地慢服务器 600ms + 超时 200ms → 必须失败；同 URL + 按 host 3000ms → 必须成功），不是查源码。

**⑥ 日志轮转**

- `.night-publish-console.log` / `.daily-review.log` 是 `cmd >>` 写出来的 —— **只追加、永不清理**（实测 11 天涨到 505 KB / 664 KB）。
- `tools/rotate-logs.mjs`：**切历史 + 原地清空**（**不能删文件** —— `cmd >>` 占着句柄删不掉），保留最近 7 份；夜间流程最后调（成功失败都轮），轮转失败**不影响发布结果**。
- 台账 `.fetch-ledger.json` **不在这里管** —— 它有自己的保留策略（`fetch_ledger.py` 的 `KEEP_DAYS = 120`）。

---

## macOS 迁移（2026-11-15 晚做的准备，**真机未验证**）

用户要把这套搬到 **Mac mini**（那台机器自动息屏，问「息屏还能不能跑」）。

### 思路：不是重写一套 `.sh`，是**装 PowerShell 7 跑同一份 `.ps1`**

macOS 上装 `pwsh`（`brew install --cask powershell`），**跑同一批 `.ps1`**。
理由：流程逻辑（期号算法、闸门、幂等、清孤儿顺序、发布钩子）**只有一份**，不会出现两边行为慢慢分叉；踩过的坑也只用修一次。

代价：`.ps1` 里所有 Windows 绑定必须拆掉。**这些改动全部收敛到 `tools\common.ps1`**（新增，UTF-8 BOM / LF），其余 `.ps1` 只调 helper。

### 拆掉的 5 处绑定（+2 处行为差异）

| # | Windows 写法 | macOS 上的问题 | 现在的解法（都在 `tools\common.ps1`） |
|---|---|---|---|
| ① | `ConvertTimeBySystemTimeZoneId(..., 'China Standard Time')` | Unix 认不出 Windows 的时区名 → **期号差一天** | `Get-BjNow`：两个时区 ID 都试（`China Standard Time` / `Asia/Shanghai`）；`Get-BjDate` 是它的字符串版 |
| ② | 起子进程用 `powershell.exe` | macOS 上没这个命令 | `Get-ShellExe`：Windows → `powershell.exe`，其他 → `pwsh` |
| ③ | `Join-Path $Root 'tools\xxx.ps1'` | **反斜杠在 Unix 上是合法文件名字符** → 会被当成一个文件名 → 「找不到文件」 | `Get-ToolPath`；所有 `.ps1` 代码里**不再出现反斜杠路径** |
| ④ | python 候选写死 `C:\Python3*` / `%LOCALAPPDATA%\Programs\Python` | macOS 上全不存在 | `daily.ps1` / `publish.ps1` 按平台分支（macOS 补 `/opt/homebrew/bin`、`/usr/local/bin`） |
| ⑤ | 图像根目录写死 `~/image-root` | macOS 上没 D 盘 | `Get-ImageRoot`：macOS → `~/image-root`；`Get-SourceDateDir` 拼 `src/<日期>` |

另外两处**行为差异**（不是路径，但一样会让 macOS 上出怪事）：

- **审稿台的启动方式**：Windows 上要借 `explorer.exe` 脱 Job Object（Explorer 不在任何 Job 里，它拉起的子进程也继承不到）。
  macOS/Linux **没有 Job Object 这回事** → 那边是**反过来**的要求：**绝对不能调 `explorer.exe`**，直接 `detached` 起就行。
  `tools\start-review.mjs` 现在按 `process.platform` 分支；`tools\review.mjs` 的「点发布」spawn 同理（Windows 仍是 `cmd /c start /b powershell`，macOS 走 `pwsh` + `detached`）。
- **原生命令退出码的语义**：PowerShell **7.4 起** `$PSNativeCommandUseErrorActionPreference` 默认 `$true`，
  「原生命令退出码非 0」会变成**终止性错误**；而本工程到处是「跑一下看退出码，不行就跳过」的 PS 5.1 老语义
  （依赖自检、token 续期、构建校验……）。
  `common.ps1` 把它压回 `$false`，两个平台的行为才对得上。

### macOS 部署包（`tools\macos\`）

| 文件 | 作用 |
|---|---|
| `run-night-publish.sh` | launchd 的入口：找到 `pwsh` → 跑 `tools/night-publish.ps1`（**跟 Windows 同一份**） |
| `com.your-project.night-publish.plist` | launchd 定时任务模板（`__PROJECT_DIR__` 由安装脚本替换） |
| `install-launchd.sh` | 装依赖检查 + 写 plist 到 `~/Library/LaunchAgents/` + `launchctl bootstrap` + 打印睡眠设置 |
| `uninstall-launchd.sh` | `launchctl bootout` + 删 plist（**不动工程里的任何东西**） |

对标关系：Windows 的计划任务 `DailyImageSite-NightPublish-0010`（DAILY 00:10）→ `StartCalendarInterval` 00:10；
Windows 的 Startup 文件夹 → `RunAtLoad = true`。

### macOS 的两条硬前提

1. **机器不能睡眠** —— macOS 息屏只关显示器，后台任务照跑；**真正打断它的是「系统睡眠」** → `sudo pmset -c sleep 0`。
2. **用户不能注销** —— LaunchAgent 属于用户会话，注销后就不跑了（**锁屏无妨**）。

### 迁移手册

`docs/macos-migration.md` —— 依赖清单、迁移步骤、**跟 Windows 对照的验收清单**（A~F 六段）、10 个 macOS 特有坑、回滚。

⚠️ **这一整节的东西在 macOS 上都没真机验证过**（我碰不到那台 Mac mini）。
判定「能不能停掉 Windows 那台」的标准是手册里的 **C（手动发布）+ D（线上核验）+ E（launchd 真实触发）三条全绿**；
只跑通 A（环境）、B（护栏）不算数。

### 跨平台护栏

- `tools\test-portability.mjs` —— **41/0**（macOS 部署包 / launchd 定时点对齐 / Python 侧 / Node 侧 / 全局残留扫描）
- `tools\test-night-flow.mjs` **第 7 组** —— 11 条（跨平台 helper：时区两种 ID、shell 按平台、图像根目录按平台、
  **没有 `.ps1` 自己换算时区**、**没有 `.ps1` 硬编码 `powershell.exe`**、**没有 `.ps1` 拼反斜杠路径**）
- `tools\test-night-flow-mutate.mjs` —— **6 处新的跨平台变异体**（去掉 Asia/Shanghai 兜底 / 只认 powershell.exe /
  又自己写时区换算 / 路径又用反斜杠 / 不 dot-source helper / OCR 不按平台选 / 默认目录写回别人机器的路径 /
  build.mjs 只用 where / refresh-token 只用 Windows 路径 / start-review 不按平台分支 / plist 定时点改 00:30）
- `tools\test-daily-review.mjs` —— `.cmd` 编码 / `explorer.exe` / `powershell` 这些断言**按 `process.platform` 分支**
  （macOS 上改查 `.sh` 那套；`spawnSync('powershell')` → `spawnSync('pwsh')`）

### 读日志的坑

`.night-publish-console.log` 是 **UTF-8 无 BOM**（`cmd >>` 重定向写出来的）。
**PS 5.1 的 `Get-Content` 会按 ANSI（GBK）解码 → 中文全是乱码**。
要显式指定编码：

```powershell
[System.IO.File]::ReadAllText('.night-publish-console.log', [System.Text.Encoding]::UTF8)
```

（日志本身没问题，**乱码只是读法的问题**。）

---

## 音乐榜 / 影视榜（2026-11-16 加，**代码就绪、还没上线**）

给站点加了两个**文本型 tab**：`music`（听乐，网易云热歌榜）和 `movie`（看片，豆瓣 Top250 + B站热门）。

两条铁律：

1. **不托管任何音视频文件**。用户明确「可以搜索、不能下载」—— 榜单条目只带标题/歌手/封面 URL/外链，
   播放和观看都在对方站点发生。这不只是版权问题，也是**成本问题**：
   自托管视频会同时咬三个额度（R2 存储先爆、Workers 的 Range 请求暴涨、每次部署全量重传 `published\`）。
2. **运行时零消耗**。榜单在**构建期**抓（`tools\fetch-rank.mjs`），烘进 manifest；
   音乐的全网搜走 **iTunes Search API，浏览器直连** —— 那家的响应头是 `Access-Control-Allow-Origin: *`，
   实测**带 Origin 头也照样放行**（`Origin: null` 除外）→ 完全不经过本站的 Cloudflare →
   **0 次 Workers 请求、0 次 R2 操作**。

### 数据源（2026-11-16 实测）

| 用途 | 源 | 结果 |
|---|---|---|
| 音乐榜 | 网易云热歌榜 `music.163.com/api/playlist/detail?id=3778678` | 200 首，免 key |
| 影视·电影 | 豆瓣 Top250 `movie.douban.com/top250` | **250 条要翻 10 页**（首页只给 25 条） |
| 影视·视频 | B站热门 `api.bilibili.com/x/web-interface/popular` | 50 条，免 key |
| 音乐全网搜 | iTunes Search `itunes.apple.com/search` | CORS `*` → 前端可直连 |
| ❌ | B站 `ranking/v2` | 被风控挡了，返回 `code:-352` |
| ❌ | iTunes `media=movie` | cn 和 us 都返回 `resultCount:0` |

iTunes Search 的参数有个坑：**`country=cn` 对英文词一条都搜不到**（实测 `count=0`），
不带 country 的默认 storefront 给的又是繁体中文 —— 所以前端是「先试 `country=cn`（简体），
搜不到再退回不带 country 的同一 URL」。

### 三个热链的坑（封面）

- **豆瓣图床全站防盗链**：裸连 418、带任何第三方 Referer 403，只有 `Referer: https://movie.douban.com/` 才 200
  → 外站根本拿不到 → 构建期把 250 条豆瓣封面的 URL **置空**，前端渲染成首字占位框（保持三列对齐）。
  要真拿到海报只能服务端代理伪造 Referer（烧 Workers，不划算）。
- **B站图床见非 B站 Referer 就 403**：浏览器默认会把本站地址当 Referer 发出去 → `<img>` **必须**设
  `referrerPolicy='no-referrer'`，否则封面在浏览器里会全挂。
  ⚠️ 构建期的封面探测**测不出来** —— 探测是服务器视角，没有 Referer。
- 网易云图床两种情况都 200，不受影响。

### manifest 里榜单 tab 的形状

tab 的形态规则定义在 `tools\tab-kinds.mjs`（**只有这一处定义**）：
- 没有 `type` 字段 → 媒体型（图片 tab），产物在 r2 母本里，item 带 `thumb`/`full`
- 有 `type` 字段 → 文本型（`headlines` 见报 / `rank` 榜单），产物**不在**母本里

榜单 item 固定 7 个字段：`rank` `title` `subtitle` `meta` `cover` `link` `source` `tag`。
**`cover` 是远程 URL**（热链），不是站内 `/img/...` 路径 —— 见报那套 `newsImgSrc()` 只认站内绝对路径，
**不能**拿来处理榜单封面（会一律当成「没有图」）。

### 加新 tab 时的三个必改点

1. `site\board.html` 的 `TAB_LABELS` 要加中文名 —— `tools\test-contract.mjs` 会从 build.mjs 抠栏目逐个核对，漏了会红。
   ⚠️ **build.mjs 里的 key/label 必须写成字符串字面量**（`key: 'music'`，不是 `{ key: rt.key }`）——
   写成变量的话那条正则抠不到，新栏目就**脱离契约保护**（留言板显示内部 id，而且不报错）。
2. `tools\verify-news.mjs` 的 tab 数断言**不能写死 4**（线上可能 4 个也可能是 6 个）。
3. 文本型 tab 的 `type` 必须在 `tools\tab-kinds.mjs` 里登记 —— 否则 `build.mjs` 的产物自检会拿它当图片 tab，
   去 r2 母本里找它的图，找不到就**直接拒绝生成 manifest**（`--keep-manifest` 那条路也会被拒）。

## 追更数据（2026-11-16 加，**v3 起不再是独立 tab**，整体并入「看片」）

它原来是第 7 个 tab（`key='follow'` / 中文名「追更」/ `type='rank'`）。
2026-11-16 深夜按用户要求**取消这个 tab**，它的两块内容整体搬进「看片」当大目录 →
**站点从 7 个 tab 变成 6 个**（见闻 / 见她 / 见笑 / 见报 / 听乐 / 看片）。
抓取端和数据格式**一个字没变**，只是换了归置 → 见下面「看片 v3」那节。

**只做信息汇总，不提供任何内容播放** —— 和榜单 tab 一样，不托管、不转码、不代理音视频。

### 它回答什么

| 板块 | 内容 | 数据源 |
|---|---|---|
| 剧集更新 | 今天/明天播出的剧（美剧 + 国剧 + 日剧 + 韩剧 + 港剧） | TVmaze 播出表 |
| 城市演出 | 12 个主要城市的近期演出（话剧 / 展览 / 音乐节 / 分享会） | 豆瓣同城 |

**城市是 chip，不是独立 tab** —— 美团那套：chip 行 = `剧集更新` + 12 个城市名，点城市切到该城的演出。

### 数据源（2026-11-16 实测）

| 源 | 接口 | 实测 |
|---|---|---|
| TVmaze 播出表 | `api.tvmaze.com/schedule?country=US&date=YYYY-MM-DD` | **免费、无 key**。US/CN/JP/KR/HK 五国 × 2 天 → 原始 **219 条**，**筛完只剩 54 条**（见下）。条目带 `show.officialSite`（**官方正版入口**，例 `hbo.com/succession`） |
| 豆瓣同城 | `www.douban.com/location/<slug>/events` | 12 城 slug **逐个验过全部 200**，每城 11~15 条 → **120 条**。需要 Referer |
| 兜底通道 | `tools/fetch-follow.local.json` | **默认关闭**（文件不存在）。见下 |

**两条排序/筛选规则（不筛的话这个 tab 就是垃圾）**：

1. **只留「剧集」类型**（`SERIES_TYPES = ['Scripted','Documentary']`）——
   TVmaze 的播出表把新闻/脱口秀/真人秀全混在一起：实测美国一天 81 条里
   **Scripted 只有 10 条**，News 37 · Talk Show 14 · Reality 13 · Game Show 3 · Documentary 2 · Sports 2。
   不筛的话首页全是「CBS Mornings」「Morning Joe」。
   ⚠️ **`type` 缺失的条目照样保留**（判不出来就不丢数据）；**结构自检用不过滤的解析**（`types: null`），
   否则「某国某天全是新闻类」（JP 2026-11-17 实测就是 6 条全是新闻）会被误报成「源结构可能变了」。
2. **按国家分组，不按时间全局混排** —— 美剧黄金档 = UTC 次日凌晨，全球按时间排会把美剧压到末尾；
   国家顺序 = `COUNTRIES`（US → CN → JP → KR → HK），**美剧在前**，组内仍按播出时间升序。

- `fetch-follow.mjs` 落盘 `{源图根}/{日期}/follow_{日期}.json`：
  `{date, generatedAt, cities[], schedule[], events[], errors[]}`，条目 8 字段同榜单契约。
- CLI：`node tools\fetch-follow.mjs --date 2026-11-16`（`--dry-run` 只打印 · `--help`）

### 兜底通道（用户拍板「合法源为主、盗版站只作兜底」）

- 配置 `tools/fetch-follow.local.json`：`{"fallbacks":[{"name":"显示名","url":"列表页 URL"}]}`
- **文件不存在 = 整条通道关闭**（建了这个文件才等于启用）
- 规则：只在主源该板块失败时启用 → **只提取纯文本元数据**（剧名/集数/日期）→
  **页面上的所有 URL 一律丢弃**（不解析 link、不输出 link）→ item 的 link 恒为**豆瓣站内搜索**
- **硬自检**：兜底输出里出现 `http://`/`https://`（豆瓣搜索链接除外）→ 直接 throw

### 六个实测坑

1. **TVmaze 的 `?date=` 是 UTC 语义** —— `date=2026-11-16` 会返回 airdate=2026-11-15 的条目（当地时区还没到 16 号）。
   所以某天的 payload 里会混到邻日 airdate，这是**源语义不是 bug**。
2. **某国某天 0 条是正常的**（HK 常年稀疏）→ 只有「源返回了 N 条却解析出 0 条」才算结构变化。
3. **每日条数浮动很大**（US 实测 81 条/天）→ **别把条数写进文档或断言**。
4. **豆瓣同城页每个城市多 5 个 `list-entry`** —— 那是票务/主办方条目（没有 `itemprop="summary"`），不是活动 → 已丢弃。
5. **豆瓣海报 CDN 的防盗链规则跟 `movie.douban.com` 不一样**：`img*.doubanio.com` **不带 Referer → 418，带任意 Referer（含外站）→ 200** →
   所以活动海报 `<img src>` 能直出（不像豆瓣电影封面只能走占位框）。**别给豆瓣活动海报加可达性探测**（裸探会把全部海报判死）。
6. **两块各有一套从 1 开始的序号** —— schedule 1..N、events 1..M，直接拼起来同一个 tab 里序号会重复 →
   `build.mjs` 拼接后**统一重编号成 1..K**（护栏钉死了，变异会变红）。

### link 的 http → https

TVmaze 的 `officialSite` **有一半是 `http://`**（msnbc / nbc / cnn 都是）→ 站点是 https 就是 mixed content →
`fetch-follow.mjs` 统一升成 https（`toHttps()`，跟 `fetch-rank.mjs` 同一个理由）。

### 前端几乎零改动

- `site/app.js` 的 `renderRank()` 已经支持 `chips` + `data-tag` 过滤 + 回车跳豆瓣 → **城市 chip 直接靠 `tag` 实现，一行前端都不用改**。
- 只改了一处：`countPill` 的计数单位 —— 文本型 tab（headlines / rank）用「条」，图片 tab 用「张」。
  ⚠️ 原来写的是 `type === 'headlines' ? ' 条' : ' 张'` → 榜单 tab 会显示「200 张」。
- `build.mjs` 侧：上限 `MAX_FOLLOW_ITEMS = { schedule: 500, events: 300 }`（**分项，两个数故意不同**；
  统一成一个数 = 把「哪一块被砍掉了」这件事藏起来）；chips 里的城市**来自 `payload.cities`**，不写死。
  （v3 起这两块的**内容进了「看片」**，上限和「截完再拼」的纪律都不变。）

### 护栏

- `tools\test-fetch-follow.mjs` **169/0**（离线 fixture + 本机 fixture server 打通整条 CLI 链路）
- `tools\test-fetch-follow-mutate.mjs` **17/17 处变异全被抓住**（含「兜底输出含 URL」「兜底通道默认关闭被破坏」）
- `tools\test-rank-tab.mjs` **113/0**（第 12 段「追更 tab」32 条断言）· `test-rank-tab-mutate.mjs` **30/30 处变异**
  （⚠️ 这两个数是 **v2 时的历史值**，v3 已整体重写 → 见下面「看片 v3 · 护栏（v3 后）」）

## 榜单/追更 v2：多层分类 + 豆瓣封面本地化（2026-11-16 晚）

> 用户拍板：**层级越细越好** · **港剧混排**（不单独成板块）· **看片电影「有图的靠前」** · **三个 tab 上线**。

### 条目契约从 8 个字段变成 9 个

`{rank, title, subtitle, meta, cover, link, source, tag}` → **加 `tags: string[]`**。
`tags` 里每一项是 `'@<层号>:<值>'`：

| 层号 | 含义 | 例 |
|---|---|---|
| `@1:` | 板块 | `中文榜` / `国际榜` / `场景榜` / `电影` / `B站热门` / `抖音热门` / `频道更新` / `本地演出` |
| `@2:` | 分类 | `热歌榜` / `正在放映` / `B站热门` / `Netflix` / `武汉` |
| `@3:` | 细分 | `英语` / `江汉区` |
| `@4:` | 类型 | `Live 音乐` |

- **一条内容可以同属多个值**（一首歌既在中文榜又在国际榜）→ 前端 `levelTags()` 返回**数组**。
  只取第一个的话，它就只会出现在一个榜里。
- 层号必须**从 1 开始连续**，中间断一层那一层就没有 chip。

### 多层 chip：每层的选项**从数据现推**，不写死

`site/app.js` 的 `renderRank()` 重写成分层推导：

- 第 L 层的候选 = 满足前 L-1 层已选内容的元素；本层的选项 = 候选里 `@L:` 标签去重。
  → **天然没有「点进去是空的」死 chip**，换城市组 / 换平台 / 换榜单都不用改前端。
- 改了上层 → **清空下层选择**（否则会出现「选了深圳、结果按上海的区筛」）。
- 某层在当前选择下没有内容 → **整行撤掉**（不留下一个点了没反应的排）。
- 每行结构 = `.chip-line` 里左边一个**不跟着滚**的小标题（板块/分类/细分/类型）+ 右边横向滚动的 `.chips`。
  小标题必须放滚动区外面，否则往右滑的时候「这排是什么」就跟着滑没了。
- `site/app.css` 新增 `.chip-lines` / `.chip-line` / `.chips-cap` / `.chips-lv3` / `.chips-lv4`。
  ⚠️ **不用 flex gap**（微信 X5 不支持）。

### ⚠️ 层级标签用 **JSON 编码的 `data-lv`**，不是空格分隔

见报那套 `data-tags`（空格分隔）**没有**改成 JSON —— 它的标签值是分类名，不带空格。
但**榜单/追更的标签值会带空格**（平台名 `Prime Video`、语言 `English`）→ 空格分隔会把标签拆成两半，筛选直接失效。
所以 `rankRow()` 写的是 `li.setAttribute('data-lv', JSON.stringify(tags))`，`levelTags()` 读的是 `getAttribute('data-lv')` + `JSON.parse`。

### 旧 manifest 的兼容路径（**不能删**）

`useLegacy = !(items[0].tags && items[0].tags.length)` → 条目没有 `tags` 时走老路：
`tab.chips` 单层 + `data-tag` 等值匹配。
**为什么必须留**：`--keep-manifest`（只换前端、内容不动）构建会沿用旧 manifest —— 旧 manifest 的条目没有 `tags`，
走新路径的话分类 chip 整排消失（而这次改动跟内容无关，用户根本不会察觉）。
`build.mjs` 的 `level1Chips()` 也留了兜底：没有 `@1:` 标签时退回按 `it.tag` 去重（旧追更数据的 tag 语义正好就是那一层：
剧集更新的 tag = `剧集更新`，演出的 tag = 城市名）。

### 豆瓣封面必须自己存（**418，浏览器和生产都救不了**）

- `img*.doubanio.com` 对**不带 Referer** 的请求一律 **418**（14 字节 teapot），**给不给浏览器 UA 都一样**。
  浏览器 `<img>` 带的是**本站域名** → 生产环境同样裂图 → **热链这条路根本走不通**。
- 猫眼（`p0.pipi.cn`）/ B站（`i1.hdslb.com`）/ 网易云 / TVmaze 的图床**不查 Referer** → 远程 URL 原样保留，热链没问题。
- 抓取端用 `Referer: https://www.douban.com/` 把封面**下载到本地**：
  `<SRC_LOCAL>/<日期>/follow-covers/<sha1前16位>.jpg`，条目 `cover` 写 `local:follow-covers/<hash>.jpg`。
- **构建期**（`build.mjs` 的 `localizeCovers()`）把 `local:` 封面转成 WebP 存进 **R2 母本**，
  再把 `cover` 换成站内路径 `/img/<日期>/covers/<随机段>_<序号>.webp`。

#### ★ 封面**必须套用现有的产物命名**（这是本节最要紧的一条）

`upload-r2.mjs` 只上传符合 `PRODUCT_RE = /^[0-9a-f]{10}_\d{3}(_t)?\.webp$/` 的文件；
`functions/img/[[path]].js` 的代理只放行 `<日期>/<分类>/<10位随机段>_<3位序号>.webp`；
`orphan-clean.mjs` / `r2-prune.mjs` 也只认这一种 —— **不认的会被 r2-prune 当垃圾删掉**。
所以封面**改名成产物格式**（而不是给封面另开一套命名）→ **整条 R2 管道一个字节都不用改**。
代价是分类目录名必须过代理的 `[a-z0-9]+` → 用 `covers`。

- 随机段按**内容**算（不是按位置）：跟图片产物一个道理 —— 位置一变 URL 就变，边缘缓存里留着的旧内容会被继续命中。
- 序号也从内容哈希里取（不随列表顺序变）→ 重建时 URL 不变，缓存继续命中。
- 转换用 `scale=W:H:force_original_aspect_ratio=decrease`（**等比缩放，不裁不拉**）：
  电影海报 2:3、豆瓣演出海报 175×260，拉成正方形会把人拉胖。
  ⚠️ 勿用 `thumbnail/!200x200`（猫眼那边反而会涨到 559 KB）。

### TVmaze 必须用 `/schedule/full`，且 `date=` 是**窗口起点**

- `schedule?country=&date=` 是**按剧去重**的（一天 92 条 = 92 部剧），且 **country 不给就默认 US**
  → 实测 5 国 × 3 天，**Netflix / HBO Max / Prime Video 全是 0 条**（用户点名的平台根本出不来）。
- `/schedule/full?date=X` 是**集级**的（一天 5836 条 / 1247 部剧 / 105 个 webChannel，11.7 MB / 次），
  **忽略 country** → 全球平台一次拿全。
- ⚠️ `date=` 是**窗口起点**不是精确一天（返回的 `airdate` 横跨 date-1 ~ date+11）
  → **必须自己按 `e.airdate === 目标日` 过滤**，否则会混进别的日期的集。
- 逐日精确过滤实测：11-16 = 280 集/247 剧/36 webChannel · 11-17 = 267/248/31 · 11-18 = 282/261/41。

### 猫眼「即将上映」用 `comingList`，豆瓣 `/coming` 只能补量

- `m.maoyan.com/ajax/comingList?token=&ci=1` → 200，**10 条，10/10 带封面**，字段与 hot.json 完全一致。
- `movie.douban.com/coming` → 表格页 **0 张图**（HTML 里只有 1 个 `<img>`）。
- 豆瓣补海报的三条路**全堵死**：subject 详情页 → 跟跳转后 200 但只有 **2951 字节反爬验证页**（无 `og:image`）；
  `/j/subject_abstract?subject_id=` → **200 且是 JSON，但没有 `cover` 字段**；`/j/search_subjects` 只能按 tag 搜。
- 猫眼原图 **430 KB**（列表只显示 56×56）→ 必须拼
  `?imageMogr2/thumbnail/200x200^/gravity/center/crop/200x200/quality/80` → **39 KB**。
- 合成时**有图的靠前**（用户拍板）。

### 三个 tab 的上限（v2 后）

`MAX_RANK_ITEMS = { music: 600, movie: 400, video: 200 }` · `MAX_FOLLOW_ITEMS = { schedule: 500, events: 300 }`。
⚠️ **上限必须按段分项、且几个数不能是同一个** —— 统一成一个数 = 把「哪一段被砍掉了」从代码上藏起来
（影视榜 2026-11-16 实踩过：豆瓣 250 + B站 50 统一卡 200 → B站那 50 条全没了）。

### 护栏（v2 后）

- `tools\test-rank-tab.mjs` **145/0**（新增第 13 段「多层 chip 的数据契约」+ 第 14 段「豆瓣封面本地化」）
- `tools\test-rank-tab-mutate.mjs` **41/41 处变异全被抓住**
- `tools\test-fetch-rank.mjs` **159/0** · `tools\test-fetch-rank-mutate.mjs` **18/18**

## 看片 v3：五个大目录（2026-11-16 深夜，**代码就绪、还没上线**）

> 用户拍板：**B站热门、抖音热门提上来做大目录** · **追更的「频道更新」和「本地演出」搬进看片** ·
> **频道更新放第一个**。
> 连带后果（已向用户说明、用户未反对）：追更的两个分类全搬走 → 追更 tab 变空 →
> **站点从 7 个 tab 变成 6 个**（见闻 / 见她 / 见笑 / 见报 / 听乐 / 看片）。

### 目录顺序 = 数据顺序（不是配置项）

用户拍板的顺序：**频道更新 → 电影 → B站热门 → 抖音热门 → 本地演出**。

看片的五个大目录 = 条目的 `@1:` 标签，**顺序由数据里的出现顺序决定** ——
`site/app.js` 的 `renderChips()` 按条目在列表里的出现顺序去重现推 chip，**不排序**。
所以「目录顺序」就是 `build.mjs` 里 `watchList` 的拼接顺序：

```js
const watchList = [...followSchedule, ...movieList, ...videoList, ...followEvents]
  .map((it, i) => ({ ...it, rank: i + 1 }));
```

⚠️ 改顺序 = 改这一行的数组顺序，**别去改前端**（前端根本没有「目录顺序」这个概念）。
⚠️ 护栏也必须**钉死顺序**（只断言「包含这五段」是抓不住顺序错乱的）。

### 五段各来自哪

| 大目录（@1） | 来源 | 条数（11-16） | 上限 |
|---|---|---|---|
| `频道更新` | `follow_<日期>.json` 的 schedule 段 | 184 | `MAX_FOLLOW_ITEMS.schedule = 500` |
| `电影` | `rank_<日期>.json` 的 movie 段 | 36 | `MAX_RANK_ITEMS.movie = 400` |
| `B站热门` | `rank_<日期>.json` 的 video 段 | 50 | `MAX_RANK_ITEMS.video = 200`（两段共用） |
| `抖音热门` | 同上 | 50 | 同上 |
| `本地演出` | `follow_<日期>.json` 的 events 段 | 120 | `MAX_FOLLOW_ITEMS.events = 300` |

**「视频」这个 @1 壳去掉了**（v2 是 `@1:视频` → `@2:B站热门`，v3 直接 `@1:B站热门`）。
标签字面也从「频道新更」改成「**频道更新**」（用用户的字面）—— 抓取端常量 `L1_SCHEDULE`、
源数据、护栏断言**三处一起改**。

### build.mjs 的三段式改动

1. **读数据**：榜单块（`musicList`/`movieList`/`videoList`）和追更块（`followSchedule`/`followEvents`）
   **只负责读，不 push tab**。变量声明提到块外面 —— 读数据和拼 tab 必须分成两步，
   否则先读的那块会被后面覆盖掉。
2. **合并**：上面那行 `watchList`（五段 + 统一重编号 1..K）。
3. **组 tab**：`const rankTabs = []` → 只 push `music`（听乐）和 `movie`（看片）两个。
   `key`/`label` 必须是**字符串字面量**（`key: 'movie', label: '看片'`），
   否则 `tools/test-contract.mjs` 的正则抠不到 → 栏目脱离契约保护。

⚠️ **`movie` 这个 key 留着没改**（它是「看片」的历史 key，留言板和 verify-news 都按它找）；
**标签改名要同时改** `site/board.html` 的 `TAB_LABELS` 和 `tools/verify-news.mjs`，
否则 `test-contract.mjs` 的「栏目中文名两边一致」断言会红。

### ⚠️ 发布链路**不重跑抓取器** —— 改标签必须迁源数据

`tools/publish.ps1` 只跑 `node tools/build.mjs --date <日期>`，**不会**跑 `fetch-rank.mjs` / `fetch-follow.mjs`。
所以光改抓取器，**当期线上还是旧结构**（新标签要等第二天抓取才生效）。

改层级标签 / 改标签字面时，**必须同时迁当期的源数据**：
`~/image-root\src\<日期>\rank_<日期>.json` / `follow_<日期>.json`。

迁移脚本的三个要点（2026-11-16 实踩）：
1. **先备份**（`.bak-tag-migration`）。
2. **先验证「原样再序列化 == 原文」**，确认 `JSON.stringify(obj, null, 2)` 的格式跟原文件一致 ——
   不一致就会把整个文件重排，diff 全是噪音。
3. ⚠️ **打完补丁再序列化** —— 第一次写这脚本时把序列化结果在补丁前就存进了变量，
   结果写回的是**没改过的内容**（文件看着被重写了，其实一个字没变；幸好格式自检过了，没造成损坏）。

### 护栏（v3 后）

- `tools\test-rank-tab.mjs` **182 通过 / 0 失败**（v2 是 149 条；第 12 段从「追更 tab」整体重写成
  「看片五段合并」，新增**顺序断言** —— 拼接顺序错必须红）
  - 顺序类：把 `const watchList = [` 到第一个 `]` 的**数组字面量**抠出来，按出现顺序抠段名，
    跟 `['followSchedule','movieList','videoList','followEvents']` **逐位严格相等**；
    再拆成 4 条定位断言（schedule 在 movie 前 / video 在 events 前 / 一段都不能少 / 不能多出段）
    +「拼接之后没有再排序」+ **前端前提也钉住**（`renderChips` 里不许出现 `.sort(`）
  - 分项上限：断的是**源码下标顺序**（`payload.schedule.slice` < `payload.events.slice` < 拼接点），
    再加一条反向断言（拼接结果里**不许出现 `.slice(`）→ 专抓「先拼后截」
  - 降级：新写 `catchBodies()` 用大括号配对抠出 catch **自己的**函数体 → 断言里面没有 `throw`
- `tools\test-rank-tab-mutate.mjs` **54 通过 / 0 失败，49/49 处变异全被抓住**（v2 是 43 处）
  - 纪律：**锚点自检前置**（每个 `from` 恰好命中 1 次，否则 exit 1 报「脚本过期了（源码改了？）」）·
    **干净地红**（exit≠0 + 有统计行 + stderr 无调用栈）· **expectFail + expectGreen 双向声明** ·
    统计按**本次运行**切分
- `tools\test-fetch-rank.mjs` **159 通过 / 0 失败**（B站/抖音的 tags 断言改成 `@1:B站热门` / `@1:抖音热门`，
  已知板块集合里 `视频` 换成 `B站热门`/`抖音热门`）
- `tools\test-fetch-follow.mjs` **275 通过 / 0 失败**（`L1_SCHEDULE` 改成「频道更新」，断言同步）
- ⚠️ **worker 主动暴露的遗留缺口（不写假护栏）**：① 护栏是**静态源码断言**，不验证运行结果
  ② 各段**实际条数**没断言（抓取端某天抓不到 B站 → 目录顺序仍对但少一档，护栏不会红）
  ③ 段内顺序只钉住了 videoList ④ `@2/@3/@4` 层级（城市/平台/语言）没查

## daily.ps1 第 4 步：把榜单 + 追更抓进日常流程（2026-11-16 深夜）

### 为什么以前流程里没有这一步

榜单（听乐 + 看片的电影/B站/抖音段）和追更（看片的频道更新/本地演出段）
都是**构建期静态数据** —— `build.mjs` 只读 `src\<期号>\rank_<期号>.json` 和
`follow_<期号>.json`，**它自己不会去抓**。

而 `tools/daily.ps1`（桌面「一键更新」和「上传图片」的**共同汇聚点**）以前只有
**抓图 → 头条 → 清洗 → 构建** 四步，**从来不跑抓取器** →
除了 11-16 那一期（手工跑过）之外，**23 期里 22 期的源目录里根本没有这两份 JSON**
→ 构建时静默跳过 → 线上只有 4 个 tab（见闻/见她/见笑/见报）。

看片 v3 把两块的五段并进「看片」之后，漏抓的后果从「tab 不存在」变成
「看片只有 2~3 个目录」—— 看着像网站坏了，更看不出是漏抓了一次数据。

### 第 4 步怎么写的

| | |
|---|---|
| 位置 | **清洗之后 → 抓取 → 构建之前**（构建完再抓就进不了这一期产物） |
| 命令 | `node tools/fetch-rank.mjs --date $publishDate` + `node tools/fetch-follow.mjs --date $publishDate` |
| 日期参数 | **期号 `$publishDate`**，不是内容日期 `$ContentDate`（内容日期是昨天，目录名是期号） |
| 失败处理 | **只警告不中断**（`Warn` + 继续）—— 榜单/追更是补充内容，**图片才是主体** |
| 缺段可见性 | 构建那一步会**点名**说缺了哪几段（`build.mjs` 的 `WATCH_SECTIONS`） |
| 逃生口 | `-NoRank`（`daily.ps1` 和 `daily-review.ps1` **都**要认，桌面那条链才够得着） |

⚠️ **原生命令的两条老规矩同样适用**：接 `| Out-Host`（PS 5.1 的 transcript 抓不到原生 stdout）、
不许 `2>&1`（stderr→ErrorRecord→掀翻 `$ErrorActionPreference='Stop'`）。

⚠️ **小口子：`-Out` 只影响图片，不影响榜单/追更** —— 抓图/头条/清洗都接了 `$Out`，
但两个抓取器**只写 `SRC_LOCAL`**（`paths.mjs` 的 `IMAGE_ROOT`），
而 `build.mjs` 也只从 `srcSearchRoots()` 读 —— 所以用 `-Out` 时，
榜单/追更仍然落在默认源根（**跟构建读的地方一致**，不会错位）。
桌面两个入口都不传 `-Out`，所以日常流程碰不到这个口子。
将来要让 `-Out` 真正生效，得给两个抓取器加 `--root`（`fetch-follow.mjs` 的
`followFilePath(date, { root })` 已经预留了参数，只是 CLI 没暴露）。

### 实跑结果（2026-11-16 深夜，用 2026-11-17 期号实跑，**不动已发布的 11-16 数据**）

- `fetch-rank.mjs` exit 0（47.3 秒）：**听乐 550 / 电影 38 / 视频 100**
  （`@1:B站热门` 50 + `@1:抖音热门` 50，**无残留 `@1:视频`**）
- `fetch-follow.mjs` exit 0（30.8 秒）：**频道更新 181 / 本地演出 120**，
  豆瓣封面本地化 **140 张就绪 / 0 张失败**
- 形状核对：`schedule` 181 条 = `@1:频道更新` + `@2:平台` + `@3:语言`；
  `events` 120 条 = `@1:本地演出` + `@2:城市` + `@3:区` + `@4:类型`；
  封面字段是 `local:follow-covers/…`（构建期转 WebP → `/img/<日期>/covers/…`）
- 合起来就是 v3 的五段：**频道更新 181 + 电影 38 + B站热门 50 + 抖音热门 50 + 本地演出 120 = 439 条**

### 护栏

- `tools\test-daily-rank-step.mjs` **34 通过 / 0 失败**（新套件）
  - 断言一律看**剥掉注释后的代码**（daily.ps1 的注释里本来就写着这些说明，
    全文匹配 = 护栏把自己的说明书当合规）
  - 覆盖：第 4 步存在 / 有 `-NoRank` / 被 `-NoRank` 守卫 / 位置（清洗后·构建前·期号之后）/
    两个抓取器在**同一个列表** / 传的是期号不是内容日期 / **失败只警告不中断**（段内无 `throw`）/
    原生命令接了 `Out-Host` 且无 `2>&1` / `daily-review.ps1` 透传 `-NoRank` /
    抓取器自己的 `--date` 参数和落盘路径跟 build.mjs 读的对得上 / 编码与 PS 语法
- `tools\test-daily-rank-step-mutate.mjs` **17 通过 / 0 失败，15/15 处变异全被抓住**
  - 纪律同 v3：锚点自检（`from` **恰好命中 1 次**，否则判「脚本过期了（源码改了？）」）/
    干净地红（exit≠0 + 有统计行 + stderr 无调用栈）/ expectFail + expectGreen 双向声明
- `tools\test-daily-review.mjs` 从 41 条加到 **43 条**：原来的「原生命令」扫描正则
  只认 `& node @(...)`（数组展开），新增的 `& node $fetcher --date $publishDate`
  **整个漏在外面** → 它的 Out-Host / 2>&1 纪律没人盯。正则改成**按调用了哪个可执行文件认**，
  不看参数形态（另两条环境准备用的调用 `-c "import X"` / `-m pip install` 显式豁免并写清理由）

⚠️ **遗留缺口（不写假护栏）**：这一套护栏是**静态源码断言**，不验证实跑结果；
各段**实际条数**没断言（某天 B站抓不到 → 目录顺序仍对但少一档，护栏不会红）。

## 三件套：分享卡片 + RSS + 模糊占位（2026-11-17 加）

### 为什么要做这三件（评估结论，别再重复评估）

这个站的消费路径是**微信 / QQ 群里分享链接**（`gate.ps1`「复制这个发群里」、
`daily.ps1`「上传之后东西就发到群里了」）→ **分享卡片是唯一预览**。
实测当时的现状：`og:image` 恒等于 640×640 的 logo、**没有** `twitter:image`；
站内**一个 feed 都没有**（`/feed.xml` 落到 Pages 的 404 兜底页，返回 200 + `text/html`，
那不是 feed —— **判「文件存不存在」不能看状态码**）；三栏照片首屏是白 loading。

收益排序：**OG 卡片 > RSS > 全站搜索 > 投稿**。
（全站搜索的真增量只有「跨 tab + 搜往期」——每个文本 tab 已经有搜索框了；
而 Pagefind 抓不到 JS 渲染的内容，成本被严重低估。投稿要引第三条内容来源 + 审核负担。）

### ① 分享卡片（OG）

- 每期一张 `published/<日期>/og.jpg`，**1200×630**，**三栏拼图**（见闻 / 见她 / 见笑 各取第一张全图）。
- **图里不写文字** —— 字体路径跨平台不可靠；文字放 `og:title` / `og:description`。
- **`og:image` 必须是绝对 URL** —— 相对路径微信 / X / 知乎爬虫拉不到 → 白卡。
- **URL 必须带日期** —— 微信按分享 URL 缓存卡片；根 URL 是固定链接 → 它的卡片会停在缓存那天。
  **要每期新卡就分享「当天页面」链接**（URL 每期不同 → 微信每次重抓）。
- **根页 `og:title` / `og:description` 刻意不带日期** —— 带日期的话，缓存住的卡片永远停在第一天。
- 放 **Pages 静态面**（`published/<日期>/og.jpg`），**不能放私有 R2** —— 爬虫拿不到 Function 凭证。
- 合成失败**退回 logo、不阻断构建**（构建是主体，分享图是加分项）。
- ⚠️ og.jpg 必须写在 build.mjs 的 `fs.rm(published/<日期>)` **之后** —— 写在之前会被删掉。

### ② RSS（`published/feed.xml`）

- RSS 2.0，**每期一条 item**（不是每条内容一条）：这是一份日报，
  3 万多条内容塞进去阅读器会卡住，也没人会逐条读。
- item 的 `<link>` / `<guid>` **必须绝对 URL** —— 相对路径阅读器点不开。
- `<pubDate>` 用 **UTC RFC822**（`Tue, 17 Nov 2026 00:00:00 GMT`）——
  读者遍布全球，本地时区会让「这期是哪天」在不同机器上飘。
- 标题 / 描述必须 **XML 转义** —— 见报标题来自别的 RSS 源，`AT&T`、`<紧急>` 是常事；
  不转义整份 feed 被阅读器判为坏 XML **直接丢弃**。
- 内容是**所有往期**：每次构建扫一遍 `published/<日期>/` 的 manifest 汇总一次
  （所以 feed 里的期数 = `published/` 下的日期目录数）。
- 模板里加 `<link rel="alternate" type="application/rss+xml" href="/feed.xml">` ——
  阅读器靠它自动发现。`type` 必须是 `application/rss+xml`（写 `text/xml` 很多阅读器不认）。

### ③ 模糊占位（LQIP）

- 24px 宽的小图，**base64 data URI 内联进 manifest** ——
  零额外请求、零额外 R2 对象（走 R2 要改上传 / 孤儿清理 / 代理放行三条管道，太重）。
- **批量 12 张/次 ffmpeg**（一图一进程 182 次要 23.8s，批量 16 次只要 10.8s）。
- **不用 CSS `filter: blur()`** —— 182 个模糊图层在手机上会掉帧；
  24px 放大到 400px 时浏览器的插值已经足够模糊。
- 只给**三栏照片**做（182 张，共 76.2 KB）；**不做见报 RSS 配图** —— 那会让 manifest 涨到 ~150 KB。
- LQIP 失败**只降级不阻断**。
- ⚠️ **ffmpeg 9.0.2 上 `scale=24:-2:flags=fast` 是非法的**（整批 182 张全废，不报像的错）；
  合法值是 **`flags=fast_bilinear`**。

### 公共件：`tools/strip-comments.mjs`（护栏剥注释用）

新护栏匹配源码前**一律先剥注释**：工程源码的注释里就写着 "og:image"、"RSS"、"绝对 URL"、
"LQIP" 这些词，护栏若全文匹配，会把**自己的说明书当成合规证据** → 代码改坏了也照样全绿 → 假护栏。

- JS 用 `stripJsComments` / HTML 用 `stripHtmlComments` / CSS 用 `stripCssComments`。
- 剥注释只用于**匹配**；统计行数 / 字节数的断言用原文件。
- ⚠️ 它是**状态机**，不是「把 `//` 之后全删」：朴素的剥法会把字符串里的
  `https://example.com` 吃掉（后面的真代码一起没了）。
- 它自己也有护栏（`tools/test-strip-comments.mjs`）—— **剥离器一坏，三套护栏一起变成假护栏**，
  而且不会有任何报错。

## 开源导出（2026-11-17）

本仓库是从线上那套工程**脱敏后**导出的独立副本（`psterman/daily-image-site`，MIT）。
导出之后两边**分叉**：线上工程继续私有演进，两边**不自动同步**。

### 占位约定（你要改的就是这些）

| 占位 | 含义 | 改成 |
|---|---|---|
| `https://example.com` | 站点公开地址（OG / RSS 的绝对 URL 都用它） | 你的域名 |
| `your-bucket` | R2 私有桶名 | 你的桶名 |
| `your-project` | Cloudflare Pages 项目名 | 你的项目名 |
| `~/image-root` | 本地图片存储总根（源图 `src/` + 母本 `r2/`） | 你的路径 |
| `每日图片站` | 站名 | 你的站名 |
| `C:\Users\<user>` | 本机用户名 | 一般不用改 |

**替换顺序敏感**：更具体的规则必须排在更宽泛的前面 ——
图根路径要排在**桶名**之前（否则本地图根目录会被改成桶名），
工程根路径要排在**项目名**之前。

### ⚠️ 机械替换会**静默腐蚀护栏**（这次真踩到了）

桶名和图根目录名**曾经**用了同一个词。全局替换把它换成桶名的占位之后，护栏里
「本地图根目录名是那个词」这条断言变成了「本地图根目录名是**桶名**的占位」——
**断言照样绿，但盯的已经不是同一件事**（名不副实的断言 = 假护栏）。

同一个坑还让 3 个 Python 文件**语法直接坏掉**：替换规则少了一个右括号 →
`return os.path.join(..., "image-root"), "src")`。

**正解**：脱敏之后**必须复跑全量护栏**，而且要逐条看红项 ——
机械替换的错误只会表现为「某个字面量对不上」，**不会自己报警**。

### ⚠️ 脱敏还会**让变异测试静默失效**

`test-build-og-mutate.mjs` 里有个变异是「把站点根写死」：
- 护栏夹具用的域名是 `https://example.com`
- 变异体写死的域名原本**跟夹具不一样** —— 所以变异后断言变红 ✓
- 脱敏把变异体也换成同一个域名 → 变异结果跟夹具期望**一模一样** → 断言照样绿 → **变异白做**

**规则**：变异体里写死的值，**必须跟护栏夹具的值不同**，否则这个变异从设计上就区分不出来。
改名 / 脱敏 / 换域名之后，**变异套件要单独复跑一遍** ——
它变红的方式跟常规套件不一样（常规套件红 = 代码坏了；变异套件绿 = 变异没被抓住）。

### 脱敏顺手改掉的三处设计问题

1. **图根默认值不再按平台分**（`paths.mjs` / `common.ps1` / 三个 `.py`）——
   统一落在用户家目录下的 `image-root`，**代码里不出现任何盘符字面量**。
   原来的「Windows → D 盘 / macOS → 家目录」在公开仓库里既暴露本机布局，
   又要求每处都得记得分平台。护栏相应改成盯「**不许出现盘符字面量**」。
2. **`orphan-clean.mjs` 的凭据改成懒检查** ——
   以前构造时就检查 → 「这期一个孤儿都没有」也会因为没配云凭据而 exit 1（纯噪音）。
   现在真要删的时候才要凭据（新增两条护栏锁住这个行为）。
3. **`test-retag.mjs` 改成显式跳过**（退出码 2）——
   它需要真实 `published/` 往期产物，全新 clone 没有。
   **跳过绝不能冒充通过**：跑批器把「跳过」单列，不计入绿。

### 跑批器

`tools/run-all-tests.mjs` —— 34 套常规 + 11 套变异，逐个跑、逐个判退出码。
退出码约定：`0` 绿 · `1` 红 · `2` 跳过。

---

## 测试与校验

`npm test` = `node tools/run-all-tests.mjs`（34 套常规；`npm run test:mutate` 加 11 套变异）。
单个套件也可以逐个跑：

| 文件 | 断言 | 测什么 |
|---|---|---|
| `test-rss.mjs` | 59 | RSS 解析 / 反爬识别 / 重试 / 过期闸门 / **单源级超时（单源 > 按 host > 全局）** |
| `test-news-taxonomy.mjs` | 40 | 见报分类表 + 归属计算 |
| `test-news-taxonomy-mutate.mjs` | 6 组变异 | 改坏分类逻辑必须被抓住 |
| `test-build-taxonomy.mjs` | 30 | 真在临时目录跑构建，验 manifest 分类 + **`/archive/` 日期索引必须包含最新一期** + **日期条目必须带 `class="row"`（卡片样式才生效）** |
| `test-keep-manifest.mjs` | 26 | `--keep-manifest` 行为 |
| `test-retag.mjs` | 39 | **`--retag` 往期重分**：条数一致 / **除 tag·tags 外逐字段深比较 + 字段顺序都不变** / tag == 新 taxonomy 里该源的分类 / tags[0] == tag / 分类列表按固定顺序重算 / 无残留旧分类名 / **照片 tab 整 tab 逐字节相同** / index.html 引用新 manifest + 旧 manifest 被删 / 页面壳未换版 / 根页面引用同步 / **published/ 一个字节没动** / **漏配源 → exit 1 且点名该源、不写出任何 manifest** / 三道闸门（与 `--keep-manifest` 互斥 / 缺 `--date` / 缺旧 manifest）。**5 组变异全部有牙齿**：不重算分类→红5 / 丢 desc→红2 / 不删旧 manifest→红1 / 丢照片 tab→红3 / 去预校验→红1 |
| `test-contract.mjs` | 23 | 跨文件契约：白名单 / R2 key / 栏目中文名 / 三处正则一致 |
| `test-news-ui.mjs` | 116 | 见报 tab 前端（无「全部」chip、默认选第一分类、**关键词搜索**：标题/来源/摘要、AND 三维度、计数提示、**可选配图**：有 img 才渲染、懒加载、不影响照片 tab、375px 不溢出） |
| `test-news-search-mutate.mjs` | 9 组变异 | 改坏搜索实现必须被抓住 |
| `test-rss-images.mjs` | 36 | 见报配图：候选图收集规则 + 真下载/真转码/真筛选（403 退到下一张、太小/横幅/超体积被拒、白名单外跳过、临时文件清理、Referer 带上）+ **URL 必须能被线上代理的路径正则认出来** + **同一个盐 → 同一个 URL，换盐 → 换随机段** + **白名单 ↔ 源列表对账**（**RSS 源或头条源**都认，拼错只会静默不出图）+ **头条来源的条目也能真的配到图**（走同一条流水线） |
| `test-headlines.mjs` | 30 | 头条 JSON 新鲜度：**当天那份超过 2 小时必须告警**（含旧了多久 + 哪些源 + 刷新命令）+ 阈值边界 + 重建往期不误报 + 没有 headlines 目录返回 null（变异：阈值放大 → 4 条红）+ **头条候选配图**：JS 侧映射（形状必须 `{url,kind}`、裸字符串归一、非 http 滤掉）+ **Python 抽图模块**（真跑 python：协议相对补全、懒加载属性、URL 粗筛、data:/非图片后缀） |
| `test-review-keys.mjs` | 30 | 审稿台键盘（回车标记 / **Delete 直删** / 焦点护栏）+ 标记持久化 |
| `test-daily-review.mjs` | 43 | 一键更新护栏：`.cmd` 编码 / 绝不碰发布 / `Out-Host` 不被摘掉 / Job 脱身机制（**按平台分支**：macOS 上改查 `.sh`、查「不碰 explorer.exe」）/ **原生命令扫描改成「按可执行文件认」**（原来只认 `@(...)` 展开，新写的 `& node $fetcher …` 落在外面没人盯） |
| `test-daily-rank-step.mjs` | 34 | **daily.ps1 第 4 步**：抓取器都在 / 传期号不传内容日期 / 失败只警告不中断 / 位置（清洗后·构建前）/ `-NoRank` 逃生口 + 桌面链透传 / 抓取器的 `--date` 与落盘路径跟 build 对得上 / 编码与 PS 语法 |
| `test-daily-rank-step-mutate.mjs` | 15 组变异 | 改坏第 4 步必须被抓住（**15/15 全抓**：漏一个抓取器 / 传错日期 / 警告后又 throw / 摘掉 Out-Host / 加 2>&1 / 删逃生口 / 挪到构建之后 / 不透传 …） |
| `test-strip-comments.mjs` | 23 | 注释剥离器（**三套新护栏的地基**）：JS 状态机不吃掉字符串里的 `https://` / 正则字面量 / 模板串，HTML + CSS + 编码 |
| `test-build-og.mjs` | 27 | **OG 分享卡片**：导出 + 默认 1200×630 + **`ogImageUrl` 真 import 真调用**（绝对 URL / 无双斜杠 / 换域名跟着变）+ 失败真抛错（不存在 ffmpeg 探针）+ size>0 校验 + 无 drawtext + build.mjs 的落点/顺序/占位符/catch 不阻断/根页不带日期 + template 的 og·twitter·rss meta + verify-build 的 og 自检 + 编码 |
| `test-build-og-mutate.mjs` | 10 组变异 | 改坏 OG 必须被抓住（**10/10 全抓**：宽高 640 / 站点根写死 / throw→return / 去掉 size 校验 / 落点改根目录 / 挪到 rm 之前 / 根页 title 带日期 / og 写死 logo / 相对路径 / 删 twitter:image） |
| `test-build-feed.mjs` | 52 | **RSS**：6 个 tab 的中文名映射（不含已下线的 follow）+ **真 import 真调用**（绝对 URL / GMT pubDate / 倒序 / XML 转义 / 6 栏摘要 / 不许再出现「三栏」）+ build.mjs 扫所有往期 + 落根目录 + template 与**往期页**的 rel/type + 编码 |
| `test-build-feed-mutate.mjs` | 11 组变异 | 改坏 RSS 必须被抓住（**11/11 全抓**：相对路径 link / 本地时间 pubDate / 不转义 / 升序 / 少一个 tab / description 写回「三栏」 / 写到当期目录 / 只扫当期 / type 改 text/xml / 不校验非法日期 / 往期页订阅链接被删） |
| `test-build-lqip.mjs` | 39 | **模糊占位**：`flags=fast_bilinear` 正向 + **`flags=fast` 负向**（ffmpeg 9.0.2 非法值）+ 24px + 批量 12（运行时证据：24 张 = 2 批 2 次 ffmpeg）+ data URI + 全失败返空 Map + build.mjs 只收照片 + app.js 写 `--lqip` + app.css 的 `::before`/`is-loaded` + **不许有 `filter: blur()`**（要区分 `backdrop-filter:`） |
| `test-build-lqip-mutate.mjs` | 9 组变异 | 改坏 LQIP 必须被抓住（**9/9 全抓**：`flags=fast` / batchSize=1 / 宽度 96 / 失败改成 throw / 不写 lqip 字段 / 构建被掀翻 / 不设 `--lqip` / opacity 改成 .9 / 加 `filter: blur(20px)`） |
| `test-portability.mjs` | 45 | 跨平台护栏：macOS 部署包 / launchd 定时点对齐 / Python 侧 OUT_BASE + OCR / Node 侧 where→which、spawn 分支 / 全局残留扫描 / **图根默认值不许出现盘符字面量**（脱敏后改盯这条） / **任务台：PowerShell 可执行名按平台分** |
| `test-orphan-clean.mjs` | 48 | 孤儿清理：键集抽取（**base-36 hash 不是 hex**）/ REST 删除的成功判据（**不能只看 HTTP 码**：`success:false` + `code 10007` 才是幂等成功）/ 干跑不删 / 失败如实报 / **凭据懒检查**（构造不抛、真删才抛） |
| `test-media-fallback.mjs` | 15 | ffmpeg 格式回退机制 |
| `test-likes.mjs` / `test-board.mjs` / `test-functions.mjs` | 67 / 42 / 35 | 点赞后端 / 留言板 / Functions 公共层 |
| `test-likes-ui.mjs` / `test-board-ui.mjs` | 32 / 45 | 前端点赞 / 留言板版面 |
| `test-webp.mjs` | 8322 文件 | WebP 宽高解析器 vs ffprobe 逐个对照（母本每多一期就多几百个文件，2026-11-11 起 8322 个，约 12 分钟） |
| `test-night-dashboard.mjs` | 172 | 定时任务台：三个 helper 的时间戳格式 + 解析层（剥 BOM / 15 节点 / 老日志兼容 / 跨零点）+ 状态与问题判定（中位数只用成功的夜 / **`.done` 优先于日志标记 / dead 点名步骤 / 格式变了退化为 unknown 并按完成记录分级 / 阶段级慢 > 中位数 × 3（只比闭合区间）/ 06:00 闸门 / 阶段级只比闭合区间** / **计划任务「正在运行」不算失败** / **267009·267011 只靠结果码也判成「不是失败」**）+ HTTP 层（本机 / 动态端口 Origin / 目录穿越金丝雀 / **写路径零副作用** / **by:manual 取 manual 日志** / **只绑 127.0.0.1** / **`/api/log` 只读尾部 64KB** / **guard 挡非本机 + 挡跨站 + 放行本机同源** / **已有发布在跑 → 409 且零 spawn**）+ 启动器约定 + 服务端 toast（**AUMID 字面量只放 common.ps1**） |
| `test-night-dashboard-mutate.mjs` | 17 组变异 | 改坏**解析层、HTTP 层和 toast 的 AUMID 归位**都必须被抓住（剥 BOM / 时间戳正则 / 跨零点 / 负耗时 / 分组 / median / allowWrite 顺序 / by:manual / 绑 0.0.0.0 / 读整份日志 / **AUMID 字面量搬回 notify.ps1** / **common.ps1 里的 Get-ToastAumid 被改名** / **删掉结果码排除** / **guard 放行非本机** / **409 那道门失效**） |

| `test-night-hardening.mjs` | 46 | 2026-11-25 那轮夜间加固的契约：告警下沉（`Send-Alert` 在 common.ps1 / 失败才发 / 通知失败不掀翻主流程）+ 看门狗（`.done` 判定 / exit≠0 不重复告警 / `.cmd` 纯 ASCII 无 pause / 参数透传）+ 抓图总预算（**每个源都查**）+ pHash 增量缓存（**mtime+size 都要比** / 原子写盘 / 新图登记进缓存 / **改模块级标志位的函数必须有 `global` 声明**）+ RSS 换源（**V2EX 官方 / NYT中文+法广中文走 bestblogs / DW 中文已删 / 不许加回用户移除过的源**）+ 日志轮转（切历史不删文件 / 夜间流程最后调）。第 7 组（计划任务属性）**只在传 `SCHED_SETTINGS_FILE` 时才断言**，否则跳过 |
| `test-night-hardening-mutate.mjs` | 18 组变异 | 证明上面那套护栏**真的有牙齿**：改坏告警链路 / 看门狗 `.cmd` / 抓图预算 / pHash 缓存键 / **两处 `global` 声明** / RSS 地址 / 日志轮转，**18/18 全被抓**。⚠️ 第一版有 **4 个假绿**（只查「函数名出现过」→ 变异把调用换掉也不红），已改成**查结构不查词 presence** |

**合计 ≈1048 项断言**（不含 80 组变异、8322 文件对照）。改完代码至少跑相关的那几套。

| 工具 | 用途 |
|---|---|
| `node tools\verify-build.mjs --date 2026-11-08` | 产物自检：manifest 引用的产物**存在且是有效 WebP**（0 字节 / 坏文件头 = 裂图，exit 1）/ 无孤儿 / 源图张数 == manifest 张数 / `count` == `items.length` / 见报无重复链接。`publish.ps1` 第 2 步后自动跑，不通过中止发布。`--date all` 查所有日期 |
| `node tools\verify-news.mjs https://example.com/2026-11-08/` | 见报 tab 专项（微信 UA + 6 个目录逐一验归属），线上 49 项 |
| `node tools\final-verify.mjs` | 线上图片逐张下载字节级比对（最严格） |
| `node tools\check-r2.mjs` / `check-api.mjs` | R2 可用性 / Cloudflare API 权限自检 |
| `node tools\r2-prune.mjs --orphans --dry` | 以 manifest 为准清 R2 孤儿对象（**先 dry**） |
| `node tools\r2-usage.mjs [--by-date]` | R2 用量体检 + 自动续期 |
| `node tools\check-links.mjs "https://example.com/" [--probe]` | 见报链接体检 |
| `node tools\fetch-rss.mjs --probe <url>` | 探测某个地址能不能当 RSS 源 |
| `node tools\fix-ps1-encoding.mjs` | 统一 `.ps1` 为 UTF-8 with BOM + 语法检查 |

---

## 项目布局

```
site/       前端模板：template.html · app.js · app.css · board.html · assets/
tools/      全部构建与运维脚本（70 个）；tools/grab/ 是 Python 抓取层；
            tools/macos/ 是 macOS 部署包（launchd plist + .sh）
functions/  Pages Functions：_middleware.js(访问口令) · img/[[path]].js(图片代理) · board/ · likes/ · loomy-sign/(讯飞短信登录签名，密钥只在 Cloudflare Secret)
lib/        r2-json.mjs(单文件+etag乐观锁) · rate-limit.mjs · loomy-signature.mjs + loomy-sign-service.mjs(讯飞签名算法与 HTTP 层)
published/  待部署产物：每期一个日期目录 + index.html(根路径=今天) + archive/
docs/       rss-candidates · superpowers/{plans,specs} · macos-migration.md(迁移手册)
assets/     shortcut.ico（桌面快捷方式图标）
```

**图片存储不在工程目录**（`IMAGE_ROOT`，默认 `~/image-root`；macOS 上是 `~/image-root`）：
`src/<发布日>/<分类>/` 源图（**真正不能删**） · `r2/<发布日>/<分类>/*.webp` 转码母本。

关键文件：`tools/paths.mjs`（`IMAGE_ROOT` 唯一真源）· `tools/build.mjs` · `tools/publish.ps1` ·
`tools/daily.ps1` · `tools/daily-review.ps1` · `tools/review.mjs`（审稿台，67 KB）· `tools/start-review.mjs` ·
**`tools/common.ps1`（跨平台公共 helper：北京时间 / 起子进程的 shell / 图像根目录 / 路径拼接 / 只认退出码的子进程入口）** ·
根目录 `起审稿台.cmd`（审稿台启动器，经 `explorer.exe` 脱身 Job Object；`.cmd` 必须纯 ASCII/LF/无 BOM）·
`tools/news-taxonomy.json`（**见报分类唯一真相源**）· `tools/rss.config.json`（只管订阅地址，分类不在这里配）·
`tools/media-fallback.mjs`（ffmpeg 格式回退）。

状态文件（根目录）：`.env.local` · `.img-salt` · `.fetch-ledger.json` · `.review-passed-<日期>` ·
`.review-port` · `.publish-date` · `.daily-review.log` · `.review-station-<日期>.out.log/.err.log` ·
`.review-publish-<日期>.log`

---

## 硬约束（绝对不能做）

- **`.ps1` 必须 UTF-8 with BOM** —— PS 5.1 读「无 BOM + 中文」按 GBK 解码，多字节被拆成孤立引号，解析阶段就报错。`.mjs/.css/.html` 不受影响
- **`.cmd` 必须纯 ASCII / LF / 无 BOM** —— 带 BOM 第一行直接报错
- **`.env.local`、`.img-salt`、`.fetch-ledger.json` 绝不入库、绝不外泄** —— `.img-salt` 泄露等于泄露全部图片路径
- **不要给原生命令加 `2>&1`** —— PS 5.1 会把 stderr 转成 ErrorRecord，脚本是 `$ErrorActionPreference='Stop'`，python 打一行 warning 就能干掉整轮。发布重定向要用 `*>&1`（`Write-Host` 走 host 不走 stdout）
- **PS 5.1 的 `Start-Transcript` 抓不到原生命令 stdout** —— 原生命令要接 `| Out-Host`，否则日志少一大半
- **`detached` = 不继承控制台；`windowsHide` = 隐藏窗口** —— 别混。`cmd /c start` 后面必须带 `/b`；`start /b` 不能配 `windowsHide`
- **`detached: true` 在 Windows 上会让 `powershell.exe` 137ms 内「成功」退出**（exit 0，一个字都不输出）—— 要起无控制台的 node 进程用 `tools/start-review.mjs`
- **审稿台必须既没有控制台、也不在任何 Windows Job Object 里** —— 它是长驻进程：挂在准备窗口的控制台上，窗口一关就被腰斩；落在带 `KILL_ON_JOB_CLOSE` 的 Job 里会被**强杀**（无 stderr、无退出码、无事件日志）。2026-11-08 09:00 那次事故的真凶是后者。`detached` 只解决控制台，**不能**脱离 Job（Node 的 spawn 没有 `CREATE_BREAKAWAY_FROM_JOB`）→ 必须经 `explorer.exe` 起（见「每日流程」）
- **审稿台的 Delete 键 = 直接真删当前这张图**（2026-11-09 改）—— 不进隔离区。审稿是**人眼判定**，看过就是该删；隔离区是给**清洗脚本**兜底的（规则判定，误删过正常梗图，源站图床挂了取不回来）。批量删除仍走「应用勾选（删除）」那条路（**带确认条**）。⚠️ **删掉的图回不来**：抓取台账记着「抓过」，重跑抓图会直接跳过（要找回得清掉台账里那条 URL 记录）
- **清洗的删除走隔离区不是硬删**：`src\<日期>\_quarantine\<分类>\<原文件名>`（同名加 `_1`/`_2`）。改清洗规则**先 `--dry` 再真删**
- **分类撞名不覆盖**，另存 `_m1`/`_m2` —— 覆盖等于悄悄删了别人那张图
- **判重键直接用 `fetch-rss.mjs` 的 `normalizeLink`**，不要手抄正则
- **见报分类唯一真相源是 `tools/news-taxonomy.json`**；漏配新源 → **构建直接失败**，不静默归「其它」
- **写 Pages 密钥必须用 `npx wrangler pages secret bulk`**（REST PATCH 返回 200 success 但根本没写）；判断状态用 `wrangler pages secret list`；**改完密钥必须重新部署才生效**
- **R2 条件写键名是 `etagMatches`**（不是 `etagMatch`）；冲突时 `put()` 返回 `null` 而不抛异常，必须看返回值
- **任何会写生产数据的验证脚本必须自带收尾** —— 早先的线上冒烟脚本在 `likes/<日期>.json` 里留了一票，收不回来
- **Pages Functions 路由 = 文件路径**；路由写错会回退首页返回 200 + HTML，图片全坏
- **临时文件用完必须清理**（`tmp-*` / `tools/.tmp-*`）；**删除文件一律用** `recycle-delete.cmd -- "<正斜杠字面量路径>"`，别用 `Remove-Item`

---

## 见报的分类体系（2026-11-11 改）

真相源 `tools/news-taxonomy.json`（**改这里 = 改分类，不用动代码**）。chip 顺序 = `categories` 数组顺序（固定，不随条数变）。

| # | 分类 | key | 装什么 |
|---|---|---|---|
| 1 | 热议 | `hot` | **纯热榜聚合**：微博热搜 / 知乎热榜 / 虎扑步行街 / 抽屉热榜 |
| 2 | 时政要闻 | `current` | 联合早报(中国·国际) / 路透中文 / 纽约时报中文 / 参考消息 / 每日环球视野 + 新华网 / 求是网 / 澎湃 / 侠客岛 / 长安街知事 / 卫星社 / 德国之声 / 法广 |
| 3 | 财经商业 | `biz` | 雪球 / Readhub早报 / 虎嗅 / 钛媒体 / FT中文网 / 财富中文网 / 华尔街见闻 / 新财富 |
| 4 | 科技数码 | `tech` | 驱动之家 / 爱范儿 / 36氪 / 差评 / 蓝点网 / 数字尾巴 / cnBeta / 雷锋网 / FreeBuf / 安全客 |
| 5 | AI | `ai` | **12 个专注 AI 的源**：AIHOT精选 / 即刻·AI编程 / APPSO / 量子位 / **机器之心 / 新智元 / 硅星人Pro / AI前线 / Datawhale / 晚点LatePost / 集智俱乐部 / PaperWeekly**（**外加关键词自动挂上来的**，见下） |
| 6 | 效率工具 | `tools` | 少数派 / 少数派发现 / 异次元 / 小众软件 |
| 7 | 技术社区 | `dev` | V2EX(热榜·创意·技术) / LINUX DO / 掘金(社区·最热) / NodeSeek / 即刻·行业内幕 / w2solo / infoQ中文 / 潮流周刊 |
| 8 | 深度阅读 | `deep` | 阮一峰 / 博海拾贝 / 知乎日报 / 人人都是产品经理 / 字节跳动技术团队 / 美团技术团队 / 理想生活实验室 / 果壳网·科学人 |

- **原来 6 个分类里 5 个是科技味的** → 中文时政只能塞「热议」，热榜和时政混在一起；**一个正经财经类都没有**，雪球被挂在「深度阅读」里。2026-11-11 开「时政要闻」+「财经商业」两个类，顺带把 5 个时事媒体从 hot 挪走、把雪球从 deep 挪走。
- **RSS 源从 29 个加到 59 个**（新增 30 个，全部实测过：200 + 合法 RSS + 最新 0~2 天前）。`maxItems` 同步从 87 调到 **232**。**2026-11-12 再加 8 个 → 67 个源**（见下面「AI 分类怎么充实的」）。
- ⚠️ **AI 分类会被关键词撑大**：`keywordTags` 里命中「AI/大模型/GPU/…」的条目会**自动追加** AI 标签 —— **2026-11-12 实测（352 条见报）**：AI 分类 **89 条**（chip 口径），其中 **39 条来自 12 个 AI 专属源**（主标签口径，每条唯一），另外 **50 条是各行各业的文章被判成 AI**（V2EX 的 Claude 话题 / infoQ 的模型发布 / 华尔街见闻的算力股 / 少数派的派早报…）。**这 50 条不是误判** —— 它们确实在讲 AI，只是不是「AI 专题报道」。要收紧就改 `keywordTags` 的词表。
- 改完必须 `node tools\test-news-taxonomy.mjs`（断言里写死了「有 8 个分类」）。
- ✅ **线上当期是 11-15 期**（2026-11-15 上午发布，两期一起上）—— 根路径 → 11-15（`manifest.glbf83.js`，197989 字节，SHA256 `E05A60CAEF5F539478B359A4E264595924476AD3D5C51C2C28D7FD69802BCA06`，**线上与本地字节级一致**；**照片 224 张 / 见报 232 RSS + 121 头条 / 8 分类 / 配图 173 条**）。部署快照 `https://b663d719.your-project.pages.dev/`。线上 `/archive/` **22 期**（10-25 ~ 11-15）。
- ✅ **11-14 也补发了** —— `manifest.2kxqkw.js`（216812 字节，SHA256 `6B3A83B6F6F6E1740F34D0B1C3272D22A5864E39B28069AFE3990B53D1A18F4C`，与本地一致），照片 305 张，见报 232 RSS + 140 头条 / AI 96 / 配图 174 条。快照 `https://1ca7f0f5.your-project.pages.dev/`。
- ⚠️ **发布顺序的规矩：根路径 = 最后构建的那一期** —— `build.mjs` 写根 `index.html` 时用的是**本次构建的日期**。所以要一次发两天，必须**先建旧的、最后建新的**（先 11-14 再 11-15），否则根路径会停在旧的一期。
- （历史）11-12 期：根路径 → `manifest.1k4edem.js`，214386 字节，SHA256 `CE0474200E46C071BCA124CB1B860D4C0A6C6F4232310E099577265FEC124A07`，**线上与本地字节级一致**；**352 条 / 8 分类 / 70 来源 / 171 条带图**，照片 312 张。部署快照 `https://e28ea924.your-project.pages.dev/`。R2 上传 **794 个文件 / 33.38 MB**（73.4s），Pages 部署 exit 0。
- ✅ **往期 18 期已按新 taxonomy 重分并一起上线**（`--retag`，**内容零改动**）—— 10-25 ~ 11-11 每期一个 manifest，线上 `/2026-11-04/` 引用 `manifest.k2mb8s.js` 与本地一致。**旧的 10 个分类名（微博/知乎/科技/社区/效率/即刻/资讯/博客/数码/V2EX）已全部消失**，现在往期也是 8 分类版。
- ✅ **线上核验全过（11-12 那轮）** —— `verify-news.mjs https://example.com/` **53/0**（AI 显示 **89/352**）· 抽 3 张配图真取 → **200 + image/webp** · `/archive/` 当时 **19 期** · 浏览器实看线上：机器之心 4 条**全部带图渲染**、往期 11-04 chip 已是新分类 · **零 4xx/5xx**。

### AI 分类怎么充实的（2026-11-12）

用户拍板「完善 AI 的内容 + 把专注 AI 的 RSS 归到这个分类 + AI 内容的来源放进 AI 分类」，落成三件事：

**① 加了 8 个专注 AI 的源 → 主分类直接归 `ai`**（`news-taxonomy.json` 的 `sourceCategory`）

| 源 | 性质 | 为什么只能这么拿 |
|---|---|---|
| 机器之心 / 新智元 / 硅星人Pro / AI前线 / Datawhale / 晚点LatePost / 集智俱乐部 / PaperWeekly | 中文 AI 垂直媒体 | **官网 RSS 全死了** —— 机器之心 `/rss`、`/rss.xml`、`/atom.xml` 三个地址都返回 HTML；PaperWeekly 域名不通；硅星人官网域名被抢（跳 `/lander` 广告页）。**公众号镜像是唯一长期通道** |

全部走 `wechat2rss.bestblogs.dev`（站里已在用：APPSO、掘金技术社区）→ **不引入新的第三方依赖**。
**没加**：雷峰网公众号（官网源已在，文章重复）；智谱 / 通义 / 阶跃 / DeepSeek 公众号（停更 8~115 天，过期闸门会全丢）；宝玉（停更 23 天）；TechNode（2000 条但全英文标题）。

**② 关键词表从 10 个词扩到 33 个** → 非 AI 源里的 AI 文章**自动追加** AI 标签。加的是实测标题里真出现过的模型名（DeepSeek / Gemini / Kimi / Llama / Qwen / Mistral / Copilot / Cursor / Agent / Anthropic / OpenAI）和技术词（具身智能 / 多模态 / 大语言模型 / 推理模型 / 扩散模型 / LLM / AGI / RAG / MCP / GPU / 算力）。

**③ 关键词表里故意不放「英伟达」** —— 这是**实测踩出来的坑**（2026-11-12）：加上它之后，那天 14 条「黄仁勋婚外情 / 董事会罢免 CEO」的**公司治理八卦**全被拖进 AI 分类。英伟达真正的技术新闻本来就带 GPU / 算力 / 芯片，由那几个词兜住；治理新闻只提公司名，不该进 AI。去掉后 AI 从 98 条回到 87 条（砍掉 11 条纯治理新闻）。
**同理故意不加**：机器人（工业自动化也用）、芯片（驱动之家整站都是芯片新闻，加了等于把整个源拖进 AI）、模型（太泛）、Token（财经文里也常见）、论文（任何学科都发）、推理（逻辑/刑侦语境）。

**AI 分类现状（2026-11-12 试构建，352 条见报）**

| 口径 | 条数 | 含义 |
|---|---|---|
| chip 口径 | **87 条**（带图 18） | **用户点「AI」chip 实际看到的** |
| 主标签口径 | **38 条** | 12 个 AI 专属源，每条唯一 —— 和 = 见报总数，可用来对账 |

剩下 49 条是各行各业被判成 AI 的文章（V2EX 的 Claude 话题 / infoQ 的模型发布 / 华尔街见闻的算力股 / 纽约时报的「英伟达将与 Anthropic 绑定」…）—— **不是误判**，它们确实在讲 AI，只是不是 AI 专题报道。

⚠️ **两套口径别混**：chip 筛选走 `tags`（一条可属多类，各分类之和 401 > 352 是**正常的**）；主标签 `tag` 每条唯一（和正好 352）。详见本文件「分类有两套口径」那条坑。

**新增源的已知限制**

- **公众号镜像条目本来就有图（2026-11-12 实测推翻旧结论）** → 旧记录写「公众号镜像条目带图 0/10」是**错的**：那会儿探到的是镜像站**还没加 img-proxy 的旧版 feed**。现在实测 8 个 AI 源 **10/10 条目有候选图**（共 57~80 个/源），而且镜像站把原图包成 `img-proxy/?k=…&u=<mmbiz 地址>` 的代理形式 → **既不用抓 `mp.weixin.qq.com` 原文页（那边被反爬挡着，3 组请求头都只返回 18KB 的「环境异常」验证页），也顺带绕开了 mmbiz 的防盗链**。抽样 32 条实测 **32/32 过筛**（892×380 ~ 1280×1592，18~258KB，全 image/jpeg）→ 9 个公众号镜像源已进白名单。
- **APPSO 不是「镜像上也没了」，是配置里的地址被截断**（2026-11-12）→ 配置写的是 38 位 `…4ae111e5b509609a5ee96c9894f1868fba` → 一直 HTTP 500；用户给的完整地址是 42 位 `…4ae111e5b509609a5ee96c9894f1868fbafd793e.xml` → 改完后 **200 + 10 条 + 9 条带图 + 最新 11-11**。**教训**：镜像源「连续 500」先怀疑**地址抄漏了尾巴**，别急着判死刑。
- **`fairCap` 不变**：`maxItems=232` 是硬上限，源数 59 → 67 后 `fairCap = max(2, ceil(232/67)) = 4`（**还是 4**），且「每源保底 1 条」保证新源一定露脸 —— 代价是老源从平均 3.9 条降到 3.5 条，**没有源被整个挤掉**。

---

## 产物有效性：三道闸门（2026-11-16 加）

**真实事故（不是假想）**：2026-11-15 那次发布把一个 **0 字节** 的 WebP 传到了生产 R2 桶，
线上代理以 `HTTP 200 / Content-Length: 0 / Content-Type: image/webp` 吐出来 →
2026-11-14 归档页那一格是裂图（**状态码 200，监控看不出来**，撤回还要等 24 小时边缘缓存）。

**根因链** —— 三道闸门各漏了同一件事：「存在」≠「能用」：

| 闸门 | 改之前 | 改之后 |
|---|---|---|
| `tools\build.mjs`（`--no-convert` 复用路径） | `fs.access` 只查「文件在不在」→ 0 字节也算「在」→ 被当成合法产物复用，一路传下去 | 真读文件头：0 字节 / 坏文件头 → **回退成真转码**，日志点名是哪个文件、什么问题（`部分产物缺失或损坏（…），自动回退为重新转码`） |
| `tools\verify-build.mjs`（发布闸门，publish.ps1「产物自检不通过，已中止」） | `fs.existsSync` 只查存不存在 → 自检放行 | 存在 **且** 是有效 WebP；有问题 → exit 1 + 说人话的中文描述（哪个文件、什么问题） |
| `tools\upload-r2.mjs`（上传前） | 只按文件名正则 `PRODUCT_RE` 过滤 → 0 字节照传不误 | **所有**日期的产物先过一遍有效性；有坏的就**一张都不传**，exit 1（`--dry` 也要把坏文件列出来） |

三处都复用 `tools\webp.mjs` 的 `webpSize(file)`（直接读字节、不起进程，微秒级 —— 当期几百上千个产物扫一遍不心疼）。
**注意**：`webpSize` 对 0 字节文件也会抛错（「文件过短」），所以三处都额外判了一次 `st.size === 0` ——
不是为了「拦住」（webpSize 已经拦住了），是为了**报错说人话**：
「是 0 字节的空文件」比「不是有效的 WebP（WebP 文件过短）」一眼看得懂。

**护栏**：`tools\test-product-validity.mjs`（**43/0**）—— 真跑三份脚本：在临时工程里造 0 字节 / 坏文件头的产物，
看它们拦不拦得住（`--dry` 也验、真上传路径用夹具把 `fetch` 换掉，保证**一个网络请求都发不出去**）；
`tools\test-product-validity-mutate.mjs`（**10 处变异全被抓**）—— 每条变异还指定了「必须保持绿」的断言，
确保红的正好是指定的那几条，不是别的断言碰巧红了。

⚠️ **本轮发现、但没有修的洞**：`verify-build.mjs` 里「见报配图（`it.img`）」的核对写在
`tab.key === 'news'` 那一支，而**真实的见报 tab 带 `type: 'headlines'`** → `isTextTab(tab)` 为真 →
那一支被 `continue` 掉了 —— 也就是说**见报配图（以及「见报重复链接」那一项）在生产里其实没被自检过**
（2026-11-16 实测 `published/2026-11-16/manifest.*.js`：news tab 的 `type='headlines'`）。
本轮只按要求给那处补了有效性检查，**没动这个可达性问题** ——
动它之前要先确认线上母本里的配图都在，否则一上线就会把发布拦死。

---

## 已知坑（现象 → 根因 → 正确做法）

- **护栏断言里只写字段名 → 注释里提到同一个名字就把断言蒙过去了** —— 断言写成 `/it\.cover/.test(源码)` 时，**注释里写一句「必须把 it.cover 也算进来」就能让坏版本照样绿**。正解：断言匹配**代码结构**（如 `/for\s*\(const\s+u\s+of\s*\[\s*it\.full\s*,\s*it\.thumb\s*,\s*it\.cover\s*\]\s*\)/`），别只匹配标识符
- **变异锚点在文件里出现两次时，只改第一处护栏照样绿** —— 2026-11-16 踩到两例：`${nonce}_${String(seq)...}.webp`（初次赋值 + 撞名重试）和 `force_original_aspect_ratio=decrease`（代码 + 注释）各出现两次 → 变异器要支持 `replaceAll`（或锚点选到唯一处）
- **同一个代码形状出现在两个渲染路径里时，变异锚点会变得不唯一** —— 见报和榜单各有一套一样的搜索框 → 「清空按钮不绑事件」那条变异从「命中 1 次」变成「命中 2 次」→ 锚点要多带几行才唯一
- **发布链路不重跑抓取器 —— 改了层级标签 / 标签字面，当期线上还是旧结构** —— `tools/publish.ps1` 只跑 `node tools/build.mjs --date <日期>`，**不会**跑 `fetch-rank.mjs` / `fetch-follow.mjs`。所以光改抓取器，当期发布的还是旧标签（新标签要等第二天重新抓取才生效）。正解：**改标签时必须同时迁当期的源数据** `~/image-root\src\<日期>\rank_<日期>.json` / `follow_<日期>.json`。迁移脚本三条：① 先备份（`.bak-tag-migration`）② 先验证「原样再序列化 == 原文」（确认 `JSON.stringify(obj,null,2)` 的格式跟原文件一致，不一致会把整个文件重排、diff 全是噪音）③ ⚠️ **打完补丁再序列化** —— 第一次写这脚本时把序列化结果在补丁前就存进了变量，写回的是**没改过的内容**（文件看着被重写了，其实一个字没变；幸好格式自检过了没造成损坏）
- **日常流程里没有抓取器 → 22/23 期线上只有 4 个 tab，而且全程不报错** —— 榜单/追更都是**构建期静态数据**，`build.mjs` 只读 `src\<期号>\rank_<期号>.json` / `follow_<期号>.json`，**它自己不会去抓**；而 `daily.ps1`（桌面两个入口的**共同汇聚点**）以前只有 抓图→头条→清洗→构建 四步。后果链：源目录里没有那份 JSON → 构建**静默跳过**（只打一行「没有 rank_xxx.json，跳过」）→ 线上少两个 tab，**没有任何报错**。v3 之后后果更难认（看片只有 2~3 个目录，像网站坏了而不是像漏抓）。正解：把抓取器**收进日常流程**（`daily.ps1` 第 4 步，`--date $publishDate` 传**期号**）+ 留 `-NoRank` 逃生口（网络不通时能手动跳过）+ 「缺段」由构建**点名**报出，不许静默跳过
- **护栏的正则只认某一种参数形态 → 新写的调用从缝里漏过去** —— 2026-11-16 实测：`test-daily-review.mjs` 的「原生命令」扫描写的是 `/^\s*&\s+(\$py|node)\s+@/`（只认**数组展开** `@(...)`），而第 4 步新写的调用是 `& node $fetcher --date $publishDate`（直接传参）→ **完全落在正则外面**，它的 `| Out-Host` / 无 `2>&1` 纪律**没人盯**。正解：扫描按「**调用了哪个可执行文件**」认，**不看参数形态**；只把真正例外的（`-c "import X"` 自检、`-m pip install`）显式豁免并写清理由。通用形态：**护栏的匹配面要覆盖「所有写法」，别只覆盖「当时已有的那种写法」**
- **断言「有个 X」时，同一文件里有两句相似的就会假绿** —— daily.ps1 第 4 步有主标题 `Step '4/5 抓榜单…'` 和 else 分支那句 `Step '4/5 跳过抓榜单…'` → 断言 `/Step\s+'4\/5/` **两句都匹配** → 删掉主标题护栏照样绿。正解：断言要**认准那一句**（`/Step\s+'4\/5\s+抓榜单/`）。通用形态：**同一文件里出现两次的形状，断言必须区分是哪一次**（护栏自己写两个 `#` 注释也会撞车）
- **「目录顺序」是数据顺序，不是配置项 —— 改顺序要改数据拼接顺序，护栏必须钉死顺序** —— 2026-11-16 v3 实测：看片的五个大目录（频道更新 / 电影 / B站热门 / 抖音热门 / 本地演出）来自条目的 `@1:` 标签，而 `site/app.js` 的 `renderChips()` **按条目在列表里的出现顺序去重现推 chip、不排序** → 数据里的顺序 = 用户看到的目录顺序。所以「调目录顺序」= 改 `build.mjs` 里 `watchList` 那一行数组的顺序，**前端根本没有「目录顺序」这个概念，别去改前端**。⚠️ 护栏只断言「包含这五段」是**抓不住顺序错乱**的 → 必须断言**拼接表达式的确切顺序**，并配一条「把顺序改掉」的变异
- **变异脚本的锚点会随被测源码改写而漂移 —— 报「变异点没在原文件里找到」时，先分清是「锚点旧了」还是「护栏旧了」** —— 2026-11-16 踩到：worker 把 `verify-build.mjs` 的 `if (isTextTab(tab)) continue;` 改成带本地化封面校验的块结构（`if (isTextTab(tab)) { … continue; }`），**护栏 `test-rank-tab.mjs` 已经同步更新成新结构的断言**（`/if\s*\(\s*isTextTab\(\s*tab\s*\)\s*\)\s*\{/` + region 里必须含 `it.cover`），**只有变异脚本的 `from` 锚点没跟上** → 那条变异被判成「没找到变异点」→ 43 处只抓到 42 处，回归变红。正解（分诊顺序）：**先读护栏的断言** —— 护栏期望**新结构** = 锚点旧了（只改变异脚本的 `from`/`to`，**别去动护栏**）；护栏也期望**旧结构** = 两者都旧了（护栏才是真缺口，要补断言）。配套：锚点挑**结构上唯一**的片段（`if (isTextTab(tab)) {` 而不是整个块），并在变异脚本里**写清锚点为什么这么选**，源码下次再改时一眼看出该往哪儿挪
- **变异脚本要自带「锚点自检」：锚点不是唯一命中就判脚本过期，别混进「没抓到」的统计里** —— `test-product-validity-mutate.mjs` 开头有一段自检（每个 `from` 必须在被改文件里**恰好命中 1 次**，否则 exit 1 并写明「变异脚本过期了（源码改了？）」）；`test-rank-tab-mutate.mjs` 没有，只在跑到那条时打印「变异点没在原文件里找到（源文件变了？）」→ 漂移的锚点被算进「只抓到 42 处」，看起来像**护栏有缺口**，其实只是脚本过期。正解：两条路都要走 —— ① 变异脚本加锚点自检（过期就明确说「脚本过期」，别报「没抓到」）② 先读护栏断言确认是锚点旧还是护栏旧，再决定改哪边
- **审稿台一个会话只能发一次 —— 「已经在发布了」不代表真有发布在跑** —— 2026-11-16 实测：当天 08:00 发过一次后，22:03 再调 `POST /api/publish` 一直返回 **409「已经在发布了，等它跑完」**，但**进程列表里根本没有 publish.ps1 / build.mjs / upload-r2**，发布日志文件也停在 08:05 没再动过。根因：状态端点只在「死进程」分支里把 `publishState.running` 置 false（`if (st.dead && !publishState.deadNote)`），**正常完成路径不清这个内存标志** → `startPublish()` 的守卫永远为真。正解：**重启审稿台再发**（`node tools/start-review.mjs <日期>`；Windows 上**必须走默认路径**（经 explorer.exe 脱 Job Object），`--direct` 从 agent 的 shell 里起会被 Job 连坐杀掉），然后 `POST /api/publish`（它会重写放行凭证 + 清空发布日志 + detached 起 runner）。⚠️ 重启后**要让用户刷新浏览器页**（旧页面的轮询还打在被杀掉的进程上）
- **测「目录穿越 / 鉴权防护」时，请求路径里的 `..` 会被 URL 解析器提前归一化 → 断言假绿** —— 2026-11-16 实测：用 `fetch('/../canary.txt')` 测「不能读到伺服根之外的文件」，**WHATWG URL 解析器在请求发出前就把 `..` 消掉了** → 服务器收到的是 `/canary.txt` → 404 → 断言「没泄露」看着通过，**其实请求压根没穿出去**。正解：① 判据改成**金丝雀**（在受保护范围外放一个内容带唯一标记的文件，断言「**响应体里没有那个标记**」，而不是断言状态码）② 再补一条**能真正打到防护**的路径：`%2f..%2f`（`%2f` 不会被解析器解码，是服务器自己 `decodeURIComponent` 之后才变成 `..`）→ 那条才真的走防护分支（403）。**通用形态：安全类断言要判「有没有泄露」，别只判状态码**
- **「线上裂图」和「本地预览裂图」是两回事 —— 先确认你看的是哪个** —— 2026-11-16 用户报「见闻 见她 见笑 和 logo 裂了」，查下来**线上全绿**（逐项核 + 170 张缩略图并发压测全中 + 冷加载零失败请求），裂的是 8809 本地预览。判据：**预览是本机 HTTP、线上是公网 CDN**，两者要分别验证；看到「裂图」先问一句「这是线上还是预览」
- **护栏断言自己抛异常时，崩溃造成的红不算红** —— 2026-11-16 踩到：`httpGet` 在 301 上会抛 `Error: HTTP 301`，变异一关掉「自己跟跳转」，测试就在**第一个 `await`** 处死了 → 后面所有断言根本没机会跑 → 变异测试判成「FALSE_RED」（红是崩出来的，不是断言判出来的），**护栏的真实缺口被盖住**（当时 39/40，看着像「抓到了 39 个」，其实那 1 个是假红）。正解：① 把可能抛的调用包进 `try/catch`（同文件 11.2/11.3 段本来就这么写）② 下标取值用 `?.` + `??` 兜底 → 让断言**干净地红**。通用形态：**任何护栏断言都不能自己抛异常 —— 崩掉的红不是红**
- **本地预览必须伺服「构建根」而不是「日期目录」，并且把 `/img/*` 映射到 R2 母本** —— 2026-11-16 踩到：8809 预览伺服的是 `tools\.tmp-v2-build\2026-11-16\`（日期页那一层）→ ① 日期页的 logo 路径是 `../assets/logo.webp`，解析到根后**根下没有 `assets/`** → **logo 裂成裂图标** ② 构建输出里**没有 img/ 目录**（图片只走 R2 私有桶 + Pages Function 代理）→ **三栏照片整片 404 空白**。正解：新增 `tools/preview-server.mjs` —— 伺服 `published/`（= 线上部署面，跟线上长得一模一样）+ 把 `/img/<日期>/<分类>/<文件>` 映射到**本地 R2 母本** `~/image-root\r2`（与线上 URL 结构完全一致）+ 补 **clean URL**（`/board/` → `board.html`，跟 Cloudflare Pages 的规则一样）。现在预览 **480/480 张站内图全中**、logo/CSS/JS 全通。⚠️ 判据：**「预览里裂图」先问「伺服的是哪一层」，别默认线上坏了** —— 这次线上其实全绿（170 张缩略图 170/200、logo 200、冷加载零失败）
- **本地预览里 `/img/*` 必然 404 —— 那不是 bug** —— 预览是 `python -m http.server` 指向**构建输出目录**，而构建输出里**没有 img/ 目录**（图片只走 R2 私有桶 + Pages Function 代理）→ 本地化封面在预览里必然裂图；**真实验收只能在发布后查线上**，或直接查 R2 母本 `~/image-root\r2\<日期>\covers\`（**这条已被上一条取代：现在用 `tools/preview-server.mjs`，预览能出真图**）
- **「文件存在」不等于「文件有效」—— 0 字节产物会一路混到线上（2026-11-16 实测真缺陷）** —— 现象：`~/image-root\r2\2026-11-14\jianshe\962bbae53f_091.webp` 是 **0 字节**，线上代理照样以 **`HTTP 200 / Content-Length: 0 / Content-Type: image/webp`** 吐出来 → 归档页那一格是裂图，而**构建日志全程报「成功」**。根因链：① 某次构建转码被中断 → 留下 0 字节 ② `build.mjs` 的 **`--no-convert` 复用路径只 `fs.access` 查「存不存在」** → 0 字节也算存在 → 复用 ③ `verify-build.mjs` 查引用产物**也只查存在** → 自检放行 ④ `upload-r2.mjs` **只按文件名正则过滤** → 照传不误。`toWebPChecked()` 其实**已经**会查 `size > 0` 并重试/抛错 —— 漏的是**复用路径**和**下游三道检查**。正解：**存在性检查一律升级成有效性检查**（用 `tools/webp.mjs` 的 `webpSize()`，它对过短/非 WebP 会抛错）—— 复用路径判「无效就重转」、自检判「无效就中止发布」、上传判「无效就不传并报错」
- **豆瓣封面本地化后是站内路径，挂在条目的 `cover` 字段上（不在 `full`/`thumb` 里）** —— 只收 `full`/`thumb` 的工具（`r2-prune.mjs --orphans`）会把它**当孤儿删掉** → 线上直接裂图。`orphan-clean.mjs` 是从 manifest **原文**正则抓的 → 任何字段里的站内路径都算，自动保住
- **TVmaze `schedule?country=` 给不出任何一个用户点名的平台** —— 它是**按剧去重**的（一天 92 条 = 92 部剧）且 **country 不给就默认 US** → 5 国 × 3 天实测 Netflix / HBO Max / Prime Video **全是 0 条**。必须用 `/schedule/full`（集级、忽略 country），且 `date=` 是**窗口起点**不是精确一天 → 自己按 `e.airdate === 目标日` 过滤
- **「搜不到」≠「不存在」** → 全盘搜索没搜到中文文件名 → **先打开目录看一眼再写进文档**（README 曾误写「`一键更新.cmd` 已不在工程里」）
- **PIL 放行 ≠ 图片没坏** → Pillow 遇截断 JPEG 静默补灰不报错 → 用 `tools/media-fallback.mjs` 的 `runWithFormatFallback()`（默认探测失败强制 `-f image2pipe` 再试一次）
- **构建全程报「成功」但线上裂图** → 随机段含「序号」，删一张图后面全部改名 → `verify-build.mjs` 四项对账，不过不发布
- **「见闻」整栏归零但日志「成功」** → 两个独立原因。① **喷嚏图卦换了图床**：老 URL `/dapenti/<目录>/<文件>.jpg`，新 URL `/codex-image-assets-<hash>/Dapenti%20Pic%20Manager/文章图片/<文件>.jpg`（端口 :99）—— 写死 `"/dapenti/" in u` 的过滤器会滤掉 34 个 `<img>` 里的 33 个。正确过滤是收两种形态、排掉固定 banner（663×100）、新浪表情（外部域名）、站点小图标（相对路径 `cdwj.gif`）。**一页 34 个 img = 30 内容 + 1 banner + 2 微博表情 + 1 图标**；排查看 `grab.log` 里 `解析出 N 张候选图片` 的 N（正常 ≈30，**N=1 即换图床**）。② 抓取器按「取最新」而非**内容日期**选图卦文章（off-by-one）→ 用 `_parse_tugua_date()` 按内容日选：站点当天早上就发当天那期，提前抓走 → 第二天全被台账判「抓过」→ 整栏归零而日志报「成功」
- **「见她」常年 0 张但日志「成功」** → 煎蛋只请求了不带 `page` 的最新页 → 登录墙只挡很老的页，要从最新页往前翻
- **福利吧整站维护** → 所有路径返回 HTTP 200 的「提示信息」页 → 只看 200 会误判「已上线」，还会把「n=0」写进台账**导致真正的这一期被永远跳过** → 加 `_fuliba_is_notice_page()`，urls 为空时不写台账
- **福利吧站点正常、但还没发新一期**（另一种失效模式，别跟「维护」混）→ 只能拿到上一期 → 那一期的图以前抓过 → 台账**全跳过** → **该源 0 张贡献**，日志只写一句「这一期 X 已经抓过 —— 源站大概率还没发新一期」。**不是抓取 bug**，判据是「源站最新期号 vs 目标内容日期」：2026-11-09 实例 = 第 157 期 `2026157.html` 404 未上线、第 156 期 116 张全是旧的 → **见她 124 → 71（−53）**、见笑 174 → 116（−58）。补抓办法：等它发了新期后重跑 `tools\daily.ps1`（台账会自动跳过已抓的、补上新的），然后**重新构建**
- **福利吧 `.gif` 看着像重复** → 实测 md5 / pHash 全不同，是同一相册的不同照片 → **差点误删 190 张真照片**；判重必须看内容，不能只看文件名像
- **福利吧的 `.gif` 内容其实是 JPEG** → ffmpeg 自动格式探测会失灵（报 `End of file`）→ 走格式回退机制。注意 `sinaimg .../large/xxx.gif` 实测**连抓 3 次内容完全相同**，跟「同系列不同照片」是两回事
- **每次拉取同一批图完整下载两遍** → 福利吧 RSS 滞后于发文 → `fetch_ledger.py` 台账**下载前**查表（归一化 URL），命中连 HTTP 请求都不发
- **「文件已存在就跳过」永远命中不了** → 文件名用 `abs(hash(url))`，受 `PYTHONHASHSEED` 影响 → 改成 `md5(url)` 前 5 位
- **逐张分流把同一个写真相册劈成两半** → 逐张判据在人脸小 / 肤色被稀释时失效 → 相册段级多数票
- **清洗误删正常梗图** → 主词表含单字「信」和裸 `@handle` 这类弱特征 → 移到 `AD_CONTEXT` 语境词表
- **线上照样出广告横幅而清洗「成功」** → 清洗按 `--date` 找目录，洗的是**昨天已发过的目录** → 清洗跟发布日走
- **pHash 阈值 8 跨目录误伤** → 8 是给「见闻」滚动截图调的 → 按目录分开定（见闻 8 / 见她·见笑 5），跨目录取 `min`
- **切 tab 图片加载不出来（等 38~62 秒）** → 浏览器同域只开 6 条连接，预载的全尺寸图占满队列 → 前端自建加载队列（并发 6 / 切 tab 中止旧请求 / 失败重试 2 次）
- **「本机探测 403」≠ 链接坏了** → 本机出网是新加坡机房 IP，知乎一律 403 → 用内容级证据反查
- **源对 `Accept` 头做精确匹配（回 419）** → 必须用 `application/rss+xml, application/xml, text/xml`，不能 `*/*`
- **源返回 200 但不是 RSS** → 先检查内容里有没有 `<rss>`/`<feed>`，没有就判该源失败
- **重试只针对网络层失败**（超时 / 连接重置 / socket 断）—— 4xx/5xx 和「200 反爬页」不重试
- **「项目创建失败」跟项目存不存在毫无关系** → `wrangler pages project list` 网络失败时输出为空 → 列表查询退出码非 0 就中止，不去猜「项目不存在」而 create
- **R2 上传成功 ≠ Pages 部署会顺** → 两条链路（`api.cloudflare.com` vs S3 端点）抖动时机不同 → 部署自带 4 次重试（10/20/30 秒）
- **发布跑到一半才炸，但手动跑同一脚本是 `RESULT=READY`** → 审稿台是长驻进程，环境变量是**启动那一刻的快照** → `publish.ps1` 第 0.5 步强制覆盖 `CLOUDFLARE_API_TOKEN`；`review.mjs` 用 `freshEnv()` 重铺
- **`pages deploy` 报奇怪的错但 `pages project list` 正常** → OAuth token 只有几小时寿命，且**认证失败有两种长相**（401+10000 / 400+9106）→ `tools/refresh-token.mjs` 自动续期写回 `.env.local`
- **「发布失败但看不出为什么」** → 发布日志原来只在内存，审稿台一死日志蒸发 → 输出落盘 `.review-publish-<日期>.log`，结束标记由发布进程自己写 `=== PUBLISH_DONE exit=N ===`
- **审稿台和发布子进程同时静默消失** → 不是控制台连坐，是 **Job Object 连坐**：本机 openclaw 进程监督器给会话建了带 `KILL_ON_JOB_CLOSE` 的 Job（`openclaw/dist/process/supervisor/service-child-windows-job-anchor.js` 里的 `SetInformationJobObject` / `TerminateJobObject`），Job 一关里面的进程被**强杀** —— 无 stderr、无退出码、无事件日志，跟「程序自己崩了」一模一样。`detached`（DETACHED_PROCESS）**不能**脱离 Job。判据用 `IsProcessInJob(hProc, NULL, &r)`（NULL job = 「是否在任意 Job 里」）：从 agent 的 bash 起的**在 Job 里**，从桌面快捷方式（explorer.exe）起的**不在**。解法：`tools\start-review.mjs` 经 `explorer.exe` 起（Explorer 本身不在任何 Job 里）
- **⚠️ Cloudflare 的 OAuth token 只活 1 小时，发布链路会跨过过期点（2026-11-15 实测的真凶之二）** → 症状：R2 上传阶段**几百个文件 401 code 10000（Authentication error）**，另有一批「重试耗尽」→ `upload-r2.mjs` exit 1 → publish.ps1 throw → **Pages 根本没部署**。
  **真因**：token 只活 1 小时（`expires_in = 3600`）。发布开头续期时 token 还剩 **12 分钟**，判断「有效」放行；而「构建 + 产物自检 + R2 探测 + 审稿闸门 + 上传（782 个文件 / 3~8 分钟）+ 部署」整条链路完全可能跨过过期点。
  **修法（两处）**：① `tools/refresh-token.mjs` 加**最小有效期余量**（`MIN_TTL_MS = 15 分钟`，剩余不足就当它该续了；`isExpired` 保留给 `--check` 用严格判断）② `tools/publish.ps1` **上传前再续一次**（4.5 步），并且**把新 token 重新导进本进程的环境变量** —— 续期只改 `.env.local`，**子进程 `upload-r2.mjs` 继承的是本进程的环境变量**，不重导就白续。
  **护栏**：`tools/test-publish-natives.mjs` **32/0**（含：有最小余量、续期判断用 `needsRenewal`、至少续期两次、`Import-EnvFile` 至少两次、且上传前那次续期紧跟着重新导入）。**变异**：删掉上传前那次续期 → 3 条断言变红 exit 1。
- **发布「无退出码、无结束标记」多半是被一行 stderr 掀翻的，不是被 kill（2026-11-14 / 11-15 实测定位）** → 症状：`.review-publish-<日期>.log` 停在构建的「✓ 产物自检通过：manifest 引用的文件全部存在」之后（**下一步就是见报抓取**：67 个 RSS 源 + 头条），**没有 `=== PUBLISH_DONE exit=N ===`**（runner 是在 `publish.ps1` 返回之后**无条件**追加这一行的，缺它 = 脚本没走到最后）。
  **真凶**：PS 5.1 里原生命令往 **stderr** 写一行字就会被转成 ErrorRecord，而 publish.ps1 顶着 `$ErrorActionPreference='Stop'` → ErrorRecord 直接变**终止性错误** → 脚本当场死。那行字是构建打的「! 抓取过程中连接被重置（undici 已知崩溃），该源按失败处理，继续」（fetch-rss.mjs:57）—— **它只是提示**，build 自己会接着跑完，是 publish.ps1 被它掀翻了。
  **修法**：所有原生命令都走 `Invoke-NativeCmd` / `Invoke-NativeCmdCapture`（内部先把 ErrorActionPreference 降成 Continue，成败只看 `$LASTEXITCODE`）。**别把全局的 'Stop' 改成 'Continue'** —— 那样会掩盖真正该抛的错。
  **护栏**：`tools/test-publish-natives.mjs`（18/0，变异：把构建改回 `& node @buildArgs` → 3 条断言变红）。
- **审稿台的「发布中」不能只靠 45 分钟兜底（2026-11-15 改）** → 原来「还在跑」= 日志 2 分钟内动过 **或** 内存里那个标记还在；发布被腰斩时日志再也不动 → 界面一直转「发布中…」，用户看着像「审核了但没发布」。现在多一条判据：**日志 6 分钟没更新又没结束标记 = 进程已经不在了** → 立刻报失败（`tools/publish-state.mjs` 的 `computePublishState`，纯函数可单测，`tools/test-publish-state.mjs` 26/0）。
  ⚠️ 判死时**只把话术写进内存，不要写回日志文件** —— 写回去会刷新日志 mtime，「多久没动」就永远归零。
- **`build.mjs` 是先删后建**（第 955 行 `fs.rm(published/<日期>, { recursive: true })` → `fs.mkdir`）→ **构建一启动就清空那一期的目录**。所以发布被中途杀掉的后果不是「还停在上一版」，而是**空目录**（11-14 目录建于 09:25:39、11-15 建于 08:59:05，两者 `LastWriteTime == CreationTime`，一个文件都没写进去）**+ `published/index.html` 指向已被删掉的 manifest** → **绝不能在没重建的情况下直接 `wrangler pages deploy published`**（首页见报区会是空的）。
- **验「某期上线了没」不能只看 HTTP 码**（上面那条讲的是 `/img/`；**日期页同理**）→ 线上 `/2026-11-14/` 返回 200，但内容与根页**逐字节相同**（4030 字节）→ 那是 Pages 的兜底页，不是当期页。**比对要下原始字节算哈希**。
- **看到 `/img/xxx` 返回 200 但内容是 HTML** → Pages 找不到静态资源就回退首页并返回 200+HTML → **排查要看 Content-Type，不能只看状态码**
- **用户输了正确口令还是裂图** → Pages 给无 Cache-Control 的 Function 响应默认套 `max-age=14400` → 401/302 必须显式 `no-store`
- **开启口令后不带凭证仍能取到图** → 图片边缘缓存 TTL `max-age=86400`，请求根本不打 Function → 要立刻收回得清边缘缓存（或等 24 小时）；关闭口令则立即生效
- **线上留言板乐观锁从来没生效过** → 键名写成 `etagMatch`，真键名是 `etagMatches`
- **`opencv-python-headless 5.x` 让 `CascadeClassifier` 消失** → 5.x 删了 Haar 级联 → `pip install "opencv-python-headless<5"`
- **改缩略图尺寸必须同时把「输出规格」算进随机段** → 否则 URL 不变但内容变，边缘缓存最长 24 小时吐旧图
- **审稿台看的是源图不是转码产物** → 母本文件名带构建序号，未构建 / 刚删图时按序号反查会 404 一片
- **浏览器原生行为会把前端断言变成空壳** → Chrome 在 `<input type="search">` 里按 **Esc 原生清空输入框并触发 `input` 事件**（实测：`keydown → input → search → keyup`）。用真实按键测「Esc 清空」，Chrome 顶掉我们的实现、断言照样绿 —— 变异测试 M5 就是这么漏的（改了实现，全绿）。**测「只有我们的 JS 才做的事」必须用不可信事件**（Playwright `dispatchEvent('keydown', {key:'Escape'})`）：合成事件不触发浏览器默认动作，只走自己的处理函数。通用判据：**断言能不能被浏览器原生行为顶掉**，顶得掉就是假护栏
- **`<input type="search">` 会自带一个原生清空按钮** → Chrome / Edge / Safari 上它长在输入框**里面**，跟我们自己的 ✕ 按钮并排 → 页面上**两个清空按钮**（2026-11-09 线上截图才发现）。正解：`type="text"` + `inputmode="search"`（手机键盘照样出搜索键），清空控件就只剩自己那一个
- **同名源 ≠ 同一条 URL** → 外部源清单（anyfeeder 常用源列表）里「36氪 / 路透中文 / 雪球」判失效，跟我们**同名但 URL 不同**（那份测的是 `plink.anyfeeder.com/36kr`、`/reuters/cn`、`/xueqiu/hot`；我们用的是 `www.36kr.com/feed`、`reuters.buzzing.cc/feed.xml`、`plink.anyfeeder.com/weixin/xueqiujinghua`）→ **拿自己的 URL 实测才作数**，别照着别的清单删源。2026-11-11 用生产抓取层实测：我们 29 个源**全部存活且新鲜**（最旧的阮一峰 5 天前，其余 0~1 天）
- **外部清单只测「能不能抓到」，不测「有没有新内容」** → anyfeeder 常用源列表 261 个源里有 **19 个返回合法 RSS 但内容 3 个月以上没更新**（最久 1305 天 / 解放军报），另有 4 个「页面没标异常、实测却已失效」→ 页面自带的健康标记也不权威。我们自己的 `fetch-rss.mjs` 有 `maxAgeDays` 过期闸门，**这一层比外部清单强**；新增源时别把它降级成「能抓到就算活」
- **APPSO 的 feed「失效」是假象（2026-11-12 纠正）** → 2026-11-11 记的是 `wechat2rss.bestblogs.dev/feed/4ae111e5b509609a5ee96c9894f1868fba` 连试 3 次 **HTTP 500**、换 `wechat2rss.xlab.app` 同 id **404** → 当成「两个镜像都没这个 feed 了」。**真因是配置里的地址被截断了 4 位**（`…1868fba` 少了一截），用户给的完整地址是 `…1868fbafd793e.xml` → **200 + 10 条 + 9 条带图**。**镜像源连续 500/404 时，先怀疑地址抄漏尾巴，再判死刑**
- **每个 RSS 源每天只贡献「公平配额」条数，不是它 feed 里的全部** → `fairCap = max(2, ceil(maxItems/源数))`，且**保底 1 条 + 之后按时间倒序补齐** → 条目比热门源旧的源会被挤到 1~2 条。2026-11-11 实测：`maxItems=177`（59 源 × 3）时求是网/侠客岛/新财富/财富中文网等**只拿到 1 条**；改成 `maxItems=232`（×4）后几乎每个源都拿到 4 条 → **maxItems 不是死公式，源变多时按「安静源能不能露脸」调**，不是按源数 × 3。**2026-11-12 实测（源数 59 → 67）**：`fairCap = max(2, ceil(232/67)) = 4` —— **还是 4，没变**；而且「每源保底 1 条」保证新源一定露脸，代价只是老源从平均 3.9 条降到 3.5 条，**没有源被整个挤掉**
- **见报原本是纯文字卡片，RSS 自带图片一个都没取** → 2026-11-11 实测全量探针（59 源 / 1658 条目）：`parseFeed()` 只取 title/link/ts/desc/categories，**不解析 enclosure / media:content / media:thumbnail / RSS1.0 `<image>` / description 内联 `<img>`**；manifest 的新闻条目字段也只有 `title/link/source/tag/tags/time/desc/needLogin`，前端 `renderHeadlines()` 纯文字。**2026-11-11 已加配图并上线**（见上面「见报的配图」一节）。同一批探针的其它结论：1658 条目里 **771 条（46.5%）带图，但只有 25/58 个源带图**；形态是内联 `<img>` 2523 · enclosure 214 · media:* 54；原图体积中位数 59 KB / 平均 302 KB（每日环球视野单张 2.1 MB）

---

- **实验版被用户的「发布」一起推上线，根路径还倒退了** → 2026-11-11 08:15 用户在审稿台点了「通过审核并发布」（exit=0），而我 08:16 正在用新配置重建 `published/2026-11-09/`。`publish.ps1` 部署的是**整个 `published/` 目录**，于是**我的 8 分类试验版被一起传上线**，线上 11-09 变成 8 分类、**根路径从 11-11 倒回 11-09**。根因：`published/` 同时是「部署面」和「我的工作区」。正解：**实验在 `published/` 之外做**；审稿台开着的时候不要重建 `published/` 里的任何一期
- **线上能取回任何一期的历史 manifest** → 每次部署都有独立快照域名：`https://<部署ID>.your-project.pages.dev/<日期>/<manifest名>`。**快照长期可访问、而且图片能正常取（R2 绑定是共用的）** → 它可以直接当「预览地址」用：想看某个未上线版本的真实效果，把那一版的部署快照链接给用户就行，不用碰生产域。还原流程：① 从快照下载那期的 manifest（内容字节）→ ② `node tools\build.mjs --date <日期> --no-convert --keep-manifest` 用**同一份 manifest** 重建 → ③ `publish.ps1 -SkipBuild -SkipUpload` 部署 → ④ 核对。2026-11-11 实测有效，取回的两份 manifest 与本地还原产物 **SHA256 字节级一致**
- **manifest 文件名里的 hash 长度不固定** → 形如 `manifest.1cjfi.js`（5 位）、`manifest.1rwg2l4.js`（7 位）、`manifest.119w930.js`（7 位）。写正则核对线上引用时用 `manifest\.[0-9a-z]+\.js` —— 写死 `{7}` 或 `{8}` 会**漏掉一部分**（我两次都栽在这：`{8}` 匹配不到 7 位的，`{7}` 匹配不到 5 位的），**空结果先怀疑正则，再怀疑线上**
- **RSS 的图不能直接外链** → 三个理由各自致命：① **防盗链**（博海拾贝不带 Referer 直接 403）② **混合内容**（每日环球视野 100 条里 99 条是 `http://`，https 页面里会被浏览器直接拦掉）③ **源站随时改 URL**，外链会一夜之间全裂。正确做法是抓到自己这边再给页面用
- **挑图要看「下载后的实际尺寸和体积」，不能靠 URL 猜** → 摘要里内联的 `<img>` 混着**广告图、表情、1×1 像素、站点 logo、公众号二维码**；而「logo」「avatar」「spacer」这些词在**正常文章图 URL 里也经常出现** → 靠名字猜必然出错。判据（`tools/rss-images.json` 可调）：宽 <120 或高 <80 = 图标/像素点；宽高比 >4 或 <0.25 = 广告条；高 >900 = 长截图拼图；原图 >1.5 MB 直接不取
- **摘要里的 `<img>` 有两种写法** → CDATA 包着真 HTML（`<img ...>` 原样出现在 XML 里）vs **实体转义**（`&lt;img ...&gt;`）。只扫一种 → 转义的那种源**一张图都取不到**。`extractImages()` 要同时扫原始块和解实体后的摘要/正文
- **加新字段时，「逐字段重建对象」的地方必须每一处都补** → `build.mjs` 和 `fetchHeadlines()` 都是显式列出字段重建对象的，**没列的字段一律不跟着走**。漏一处的症状极其安静：构建日志写「配图：尝试 0 个候选」，一条图都没有，像是功能没生效
- **同一张图被两个条目引用时，临时文件名会撞车** → 两条并发任务写同一个临时文件，一个转完把它删了，另一个 ffmpeg 正在读 → 直接失败（护栏测试里真撞到过：两条都指同一张图，结果只选中一条）。临时文件名必须带**序号**；转码产物也要先写带序号的临时文件再挪到最终名
- **Node 内置 fetch 会在读 body 中途被重置时崩掉整个构建** → undici 内部 `Parser.finish` 抛 `assert(!this.paused)`（`ERR_ASSERTION`），而且是抛在 **socket 的事件回调里** —— 不在 promise 链上 → 外层 try/catch 接不住，直接变成 uncaughtException 把整个进程带走。59 个源里只要有一个在读 body 时断线，**整期构建全废**。`tools/fetch-rss.mjs` 里放了一个**只放行这一种错误**的 uncaughtException 兜底，其它异常照旧抛出
- **`build.mjs --out <dir>` 把产物写到 `published/` 之外** → **做试验必须用它**（硬约束第 8 条的落地）。2026-11-11 实测：带图构建输出到 `.exp/out`，真工程 `published/` 的四个文件**时间戳一字未动**
- **`dev-server.mjs` 的第三个参数是图片来源** → `node tools\dev-server.mjs <端口> <产物目录> r2`：页面伺服指定目录，`/img/*` 仍从本地 R2 母本取。不给第三个参数时按老行为：给了目录就是自包含（`BASE/img`），没给就是 R2。`--out` 出来的产物里只有页面没有图，预览时**必须**用 `r2` 这一档
- **长驻预览的「伺服哪个目录」不能靠环境变量传** → `start-preview.cmd` 是**经 `explorer.exe` 启动**的，而 explorer.exe 早就在跑 → 它传的是**自己的**环境，不是调用方的 → 我在 shell 里设 `PREVIEW_BASE=…` 根本传不到子进程。**explorer.exe 这条路只认路径、不认参数、更不认环境变量**。正解：**按磁盘上的实际状态判断**（`.exp\out` 有 `index.html` 就伺服它，没有就伺服 `published\`）。2026-11-11 就是「清掉试验产物 → 顺手把预览也停了 → 用户发现 8790 访问不了」；改成自动回退后，试验产物清不清理都不影响预览
- **收尾时不要顺手把用户还在用的服务停掉** → 清理「试验产物」和「长驻服务」是两件事。`.exp/out` 是可删的产物，预览进程是**用户的工作界面**。停之前先问一句「这个服务还有人在用吗」
- **还原后必须做字节级核对，不能只看「200」** → 判据 = 线上 manifest 与本地还原产物的 **SHA256 相同** + `verify-news.mjs` 两期都 49/0 + 根路径的 `index.html` 里 `<script src="/<日期>/manifest.*.js">` 指向预期那一期。2026-11-11 还原用的是这三项
- **配图的落盘目录多排一层 → 全线 404，而且不报错** → 一开始把配图放在 `r2/rss/<日期>/`，比照片多一层。`upload-r2.mjs` 把 `R2_ROOT` 的每个子目录都当**日期**，`rss` 也算一个 → R2 key 变成 `rss/<日期>/<文件>`，而代理的正则要求 `^日期/分类/文件$` → **每一张配图都 404**，但页面照样渲染、构建日志全程报「成功」。正解：**跟照片同构**，放 `r2/<日期>/rss/<文件>`，key = `<日期>/rss/<文件>`，代理正则不用改、`upload-r2` 的递归 walk 自动带上
- **`/archive/` 的日期索引把最新一期剔掉 → 在「全部日期」里根本点不到今天** → `buildIndexHtml()` 原来用 `dates.slice(1)`（理由是「根路径就是它」），于是往期列表第一条是**昨天**那一期。点进去看到的是昨天（乃至前天）的见报 → 「进入11月11日的内容，却看到11月9日的内容」。**不是内容错了，是今天那期没出现在列表里，人只能去点昨天那期**。2026-11-11 改成列表包含全部日期（上面那张「最新一期」大卡片保留），护栏在 `test-build-taxonomy.mjs` 场景 3（变异测试：改回 `slice(1)` → 3 条断言变红）
- **`/archive/` 的日期条目漏了 `class="row"` → 一排裸蓝色下划线链接** → 这个页面的卡片样式（背景 / 圆角 / 右边的 › 箭头 / 日期的等宽数字）全挂在 `a.row` 上，而日期列表的 `<a>` 写的是 `<a href="../…">`（留言板那条 `<a class="row">` 反而是对的）→ **CSS 写了但从没生效**，远看像没做完的半成品。2026-11-11 补上 class，并把断言写进 `test-build-taxonomy.mjs` 场景 3（变异：去掉 class → 1 条红）
- **见报各分类的**时效**差得非常远，不能只看「这一期是今天的」** → 2026-11-11 实测线上 11-11 那期（6 分类版）：热议 101 条里 89 条是 11-11，但 **AI 9 条里只有 3 条、效率工具 12 条里只有 1 条、深度阅读 14 条里只有 3 条**是 11-11，其余是 11-10 及更早（阮一峰 11-06、10-30）。原因不在构建，在**源本身**：阮一峰一周两更、求是网/每日环球视野一天几十条但只在早上更新。**同一个分类里的条目年龄能差一周** —— 看到旧条目先怀疑源，别怀疑构建
- **「线上不是最新」的头号原因：头条 JSON 是快照，构建期只读不重抓** → 见报有**两条**内容来源：RSS（`fetch-rss.mjs` 每次构建**实时重抓** → 时间戳新鲜）vs **头条**（`daily_headlines.py` 落的 `headlines_<日期>.json`，构建期**只读不重抓** → 时间戳 = 那次抓取的时刻）。2026-11-11 实测：早上 07:35 抓的那份 JSON，**当天三次构建（08:11 / 09:58 / 12:10）全都用的是它**，于是**139~142 条**（微博热搜 50~52 + V2EX 热榜 30 + 驱动之家 29~30 + 虎扑步行街 30）全部盖着 `07:35`，而这些**全部落在默认第一档「热议」** → 用户打开见报第一眼就是一屏旧时间戳 → 「访问不是最新」。**排查顺序**：① 线上 manifest 与本地是否字节级一致（一致 = 部署没问题）② 抓 manifest 里的条目时间分布（`按 来源@时间` 统计）③ 若某一批源的时间完全相同 = 快照没刷新 → `python tools\grab\daily_headlines.py` 重抓后重建。**症状隐蔽**：构建日志一路「成功」、线上与本地 SHA256 一致、页面 200 全对 —— **部署是对的，是内容本身就是旧的**
- **头条过期要「喊出来」，不能静默发出去** → 2026-11-11 加：`tools/headlines.mjs` 的 `loadHeadlines()` 读**当天**那份时，超过 `STALE_HEADLINES_MS`（2 小时）就打醒目告警（旧了多久 + 哪些源 + 刷新命令）。**重建往期时用的是别的日期那份 → 不告警**（往期本来就是旧内容）。护栏 `tools/test-headlines.mjs` **30/0**（变异：阈值放大 → 4 条红；另有配图链路的断言，变异：JS 映射不过滤 + Python 去掉 URL 粗筛 → 4 条红）
- **macOS：反斜杠是合法文件名字符，不是分隔符** → `tools\review.mjs` 在 macOS 上会被当成**一个文件名** → 报「找不到文件」，而且**报错信息完全不指向真正的原因**。凡是拼路径的地方一律用 `Join-Path`（Windows 也认正斜杠）。护栏 `test-night-flow.mjs` 第 7 组 + `test-portability.mjs` 都盯着这条
- **macOS：Unix 认不出 Windows 的时区 ID** → `'China Standard Time'` 在 Unix 上抛 `TimeZoneNotFoundException` → 期号算不出来（差一天）→ 整个「夜里发 / 早上审」的循环错位。**这条最危险，因为它在 Windows 上永远是对的** —— 只能靠 `common.ps1` 里两个 ID 都试 + 护栏盯着
- **macOS：PowerShell 7.4 起原生命令退出码非 0 会变成终止性错误** → 本工程到处是「跑一下看退出码，不行就跳过」的 PS 5.1 老语义 → 在 macOS 上会大面积炸。`common.ps1` 里把 `$PSNativeCommandUseErrorActionPreference` 压回 `$false`
- **macOS：息屏 ≠ 睡眠** → 用户问「自动息屏还能不能跑」时要说清：macOS 息屏只关显示器，**后台任务照跑**；真正打断它的是**系统睡眠**（`sudo pmset -c sleep 0`）。另外 **LaunchAgent 属于用户会话 → 注销后就不跑**（锁屏无妨）
- **⚠️ 审稿台的期号在「进程启动时」就定死了** —— `review.mjs:69` 是 `const DATE = argv.find(...) || beijingToday()`，**只在启动那一刻算一次**。所以**跨天不重启，它还在服务昨天那一期**：
  - 2026-11-16 00:32 就踩到了：那个审稿台是 11-15 10:15 起的 → 页面显示 **2026-11-15** → 早上去审会**审错期**；
  - 更糟的是**误发布的代价**：根路径 = 最后构建的那一期 → 误发 11-15 会让**根页面倒退到 11-15**。
  - **每天早上第一件事：确认审稿台页面的期号是不是今天**（页面上有「审稿台 · <日期>」）。不对就重启：
    ```powershell
    # 先停旧的（它占着 8789，不停的话新台子会顺延到 8790 → 用户点错台子）
    # 再起新的：start-review.mjs 优先读 .publish-date（daily.ps1 写的，就是当期）
    node tools\start-review.mjs
    ```
- **审稿台的「通过审核并发布」不查幂等标记** —— `.night-publish-<日期>.done` 只管**夜间**和**桌面「上传图片」**两个入口；审稿台的发布按钮直接调 `publish.ps1` → **早晨重发照常能发**，不会被夜里那个标记挡住
- **护栏匹配源码前必须先剥注释 —— 注释就是毒药** —— 2026-11-17 实测：这个工程的源码注释里就写着 "og:image"、"RSS"、"绝对 URL"、"flags=fast"、"filter: blur()" 这些**关键词**。护栏若全文匹配，会把**自己的说明书当成合规证据** → 代码改坏了照样全绿 → **假护栏**。正解：`tools/strip-comments.mjs`（JS 是**状态机**，不能简单按 `//` 切 —— 那样会把字符串里的 `https://example.com` 吃掉）。剥注释只用于**匹配**，统计行数/字节数仍用原文件
- **ffmpeg 9.0.2 的 `flags=fast` 是非法值** —— `scale=24:-2:flags=fast` 会让**整批 182 张 LQIP 全废**，而且**不报像的错**；合法值是 **`flags=fast_bilinear`**。另外 ffmpeg 的 `color` 源尺寸写的是 **`s=WxH`**（不是 `s=400:630`），`hstack=inputs=1` 也非法（单图必须绕开 hstack）
- **「全站不许有 blur」这类规则必须区分 `filter:` 和 `backdrop-filter:`** —— `site/app.css` 里本来就有合法的 `backdrop-filter: blur(12px)`（顶栏/浮层）；朴素的 `filter: blur(` 子串匹配会误红。LQIP 之所以**不用** `filter: blur()`：182 个模糊图层在手机上会掉帧，24px 放大到 400px 时浏览器插值已经足够模糊
- **静态匹配挡不住「把 throw 改成 return」和「把站点根写死」** —— 前者源码里还有别的 throw，后者源码看着完全正常。正解是**真的 import 那个模块调一次**（用一个不存在的 ffmpeg 路径注入失败 / 换个域名看输出跟不跟着变），静态断言只能证明「有这段文字」，证明不了「这段文字在起作用」

---

## 见报的配图（2026-11-11 加，同日上线）

真相源 `tools/rss-images.json`。`enabled=false` 时跟没有这个功能一模一样 —— manifest 不带 `img` 字段、前端不渲染任何 `<img>`、老 manifest 天然兼容。
**2026-11-11 起默认开**（`enabled: true`），上线时跟着正常发布走；试验时用 `build.mjs --no-rss-images` 临时关。

| | |
|---|---|
| 开关 | 配置里的 `enabled`，或命令行 `--rss-images` / `--no-rss-images`（命令行优先） |
| 数据契约 | manifest 的新闻条目多一个**可选**字段 `img`（站内路径 `/img/<日期>/rss/<10位hex>_001_t.webp`）。没这个字段 = 这条没图 |
| 抓取 | `tools/fetch-rss.mjs` 的 `extractImages()` 按优先级收候选：enclosure > media:thumbnail > media:content > RSS1.0 `<image>` > 摘要内联 `<img>` |
| 下载转码 | `tools/rss-images.mjs`：带 Referer 下载（防盗链）→ ffmpeg 缩到 400px webp → 转完再验尺寸 → 落 `r2/<日期>/rss/` |
| 挑图判据 | **看下载后的实际尺寸和体积，不靠 URL 猜**（见上面那几条坑） |
| 白名单 | 目前 **42 个源**（40 个 RSS 源 + 2 个头条源）。其中 **9 个是公众号镜像源**（APPSO / 机器之心 / 新智元 / 硅星人Pro / AI前线 / Datawhale / 晚点LatePost / 集智俱乐部 / PaperWeekly）—— 它们的图**不用另抓**，镜像站 feed 里本来就有 `img-proxy` 代理地址（见「公众号镜像源自带配图」一节）。部署面实测 **151 条带图 = 148 个文件 / 2177 KB**（151 条引用 148 个文件：同图被多条共用 2 处，`187a6ac950`×3、`0d975cf75d`×2；**磁盘 0 缺失 0 孤儿**）；2026-11-11 中午扩容前是 10 源 → **34 张 / 375 KB** |
| 前端 | `site/app.js` 的 `renderHeadlines()` 出图，复用**已有的** IntersectionObserver + 并发队列（`data-tab="news"`），没另起一套 |

### 落盘布局：必须跟照片那套**同构**

```
<IMAGE_ROOT>/r2/<日期>/rss/<10位hex>_001_t.webp      ← 配图（母本）
R2 key: <日期>/rss/<10位hex>_001_t.webp
页面 URL: /img/<日期>/rss/<10位hex>_001_t.webp
```

跟照片（`<日期>/<分类>/<10位hex>_<序号>[_t].webp`）**一模一样的形状**，于是三处**一行都不用改**就认：

- `functions/img/[[path]].js` 的路径正则 `^(\d{4}-\d{2}-\d{2})\/([a-z0-9]+)\/([0-9a-f]{10}_[0-9]{3}(_t)?\.webp)$` —— `"rss"` 正好符合 `[a-z0-9]+`
- `tools/upload-r2.mjs` 的 `walk` 会递归进 `rss/`，`PRODUCT_RE` 按**文件名**过滤 → key = `<日期>/rss/<文件>`
- `tools/stage-static-images.mjs` 的静态兜底也照抄同一层结构

随机段用**跟照片同一份 `.img-salt`** 算：`sha256(salt|rss|<图片URL>)[:10]`。不用同一份盐 = 同一个站点两套随机段，等于把一半的口子留着。

### 配图数量的天花板不在白名单，在 `fairCap`

配图**不是**独立的配额：它挂在条目上，而条目数被 `fetch-rss.mjs` 的 `fairCap` 卡着（`max(2, ceil(maxItems/源数))`，`maxItems=232` / 67 源 → **每源最多 4 条**）→ **每源最多也就 4 张图**。

所以：**白名单扩到 42 个源之后，加源收益已经递减**（42 源 × 4 = 理论上限 168 张）。再往上要动的是 `maxItems`（那会同时多出文字条目），不是白名单。

### 头条源也能配图（2026-11-11 晚）

见报有**两条**内容来源，**配图能力原来不对等**：RSS（构建期实时重抓）能配图，**头条（`daily_headlines.py` 落的快照、构建期只读）一条图都没有** → 「热议」那一档（微博热搜 52 + 虎扑 30 + 抽屉 4）**全是纯文字**，而它是默认第一档。

**为什么原来一条都没有**：微博热搜走 API，`realtime` 条目里**压根没有任何图片字段**（`emoticon` 全空、`topic_flag` 是数字标记）→ 天生无图。但**虎扑步行街 / 驱动之家的条目页里是有真实内容图的**（虎扑帖子的配图、驱动之家文章里的插图），只是抓取器从来没抽过。

**改了三层**（`build.mjs` **一行没改** —— 配图那步本来就走合并后的全部 `newsItems`）：

1. **`tools/grab/headline_images.py`（新）** —— 逐条抓条目页、把 `<img>` 抠出来当**候选**。纯函数 + 独立抓取入口（`daily_headlines.py` 一 import 就有副作用：建日志、读 cookie、写盘，不好测）。**只管「找」不管「选」**。
2. **`tools/grab/daily_headlines.py`** —— 对 `驱动之家` / `虎扑步行街` 调它（`SOURCES` 第 4 个字段 `want_images`），候选写进 headlines JSON 的 `imgs`。**形状必须跟 RSS 那条路一致：`{url, kind}` 对象**。
3. **`tools/headlines.mjs`** —— 把 JSON 的 `imgs` 映射到条目上（过滤掉非 http 的，裸字符串归一成 `{url, kind}`）。另导出 `HEADLINE_SOURCES`，让配图白名单的对账**同时认 RSS 源和头条源**。
4. **`tools/rss-images.json`** —— 白名单加这两个源。

**实测**：驱动之家 **30/30** 条抓到候选、虎扑 **26/30**（60 个页面抓取只多花 ~10 秒）。配图命中 104 → **151 条**（部署面 148 个文件）；**热议 0 → 24/87 (28%)**、**科技数码 36% → 80%**。

**仍然无图的**：微博热搜 52 条（API 不给图）、V2EX 热榜（热榜页纯文字、帖子页里多是头像，产出极低，没做）、抽屉热榜（实测 0 候选）。

**坑**：候选的**形状**不一致会**静默失败** —— `rss-images.mjs` 直接读 `cand.url` / `cand.kind`，形状对不上就拿到 `undefined`，图一张都下不下来，而且**构建日志全程报「成功」**。所以 Python 侧产出、JS 侧映射，两边都必须认 `{url, kind}`。

**配图覆盖率按分类差别极大**（**2026-11-12 部署面** `manifest.1k4edem.js` 实测：**352 条里 171 条带图**）：深度阅读 21/25 (84%) · 科技数码 53/66 (80%) · 效率工具 9/13 (69%) · **AI 43/89 (48%)** · 财经商业 10/24 (42%) · 时政要闻 20/51 (39%) · **热议 25/84 (30%)** · 技术社区 5/50 (10%)。
（上一轮 11-11 是 369 条里 151 条带图，AI 30/83 (36%) → **AI 这次翻了倍**，因为 9 个公众号镜像源自带配图。）

**头条源出图**：驱动之家 **29/29** · 虎扑步行街 **25/30** · 微博热搜 **0/50** · V2EX 热榜 0/15 · 抽屉 0/4

**9 个公众号镜像源出图（2026-11-12）**：机器之心 4/4 · 硅星人Pro 4/4 · 集智俱乐部 4/4 · APPSO 3/4 · AI前线 3/3 · 新智元 2/2 · Datawhale 2/2 · 晚点LatePost 2/2 · PaperWeekly 2/2 → **合计 26/27 (96%)**

> ⚠️ **分类有两套口径，写数字前必须先声明用的是哪一套** —— ① **chip 口径（= 用户点分类 chip 实际看到的）**：筛选走 **`tags` 数组**（主标签 + 关键词命中的次标签），**一条可以同时属于多个分类** → 8 个分类加起来是 **437 > 369，这是正常的、不是错误**；上面的覆盖率用的就是这套。② **主标签口径**：每条只有一个 `tag`，加起来**正好 369**；同一个 **AI** 在主标签口径下只有 **15 条**（AIHOT精选 5 + 即刻·AI编程 5 + 量子位 5），在 chip 口径下是 **83 条** —— 差 68 条，全是别的主分类里又命中了 AI 关键词的。**判据**：要跟「分类条数之和」对账就用主标签口径，要说「点进去能看到多少带图」就用 chip 口径。**另外覆盖率一定要从部署面 manifest 重算** —— 旧构建的数字会过时（上一版文档那组 AI 28/80 是中午那次构建的）；构建日志打的「目录 8 个：…」是 chip 口径的**分类池**，跟最终 manifest 的 chip 口径**接近但不是同一份数字**。

### 公众号镜像源自带配图（2026-11-12）—— 不用抓原文页

走 `wechat2rss.bestblogs.dev` 的**公众号镜像 feed，条目里本来就带图**。实测 8 个 AI 源 **10/10 条目有候选图**（每个源 57~80 个候选），镜像站把公众号原图包成了代理形式：

```
https://wechat2rss.bestblogs.dev/img-proxy/?k=0dd9c3af&u=https%3A%2F%2Fmmbiz.qpic.cn%2Fsz_mmbiz_jpg%2F…
```

**为什么不抓 `mp.weixin.qq.com` 原文页**（那才是第一反应）：实测 3 组请求头（桌面 UA / 桌面 UA+Referer / 微信 iPhone UA+Referer）**全都只返回 18KB 的「环境异常 / 去验证」页面**，0 张图。走镜像的 `img-proxy` 反而两头都对：① 绕开反爬 ② 绕开 mmbiz 的防盗链（Referer 照惯例带 `https://mp.weixin.qq.com/`，但 img-proxy 不校验它）。

**实测出图率**：8 源各抽 4 条 = 32 条，**32/32 过筛**（尺寸 892×380 ~ 1280×1592，18~258KB，全 `image/jpeg`）→ 这 9 个源（APPSO + 8 个 AI 源）已进 `tools/rss-images.json` 白名单，**走的就是现成的配图流水线，一行代码没改**。

> **旧结论作废**：AGENTS.md 原来写「公众号镜像条目带图 0/10 → 要出图只能逐条抓原文页，是另一件事」—— **那条是错的**。当时探到的是镜像站**还没上 img-proxy 的旧版 feed**。**教训：探外部源的形态之前，隔一段时间要重探一次** —— 镜像站是会加功能的。

**「热议」不是天生无图，是**从来没抽过** —— 这条已经改完了（见上面「头条源也能配图」）：现在 24/87 有图（虎扑那 30 条里的 24 条）。剩下 52 条微博热搜**才是真的天生无图**（API 不给图片字段）。所以「默认第一档全是纯文字」这个问题**没有彻底消失，但已经缓解** —— 要彻底解决只剩两条路：① 换 chip 顺序（11-06 用户定的「打开见报直接看第一个分类（热议）」）② 给微博热搜换数据源（换的是源不是抓法）。**2026-11-11 都没做**。

**故意不在白名单里的源**：每日环球视野（100 条里 99 条是 `http://` + 单张 2.1 MB，出图率仅 17%）。

**2026-11-11 中午把白名单从 10 个源扩到 31 个**（用户拍板「尽量配图，暂时不增加新目录」——只放宽配图白名单，**不加任何新源、不动分类表**）。判据是**实测出图率**，不是拍脑袋：用真实流水线（下载→缩略→尺寸筛选）扫全部 59 个源、每源取前 12 条做样本 → 非白名单的 49 个源里有 20 个能稳定出图（样本 506 条 → 229 张）。收进来的条件是**样本 ≥10 且出图率 ≥60%**，小样本满产的也收（异次元 5/5）。

**「加了也白加」的 7 个源明确排除**（实测 0 出图，加进去只是白下载）：澎湃新闻 / 参考消息 / 侠客岛 / 长安街知事 / 华尔街见闻 / 新财富 / 雪球。

**博海拾贝收回黑名单**：之前判它「防盗链 403」是**不带 Referer 直连**的结果；我们的流水线本来就带 Referer，实测 9/10 出图。**判断防盗链必须用生产流水线去试，不能用裸 fetch 试。**

`tools/verify-build.mjs` 现在会**核对配图**：manifest 引用的每张 `img` 必须在 `r2/<日期>/rss/` 里真的存在（漏 → 线上裂图），且该目录里不能有 manifest 没引用的孤儿（`rss-images.mjs` 跑完会按本轮产出白名单清掉旧的）。

---

## 中文 RSS 源的服务端可抓性（2026-11-05 实测，Node fetch + 浏览器 UA）

**抓得到**：`sspai.com/feed` · `woshipm.com/feed` · `readhub.cn/rss`（是 `/rss` 不是 `/feed`）·
`w2solo.com/topics/feed` · `economist.com/latest/rss.xml` · `linux.do/latest.rss` ·
`rss.huxiu.com/` · `cn.nytimes.com/rss/` · `feeds-origin.appinn.com/appinns`（**必须用 feeds-origin**）·
`feedex.net/feed/feed.iplaysoft.com/` · `rss.nodeseek.com/` · `linuxdorss.longpink.com/top.xml` ·
`plink.anyfeeder.com/{idaily/today, zaobao/realtime/china, weixin/<账号名>}`（是 `/rss` 不是 `/feed`）·
`wechat2rss.bestblogs.dev/feed/<hash>.xml` / `wechat2rss.xlab.app/feed/<hash>.xml`（公众号镜像）

**抓不到**：`36kr.com/feed`（火山引擎 WAF）· `appsos.com/feed` · `iplayapp.com/*` · `linux.do` 直连 403 ·
`appinn.com/feed` 本机不可达 · `rss.shab.fun` / `xiaozhensoft.com` 本机网络层不可达

⚠️⚠️ **2026-11-25 更正：下面三个源被「网络层」拦死了，不是源坏了** —— 实测（Node 与 PowerShell 两种运行时一致）：

- `rss.dw.com`（德国之声中文）DNS 解析成 **0.0.0.0**（污染）→ **该源已删除**，位置由**法广中文**接替（RSSHub 无对应中文路由，`dw/news` 是英文源违反「只收中文」）。
- `cn.nytimes.com/rss/`（纽约时报中文）· `rss.mifaw.com/articles/…`（V2EX 热榜）· `www.rfi.fr/cn/rss`（法广中文）全部 **`ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE`**（TLS 握手被阻断）。
- **换域名解决不了**，必须走国内通道：纽约时报中文 → `rsshub.bestblogs.dev/nytimes/world`；法广中文 → `rsshub.bestblogs.dev/rfi/cn`；**V2EX 热榜 → 官方 `www.v2ex.com/feed/tab/hot.xml`**（官方比 RSS屋镜像更稳，实测多轮稳定）。
- ⚠️ **`rsshub.app` 公共实例已被风控（403）**，能用的是 `rsshub.bestblogs.dev`。
- ⚠️ 换源后**必须同步删 `tools/news-taxonomy.json` 里的 `sourceCategory` 映射** —— `test-news-taxonomy.mjs` 断言「源数量 == 映射数量」且「没有已下线的源」。

⚠️ `reuters.buzzing.cc` 名为「路透中文」，实为 Bluesky 上**路透英文源**的镜像：标题机器翻成中文、正文和 summary 是英文、链接跳 reut.rs 跳英文站（对本机 IP 回 401/超时）。**是否保留待用户拍板。**

**注意**：知乎日报 `rsshub.bestblogs.dev/zhihu/daily` 只有 **1 个可用镜像**（9 个 RSSHub 实例实测：rsshub.app 超时 47.4s、rssforever fetch failed、ktachibana.party 429、pseudoyu/19940731/bdbk 解析不了、luckly.workers.dev 超时）；它一天 4 条、发布时间都在 07:00 前后（比别的源晚 6 小时 → 按时间补齐时常常只拿到保底的 1 条）。`feeds.feedburner.com/nytcn` 不稳（3 次里 1 次要靠重试才过，24 秒）→ 纽约时报中文改用直连 `cn.nytimes.com/rss/`（⚠️ **2026-11-25 起直连也 TLS 握手失败了 → 已改成 `rsshub.bestblogs.dev/nytimes/world`**，见上面那条更正）。

**规则**：内容站**只收中文源**；英文源（经济学人 / Hacker News / MIT Tech Review）不要。
「Folo 里能刷到」≠ 本机能抓 —— 加源前先 `node tools\fetch-rss.mjs --probe <url>` 验一遍。
镜像服务（`feedx.net`）只支持白名单源；tidings 合集里混着中文名的**镜像**，按中文过滤挡不住 → **按名字 + 域名一起挡**。

---

## 本机事实（换机器就不适用）

- 工程根 `PROJECT_ROOT`；上一层仓库 `PARENT_DIR`
- `IMAGE_ROOT` = `~/image-root`（C 盘只剩 17 GB，D 盘 98 GB）；旧路径 `C:\Users\<user>\Downloads` 和工程内 `r2/` 仍被识别
- 桌面快捷方式 `C:\Users\<user>\Desktop\一键更新.lnk` → 工程根 `一键更新.cmd`
- 审稿台默认端口 8789（占用时顺延，实值写 `.review-port`）；本地预览 8788
- 线上 `https://example.com/`；`.env.local` 键名：`CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` / `PAGES_PROJECT` / `SITE_URL` / `IMAGE_ROOT`
- 本机出网是**新加坡机房 IP（AS30058）** → 知乎一律 403、微博跳访客系统、路透中文 401
- Cloudflare 资源：Pages 项目 `your-project`、R2 私有 bucket `your-bucket`；留言板 / likes 复用同一个 R2 binding `env.IMAGES`，**不建 D1 / KV / 不申请新 token**；API Token 没有 Cache Purge 权限
- `onnxruntime` 在这台机器原生崩溃（RapidOCR 不可用）；OCR 走 Windows 自带 WinRT（`pip install --no-deps winsdk`，`--no-deps` 必须带）
- tesseract 未装；YuNet 模型 232 KB 首次自动下载，之后离线可用
- **macOS 那台（Mac mini）**：自动息屏。**息屏不影响后台任务**（macOS 息屏只关显示器）；
  真正打断它的是**系统睡眠** → 要 `sudo pmset -c sleep 0`；还有 **LaunchAgent 属于用户会话 → 注销后就不跑**（锁屏无妨）。
  详细迁移步骤与验收清单见 `docs/macos-migration.md`。**那边的真机验证还没做**

---

## 已知未完成

- **11-08 / 11-09 两期都缺福利吧那批** —— 源站第 157 期一直没发（`2026157.html` 404），两期都只能拿到第 156 期、而那批以前抓过 → 台账全跳过 → **福利吧 0 张贡献**。11-09 已发布（193 张 = 见闻 24 / 见她 76 / 见笑 93），**没补**；要补得重抓 + 重建 + 重发，而重发要等 24 小时边缘缓存，多数情况下不划算 —— 等第 157 期上线后从下一期开始恢复正常
- ✅ **往期统一重分已完成**（2026-11-12）—— `build.mjs --retag` 已实现（护栏 `tools/test-retag.mjs` 39/0 + 5 组变异全被抓），10-25 ~ 11-11 共 **18 期**已重分并一起上线；旧的 11 个分类名（微博/知乎/科技/社区/效率/即刻/资讯/博客/数码/V2EX）**全部消失**，现在往期也是 8 分类版。
- ✅ **11-14 / 11-15 两期都已发出去**（2026-11-15 上午）—— 两次失败的真因**已定位并修好**：**① 一行 stderr 掀翻**（PS 5.1 把原生命令的 stderr 转成 ErrorRecord，而 `publish.ps1` 顶着 `$ErrorActionPreference='Stop'` → 终止性错误；触发句是 `fetch-rss.mjs:57` 的「! 抓取过程中连接被重置…该源按失败处理，继续」，它**只是提示**）**② Cloudflare token 只活 1 小时**（上传到一半 249 个文件 401 → Pages 根本没部署）。修法与护栏见 `CHANGELOG.md` 第三节。⚠️ **根路径 = 最后构建的那一期** → 一次发两天必须**先建旧的、最后建新的**
- ⚠️ **8 个临时文件要手动删**（2026-11-15 遗留）—— `PROJECT_ROOT\.exp\` 下：`publish-mutant.ps1` `publish-mutant2.ps1` `publish-mutant3.ps1` `publish-2026-11-14.log` `publish-2026-11-14b.log` `publish-2026-11-15.log` `repro-1115-build.log`，**外加工程根的 `.tmp-enc-test.txt`**。**本机回收站删除器不可用时，任何删除方式（含 `rm --`）都会被安全策略硬拦，且明确禁止改用永久删除/脚本/文件系统 API** → 只能手动删。同目录的 `preview.*` / `start-preview.*` 是预览服务自己的文件，**别删**
- ⚠️ **`build.mjs` 还是先删后建**（第 955 行 `fs.rm` → `mkdir`）—— 没改成原子替换。发布再被打断仍会留下「空目录 + `published/index.html` 指向不存在的 manifest」→ **没重建之前别 `wrangler pages deploy published`**
- ⚠️ **macOS 迁移只做了「代码 + 部署包 + 手册」，真机一步都没验**（2026-11-15 晚）—— 我碰不到那台 Mac mini。
  已做：跨平台改造（`tools/common.ps1` 收敛 5 处绑定 + 2 处行为差异）· `tools/macos/` 部署包（launchd plist + 3 个 .sh）·
  `docs/macos-migration.md` 迁移手册（依赖 / 步骤 / **A~F 六段验收清单** / 10 个坑 / 回滚）·
  跨平台护栏 `tools/test-portability.mjs` 41/0 + `test-night-flow.mjs` 第 7 组 11 条 + 6 处新变异体。
  **没做**：Mac mini 上的依赖安装、`wrangler login`、launchd 真实触发、RapidOCR 效果、onnxruntime 稳定性、
  与 Windows 的 manifest 字节级比对。**别在真机验收通过之前停掉 Windows 那台的定时任务**
- `tools\check-cats.mjs` / `r2-mock.mjs` / `diag-feed-links.mjs` / `cleanup-side-effects.mjs` 用途未在 README 覆盖
- 投稿口令 `SUBMIT_TOKEN` 本机拿不到（Cloudflare Pages 加密变量只写不读）
