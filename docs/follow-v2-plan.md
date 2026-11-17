# 追更 tab v2 规划：频道化 + 演出子标签

> 2026-11-16 11:0x–12:0x · **只做可行性规划，未动任何代码**
> 目标：把「追更」从「通用播出表 + 演出」改成「**频道类**（港剧 / B站番剧 / Netflix / HBO / 迪士尼+ / Hulu …）」，并给「各地演出」加**城市子标签**。

---

## 0. 结论先说

**能做，但有三条岔路必须先定。**

核心发现：**TVmaze 的 `show` 对象里本来就带 `webChannel`（Netflix / Hulu / Disney+ / Peacock / Prime Video / 腾讯 / 优酷…）和 `network`（HBO / CBS / ABC / TVB…）** —— 也就是说「按频道分组」这件事**不需要新数据源**，只需要把现有的 schedule 结果**换一个分组维度**（现在按国家分，改成按频道分），并把国家列表和天数扩开。

代价是**语言结构**：一天 338 个更新的剧里，**中文只有 12 个（3.6%）**，其余是英文 206 / 日文 31 / 俄文 15。这是中文站的结构性约束，必须先拍板。

### 0.1 ⚠️ 2026-11-16 15:4x 修正：上面的源**选错了**，必须用 `/schedule/full`

做本地原型时实测发现，**`schedule?country=&date=` 根本给不出你点名的平台**：

| 端点 | 实测（2026-11-16~18，US/CN/JP/KR/GB × 3 天） |
|---|---|
| `schedule?country=US&date=X` | 一天 **92 条 = 92 部剧**（**按剧去重**，不是集级）· country 不给就默认 US |
| 上述 5 国 × 3 天合计 | **Netflix=0 · HBO/HBO Max=0 · Prime Video=0 · Disney+=1 · Hulu=7 · Peacock=6** |
| `schedule?date=X`（不带 country） | 同样默认 US → 全量也只有 42 个频道，Netflix 仍是 0 |
| **`schedule/full?date=X`** | 一天 **5836 条 / 1247 部剧 / 105 个 webChannel** · 11.7 MB · **忽略 country**（全球平台一次拿全） |

`/schedule/full` 按剧去重后的 webChannel 分布（3 天合计 1247 部剧里 389 部带 webChannel）：

```
Netflix=33  Prime Video=22  YouTube=20  腾讯视频(Tencent QQ)=18  爱奇艺(iQIYI)=18
BBC iPlayer=18  Paramount+=14  HBO Max=13  Hulu=13  NRK TV=12  Peacock=12
迪士尼+(Disney+)=11  Apple TV=11  优酷(Youku)=9  GagaOOLala=6  Okko=6  哔哩哔哩(Bilibili)=4  …
```

**按精确 airdate 过滤后**（`date=` 是**窗口起点**不是「精确一天」，返回的 airdates 横跨 date-1 ~ date+11，必须自己按 `e.airdate === 目标日` 过滤）：

| 日期 | 集数 | 去重剧 | webChannel 种数 | 当天出现的点名平台 |
|---|---|---|---|---|
| 2026-11-16 | 280 | 247 | 36 | 腾讯=5 优酷=2 爱奇艺=2 Disney+=0 Hulu=2 Peacock=3 |
| 2026-11-17 | 267 | 248 | 31 | 腾讯=8 优酷=3 爱奇艺=3 Disney+=2 Hulu=4 Peacock=3 |
| 2026-11-18 | 282 | 261 | 41 | **Netflix=5 · HBO Max=2 · Disney+=3 · Paramount+=3 · Apple TV=2** 腾讯=4 优酷=3 Hulu=4 Peacock=2 |

→ **结论修正**：v2 的频道源必须换成 `/schedule/full`（集级、全球、带 webChannel），请求数反而更少（**1 次**就能覆盖 3 天，因为它是窗口）。「按频道分组不需要新接口」这句仍然成立，但**接口路径要换**。

### 0.2 ⚠️ 同城演出的封面**不能热链豆瓣**（418）

实测 `img3.doubanio.com`：带 `Referer: https://www.douban.com/` → **200**（32 KB）；**不带 Referer（给不给 UA 都一样）→ 418**（14 字节）。

