# 看片 tab v2 规划：院线电影 + 多平台热门视频

> 2026-11-16 15:15–16:0x · **只做可行性规划，未动任何代码**
> 目标：① 电影板块从「豆瓣 Top250 经典」改成「**正在放映 + 近期即将上映**」；② 视频板块从「B站热门 50 条」改成「**B站 / 油管 / 抖音 / TikTok** 多平台热门聚合」。

---

## 0. 结论先说

**能做，但不是四个平台全上。** 实测结果：

| 板块 | 结论 |
|---|---|
| 正在放映 + 近期即将上映 | ✅ **可做**。猫眼（JSON，含热度/想看/排片）+ 豆瓣 `/coming`（22 部待映）双源互补 |
| B站热门 | ✅ **已在用** |
| 抖音热门 | ✅ **可做**，但它是**热搜词榜**不是热门视频榜，且封面签名 24h 过期 |
| YouTube 热门 | ❌ **未攻克**（RSS 端点本机全挂，innertube 被 400）→ 需走官方 Data API v3 |
| TikTok 热门 | ❌ **未攻克**（所有公开端点都要签名/登录）→ 建议 v1 不做 |

**架构上的好消息**：看片 v2 和追更 v2 **需要同一次前端重构**（多层 chip + `data-tags` includes 匹配），应该合并做，不是两件事。

---

## 1. 电影板块

### 1.1 猫眼（主源，JSON）

`https://api.maoyan.com/mmdb/movie/v5/list/hot.json?ci=1` → 200，21.5 KB

**一次返回 `hot` 12 条 + `movieIds` 92 个 + `total` 92**，且 `hot` 里**已经混着未上映的**：

| 字段 | 含义 | 实测样例 |
|---|---|---|
| `nm` | 片名 | 神探之痕迹 |
| `img` | 封面 | `https://p0.pipi.cn/mediaplus/friday_image_fe/....jpg?imageMogr2/quality/80` |
| `star` | 主演 | 张译,马丽,陈明昊 |
| `sc` | 评分 | 9.6 |
| `wish` | 想看人数 | 217899 |
| `cat` | 类型 | 犯罪 |
| `dur` | 时长 | — |
| `rt` | 上映日期 | 2026-10-01 |
| `showInfo` | 排片 | 今天260家影院放映1455场 |
| `comingTitle` | 档期 | 10月1日 周四 |
| **`globalReleased`** | **是否已上映** | true / **false** |
| `preSale` | 预售中 | 0 / **1** |
| `videourl`/`videoId` | 预告片 | — |

**区分「正在放映 / 即将上映」**：实测 12 条里 `globalReleased=false` 的正好 1 条（饥饿游戏：收获日出，rt=2026-11-20，preSale=1，showInfo=「2026-11-20 本周五上映」）→ 这就是「近期即将上映」的天然信号。

**封面可达性**：`p0.pipi.cn` **裸连 200 image/jpeg、带 Referer 也 200** → 可直出（这是它比豆瓣强的地方）。

⚠️ **但原图 430 KB，列表里只显示 56×56** —— 必须用图床参数裁小。实测（qiniu 系）：

| 参数 | 体积 |
|---|---|
| 原图 `?imageMogr2/quality/80`（API 给的默认） | **430 KB** |
| `?imageMogr2/thumbnail/200x200^/gravity/center/crop/200x200/quality/80` | **39 KB** ✅ |
| `?imageView2/2/w/200` | 65 KB |
| `?imageMogr2/thumbnail/!200x200/quality/80` | 559 KB ❌（不裁剪的写法反而更大，别用） |

**扩量**：`m.maoyan.com/ajax/movieOnInfoList?token=&movieIds=<id,...>` → 200，顶层带 `movieList` → 可用 `hot.json` 返回的 92 个 id 批量补齐「全部在映/待映影片」。

### 1.1b ⭐ 猫眼「即将上映」列表（2026-11-16 15:4x 补挖，比豆瓣强）

**`https://m.maoyan.com/ajax/comingList?token=&ci=1`** → **200，6.4 KB，JSON**

顶层 `{ coming: [...], movieIds: [...] }`，`coming` **10 条**，字段和 `hot.json` **完全一致**（`id` / `nm` / `img` / `star` / `sc` / `wish` / `rt` / `showInfo` / `comingTitle` / `globalReleased` / `preShow`），而且：

- **10/10 条都带 `img` 封面**（豆瓣表格页是 **0 张图**）
- 10 条 `globalReleased` **全是 false** → 天然就是「近期即将上映」
- 首条是「琴弓师」，与豆瓣 `/coming` 首行**同一部** → 两源可对齐去重

