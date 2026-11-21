# 每日图片站 · daily-image-site

把每天收集到的图片，自动做成一个**能在微信里直接打开**的公开网页。

一条完整的流水线：**抓取 → 清洗 → 构建 → 人工审稿 → 发布**，
外加 RSS 订阅、OG 分享卡片、模糊占位图，
以及 **34 套自动化护栏 + 11 套变异测试**替你盯着每次改动。

```
┌──────────────────────────────────────────────────────────────┐
│  每日图片站                                    [看板]  [订阅] │
├──────────────────────────────────────────────────────────────┤
│  见闻  │  见她  │  见笑  │  见报  │  听乐  │  看片            │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│      ▢  ▢  ▢  ▢  ▢  ▢  ▢  ▢      缩略图网格，滚动懒加载       │
│      ▢  ▢  ▢  ▢  ▢  ▢  ▢  ▢      首屏用 24px 模糊占位        │
│      ▢  ▢  ▢  ▢  ▢  ▢  ▢  ▢      点开看原图                  │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  2026-11-17 · 见闻 30 · 见她 72 · 见笑 80 · 见报 369 …       │
└──────────────────────────────────────────────────────────────┘
```

---

## 这东西解决什么问题

「每天攒一堆图，想发给朋友看」这件事，原始做法有四个洞：

| 痛点 | 这个项目怎么补 |
|---|---|
| 图片散在微信收藏夹 / 相册里，发出去是**九宫格图片堆** | 每期一个网页链接，发出去是**带缩略图的卡片** |
| 微信只给链接预览，**不订阅** | 每期一条 RSS item，订阅器自动收 |
| 网页首屏白屏，**手机上尤其明显** | 内联 24px 模糊占位（LQIP），零额外请求 |
| 自动发布怕**发错内容** | 审稿台是发布的**前置闸门**，没审过不许发 |

---

## 功能一览

### 站点侧

- **6 个 tab**：见闻 / 见她 / 见笑（图片）、见报（RSS 热榜条目）、听乐（音乐榜）、看片（影视榜）
- **图片私有托管**：图片存 R2 私有桶，网页通过 Pages Function 代理取（`/img/<日期>/<分类>/<文件>`），**URL 里带随机盐** —— 猜不到就是猜不到
- **往期归档**：每期一个永久链接（`/<日期>/`）+ `/archive/` 列表
- **看板**（`/board/`）：投稿（口令保护）+ 点赞
- **OG 分享卡片**：每期一张 1200×630 三栏拼图（见闻/见她/见笑各取一张），`og:` / `twitter:` 全套元数据
- **RSS**（`/feed.xml`）：RSS 2.0，每期一条 item，链接与 guid 都是绝对 URL
- **邮件推送（Newsletter）**：读者在 `/subscribe/` 按分类订阅，每天早上直接收邮件，不用登录网站 → 见 [`docs/newsletter-setup.md`](docs/newsletter-setup.md)
- **群机器人日报**：企业微信 / 钉钉 / 飞书群每天收一条固定六栏目日报，点链接直达栏目 → 见 [`docs/newsletter-setup.md`](docs/newsletter-setup.md)
- **用户自建平台数据模型**：注册用户、个人平台、栏目、候选池、关注、广告与版权投诉的可移植 SQL 模型 → 见 [`docs/data-model.md`](docs/data-model.md)
- **第一阶段最小闭环（可运行）**：注册 → 选标签建栏目 → 灌内容（版权过滤）→ 候选池 → 审稿（人工/AI 自动）→ 发布 digest.json。纯函数实现，本地 JSON store 可离线跑通 → 见 [`docs/platform-pipeline.md`](docs/platform-pipeline.md)
- **Supabase 真后端**：Auth 登录 + PostgREST + 23 张表 RLS 行级隔离，用户刷新不丢数据；业务函数零改动跑在真库上 → 见 [`docs/supabase-setup.md`](docs/supabase-setup.md)
- **主源供给链路**：RSS 抓取/解析（复用 fetch-rss.mjs）→ 版权过滤 + 标签映射（lib/ingest-map.mjs）→ service_role 灌入共享池；已灌入真实 AI 资讯，前端读真数据 → 见 [`docs/main-source-pipeline.md`](docs/main-source-pipeline.md)
- **模糊占位（LQIP）**：24px WebP 以 base64 data URI 内联进 manifest —— 零额外请求、零额外 R2 对象
- **懒加载**：原图滚动到才加载
- **轻依赖**：前端零外部 JS/CSS

### 工具链侧