浏览器里 `<img>` 带的是**我们自己站点的 referer** → 必然裂图（原型第一版就是全空白框）。**生产环境同理：豆瓣封面必须自己存**（下载后存 R2，走 Pages Function 代理），不能外链豆瓣。原型里已经这么做了（下载 140 张到 `./covers/`），12 城 + 港剧共 140 张全部成功、0 失败。

---

## 1. 实测可行性表（全部实测，不是查文档）

### 1.1 频道类源

| 源 | 状态 | 能拿到 | 拿不到 / 坑 |
|---|---|---|---|
| **TVmaze `schedule/full?date=`** | ✅ 200 | **集级**：一天 5836 条 / 1247 部剧 / 105 个 webChannel，**忽略 country**（全球平台一次拿全）· 内嵌 `show` 带 `webChannel`/`network`/`image` | 11.7 MB / 次 · `date=` 是**窗口起点**不是精确一天 → 必须自己按 `airdate` 过滤 · 见 §0.1 |
| **TVmaze `schedule?country=&date=`** | ✅ 200 | episode + 内嵌 `show`（含 `webChannel` / `network` / `image` / `officialSite` / `type`） | **按剧去重**（一天 92 条 = 92 部剧）· country 不给默认 US → **Netflix/HBO/Prime Video 全是 0**（见 §0.1）· HK/TW/SG 一天 0 条 |
| **TVmaze `/updates/shows?since=day`** | ✅ 200 | 338 个 show id（当天元数据有变动的剧） | 是「元数据更新」不完全等于「新一集」 |
| **TVmaze `/shows/{id}/episodes`** | ✅ 200 | 该剧全部集（季/集号/标题/airdate） | 已完结剧仍在列（如使徒行者停在 2020） |
| **B站番剧 `pgc/web/timeline?types=1&day=3`** | ✅ code=0 | 7 天 23 集，**直给** `cover` / `square` / `pub_index` / `pub_time` / `title` | 一天只有 23 集，量偏少；`day` 参数不生效（day=1 与 day=3 同结果） |
| **JustWatch GraphQL**（POST，`X-Client-Id: justwatch`） | ⚠️ 半通 | `newTitles(country:)` ✅ · `offers` ✅（直接给 `package.technicalName` + `monetizationType`）· `packages` ✅（HK 42 家 / US 351 家 / **CN 仅 5 家=空的**） | **`package` 过滤参数不生效**（netflix/disneyplus/iqiyi 返回同一批 id）· **`Title` 只有 `id`/`objectType`，标题与封面字段没摸到** · `searchTitles` 任意 source 返回空 · content API 404 → **暂不能作主源** |
| **Netflix Tudum Top10** | ❌ | — | `/tudum/top10/data/tudum-top10-global-tv` 及带 week 参数版本**均 404** |
| **豆瓣「港剧」标签** `movie.douban.com/j/search_subjects?type=tv&tag=港剧` | ✅ 200 | 20 条/页，直给 `title` / `cover` / `url` / `rate` | **豆瓣图床防盗链** → 封面只能走占位框（与现有豆瓣 Top250 同样的坑）；排序是否按「最新」待确认 |

### 1.2 演出源（子标签城市）

**豆瓣同城比预期好用 —— 城市子标签是现成的。**

| 发现 | 实测 |
|---|---|
| 城市页重定向 | `www.douban.com/location/<slug>/events` → `https://<city>.douban.com/events/week-all`（或留在 `www.douban.com/location/<slug>/events/week-all`） |
| **区级子链接** | `https://<city>.douban.com/events/week-all-<区id>` → **12 城全部有**，区数 9~37 个（京 16 / 沪 16 / 渝 37 / 蓉 20 / 穗 11 / 苏 9 …） |
| **类型分类** | `week-music` 音乐 · `week-comedy` 喜剧 · `week-drama` 戏剧 · `week-salon` 讲座 · `week-party` 聚会 · `week-film` 电影 · `week-exhibition` 展览 · `week-sports` 运动 · `week-commonweal` 公益 · `week-travel` 旅行 · `week-competition` 赛事 · `week-course` 课程 · `week-kids` 亲子 · `week-others` 其他 · `week-all` 全部 |
| **区级信息本来就抓到了但被丢掉** | 条目 `<li title="城市 行政区 场馆 地址">` 里已含行政区；现有 `splitVenueAddress()` 里 `DISTRICT_RE` 匹配后**直接 slice 掉了** → 改成保留即可 |

