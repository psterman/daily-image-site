# CHECKPOINT — 每日图片站（your-project）

> **用途**：会话被压缩 / 换会话 / 换人接手时，**先读这一个文件**就能接上。
> **同目录** `AGENTS.md` = 完整事实与坑清单（本文件只是它的压缩版）；改动流水账在 `PARENT_DIR\.superpowers\sdd\2026-11-05-news-taxonomy\progress.md`（Task 1~38）。
> ⚠️ **本文件、AGENTS.md、SDD 账本三个都不在 git 里**（根 `.gitignore:115` 忽略整个 `your-project/`；`.superpowers/sdd/.gitignore` 内容就是 `*`）→ **本地磁盘是唯一副本，别手删**。
> 最后更新：**2026-11-25 11:2x**（**夜间链路加固** —— 体检发现四个问题并全部修掉：① **告警链路是断的**（toast 只有手动起的任务台发，机器重启就没了 → 夜里失败零通知）→ 告警下沉到夜间脚本（`common.ps1` 新增 `Send-Alert`）+ 新增 `DailyImageSite-NightWatchdog-0130` 看门狗覆盖「被硬杀」那条静默路径 ② 计划任务 `ExecutionTimeLimit` **PT72H → PT2H**（一次卡死会连压 3 晚） ③ **抓图加总预算 1500s**（防关机硬杀） ④ **pHash 索引改增量缓存**（实测 116.7s → 1.9s） ⑤ **三个中文 RSS 源被网络层拦死 → 换掉**（V2EX 官方 feed / NYT中文+法广中文走 bestblogs 镜像 / 删 DW 中文由法广接替），并**同步删掉 taxonomy 里的映射** ⑥ 日志轮转。**护栏 46/0 + 变异 18/18**。⚠️ **测试遗留文件会变成明晚的雷**：端到端测试在工程根写了 **`.night-publish-<未来日期>.log` 和 `.done`** —— `.done` 一旦留在那儿，**看门狗会判定「夜间脚本自己告警过了」→ 明天真被硬杀时不再告警**。幂等只认 `"exit":0`，所以 `exit:1` 的残留**不会**让明晚的发布被跳过，但会**关掉看门狗**。→ 跑完端到端测试**必须清掉未来日期的 `.done` / `.log`**。）｜前一轮：**2026-11-16 17:0x**（**榜单三个 tab 的 v2 已落地生产代码** —— 多层分类 chip + 豆瓣封面本地化；用户 16:09 拍板「上线」；**代码 / 护栏 / 试验构建 / 浏览器验收全过，尚未发布**）｜前一轮：**早晨审稿后重发已发出** —— 170 张 / 见报 371 条 / 孤儿 322 个全清；**新加「听乐」「看片」两个榜单 tab**）｜前一轮：**夜间无人值守链路第一次真跑通** —— 00:10:01 起跑 → 00:21:40 结束，`=== NIGHT_DONE exit=0 ===`，部署 `074b1231`，线上与本地 manifest 字节级一致，archive 23 期）+ 前一轮：核实「今天发没发」→ 定位根因（**一行 stderr 掀翻** + **token 只活 1 小时**）→ 修好护栏 → **两天都发了** → **审稿台已重启** → **夜间自动发布 + 早晨重发 + R2 孤儿清理落地** → **桌面「上传图片」手动入口上线** → **修掉期号错位一天**（夜间跑改到**过了午夜 00:10**）→ **macOS 迁移准备完成**（跨平台改造 + launchd 部署包 + 迁移手册 + 可移植性护栏，**真机未验证**））。

---

## 一、一句话现状

线上已到 **11-16**，**/archive/ 23 期**。根因已定位**并修好**：发布被掀翻不是被 kill，是**构建的一行 stderr**（见第三节）；顺带还挖出**第二个坑：Cloudflare token 只活 1 小时，发布链路会跨过过期点**（见第三节之二）。

**夜间自动化已就位并且真跑通过**（2026-11-15 晚落地 → **2026-11-16 00:10 第一次无人值守真跑**）：**过了午夜（00:10）自动把当期发出去（未审稿直接上线，用户明确授权）** → 第二天早上起审稿台审完重发；同时做 **R2 孤儿清理**。另外加了**桌面「上传图片」双击入口**（手动上传，无时间闸门）。

✅ **首次真跑结果**：00:10:01 起跑 → **00:21:40 结束**（11 分 40 秒）· `=== NIGHT_DONE exit=0 ===` · 标记 `.night-publish-2026-11-16.done` 写出（`"exit":0`）· 部署 `https://074b1231.your-project.pages.dev` · **上传 543 个对象** · **清孤儿 1 个（删掉 1 失败 0）** · 线上与本地 manifest **SHA256 逐字节一致** · `verify-news` 根页与当天页都 **53/0** · archive 23 期 · Next Run **2026/11/17 00:10**。**夜间无人值守链路从此不再是「没验过」。**

⚠️ **本轮修掉了「期号错位一天」**：站点的期号 = 北京今天，而抓图落盘目录 = `bj_today`（下载当天）→ **期号由跑的那一刻是几号决定**。原来的 23:00 夜间跑算出来的是**当天早上已经发过**的那一期，而第二天早上审稿台（期号=北京今天）审的又是**还没发出去**的一期。**过了午夜跑，两边才对得上**（内容窗口也才完整）→ 计划任务改成 **00:10**。

ℹ️ **本次真跑的两个非致命现象**（都符合预期，不是 bug）：① **福利吧 116 张全被台账跳过** —— 日志提示「这一期 2026-11-14 已经抓过 —— 源站大概率还没发新一期」；福利吧只取最新一期，**源站不出新期 → 见笑数量会掉**（11-16 见笑 99 张 vs 11-15 的 197 张）② **知乎 401** —— cookie 过期的老问题，不影响发布。

**macOS 迁移已做完「准备」部分**（2026-11-15 晚）：做法是**装 PowerShell 7 跑同一份 `.ps1`**（不重写第二套 `.sh`），
把 5 处 Windows 绑定（时区 ID / 子进程 shell / 反斜杠路径 / python 探测 / 图像根目录）+ 2 处行为差异
（Job Object 脱身方式、PS 7.4 的原生命令退出码语义）全部收敛到**新增的 `tools/common.ps1`**。
配套：`tools/macos/` 部署包（launchd plist + 3 个 `.sh`）· `docs/macos-migration.md` 迁移手册（A~F 六段验收清单）·
新护栏 `tools/test-portability.mjs`（41/0）。
⚠️ **Mac mini 上的真机一步都没验**（我碰不到那台机器）→ **别在验收通过之前停掉 Windows 这台的定时任务**。

---

## 二、线上 / 本地状态（2026-11-15 19:0x 实测）

