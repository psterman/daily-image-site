# Supabase 真后端接入指南

把「用户自建平台」从本地 JSON 库升级为真后端：用户登录、数据持久化、多用户隔离、刷新不丢。

## 1. 为什么是 Supabase

- **免费层够用**：500MB 数据库、5 万月活用户、无限 API 请求（免费档），比自建服务器省心。
- **Auth 自带**：邮箱 / 手机 / OAuth 登录开箱即用，`auth.uid()` 直接进 RLS 做行级隔离。
- **PostgREST 自动出 REST API**：23 张表不用写后端 CRUD。
- **RLS 是隔离核心**：用户只能读写自己的平台数据，共享内容池只读。

分工不变：**Supabase = 控制面 / 业务真源**；**Cloudflare = 发布面 / 文件面**（静态站 + R2 存 digest 快照与图片）。

## 2. 三步建库

在 Supabase 项目后台 → SQL Editor，按顺序执行：

```sql
-- ① 建表（23 张）+ 索引 + updated_at 触发器
--   内容见 db/schema.sql
-- ② 种子数据（8 个标签包 + 主源占位）
--   内容见 db/seed-core.sql
-- ③ Supabase 集成（Auth 同步 + RLS + 公开读策略）
--   内容见 supabase/migration.sql
```

也可以用 psql：

```bash
psql "$SUPABASE_DB_URL" -f db/schema.sql
psql "$SUPABASE_DB_URL" -f db/seed-core.sql
psql "$SUPABASE_DB_URL" -f supabase/migration.sql
```

> 顺序不能反：`migration.sql` 依赖已存在的表与 `auth.users`。

执行完成后验证：

```bash
npm run sb:check      # 静态护栏：23 表 / RLS / 触发器 / 客户端契约
npm run db:check      # 原有数据模型护栏
```

本机 Node 子进程不可用时，可直接用浏览器打开 `lib/sb-static-selftest.html`（需经本地静态服务器，见文末）跑同样断言。

## 3. 拿 key

项目后台 → Project Settings → API。Supabase 现在有两代 key 格式，**两代都能用**，`sb-client.mjs` 都兼容：

| 新版格式（推荐） | 旧版格式 | 用途 | 能否进前端 |
| --- | --- | --- | --- |
| `sb_publishable_...` | `sbp_...`（anon） | 浏览器直连，受 RLS 约束 | ✅ |
| `sb_secret_...` | `service_role` JWT | 灌主源、群发等特权操作，绕过 RLS | ❌ 仅服务端 Edge Function |

另需 **Project URL**（`https://<project-ref>.supabase.co`）——没有它，光有 key 连不上。

> ⚠️ `sb_secret_` / `service_role` 拥有绕过 RLS 的全权限。一旦泄露（贴进对话、写进日志、提交到仓库），应立即在后台 **API Keys → Revoke / Rotate**。前端只用 publishable key，secret 永不进浏览器。

### 凭证放哪

仓库根目录已备好两个文件：

- `.env.example` —— 纯占位模板，**可提交**，作为字段清单
- `.env.local` —— 真实值，**已被 `.gitignore` 忽略，绝不提交**

把 key 和 Project URL 填进 `.env.local`。`sb-client.mjs` 本身不读 env，由调用方注入：

```js
const client = createClient({
  url: process.env.SUPABASE_URL,          // 或从你的配置读
  key: process.env.SUPABASE_PUBLISHABLE_KEY, // 浏览器端只用 publishable
  schema: 'platform',                     // 业务表所在 schema（默认 public）
});
```

## 4. 浏览器端接入

项目新增三个零依赖模块（浏览器直接 `import`，无需 npm 安装）：

```
lib/sb-client.mjs   Supabase REST / Auth 客户端，可注入 fetch
lib/sb-repo.mjs     内存 db ↔ 表的桥接层（loadDb / saveDb / runRemotePipeline）
lib/platform-flow.mjs  业务函数（本次仅让 registerUser 支持传入 auth uid）
```

最小用法：

