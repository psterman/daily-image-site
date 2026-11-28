# 把「每日图片站」做成 APK —— 评估（2026-11-28）

> 起因：用户问「这个网页能做成 apk 吗？」
> **用户已拍板：本轮只做评估，不动手。** 工具链（JDK 17 + Android SDK）以后要装的话装 **D 盘**（已获授权）。

---

## 0. 结论

**能做，技术上没有障碍。** 但有一条结论比「能不能」更重要：

> **APK 换不来更好的微信分享 —— 对这个站最核心的玩法，APK 是「持平甚至降级」。**

- 现在的网页玩法：**长按图 → 发送给朋友** → 微信出**带缩略图的图文卡片**（可点进站看原图）。这条路已经是微信里能拿到的最好形态。
- APK 里若**不接微信 SDK**，只能调**系统分享面板** → 微信收到的是**纯图片 + 一段文字链接**（不是卡片、链接不带缩略图），甚至可能拆成两条消息。
- 要在 App 里出**带缩略图的链接卡片**，得接微信开放平台「移动应用」SDK（`WXMediaMessageLink`）→ 需要**企业资质**的开放平台账号（个人开发者申请不到移动应用接入）+ 应用审核 + 域名在开放平台配白名单。

**所以 APK 的价值不在「分享」，在「打开方式、离线、原生体验」。**

**建议路线：先 PWA（零工具链、当天能上、不锁死后路）→ 真的需要 apk 文件了再上 WebView 壳 → 原生重写只在有明确原生需求时才做。**

---

## 1. 三条路对照

| | **A. PWA** | **B. WebView 壳 apk** | **C. 原生重写（Compose）** |
|---|---|---|---|
| 形态 | 不是 apk；Android Chrome「添加到主屏幕」= 桌面图标 + 全屏 + 可离线 | 真 apk 文件，站内网页原样套 | 真 App，重写全部 UI |
| 工具链 | **零**（2 个文件 + 图标） | JDK 17 + Android SDK（~5GB，D 盘） | 同 B |
| 工时（估算） | **半天** | 1~2 天（含工具链安装/踩坑） | 数周（数千行 Kotlin + 数据层 + 缓存 + 手势 + 分享 + 推送） |
| 产物 | `site/manifest.json` + `site/sw.js` + 图标 | 工程目录 + `app-release.apk` | 完整工程 + AAB |
| 分发 | 不用分发，用户自己加 | **不上架**即可：apk 文件放下载页 / GitHub Releases（装时要开「未知来源」） | 同 B，或上架 |
| 拿到什么 | 80% 的「像 App」感、离线缓存、桌面图标 | A 的全部 + 原生分享面板、保存到相册、下载、返回键接管 | 原生分享/缓存/推送/大图浏览/沉浸式 |
| 代价 | 「添加到主屏幕」不是真安装；微信内置浏览器里用不了（也不需要） | 要维护一个 Gradle 工程 + 签名 + 版本更新 | 工作量最大；**还要另开 JSON 数据接口** |

**判据（按目标选）**：

| 你真正想要的 | 走哪条 |
|---|---|
| 「手机上打开像 App 一样」 | **A** 就够 |
| 「要一个能装的 apk 文件，给别人发」 | **B** |
| 「要离线看整期图」 | A 的 Service Worker 能做基础版；**B/C** 才能做扎实 |
| 「要原生分享面板」 | B/C（但微信卡片仍然拿不到，见 §2.1） |
| 「要推送通知」 | **C**（或服务端 + Web Push，A/B 也能做 Web Push） |
| 「要更好的微信分享卡片」 | **谁都做不到**（除非有企业资质接微信 SDK） |

---

## 2. 这个站特有的坑（都核实过，不是泛泛而谈）

### 2.1 微信分享：APK 是降级不是升级 ⭐ 最重要

| 路径 | 微信里发出去的东西 |
|---|---|
| 网页长按图 → 发送给朋友 | **带缩略图的图文卡片**（点进去是单图页大图）✅ |
| apk 调系统分享面板（ACTION_SEND） | 纯图片 + 文字链接，**不是卡片**，链接不可点成卡片 ⬇️ |
| apk 接微信 SDK 发 `WXMediaMessageLink` | 带缩略图的卡片 ✅，但要**企业资质**开放平台账号 + 审核 |

**折中做法（apk 里可做）**：在 App 里放「复制链接」按钮 → 用户粘贴到微信 → 微信因为抓过这个 URL 的 og 标签，会出卡片 ✅。
（现在的网页查看器已经有「复制链接」了，这条路径本来就通。）

### 2.2 返回键：网页的「返回陷阱」和 Android 返回键会打架

本站 13/14 章做过**返回陷阱**（打开大图压一条历史 → 第一次返回先关大图、不退出页面）。
在 apk 里必须这样接，否则会出现「按返回没反应」：

