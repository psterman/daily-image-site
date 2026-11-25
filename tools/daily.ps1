<#
.SYNOPSIS
    每日准备：抓图 + 抓头条 + 清洗 + 构建（不上传、不部署）。
    审完稿再跑 tools/publish.ps1 传上去。

.DESCRIPTION
    流程（顺序固定，日期必须对齐）：
      1. daily_grab_all.py    抓 3 个 TG 频道 + 喷嚏图卦 + 福利吧 + 煎蛋女装
                              下载即改名：见笑 / 见闻 / 见她（福利吧靠人脸检测分流）
      2. daily_headlines.py   抓 5 个热榜源 → headlines_<日期>.json（见报的分类目录）
      3. clean_images.py      剔广告图 / 剔废图 / 剔重复图
      4. fetch-rank.mjs       抓榜单 → rank_<日期>.json（听乐 + 看片的电影/视频段）
         fetch-follow.mjs     抓追更 → follow_<日期>.json（看片的频道更新/本地演出段）
      5. build.mjs            构建页面 + 转码（产物在本地，不上传）

    ⚠️ 第 4 步是 2026-11-16 补上的 —— **以前这一步根本不在流程里**。
    榜单和追更都是**构建期静态数据**（build.mjs 只读那两个 JSON，不会自己抓），
    以前只有 11-16 那一期有（手工跑抓取器跑的），
    其余各期源目录里没有 → 构建时静默跳过 → 站点只有 4 个 tab。
    看片 v3 把两块的五段并进「看片」之后，漏抓的后果从「tab 不存在」
    变成「看片只有 2~3 个目录」—— 看着像网站坏了，更难看出是漏抓了一次数据。
    所以第 4 步失败**只警告不中断**（图片才是主体），
    但构建会**点名**说缺了哪几段（build.mjs 的 WATCH_SECTIONS 清单）。

    完事会提示你开审稿台：node tools/review.mjs <日期>
    审完点「通过审核」，再跑：
      powershell -ExecutionPolicy Bypass -File tools/publish.ps1 -Date <日期>

    为什么拆成两段：
      上传之后东西就发到群里了，撤回要等 24 小时边缘缓存，
      而且链接已经发出去收不回来 —— 所以上传前必须有人看过图。

    日期语义（重要）：
      目录名 = **发布日期**（北京今天），抓的是**昨天**的内容。
      站点「日期页 = 目录名」，所以这一步算出来的 publishDate
      必须原样传给 publish.ps1，两边才能对上。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools/daily.ps1

.EXAMPLE
    # 只重建，不重新抓（改完文案用）
    powershell -ExecutionPolicy Bypass -File tools/daily.ps1 -NoGrab

.EXAMPLE
    # 指定内容日期（默认昨天）
    powershell -ExecutionPolicy Bypass -File tools/daily.ps1 -ContentDate 2026-10-25
