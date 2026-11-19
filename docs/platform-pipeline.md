# 第一阶段最小闭环：可运行骨架

这份文档对应 [`docs/data-model.md`](data-model.md) 第 5 节「第一阶段实现顺序」的前 10 张表。  
数据模型是**静态结构**，这份文档描述的是**让结构跑起来的代码**。

## 1. 闭环做了什么

一句话：**用户选几个标签包，系统每天给他生成一份属于自己的日报，审核后产出可被邮件 / Telegram / agent 共用的 `digest.json`。**

```text
注册用户           -> users
  ↓
建平台 + 选标签包  -> platforms + platform_columns（标签包 1:1 变栏目）
  ↓
主源灌入内容       -> sources + content_items + content_tags（版权过滤）
  ↓
生成候选池         -> candidate_entries（打分 + 去重 + 分栏）
  ↓
审稿               -> candidate_entries.status（人工决策 / AI 自动）
  ↓
发布               -> issues + issue_items + digest.json
```

终点 `digest.json` 与老站的同构，`tools/render-email.mjs` 直接能渲染。区别只在栏目 key：老站是写死的六个（`jianwen`/`jianxiao`/…），平台是自己选的标签包（`ai`/`opensource`/…）。渲染器通过 `digest.tabKeys` 自动识别，两种 digest 都支持。

## 2. 怎么跑

```bash
# 跑通整条链（AI 自动审稿），产出 digest.json
npm run platform:run -- --date 2026-11-18 --site-url https://demo.pages.dev

# 只生成候选池，留给审稿台人工决策
npm run platform:run -- --date 2026-11-18 --review manual

# 自定义用户 / 平台 / 标签
npm run platform:run -- --date 2026-11-18 --site-url https://x.pages.dev \
  --email me@example.com --name '我的头条' --tags ai,opensource,funny

# 护栏测试（离线、确定性、不连数据库）
npm run platform:test
```

产物位置：

- 数据库快照：`.data/platform/db.json`
- 推送稿：`.data/platform/published/<slug>/<date>/digest.json`

这两个目录都是运行时产物，不进版本库。

## 3. 代码结构

| 文件 | 职责 |
|---|---|
| `lib/platform-store.mjs` | 后端中立的数据层。与 schema 同构的 JSON store，`loadDb` / `saveDb` 可替换 |
| `lib/platform-flow.mjs` | 六个纯函数步骤 + `runPipeline` 便捷入口。业务规则全在这里 |
| `tools/platform-cli.mjs` | 可运行入口，把闭环跑一遍并落盘 |
| `tools/test-platform-flow.mjs` | 闭环护栏，覆盖六步 + 版权 + 去重 + 幂等 + 渲染兼容 |

为什么纯函数 + 可注入 db：真实后端（Supabase / 内置云服务）还没接。把每步写成 `(db, input) => output`，护栏就能用内存 db 跑通真流程；后端接好后只需替换 `platform-store` 的 `loadDb` / `saveDb`，六个业务函数一行不改。

## 4. 版权纪律（产品红线）

这一层不存正文，只存索引。规则硬编码在 `ingestContent`：

- `rights_status = blocked` 的源整条丢弃，标题都不进库；
- `allow_snippet = false` 的源不存摘要；
- `allow_image = false` 的源不存图片 URL；
- 永远不写 `content_bodies`（第一阶段不启用全文）；
- digest 的每条都是 `link_card`：标题 + 短导读 + 原文链接。

这不是保守，是产品的生存线。RSS 聚合本身不侵权，但一旦主动分类、摘要、排序、全文搬运，平台就更接近内容服务提供者，注意义务陡增。第一版把展示压到最小，把用户注意力导回原文。

## 5. 双模式迁移路径

当前是**本地 JSON 模式**：`loadDb(file)` / `saveDb(db, file)`。  
接后端的两种路径，业务函数都不用改：

- **Supabase**：`loadDb` 换成 PostgREST 拉取，`saveDb` 换成按表 upsert；`audit()` 直接写 `audit_logs`；Auth 对接 `users.id`。
- **内置云服务 / Cloudflare D1**：同理，只换存储适配层。UUID 主键、`jsonb` 字段、`created_at` 都与 schema 对齐，迁移不带数据结构返工。

这也是借鉴 `onetone-open-platform` 的结论之一：它的 Supabase 工程壳值得学，但「平台为核心」的数据模型和审稿台必须是我们自己的。

## 6. 下一步（第二阶段）

第一阶段只到 digest 为止，以下是还没做的：

- 注册登录（Magic Link / 手机号 / Telegram），现在是命令行占位；
- 多用户候选池与审稿台 UI（把 `candidate_entries` 暴露成可操作的网页）；
- `delivery_channels` / `issue_deliveries`：邮箱 / Telegram 自助绑定 + 发送幂等；
- 关注关系（平台 / 栏目 / 标签包）与平台目录页；
- 广告位与版权投诉流程；
- AI 每步写入 `ai_runs` 的完整审计。

这些表都已在 `db/schema.sql` 里建好，第二阶段按上表顺序逐个接。