```kotlin
// 关键：back 先交给网页，网页消费不掉时才退出 Activity
if (webView.canGoBack()) webView.goBack() else finish()
```

⚠️ **陷阱期间 `canGoBack()` 是 true**（那条历史还在）→ 如果 App 直接 `finish()`，用户就再也退不出大图了。
→ 必须**先 `goBack()`**，让网页自己的 popstate 处理器关大图并把陷阱收回（本站已实现，见 `site/app.js`）。

### 2.3 图片走 Pages Function 代理私有 R2

- 每看一张图 = **一次 Pages Function 调用**（免费额度 10 万/天，够用但要记着）。
- 代理返回 `Cache-Control: public, max-age=86400` → **HTTP 缓存能直接吃到** ✓，WebView 里不需要额外写缓存逻辑。
- 离线缓存整期 ≈ 200 张 × 100KB ≈ **20MB/期**，本地文件缓存可行。
- ⚠️ PWA 的 Service Worker **别把 `/img/` 代理无限缓存** —— 既吃 Workers 配额，又可能把用户看到的内容钉死。

### 2.4 鉴权：用的是 `x-author-token`，不是 Cookie ✅ 好消息

留言板/点赞的会话是客户端生成 token、放在 `x-author-token` 头里（不是 Cookie）。
→ **WebView / 原生 App 里天然可用**（token 存 localStorage 就行），不用改服务端。

### 2.5 前端已经为「套壳」做过准备 ✅

- 首屏有**内联 `<style>`**（`site/template.html`）→ 冷启动白屏问题小。
- 懒加载是**自建的 IntersectionObserver + 并发队列**（因为微信 X5 不认 `loading=lazy`）→ WebView 里表现一致。
- 站点本来就是**移动优先**、专门为微信 X5 调过的 → 套壳几乎 1:1。

### 2.6 工具链与磁盘

- 本机现状：**只有 Node**，没有 JDK / Android SDK / Gradle / adb。
- 需要装：**JDK 17**（~300MB，AGP 8.x 要求）+ **Android SDK**（cmdline-tools + platform-tools + build-tools + platform-34，约 4~6GB）。
- 磁盘：D 剩 96GB / E 剩 102GB → 装 **D 盘**没问题（C 盘只剩 35.8GB，Android Studio 本体也别装 C）。
- Gradle 用 wrapper 会自动下发行版（首次构建要联网）。

### 2.7 分发与合规

| 方式 | 需要什么 |
|---|---|
| **不上架，直接发 apk 文件** | 只要自签 keystore（`keytool` 生成）+ `apksigner` 签名；用户开「允许未知来源」。**不需要备案、不需要软著** |
| 上架国内商店（华为/小米/应用宝） | **ICP 备案**（域名）+ **软著登记**（个人可申请，1~2 个月）+ 隐私政策与用户协议（本站有留言板/点赞 = 有用户数据）+ 各商店的合规问卷。**周期以月计** |
| Google Play | 付费开发者账号（$25）、AAB 格式、目标 API 版本要求 |

⚠️ **apk 一旦发出去就收不回来**（用户手机上装着，只能靠「提示升级」）。这是本项目里少有的**不可逆对外动作**，跟发布一样要先问过用户。

### 2.8 签名与版本更新

- 自签 keystore **必须留好**（丢了就发不了升级包，用户只能卸载重装）→ 放到工程外的私密位置 + 备份。
- 同一个 keystore 签的新 apk 可以**覆盖安装**（版本号 `versionCode` 要递增）。

### 2.9 国内访问质量：apk 不改变

图片走 Cloudflare Pages + Function 代理 = 每次看图多一跳 Functions 计算，国内网络下波动明显。
**真要「国内流畅」，得换图片分发（国内 CDN / 对象存储）**，那是一个独立的、更大的工程（也是另一个不可逆动作）。

---

## 3. 若要动手，各路线的改造清单

### A. PWA（改动最小）

1. `site/manifest.json`：`name` / `short_name` / `start_url` / `display: standalone` / `theme_color` / `background_color` / `icons`（192 + 512 PNG，可从 `site/assets/logo.jpg` 用 ffmpeg 转 PNG + 缩放）。
2. `site/sw.js`：
   - **静态壳**（HTML/CSS/JS）→ cache-first；
   - **manifest / API** → network-first（别缓存写操作）；
   - **`/img/` 代理** → network-first 或干脆不缓存（避免吃 Workers 配额）；
   - 版本号变更时清旧缓存。
3. `site/template.html` 里加 `<link rel="manifest">` + `<meta name="theme-color">` + `apple-touch-icon`。
4. ⚠️ 注意 **Pages 的 `_middleware.js`** 会不会拦静态资源路径 —— 加 sw.js 后要验一次。

### B. WebView 壳 apk

