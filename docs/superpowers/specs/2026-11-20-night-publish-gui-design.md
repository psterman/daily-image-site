# 定时任务台：每日站点夜间发布任务的本地 GUI

日期：2026-11-20
状态：设计已批准（形态 / 首屏布局 / 视觉风格 / 技术方案 / 阶段耗时取法 / 通知方案，逐段获批）

---

## 1. 背景与目标

每日图片站「大佬请批阅」（`https://daily.onetone.app/`）的夜间发布由 Windows 计划任务
`\DailyImageSite-NightPublish-0010` 驱动，每天 00:10 跑一整条链路（准备 → 构建 → 上传 R2 →
部署 Pages），跑完写一份 `.night-publish-<日期>.log` 和一个 `.night-publish-<日期>.done` 标记。

现状的四个问题：

- **看不见进度** —— 链路有 15 个阶段，跑要 15–30 分钟，但没有任何入口能看到它跑到哪一步。
- **出事只能翻日志** —— 日志是 65KB 纯文本，失败时要人肉在几百行里找哪一步炸了。
- **没有历史** —— 每天的 `.done` 散在工程根，没有一条能回看的流水。
- **重跑 / 补发没有入口** —— 手动发布是桌面双击 `.cmd`，看不见它跑没跑成。

目标：一个只在本机跑的网页，打开就知道「今天跑成没有、跑到哪了、有没有问题」，
并且能在页面上做两个受控的写操作（立即跑一次 / 补发某一天）。

---

## 2. 范围

### 2.1 做什么

- 本地网页 `http://127.0.0.1:8801`（占用则顺延）
- 首屏「今日焦点」：状态 + 15 阶段进度 + 问题卡 + 最近 7 天
- 只读能力：今天状态 / 阶段进度 / 历史流水 / 某天的日志尾部
- 写操作：「立即跑一次」「补发某一天」，各有**独立的**二次确认条
- 反馈：页面内提示 + 浏览器桌面通知 + 服务端 Windows toast（页面关着也收得到）

### 2.2 不做什么（YAGNI）

| 不做 | 为什么 |
|---|---|
| SSE / WebSocket | 本地单用户，3 秒轮询够用 |
| 登录 / 权限 / 用户系统 | 只绑 `127.0.0.1` |
| 多期对比图表 | 7 天迷你条 + 展开表格够用 |
| 移动端适配 | 只在桌面上看 |
| 改发布链路的逻辑 | 只改 3 个 helper 的**输出格式**（加时间戳） |
| 调 Cloudflare API 取状态 | 状态全从磁盘推导 —— 不花 token、不触发限流、不受线上故障影响 |

---

## 3. 已确认的决策

| 项 | 决策 |
|---|---|
| 形态 | 独立本地网页，8801 |
| 首屏 | A「今日焦点」 |
| 视觉风格 | 1「素白文档风」（+ 跟随系统的暗色） |
| 技术方案 | A「独立常驻小服务」（**不**并进审稿台） |
| 阶段耗时 | 改 3 个 helper 加时间戳（不靠 dashboard 采样） |
| 通知 | 页面 + 浏览器通知 + 服务端 Windows toast |
| 操作边界 | 只读 + 「立即跑一次」+「补发某一天」 |
| 补发语义 | 重跑 `publish.ps1 -Date <该日> -SkipReview -NoConvert -NoHeadlines` → **线上首页重新指向该日**（不可逆） |

---

## 4. 架构

### 4.1 组件

| 文件 | 职责 |
|---|---|
| `tools/night-dashboard.mjs` | 常驻 HTTP 服务：静态托管 + 4 个 API。Node 内置 `http`，**零新依赖** |
| `tools/night-dashboard-state.mjs` | 解析层（I/O + 纯函数）：读 `.done`/`.log`、剥 BOM、解析阶段树、算状态与问题 |
| `tools/dashboard-ui/{index.html,app.js,app.css}` | 页面（原生 JS，零构建、零框架） |
| `tools/start-dashboard.mjs` | 启动器：Windows 经 `explorer.exe` 脱 Job；macOS 直接 detached |
| `起任务台.cmd` | 根目录双击入口（**纯 ASCII / LF / 无 BOM**） |
| `tools/notify.ps1` | Windows toast（服务端调用，页面关着也能发） |
| `tools/test-night-dashboard.mjs` | 护栏 |
| `tools/test-night-dashboard-mutate.mjs` | 变异护栏 |