#>
param(
  # 内容日期（要抓哪天的图）。默认昨天。
  [string]$ContentDate,
  # 跳过下载（图片已经手动放好了）
  [switch]$NoGrab,
  # 跳过抓头条
  [switch]$NoHeadlines,
  # 跳过图片清洗（不剔广告图 / 废图 / 剔重复图（按发布日目录洗））
  [switch]$NoClean,
  # 跳过抓榜单 + 追更（听乐 / 看片 五段的静态数据）
  [switch]$NoRank,
  # 复用已转码的图片，不重新转码（快 5 倍）
  [switch]$NoConvert,
  # 跳过部署（这一步默认就不部署，留着是为了兼容旧调用）
  [switch]$SkipDeploy,
  # 源图根目录（默认读 .env.local 的 IMAGE_ROOT\src）
  [string]$Out
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# 跨平台公共 helper（北京时间 / 起子进程的 shell / 图像根目录 / 路径拼接）。
# macOS 上跑的是同一份 .ps1（PowerShell 7），helper 负责把那几处 Windows 绑定拆掉。
. (Join-Path $PSScriptRoot 'common.ps1')

function Step($msg) { Write-Host ("`n=== $msg ===  [" + (Get-BjNow).ToString('HH:mm:ss') + "]") -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [!]  $msg" -ForegroundColor Yellow }

# 下面所有原生命令（python / node）都接一个 `| Out-Host`。
#
# 为什么：PowerShell 5.1 里原生命令的 stdout 是直接写控制台句柄的，
# 不经过 PowerShell 的输出流 —— 所以 Start-Transcript **抓不到它**。
# 一旦被重定向（`| Tee-Object`、`*>&1`），Write-Host 能抓到、原生命令抓不到，
# 日志就会缺一大半。
#
# 接上 Out-Host 之后，原生输出改走 host：
#   - 屏幕上照样一行一行实时刷（Out-Host 是流式的）
#   - 颜色不受影响（本来原生命令也没颜色）
#   - Start-Transcript 能完整抓到 —— 一键更新.cmd 的日志就靠这个
#
# 代价：`powershell -File daily.ps1 > out.txt` 这种重定向会抓不到原生命令输出
# （跟 Write-Host 一样只走控制台）。项目里日志走 transcript，不用那种重定向。
#
# 注意：**不要**给这些命令加 `2>&1`。
# PS 5.1 里 `2>&1` 会把 stderr 转成 ErrorRecord，
# 而本脚本 $ErrorActionPreference='Stop'，遇到 ErrorRecord 直接抛异常 ——
# python 打一行无害的 warning 就能把整轮准备干掉（publish.ps1 里为 npx 踩过同一个坑）。

# ── 0. 环境准备 ─────────────────────────────────────────────
Step '0/5 准备环境'

# 找 python。
#
# 注意：不能只看「文件存在」—— WindowsApps 目录里有个 python.exe 占位符，
# 它在 PATH 里而且文件确实存在，但只是微软商店的跳转壳，
# 跑起来直接 exit 9009（命令找不到）。
# 所以每个候选都要实际跑一次 --version，跑通才算数。
$candidates = @()
foreach ($cmd in @('python', 'python3', 'py')) {
  $c = Get-Command $cmd -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue
  if ($c) { $candidates += $c }
}
if (Test-IsWindowsHost) {
  # 路径一律用 Join-Path + 正斜杠拼 —— Windows 照样认（Win32 接受正斜杠），
  # 但源码里不留反斜杠：反斜杠在 macOS 上是**合法文件名字符**，
  # 照抄到 macOS 会把 "C:\some-root" 当成一个文件名。
  $candidates += Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs/Python') -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName 'python.exe' }
  $candidates += Get-ChildItem 'C:/Python3*' -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName 'python.exe' }
} else {
  # macOS / Linux：Homebrew 的 python3。
  # Intel 装在 /usr/local，Apple Silicon 装在 /opt/homebrew —— PATH 里通常已经有了，
  # 这里只是兜底（有些安装方式不往 PATH 里塞）。
  # 注意 macOS 自带的 /usr/bin/python3 是**占位壳**，跑 --version 会失败，
  # 下面那个「实际跑一次 --version」的判据会把它刷掉。
  $candidates += @('/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3')
}

$py = $null
foreach ($c in ($candidates | Select-Object -Unique)) {
  if (-not $c -or -not (Test-Path $c)) { continue }
  & $c --version *> $null
  if ($LASTEXITCODE -eq 0) { $py = $c; break }
}
if (-not $py) {
  $hint = if (Test-IsWindowsHost) { 'winget install --id Python.Python.3.12 -e' } else { 'brew install python@3.12' }
  throw ('找不到可用的 python。装一个：' + $hint +
         "`n（试过的候选：$($candidates -join ', ')）")
}
Ok "python: $py"

# 依赖自检（缺了就装）
$need = @('requests', 'bs4', 'lxml', 'PIL', 'imagehash', 'cv2')
$missing = @()
foreach ($m in $need) {
  & $py -c "import $m" 2>$null
  if ($LASTEXITCODE -ne 0) { $missing += $m }
}
if ($missing.Count) {
  Warn "缺依赖：$($missing -join ', ')，正在安装…"
  # opencv 必须锁 4.x —— 5.x 删掉了 Haar 级联（人像分流要用）
  & $py -m pip install requests beautifulsoup4 lxml Pillow imagehash "opencv-python-headless<5"
  if ($LASTEXITCODE -ne 0) { throw "pip 安装失败（exit $LASTEXITCODE）" }
}
Ok '依赖齐全'

# ── 日期：内容日期（默认昨天） vs 发布日期（北京今天）─────────
$bjNow = Get-BjNow
$publishDate = $bjNow.ToString('yyyy-MM-dd')
if (-not $ContentDate) {
  $ContentDate = $bjNow.AddDays(-1).ToString('yyyy-MM-dd')
}
Ok "内容日期 $ContentDate  ->  发布日期 $publishDate"

# 记下这次要发布的日期。
# publish.ps1 不带 -Date 时读它 —— 这样「准备」和「发布」算出来的日期一定对得上，
# 不会出现「页面写 10-27、图却是 10-26 的」这种错位。
[System.IO.File]::WriteAllText((Join-Path $Root '.publish-date'), $publishDate, [System.Text.Encoding]::ASCII)

# ── 1. 抓图 ─────────────────────────────────────────────────
if (-not $NoGrab) {
  Step '1/5 抓图 + 目录分流'
  $grabArgs = @('tools/grab/daily_grab_all.py', '--date', $ContentDate)
  if ($Out) { $grabArgs += @('--out', $Out) }
  # ⚠️ **抓图时间预算**（2026-11-25 加）：
  #   抓图耗时随上游波动剧烈（实测 446 / 573 / 675 / 638 / 1701 秒），
  #   而这台机器每晚 01:12~03:12 自动关机、发布 00:10 起跑
  #   → 上游一慢就可能**跑到一半被关机硬杀**（历史上 11-14/11-15 就是这个形态）。
  #   给它一个总预算：超了就带着已抓到的素材继续，剩下的源跳过
  #   → 宁可少几张图，这一期也要按时发出去。
  #
  #   0 = 不限（默认，手动跑时保持原行为）。夜间流程由 night-publish.ps1 传 1500 秒（25 分钟）。
  $budget = [int]$env:MEMES_GRAB_BUDGET_SEC
  if ($budget -lt 0) { $budget = 0 }
  $env:MEMES_GRAB_BUDGET_SEC = "$budget"
  & $py @grabArgs | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "抓图失败（exit $LASTEXITCODE）" }
} else {
  Step '1/5 跳过抓图（-NoGrab）'
}