- **抓取器**（Python）：`daily_grab_all.py` 抓图 → `daily_headlines.py` 抓热榜 → `clean_images.py` 清洗（去广告图 / OCR 剔水印 / 分类）
- **构建器**（Node）：`build.mjs` 转 WebP、生成 manifest、拼页面、出 OG 图、出 RSS
- **审稿台**（本地 Web UI）：改分类、删图、点「发布」—— 点发布会写一个**只对当期有效**的放行凭证
- **发布闸门**：`publish.ps1` 认凭证，没凭证**拒发**（这是设计，不是故障）
- **夜间自动化**：Windows 计划任务 / macOS launchd，00:10 无人值守跑完整条链
- **本地任务台**（本地 Web UI）：看夜间发布跑到哪一步、有没有问题；外加「立即跑一次」「补发某一天」两个**带确认条**的写操作
- **护栏**：35 套自动化测试 + 12 套变异测试

---

## 快速开始

### 1. 环境

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | 22+ | 构建 / 发布 / 测试 |
| Python | 3.10+ | 抓取与清洗 |
| ffmpeg | 任意近期版本 | 转 WebP、生成缩略图与 OG 图 |
| PowerShell | Windows 用自带 5.1；macOS 装 pwsh 7+ | 发布链路的入口是 `.ps1` |
| Cloudflare 账号 | — | Pages（静态面）+ R2（图片私有桶） |

```bash
git clone https://github.com/psterman/daily-image-site.git
cd daily-image-site
npm install          # 主要是 playwright（4 个 UI 护栏要用）
```

### 2. 一键开通 Cloudflare 资源

```powershell
powershell -ExecutionPolicy Bypass -File tools/setup-cloudflare.ps1 `
  -Project your-project -Bucket your-bucket -SiteUrl https://example.com