**复用不重造**：`tools/publish-state.mjs`（已有）提供 `computePublishState` / `describeDeadState` /
`PUBLISH_STALE_MS`（6 分）/ `PUBLISH_TIMEOUT_MS`（45 分）/ `PUBLISH_TOUCH_MS`（2 分）。

⚠️ `publish-state.mjs` 是**纯函数、零 I/O** —— 它不读文件、不剥 BOM、不解析 `.done`。
那些是解析层（`night-dashboard-state.mjs`）的事。

### 4.2 数据流

```
计划任务 00:10 → tools/night-publish.cmd → tools/night-publish.ps1
  → tools/daily-review.ps1 → tools/daily.ps1    （准备 8 节点）
  → tools/publish.ps1                           （发布 6 节点）
        ↓ 写
.night-publish-<日期>.log   （阶段标记行，带 [HH:mm:ss]）
.night-publish-<日期>.done  （JSON：date / at / exit；手动跑时多一个 by）
        ↓ 每 3 秒
dashboard 服务扫磁盘 → 解析 15 节点 → 算状态与问题 → GET /api/state → 页面重绘
```

- 页面**不主动读文件**；服务端**不调 Cloudflare API**。
- 唯一例外是「下次运行时间」从计划任务读 —— 不需要管理员权限（已实测）。

### 4.3 写操作链路

```
按钮 → 二次确认条（写清不可逆性） → POST /api/run-now | /api/republish
     → 本机 + 跨站 Origin 校验（**动态端口**白名单）
     → 已有任务在跑？ → 409
     → spawn（Windows: cmd /c start /b powershell -File <runner>；macOS: pwsh + detached）
     → runner 捕获 *>&1 落日志 + 自己写 DONE 标记
     → 202 立刻返回；页面靠同一套 3 秒轮询看到进度
```

⚠️ `publish.ps1` 用 `Write-Host` 输出，**不走 stdout** → 必须 `*>&1` 捕获，
否则日志里连 `=== 6/6 部署 ===` 都看不到（审稿台踩过这个坑，见 `review.mjs:1379-1383`）。

### 4.4 三个写操作各自用哪个脚本

| 操作 | 命令 | 期号 | 注意 |
|---|---|---|---|
| 立即跑一次 | `tools/manual-publish.ps1 -Force -NoBrowser` | 北京今天 | **必须带 `-Force`**：不带的话，当天已发过时会 `Read-Host` 提问，无控制台时抛异常 → 被 catch → 跳过 → 静默 `exit 0`（用户以为跑了，其实啥也没干）。**必须带 `-NoBrowser`**：否则跑完会 `Start-Process` 打开线上站点抢焦点 |
| 补发某一天 | `tools/publish.ps1 -Date <该日> -SkipReview -NoConvert -NoHeadlines` | 用户选的那天 | 完整流程：构建 + 上传 + 部署 + 清孤儿。开关跟夜间一致 —— 跳过审稿闸门（用户 2026-11-15 已授权「接受未审稿直接上线」），`NoConvert` 复用已转好的图 |
| 夜间（不由 GUI 触发） | `tools/night-publish.ps1` | 北京今天 | 时间闸门 00:00–05:59，`-Force` 越过 |

补发**不重跑准备阶段**（不抓图、不刷头条），只重发那一天已有的内容 → 所以源图必须在。
`manual-publish.ps1` 与夜间**共用幂等标记** `.night-publish-<日期>.done`，
手动写出的 JSON 多一个 `by: 'manual'` 字段。

### 4.5 怎么打开页面

- 双击根目录 `起任务台.cmd` → 服务起来 → **自动打开** `http://127.0.0.1:<实际端口>/`。
  端口可能从 8801 顺延，所以必须读 `.night-dashboard-port` 拿**实际端口**再打开，不能写死 8801。
- **再双击一次不重复起服务**：脚本先探 `.night-dashboard-port` 上的端口是否还活着 →
  活着就直接打开页面；死了才重新起。