# ── 2. 抓头条 ───────────────────────────────────────────────
if (-not $NoHeadlines) {
  Step '2/5 抓头条（见报的分类目录）'
  $headArgs = @('tools/grab/daily_headlines.py')
  if ($Out) { $headArgs += @('--out', $Out) }
  & $py @headArgs | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "抓头条失败（exit $LASTEXITCODE）" }
} else {
  Step '2/5 跳过抓头条（-NoHeadlines）'
}

# ── 3. 清洗图片 ─────────────────────────────────────────────
# 剔除广告图 / 废图 / 重复图。
# 必须在构建之前做 —— 构建从源图目录读，清洗后数量变了，
# 序号会重排，manifest 和 R2 一起重建才对得上。
#
# 注意这里传的是 $publishDate，不是 $ContentDate：
#   daily_grab_all.py 的 --date 是「内容日期」（抓哪天的内容），
#   但它落盘的目录是「发布当天」（bj_today）——
#   站点「日期页 = 目录名」，所以图在 src\<发布日>\ 里。
#   清洗必须跟着落盘目录走。之前传的是 $ContentDate，
#   结果洗的是昨天那个已经发过的目录，新抓的图一张都没洗到。
$cleaned = $false
if (-not $NoClean) {
  Step '3/5 清洗图片（剔广告 / 剔废图 / 剔重复）'
  $cleanArgs = @('tools/grab/clean_images.py', '--date', $publishDate)
  if ($Out) { $cleanArgs += @('--src-root', $Out) }
  & $py @cleanArgs | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "清洗图片失败（exit $LASTEXITCODE）" }
  $cleaned = $true
} else {
  Step '3/5 跳过清洗（-NoClean）'
}