```js
import { createClient } from './lib/sb-client.mjs';
import * as flow from './lib/platform-flow.mjs';
import { runRemotePipeline } from './lib/sb-repo.mjs';

const client = createClient({
  url: 'https://<your-project>.supabase.co',
  key: '<anon-public-key>',
});

await client.auth.signUp(email, password, { display_name: '我的头条' });
// 或 await client.auth.signIn(email, password);

const result = await runRemotePipeline(client, {
  flow,
  email,
  name: '我的头条',
  tagKeys: ['opensource', 'ai', 'design'],
  siteUrl: 'https://<your-project>.pages.dev',
  date: '2026-11-18',
  review: 'auto',        // auto | manual
  perColumn: 2,
});
// result.digest 与邮件 / Telegram / 公开页同源
```

登录后的 `access_token` 可通过 `createClient({ ..., getToken: () => token })` 注入；
`auth.uid()` 会命中 `platform.users.id`（注册触发器保证两者一致），RLS 随即生效。

### 前端登录页（site/）

`site/portal.html` 现在是「登录优先」的工作台：未登录时全屏显示登录 / 注册卡片，登录后进入云模式。

| 文件 | 职责 |
| --- | --- |
| `site/config.js` | 公开配置：Project URL + publishable key + schema + siteUrl，**绝不放 secret / PAT** |
| `site/auth-ui.mjs` | 表单三态（checking / signedOut / signedIn）、会话读写、错误中文化 |
| `site/portal-app.mjs` | 双模式控制器：demo（内存）/ cloud（Supabase）；`refresh()` 重绘、`commit()` 写回 |

关键行为与踩坑：

- 启动先探测后端（读一条 `tag_packs`），再读 localStorage 会话恢复。
- **恢复会话必须同时 `client.auth.setToken(token)`**：`getToken` 只用于数据请求的 Bearer，`auth.user()` 读的是客户端内部 `sessionToken`。只注入 `getToken` 会导致刷新后被误判为未登录——这是本轮浏览器自检抓到的真 bug。
- 登录后 `loadDb` 拉共享池 + 私有表，业务函数照旧跑；任何改动经 `commit()` → `saveDb()` 写回私有表，共享池不写。
- 主源尚未灌内容时，用本机缓存的演示内容补齐**内存池**（不写共享池），保证候选条目引用的 `content_item_id` 稳定；真主源接入后清掉 localStorage key `platform.demo-content.v1` 即可。
- 未登录 / 云端不可用时可点「进入演示模式」离线跑完整条闭环。

> 当前项目 `mailer_autoconfirm=false`：注册后需到邮箱点确认链接再登录，`authError()` 已把 `email not confirmed` 翻译成中文提示。

### 读写边界（重要）

| 表 | 谁能写 |
| --- | --- |
| `tag_packs` / `sources` / `content_items` / `content_tags` | 仅 `service_role`（管理端灌主源） |
| `platforms` / `platform_columns` / `candidate_entries` / `issues` / `issue_items` / `delivery_channels` / `follows` | 登录用户，RLS 按 owner 隔离 |
| `issues`（status=published 且平台公开） | 匿名可读（公开页） |

这对应产品定位：**主源由我们预配置，用户只做选择和审稿**。`saveDb()` 不会写共享池。

## 5. 服务端特权操作（下一步）

以下操作不能放浏览器（需要 `service_role` 或密钥），应放 Supabase Edge Functions 或 Cloudflare Functions：

- 从 RSS / API 抓取并灌入 `content_items`（版权字段由管理端确认）
- AI 摘要 / 打分并写 `ai_runs` 审计
- 邮件 / Telegram 群发与 `issue_deliveries` 幂等
- 广告审核、投诉处理

这些 Function 用 `service_role` key 绕过 RLS，但必须自己校验调用来源。

## 6. 部署在独立 schema（既有项目共存时）

如果 Supabase 项目里已经有别的表（例如 onetone 平台自己的 `profiles / likes / timeline`），**不要把我们的 23 张表建进 `public`**——同名表（如 `follows`）结构不同会导致读写错位。改用独立 schema：