- 服务常驻：关掉浏览器不影响它。`起任务台.cmd` 放进 Startup 文件夹 → 开机自启
  （跟夜间发布走同一条路 —— 本机非管理员，`ONSTART`/`ONLOGON` 触发器用不了）。

---

## 5. 数据源与格式（全部实测）

### 5.1 三种日志源

| 来源 | 日志 | 结束标记 | 幂等 / 凭证 |
|---|---|---|---|
| 夜间 | `.night-publish-<D>.log` | `=== NIGHT_DONE exit=N ===` | `.night-publish-<D>.done` |
| 手动 | `.manual-publish-<D>.log` | `=== MANUAL_DONE exit=N ===` | 同一个 `.done`（多一个 `by:'manual'`） |
| 审稿台 | `.review-publish-<D>.log` | `=== PUBLISH_DONE exit=N ===` | `.review-passed-<D>` |

三种**归一成同一套 `steps` 结构**，靠各自的 DONE 标记判来源。

### 5.2 `.done` 的两个坑

1. **带 UTF-8 BOM**（实测首字节 `EF BB BF`）→ `JSON.parse` 前必须剥 `\uFEFF`。
2. **失败时也会写**（`"exit":1`）→ 幂等正则 `'"exit"\s*:\s*0'` 不匹配 → 下次会重跑。
   界面必须区分「昨晚失败过」和「昨晚没跑」。

### 5.3 阶段树：15 个节点

日志里共 15 行阶段标记。界面上分 **3 组**：

```
组 1「准备」—— 7 个节点
  1/3 每日准备（抓图 → 头条 → 清洗 → 榜单/追更 → 构建）   ← 既是组标题也是节点
    0/5 准备环境
    1/5 抓图 + 目录分流
    2/5 抓头条（见报的分类目录）
    3/5 清洗图片（剔广告 / 剔废图 / 剔重复）
    4/5 抓榜单 + 追更
    5/5 构建（本地，不上传）
组 2「校验与审稿」—— 2 个节点
  2/3 校验构建产物
  3/3 跳过审稿台（-SkipReview）
组 3「发布」—— 6 个节点
  1/6 刷新 Cloudflare token
  2/6 构建页面与图片
  3/6 探测 R2 状态
  4/6 跳过审稿闸门
  5/6 上传图片到 R2
  6/6 部署 Cloudflare Pages（项目 daily-image-site）
```

7 + 2 + 6 = **15 个节点**。

**同一编号有多个分支文案**（`2/6 构建页面与图片` / `2/6 跳过构建`；`4/6 审稿闸门` /
`4/6 跳过审稿闸门`；`5/6` 三种；`3/3` 两种）→

- **步骤 key 用编号**（`prep/1-5`、`pub/2-6`），不用文案；
- **显示的文案用日志里实际出现的那句** —— 跳过了哪一步如实呈现。

### 5.4 阶段时间戳：改 3 个 helper

三个脚本各有一个输出 helper，一改覆盖全部变体：

| 文件:行 | 现状 | 改后 |
|---|---|---|
| `tools/daily.ps1:76` | `function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }` | `function Step($msg) { Write-Host ("`n=== $msg ===  [" + (Get-BjNow).ToString('HH:mm:ss') + "]") -ForegroundColor Cyan }` |
| `tools/daily-review.ps1:98` | `function Rule($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }` | 同上（`(Get-BjNow)`） |
| `tools/publish.ps1:51` | `function Step($msg) { ... }` | 同上（`(Get-BjNow)`） |

输出变成：`=== 1/6 刷新 Cloudflare token ===  [00:12:03]`

四条约束：

1. **用 `Get-BjNow`，不用 `Get-Date`** —— 日志头行那个 `00:10:02` 是北京时间基准；
   `Get-Date` 是本机本地时区。macOS 迁移后时区一变，两个基准错位，阶段耗时会算出负数。
   三个脚本都已 dot-source `common.ps1` ✓
2. **时间戳放在 `===` 之后** —— 消息仍在两个 `===` 之间。解析正则
   `^===\s+(.+?)\s+===\s+\[(\d{2}:\d{2}:\d{2})\]\s*$` 取时间；
   **老日志走兼容分支照样解析**（无时间戳 → 阶段耗时显示 `—`）。
