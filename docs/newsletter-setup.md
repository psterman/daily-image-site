# 每日邮件推送（Newsletter）开通指南

把每天的站点内容，按订阅者勾选的分类，直接发到邮箱。读者不用登录网站。

## 它怎么工作

```
build.mjs（出 published/<日期>/）
      ↓
build-digest.mjs  → published/<日期>/digest.json   ← 与渠道无关的推送稿（唯一真源）
      ↓
send-newsletter.mjs  → 读 R2 订阅者 → 按分类渲染 → Resend 发信
      ├
send-groupbot.mjs    → 企业微信 / 钉钉 / 飞书群（广播日报）
      ↑
subscribe Function  ← 读者在 /subscribe/ 勾选邮箱与分类
```

三个设计要点：

1. **推送稿是唯一真源**。`build-digest.mjs` 从页面实际加载的那份 manifest 取数，拼成绝对 URL；邮件、Telegram、agent 将来都读同一份 `digest.json`，不再各自去翻 manifest。
2. **订阅者存 R2**（跟图片同桶，`subscribers/` 前缀），不引入 KV/D1 等新绑定。邮箱用 sha256 当键，明文只在发信时读。
3. **按分类过滤后再渲染详情**；但顶部的**固定栏目预览条永远列全六个栏目**（读者一眼看今天有什么、想临时跳没订的栏目点一下就直达）。退订链接每人独立 token，点一下即退。

## 读者收到的邮件长什么样

从上面到下面依次是：

1. **标题 + 概览**：`每日图片站 · 11月17日`，一行 `见闻 30 · 见她 72 · …`。
2. **今日栏目预览条**：六个栏目永远全在，每个带封面缩略图、数量、`直达查看 →`。
   - `●` = 已订阅，`○` = 未订阅（不靠颜色也能区分）。
   - 每一格都链到 `<站点>/<日期>/#<栏目key>`（如 `#jianxiao`）——站点的 `app.js` 读 `location.hash` 切栏目，点开直接落在指定栏目，不用从首页再找。
3. **订阅栏目的详情**：每个栏目标题带 `在网页看这一栏 →` 直达；图片 tab 显示缩略图网格（点图看原图），文本 tab 显示标题列表。只有订阅的栏目才有详情。
4. **页脚**：`在网页里看完整一期 →` + 一键退订。

纯文本兜底（给 agent / 纯文本客户端）同样带一行六栏目直达索引，agent 能拿到完整栏目地图。

**为什么不只列订阅的栏目**：预览条是每天的"入口地图"——读者想临时看看没订的栏目，点一下就走，不用先去改订阅设置。预览是轻量目录，详情才是订阅内容，两者职责不同。

## 开通步骤

### 1. 准备发信域名（唯一的小成本）

邮件要进收件箱，必须从一个**你自己拥有并验证过的域名**发出。用 `pages.dev` 这类地址发信会进垃圾箱。

- 买一个域名（`.com` 约 ¥70/年，Cloudflare Registrar 或任意注册商）。
- 在 Resend（`resend.com`）注册 → Domains → 添加域名 → 按提示加 3 条 DNS 记录（SPF / DKIM / DMARC）。验证通过。
- **免费额度**：3000 封/月，但每天硬顶 100 封。个人日报够用；超过就升级（$20/月起）或每天分批。

> 这一步是整套方案里唯一要花钱的地方（域名年费）。 Cloudflare 的 Pages + R2 依然全免费。

### 2. 配置 `.env.local`

在原有配置基础上加这几行：

```ini
# 发信（Resend）
RESEND_API_KEY=re_xxxxxxxx
NEWSLETTER_FROM=每日图片站 <daily@你的域名>

# 其余沿用现有配置，发信脚本靠它们读 R2 订阅者
CLOUDFLARE_ACCOUNT_ID=xxxxxxxx
CLOUDFLARE_API_TOKEN=yyyyyyyy
R2_BUCKET=your-bucket
SITE_URL=https://你的站点.pages.dev
```

`CLOUDFLARE_API_TOKEN` 需要 R2 读写权限（`Object Read & Write`），跟上传图片用的是同一个即可。

### 3. 订阅页自动上线

`functions/subscribe/` 下的两个 Function 会随 Pages 部署自动生效，无需手动配置：

- `GET  /subscribe/`  → 六分类勾选的订阅页
- `POST /subscribe/`  → 提交订阅
- `GET  /subscribe/api?action=unsubscribe&email=<hash>&token=<token>` → 退订（邮件底部链接）
- `GET  /subscribe/api` → 订阅人数（统计用，不含隐私）

重新部署一次（`publish.ps1`）后访问 `https://你的站点.pages.dev/subscribe/` 确认页面出来。

### 4. 接到每日流程（可选自动化）

在 `publish.ps1` 部署成功后追加两步（建议放在清孤儿之后）：

```powershell
node tools/build-digest.mjs --date <日期>
node tools/send-newsletter.mjs --date <日期>
```

不想改 publish.ps1 也可以手动跑。发信失败不会回滚网站——邮件是旁路，站点发布是主线。