**结论**：电影板块改成「**猫眼 hot（正在放映）+ 猫眼 comingList（即将上映，带图）+ 豆瓣 /coming（补量，无图）**」。
实测条数：正在放映 **11**（全带图）· 即将上映 **25**（其中 10 条带图、15 条只有文字占位）。

→ **待你拍板的取舍**：即将上映要么「**只留猫眼 10 条（全有图）**」，要么「**要满 25 条、但 15 条没图**」。

### 1.2 豆瓣「即将上映」（副源，只补量不补图）

- ✅ `https://movie.douban.com/coming` → 200，23.8 KB，标题「即将上映电影」，**22 个 subject 链接**，结构是**表格**（`coming_list` th/td，按日期分组），不是 item 卡片
- ✅ `https://movie.douban.com/cinema/nowplaying` → 200，244 KB（正在热映）
- ❌ `https://movie.douban.com/cinema/coming` → **404**（路径变了，`/coming` 才对）
- ⚠️ **豆瓣图床防盗链** → 封面浏览器直连会 418/403 → 只能走占位框（与现有豆瓣 Top250 同一个坑）
- ⚠️ **补海报的三条路全堵死**（2026-11-16 实测）：
  - `/coming` 页面 HTML 里**只有 1 个 `<img>`**，0 张 doubanio 图 → 表格里根本没有图
  - `movie.douban.com/subject/{id}/` → 跟跳转后 200 但**只有 2951 字节的反爬验证页**，无 `og:image`
  - `movie.douban.com/j/subject_abstract?subject_id={id}` → **200 且是 JSON，但响应里没有 `cover` 字段**（只有 title/url/star/directors/actors/region/types/release_year）

  → **想给「即将上映」配图，只能用猫眼 comingList 的那 10 条**（或另找源，如 TMDB 要 key 且是英文源，不符合「只收中文源」的偏好）。

### 1.3 猫眼系死路

| 端点 | 结果 |
|---|---|
| `mmdb/movie/v5/list/coming.json` | **404** |
| `mmdb/movie/v5/list/coming-soon.json` / `comingsoon.json` / `preview.json` | **404** |
| `piaofang.maoyan.com/dashboard-ajax?orderType=0` | **403** |
| `www.maoyan.com/ajax/coming?ci=1` | **302 循环**（缺 token） |
| `www.maoyan.com/films/box` · `/films/coming-soon` | 重定向循环 |
| `hot.json` 的 `offset` / `start` / `page` / `limit` / `count` / `movieIds` / `area` / `showType` | **全部无效**（永远 12 条、首条不变） |

---

## 2. 视频板块

### 2.1 B站（✅ 已在用）

`https://api.bilibili.com/x/web-interface/popular?ps=50&pn=1` → 200，50 条，直给 `title` / `owner.name` / `pic` / `stat.view` / `bvid`。

### 2.2 抖音（✅ 可做，但有两个坑）

**主源** `https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web&detail_list=1`
→ 200，63 KB，`data.word_list` **47 条**：

| 字段 | 含义 |
|---|---|
| `word` | 热搜词 |
| `hot_value` | 热度值 |
| `position` / `max_rank` | 排名 |
| `video_count` / `article_detail_count` / `discuss_video_count` | 关联内容数 |
| `sentence_id` / `sentence_tag` | 抖音内容 id / 分类 |
| `word_cover.url_list` | 封面（**带签名**） |

**副源（更稳）** `https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/` → 200，**2.8 KB**，50 条精简（`word` / `hot_value` / `label`），**无封面** → 体积小、不会裂图。

**坑 1：这是「热搜词榜」，不是「热门视频榜」。** 每条只有词 + 热度，没有具体视频。

**坑 2：封面必带签名且约 24 小时过期。**
- `p*-sign.douyinpic.com` 带签名 → 200 image/jpeg ✅
- 换任何非签名域名（`p3` / `p11` / `p26.douyinpic.com`）→ **全 403**
- `x-expires=1794834000` → 约 2026-11-17 过期 → **构建期抓的封面次日必裂**
- → 必须靠前端占位兜底（rank tab 已有 `rank-cover-empty` 机制）

### 2.3 YouTube（❌ 未攻克）

| 路径 | 结果 |
|---|---|
| `www.youtube.com/feeds/videos.xml?chart=mostPopular` | **400** |
| `www.youtube.com/feeds/videos.xml?channel_id=…` | **404**（本机网络层） |
| `rss.youtube.com/feeds/videos.xml?chart=mostPopular` | **TLS 断开** |
| `www.youtube.com/feed/trending` | 200，974 KB，含 `ytInitialData` —— 但里面 **0 个 videoId**（trending 改由客户端 XHR 拉，SSR 只剩空态「Try searching to get started」） |
| innertube `browse` / `next`（带 INNERTUBE_API_KEY + CONTEXT + visitorData） | 全 **400**：`FEtrending` → "Request contains an invalid argument"；`FEwhat_to_watch` → "Precondition check failed" |