| 项 | 值 |
|---|---|
| 线上 | https://example.com/ |
| **线上当期** | **2026-11-16** · `manifest.ckann1.js`（195336 字节；**11-16 08:05 早晨审稿后重发**）· 部署快照 `https://3daa32f9.your-project.pages.dev/` · 照片 **170 张**（见闻36/见她52/见笑82）· 见报 **371 条（其中带图 177 条）** · 线上与本地 manifest **SHA256 逐字节一致**（`EC6A12B8…8542060`）· **清孤儿 322 个（失败 0）** · `verify-news` 根页与当天页都 **53/0** |
| **线上 11-14（补发）** | `manifest.2kxqkw.js`（216812 字节，SHA256 `6B3A83B6F6F6E1740F34D0B1C3272D22A5864E39B28069AFE3990B53D1A18F4C`，**与本地字节级一致**）· 快照 `https://1ca7f0f5.your-project.pages.dev/` · 照片 **305 张**（见闻25/见她140/见笑140）· 见报 232 RSS + 140 头条 / AI 96 / 配图 174 条 |
| **11-15 傍晚重发** | 19:25 手动跑「上传图片」：抓图（福利吧出了**第160期**，多 99 张）→ 清洗（331 张全留）→ 构建 344s → 上传 **839 个 / 28.94 MB / 83.6s** → 部署 `836a1b69` → **清孤儿 3 个（排在部署之后 ✓）** → ⚠️ **写标记那步炸了**（`$marker`/`$Marker` 撞名，见坑 33），**已修** |
| 线上 `/archive/` | **23 期**（2026-10-25 ~ 2026-11-16） |
| **11-14 / 11-15** | ✅ **都已上线**（2026-11-15 上午补发）。线上 `/2026-11-14/` 与 `/2026-11-15/` 都是真当期页（各引用自己的 manifest，与根页内容不同） |
| 本地 `published/` | **22 个日期目录带 manifest**（10-25 ~ 11-15）；`assets/` 只有 logo；根 `index.html` 指向 **11-15**（根路径 = 最后构建的那一期） |
| ✅ 本地部署面自洽 | 11-14 `manifest.2kxqkw.js` + 11-15 `manifest.glbf83.js` 都在，两期都过了产物自检与审稿闸门 |
| `.publish-date` | **2026-11-15** |
| 审稿凭证 | `.review-passed-2026-11-13`(08:45) · `-2026-11-14`(09:25) · `-2026-11-15`(08:59) —— **三份都在**，闸门会放行 |
| 素材（可重发） | `~/image-root\src\2026-11-14` 见闻25/见她140/见笑140 · `2026-11-15` 见闻21/见她54/见笑149；母本 `~/image-root\r2\2026-11-14`（280+50+280+173 文件）/ `r2\2026-11-15`（108+42+298+176 文件）**都在** |
| 长驻服务 | 审稿台 **8789 LISTEN pid=19576**（**11-16 00:32 重启到 11-16**：旧的 pid 26292 是 11-15 10:15 起的，**期号在启动时就定死 → 一直服务 11-15**，不重启就会审错期、误发还会让根路径倒退）；`IsProcessInJob=false` → 已脱离 Job Object；实测 `/thumb/` 200 · `/api/list` 184 条（与 manifest 一致）；预览 **8790 没跑**（`.exp/preview.pid` 最后写于 11-13 01:35）→ 需要时 `node .exp\start-preview.mjs` 重起 |
| **夜间自动化（新增）** | 计划任务 **`DailyImageSite-NightPublish-0010`**（**DAILY 00:10**，Status Ready，下次 **2026/11/16 00:10**，`StartWhenAvailable=True`）· 入口 `tools\night-publish.cmd` · 开机触发靠 **Startup 文件夹** `your-project-night.cmd`（ONSTART/ONLOGON **Access is denied**，本机非管理员）· 早晨 `tools\morning-review.ps1` 起审稿台 · ✅ **token 续期链路已实测走通**：把 `expiration_time` 临时置为过去 → 逼出一次**真实 OAuth 刷新** → 拿到新 token（1 小时）+ **轮换后的 refresh_token 已写回** → `.env.local` 同步 → 账号接口验证通过。**00:10 那次上传前续期不会掉链子** |
| **手动上传入口（新增）** | 桌面 **`上传图片.lnk`** → 工程根 `上传图片.cmd`（**纯 ASCII / LF / 无 BOM**，末尾有 `pause`）→ `tools\manual-publish.ps1`：**无时间闸门**（手动点就是有意的）、当天已发过会**先问一句**、日志 `.manual-publish-<日期>.log` + `=== MANUAL_DONE exit=N ===`、**幂等标记跟夜间共用同一个文件**（谁先发过另一边就不重复上传）。发的是**今天该发的那一期**（期号=北京今天，内容=昨天→今天） |
| 机器 | `LastBootUpTime = 2026-11-15 08:14:25`（今早 00:31 由 RuntimeBroker 关机，08:14 开机） |
| 源码改动 | **本轮改过**：`tools/publish.ps1`（helper + token 续期 **+ 榜刷新守卫 + 孤儿 capture/sweep 钩子 + `-NoHeadlines`**）· `tools/refresh-token.mjs` · `tools/review.mjs` · **新增** `tools/publish-state.mjs` / `test-publish-state.mjs` / `test-publish-natives.mjs` / **`orphan-clean.mjs`** / **`night-publish.ps1`** / **`morning-review.ps1`** / **`night-publish.cmd`** / **`test-orphan-clean.mjs`** / **`test-night-flow.mjs`** / **`test-night-flow-mutate.mjs`**；`site/` 前端**没动**；`tools/build.mjs` / `tools/fetch-rss.mjs` / `tools/grab/*` 也**没动** |
| **🎵 榜单三个 tab（11-16 加，**v2 已落地，⛔ 尚未发布**）** | **听乐**（music，**多榜 550 条**：中文榜 260 / 国际榜 220 / 场景榜 70）· **看片**（movie，猫眼 21 + 豆瓣 15 + **B站 50 + 抖音 50** = 136 条）· **追更**（follow，TVmaze 频道新更 + 豆瓣同城演出）。**v2 = 多层分类 chip**：条目契约 8 字段 → **9 字段**（加 `tags` 层级标签 `@1:`~`@4:`），**每层选项由前端从数据现推**（没有死 chip，换城市/平台不改前端）；**豆瓣封面必须自己存**（图床对不带 Referer 一律 418）→ 构建期转 WebP 存 R2 母本、**复用现有产物命名**（`upload-r2` / 代理 / `r2-prune` / `orphan-clean` 一个字节都不用改）。构建期抓、运行时零消耗，猫眼/B站/网易云/TVmaze 封面**热链**，豆瓣封面**自托管**。**护栏 149/0 + 变异 43/43 + fetch-rank 159/0 + 18/18 + fetch-follow 275/0 + 变异 40/40，既有套件全绿，试验构建 7 个 tab（追更 304 条 / 140 张本地化封面），浏览器验收通过** → **发布是不可逆动作，走审稿台「通过审核」→「发布」两步**。**2026-11-16 22:08 状态：✅ 已发布上线** —— 用户 22:02 在确认条上拍板「现在发布」→ 审稿台发布端点触发 `publish.ps1 -Date 2026-11-16`：**产物自检通过（manifest 340 个引用产物）→ 审稿闸门过（170 张）→ R2 上传 648 个对象 / 18.26 MB / 65.2s → Pages 部署完成 → 清孤儿 125 个（失败 0）→ `=== PUBLISH_DONE exit=0 ===`**。线上 manifest `manifest.1vaa20.js`，**7 个 tab**（见闻 36 / 见她 52 / 见笑 82 / 见报 371 / 听乐 550 / 看片 136 / 追更 304），追更 `@1`~`@4` 四层标签齐全、**140 张本地化封面抽检全 200 非空**，`verify-news` **63/0** |
| **★ 0 字节产物事故（11-16 晚，已修）** | 全量回归时 `test-webp` 报 **1/12030** → 查出一个**真实线上缺陷**：`r2\2026-11-14\jianshe\962bbae53f_091.webp` 是 **0 字节**，线上代理以 **`HTTP 200 / len=0`** 吐出来 → **11-14 归档页「见她」#91 点开大图是裂图**（缩略图正常，网格上看不出）。根因：**三处都只查「文件存不存在」**（`build.mjs --no-convert` 复用路径 / `verify-build.mjs` 自检 / `upload-r2.mjs` 上传）。**已修**：① 本地重转成 **130,654 B** 有效 WebP（同名，manifest 不变）② **已推 R2**（用户授权，1 个对象 128 KB，HTTP 200）—— ⚠️ **边缘缓存仍吐旧版**（24h max-age，OAuth token 无 zone/purge 权限）→ **要等缓存自然过期才对所有访客生效**。**已补三道闸门**（存在 **且** 有效：`webpSize` 读文件头）：`build.mjs` 坏了就回退真转码 · `verify-build.mjs` 坏了就 exit 1 · `upload-r2.mjs` 坏了就一张都不传。**护栏 43/0 + 变异 10/10**，`verify-build --date all` **23 期全过** |
| **★ 本轮收口（11-16 深夜）** | 全量回归 13 套件跑完，**唯一的红是「变异脚本锚点漂移」，不是产品代码坏了**：worker 把 `verify-build.mjs` 的 `if (isTextTab(tab)) continue;` 改成带本地化封面校验的块结构 `if (isTextTab(tab)) { … continue; }`，**护栏 `test-rank-tab.mjs` 已同步更新成新结构的断言**（`/if\s*\(\s*isTextTab\(\s*tab\s*\)\s*\)\s*\{/` + region 里必须含 `it.cover`/`r2Date`），**只有变异脚本的 `from` 锚点还指着旧结构** → 那条变异被判成「变异点没在原文件里找到（源文件变了？）」→ 43 处只抓到 42 处。**分诊判据（已写进 AGENTS.md）**：**先读护栏的断言** —— 护栏期望**新结构** = 锚点旧了（只改 `from`/`to`，**别去动护栏**）；护栏也期望旧结构 = 两者都旧了（护栏才是真缺口，要补断言）。修完 `test-rank-tab-mutate` **46 通过 / 0 失败（43/43 全抓）**。另补有效性变异 **M10**（文本型 tab 的本地化封面闸门退回「只查存不存在」→ 0 字节封面照样放行；**`covers/` 根本不在孤儿检查范围 → 这道闸门是唯一防线**）→ **11/11 全抓**，M10 红得正好是指定的那两条。线上 `verify-news` **54/0** · 预览 8809 确认是 v2 七 tab 版（追更 304 条 / `@1`~`@4` 四层标签齐全）· **13 套件全量回归重跑 `FAIL_LIST` 为空** |
| **★ 本地预览修好（22:15–22:30）** | 用户报「见闻 见她 见笑 和 logo 裂了」→ 查完发现**线上全绿**（7 tab / 170 张缩略图 170/200 / logo 200 / 冷加载零失败），裂的是**本地预览 8809**：它伺服的是 `tools\.tmp-v2-build\2026-11-16\`（**日期页那一层**）→ ① 日期页 logo 路径 `../assets/logo.webp` 解析到根、根下没有 `assets/` → logo 裂 ② 构建输出**没有 img/** → 三栏照片整片 404。正解：新增 **`tools/preview-server.mjs`**（伺服 `published/` = 线上部署面 + `/img/*` 映射到本地 R2 母本 `~/image-root\r2` + clean URL `/board/`→`board.html`），`preview-8809.cmd` 改用它（仍走 explorer.exe 脱 Job + 自拉起循环）。**现在预览 = 线上：7 tab / 480 张站内图全中 / logo、CSS、JS 全通**，另加护栏 **`tools/test-preview-server.mjs`（10/0）**，其中「目录穿越」三条用**金丝雀文件**判（`%2e%2e` 会被 URL 解析器提前归一化 → 状态码判据会假绿，判据必须是「有没有把根外文件的内容发出去」） | |

| **★ 看片 v3：五个大目录（11-16 23:00，⛔ 尚未发布）** | 用户要求：**B站热门 / 抖音热门提上来做大目录** · **追更的「频道更新」「本地演出」搬进看片** · **频道更新放第一个**。**追更 tab 取消**（两个分类全搬走 → tab 变空）→ **站点从 7 个 tab 变成 6 个**（见闻/见她/见笑/见报/听乐/看片）。**看片 = 频道更新 184 + 电影 36 + B站热门 50 + 抖音热门 50 + 本地演出 120 = 440 条**（原来 136 + 追更 304 分开两个 tab）。改动：`fetch-rank.mjs` 把 B站/抖音的 `tags` 从 `@1:视频`+`@2:X` 改成 `@1:X`（去掉「视频」壳）· `build.mjs` 改成**读数据 → 五段合并 → 组 tab** 三步（`watchList = [...followSchedule, ...movieList, ...videoList, ...followEvents]`）· `site/board.html` 的 `TAB_LABELS` 去掉 follow · `tools/verify-news.mjs` 去掉追更断言、多层 chip 循环改成 `['music','movie']`。⚠️ **发布链路不重跑抓取器** → 必须**迁当期源数据**：`rank_2026-11-16.json` 的 100 条 video 标签 + `follow_2026-11-16.json` 的 184 条 `@1:频道新更`→**`@1:频道更新`**（抓取端常量 `L1_SCHEDULE`、源数据、护栏三处一起改，用用户的字面）。**目录顺序 = 数据顺序**（前端 `renderChips()` 按数据出现顺序推 chip、不排序）→ 顺序写死在 `watchList` 那一行。**试验构建通过**：看片分段 `频道更新 184 + 电影 36 + B站热门 50 + 抖音热门 50 + 本地演出 120（共 440）` · 浏览器验收：**6 个 tab** / 板块行 **全部·频道更新·电影·B站热门·抖音热门·本地演出**（顺序与用词都对）· B站热门筛选后分类行正确收起 · 本地演出三层筛选（城市/区/类型）+ 自托管封面正常 · **控制台 0 错误**、唯一失败请求是 `/likes/api`（Pages Function，本地预览没有，正常）。**⛔ 发布是不可逆动作，等用户拍板** |

---

| **★ daily.ps1 第 4 步：把榜单 + 追更抓进日常流程（11-16 23:5x，⛔ 尚未随 v3 发布）** | 用户问「桌面上的更新需要改吗？已经更新了目录」→ 查出**桌面两个入口的共同汇聚点 `daily.ps1` 从来不抓榜单/追更**（以前只有 抓图→头条→清洗→构建 四步）→ 而这两块是**构建期静态数据**（`build.mjs` 只读 `src\<期号>\rank_<期号>.json` / `follow_<期号>.json`，**它自己不会去抓**）→ **23 期里 22 期源目录里根本没有这两份 JSON** → 构建静默跳过 → 线上只有 4 个 tab（实测过）。v3 把五段并进看片后，漏抓的后果从「tab 不存在」变成「看片只有 2~3 个目录」，**更难看出是漏抓**。**第 4 步**：位置 清洗之后→抓取→构建之前 · 命令 `node tools/fetch-rank.mjs` + `tools/fetch-follow.mjs` · **`--date $publishDate`（期号，不是内容日期）** · **失败只警告不中断**（图片才是主体；缺段由 `build.mjs` 的 `WATCH_SECTIONS` 点名） · 逃生口 **`-NoRank`**（`daily.ps1` + `daily-review.ps1` 都认，桌面那条链才够得着） · 原生命令照旧接 `| Out-Host`、**不许 `2>&1`**。**实跑验证（用 11-17 期号，不动已发布的 11-16 数据）**：rank exit 0（47.3s，听乐 550 / 电影 38 / 视频 100 = `@1:B站热门` 50 + `@1:抖音热门` 50，**无残留 `@1:视频`**）· follow exit 0（30.8s，频道更新 181 / 本地演出 120，豆瓣封面 **140 张就绪 0 失败**）· 形状核对全对（schedule = `@1:频道更新`+`@2:平台`+`@3:语言`；events = `@1:本地演出`+`@2:城市`+`@3:区`+`@4:类型`；封面是 `local:follow-covers/…`）→ **五段合计 439 条**。**新护栏 `test-daily-rank-step.mjs` 34/0 + `test-daily-rank-step-mutate.mjs` 17/0（15/15 全抓）**；`test-daily-review.mjs` 41→**43**（原来的原生命令扫描只认 `& node @(...)`，新写的 `& node $fetcher …` 从缝里漏过去 → 改成「按调用了哪个可执行文件认」，不看参数形态）。⚠️ **遗留缺口**：护栏是**静态源码断言**，不验证实跑；各段**实际条数**没断言 |
| **★ 三件套：OG 分享卡片 + RSS + 模糊占位（11-17 08:00–09:1x，⛔ 尚未发布）** | 用户从「Astro 能顺手加的能力」里挑了 **OG 卡片 + RSS + 模糊占位** 三项。**评估结论：OG > RSS > 全站搜索 > 投稿** —— 这个站的消费路径是**微信 / QQ 群里的链接**（`gate.ps1`「复制这个发群里」）→ **分享卡片是唯一预览**；实测当时 `og:image` 恒等于 640×640 的 logo、**没有** `twitter:image`；站内**一个 feed 都没有**（`/feed.xml` 落到 Pages 的 404 兜底页，返回 200 + `text/html` —— 那不是 feed，**判文件存不存在不能看状态码**）；每个文本 tab 已有搜索框 → 全站搜索真增量只有「跨 tab + 搜往期」，而 Pagefind 抓不到 JS 渲染内容（成本被低估）；投稿要引第三条内容来源 + 审核负担。**① OG 卡片**：`published/<日期>/og.jpg` **1200×630 三栏拼图**（见闻/见她/见笑 各取首图，**图里不写文字** —— 字体路径跨平台不可靠，文字放 og:title/desc）· **`og:image` 必须绝对 URL**（相对路径微信/X/知乎爬虫拉不到 → 白卡）· **URL 必须带日期**（微信按分享 URL 缓存卡片，根 URL 固定 → 卡片停在缓存那天；**要每期新卡就分享「当天页面」链接**）· **根页 og:title/desc 刻意不带日期**（带日期 → 缓存住的卡片永远停在第一天）· 放 **Pages 静态面**（不能放私有 R2，爬虫拿不到 Function 凭证）· 合成失败**退回 logo 不阻断** · og.jpg 必须写在 `fs.rm(published/<日期>)` **之后** · 模板加 `og:image:width/height` + `twitter:card=summary_large_image` + `twitter:image`。**② RSS**：`published/feed.xml`（根目录）· **每期一条 item**（不是每条内容一条 —— 3 万多条塞进去阅读器会卡）· item 的 link/guid **绝对 URL** · pubDate **UTC RFC822**（读者遍布全球）· 标题描述 **XML 转义**（不转义整份 feed 被阅读器判坏 XML 直接丢弃）· 每次构建扫 `published/<日期>/` 的 manifest 汇总**所有往期** · 模板**和往期页**都加 `<link rel="alternate" type="application/rss+xml" href="/feed.xml">`（往期页自带 head，**不走模板**，worker 报出来后补的）。**③ 模糊占位**：24px 小图 **base64 data URI 内联 manifest**（零额外请求、零额外 R2 对象；走 R2 要改上传/孤儿清理/代理放行三条管道）· **批量 12 张/次 ffmpeg**（一图一进程 182 次要 23.8s → 16 次 10.8s）· **不用 CSS `filter: blur()`**（182 个模糊图层手机掉帧；24px 放大到 400px 时浏览器插值已经够糊）· 只做三栏照片（182 张 / 76.2 KB），**不做见报 RSS 配图**（会到 ~150 KB）· 失败只降级不阻断。**新护栏 5 套**：`test-strip-comments.mjs` **23/0**（**三套新护栏的地基** —— 护栏匹配源码前一律先剥注释，否则**把自己的说明书当合规证据** → 假护栏；剥法必须是状态机，朴素按 `//` 切会把字符串里的 `https://` 吃掉）· `test-build-og.mjs` **27/0** + 变异 **10/10** · `test-build-feed.mjs` **52/0** + 变异 **11/11** · `test-build-lqip.mjs` **39/0** + 变异 **9/9**。**试验构建 exit 0**：og.jpg **1200×630 / 141KB** · feed.xml **PowerShell XML 解析器判合法** · manifest **182/182 条带 LQIP**（601 KB）· **浏览器验收**：首屏糊（LQIP 在）→ 真图加载后清晰（模糊层收起，`.cell.is-loaded::before` opacity 0）· og/twitter meta 全绝对 URL · 根页 og:title 不带日期。⚠️ **遗留缺口**：源图缺失走「从已转码产物重建」那条路径时**不产 LQIP、不产 og.jpg**（该期分享图退回 logo、首屏没有模糊占位）—— **优雅降级不是崩溃**，本轮**未改**（改它要动 build.mjs 的稳定分支，还要连带改 LQIP 护栏「lqipJobs.push 只出现一次」的结构断言）|

## 三、⚠️ 为什么「审核了却没发布」——根因已定位并修好（2026-11-15）

**真凶不是被 kill，是被一行 stderr 掀翻的。**

链路：审稿台「通过审核并发布」按钮 → `cmd /c start /b powershell -File .review-publish-<日期>-runner.ps1` → `tools/publish.ps1 -Date <日期>` → `& node tools/build.mjs …`

- PS 5.1 里**原生命令往 stderr 写一行字**就会被转成 ErrorRecord；而 `publish.ps1` 顶着 **`$ErrorActionPreference = 'Stop'`** → ErrorRecord 直接变**终止性错误** → 脚本当场死掉。
- 那行字是构建打的（`fetch-rss.mjs:57`）：**`! 抓取过程中连接被重置（undici 已知崩溃），该源按失败处理，继续`** —— 它**只是提示**（那个源按失败处理、其余照常），build 自己会接着跑完；**是 publish.ps1 被它掀翻了**。
- 现场完全吻合：日志停在「✓ 产物自检通过」（下一步就是见报抓取，正是这行字出现的地方）、**无退出码**、连 runner 无条件追加的 `=== PUBLISH_DONE exit=N ===` 都没写出来。
- 11-14 与 11-15 **两次都死在同一句** → 不是巧合，是这条链路每天都会遇到连接重置。
- 已排除的解释：机器没重启（事件日志 1074/12/41/6008）、审稿台没重启（pid 17696 仍是 08:24:38 起的那个）、`publish.ps1` 内没有 timeout/杀进程逻辑。
- **复现验证**：前台跑 `node tools\build.mjs --date 2026-11-15` → **exit 0、耗时 168.1s、产物完整**（224 张 / RSS 232 + 头条 121 / AI 94 / 配图 175 条），构建本身没问题。

**为什么界面一直转「发布中…」**：审稿台原来只靠「45 分钟兜底」判断发布死没死 → 界面转了 27 分钟你才来问。

**已修（3 处）**
1. `publish.ps1`：新增 `Invoke-NativeCmd` / `Invoke-NativeCmdCapture`（内部先把 ErrorActionPreference 降成 Continue，成败只看 `$LASTEXITCODE`），**全部 8 处原生命令改走 helper**（原来只有部署那处是对的，构建/自检/R2 探测/上传/建项目/`pages project list` 全漏了）。
2. 审稿台判活：新增「**日志 6 分钟没更新又没结束标记 = 进程已经不在了**」→ 立刻报失败，不再干等 45 分钟（纯函数 `tools/publish-state.mjs`，便于单测）。
3. 本地发布面：11-15 已重建修好（原来 `published/index.html` 指向一个已被删掉的 manifest）。

**护栏**：`tools/test-publish-natives.mjs` **32/0**（静态层 + 行为层：把 helper 抠出来真跑，验 stdout 进管道 / stderr 不掀翻脚本 / 退出码拿得到；变异：构建改回 `& node @buildArgs` → 3 条红 · helper 改回吞 stdout → 两层红 · 删掉上传前续期 → 3 条红）· `tools/test-publish-state.mjs` **26/0** · `test-contract` 23/0 · `test-daily-review` 39/0 · `test-review-keys` 30/0 全部复跑通过。

**仍未做**：`build.mjs` 的**先删后建**（第 955 行 `fs.rm` → `mkdir`）没改成原子替换 —— 以后发布再被打断，仍会留下「空目录 + 悬空引用」。

### 三之二、第二个坑：Cloudflare token 只活 1 小时，发布链路会跨过过期点

- **症状**：11-14 那次发布（修完 stderr 之后跑的）**R2 上传阶段 249 个文件 401 code 10000（Authentication error）**，另有一批「重试耗尽」→ `upload-r2.mjs` exit 1 → publish.ps1 throw「R2 上传失败」→ **Pages 根本没部署**。
- **真因**：Cloudflare 的 OAuth token **只活 1 小时**（`expires_in = 3600`）。发布开头续期时 token 还剩 **12 分钟**，判断「有效」就放行了；而「构建 + 产物自检 + R2 探测 + 审稿闸门 + 上传（782 个文件 / 3~8 分钟）+ 部署」整条链路**完全可能跨过过期点** → 上传到一半 token 过期。
- **修法（两处）**：
  1. `tools/refresh-token.mjs`：加 **最小有效期余量**（`MIN_TTL_MS = 15 分钟`）—— 剩余不足 15 分钟就当它该续了（`isExpired` 保留给 `--check` 用严格判断）。
  2. `tools/publish.ps1`：**上传前再续一次**（4.5 步），并且**把新 token 重新导进本进程的环境变量** —— 续期只改 `.env.local`，而子进程 `upload-r2.mjs` 继承的是**本进程**的环境变量，不重导就白续。
- **护栏**：`tools/test-publish-natives.mjs` 扩到 **32/0**（断言：有最小余量 ≥5 分钟、续期判断用 `needsRenewal`、`publish.ps1` 至少续期两次、`Import-EnvFile` 至少调用两次、且上传前那次续期紧跟着重新导入）；**变异验证**：把上传前那次续期删掉 → 3 条断言变红 exit 1。

### 三之三、发布记录（2026-11-15 上午，两次都 exit 0）

| 期 | manifest | 照片 | 见报 | R2 上传 | 部署快照 |
|---|---|---|---|---|---|
| 11-14 | `manifest.2kxqkw.js`（216812 字节） | 305 张（见闻25/见她140/见笑140） | 232 RSS + 140 头条 / AI 96 / 配图 174 条 | 782 个 / 31.77 MB / 79.3s | `https://1ca7f0f5.your-project.pages.dev/` |
| 11-15 | `manifest.glbf83.js`（197989 字节） | 224 张（见闻21/见她54/见笑149） | 232 RSS + 121 头条 / AI 90 / 配图 173 条 | 620 个 / 19.04 MB / 61.4s | `https://b663d719.your-project.pages.dev/` |

**线上核验全过**：根页 → 11-15 + `manifest.glbf83.js` · `/2026-11-14/` → `manifest.2kxqkw.js`（与根页内容不同，是真当期页）· `/archive/` **22 期** · 两份 manifest 与本地**字节级一致**（SHA256）· 抽 5 张/期（照片 + 见报配图）→ **200 + image/webp** · `verify-news` 线上 **53/0**（根页与 /2026-11-14/ 各跑一次）· `test-review-keys` 30/0。

**发布顺序的规矩**：**根路径 = 最后构建的那一期**（`build.mjs` 写根 `index.html` 时用的是本次构建的日期）→ 要一次发两天，必须**先建旧的、最后建新的**，否则根路径会停在旧的一期。

---

## 四、最近几轮做了什么

1. **配图白名单扩容**（11-11）：10 源 → 31 源。判据是**实测出图率**（样本 ≥10 且 ≥60%）。
2. **「线上不是最新」修复**（11-11）：真因是**头条快照**过期，不是部署问题。加了 **2 小时过期告警**。
3. **给热榜源配图**（11-11 晚）：头条源走通 RSS 那条配图流水线 → **热议 0% → 28%**。
4. **AI 分类扩容 + 公众号配图 + 往期重分**（11-12）：加 8 个 AI 专属源 + 关键词表 10→33 → AI chip 87→**89**；**公众号配图零代码**（镜像 feed 自带 `img-proxy`）；**18 期往期按新 taxonomy 重分**（10-25 ~ 11-11）。
5. **11-13 发布成功**（11-13 08:49）：522 个文件 / 18.02 MB 上传 R2 → Pages 部署 exit 0 → 线上当期变成 11-13。
6. **11-14 / 11-15 发布失败**（11-14 09:28 / 11-15 09:01）：真因见上文第三节（**一行 stderr 掀翻**，不是被 kill）→ **已修好并已补发上线**。
7. **审稿台已重启**（11-15 10:15，pid 17696 → **26292**）：旧进程跑的还是老 `review.mjs`，新判活逻辑没生效。重启后状态接口已用新话术：「✗ 发布进程已经不在了：日志 4485 秒没有更新，也没有结束标记（多半是被强杀或脚本被腰斩）」，且**日志文件 mtime 没被刷新**（`.review-publish-2026-11-15.log` 仍停在 09:01:05）→ 判死不会自锁。
8. **夜间自动发布 + 早晨重发 + R2 孤儿清理**（11-15 15:00~19:10）：用户提「晚上开机自动跑一遍不审稿 11 点自动发，第二天审稿再审稿线上的图片，同时更新见报的内容」→ 三问选定 **晚上发当期（未审稿直接上线）+ 早上审完重发 + 同步清孤儿** → **夜间脚本 / 早晨脚本 / 孤儿清理器 / 计划任务全部落地**（详见第一节与第七节第 11 项）。**token 续期链路已实测走通**。
9. **桌面「上传图片」手动入口 + 修期号错位**（11-15 19:00~19:30）：用户要「一个桌面执行文件，每天手动启动上传图片」→ 新增 `tools\manual-publish.ps1` + `上传图片.cmd` + 桌面 `.lnk`；**同时发现并修掉「期号错位一天」**（期号=北京今天 + 落盘目录=bj_today → 23:00 跑发的是当天早上已发过的那一期），夜间跑改到**过了午夜 00:10**。用户拍板：手动入口发**今天该发的那一期**，并**当场跑一次端到端验证**。
10. **macOS 迁移准备**（11-15 20:00~20:45）：用户问「能不能发给 Mac mini（自动息屏还能不能跑）」→ 评估后决定**不重写第二套 `.sh`，而是装 PowerShell 7 跑同一份 `.ps1`** → 拆掉 5 处 Windows 绑定 + 2 处行为差异，全部收敛到新增的 `tools/common.ps1`；新增 `tools/macos/` 部署包（launchd plist + 3 个 `.sh`）、`docs/macos-migration.md` 迁移手册（A~F 六段验收清单）、`tools/test-portability.mjs` 护栏（41/0）。**Windows 侧全程零行为变更**（全套 11 套护栏复跑全绿 + 线上 `verify-news` 53/0）。**Mac mini 真机未验证**。
11. **过目 Chrome 扩展的隐私政策页**（11-22）：为「过目 Lookon」上 Chrome 应用商店做合规准备 —— 新增 `site/privacy.html`（独立静态页，照 `board.html` 的写法，资源走绝对路径）+ `published/_redirects` 追加一行 `/privacy /site/privacy 200`。**已部署上线**（Pages 项目 `efqljinkeatzpobvuouj` = `my.onetone.app`）：`https://my.onetone.app/privacy` → **HTTP 200、零跳转**。权威正文在主仓 `docs/lookon-privacy.md`，网页呈现版另有一份在主仓 `website/lookon-privacy.html`。⚠️ **两个坑**：① **Pages 的 HTML handling 会把 `.html` 去掉并 308** —— `_redirects` 的目标**必须写不带扩展名的形式**（写 `/site/privacy.html` 会多一跳 308 → `/site/privacy`；写 `/site/privacy` 才是直连 200），`/portal` 那条老规则同理。② **`published/` 不在 git 里**（`.gitignore` 忽略整个 `published/`）→ 产物**只存在于本机磁盘**：清空/重建 `published/` 会把隐私页弄丢，**下次发布前先确认 `published/site/privacy.html` 和 `published/_redirects` 还在**。

---

## 五、这一版动过的文件（站点**不在 git 里**，靠这份清单）

**11-12 那轮（仍是当前代码状态）**

新增
- `tools/test-retag.mjs` —— **`--retag` 往期重分**护栏，39/0（含 5 组变异）
- `docs/ai-rss-sources-2026-11-12.md` —— AI 源调研报告（精选清单 / 热门标题 / 停更黑名单）

改
- `tools/build.mjs` —— **实现 `--retag`**：`parseArgs` 加参数、模块级抽出 `hash`/`resolvePublishedRoot`/`renderPage`/`readManifestPath`/`findLiveManifestName`、新增 `runRetag()` + `printRetagDiff()`、`main()` 开头分流、删掉两处失效的 `if (args.retag)` 死分支
- `tools/rss.config.json` —— **APPSO 地址改完整**（38 位 → 42 位 `…1868fbafd793e.xml`）；`_doc` 记「换过的地址」
- `tools/rss-images.json` —— **白名单 33 → 42 源**（加 APPSO + 8 个 AI 源）；新增 `_wechat_mirrors` 说明
- `tools/news-taxonomy.json` —— 8 个新源 `sourceCategory` → `ai`（专属源 4 → **12**）；AI 关键词表 10 → **33**（**去掉「英伟达」**）
- `AGENTS.md` —— 新增「AI 分类怎么充实的」「公众号镜像源自带配图」两节；**纠正两条错结论**（公众号带图 0/10、APPSO 已失效）；测试表加 `test-retag.mjs`；命令表加 `--retag`
- SDD `progress.md` —— Task 30 / Task 31

没动
- `tools/fetch-rss.mjs`（配图零代码改动）· `tools/news-taxonomy.mjs`（分类逻辑零改动）· `site/` 前端

**11-13 之后**
- `wrangler.toml`（11-13 08:48）—— 唯一被改过的工程文件；其余改动都是运行时产物（审稿台日志 / 凭证 / pid、`.publish-date`、`.fetch-ledger.json`、`.env.local`）。

**11-15 这一轮（修「审核了却没发布」）**

新增
- `tools/publish-state.mjs` —— 发布状态判定**纯函数**（`computePublishState` + `describeDeadState`）：有结束标记 / 日志多久没动 / 45 分钟兜底，三条判据
- `tools/test-publish-state.mjs` —— 护栏 **26/0**
- `tools/test-publish-natives.mjs` —— 护栏 **32/0**（静态层：publish.ps1 里没有裸的原生命令调用、8 处都走 helper、全局仍 Stop、流式 helper 不吞 stdout；行为层：把 helper 抠出来真跑）

改
- `tools/publish.ps1` —— **新增 `Invoke-NativeCmd` / `Invoke-NativeCmdCapture`**（内部先把 `$ErrorActionPreference` 降成 `Continue`，成败只看 `$LASTEXITCODE`），**8 处原生命令全部改走 helper**（token 续期 / 构建 / 产物自检 / R2 探测 / 上传 / 静态兜底 / 建项目 / `pages project list` / 部署）
- `tools/review.mjs` —— 状态接口改用 `computePublishState`；**日志 6 分钟没更新又没结束标记 → 立刻判死**并给出一句人话（只写内存、不写回日志文件，否则会把 mtime 刷新）；前端对「没有结束标记」单独措辞
- `AGENTS.md` / `CHANGELOG.md` —— 根因、修复、护栏全部落盘

**没动**：`tools/build.mjs`（**先删后建**那处仍待改成原子替换）· `tools/fetch-rss.mjs`（那行 warning 是**提示**，本身没问题）· `site/` 前端

**11-15 夜间自动化这一轮（夜里发当期 + 早晨审完重发 + R2 孤儿清理）**

新增
- `tools/orphan-clean.mjs` —— **R2 孤儿清理器**。纯函数可测：`extractObjectKeys` / `diffKeys` / `shouldUpload` / `isDeleteSuccess` / `sweepOrphans` / `findManifestFile` / `readManifestKeys`；CLI `--capture`（构建前抓旧键集）/ `--sweep`（上传后删差集）/ `--plan`（干跑）/ `--probe-delete`（验 REST 链路）
- `tools/night-publish.ps1` —— **夜间无人值守主脚本**：时间闸门（BJ ≥20:00）→ 幂等标记 → `daily-review.ps1 -SkipReview -NoBrowser`（准备）→ `publish.ps1 -SkipReview -NoConvert -NoHeadlines`（发布）→ 写标记 + `=== NIGHT_DONE exit=N ===`
- `tools/morning-review.ps1` —— **早晨起审稿台**（期号默认北京今天 → `start-review.mjs` → 开浏览器）
- `tools/night-publish.cmd` —— 计划任务入口（**纯 ASCII / LF / 无 BOM**，不能有 `pause`）
- `tools/test-orphan-clean.mjs` —— 护栏 **46/0**
- `tools/test-night-flow.mjs` —— 护栏 **22/0**（`stripComments` 剥注释再断言，避免反面示例误伤）
- `tools/test-night-flow-mutate.mjs` —— **变异验证 14/0**（10 处变异全被抓；变异体写在 `tools\.tmp-night-mut\`，跑完自清）

改
- `tools/publish.ps1` —— 新增 `[switch]$NoHeadlines` · `Find-Python` helper（真跑 `--version` 判活）· **1a 榜刷新**（**仅** `-Date == 北京今天`，失败只告警）· **1b 孤儿 capture**（构建前）· **4.5 孤儿 sweep**（**部署成功之后**，**「既构建又上传又部署」三条件齐了才跑**，失败只告警）—— ⚠️ sweep 原先排在上传之后，**部署失败就永久裂图**，本轮挪到部署之后
- `AGENTS.md` —— 新增「夜间自动发布 + 早晨重发」整节
- `CHANGELOG.md` —— 本文件
- SDD `progress.md` —— Task 36

**没动**：`tools/build.mjs`（先删后建仍待改）· `tools/grab/*`（`daily_headlines.py` **不需要**改 `--date`：榜刷新只对当期，而它的默认输出目录 `~/image-root\src\<北京今天>\headlines` 正好对得上）· `site/` 前端

**11-15 晚这一轮（桌面手动入口 + 修期号错位）**

新增
- `tools/manual-publish.ps1` —— **手动上传**（UTF-8 BOM / LF）：跟夜间同一套流程，差三件事 —— **没有时间闸门**、当天已发过会**先问一句**、日志另开一份（`.manual-publish-<日期>.log` + `=== MANUAL_DONE exit=N ===`）。**幂等标记跟夜间共用同一个文件**
- `上传图片.cmd`（工程根，**纯 ASCII / LF / 无 BOM**，末尾有 `pause`）—— 桌面双击入口
- 桌面 `上传图片.lnk` → 指向 `上传图片.cmd`，图标复用 `assets\shortcut.ico`

改
- `tools/night-publish.ps1` —— **时间闸门从「BJ ≥20:00」改成「BJ 00:00–05:59」**（过了午夜，期号才对得上第二天早上审的那一期）
- `tools/test-night-flow.mjs` —— 闸门断言改写 + **新增第 5 组「手动上传入口」断言**（34/0）
- `tools/test-night-flow-mutate.mjs` —— **新增 4 处变异**（闸门改回 20:00 / 手动入口加上夜间闸门 / 幂等标记不共用 / .cmd 混进中文），共 14 处变异全被抓（18/0）
- Startup `your-project-night.cmd` —— 注释改成「00:00–05:59 窗口」
- 计划任务 —— 删掉 `DailyImageSite-NightPublish-2300`，新建 **`DailyImageSite-NightPublish-0010`**（DAILY 00:10 + `StartWhenAvailable=True`）

**没动**：`tools/grab/daily_grab_all.py`（**`--out` 只能换输出根目录，换不了日期目录** —— 日期目录恒为 `OUT_BASE/<bj_today>/`，所以「晚上点、提前发明天那期」光靠参数做不到，得改脚本；本轮按用户决定**不做**）· `tools/build.mjs` · `site/` 前端

**11-15 晚这一轮（macOS 迁移准备）**

新增
- `tools/common.ps1` —— **跨平台公共 helper**（UTF-8 BOM / LF）。`Get-BjNow`（两个时区 ID 都试）/ `Get-BjDate` / `Get-ShellExe`（Windows→`powershell.exe`，其他→`pwsh`）/ `Get-ImageRoot` / `Get-SourceDateDir` / `Get-ToolPath` / `Invoke-PsScript`（只认退出码、不认 stderr）/ `Test-IsWindowsHost`；并把 `$PSNativeCommandUseErrorActionPreference` 压回 `$false`（PS 7.4 的新语义跟本工程的老语义冲突）
- `tools/macos/run-night-publish.sh` —— launchd 入口（找 `pwsh` → 跑**同一份** `night-publish.ps1`）
- `tools/macos/com.your-project.night-publish.plist` —— launchd 定时任务模板（`StartCalendarInterval` 00:10 + `RunAtLoad`）
- `tools/macos/install-launchd.sh` / `uninstall-launchd.sh` —— 装 / 卸
- `docs/macos-migration.md` —— **迁移手册**（依赖 / 步骤 / **A~F 六段验收清单** / 10 个 macOS 特有坑 / 回滚）
- `tools/test-portability.mjs` —— 护栏 **41/0**

改（跨平台改造，**Windows 行为零变更**）
- 10 个 `.ps1` 全部 dot-source `common.ps1`；期号改走 `Get-BjDate`/`Get-BjNow`；子进程改走 `Get-ShellExe`/`Invoke-PsScript`；路径改走 `Get-ToolPath`/`Get-SourceDateDir`；`board.ps1` / `gate.ps1` 的 `& powershell ...` 改成 helper（顺手修掉「子进程一行 stderr 掀翻调用方」的隐患）
- **`.ps1` 代码里不再有任何反斜杠路径**（含用户可见的提示语，如 `tools\publish.ps1` → `tools/publish.ps1`）
- `tools/publish.ps1` / `daily.ps1` 的 `Find-Python` 按平台分支（macOS 补 `/opt/homebrew/bin`、`/usr/local/bin`）
- `tools/refresh-token.mjs` —— wrangler 配置路径按平台分（Windows `AppData/Roaming/xdg.config/…`，macOS `~/.config/.wrangler/…`）
- `tools/setup-cloudflare.ps1` —— 同上（`Get-WranglerConfigPath`）
- `tools/build.mjs`（`findBin`：where→which、winget 限定 Windows、补 Homebrew/MacPorts 路径、可执行名去 `.exe`）· `tools/start-review.mjs`（非 Windows **不碰** `explorer.exe`）· `tools/review.mjs`（「点发布」spawn 非 Windows 走 `pwsh`）· `tools/test-webp.mjs` / `make-logo.mjs` / `test-rss-images.mjs`（`where`→`which`）
- `tools/grab/daily_grab_all.py` / `daily_headlines.py` —— 默认输出目录按平台（macOS → `~/image-root/src`；**原来写死的是别人机器上的 `/Users/test/Desktop/memes_daily`**）
- **`tools/paths.mjs`** —— **`IMAGE_ROOT` 默认值按平台分**（win32 → `~/image-root`，其他 → `os.homedir()/image-root`）；`LEGACY_SRC` 只在 Windows 生效、`srcSearchRoots()` 滤掉空串。⚠️ 这一处写死的后果是**静默**的：macOS 上审稿台一张图都不显示且不报错
  （2026-11-17 开源导出时改成了**所有平台统一落在家目录**、代码里不出现盘符字面量）
- **`tools/final-verify.mjs`** —— 工程根/图像根改走 `paths.mjs`（原来写死 `PROJECT_ROOT` → 拷到 macOS 上什么都验不出来）
- `tools/grab/clean_images.py` —— **OCR 引擎按平台选**：Windows → WinRT（行为不变）· macOS/Linux → **RapidOCR**（`rapidocr-onnxruntime`）；拿不到引擎就**降级不崩**（跳过 OCR 规则）。`--src-root` 默认值也按平台
- `tools/test-night-flow.mjs` —— **新增第 7 组「跨平台 helper」11 条**（39→**50/0**）
- `tools/test-night-flow-mutate.mjs` —— **新增 6 处跨平台变异**（共 34 处全被抓，35/0）+ 新增可移植性护栏基线
- `tools/test-daily-review.mjs` —— `.cmd` / `explorer.exe` / `powershell` 断言**按 `process.platform` 分支**；`spawnSync('powershell')` → `pwsh`；新增 `common.ps1` 的编码与语法断言（39→**41/0**）
- `AGENTS.md` —— 新增「macOS 迁移」整节 + 4 条 macOS 坑 · `CHANGELOG.md` —— 本文件 · SDD `progress.md` —— Task 38

**没动**：`site/` 前端 · `tools/fetch-rss.mjs` · `tools/news-taxonomy.*` · `tools/orphan-clean.mjs` · 线上产物（**没重新构建、没部署**）

**11-16 深夜这一轮（看片 v3 + daily.ps1 第 4 步）**

新增
- `tools/test-daily-rank-step.mjs` —— 护栏 **34/0**（daily.ps1 第 4 步的契约：抓取器都在 / 传期号不传内容日期 / 失败只警告不中断 / 位置 / `-NoRank` 逃生口 + 桌面链透传 / 抓取器的 `--date` 与落盘路径跟 build 对得上 / 编码与 PS 语法）。**断言一律看剥掉注释后的代码**
- `tools/test-daily-rank-step-mutate.mjs` —— **变异验证 17/0（15/15 处变异全被抓）**：漏一个抓取器 / 传成内容日期 / 警告后又 throw / 摘掉 `| Out-Host` / 加 `2>&1` / 删 `-NoRank` 声明 / 守卫写成 `if ($true)` / 删主标题 / **整块挪到构建之后** / 不透传 / 删 daily-review 的声明 / 说明里删掉「第 4 步」 / 抓取器把 `--date` 改名 / 落盘文件名改了。纪律：锚点自检（`from` 恰好命中 1 次）/ 干净地红（exit≠0 + 有统计行 + stderr 无调用栈）/ expectFail + expectGreen 双向声明

改
- `tools/daily.ps1` —— **新增第 4 步**（`fetch-rank.mjs` + `fetch-follow.mjs`，`--date $publishDate`；失败只 `Warn` 不 `throw`）+ `[switch]$NoRank` 逃生口 + 步骤编号 `0/4`→`0/5`（其余步骤本来就是 `N/5`）
- `tools/daily-review.ps1` —— **透传 `-NoRank`**（桌面「一键更新」那条链上才够得着逃生口）+ `.SYNOPSIS` / `.PARAMETER` / 阶段标题补「榜单/追更」
- `tools/test-daily-review.mjs` —— 「原生命令」扫描正则从 `/& (\$py|node) @/` 改成 **`/& (\$py|node) /`（按调用了哪个可执行文件认，不看参数形态）**；原来新写的 `& node $fetcher --date $publishDate` **完全落在旧正则外面**，它的 Out-Host / 无 `2>&1` 纪律没人盯。两条环境准备用的调用（`-c "import X"` / `-m pip install`）显式豁免并写清理由（41→**43/0**）
- `AGENTS.md` —— 新增「daily.ps1 第 4 步」整节 + **3 条新坑**（流程里没有抓取器 → 22/23 期只有 4 tab 且不报错 / 护栏正则只认某一种参数形态 → 新写法从缝里漏过去 / 断言「有个 X」时同文件两句相似就假绿）· `CHANGELOG.md` —— 本文件 · SDD `progress.md` —— Task 48

**没动**：`tools/build.mjs`（先删后建仍待改）· `site/` 前端 · `tools/fetch-rank.mjs` / `fetch-follow.mjs`（v3 那轮已改完，这轮没再动）· 线上产物（**没重新构建、没部署**）

**11-17 早这一轮（OG 卡片 + RSS + 模糊占位）**

新增
- `tools/build-og.mjs` —— 分享图合成：一次 ffmpeg `filter_complex` + `hstack` 拼三栏，**图里不写文字**（字体路径跨平台不可靠）；`ogImageUrl()` 出绝对 URL
- `tools/build-feed.mjs` —— RSS 2.0：每期一条 item、link/guid 绝对 URL、pubDate 走 UTC RFC822、XML 转义 + CDATA（`]]>` 拆段）
- `tools/build-lqip.mjs` —— 24px 模糊占位：**批量 12 张/次 ffmpeg**（`flags=fast_bilinear`），出 base64 data URI；全失败返空 Map 不抛
- `tools/strip-comments.mjs` —— 注释剥离器（JS 状态机 / HTML / CSS）—— **三套新护栏的地基**
- `tools/test-strip-comments.mjs` —— 护栏 **23/0**
- `tools/test-build-og.mjs` + `tools/test-build-og-mutate.mjs` —— 护栏 **27/0** + 变异 **10/10**
- `tools/test-build-feed.mjs` + `tools/test-build-feed-mutate.mjs` —— 护栏 **52/0** + 变异 **11/11**
- `tools/test-build-lqip.mjs` + `tools/test-build-lqip-mutate.mjs` —— 护栏 **39/0** + 变异 **9/9**

改
- `tools/build.mjs` —— ① import 三个新模块 ② 照片循环里收 LQIP 素材（`lqipJobs`）与分享图素材（`ogPhotos`，每栏第一张）③ 批量生成 LQIP 并把 data URI 写进 manifest 条目的 `lqip` ④ 合成 `published/<日期>/og.jpg`（失败退回 logo **不阻断**）⑤ 生成 `published/feed.xml`（扫**所有往期**的 manifest，每期一条 item）⑥ 根页与日期页都传 og 三件套（根页 title/desc **不带日期**）⑦ **往期页 `buildIndexHtml()` 自带的 head 里补 `<link rel="alternate">`**（它不走 `site/template.html`，漏了就没有订阅入口 —— worker 报出来后补的）
- `site/template.html` —— `og:image` 从写死 logo 改成 `{{OG_IMAGE}}` + `{{OG_IMAGE_W}}` + `{{OG_IMAGE_H}}`；新增 `og:image:width/height`、`twitter:card=summary_large_image`、`twitter:image`、`<link rel="alternate" type="application/rss+xml" href="/feed.xml">`
- `site/app.js` —— cell 创建时 `if (item.lqip) cell.style.setProperty('--lqip', 'url("' + item.lqip + '")')`
- `site/app.css` —— `.cell::before` 铺 `background-image: var(--lqip, none)` + `.cell.is-loaded::before { opacity: 0 }`（**刻意不用 `filter: blur()`** —— 182 个模糊图层手机掉帧）
- `tools/verify-build.mjs` —— 新增第 6 项自检：日期页 `og:image` 指向的文件**必须存在且非 0 字节**（og.jpg 不是 manifest 条目，上面那套自检查不到它）
- `tools/publish.ps1` —— 发布完成后多打一行 RSS 链接 + 一句提示（想让卡片显示当期的图，就发「当天页面」那条链接）
- `tools/build-feed.mjs` —— channel description 从「三栏」改成 6 tab；CLI `--issue` 的 pubDate 改成**期号当天**（原来取构建当时 → 同一个期号每次跑出来都不一样）
- `tools/preview-server.mjs` —— MIME 表补 `.xml`（原来 `/feed.xml` 落到 `application/octet-stream`，本地预览跟线上不一致）

**没动**：`tools/daily.ps1` / `daily-review.ps1`（这轮不用改流程）· `tools/fetch-rank.mjs` / `fetch-follow.mjs` · `functions/`（图片代理不动 —— LQIP 是 base64 内联，不走 R2）· 线上产物（**还没发布**）

**工程外的改动**
- 计划任务 `DailyImageSite-NightPublish-2300`（DAILY 23:00）
- Startup 文件夹 `C:\Users\<user>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\your-project-night.cmd`

---

## 六、验证命令（照抄即可）

```powershell
cd PROJECT_ROOT
node tools\test-retag.mjs ; node tools\test-news-taxonomy.mjs ; node tools\test-news-taxonomy-mutate.mjs
node tools\test-build-taxonomy.mjs ; node tools\test-rss-images.mjs ; node tools\test-contract.mjs ; node tools\test-keep-manifest.mjs
node tools\verify-build.mjs ; node tools\verify-news.mjs https://example.com/
```

**日常操作**

```powershell
node tools\build.mjs --date 2026-11-15 --no-convert --src ~/image-root\src\2026-11-15                # 构建到部署面
node tools\build.mjs --retag --date 2026-11-04                                                          # 往期重分（内容零改动）
node tools\build.mjs --retag --date 2026-11-04 --out PROJECT_ROOT\.exp\retag-test     # 重分试验
powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish.ps1 -Date 2026-11-15                     # 发布（需先过审 + 用户确认）
node .exp\start-preview.mjs                                                                              # 起预览
node tools\start-review.mjs 2026-11-15                                                                   # 起审稿台
```

**夜间自动化**

```powershell
node tools\test-orphan-clean.mjs ; node tools\test-night-flow.mjs ; node tools\test-night-flow-mutate.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File tools\night-publish.ps1        # 天亮后会被时间闸门挡住（exit 0）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\morning-review.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools\manual-publish.ps1       # 手动上传（= 桌面双击）
node tools\orphan-clean.mjs --date 2026-11-15 --probe-delete                         # 验 R2 删除链路
node tools\orphan-clean.mjs --date 2026-11-15 --plan                                 # 干跑：看会删哪些孤儿
schtasks /query /tn "DailyImageSite-NightPublish-0010" /fo LIST /v
```

**当前护栏基线**（11-15 20:45 复跑，全绿）：
`test-retag` 39/0 · `test-news-taxonomy` 40/0 · `test-news-taxonomy-mutate` 6/6 · `test-build-taxonomy` 30/0 · `test-rss-images` 36/0（白名单 42 源 / 全部 67 源）· `test-contract` 23/0 · `test-keep-manifest` 26/0 · `test-rss` 48/0 · `test-news-ui` 116/0 · `test-news-search-mutate` 9/9 · `test-news-dedupe` 12/0 · `test-headlines` 30/0 · `test-review-keys` 30/0 · `test-media-fallback` 15/0 · `test-likes` 67/0 · `test-likes-ui` 32/0 · `test-board` 42/0 · `test-board-ui` 45/0 · `test-functions` 35/0 · **`test-publish-state` 26/0** · **`test-publish-natives` 32/0** · **`test-orphan-clean` 46/0** · **`test-night-flow` 50/0** · **`test-night-flow-mutate` 38/0（37 处变异全被抓）** · **`test-daily-review` 41/0** · **`test-portability` 44/0** · `verify-build` ✓ · `verify-news` 53/0（AI 显示 89/352）

---

## 七、下一步入口

| # | 事项 | 说明 |
|---|---|---|
| 1 | ~~**发 11-15（今天）**~~ | ✅ **已完成**（2026-11-15 上午，`publish.ps1 -Date 2026-11-15 -NoConvert` exit 0） |
| 2 | ~~**补发 11-14**~~ | ✅ **已完成**（同一轮，`-SkipBuild` 复用已建好的产物，exit 0）。⚠️ 根路径 = 最后构建的那一期 → 顺序不能反 |
| 2b | **`build.mjs` 改成原子替换** | 现在还是先 `fs.rm` 再 `mkdir`（第 955 行）→ 以后发布再被打断，仍会留下「空目录 + 悬空引用」。改成「写临时目录 → 原子替换」，或失败时保留上一版 |
| 2c | **临时文件要手动删（清单已变）** | `PROJECT_ROOT\.exp\` 下：`publish-mutant.ps1` `publish-mutant2.ps1` `publish-mutant3.ps1` `publish-2026-11-14.log` `publish-2026-11-14b.log` `publish-2026-11-15.log` `repro-1115-build.log`；**外加工程根的 `.tmp-enc-test.txt`**（排查 `Set-Content -Encoding` 时留下的）；**本轮新增 `tools\.tmp-rank-build\`（整个目录，榜单试验构建产物）+ `%TEMP%\probe-*.mjs`（数据源探测脚本）**。**回收站删除器本轮仍不可调用 → 任何删除方式（含 `rm --`）都被安全策略硬拦，且明确禁止改用永久删除/脚本/文件系统 API** → 只能手动删（同目录的 `preview.*` / `start-preview.*` 是预览服务自己的文件，**别删**） |
| 3 | **预览 8790 没跑** | 需要时 `node .exp\start-preview.mjs`（经 explorer.exe 脱 Job Object） |
| 4 | **微博热搜 52 条无图** | 用户已决定**接受**，chip 顺序**不动**（11-06 定的） |
| 5 | **投稿口令 `SUBMIT_TOKEN`** | 用户已决定**保留** |
| 6 | **路透中文镜像** | 用户已决定**保留** |
| 7 | **知乎热榜 401** | cookie 过期（非近期引入） |
| 8 | **照片还是早上那批** | 更新要重跑图片抓取 + **重新过审** |
| 9 | 福利吧第 157 期未上线 | 11-08/11-09 两期缺那批，已发布不补 |
| 10 | **往期统一重分** | ✅ **已完成**（18 期，10-25 ~ 11-11，已上线） |
| 11 | ~~**核对夜间自动发布的第一次真实运行**~~ | ✅ **已完成**（2026-11-16 00:10:01 起跑 → **00:21:40 结束**，`=== NIGHT_DONE exit=0 ===`，部署 `074b1231`，上传 543 对象，清孤儿 1，线上与本地 manifest **SHA256 逐字节一致**，`verify-news` 53/0，archive 23 期）。**无人值守链路从此不再是「没验过」** |
| 12 | **「凌晨预处理 + 早上快跑」双击脚本**（可选） | `daily-review.ps1 -NoGrab -NoClean -NoConvert` —— 夜里只抓取+清洗，早上手只跑构建+自检。**用户尚未表态** |
| 13 | **⚠️ 在 Mac mini 上做真机验收**（本轮新提出） | 我碰不到那台机器 → 只能交付代码 + 部署包 + 手册。步骤见 **`docs/macos-migration.md`**（依赖 → 拷工程 → `.env.local` → `wrangler login` → `install-launchd.sh` → `pmset -c sleep 0`）。**验收判据 = 手册的 C（手动发布）+ D（线上核验）+ E（launchd 真实触发）三条全绿**；只跑通 A（环境）、B（护栏）不算数。⚠️ **没通过之前别删 Windows 那边的计划任务**（两台同时跑 = 同一期发两遍） |
| 14 | ~~**🎵 榜单三个 tab 上线**~~ | ✅ **已完成（2026-11-16 22:08 发布）** —— 用户 22:02 在确认条上拍板「现在发布」→ 审稿台发布端点 → `publish.ps1 -Date 2026-11-16`：产物自检通过（manifest 340 个引用产物）→ 审稿闸门过（170 张）→ R2 上传 **648 个对象 / 18.26 MB / 65.2s** → Pages 部署 `c96ae2bc` → 清孤儿 **125 个（失败 0）** → `=== PUBLISH_DONE exit=0 ===`。线上 **7 个 tab**，manifest `manifest.1vaa20.js`，`verify-news` **63/0**，140 张本地化封面抽检全 200 非空。⚠️ **发布前重启过审稿台**：它一个会话只能发一次（`publishState.running` 不清 → 409「已经在发布了」，但根本没有发布进程在跑），详见 AGENTS.md 已知坑 |
| 15 | **见报配图自检在生产里从未生效（可达性洞）** | `verify-build.mjs` 的「见报配图（`it.img`）」核对写在 `tab.key === 'news'` 那一支，而**真实的见报 tab 带 `type: 'headlines'`** → `isTextTab(tab)` 为真 → 那一支被 `continue` 掉 → **见报配图与「见报重复链接」两项在生产里从没被自检过**（实测 `published/2026-11-16/manifest.*.js` 的 news tab 确实带 `type='headlines'`）。本轮只给那处补了**有效性**检查、**没动可达性** —— 动之前要先确认线上母本里的配图都在，否则一上线就把发布拦死 |

---

## 八、别踩的坑（速查，详见 AGENTS.md）

1. **站点代码不在 git 里** → 无 commit 可回滚，靠「跑测试 + 更新 AGENTS.md + 更新 SDD 账本」留痕。**SDD 账本同样不在 git 里**。
2. **删文件只能走回收站**（不要用 `Remove-Item`，它会被安全策略硬拦）；**递归拷贝（`Copy-Item -Recurse`）同样被拦** → 往期 manifest 的备份用**线上快照**取回（`https://example.com/<日期>/manifest.<hash>.js`）。
3. **改文件用 edit/write + 绝对路径**；bash 里 `cd` 之后写文件/重定向会被硬拦。**bash 里 `cd` 对 .NET API（如 `ReadAllBytes`）无效 —— 相对路径按进程工作目录解析，要用绝对路径**。
4. **比对线上文件必须下原始字节算哈希** —— `.js` 的 Content-Type 常不带 charset。**Pages 对不存在的路径返回 index.html + 200**（验「某期上线了没」不能只看 HTTP 码，要比对字节）。
5. **分类有两套口径**：chip 筛选走 `tags`（一条可属多类，和 > 总数**正常**）；主标签 `tag` 每条唯一（和 = 总数）。**同一个 AI：chip 89 条 / 主标签 39 条**。以 `verify-news.mjs` 数出来的为准。
6. **收尾清理 ≠ 把用户还在用的服务一起停掉** —— 预览/审稿台是用户的工作界面。
7. **本机长驻进程必须经 `explorer.exe` 脱 Job Object**；`detached` 不够。
8. **候选图形状必须 `{url, kind}`** —— 不一致会**静默失败**。
9. **判断外部源能不能用，必须用生产流水线试** —— 裸 fetch 的 403 是假阴性。
10. **内容源有「构建期只读快照」** —— 头条 JSON 过期会静默发旧内容。
11. **加关键词前先在隔离试构建里抽样复核** —— 「英伟达」→ 14 条公司治理八卦进 AI。
12. **公众号镜像 feed 自带 `img-proxy` 配图** —— **不用抓 mp.weixin.qq.com 原文页**。**但镜像会变**，隔一段时间要重探。
13. **镜像源连续 500/404 先怀疑地址抄漏尾巴** —— APPSO 就是这么被误判成「镜像上也没了」的。
14. **`build.mjs` 先 `fs.rm` 再 `mkdir`（第 955 行）** → **构建一启动就清空那一期的目录**。所以「发布被打断」的直接后果是**空目录 + `published/index.html` 指向不存在的 manifest** → **绝不能在没重建的情况下直接 `wrangler pages deploy published`**。（改成原子替换这件事还没做。）
15. **发布日志里没有 `=== PUBLISH_DONE exit=N ===` = 脚本没走到最后**（不是「成功但没写」）。runner 在 `publish.ps1` 返回后无条件追加这一行。
16. **⚠️ PS 5.1：原生命令往 stderr 写一行字，就能掀翻整个脚本** —— stderr 被转成 ErrorRecord，而 `$ErrorActionPreference='Stop'` 把 ErrorRecord 变成**终止性错误**。本机每天都会遇到连接重置，构建就会打这一行「! 抓取过程中连接被重置…该源按失败处理，继续」→ **2026-11-14 / 11-15 两次发布都是这么没的**（不是被 kill）。**所有原生命令必须走 `Invoke-NativeCmd`**（内部降成 Continue，看 `$LASTEXITCODE`）。**别把全局 'Stop' 改成 'Continue'**。
17. **⚠️ Cloudflare 的 OAuth token 只活 1 小时** —— 发布链路（构建 + 上传 + 部署）**会跨过过期点**：11-14 那次发布开头判断「还剩 12 分钟，有效」放行，上传到一半 token 过期 → **249 个文件 401 code 10000** → exit 1，Pages 根本没部署。**上传前必须再续一次**，且**要把新 token 重新导进本进程的环境变量**（续期只改 `.env.local`，子进程继承的是本进程的环境变量）。
18. **`build.mjs` 先 `fs.rm` 再 `mkdir`（第 955 行）** → 构建一启动就清空那一期的目录 → 发布被打断的后果是**空目录 + `published/index.html` 指向不存在的 manifest** → **没重建之前别 `wrangler pages deploy published`**。（改成原子替换这件事还没做。）
19. **PowerShell 里 `node $fileInfo` 只传文件名**（不含目录）→ 20 套护栏一起 exit 1，看着像全军覆没其实只是循环写法错了，**要用 `$t.FullName`**。
20. **`read` 工具偶尔把文件渲染串行**（`V2EX创意` 显示成 `2EX创意`、行与行粘一起）→ **改完 JSON 一定用 `node` 独立校验能 parse、源数对不对**。
21. **manifest 的 hash 是 base-36 不是 hex** —— `manifest.glbf83.js` / `2kxqkw.js` 带 g/l/k/x/q/w → 找文件用 `[0-9a-z]+`；用 `[0-9a-f]` **一个都匹配不上** → 键集 0 个 → 孤儿清理**静默不干活**（不报错、不删东西）。
22. **Cloudflare REST DELETE 删一个不存在的键 → HTTP 200 + `success:false` + `code 10007`** → **判成功必须看响应体，不能只看 HTTP 码**。`code 10000` 才是真失败。
23. **R2 REST 没有 list 接口** → 孤儿只能靠「旧 manifest vs 新 manifest 差集」定位，列举不了整个 bucket。
24. **node CLI 入口在 Windows 必须用 `pathToFileURL(process.argv[1]).href`** —— 手写 `file://${argv[1]}` 得到 `file:///E:/...`（三个斜杠）→ `main()` 根本不跑 → **exit 0 但零输出**（脚本变死的）。再加 `process.argv[1] &&` 防 import 时炸。
25. **`.cmd` 里 `pause` 会让无人值守永远挂死** → 计划任务入口单独做一个**无 pause** 的 `tools\night-publish.cmd`（纯 ASCII / LF / 无 BOM）；桌面「一键更新.cmd」保留给白天双击。
26. **ONSTART / ONLOGON 计划任务触发器需要管理员**（本机不是 → `Access is denied`），**DAILY 不需要** → 开机触发改用 **Startup 文件夹**（语义是「用户登录」，不是「系统启动」）。
27. **夜间脚本里的子进程不能裸调** —— PS 5.1 的 stderr → ErrorRecord → 掀翻 `$ErrorActionPreference='Stop'`（和 11-14/11-15 发布死掉的是同一个坑）→ 统一走 `Invoke-Child`（内部降 Continue、只看 `$LASTEXITCODE`）。
28. **⚠️ 期号 = 北京今天，而抓图落盘目录 = `bj_today`（下载当天）** —— 所以**期号由「跑的那一刻是几号」决定，跟内容日无关**。这导致**夜间跑必须在过了午夜之后**：23:00 跑算出来的是**当天早上已经发过**的那一期，而第二天早上审稿台（期号=北京今天）审的又是**还没发出去**的一期 —— **整个周期错位一天**。判据：`daily_grab_all.py:284-285`（`cat_dir_for` 里 `bj_today = ...; out = OUT_BASE/bj_today/category`）+ `daily.ps1:130-135`（`publishDate = 北京今天`、`ContentDate = 北京昨天`）。
29. **`daily_grab_all.py --out` 只能换输出根目录，换不了日期目录** —— 日期目录恒为 `OUT_BASE/<bj_today>/`。所以「晚上点、提前发明天那期」**光靠参数做不到**，得改抓图脚本（用户本轮决定**不做**）。
30. **抓取台账（`.fetch-ledger.json`）在发请求前就跳过「以前抓过的 URL」** —— 所以**重复抓图不会把用户删掉的图带回来** ✓。这条让「重发当期」是安全的。
31. **`.cmd` 的正文必须纯 ASCII** —— cmd.exe 的 `chcp 65001` 对中文正文不可靠（会显示成乱码）；`.cmd` 约定 = 纯 ASCII / LF / 无 BOM。**无人值守的入口不能有 `pause`**，手动双击的入口**必须有 `pause`**。
32. **⚠️ 清孤儿（R2 DELETE）必须排在 Pages 部署之后** —— 上传完那一刻线上还指着**旧 manifest**，这时删旧对象 = 把线上正在用的图删了（页面裂图）；**部署要是失败，线上就会一直裂着**，直到下一次发布成功才恢复。判据：`publish.ps1` 里 `--sweep` 的位置 > `pages deploy` 的位置，且条件是「既构建又上传**又部署**」。
33. **⚠️ PowerShell 变量名大小写不敏感** —— `$marker` 和 `$Marker` 是**同一个变量**。2026-11-15 傍晚真踩了：路径变量被 JSON 覆盖 → `Set-Content -Path $Marker` 把 JSON 当路径 → 报「找不到与参数名称"Encoding"匹配的参数」→ **标记文件写不出来** → 幂等失效 + 脚本 exit 1。**修法：JSON 变量改名 `$markerJson`**；护栏 `test-night-flow.mjs` 第 6 组专门盯「同一个变量既当路径又当 JSON」这种撞名。
34. **构建前抓的「旧键集」在「准备步已构建过」时是空的** —— 夜间/手动流程里 `daily-review.ps1` 先构建过一次，`publish.ps1` 的 capture 拿到的已经是新 manifest → 差集为空 → 这次没孤儿可清（**正常**）。**孤儿真正出现在「早晨审稿删图 → publish.ps1 重建」那条路径上**。
35. **macOS：反斜杠是合法文件名字符，不是分隔符** —— `tools\review.mjs` 在 macOS 上会被当成**一个文件名** → 报「找不到文件」，报错完全不指向真因。拼路径一律用 `Join-Path`（Windows 也认正斜杠）。
36. **macOS：Unix 认不出 Windows 的时区 ID** —— `'China Standard Time'` 在 Unix 上抛 `TimeZoneNotFoundException` → 期号差一天 → 整个「夜里发 / 早上审」错位。**这条在 Windows 上永远是对的**，只能靠 `common.ps1` 里两个 ID 都试 + 护栏盯着。
37. **macOS：PowerShell 7.4 起原生命令退出码非 0 = 终止性错误** —— 本工程到处是「跑一下看退出码，不行就跳过」的 PS 5.1 老语义 → 在 macOS 上会大面积炸。`common.ps1` 里把 `$PSNativeCommandUseErrorActionPreference` 压回 `$false`。
38. **macOS：息屏 ≠ 睡眠** —— 息屏只关显示器，后台任务照跑；**真正打断它的是系统睡眠**（`sudo pmset -c sleep 0`）。**LaunchAgent 属于用户会话 → 注销后不跑**（锁屏无妨）。
39. **`.night-publish-console.log` 是 UTF-8 无 BOM** —— PS 5.1 的 `Get-Content` 会按 ANSI（GBK）解码 → **中文全是乱码**。要显式指定：`[System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)`。**日志本身没问题，乱码只是读法的问题。**
40. **⚠️ `tools/paths.mjs` 是路径真源（工程根 + 图像根）** —— 别在别的脚本里再写死路径。**`IMAGE_ROOT` 的默认值写死 `~/image-root` 的后果是「静默」的**：macOS 上没有 D 盘，`.env.local` 一旦没带 `IMAGE_ROOT`，审稿台会**一张图都不显示**、构建会以为「今天没图」，而**没有任何报错**。现已按平台分（win32 → `~/image-root`，其他 → `~/image-root`）。同样地，`final-verify.mjs` 原来写死 `PROJECT_ROOT` → 拷到 macOS 上**什么都验不出来**，现改走 `paths.mjs`。
41. **★ 文本型 tab 的判定必须收敛到一处** —— 榜单 tab 是**文本型**（`type:'rank'`），没有 id/thumb/full。判定散落在 `diffImageTabs`、产物自检、`verify-build` 各一份（原来写的是 `type !== 'headlines'`）→ **漏改一处就直接让构建失败**。现已收敛到 **`tools/tab-kinds.mjs`**（`isMediaTab` = `!tab.type` · `isTextTab` = `!!tab.type`）。**加新 tab 类型时先改这一个文件。**
42. **★ 榜单 item 上限不能统一卡一个数** —— 影视榜 = 豆瓣 250 + B站 50 = **300** 条，音乐榜 = 网易云 **200** 首。统一卡 200 会**把 B站那 50 条整段砍掉**（实测踩过）→ 现在是 `MAX_RANK_ITEMS = { music: 200, movie: 300 }`，**按 tab 分别设**；护栏里有对应变异（把两个上限统一成 200 → 必须变红）。
43. **★ 热链封面的三个坑，构建期探测测不出来** —— ① **豆瓣图床全站防盗链**：裸连 418、第三方 Referer 403、**只有 `Referer: https://movie.douban.com/` 才 200** → 外站拿不到 → 豆瓣条目**封面置空 + 首字占位框** ② **B站图床见非 B站 Referer 就 403** → `<img>` 必须 `referrerPolicy='no-referrer'`（**服务器视角没有 Referer，构建期永远测不出来，只能真浏览器验**）③ **iTunes `country=cn` 对英文词返回 0 条**，不帶 country 才给结果（且给繁体中文）→ 前端做「先 cn、搜不到退回不带 country」。
44. **★ TVmaze 播出表里混着新闻/脱口秀/真人秀** —— 实测美国一天 81 条：**Scripted 只有 10 条**，News 37 · Talk Show 14 · Reality 13 · Game Show 3 · Documentary 2 · Sports 2 → **不按 `show.type` 过滤，这个 tab 的首页就是「CBS Mornings」**。现按 `SERIES_TYPES = ['Scripted','Documentary']` 筛。**`type` 缺失的条目保留**（判不出来就不丢数据）；**结构自检必须用不过滤的解析**（`types: null`），否则「某国某天全是新闻类」（JP 2026-11-17 实测 6 条全是新闻）会被误报成「源结构可能变了」。
45. **★ 播出表按国家分组，别按时间全局混排** —— 美剧黄金档 = UTC 次日凌晨，**全局按时间排会把美剧压到末尾**（用户要的就是美剧更新）→ 国家顺序 = `COUNTRIES`（US → CN → JP → KR → HK），组内按播出时间升序。
46. **★ 两块各有一套从 1 开始的序号，拼接后必须重编号** —— schedule 1..N、events 1..M，直接拼起来同一个 tab 里序号重复（「1..150」后面又来「1..120」）→ `build.mjs` 拼接后**统一重编号成 1..K**（护栏钉死，变异会变红）。
47. **★ 文本型 tab 的计数单位别写成「张」** —— `countPill` 原来按 `type === 'headlines'` 判断 → 榜单 tab 显示「200 张」。现在按 `s.tab.type ? ' 条' : ' 张'`（**文本型一律「条」，图片 tab 才「张」**）。

---

## 九、机器相关

74 个 Chrome 进程是用户自己的浏览器，**不要杀**。本机到 Cloudflare 的 TLS 连接会**间歇 ECONNRESET** → 所有联网脚本自带重试。**机器重启/关机也会带走长驻进程** —— 查事件日志 1074（正常关机）/12（启动）/41/6008 对时间线，别误报成「程序崩了」。**长驻进程静默消失 + 无日志，先查 Job Object，再查控制台。**

---

## 十、定时任务台（2026-11-21 新增）

**是什么**：一个**只读为主的本地网页**（`127.0.0.1:8801`，占用时顺延，实值写 `.night-dashboard-port`），
看夜间发布跑到哪一步、有没有问题；外加两个受控写操作。

- **怎么起**：双击根目录 `起任务台.cmd`，或 `node tools\start-dashboard.mjs`
  （Windows 内部经 `explorer.exe` 脱 Job Object；macOS/Linux 直接 detached）。
- **状态从哪来**：本机三种日志源 `.night-publish-<日期>.log` / `.manual-publish-<日期>.log` /
  `.review-publish-<日期>.log` + 标记文件 `.night-publish-<日期>.done`。
  **`.done` 是唯一权威完成记录**（日志尾部的 `NIGHT_DONE` / `MANUAL_DONE` / `PUBLISH_DONE` 只作兜底）；
  `finishedAt / durationMs / exitCode / source` 必须**同源**（不许混着拼）。
- **阶段耗时**：靠三个 helper 现在带的 `[HH:mm:ss]` 时间戳算。
  ⚠️ **11-20 及之前的老日志没有时间戳** → 那几期阶段耗时显示 `—`，**不是「0 秒」**。
- **补发某一天 = 线上首页重新指向那一天** —— **不可逆**（撤回要等 24 小时边缘缓存）。
  → 「立即跑一次」和「补发某一天」是**两个独立按钮**，各带一条写明不可逆的确认条。
- **桌面通知的三条腿**：① 页面内状态卡（永远）② 浏览器 Notification API（页面开着）③
  服务端 Windows toast（`tools/notify.ps1`，**页面关着也收得到**，唯一的补位）。
  ③ 是**尽力而为**：发不出去就静默降级，**绝不影响主流程**；
  macOS 上按 `process.platform` 分支换 `osascript`。
- **护栏**：`tools/test-night-dashboard.mjs` **165/0** + `tools/test-night-dashboard-mutate.mjs`
  **14/14 全抓** + `tools/test-portability.mjs` **45/0**。

### ⚠️ 这个功能的两个真坑（2026-11-20/21 **实测**，不是推理）

1. **Windows 上 `spawn('powershell', …, {detached:true})` 起的 PowerShell 会「立刻退出（exit 0）」，脚本根本没跑**
   → 发布进程根本没起来，但 HTTP 层返回 **202 `{ok:true,pid}`**，看着像受理了 → **静默无操作**。
   → 必须 `cmd /c start /b`（`detachedPowerShell()`）。
2. **Windows 在计划任务「正在运行」期间就把 `LastTaskResult` 报成 267009（`SCHED_S_TASK_RUNNING`）**
   → 不排除掉的话，**每天晚上发布进行中**任务台都会弹「上一次运行没有正常结束」→ **天天误报**。
   → 判据抽成纯函数 `scheduleProblem(sched)`，排除 267009 / 267011，并用 `state === 'Running'` 互为印证；
   **真失败码（267014）仍然要报**（防止一刀切返回 null 把判据整个废掉）。
3. **Windows toast 的 AUMID 字面量同时含反斜杠路径和硬编码 `powershell.exe`** → 住在
   `tools/common.ps1` 里（工程约定：平台字面量只放那一个文件），`notify.ps1` 只调 `Get-ToastAumid`。