## 日常命令

```bash
# 只生成推送稿（构建后）
node tools/build-digest.mjs --date 2026-11-17

# 预览某分类的邮件长什么样（打印 HTML 到 stdout）
node tools/render-email.mjs --digest published/2026-11-17/digest.json --cats jianxiao,news

# 干跑：只渲染不发送，看前 3 封
node tools/send-newsletter.mjs --date 2026-11-17 --dry-run

# 正式发送
node tools/send-newsletter.mjs --date 2026-11-17

# 补发（无视已发标记）
node tools/send-newsletter.mjs --date 2026-11-17 --force
```

## 群机器人日报（企业微信 / 钉钉 / 飞书）

如果不需要按人订阅，只是想让一个团队群每天早上收到一条「今日有什么 + 点一下直达栏目」，用群机器人钩子就够了。

它跟邮件的关系：

- **邮件**：newsletter 主载体，按人按分类发详情，有退订。
- **群机器人**：群里的一条日报钩子，固定六栏目广播，不区分成员、不存订阅者、不发图床图片正文。
- 两者都读同一份 `digest.json`，栏目名、数量、`#栏目` 直达不会漂移。

### 为什么官方群机器人不会「封号」

走的是企业微信 / 钉钉 / 飞书各自的**官方 webhook**，不是个人微信外挂或协议机器人：

- 官方接口只会限流，不会封账号；
- 一天一条日报远低于三家阈值（企业微信约 20 条/分钟，钉钉 20 条/分钟，飞书 100 次/分钟 + 5 次/秒）；
- 但 HTTP 200 不等于送达 —— 脚本会继续解析 `errcode` / `code` / `StatusCode`，业务码非 0 直接报错。

真正有封号风险的是个人微信的非官方协议 / 外挂，这条不在本项目里。

### 配置 webhook

在对应平台群设置里添加自定义机器人，复制 webhook 地址到 `.env.local`：

```ini
# 只用哪个就配哪个，推荐不要写进命令行参数（会进 shell 历史）
WECOM_WEBHOOK=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...
DINGTALK_WEBHOOK=https://oapi.dingtalk.com/robot/send?access_token=...
FEISHU_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/...
```

### 命令

```bash
# 先看渲染结果（不发送）
node tools/send-groupbot.mjs --date 2026-11-17 --provider wecom --dry-run

# 正式发到企业微信群
node tools/send-groupbot.mjs --date 2026-11-17 --provider wecom

# 钉钉 / 飞书
node tools/send-groupbot.mjs --date 2026-11-17 --provider dingtalk
node tools/send-groupbot.mjs --date 2026-11-17 --provider feishu

# 只导出请求体，给已有定时任务用
node tools/render-groupbot.mjs --digest published/2026-11-17/digest.json --provider feishu --out .exp/groupbot.json
```

群消息长这样：标题 + 当日总条数 + 固定六栏目（每栏一个 `打开` 链接指向 `<站点>/<日期>/#<栏目key>`）+ `看完整一期`。飞书用富文本卡片承载链接，企业微信 / 钉钉用 markdown。

> webhook 是群凭证，等同于「谁能往群里发消息」。别提交到仓库、别打印到日志；泄露后去平台删除机器人重建一个即可。脚本不自动重试：超时可能其实已经送达，重跑比自动双发更可控。

## 护栏

```bash
npm run test:digest    # digest 生成 / 邮件渲染 / 群机器人渲染 / 收件人筛选
```

覆盖：图片 URL 必须绝对、站点尾斜杠去重、文本型 tab 不当图片处理、分类过滤真过滤、HTML 转义、退订占位符、已发不重发、`--force` / `--limit`，以及三家群机器人的 markdown / post 载荷与 `#栏目` 直达。

## 写给 agent 用

`digest.json` 是结构化 JSON（schema: 1），任何 agent / 脚本都能读：

- `tabs[].key` 分类，`tabs[].count` 数量
- 媒体型 `tabs[].highlights[].full` 是图片绝对 URL
- 文本型 `tabs[].highlights[].title` / `.url`
- `issueUrl` 当天页面，`feedUrl` 站点 RSS

`feed.xml` 也仍在（站点原有的 RSS），两者并存：feed 是「每期一条」的轻量订阅，digest 是「带内容细节」的推送源。

## 已知边界

- **Resend 免费档 100 封/天是硬顶**。脚本会在超限时直接报错而不是傻发（发一半静默漏掉更糟）；撞 429 会停发并保留未发标记，次日自动续发。
- **个人微信不适合做这条推送链**。个人主体公众号没有模板/订阅消息权限；群发是「每天1次全量广播」，做不到按分类精准推。要走微信需企业主体 + 认证（¥300/年）。本项目不接个人微信；**企业微信群机器人是官方钩子，可用**，但它是群广播、不是按人订阅。建议邮件为主，Telegram / 群机器人为辅。
- **退订是即时生效的**；但已经在途的那一封可能已经发出，属于正常现象。