1. 用 `supabase/install-to-platform-schema.sql`（已把全部表名/函数/策略限定到 `platform` schema）代替 `db/schema.sql` + `supabase/migration.sql`。
2. 把 `platform` 加入 PostgREST 暴露 schema：Dashboard → Settings → API → Exposed schemas 勾选 `platform`，或 Management API：
   ```
   PATCH /v1/projects/{ref}/postgrest
   {"db_schema":"public,graphql_public,platform"}
   ```
   改完需在 Dashboard → General Settings 点 **Restart**（仅 `NOTIFY pgrst` 不够）。
3. 浏览器客户端必须带 schema 头（PostgREST 用头选 schema，不是 URL 前缀）：
   ```js
   createClient({ url, key, schema: 'platform' })
   // 会自动加 Accept-Profile / Content-Profile: platform
   ```
   否则 `/rest/v1/tag_packs` 会 404（它默认找 `public.tag_packs`）。

> 本项目实际就部署在 `platform` schema：已验证共享池读 8 行、私有表匿名读为空（RLS 生效）。

### 用 Management API 代执行迁移（有 PAT 时）

PAT（`sbp_...`）走 `api.supabase.com`，不是 Data API 的 key：

```
GET  https://api.supabase.com/v1/projects/{ref}                    # 探项目
POST https://api.supabase.com/v1/projects/{ref}/database/query     # 执行 SQL
     body: {"query":"SELECT ...", "read_only":true}
PATCH https://api.supabase.com/v1/projects/{ref}/postgrest         # 改暴露 schema
POST https://api.supabase.com/v1/projects/{ref}/restart            # 重启生效
```

注意：
- 单请求 SQL 有长度上限（约 20KB+ 报 400），大脚本要**按语句拆开逐条发**；
- 逐条发时**每条都要带 `set search_path to platform, public;`**（每条请求是独立会话，否则表会误建到 `public`）；
- PAT 是账号级凭证，用完建议 Revoke。

## 7. 验证

本机没有真实 Supabase 实例、Node 子进程也不可用，所以用注入 mock 的浏览器自检验证链路：

```
lib/sb-selftest.html            21 项：Auth / headers / 完整闭环 / 落库 / 重载 / 错误语义
lib/sb-static-selftest.html     27 项：migration 23 表 + RLS + 触发器 + 客户端契约
site/portal-auth-selftest.html  24 项：登录 / 注册切换 / 错误翻译 / 云模式闭环 / 写回 profile / 退出
                                 5 项：?mode=restore 预置会话后刷新自动恢复
site/portal-live-probe.html      4 项：真实 Supabase 共享池可读 / 私有表 RLS 拦截 / Auth 在线
```

实测结果：`AUTHSELF|24/24|ALLPASS`、`AUTHSELF|5/5|ALLPASS`（会话恢复）、`LIVEAUTH|4/4|ALLPASS`。

本地静态服务器（PowerShell，正确设置 `.mjs` MIME）：

```powershell
$root='E:\voice-pilot\daily-image-site-open'
$l=[Net.HttpListener]::new(); $l.Prefixes.Add('http://localhost:8791/'); $l.Start()
while($l.IsListening){
  $c=$l.GetContext(); $p=$c.Request.Url.AbsolutePath.TrimStart('/')
  if($p -eq ''){$p='index.html'}; $p=$p -replace '/','\'
  $f=Join-Path $root $p
  if(Test-Path $f -PathType Leaf){
    $ext=[IO.Path]::GetExtension($f)
    $mime=switch($ext){'.mjs'{'text/javascript; charset=utf-8'}'.html'{'text/html; charset=utf-8'}'.css'{'text/css; charset=utf-8'}default{'application/octet-stream'}}
    $c.Response.ContentType=$mime
    $b=[IO.File]::ReadAllBytes($f); $c.Response.ContentLength64=$b.Length
    $c.Response.OutputStream.Write($b,0,$b.Length)
  } else { $c.Response.StatusCode=404 }
  $c.Response.Close()
}
```

浏览器打开 `http://localhost:8791/lib/sb-selftest.html`，页面 `<title>` 会显示结果，如 `SB|21/21|ALLPASS`。

## 8. 成本

- Supabase 免费层：够个人和早期引流使用。
- Cloudflare 免费层：Pages + R2（10GB/月）+ pages.dev 子域名，零成本上线。
- 唯一可能花钱：自定义发件域名（约 ¥70/年），非必需。