3. **跨零点**：手动跑可能 23:50 起跨过零点 → 解析时若算出时刻早于上一节点就 +1 天。
4. **只改输出格式，不改逻辑**。`night-publish.ps1` / `publish.ps1` / `manual-publish.ps1`
   的任何逻辑不动。`board.ps1` / `gate.ps1` / `setup-cloudflare.ps1` 也有同名 helper，
   但不在夜间链路上，不动。

---

## 6. 状态推断与问题判定

### 6.1 状态机

`not-run` → `running` → `success` / `failed`；
任何时刻日志停摆 6 分钟 → `dead`（复用 `describeDeadState`）。

### 6.2 问题判定规则（只出一条最重的）

| 级别 | 判据 | 文案 |
|---|---|---|
| error | 结束标记 `exit ≠ 0` | 「11-19 失败了：上传图片到 R2 退出码 1」 |
| error | 日志 6 分钟没动且无结束标记 | 「发布进程已经不在了：日志 420 秒没有更新」 |
| error | 45 分钟没有结束标记 | 「发布超时：45 分钟没有结束标记」 |
| warn | 总耗时 > 历史中位数 × 2 | 「昨晚花了 31 分 36 秒，平时 15 分」 |
| warn | 某阶段 > 中位数 × 3 | 「阶段 1『刷新 token』用了 7 分 12 秒，平时 2 秒」 |
| info | 计划任务 `LastResult ≠ 0` | 「计划任务上次结果码 267009」 |
| info | 现在 > 06:00 且今天没有 `.done` | 「今天凌晨没有跑」 |

### 6.3 中位数只用成功的夜

失败夜会把均值和中位数都拉歪 —— 11-20 那夜正是如此（平时 15 分钟，那夜 31 分 36 秒）。
中位数只取 `exit=0` 的夜。

---

## 7. HTTP 接口

### 7.1 `GET /api/state`

```jsonc
{
  "ok": true,
  "serverTime": "2026-11-20T09:02:00+08:00",
  "todayBj": "2026-11-20",
  "schedule": {
    "available": true,
    "name": "DailyImageSite-NightPublish-0010",
    "state": "Ready",
    "lastRunTime": "2026-11-20T00:10:10+08:00",
    "lastResult": 0,
    "nextRunTime": "2026-11-21T00:10:10+08:00"
  },
  "current": {
    "date": "2026-11-20",
    "source": "night",              // night | manual | review | null
    "status": "success",            // success | failed | running | dead | pending | not-run | unknown
    "headline": "成功 · 31 分 36 秒",
    "startedAt": "2026-11-20T00:10:02+08:00",
    "finishedAt": "2026-11-20T00:41:39+08:00",
    "durationMs": 1897000,
    "exitCode": 0,
    "steps": [
      { "key": "prep/1-5", "label": "抓图 + 目录分流", "group": "准备",
        "status": "done", "at": "00:10:11", "durationMs": 42000 }
    ],
    "problem": null                 // { level: "error|warn|info", title, detail, stepKey? }
  },
  "history": [
    { "date": "2026-11-20", "status": "success", "durationMs": 1897000,
      "source": "night", "headline": "成功 · 31 分 36 秒" }
  ],
  "problems": [],
  "actions": {
    "busy": false,
    "canRunNow": true,
    "republishDates": ["2026-11-20", "2026-11-19", "2026-11-18"]
  }
}
```

`steps[].status` ∈ `done | running | pending | failed | skipped`。

### 7.2 `GET /api/log?date=YYYY-MM-DD`

→ 200 `{ ok: true, date, source, lines: [...] }`（尾部 120 行）；日期非法 → 400。

### 7.3 `POST /api/run-now` / `POST /api/republish`

| 情况 | 状态码 |
|---|---|
| 非本机 | 403「只允许本机触发」 |
| 跨站 Origin | 403「跨站请求被拒绝」 |
| 已有任务在跑 | 409「已经在跑了，等它跑完」 |
| 正常受理 | **202** `{ ok: true, taskId }`（**不阻塞等发布跑完** —— 发布要 15–30 分钟） |
| 日期非法 / 源图已清理 | 400 + 原因 |