1. 新工程（Gradle + Kotlin + WebView），与站点仓库**分开目录**（别混进 `daily-image-site`）。
2. 必须实现的原生桥（每一项都是「不做就出问题」）：
   | 桥 | 不做会怎样 |
   |---|---|
   | 返回键 → `canGoBack()` 优先 | 大图关不掉 / 按返回没反应（§2.2） |
   | 外链（`t.me` 等）→ 交给系统浏览器 | 在 App 内打开一个打不开的网页 |
   | `DownloadListener` → 保存到相册 | 点「原图」下载不了 |
   | 原生分享（`ACTION_SEND` + `EXTRA_TEXT` 链接） | 没有分享按钮 |
   | 剪贴板（复制链接） | 复制不了（WebView 的剪贴板权限） |
   | 网络状态 / 断网提示 | 断网时白屏无解释 |
3. `WebSettings`：`javaScriptEnabled`、`domStorageEnabled`（留言板 token 要 localStorage）、`mixedContentMode`、禁止缩放冲突、UA 保持移动端。
4. 签名 + 版本号 + 升级提示（apk 放哪：建议 **GitHub Releases 或独立下载页**，别塞进 Pages —— 否则每次站点发布都要带着它，还会撞 Pages 的 20,000 文件上限）。
5. 打包完要在真机验：微信里打开链接的表现、分享面板的表现、返回键、离线。

### C. 原生重写

1. **先开 JSON 数据接口**（现在只有 `window.__DAILY_MANIFEST__=` 的 JS 文件 + `feed.xml`）；原生端不该去剥 JS 前缀。
2. UI 重写：`site/app.js` 83KB + `site/board.html` 23KB + `site/app.css` 28KB ≈ 数千行 Kotlin。
3. 图片：Coil/Glide + 磁盘 LRU + `max-age=86400` 对齐。
4. 手势：捏合缩放、沉浸式、返回键（对应网页里的 viewer + 返回陷阱）。
5. 推送：需要服务端 + 推送服务（另开工程）。

---

## 4. 不可逆 / 需要单独授权的动作（提前列清）

| 动作 | 可逆性 |
|---|---|
| 给用户手机装 apk / 发 apk 下载链接 | **不可逆**（装了就一直在，除非用户自己卸） |
| apk 上架应用商店 | **不可逆**（要备案+软著，周期以月计） |
| 改站点线上内容（发布） | 不可逆（但有 24h 边缘缓存的撤回窗口） |
| 加 PWA（manifest + sw） | **可逆**（删两个文件就回退） |
| 装 JDK / Android SDK | 可逆（删目录） |
| 把域名/图片换成国内 CDN | 半不可逆（DNS 切换 + 缓存） |

---

## 5. 建议的推进顺序

```
Step 0  PWA（半天，零工具链）
        └─ 观察：用户真的会用「添加到主屏幕」吗？离线有需求吗？
Step 1  WebView 壳 apk（1~2 天 + 5GB 工具链）
        └─ 前提：Step 0 的体验已经不够用了
Step 2  （可选）原生化 / 推送 / JSON 接口
```

**别跳步**：Step 1 的成本是 Step 0 的 3~4 倍，而两者给用户的差别，
对「看图 + 分享到微信」这个核心场景来说**几乎为零**。

---

## 6. 结论一句话

**能做，但先别做。** 这个站最核心的玩法（分享到微信出卡片）网页已经做到了最好；
apk 的增量在「打开方式 / 离线 / 原生感」，不在核心玩法。
先用 PWA（半天、零依赖、可回退）验证用户到底要不要「像 App」，要的话再上壳 apk。

---

### 附：本轮核实到的事实（可复查）

| 事实 | 依据 |
|---|---|
| 本机无 JDK / Android SDK / Gradle / adb，只有 Node | `Get-Command` 逐个查 |
| 磁盘 D 剩 96GB / E 剩 102GB / C 剩 35.8GB | `Get-PSDrive` |
| 留言板用 `x-author-token` 头鉴权，不是 Cookie | `functions/board/api.js` |
| 图片代理 `Cache-Control: public, max-age=86400` | `functions/img/[[path]].js` |
| 首屏有内联 `<style>`；懒加载是自建 IntersectionObserver + 并发队列 | `site/template.html`、`site/app.js` |
| 站点**没有** `manifest.json` / `sw.js`（PWA 需从零加） | `site/` 目录清单 |
| 可复用图标素材：`site/assets/logo.jpg`（16.3KB，640×640） | `site/assets/` 清单 |
| 微信 og:image 强制 1:1 居中裁剪；一条消息「大图+链接」做不到 | 见 `AGENTS.md` 坑清单与 `CHECKPOINT.md` 第十五章 |
| Cloudflare Pages 一个站点最多 20,000 个文件（发布包全量快照） | 同上 |