# ── 4. 抓榜单 + 追更（听乐 / 看片 五段的静态数据）────────────
#
# 为什么以前没有这一步（2026-11-16 补上）：
#   榜单（听乐 + 看片的电影/视频段）和追更（看片的频道更新/本地演出段）
#   都是**构建期静态数据** —— build.mjs 只读 src\<日期>\rank_<日期>.json
#   和 follow_<日期>.json，**它自己不会抓**。
#   以前这两份文件只有 11-16 那一期有（手工跑抓取器跑的），
#   其余各期源目录里根本没有 → 构建时静默跳过 → 站点只有 4 个 tab。
#   看片 v3 把两块并进「看片」之后，漏抓的后果从「tab 不存在」
#   变成「看片只有 2~3 个目录」—— 看着像网站坏了，更难看出是漏抓。
#
# 失败怎么办：**只警告，不中断**。
#   榜单/追更是补充内容，图片才是主体 —— 抓不到就不该让整期发不出去。
#   但「缺段」必须看得见：构建那一步会点名报缺了哪几段
#   （清单在 build.mjs 的 WATCH_SECTIONS）。
#
# 日期传 $publishDate（不是 $ContentDate）：
#   抓取器的 --date 是**期号**（= 发布日），它写 src\<期号>\rank_<期号>.json，
#   构建读的也是同一个 —— 两边必须同一个日期。
#
# 不加 2>&1：PS 5.1 会把原生命令的 stderr 转成 ErrorRecord，
# 而这个脚本顶着 $ErrorActionPreference='Stop' —— 一行 warning 就能掀翻整轮
# （2026-11-14/15 两次发布就是这么死的）。
if (-not $NoRank) {
  Step '4/5 抓榜单 + 追更（听乐 / 看片 五段的大目录数据）'
  foreach ($fetcher in @('tools/fetch-rank.mjs', 'tools/fetch-follow.mjs')) {
    & node $fetcher --date $publishDate | Out-Host
    if ($LASTEXITCODE -ne 0) {
      Warn "$fetcher 失败（exit $LASTEXITCODE）—— 看片会少几段，继续（图片是主体）"
    }
  }
} else {
  Step '4/5 跳过抓榜单 + 追更（-NoRank）'
}

# ── 5. 构建（只构建，不上传不部署）────────────────────────────
# 上传之前必须有人审稿，所以这一步到构建为止就停。
Step '5/5 构建（本地，不上传）'
$buildArgs = @('tools/build.mjs', '--date', $publishDate)
if ($NoConvert) { $buildArgs += '--no-convert' }
& node @buildArgs | Out-Host
if ($LASTEXITCODE -ne 0) { throw "构建失败（exit $LASTEXITCODE）" }

# 之前的审稿凭证对这次构建不作数 —— 内容变了
$stalePass = Join-Path $Root ".review-passed-$publishDate"
if (Test-Path $stalePass) {
  Remove-Item $stalePass -Force
  Write-Host '  (旧的审稿凭证已作废 —— 重新构建过了)' -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '════════════════════════════════════════════' -ForegroundColor Cyan
Write-Host '  准备完成，下一步：审稿' -ForegroundColor Cyan
Write-Host '════════════════════════════════════════════' -ForegroundColor Cyan
Write-Host ''
Write-Host "  1) 开审稿台：  node tools/review.mjs $publishDate" -ForegroundColor Yellow
Write-Host "  2) 浏览器打开 http://localhost:8789/" -ForegroundColor Yellow
Write-Host "  3) 检查全部图片；有要删的勾掉点「应用勾选」" -ForegroundColor Yellow
Write-Host "  4) 确认没问题点「通过审核」" -ForegroundColor Yellow
Write-Host "  5) 发布：审稿台里点「通过审核并发布」（一键重建+上传+部署），" -ForegroundColor Yellow
Write-Host "     或者再跑发布：" -ForegroundColor Yellow
Write-Host ""
Write-Host "     powershell -ExecutionPolicy Bypass -File tools/publish.ps1 -Date $publishDate" -ForegroundColor White
Write-Host ''