---

## 8. 界面

### 8.1 首屏「今日焦点」

```
┌────────────────────────────────────────────────────┐
│ 任务台                              计划任务 Ready ● │  ← 顶栏
├────────────────────────────────────────────────────┤
│ 2026-11-20 夜间发布         [ 成功 · 31 分 36 秒 ]  │  ← 主状态
│ 00:10:02 开始 · 00:41:39 结束 · 15/15 节点完成        │
│                                                     │
│  准备（7）                                          │
│  ●━━━━●━━━━●━━━━●━━━━●━━━━●━━━━●                    │  ← 15 节点分 3 组
│  1/3  0/5  1/5  2/5  3/5  4/5  5/5                  │
│  校验与审稿（2）                                     │
│  ●━━━━●                                            │
│  2/3  3/3                                         │
│  发布（6）                                          │
│  ●━━━━●━━━━●━━━━●━━━━●━━━━●                        │
│  1/6  2/6  3/6  4/6  5/6  6/6                      │
│                                                     │
│  ⚠ 阶段 1「刷新 token」用了 7 分 12 秒，平时 2 秒    │  ← 只在有问题时出现
│                                                     │
│  最近 7 天  ▇▇▇▇▇▇▇          [ 展开历史 ▾ ]         │
└────────────────────────────────────────────────────┘
```

- **阶段点**：绿=完成、蓝=进行中（呼吸动画）、灰=待跑、黄=跳过、红=失败；
  点一下展开该步的日志尾部。
- **问题卡**只在有问题时出现；没问题时不占地方。
- **历史**：默认只露 7 天迷你条，展开才是完整表格（日期 / 结果 / 耗时 / 来源 / 一句话结论）。
- **底部操作条固定**：右侧两个次要按钮 —— `立即跑一次`、`补发某一天 ▾`。

### 8.2 视觉风格「素白文档风」

| token | 值 | 用途 |
|---|---|---|
| 底 | `#ffffff` | 卡片 |
| 主文字 | `#1d1d1f` | 标题、正文 |
| 次文字 | `#86868b` | 标签、说明 |
| 绿 | `#34c759` | 成功 / 完成 |
| 黄 | `#ff9f0a` | 跳过 / 偏慢 |
| 红 | `#ff3b30` | 失败 |
| 蓝 | `#0071e3` | 进行中 / 主操作 |

- 系统字体，14px 基准，大留白，靠留白和字重分层。
- **暗色模式跟随系统**（`prefers-color-scheme`）—— 半夜起来看是刚需。

### 8.3 两个独立的确认条

按「不可逆的对外动作要与检查拆开、发布要写清不可逆性」的既定规矩，
这里是**两个独立入口、两个独立确认条，谁都不合并**：

**`立即跑一次`** →

> 立刻重跑今天的完整流程（抓图 → 头条 → 清洗 → 构建 → 上传 R2 → 部署 Pages）。
> **线上首页会立刻变成今天这一期。**
> 撤回要等 24 小时边缘缓存，发出去的链接收不回来。
> `[ 取消 ]` `[ 确认跑一次 ]`

**`补发某一天`**（选完日期才弹）→

> 补发 **2026-11-18**：重新构建并部署那一期。
> **线上首页会重新指向 2026-11-18**；11-19、11-20 会下线，直到你再发一次新期。
> 撤回要等 24 小时边缘缓存。
> `[ 取消 ]` `[ 确认补发 2026-11-18 ]`

