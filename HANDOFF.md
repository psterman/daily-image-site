# 交接文档：用户自建信息平台（"我的头条"）

> 本文写给接手的 AI / 开发者。目标：不看历史对话也能继续推进。
> 项目路径：`E:\voice-pilot\daily-image-site-open\`（基于开源项目 psterman/daily-image-site 改造）
> 最后更新：2026-11-18

---

## 0. 一句话定位

让每个用户搭一个**属于自己的信息平台**：选标签包 → 自动生成固定栏目 → 每天从平台主源收到候选内容 → 审稿台人工/AI 审核 → 生成 digest → 分发到邮件 / Telegram / 群机器人 / 公开页。

**护城河是"用户搭自己的平台"，不是做又一个中心化今日头条。**

## 1. 产品原则（用户多次纠正后定型，不可跑偏）

1. **用户自建平台是核心**。注册只是账号入口；内容宇宙、栏目秩序、审稿台、分发渠道、内容资产都归用户。这是与热榜/今日头条的本质区别。
2. **用户不配信息源，只做选择**。平台预配置好标签包（8 个）和主源；用户点选类型（如搞笑类、人像美学类），系统每天自动供给候选。
3. **审稿台是关键流程**：AI 负责抓取、初筛、打分、摘要；发布动作保留人工确认（human-in-the-loop），所有 AI 操作写 `ai_runs` 可审计。
4. **版权是红线**：第三方内容只存"标题 + 160 字内短摘要 + 原文链接"；不存全文、不转存图片、`rights_status` 诚实标记 `unknown`；分发一律 link_card 把流量还给源站；投诉走 `rights_complaints` 下架。
5. **不造轮子**：RSS 抓取/解析/去重用项目已有 `tools/fetch-rss.mjs`；分类用 `tools/news-taxonomy.json`；借鉴 Ghost / beehiiv / follow.it / BestBlogs 的成熟模式，不自研抓取与发送引擎。
6. 微信分享注意：pages.dev 境外域名有偶发拦截风险，分享用"当天页面链接"、不用短链、内容干净。

### 产品流程（用户视角）

```
登录/注册 → 一键导入类目标签 → 点标签看预览 → 选定组合建平台
每天 00:00：主源入库（抓取/去重/打标/打分）→ 按用户标签生成个人候选池
→ 审稿（AI 自动 或 人工筛选/排序/置顶）→ 生成当日页 + digest
→ 分发：指定邮箱 / Telegram / RSS / 分享链接
```

## 2. 当前完成状态

### ✅ 已完成（全部经过真实验证）

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| 数据模型 | ✅ | 23 张表（`db/schema.sql`），已部署到 Supabase **`platform` schema**（23 表 + 8 标签包 + 1 主源 + 25 条 RLS 策略） |
| 第一阶段闭环 | ✅ | `lib/platform-model.mjs` + `lib/platform-flow.mjs` 纯函数六步：registerUser → createPlatform → ingestContent（版权过滤）→ buildCandidates（打分/去重/分栏）→ reviewCandidates → publishIssue（issue + digest schema 2） |
| Supabase 数据层 | ✅ | `lib/sb-client.mjs`（零依赖 REST/Auth 客户端，支持 `schema: 'platform'` 自动带 Accept-Profile/Content-Profile）；`lib/sb-repo.mjs`（loadDb/saveDb/runRemotePipeline；saveDb 只写私有表不写共享池） |
| 前端工作台 | ✅ | `site/portal.html` 登录优先双模式：未登录显示登录/注册卡；登录后进云模式（真 Supabase）；可"进入演示模式"离线体验。含标签市场、栏目排序、审稿台、日报预览 |
| 登录/会话 | ✅ | `site/auth-ui.mjs`（login/signup/recover/reset、错误中文化、refresh）+ `site/config.js`（只放公开配置）。会话 localStorage 持久化，过期自动 refresh。真注册/登录已实测 |
| 主源供给 | ✅ | `lib/ingest-map.mjs` + `tools/ingest-platform.mjs`（Node，走 service_role）+ `tools/ingest-main-source.ps1`；共享池已灌 **44 条**（ai/opensource/tech/design/finance/portrait；funny/movie 仍空，靠关键词） |
| 日更编排 | ✅ | `tools/daily-platform-run.mjs`：可选灌池 → 全平台 `buildCandidates` → `auto_trusted` 才自动审 → `saveDb`；不自动 publish（人审红线） |
| Auth 生产预备 | 🟡 | `site_url` 已指 pages.dev；`uri_allow_list` 含本地 8765/8791 + pages.dev；**`mailer_autoconfirm` 仍 true**（上线前再关）。脚本：`tools/auth-prod-prep.mjs` |
| Cloudflare Pages | ❌ | `daily-image-site/.env.local` 的 CF token 已 401 过期，部署阻塞待新 token |
| 分发层（老架构复用） | ✅ | `tools/build-digest.mjs`（统一推送稿 digest.json 唯一真源）、`tools/render-email.mjs`（分类订阅+固定栏目预览条）、`tools/send-newsletter.mjs`（Resend + 幂等 + 100 封/天限额）、`tools/render-groupbot.mjs` + `send-groupbot.mjs`（企业微信/钉钉/飞书） |
| 渲染内核 | ✅ | `site/portal-render.mjs`（借鉴线上原版：单一真源、tabs/hash 路由、safeHref 防 XSS、三种 tab 类型 text/rank/media） |
| 静态护栏 | ✅ | `tools/check-supabase.mjs` 的 checkIngest() 锁死版权红线；`tools/check-data-model.mjs`、`tools/test-platform-flow.mjs`；浏览器自检页仍是回归基线 |

### 验证体系（本机全绿，可作为回归基线）

浏览器自检页（`<title>` 回传结果），经本地静态服务器（PowerShell HttpListener 端口 8765/8791，`.mjs` 必须给 `text/javascript` MIME）打开：

| 自检页 | 结果 | 覆盖 |
| --- | --- | --- |
| `site/portal-auth-selftest.html?mode=login` | 32/32 | 登录/注册/找回/refresh、云模式闭环、写回 header、退出 |
| `site/portal-auth-selftest.html?mode=restore` | 7/7 | 过期会话自动 refresh 恢复 |
| `site/portal-live-probe.html` | 4/4 | 真库共享池可读、RLS 拦私有表、Auth 在线 |
| `site/ingest-selftest.html` | 37/37 | 分类映射、关键词、版权过滤、去重、幂等 |
| `site/live-content-probe.html` | 7/7 | 真实内容可读、rights 诚实、标签关联 |
| `site/live-repo-probe.html` | 8/8 | 端到端 loadDb→buildCandidates→审稿→digest |
| `lib/sb-selftest.html` | 29/29 | mock 全链路（含 audit actor 过滤 / 孤儿候选过滤） |
| `lib/sb-static-selftest.html` | 27/27 | 静态契约 |
| 浏览器真注册 `site/portal.html` | ✅ | 云端：真实主源、候选池、无 audit/FK 报错（2026-11-18） |
| `npm run platform:ingest` / `platform:daily` | ✅ | Node 灌池 + 日更（service_role 已 GRANT `platform` schema） |

## 3. 架构与关键决策

### 3.1 双云分工

- **Supabase = 控制面**：Auth + PostgREST + RLS + 业务数据真源。项目 `onetone-daily`（ref `efqljinkeatzpobvuouj`），us-east-2。
- **Cloudflare = 发布面**：Pages 静态站 + R2（图片/digest 快照）。还没开始接。

### 3.2 独立 `platform` schema（重要背景）

该项目 Supabase 里**已有一套 onetone 自己的 public 表**（profiles/follows/likes/timeline 等 12 张），且 `follows` 与我们模型同名但结构不同。为避免污染，我们的 23 张表全部建在 **`platform` schema**（用 `supabase/install-to-platform-schema.sql`）。

浏览器/客户端访问自定义 schema 的方式：**不是 URL 前缀，是请求头**：

```js
createClient({ url, key, schema: 'platform' })
// 自动加 Accept-Profile: platform（读）+ Content-Profile: platform（写）
```

PostgREST 已 patch 暴露：`db_schema = "public,graphql_public,platform"`（Management API 的 PATCH /v1/projects/{ref}/postgrest，改完必须 POST /restart，单独 NOTIFY 无效）。

### 3.3 读写边界（RLS 核心设计）

| 表 | 谁能写 | 说明 |
| --- | --- | --- |
| `tag_packs` / `sources` / `content_items` / `content_tags` | 仅管理端（service_role / PAT） | 共享池，前端只读 |
| `users`(本人) / `platforms` / `platform_columns` / `candidate_entries` / `issues` / `issue_items` / `audit_logs` | 登录用户 | RLS 按 `auth.uid()` = `platform.users.id` 隔离 |
| `issues`(published 且平台 public) | — | 匿名可读（公开页用） |

Supabase Auth 新用户由触发器 `handle_new_auth_user()` 自动建 `platform.users` 行（id=auth.uid()）。

### 3.4 三把钥匙（用途绝对不能混）

| Key | 值前缀 | 用途 | 能否进前端 |
| --- | --- | --- | --- |
| publishable | `sb_publishable_` | Data API，受 RLS | ✅ 已在 `site/config.js` |
| secret（service_role） | `sb_secret_` | 绕 RLS 写共享池 | ❌ 且**新版已被 Supabase 来源检测拦截，Data API 调用一律报 Forbidden use of secret API key in browser**（见 §5 坑 2） |
| PAT | `sbp_` | Management API（api.supabase.com），可执行 SQL/改配置/重启 | ❌ 绝不 |

真实值都在 `.env.local`（已被 .gitignore 忽略）。**⚠️ PAT 和 secret 曾出现在对话中，建议用户尽快在 Supabase 后台轮换。**

### 3.5 lib 纪律（为什么这么拆）

`lib/` 下所有模块**零 `node:*` 依赖**，浏览器可直接 `import`。原因：产品方向是"用户登录网页就能搭平台"，且本机环境只能用浏览器验证（见 §5）。落盘/CLI 在 `tools/` 单独做。

### 3.6 digest 是唯一真源

`buildPlatformDigest()` 产出 schema 2 digest（tabs/tabKeys/counts/summary），网页（portal-render）、邮件（render-email）、群机器人（render-groupbot）消费同一份 → 三端永远一致。老六栏 digest 是 schema 1，`allowedTabs(digest)` 已做兼容。

### 3.7 分类映射（两套体系）

老见报八分类（`news-taxonomy.json`：hot/current/biz/tech/ai/tools/dev/deep）≠ 平台 8 标签包（funny/portrait/opensource/ai/design/finance/tech/movie）。唯一桥接在 `lib/ingest-map.mjs` 的 `CATEGORY_TO_TAGS`：

- ai→ai；tools→opensource+tech；dev→opensource；tech→tech；biz→finance；deep→design
- **hot/current 故意映射为空**（热榜/时政不进平台自建栏目——聚合流量与自建定位冲突，且时政有风险）
- `KEYWORD_TAGS` 关键词兜底（github/大模型/电影/人像等）
- 映射不到的条目不进平台（宁缺毋滥）

## 4. 文件地图

```
db/schema.sql                 23 张表定义
db/seed-core.sql              8 标签包 + 主源编辑池
supabase/migration.sql        Auth 触发器 + RLS（public 版）
supabase/install-to-platform-schema.sql  实际部署用的 platform schema 版
lib/platform-model.mjs        纯数据原语（newId/contentHash/emptyDb/seedTagPacks/ensureMainSource/audit）
lib/platform-flow.mjs         六步业务纯函数 + setPlatformTagPacks/reorderColumns/runPipeline
lib/ingest-map.mjs            RSS→共享池映射（版权纪律固化：MAX_SUMMARY=160、image_url 恒 null、rights 默认 unknown）
lib/sb-client.mjs             零依赖 Supabase REST/Auth 客户端
lib/sb-repo.mjs               内存 db ↔ Supabase 桥接
site/config.js                前端公开配置（URL/publishable key/schema/siteUrl）
site/auth-ui.mjs              登录注册 UI + 会话管理
site/portal.html/.css         工作台页面骨架 + 样式
site/portal-app.mjs           双模式控制器（demo/cloud；contentSource 标记真实/演示）
site/portal-render.mjs        日报渲染内核
site/*-selftest.html          浏览器自检页（回归基线，别删）
tools/fetch-rss.mjs           成熟 RSS 抓取器（抓/解析/去重/重试/公平配额）——复用它，别重写
tools/news-taxonomy.mjs/.json 老见报分类体系
tools/ingest-main-source.ps1  单 feed 灌库（PowerShell）
tools/ingest-platform.mjs     多源灌库（Node，推荐）：npm run platform:ingest
tools/daily-platform-run.mjs  日更：灌池+全平台候选：npm run platform:daily
tools/auth-prod-prep.mjs      Auth site_url / allow_list 预备
tools/build-digest.mjs        digest 生成（老架构）
tools/render-email.mjs / send-newsletter.mjs    邮件链路
tools/render-groupbot.mjs / send-groupbot.mjs   群机器人链路
tools/check-supabase.mjs      静态护栏（含 checkIngest 版权红线）
docs/data-model.md            数据模型
docs/platform-pipeline.md     第一阶段闭环
docs/supabase-setup.md        后端接入 + 前端登录 + 踩坑
docs/main-source-pipeline.md  主源供给（本文档的详细版）
docs/newsletter-setup.md      邮件/群机器人
```

## 5. 环境坑（接手前必读，每条都是真实踩过的）

原开发机（Windows，PowerShell 5.1）存在系统性问题：

1. **Node/Python/git/任何子进程全部崩溃**（Exit -1073741819 / 0xC0000005 STATUS_ACCESS_VIOLATION，包括 `powershell -File xxx.ps1` 启动子进程、`[scriptblock]::Create` 注入含中文注释的整文件）。**可行路径**：文件读写用工具；JS 逻辑验证用浏览器加载真实 ES module（PowerShell `HttpListener` 起静态服务器）+ 断言结果写 `document.title` 回传；HTTP 用 PowerShell 内联 `Invoke-WebRequest`/`Invoke-RestMethod`（直接写在命令里，不启子进程）。
2. **新版 `sb_secret_` key**：浏览器侧会报 Forbidden；**Node/服务端**可用，但必须先 `GRANT USAGE ON SCHEMA platform TO service_role`（以及表级 ALL），否则 PostgREST 报 `permission denied for schema platform`。Management API（PAT）仍用于改 Auth/跑 DDL。
3. **Management API 每条 SQL 必须前置 `set search_path to platform, public;`**（每条请求是独立会话，否则表/数据会误落 public——曾因此把 23 张表误建到 public，已清理恢复）。单请求 SQL >20KB 报 400，需按语句拆分逐条发。
4. **PowerShell 5.1 把 `0xffffffff`/`0x811c9dc5` 解析为负 Int32**，位运算错乱。FNV-1a 哈希（content_hash 的基础，必须与 JS `platform-model.contentHash()` 逐位一致，否则同链接重复入库）在 PowerShell 里的正确写法：十进制常量 + UInt64 全程：`[uint64]$h=2166136261;[uint64]$p=16777619;[uint64]$m=4294967295; $h=($h -bxor [uint64][int][char]$ch); $h=($h*$p)-band $m`。已用 3 组 URL 对照 JS 验证一致。
5. **sb-client 的 `auth.user()` 读内部 `sessionToken`**，`getToken` 只用于数据请求 Bearer。恢复会话必须 `client.auth.setToken(token)`，否则刷新后被误判未登录（曾引发真实 bug，已修，见 portal-app.mjs ensureClient 注释）。
6. **Supabase Auth**：当前开发态 `mailer_autoconfirm=true`（已实测注册登录）。上线前应改回 `false` 并走真实邮箱确认；前端 `authError()` 已翻译 "email not confirmed"。
7. **浏览器 fetch 国内 RSS 会被 CORS 拦**；抓 RSS 用 PowerShell `Invoke-WebRequest`（本机）或 Node `fetch-rss.mjs`（正常环境）。
8. **PostgREST 自定义 schema 用 `Accept-Profile: platform` 头**，不是 URL 前缀；`/rest/v1/platform.tag_packs` 这种写法是错的。
9. PowerShell `Invoke-WebRequest` 的 URL 里 `select=*` 会被解析异常，用明确列名 `?select=id&limit=3`。
10. PowerShell 命令行传中文比较字符串会因编码失败（如按源名 '主源编辑池' 过滤）；改用英文/枚举字段过滤（如 `rights_status=authorized`）。

**如果接手的是正常环境**（能跑 Node）：直接 `npm run test`（run-all-tests）、`npm run platform:test`、`npm run sb:check`、`npm run db:check` 验证；上面 1/10 大部分坑可以无视，2/3/4/5/6/8 仍然有效。

## 6. 未完成任务（按优先级）

1. **主源补洞**：`funny` / `movie` 仍几乎空。可加专用 RSS，或扩 `KEYWORD_TAGS` / 源级 `tagKeys`；日常重跑 `npm run platform:ingest`。
2. **定时挂上机器**：`npm run platform:daily` 已可手工跑；下一步用 Windows 任务计划 / GitHub Actions / Edge Function + pg_cron 每天 00:00 调。仍缺：写 `ai_runs`、自动 `publishIssue`（仅 `auto_trusted`）、`issue_deliveries` 群发。
3. **Telegram 适配器**：`tools/render-telegram.mjs` + `tools/send-telegram.mjs`，模式照抄 send-groupbot（业务码校验、dry-run、不自动重试）。Bot API: `https://api.telegram.org/bot<token>/sendMessage`，parse_mode=HTML。
4. **公开页与增长闭环**：`/p/<slug>/<date>/` 或 `site/p.html?slug=&date=` 读已发布 issue；平台目录、三层关注、`reader_events`、`platform.follows`。
5. **广告与合规**：`ad_slots/ad_creatives/ad_placements/ad_events`、`rights_complaints` 下架流程。
6. **前端部署**：刷新 Cloudflare API token 后，把 `site/` + `lib/` 发到 Pages（`siteUrl` 已是 `https://efqljinkeatzpobvuouj.pages.dev`）。当前 token `cfoat_` 401。
7. **Auth 上线收尾**：关 `mailer_autoconfirm`；用真实邮箱走确认/找回；轮换已暴露 PAT/secret。
8. **安全收尾**：删 `site/hash-probe.html`、`site/ingest-guard-probe.html` 等一次性探针。

## 7. 快速上手

### 正常环境

```bash
npm run test              # 全部护栏测试
npm run platform:test     # 第一阶段闭环
npm run platform:ingest   # RSS → 共享池（每标签配额）
npm run platform:daily    # 灌池 + 全平台 buildCandidates
npm run sb:check          # Supabase 静态护栏（含版权红线）
npm run db:check          # 数据模型护栏
```

### 本机（子进程崩溃环境）验证

PowerShell 起静态服务器（保存为 .ps1 后台跑，或直接在会话内联）：

```powershell
$root='E:\voice-pilot\daily-image-site-open'
$l=[Net.HttpListener]::new(); $l.Prefixes.Add('http://127.0.0.1:8765/'); $l.Start()
while($l.IsListening){
  $c=$l.GetContext(); $p=$c.Request.Url.AbsolutePath.TrimStart('/')
  if(-not $p){$p='site/portal.html'}
  elseif($p -notlike 'site/*' -and $p -notlike 'lib/*'){$p='site/'+$p}
  $f=Join-Path $root ($p -replace '/','\')
  if(Test-Path $f -PathType Leaf){
    $mime=switch -Regex ($f){'\.mjs$|\.js$'{'text/javascript; charset=utf-8'}'\.css$'{'text/css; charset=utf-8'}'\.html$'{'text/html; charset=utf-8'}default{'application/octet-stream'}}
    $c.Response.ContentType=$mime
    $b=[IO.File]::ReadAllBytes($f); $c.Response.ContentLength64=$b.Length
    $c.Response.OutputStream.Write($b,0,$b.Length)
  } else { $c.Response.StatusCode=404 }
  $c.Response.Close()
}
```

浏览器打开 `http://127.0.0.1:8765/`（工作台）或各自检页，看 `<title>`（如 `AUTHSELF|24/24|...ALLPASS`）。

### 灌主源（Management API 路径）

```powershell
$pat = (Get-Content .env.local | Where-Object {$_ -like 'SUPABASE_PAT=*'}) -replace 'SUPABASE_PAT=',''
$h = @{ Authorization="Bearer $pat"; 'Content-Type'='application/json' }
$ref='efqljinkeatzpobvuouj'
$sql = "set search_path to platform, public;
  insert into content_items (source_id,canonical_url,content_hash,content_type,title,summary,rights_status,language,metadata)
  values ('<主源UUID>','<url>','<fnv8>','article','<title>','<summary<=160>','unknown','zh-CN','{}'::jsonb)
  on conflict (source_id,content_hash) do nothing;
  insert into content_tags (content_item_id,tag_pack_id,confidence)
  select id,'<标签包UUID>',100 from content_items where source_id='<主源UUID>' and content_hash='<fnv8>'
  on conflict do nothing;"
Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$ref/database/query" -Headers $h -Method Post -Body (@{query=$sql}|ConvertTo-Json -Compress)
```

现成脚本：`tools/ingest-main-source.ps1 -FeedUrl <rss> -Limit 12 -TagKey ai [-WhatIf]`（正常环境直接跑；崩溃环境把逻辑内联进 PowerShell 会话执行）。当前主源 UUID：`74d9887f-a1d4-4e26-92c2-4005e8829c21`（主源编辑池，authorized+allow_snippet）；ai 标签包 UUID：`e1ecb27d-7b3f-40de-b4e0-a68c19d042bf`。

## 8. 已知数据现状（2026-11-18）

- `platform.content_items`：约 **44** 条（rights=unknown，无图，title+摘要+链接）
- `platform.content_tags`：约 ai19 / opensource10 / tech10 / design10 / finance5 / portrait3；**funny/movie≈0**
- `platform.tag_packs`：8 个包（funny/portrait/opensource/ai/design/finance/tech/movie）
- `platform.sources`：1 个（主源编辑池 `74d9887f-…`，authorized+allow_snippet）
- 用户私有表：已有真实注册用户与平台；日更曾为 6 平台重建候选
- `service_role`：已 `GRANT USAGE/ALL` 到 `platform` schema（否则 PostgREST 403）
- `public` schema：onetone 原 12 张表，未被触碰
- Cloudflare：API token 过期，Pages 未部署

## 9. 历史调研结论（避免重复调研）

- 对标产品：Ghost（自托管+newsletter+会员）、beehiiv（增长工具）、Substack（直达读者）、Inoreader（规则/过滤/AI摘要）、follow.it（RSS→邮件/Telegram+Approve stories，最贴近分发层）、BestBlogs（RSS+AI评分+CLI，最贴近流程）、n8n（工作流+Human approval）。
- 自研只保留四块：标签目录+预览、个人候选池、审稿台、跨渠道发布编排；抓取/LLM/发送用成熟组件。
- `psterman/onetone-open-platform`：可借鉴其 Supabase 工程壳和 Edge Function 推送模式，但它是中心化"一个平台很多人订阅"，我们是"每人自建平台"，产品结构不同，不 fork。

## 10. 给接手 AI 的话

1. 先读本文 §1 产品原则再动手——用户对方向跑偏非常敏感（历史上纠正过五次）。
2. 所有"已验证"结论都附带验证方式，改动核心逻辑后请重跑对应自检页。
3. 版权纪律（§1.4）和读写边界（§3.3）是产品红线，改动前必须想清楚。
4. 本机环境坑（§5）不是借口而是事实，接手时先确认你所在环境是否正常，再决定用哪套验证路径。
5. `.env.local` 有全部真实凭证，但 PAT/secret 建议先让用户轮换再用新值。