**正解是走官方 YouTube Data API v3**（`videos?part=snippet,statistics&chart=mostPopular`）—— 但要申请 Google Cloud 项目 + API key，且该 chart 参数需用官方统计专用 chart id。这是**唯一有官方授权口径**的路。

**替代方案**：Invidious / Piped 等第三方实例的 trending API —— 实例经常挂，且是第三方服务，不建议作为站点依赖。

### 2.4 TikTok（❌ 未攻克）

| 路径 | 结果 |
|---|---|
| `www.tiktok.com/api/explore/item_list/`（全参数） | 200 但 **0 字节**（需 `a_bogus` 签名） |
| `ads.tiktok.com/creative/creativecenter/trends?period=7` | 301 → SPA 21 KB，**无任何内嵌 JSON**（无 `__NEXT_DATA__`/`SIGI_STATE`/`__NUXT__`） |
| `ads.tiktok.com/creative_radar_api/v1/popular_trend/hashtag/list` | **code 40101 no permission** |
| `www.tiktok.com/trending` | 301 → `/foryou` 推荐页，SSR 只有零星 `hashtagName`（gta6 / iscoming），**无完整榜** |

TikTok 所有公开端点都要签名或登录。v1 建议**不做**，或降级为「只做 B站 + 抖音」。

---

## 3. 架构：和追更 v2 合并成一次前端重构

改造后看片 tab 的 chip 变成：

```
第一层：全部 │ 电影 │ 视频
  └ 电影 → 正在放映 │ 近期即将上映
  └ 视频 → B站热门 │ 抖音热门 │（油管热门）│（TikTok 热门）
```

追更 v2 的 chip：

```
第一层：全部 │ 频道新更 │ 本地演出
  └ 频道新更 → B站番剧 │ 港剧 │ Netflix │ HBO │ …
  └ 本地演出 → 北京 │ 上海 │ … → 区 + 类型
```

**两者形状一致** → 一次改 `site/app.js` 的 `renderRank()`，改成和 `renderHeadlines()` 一样的双层 chip + `data-tags` 空格分隔 includes 匹配（`app.js:476`），**约 60~100 行**。

数据形状：item 加 `tags: []` 数组，`tag` 保留作显示徽章。

---

## 4. 推荐范围

| 项 | 建议 |
|---|---|
| 电影 = 正在放映 + 即将上映 | ✅ **v1 就做**。猫眼 hot 12 条（正在放映）+ **猫眼 `comingList` 10 条（即将上映，全带图）** + 豆瓣 `/coming` 22 条（补量，无图）。**猫眼封面必须加 `imageMogr2/...crop/200x200` 参数**，否则单张 430 KB |
| B站热门 | ✅ **v1 就做**（已有） |
| 抖音热门 | ✅ **v1 就做**，用精简版 `iesdouyin`（无封面、2.8 KB、不裂图）；想上图再上带签名的完整版 + 前端占位兜底 |
| YouTube 热门 | ⏸ **v2**，走官方 Data API v3（要申请 key）。先不接 |
| TikTok 热门 | ❌ **不做**（签名墙 + 稳定性差 + 无官方无签名的公开源） |

---

## 5. 风险与未验证项

- **豆瓣 `/coming` 的表格结构已抠完**（22 个 subject 链接 + `coming_list` 表格，列 = 上映日期 / 片名链接 / 类型 / 制片国家地区 / 想看人数，**无海报字段**）
- **猫眼 `movieOnInfoList` 的 `movieList[]` 元素结构已验证**（字段 = id/img/nm/star/sc/wish/rt/showInfo/comingTitle/globalReleased/preShow，与 hot.json 一致；**只返回那 12 部热映片，不含待映片** → 待映片走 `comingList`）
- **猫眼图床裁图参数已定**（`imageMogr2/thumbnail/200x200^/gravity/center/crop/200x200/quality/80` → 39 KB）；注意别用 `!200x200` 那种写法（反而涨到 559 KB）
- **「即将上映」要不要为补量牺牲封面**待定：猫眼 10 条全有图 vs 猫眼+豆瓣 25 条（15 条没图）
- **抖音封面 24h 过期** → 必须有前端占位兜底，否则每天早上第一波访问都是裂图
- **猫眼/网易云/QQ/豆瓣都是非公开接口**，同「听乐」那套风险：著作权不侵权，但**爬虫条款与数据权益**是真风险 → 选源优先级仍是「官方开放源 > 非公开接口」
- **YouTube Data API v3 的 `chart=mostPopular`** 需要确认官方统计 chart id（常规 chartId 拿不到热门榜）
- 视频条目的**封面版权**与电影/音乐同理：只是热链，风险等级低但已记录