**日期可选范围**：只有**源图目录还在**的日期可选（`D:\daily-images\src\<日期>\`）；
源图被清掉的日期**禁用并注明「源图已清理」** —— 点了必失败，不如不让点。

### 8.4 通知：三条腿

| 腿 | 通道 | 覆盖场景 |
|---|---|---|
| ① 页面 | 页面内状态卡 | 永远（页面开着） |
| ② 浏览器 | Notification API | 页面开着；触发点：跑完、出现 error/warn、手动跑失败。首次访问给一个「开启通知」按钮（浏览器不允许自动授权） |
| ③ 服务端 | Windows toast（`tools/notify.ps1`，WinRT + PowerShell 自己的 AUMID，零新依赖） | **页面关着也收得到** —— 唯一的补位 |

- ③ 是**尽力而为**：toast 发不出去就静默降级 + 记一行日志，**绝不影响主功能**。
- macOS 上按 `process.platform` 分支换 `osascript`。
- **不漏**：页面下次打开时顶部挂一条「有 N 条未读问题」。

---

## 9. 错误处理与降级

| 情况 | 处理 |
|---|---|
| 8801 被占 | 顺延 8802–8810（照抄 `review.mjs:1663-1684` 的写法），写 `.night-dashboard-port` |
| 8810 也被占 | 退出码 1 + 明确报错（不静默） |
| 计划任务不存在 / 被改名 | `schedule.available = false`，页面显示「找不到计划任务」，**其余照常** |
| 读计划任务要管理员而失败 | 降级：`schedule` 整块显示「—」，不报错 |
| `.done` 带 BOM | 解析前剥 `\uFEFF` |
| `.done` JSON 坏了 | 当作「没有结果」+ 页面显示「标记文件损坏」，**不抛异常** |
| 日志正被写（读到半行） | 只取完整行，末尾不完整那行丢掉 |
| 日志格式变了（标记行没了） | 状态退化为 `unknown`，页面明说「日志格式变了」，**不假装一切正常** |
| 日志变大 | 每次只读**尾部 64KB**（`fs.stat` 拿大小再定位读） |
| 今天还没跑 | `status = not-run` → 「今天凌晨还没跑」 |
| 手动任务撞上夜间任务 | 写操作前查进程 → 409「已经在跑了」 |
| toast 发不出去 | 静默降级 + 记一行日志，**绝不影响主流程** |

---

## 10. 安全

- **只绑 `127.0.0.1`**（不绑 `0.0.0.0`）。
- 写操作先判 `req.socket.remoteAddress` 必须是 `::1` / `::ffff:127.` / `127.` 前缀。
- 再判 `Origin`：存在时其 host 必须等于**服务实际监听的端口**（`localhost:<chosenPort>`
  或 `127.0.0.1:<chosenPort>`）；缺失（curl 等非浏览器）放行。
  ⚠️ **不能像审稿台那样把端口写死 8789** —— 端口顺延后同源 POST 会把自己判成跨站 403。
- 只读端点无副作用。
- 写操作有二次确认条 + 不可逆文案。
- 补发日期必须源图存在，否则 400。

---

## 11. 测试（护栏）

新增 `tools/test-night-dashboard.mjs`（按现有护栏风格：输出「N 通过 / M 失败」，
可被 `tools/run-all-tests.mjs` 收编）+ `tools/test-night-dashboard-mutate.mjs`
（变异体：改坏解析器必须被抓住；锚点自检 / 期望红+期望绿双向声明 / 统计按本次运行切分）。

**A. 解析层（纯函数，喂固定样本）**

1. 15 个阶段标记全认出来（编号 + 文案 + 时间戳）
2. **老日志（无时间戳）也能解析**，时间戳为 null
3. 变体文案认得出（`2/6 跳过构建` vs `2/6 构建页面与图片`、`5/6` 三种）
4. `.done` 带 BOM 能剥
5. `.done` JSON 坏了 → 不抛，退化成「无结果」
6. 三种 DONE 标记都认：`NIGHT_DONE` / `MANUAL_DONE` / `PUBLISH_DONE`
7. `exit ≠ 0` → 最后一个阶段标 failed
8. **跨零点**的时间戳 → 时长算对（不出现负数）

**B. 状态与问题判定**

9. `exit ≠ 0` → error
10. 日志 6 分钟不动 → `dead`（复用 `describeDeadState`）
11. 总耗时 > 中位数 × 2 → warn
12. **中位数只用成功的夜** —— 构造一个「失败夜耗时 40 分钟」的样本，断言它不拉歪中位数
13. 今天没跑 → info

**C. HTTP（真起服务，不是 mock）**

14. `GET /api/state` → 200 + JSON 形状
15. `GET /api/log?date=` → 200；非法日期 → 400
16. `POST` 非本机 → 403
17. `POST` 跨站 Origin → 403
18. **同源 Origin（动态端口）→ 放行** ← 审稿台那个坑的回归测试
19. 已有任务在跑 → 409
20. 静态资源 `/` `/app.js` `/app.css` → 200 + 正确 MIME
21. **目录穿越**：金丝雀断言（响应体里没有金丝雀标记）+ 补一条 `%2f..%2f`
    真正打到防护分支 —— 请求路径里的 `..` 会被 URL 解析器提前归一化，
    只断言 404 是**假绿**

**D. 3 个 helper 的改动**

22. `daily.ps1` / `daily-review.ps1` / `publish.ps1` 的 `Step`/`Rule` 都带时间戳
23. 三处都用 `Get-BjNow` 而不是 `Get-Date`
24. **实跑验证**：真跑一次
    `publish.ps1 -Date 2026-11-20 -SkipBuild -SkipUpload -SkipDeploy -SkipReview -NoConvert -NoHeadlines`
    （全跳过 → **不部署、不碰线上**）→ 日志里出现带时间戳的标记 → 解析器认得

**E. 启动器约定**

25. `起任务台.cmd` 纯 ASCII / LF / 无 BOM（跟 `test-daily-review.mjs` 断言 `起审稿台.cmd` 同款）
26. `start-dashboard.mjs` 有非 Windows 直起分支（macOS 上不碰 `explorer.exe`）

---

## 12. 落地顺序（每步能停、能回滚）

1. **先改 3 个 helper**（加时间戳）→ 用 `publish.ps1 -SkipBuild -SkipUpload -SkipDeploy -SkipReview`
   验证（**全跳过，不部署，不碰线上**）→ 确认日志里有时间戳 → 跑全量护栏
2. 写 `tools/night-dashboard-state.mjs`（解析层）+ 它的单测
3. 写 `tools/night-dashboard.mjs`（服务）+ `tools/dashboard-ui/` 静态页
4. 写 `起任务台.cmd` + `tools/start-dashboard.mjs`
5. 写 `tools/test-night-dashboard.mjs` + 变异套件 → 全绿
6. 起服务 → 实跑「立即跑一次」→ **这一步会真的发布一次，是不可逆对外动作，到时先跟用户确认**
7. 同步到公开副本（`daily-image-site-open`），两仓护栏都绿
8. 两仓 `.gitignore` 加 `.night-dashboard-port`；`起任务台.cmd` 放进 Startup 文件夹（开机自启）

---

## 13. 后续（不在本次范围）

- macOS 的 toast（`osascript`）—— 留接口，Windows 先跑通
- 阶段耗时的精确历史（helper 加时间戳从本次起才有；11-20 及之前的老日志显示 `—`）
- 多期对比图表
- 给「补发」加「发完自动回到最新期」的组合动作

---

## 附录 A：实测依据（2026-11-20）

| 事实 | 怎么验的 |
|---|---|
| 计划任务上次 00:10:10、结果 0、下次 2026-11-21 00:10:10 | `Get-ScheduledTask` / `Get-ScheduledTaskInfo`（不需要管理员） |
| `.done` 带 BOM、102 字节、含 date/at/exit | 读文件字节 + 内容 |
| 阶段标记格式 `=== N/6 阶段名 ===`，独占一行 | grep 11-20 的日志（727/740/1180/1189/1198/1249 行） |
| 日志第 4 行有启动时刻 `2026-11-20 00:10:02`；文件 CreationTime `00:10:01` | 读日志头 + 文件属性 |
| 日志行**没有**时间戳 | 逐行看，只有 Python 抓图器和上传进度行自带时间 |
| 三个 DONE 标记互不相同 | `night-publish.ps1` / `manual-publish.ps1` / `review.mjs` |
| `manual-publish.ps1` 会 `Read-Host` 提问 | 读 `manual-publish.ps1:102-121` |
| 审稿台 Origin 白名单写死 8789 | 读 `review.mjs:1500-1519` |
| `publish.ps1` 用 `Write-Host`，得用 `*>&1` | 读 `review.mjs:1379-1383` |
| 没有护栏断言 `=== N/6` 格式 | grep 全部 `test-*.mjs` |
| 三个 helper 各只有一处定义 | grep `Step\|Rule` 定义行 |