```

它会建好 Pages 项目和 R2 桶，并把凭据写进 `.env.local`（**已被 `.gitignore` 忽略，绝不入库**）。

也可以全手写 `.env.local`：

```ini
CLOUDFLARE_ACCOUNT_ID=xxxxxxxx
CLOUDFLARE_API_TOKEN=yyyyyyyy
R2_BUCKET=your-bucket
PAGES_PROJECT=your-project
SITE_URL=https://example.com
IMAGE_ROOT=~/image-root
```

### 3. 放图

```
<IMAGE_ROOT>/src/2026-11-17/
├── 见闻/    001_xxx.jpg
├── 见她/    001_xxx.jpg
└── 见笑/    001_xxx.jpg
```

目录名就是分类，分类名就是 tab 名 —— 不需要额外配置。

### 4. 构建 + 预览

```bash
node tools/build.mjs --date 2026-11-17      # 出 published/2026-11-17/
node tools/preview-server.mjs                # http://127.0.0.1:8809
```

预览服务器会把 `/img/*` 映射到本地 R2 母本（`<IMAGE_ROOT>/r2`），
所以**预览里能看真图**，跟线上长得一样。

### 5. 审稿 + 发布

```bash
node tools/start-review.mjs 2026-11-17       # 起本地审稿台
# 浏览器里改分类、删图，确认无误后点「发布」→ 写当期放行凭证

powershell -ExecutionPolicy Bypass -File tools/publish.ps1 -Date 2026-11-17
```

### 6. 本地任务台（看夜间发布跑到哪了）

```bash
node tools/start-dashboard.mjs    # 或双击根目录的 起任务台.cmd
# 浏览器会打开 http://127.0.0.1:8801/（端口占用时顺延，实际值写在 .night-dashboard-port）
```

它只读本机的发布日志和标记文件，显示每天的阶段进度、耗时和异常；
两个写操作（立即跑一次 / 补发某一天）都会先弹确认条 —— **发布不可逆**。

### 7. 跑护栏

```bash
npm test              # 35 套
npm run test:mutate   # 加上 12 套变异测试（慢，但能证明护栏有牙齿）
```

---

## 目录结构

```
daily-image-site/
├── site/                 前端（零外部依赖的单页）
│   ├── template.html     页面模板（构建时填 {{...}}）
│   ├── app.js  app.css   渲染与样式
│   └── board.html        看板页
├── tools/                全部工具链
│   ├── build.mjs         构建器（转码 / manifest / 页面 / OG / RSS）
│   ├── build-og.mjs      OG 分享图
│   ├── build-feed.mjs    RSS 输出
│   ├── build-lqip.mjs    模糊占位
│   ├── fetch-*.mjs       抓取器（Node 侧：榜单 / 追更）
│   ├── grab/*.py         抓取器（Python 侧：图片 / 头条 / 清洗）
│   ├── review.mjs        审稿台（本地 Web UI）
│   ├── publish.ps1       发布链路（闸门 → 构建 → 上传 → 部署）
│   ├── daily-review.ps1  早晨「准备」链路
│   ├── night-publish.ps1 夜间无人值守链路
│   ├── setup-cloudflare.ps1  开通 Cloudflare 资源
│   ├── paths.mjs         **路径真源**（工程根 / 图像根）
│   ├── strip-comments.mjs  剥注释（护栏匹配的地基）
│   ├── run-all-tests.mjs 全量护栏跑批器
│   └── test-*.mjs        34 套护栏 + 11 套变异测试
├── functions/            Cloudflare Pages Functions
│   ├── img/[[path]].js   图片代理（R2 私有桶）
│   ├── board/            看板 API + 中间件
│   ├── likes/api.js      点赞
│   └── _middleware.js    闸门
├── lib/                  共享模块（R2 JSON 读写 / 限流）
├── docs/                 设计与迁移文档（含 data-model.md）
├── db/                   可移植 SQL 数据模型与种子数据
├── AGENTS.md             **开发手册 + 实测坑清单**（接手先读这个）
├── CHANGELOG.md          变更日志
└── published/            构建产物（部署面，已 .gitignore）
```

---

## 配置

全部配置集中在 `.env.local`（环境变量优先，其次 `.env.local`）：

| 键 | 必填 | 说明 |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | ✅ | Cloudflare 账号 ID |
| `CLOUDFLARE_API_TOKEN` | ✅ | API Token（需 Pages + R2 权限） |
| `R2_BUCKET` | ✅ | R2 私有桶名 |
| `PAGES_PROJECT` | ✅ | Pages 项目名 |
| `SITE_URL` | ✅ | 站点公开地址（OG / RSS 的绝对 URL 用它） |
| `IMAGE_ROOT` | | 本地图片存储总根，默认 `<家目录>/image-root` |

**图片路径只有一个真源**：`tools/paths.mjs`。别在别的脚本里写死路径 ——
挪盘就得改 6 个文件，漏一个会静默出 bug。

### 站名在哪改

站名不是配置项，是 `tools/build.mjs` 里的两个字面量：

| 位置 | 字面量 | 影响 |
|---|---|---|
| `tools/build.mjs` 的 `SITE_TITLE` | `每日图片站` | 页面标题、`og:site_name`、RSS 的 channel 标题 |
| `site/template.html` 的 `{{TITLE}}` | 模板变量 | 不用改 —— 由上面那个注入 |

搜 `每日图片站` 能一次找全（README 和 AGENTS.md 里的说明文字不算）。

---

## 一天的工作流

```
00:10  夜间链路自动跑：抓图 → 头条 → 清洗 → 构建 → 自检 → token 续期
       → 重建 → 传 R2 → 部署 → 清孤儿        （无人值守，Windows 计划任务 / macOS launchd）
  ↓
早上   你起审稿台：node tools/start-review.mjs
       → 在网页上把图挪到对的分类、删掉不该发的
       → 点「发布」（写一个只对当期有效的放行凭证）
  ↓
       powershell -File tools/publish.ps1 -Date <日期>
       → 认凭证 → 构建 → 传 R2 → 部署 → 写标记
```

Windows 上有两个双击入口：

| 文件 | 作用 |
|---|---|
| `一键更新.cmd` | 准备（抓图 → 头条 → 清洗 → 榜单/追更 → 构建 → 起审稿台），**不发布** |
| `一键发布.cmd` | 发布（传 R2 + 部署），**要求先审过** |

> ⚠️ Windows 上起审稿台请**双击 `起审稿台.cmd`**（或经 `explorer.exe` 启动）。
> 直接在终端里 `node tools/start-review.mjs` 会被终端的 Job Object 连带杀掉 ——
> 子进程被杀时**没有 stderr、没有退出码、没有事件日志**，看起来像「它自己没了」。

---

## 部署

- **静态面**（HTML / CSS / JS / manifest / `og.jpg` / `feed.xml`）→ Cloudflare Pages，
  `wrangler pages deploy published`
- **图片**（WebP 母本）→ R2 私有桶，网页通过 `functions/img/[[path]].js` 代理取
- `wrangler.toml` 里配好 `pages_build_output_dir` 与 R2 绑定

```bash
npx wrangler pages deploy published --project-name your-project --branch main
```

**为什么图片要过一层代理**：R2 桶是私有的，URL 里还带随机盐 ——
直接把桶公开，盐就白加了。

**部署完记得**：`og.jpg` 和 `feed.xml` 都在 `published/` 里，
`wrangler pages deploy published` 会整目录带上，不用单独处理。

---

## 护栏与变异测试

这个项目把「改动会不会悄悄弄坏东西」当成一等问题。

**35 套护栏**覆盖：产物有效性（0 字节文件不许混上线）· 分享卡片与 RSS 的元数据 ·
模糊占位 · 抓取器分类 · 审稿闸门 · 夜间链路 · **定时任务台** · 跨平台可移植性 · 目录穿越防护 · ……

**12 套变异测试**是护栏的牙齿 —— 它把源码**故意改坏**，然后要求护栏**必须变红**：

```
node tools/test-build-og-mutate.mjs
  → 10 个变异点，10 个全被抓（10/10）
```

护栏要合格，四条纪律缺一不可：

1. **匹配源码前先剥注释** —— 这个工程的注释里就写着 `og:image`、`RSS`、`filter: blur()`。
   全文匹配的话，护栏会把自己的说明书当成合规证据 → 代码改坏了照样全绿 → **假护栏**。
2. **锚点自检** —— 每个变异点必须在被改文件里**恰好命中 1 次**，否则脚本直接退出并说「锚点过期了」。
   源码一改锚点就会漂移，不自检的话，漂移会被混进「没抓到」的统计里。
3. **干净地红** —— 护栏要**断言变红**，不能是**自己抛异常崩掉**。
4. **expectFail + expectGreen 双向声明** —— 变异体必须红，原件必须绿。

```bash
npm run test:mutate     # 12 套变异测试
```

**「跳过」不算通过。** 跑批器把三种结果分开报：

| 退出码 | 含义 | 什么时候 |
|---|---|---|
| `0` | 绿 | 真跑了，全过 |
| `1` | 红 | 跑挂了，或断言没过 |
| `2` | 跳过 | 条件不具备（没有 `published/` 往期产物、没有 R2 母本、没装 ffmpeg） |

跳过**不计入绿** —— 把它混进「全过」里就是假绿，比红更坏。

---

## 跨平台

Windows 和 macOS **跑同一份 `.ps1`**，不维护第二套脚本。macOS 上装 pwsh 7 即可。

真正跨不过去的只有五处，都在 `tools/common.ps1` 里收着：

| # | Windows 专属 | macOS/Linux | 处理方式 |
|---|---|---|---|
| ① | 时区 ID `China Standard Time` | `Asia/Shanghai` | 两个都认 |
| ② | 子进程 `powershell.exe` | `pwsh` | 按平台选命令名 |
| ③ | 路径分隔符 `\` | `/` | 一律用 `Join-Path` |
| ④ | Python 探测目录 | — | 按平台列候选 |
| ⑤ | 图像根目录 | 家目录 | 统一落在用户家目录，**不写盘符** |

> ⑤ 这条最要紧：写死盘符的话，macOS 上会**静默**拿到空目录 ——
> 审稿台一张图都不显示，构建以为「今天没图」，而**没有任何报错**。

---

## 几条实测踩过的坑

完整清单在 [`AGENTS.md`](AGENTS.md)（那份文件是本项目最值钱的部分）。这里挑几条最狠的：

- **「文件存在」不等于「文件有效」** —— 0 字节的 WebP 会被原样传上线，
  代理还照样返回 `200 / image/webp`。存在性检查必须升级成有效性检查。
- **微信按分享的 URL 缓存卡片** —— 根 URL 是固定的，卡片会永远停在第一天。
  想每期都拿到新卡，要分享**当天页面**的链接（URL 唯一，微信每次都重抓）。
- **`og:image` 必须是绝对 URL** —— 相对路径的话微信 / X / 知乎的爬虫拉不到，分享卡片直接白卡。
- **Pages 的 404 兜底返回 200 + HTML** —— 判「文件存不存在」不能看状态码，
  要看 Content-Type 和内容开头。
- **护栏匹配源码前必须先剥注释**（见上）。
- **破坏性重建不要「先删后建」** —— 进程在中途被杀的后果不是「停在上一版」，
  而是**空目录 + 上层索引指向已被删掉的文件**（比失败更糟）。要写临时目录再原子替换。
- **Windows 上 Node 的退出码无符号** —— `-30` 实际是 `4294967262`。

---

## 关于素材与版权

**本仓库只含代码，不含任何图片素材。**

站点上的图来自网络抓取（热榜截图、论坛图、榜单封面等），
**版权归原作者所有**，抓取方不拥有这些图。
你自己用这套工具时，请自行确认所抓内容的授权与使用场景。

同理，`docs/` 里的截图与站点内容都不在仓库里 ——
公开仓库只分享**代码**。

---

## 许可证

[MIT](LICENSE) © 2026 psterman

## 致谢

- [Cloudflare Pages](https://pages.cloudflare.com/) · [R2](https://developers.cloudflare.com/r2/) —— 静态面 + 私有图片桶
- [ffmpeg](https://ffmpeg.org/) —— 转码、缩略图、OG 拼图
- [Playwright](https://playwright.dev/) —— 4 套 UI 护栏
