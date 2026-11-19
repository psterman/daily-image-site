# 榜单接入缺口汇报

生成：2026-11-18（探针 2026-11-18）  
更新：2026-11-19 — 社区热帖可抓性整理；白名单增 `hupu` / `v2ex` / `juejin` / `pcbeta`  
更新：2026-11-19 — 继承 DailyHotApi 探针/研发（补 NewsNow 缺口）

## 结论

- **通道**：RSS / 现有 `daily_headlines.py` API 抓取 / **NewsNow JSON API** / **DailyHotApi JSON**（不是爬 rebang、open2hub 页面）。
- **NewsNow 白名单**：见 `tools/newsnow.config.json`（热搜 + 社区热帖 + 部分日更源）。
- **DailyHot 白名单**：见 `tools/dailyhot.config.json`（上线 8：NGA / 吾爱 / NodeSeek / 米游社 / AcFun / 豆瓣小组 / 快手 / CSDN；简书/HostLoc 不下）。
- **目录状态**：have=97 · planned=24 · skip=105（2026-11-18 基线）；社区热帖增量见下节。

## 已接入 NewsNow

| 显示名 | NewsNow id | 见报/用途 |
| --- | --- | --- |
| 百度热搜 | `baidu` | hot |
| 微博热搜 | `weibo` | hot |
| 知乎热榜 | `zhihu` | hot |
| 抖音热榜 | `douyin` | hot |
| 今日头条热榜 | `toutiao` | hot |
| B站热搜 | `bilibili-hot-search` | hot（搜词热，非专栏热帖） |
| 百度贴吧热议 | `tieba` | hot · 社区热帖 |
| 虎扑步行街 | `hupu` | hot · 社区热帖 |
| V2EX | `v2ex` | dev · 社区热帖 |
| 掘金 | `juejin` | dev · 技术热文 |
| 远景论坛 | `pcbeta` | tech · 论坛帖 |
| GitHub趋势 | `github-trending-today` | dev |
| 金十数据 | `jin10` | biz |
| 凤凰热榜 | `ifeng` | current |
| 华尔街见闻热榜 | `wallstreetcn-hot` | biz |
| 酷安热榜 | `coolapk` | tech · 偏数码动态 |

生产请设 `NEWSNOW_BASE_URL` 指向**自建** NewsNow；公共 demo 仅作探针（非浏览器 UA 易 403）。

## 已接入 DailyHotApi

| 显示名 | DailyHot id | 见报/用途 |
| --- | --- | --- |
| 吾爱破解 | `52pojie` | tools · 论坛热帖 |
| NodeSeek | `nodeseek` | dev · 社区热帖 |
| 米游社 | `miyoushe` | fun |
| AcFun | `acfun` | ent |
| 快手热榜 | `kuaishou` | hot |
| CSDN | `csdn` | dev |

### 已接入 HotExtras（`tools/fetch-hot-extras.mjs`）

| 显示名 | 通道 | 备注 |
| --- | --- | --- |
| 小红书热榜 | OmniTrends `/api/s?id=xiaohongshu` | NewsNow 无此 id |
| 抽屉热榜 | `dig.ichouti.cn/link/hot` | JSON 热榜 |
| NGA网事杂谈 | NGA ladder + 生活/职场/文娱版块筛选 | 非 DailyHot 全站游戏热帖；官方 fid=-7 需登录 |

生产请设 `DAILYHOT_BASE_URL` 指向**自建** DailyHotApi；公共镜像仅作探针。

刷新综合预览快照：`node tools/refresh-pack-preview-hot.mjs`。

---

## 社区热帖可抓性（2026-11-19 探针）

判定：NewsNow `/api/s?id=` 通且条目为站内帖/话题；影音榜、股价、资讯流标「日更」而非热帖。不接 HTML 刮取、登录墙、纯 App。

### A. 可抓社区热帖/热议（已进或可进白名单）

| 社区 | id | 本机 | 备注 |
| --- | --- | --- | --- |
| 虎扑 | `hupu` | OK · 20 | 步行街帖 · **已白名单** |
| V2EX | `v2ex` | OK · 30 | 话题帖 · **已白名单** |
| 百度贴吧 | `tieba` | OK · 30 | **已白名单** |
| 远景论坛 | `pcbeta` | OK · 20 | **已白名单** |
| 掘金 | `juejin` | OK · 30 | 热文形态 · **已白名单** |
| B站热搜 | `bilibili-hot-search` | OK · 30 | 搜词热 · **已白名单** |

### B. NewsNow 通，但不是社区热帖（勿标热帖）

| 社区 | id | 实际内容 |
| --- | --- | --- |
| 豆瓣 | `douban` | 电影条目榜，不是小组热帖 |
| 少数派 | `sspai` | 最新文章流 |
| 懂球帝 | `dongqiudi` | 足球资讯文 |
| 雪球 | `xueqiu` | 个股行情卡 |
| 酷安 | `coolapk` | 数码动态（已白名单） |

### C′. DailyHotApi 补洞（2026-11-19 探针 · `hot-api.liiiu.cn`）

NewsNow Invalid 的源，改走 DailyHotApi（imsyy）。官方 `api-hot.imsyy.top` 已挂；本机可用第三方镜像，生产请自建并设 `DAILYHOT_BASE_URL`。

