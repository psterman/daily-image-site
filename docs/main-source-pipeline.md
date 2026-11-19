# 主源供给：从 RSS 到平台共享池

平台用户登录后，日报栏目里的内容**不是自己抓的**，而是来自平台预配置的主源共享池。本文说明这条供给链路、版权边界和运维方法。

## 1. 数据在哪

`platform` schema 的共享池四张表：

| 表 | 作用 | 谁能写 |
| --- | --- | --- |
| `sources` | 内容源 + 版权授权字段 | 管理端（service_role / PAT） |
| `content_items` | 统一内容对象（标题 + 短摘要 + 原文链接） | 管理端 |
| `content_tags` | 内容 ↔ 标签包的多对多 | 管理端 |
| `tag_packs` | 8 个标签包（用户选它生成栏目） | 管理端 |

**前端只读共享池**。用户平台自己的 `platforms / platform_columns / candidate_entries / issues` 才是用户可写的私有表（RLS 按 `auth.uid()` 隔离）。这条边界是产品的护城河：用户搭自己的栏目秩序，但内容供给由平台统一负责。

## 2. 版权纪律（红线，不能妥协）

从第三方 RSS 抓来的条目默认 `rights_status='unknown'`，只允许存三样东西：

1. **标题**（截断 200 字）
2. **短摘要**（截断 160 字，且只在 `sources.allow_snippet=true` 时保留）
3. **原文链接**（canonical_url）

**明确不做**：不存全文、不转存图片（`image_url` 恒为 null）、不冒充 `authorized`。分发时一律 link_card（标题 + 导读 + 原文链接），把流量还给源站。`rights_complaints` 表用于投诉下架。

这套纪律固化在 `lib/ingest-map.mjs` 的 `toContentItem()` 里，不靠人肉自觉。

## 3. 三层流水线

```
tools/fetch-rss.mjs        抓 RSS（零依赖，正则解析 RSS2.0 / Atom）
  parseFeed / fetchHeadlines  → {title, link, desc, source, ts, categories}
        ↓
lib/ingest-map.mjs         映射 + 版权过滤 + 打标签（浏览器/Node 通用纯函数）
  toContentItem / mapFeedItems → content_items 行 + content_tags 行
        ↓
service_role / PAT         写共享池（前端无权）
  tools/ingest-main-source.ps1  或 Management API database/query
```

**为什么不造轮子**：RSS 抓取/解析/跨源去重/过期闸门已经在 `fetch-rss.mjs` 里打磨过（50+ 源、重试、反爬识别、公平配额），`news-taxonomy.json` 是分类真相源。`ingest-map.mjs` 只补"RSS 条目 → 平台表结构 + 版权过滤 + 标签映射"这一层缺失的桥。

### 分类映射

老见报八分类（`news-taxonomy.json`）与平台 8 标签包不是一套体系，`CATEGORY_TO_TAGS` 是唯一的桥：

| 见报分类 | 平台标签包 | 说明 |
| --- | --- | --- |
| ai | ai | AI 资讯 |
| tools | opensource + tech | 效率工具 |
| dev | opensource | 技术社区 |
| tech | tech | 科技新品 |
| biz | finance | 财经商业 |
| deep | design | 深度阅读 |
| hot / current | （无） | 热榜/时政不进平台自建栏目 |

此外 `KEYWORD_TAGS` 用关键词兜底（标题命中 github/开源/大模型/电影 等追加标签）。映射不到的条目不进平台，避免噪音。

## 4. 运维实操

### 4.1 灌一批真实内容（本机 Node 崩溃时的可行路径）

本机 `powershell -File` 子进程会崩（0xC0000005），且新版 `sb_secret_` key 带来源检测、拒绝非保护环境的 Data API 调用。可行路径是 **PAT + Management API `database/query`**：

```powershell
# 凭证从 .env.local 读；PAT 走 api.supabase.com，不进前端
$pat = (Get-Content .env.local | Where-Object {$_ -like 'SUPABASE_PAT=*'}) -replace 'SUPABASE_PAT=',''
$h = @{ Authorization="Bearer $pat"; 'Content-Type'='application/json' }
$ref = 'efqljinkeatzpobvuouj'

# 每条 SQL 都要带 search_path（独立会话），否则表会误建到 public
$sql = "set search_path to platform, public;
  insert into content_items (source_id, canonical_url, content_hash, ...)
  values (...) on conflict (source_id, content_hash) do nothing;
  insert into content_tags (...) select ... on conflict do nothing;"
Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$ref/database/query" `
  -Headers $h -Method Post -Body (@{query=$sql} | ConvertTo-Json -Compress)
```

`tools/ingest-main-source.ps1` 是这套流程的脚本化版本（在正常环境可直接 `powershell -File` 跑；本机改用内联脚本块执行）。

> **FNV 哈希跨语言一致性**：`content_hash` 用 FNV-1a 32 位，必须与 JS 版逐位一致，否则同一链接会被重复灌入。PowerShell 5.1 把 `0xffffffff` 解析成负 Int32，必须用十进制常量 + UInt64 计算：
> ```powershell
> [uint64]$h=2166136261; [uint64]$p=16777619; [uint64]$m=4294967295
> $h=($h -bxor [uint64][int][char]$ch); $h=($h*$p)-band $m
> ```
> 已用 3 组 URL 对照 JS `contentHash()` 验证一致。

### 4.2 幂等

`content_items` 有 `unique(source_id, content_hash)`，`content_tags` 有复合主键 `(content_item_id, tag_pack_id)`。灌库用 `ON CONFLICT DO NOTHING`，重复跑不会翻倍。去重以归一化 URL 为准（去协议/查询串/尾斜杠），同链接改标题不算新条目。

### 4.3 验证

```
site/ingest-selftest.html      37 项：分类映射 / 关键词 / 版权过滤 / 去重 / 幂等
site/live-content-probe.html    7 项：真实共享池可读 / rights 诚实 / 标签关联 / 前端可按栏目取内容
```

浏览器打开看 `<title>`，如 `INGEST|37/37|ALLPASS`、`LIVECONTENT|7/7|ALLPASS`。

## 5. 前端如何消费

`site/portal-app.mjs` 的 `initCloud()` 用 `loadDb()` 读共享池：

- 池子非空 → `contentSource='real'`，界面数据链路显示"真实主源"，候选池来自真内容；
- 池子为空 → `contentSource='empty'`，云端**不**假灌 DEMO（前端写不进共享池，假候选会 FK 炸）；演示内容只留给离线 `initDemo()`。
- 日常灌库：`npm run platform:ingest`；日更：`npm run platform:daily`。

用户选标签 → `buildCandidates()` 按 `content_tags.tag_pack_id` 把共享池内容分进栏目 → 审稿 → `buildPlatformDigest()`。网页日报与邮件 newsletter 消费同一份 digest，永远一致。

## 6. 下一步（服务端特权操作）

主源供给已通，但完整的每日自动运转还缺 Edge Functions（每天定时抓 + 灌池 + AI 摘要/打分写 `ai_runs` + 群发写 `issue_deliveries`）。这些需要 `service_role`，不能放浏览器。当前做法是管理端手动/半自动灌库。