### 1.3 死路清单（实测，别再试）

| 端点 | 结果 |
|---|---|
| TVmaze `/networks`（列表） | **404** `Invalid Route`（`/networks/{id}` 单个仍 200） |
| TVmaze `/web-channels` | **404** |
| TVmaze `/schedule/web/{id}` | **404** |
| TVmaze `/networks/{id}/shows` | **404** |
| TVmaze `/shows?network=241` | **过滤被忽略** —— 返回的是第 0 页（240 部，Under the Dome…），不是 TVB 的剧 |
| TVmaze `schedule?country=HK / TW / SG` | 一天 **0 条** |
| Netflix Tudum / shakti API | 404 |
| JustWatch `content/titles/{id}`（含 IMDb id 与 JustWatch 自有 id） | 404 |
| RSSHub 公共实例（rsshub.app / rssforever / pseudoyu / slarker） | 全 403；本机无 Docker，只能自建 |
| 知乎 RSS | 0 字节（已失效） |
| YouTube 官方频道 RSS | 本机直连 404（网络层） |
| MyDramaList `/release/?type=drama` | 500；`/search?q=` 200（结构待挖） |
| TVB 官方 `programme.tvb.com` | 200 但是 SPA（2911 B），背后 API 待挖 |

---

## 2. 三条必须你拍板的岔路

### 岔路 A —— 频道内容要不要收英文

TVmaze 一天 338 个更新的剧的完整语言分布（实测）：

```
English 206 · Japanese 31 · Russian 15 · Spanish 14 · Dutch 13
Chinese 12 (3.6%) · Korean 5 · Norwegian 7 · Thai 6 · 其他 20
```

而你此前定过「**RSS 源只收中文，不要英文**」。但这次点名的 Netflix / HBO / Disney+ / Hulu **本身就是英文内容平台** —— 这两条偏好在这里正面冲突，必须你定。

### 岔路 B —— chip 的层级

现在是**扁平单层**（剧集更新 + 12 城混在一行）。要做到「美团式多城市 + 区级子标签」，得决定是两层还是三层。

### 岔路 C —— 港剧走哪条线

TVmaze **有** TVB：network id=**241**（country HK）、myTV SUPER webChannel id=**262**，例：使徒行者 id=32664。但 TVB 剧在 `schedule`/`updates` 里**当天 0 条**（旧剧已完结）。而且 TVmaze **没有按 network 过滤的可用接口**（§1.3），要枚举 TVB 的剧只能全量扫 300 页。

---

## 3. 推荐架构（若三条都按「推荐」拍板）

### 3.1 数据形状

追更 item 在现有 `{rank,title,subtitle,meta,cover,link,source,tag}` 基础上**加 `tags: []`**（沿用见报的约定）：

- `tag` = 显示在徽章上的那个（保持兼容）
- `tags` = 全部归属（`tag` 数组），过滤用

演出条目：`tags = ['武汉', '江汉区', '音乐']`（城市 / 区 / 类型）
频道条目：`tags = ['Netflix', '国际平台']`

### 3.2 抓取（每天，构建期）

| 板块 | 源 | 请求量 | 产出 |
|---|---|---|---|
| 频道新更 | TVmaze `schedule/full?date=` | **1 次**（窗口自带 3 天） | 集级 → 按 `airdate` 精确过滤 → 按 webChannel/network 分组（**全球平台一次拿全**，见 §0.1） |
| 频道新更 | B站番剧 `pgc/web/timeline?types=1&day=3` | 1 次 | 23 集，中文 |
| 频道新更 | 豆瓣「港剧」标签 | 1 次 | 20 条，中文 |
| 本地演出 | 豆瓣同城 12 城 | 12 次 | 每城 ~10 条 |
| 本地演出 | 豆瓣同城区级/类型（可选，按需再抓） | 0~N 次 | 区 / 类型子标签 |

**关键效率点**：schedule 的 episode 里 **已经内嵌完整 `show` 对象**（含 `webChannel`/`network`/`image`）→ 不用为频道维度额外请求任何接口。**换成 `/schedule/full` 后请求数反而从 49 次降到 1 次**（它是窗口，一次覆盖 3 天）。