| 社区 | DailyHot id | 本机 | 状态 |
| --- | --- | --- | --- |
| 吾爱破解 | `52pojie` | OK · 48 | **已白名单** |
| NodeSeek | `nodeseek` | OK · 20 | **已白名单** |
| 米游社 | `miyoushe` | OK · 30 | **已白名单** |
| AcFun | `acfun` | OK · 30 | **已白名单** |
| 快手热榜 | `kuaishou` | OK · 50 | **已白名单** |
| CSDN | `csdn` | OK · 30 | **已白名单** |
| NGA | `ngabbs` | 全站游戏热帖+置顶垃圾 | **不下**；综合改 HotExtras 网事杂谈向 |
| 豆瓣小组 | `douban-group` | 讨论精选偏日记 | **不下** |
| 简书 | `jianshu` | n=2 + 营销垃圾 | **不下**（probeOnly） |
| HostLoc | `hostloc` | 500 | probeOnly；自建后再开 |
| 酷安 | `coolapk` | 500（本镜像） | 已走 NewsNow |

上线验收（双镜像交叉）：`node tools/_go-live-probe.mjs`  
双镜像都 GO：`ngabbs` `52pojie` `nodeseek` `miyoushe` `douban-group` `csdn`  
仅主镜像 GO（`acfun`/`kuaishou`）：可上，但依赖 `hot-api.liiiu.cn`；换镜像可能挂。

探针：`node tools/fetch-dailyhot.mjs --probe-all`

### C. 暂不可接（Invalid / 无公开热帖 API）

优先点名：

- **即刻**（`jike`/`okjike`）— NewsNow Invalid；网页版受限；DailyHot 无路由
- **小红书** — Invalid（见下 P3）
- **Lofter** — Invalid
- **机核 / 游民 / 3DM / A9VG / 小黑盒** — Invalid（游民亦见 P2）
- **直播吧** — Invalid
- **Chiphell / 恩山** — Invalid；不爬 Discuz
- **Linux.do** — NewsNow Invalid；可试 RSSHub/Discourse RSS（未接）
- **HostLoc** — DailyHot 公共镜像 500；邀请墙
- **S1 / 宽带山 / TapTap / Bangumi** 等 — Invalid

综合清单同类：思否、博客园、什么值得买、大众点评、脉脉、汽车之家等 — 无可用 id 或非热帖；**不新开 HTML 刮取**。

### D. 大众热搜通道（非论坛热帖）

微博 / 知乎 / 抖音 / 百度 / 头条 / 凤凰等 — 见上表「已接入」。

---

## 仍缺 · 需补充

### P1 · 影音榜适配器（听乐/看片扩展）

NewsNow 无对应 id，需专用 rank 适配器或扩 `fetch-rank.mjs`：

- **爱奇艺热播榜**（open2hub/视频 → ent）
- **腾讯视频热搜**（open2hub/视频 → ent）
- **红果短剧红果热播榜**（open2hub/视频 → ent）
- **红果短剧真人剧热播榜**（open2hub/视频 → ent）
- **红果短剧AI剧热播榜**（open2hub/视频 → ent）
- **红果短剧漫剧热播榜**（open2hub/视频 → ent）
- **酷狗音乐酷狗飙升榜**（open2hub/音乐 → ent）
- **网易云音乐飙升榜**（open2hub/音乐 → ent）
- **网易云音乐新歌榜**（open2hub/音乐 → ent）
- **QQ音乐飙升榜**（open2hub/音乐 → ent）
- **QQ音乐新歌榜**（open2hub/音乐 → ent）
- **喜马拉雅热播**（open2hub/阅读 → deep）

### P2 · 无稳定 RSS / NewsNow 未覆盖

- **游民星空·热点资讯排行**（open2hub/游戏）— 无稳定公开 RSS / NewsNow id 未覆盖
- **游民星空热榜**（rebang/娱乐）— 无稳定公开 RSS / NewsNow id 未覆盖

### P3 · NewsNow id 探针失败（源站无效或不存在）

- **小红书阅读榜** 曾试 `xiaohongshu` — 公共实例 Invalid/empty
- **小红书热榜** 曾试 `xiaohongshu` — 公共实例 Invalid/empty
- **豆瓣书影音热榜** 曾试 `douban-movie` — Invalid（小组帖已改走 DailyHot `douban-group`）

额外探针失败的 id（目录未强依赖）：
- `bilibili-hot-video` / `36kr` / `douban-movie` / `xiaohongshu` / `netease-news` / `qq-news` / `weread` / `zq` — Invalid
- `jike` / `okjike` / `gcores` / `gamersky` / `linuxdo` — Invalid
- `kuaishou` / `douban-group` / `csdn` / `nga` / `nodeseek` — NewsNow Invalid，**已由 DailyHot 承接**

### 故意不收

- 体育 / 汽车 / 购物 整频道，以及无通道的 skip 合计 **105** 条。
- Discuz/老论坛页爬、邀请墙社区热帖。

## 建议下一刀

1. 自建 NewsNow + DailyHotApi，分别设 `NEWSNOW_BASE_URL` / `DAILYHOT_BASE_URL`。
2. P1：爱奇艺/腾讯视频/红果/网易云/QQ 音乐/酷狗 — 扩看片听乐适配器。
3. P3：小红书/即刻 — 等有合法 API 再进，不刮页面；HostLoc 自建 DailyHot 后再开。