⚠️ **封面要自己存**：豆瓣同城/港剧的图床对「不带 Referer」的请求一律 418（§0.2）→ 封面必须下载后存 R2，不能热链豆瓣。原型实测 140 张全部下载成功。

### 3.3 chip 三层（美团式）

```
第一层：全部 │ 频道新更 │ 本地演出
  └ 第二层（频道新更）：B站番剧 │ 港剧 │ Netflix │ HBO │ Disney+ │ Hulu │ 腾讯 │ 优酷 │ …
       └（频道名从数据统计出来，不写死 —— 与见报「源名从条目统计」同一套路）
  └ 第二层（本地演出）：北京 │ 上海 │ 广州 │ 深圳 │ 杭州 │ 成都 │ 武汉 │ 南京 │ 重庆 │ 西安 │ 苏州 │ 天津
       └ 第三层（选了某城）：该城的区（9~37 个） + 类型（15 个）
```

### 3.4 前端改动点（**这是本轮唯一的硬改动**）

`site/app.js` 的 `renderRank()`（追更走的路径）现在是**单层 chip + 单标签等值匹配**：

```js
// app.js:978
var hitTag = !curTag || (el.getAttribute('data-tag') || '') === curTag;
```

而见报走的 `renderHeadlines()` 已经是**双层 chip + `data-tags` 空格分隔 includes 匹配**：

```js
// app.js:476-477
var ts = (lis[k].getAttribute('data-tags') || '').split(/\s+/);
var hitTag = !curTag || ts.indexOf(curTag) >= 0;
```

→ 追要支持「城市 + 区 + 类型」多标签，**必须把 `renderRank` 改成 `renderHeadlines` 那套双层 + includes 匹配**。不是零改动，是一处真实重构（约 60~100 行）。

### 3.5 构建期成本

- 新增请求：**~15 次/天**（TVmaze `/schedule/full` 只要 **1 次**（11.7 MB）· B站番剧 1 · 豆瓣港剧 1 · 豆瓣同城 12 城 + 12 城封面下载）vs 现有 TVmaze 5 国 × 2 天 = 10 次
- 新增体积：追更 manifest 从 ~78 KB → 预估 150~250 KB（条目数从 174 → 334）
- **Cloudflare 消耗不变**：仍是构建期抓、运行时零请求；但**豆瓣封面要自己存 R2**（不是热链），R2 多 ~140 张/天的小图（实测 3.76 MB）
- **构建期内存/带宽要抬一档**：`/schedule/full` 单次 11.7 MB（原型实测 2.7 s 拉完）

---

## 4. 工作量拆分

| # | 内容 | 预估 |
|---|---|---|
| 1 | `tools/fetch-follow.mjs` 重构：TVmaze **`/schedule/full` + airdate 精确过滤** + 按 webChannel/network 分组 + 豆瓣封面本地化（下载存 R2）+ B站番剧源 + 豆瓣港剧源 + 演出加区/类型 | 大 |
| 2 | item 加 `tags` 数组 + build.mjs 追更块改造（chips 从数据来，三层） | 中 |
| 3 | `site/app.js` `renderRank` 改双层 chip + includes 匹配 | 中 |
| 4 | 护栏：`test-fetch-follow` 重写 + `test-rank-tab` 加三层 chip 断言 + 变异测试 | 大 |
| 5 | 文档：AGENTS.md / CHANGELOG.md / SDD Task 43 | 小 |

---

## 5. 风险与未验证项

- **JustWatch 的标题/封面字段仍未摸到** → 已排除在 v1 之外；若后续挖到，可作「平台上新」视角的第二数据源
- **豆瓣港剧标签的排序**未验证是否按最新（`sort=time` 参数没确认生效）→ 若不生效，港剧板块会变成「热门」而非「追新」
- **TVmaze 全量扫 300 页**（约 90 MB / 300 请求）只在需要枚举 TVB 时才做，建议做成**低频缓存**而非每次构建
- **TVmaze `updates` 的 338 是「元数据更新」**，「有新集」的比例未单独统计 → v1 以 `schedule` 为准（schedule 是播出表，语义准确）
- 英文内容占比高（96.4%）若不可接受，只能靠「按平台筛中文平台」收窄，但那会砍掉你点名的 Netflix/HBO/Disney+/Hulu
