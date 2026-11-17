<#
.SYNOPSIS
    每日图片站一键发布：构建 -> 上传图片到 R2 -> 部署 Pages。

.DESCRIPTION
    自动识别 R2 是否可用：
      - R2 已启用且 bucket 存在  -> 图片传 R2，部署带 R2 binding（体积小、可撤回）
      - R2 还没启用              -> 图片打进静态产物做兜底，临时摘掉 R2 binding
    两种模式都能正常出图，区别只在图片放哪、能不能随时撤回。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools/publish.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools/publish.ps1 -Date 2026-10-25

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools/publish.ps1 -SkipUpload
#>
param(
  [string]$Date,
  [string]$Src,
  [string]$SiteUrl,
  [string]$Project,
  [switch]$SkipUpload,
  [switch]$SkipDeploy,
  [switch]$SkipBuild,
  [switch]$ForceStatic,
  # 复用已转码的图片，只重建页面（改 RSS 配置这类不需要重转码的改动用它，快 5 倍）
  [switch]$NoConvert,
  # 沿用这一期已发布的 manifest：只改样式/前端时用，内容一个字都不动
  # （见报是构建期实时抓的，普通构建会顺手把内容换掉 —— 跟本次改动无关的线上变更）
  [switch]$KeepManifest,
  # 跳过审稿闸门（明知风险时用，比如补发某一天的漏图）
  [switch]$SkipReview,
  # 跳过刷新头条（见报的热榜）。
  # 默认会刷新**当期**（-Date == 北京今天）的热榜 —— 头条是抓取时刻的快照，
  # 构建期只读不重抓，想让用户看到最新只能在构建前重抓。
  # 往期补发一律不刷（把今天的热榜写进往期那一期 = 内容时间倒错）。
  [switch]$NoHeadlines
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# 跨平台公共 helper（北京时间 / 起子进程的 shell / 图像根目录 / 路径拼接）。
# macOS 上跑的是同一份 .ps1（PowerShell 7），helper 负责把那几处 Windows 绑定拆掉。
. (Join-Path $PSScriptRoot 'common.ps1')

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

# ── 原生命令统一入口 ──────────────────────────────────────────────
#
# 为什么必须有这个（2026-11-15 实测的真凶，两次发布都被它腰斩）：
#   PowerShell 5.1 里，原生命令（node / npx / python）往 **stderr** 写一行字，
#   就会被转成 ErrorRecord；而本脚本 $ErrorActionPreference='Stop' ——
#   ErrorRecord 直接变成**终止性错误**，脚本当场死掉。
#
#   现场：11-14 与 11-15 两次发布都停在构建的「见报抓取」阶段，日志最后一行是
#   「✓ 产物自检通过」，之后什么都没有 —— 连 runner 的结束标记都没写出来。
#   真凶是构建里这一句（fetch-rss.mjs:57，本机每天都会遇到）：
#     ! 抓取过程中连接被重置（undici 已知崩溃），该源按失败处理，继续
#   它只是**提示**（那个源按失败处理、其余照常），build 自己会接着跑完 ——
#   但 publish.ps1 被这行 stderr 掀翻了：R2 没上传、Pages 没部署，
#   审稿台那边只看到「发布中…」一直转，最后什么也没发出去。
#
# 所以：所有原生命令都必须先降成 Continue，成败只看 $LASTEXITCODE
#（native 自己的退出码），不看 stderr 有没有字。部署那一步早就是这么写的
#（见下面 6/6），只是构建、产物自检、R2 探测、上传这几步漏了。
function Invoke-NativeCmd {
  param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [string[]]$NativeArgs = @()
  )
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    # stdout 必须继续往调用方的管道流 —— 发布日志（审稿台的进度面板）靠它刷新。
    #
    # ⚠️ **不能写成 `$x = & $Exe ...`**：那样 stdout 会被函数吞进返回值，
    # 返回值就不再只是退出码（`if ($rc -ne 0)` 会误判成失败），
    # 而且原生命令的每一行也不会进发布日志 —— 2026-11-15 踩过这个坑。
    # 退出码改用脚本级变量带出来：$script:NativeExit。
    & $Exe @NativeArgs
    $script:NativeExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevEap
  }
}

# 需要把输出抓回来自己看的场合（部署失败时要从里面找 ECONNRESET）。
function Invoke-NativeCmdCapture {
  param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [string[]]$NativeArgs = @()
  )
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $Exe @NativeArgs 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevEap
  }
  return @{ Out = $out; Code = $code }
}

# 找一个能用的 python。
#
# 为什么不能只看「路径里有 python.exe」：WindowsApps 目录里有个占位的
# python.exe，它在 PATH 里、文件也确实存在，但只是微软商店的跳转壳，
# 跑起来直接 exit 9009（命令找不到）。
# 所以每个候选都要**实际跑一次 --version**，跑通才算数（与 tools/daily.ps1 同一套判据）。
function Find-Python {
  $candidates = @()
  foreach ($cmd in @('python', 'python3', 'py')) {
    $c = Get-Command $cmd -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue
    if ($c) { $candidates += $c }
  }
  if (Test-IsWindowsHost) {
    # 路径用 Join-Path + 正斜杠拼 —— Windows 照样认（Win32 接受正斜杠），
    # 但源码里不留反斜杠：反斜杠在 macOS 上是**合法文件名字符**。
    $candidates += Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs/Python') -Directory -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName 'python.exe' }
  } else {
    # macOS / Linux：Homebrew 的 python3（Intel 在 /usr/local，Apple Silicon 在 /opt/homebrew）。
    # PATH 里通常已经有了，这里只是兜底。
    $candidates += @('/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3')
  }
  foreach ($c in ($candidates | Select-Object -Unique)) {
    if (-not $c -or -not (Test-Path $c)) { continue }
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      & $c --version *> $null
      $ok = ($LASTEXITCODE -eq 0)
    } finally {
      $ErrorActionPreference = $prevEap
    }
    if ($ok) { return $c }
  }
  return $null
}

# helper 用的退出码出口（每次调用都会刷新）
$script:NativeExit = 0

# ── 0. 刷新 Cloudflare token ──────────────────────────────────
# wrangler 登录拿到的 OAuth token 只有几小时寿命，过期后所有调用都会
# 报 "Invalid access token / Max auth failures reached"，而且失败次数
# 过多 Cloudflare 会临时锁掉 token，连 refresh 都做不了。
# 这里在每次发布前先续期，并把新 token 同步回 .env.local。
Step '1/6 刷新 Cloudflare token'
Invoke-NativeCmd 'node' @('tools/refresh-token.mjs')
if ($script:NativeExit -ne 0) {
  Write-Host '  ! token 续期失败，仍继续尝试（可能是网络抖动）' -ForegroundColor Yellow
}

# ── 0.5 加载 .env.local（必须在续期之后，否则拿到的是过期副本） ──
#
# 做成函数是因为**要用两次**：开头一次，上传前续完期再一次。
# 续期只改 .env.local，**不改本进程的环境变量** —— 而子进程
# （upload-r2.mjs）继承的是**本进程**的环境变量，
# 不重新导入的话，它拿到的还是那个已经过期的 token（2026-11-15 踩过：
# 上传到一半 249 个文件 401 code 10000，整次发布 exit 1）。
function Import-EnvFile {
  $envFile = Join-Path $Root '.env.local'
  if (-not (Test-Path $envFile)) { return }
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$') {
      $k = $Matches[1]; $v = $Matches[2].Trim('"').Trim("'")
      # token 必须强制覆盖：第 1 步刚把最新 token 写进 .env.local，
      # 父进程（长驻的审稿台）里可能还残留着过期副本，
      # 而「已存在就不写」会让那份过期的赢，R2 探测直接 401。
      if ($k -eq 'CLOUDFLARE_API_TOKEN' -or -not [Environment]::GetEnvironmentVariable($k)) {
        [Environment]::SetEnvironmentVariable($k, $v)
      }
    }
  }
}
Import-EnvFile

if (-not $SiteUrl) { $SiteUrl = $env:SITE_URL }
if (-not $Project) { $Project = $env:PAGES_PROJECT }
if (-not $Project) { $Project = 'your-project' }
$Bucket = $env:R2_BUCKET
if (-not $Bucket) { $Bucket = 'your-bucket' }

# R2 binding 段的开关：wrangler.toml 里用标记注释包住，缺了 R2 时临时摘掉
$WranglerToml = Join-Path $Root 'wrangler.toml'

function Set-R2Binding([bool]$On) {
  $text = [System.IO.File]::ReadAllText($WranglerToml)

  # 先把现有的 [[r2_buckets]] 段清干净 —— 两种形态都要清：
  #   1) 带标记注释的（# >>> R2_BINDING_BEGIN ... # <<< R2_BINDING_END）
  #   2) 裸的（历史上手写进文件、没有标记的）
  # 只清其中一种的话，开关就是个摆设：静态模式摘不掉裸段，
  # R2 模式又加不上缺失的标记块，结果 wrangler.toml 永远不声明这个绑定。
  $text = [regex]::Replace($text, '(?ms)^# >>> R2_BINDING_BEGIN.*?^# <<< R2_BINDING_END\r?\n?', '')
  $text = [regex]::Replace($text, '(?ms)^\s*\[\[r2_buckets\]\].*?(?=^\[|\z)', '')

  if ($On) {
    $block = "# >>> R2_BINDING_BEGIN`r`n[[r2_buckets]]`r`nbinding = `"IMAGES`"`r`nbucket_name = `"$Bucket`"`r`n# <<< R2_BINDING_END`r`n"
    $text = $text.TrimEnd() + "`r`n`r`n" + $block
  }

  [System.IO.File]::WriteAllText($WranglerToml, $text, (New-Object System.Text.UTF8Encoding($false)))
}

# ── 0.6 定下发布日期 ─────────────────────────────────────────
# 不带 -Date 时：
#   1) 优先用 daily.ps1 记下来的 .publish-date（准备阶段算出来的发布日期）
#   2) 都没有就用北京今天
#
# 为什么必须在这里定死：
#   - 审稿闸门要按日期找凭证
#   - build.mjs 不给 --date 会去取「源目录里最新的那个」，
#     可能跟准备阶段算的发布日期对不上（页面写 10-27，图却是 10-26 的）
if (-not $Date) {
  $bjNow = Get-BjNow
  $today = $bjNow.ToString('yyyy-MM-dd')
  $Date = $today
  $dateFile = Join-Path $Root '.publish-date'
  if (Test-Path $dateFile) {
    $candidate = (Get-Content $dateFile -Raw).Trim()
    # .publish-date 可能是上次的残留 —— 源目录里没有这一期就不能用它，
    # 否则会发布一个「有页面没图」的日期。
    $srcRoot = Get-ImageRoot
    $candidateDir = Get-SourceDateDir -Date $candidate
    if ($candidate -match '^\d{4}-\d{2}-\d{2}$' -and (Test-Path $candidateDir)) {
      $Date = $candidate
    } else {
      Write-Host "  (.publish-date 是 $candidate，但源目录里没有这一期，改用 $today)" -ForegroundColor DarkGray
    }
  }
}
if ($Date -notmatch '^\d{4}-\d{2}-\d{2}$') {
  throw "日期格式不对：'$Date'（应为 YYYY-MM-DD）"
}
Write-Host "  发布日期 : $Date" -ForegroundColor DarkGray

# ── 1. 构建 ───────────────────────────────────────────────
if ($SkipBuild) {
  Step '2/6 跳过构建（复用 published/ 现有产物）'
} else {
  # ── 1a 刷新头条（见报的热榜）─────────────────────────────
  #
  # 头条是**抓取时刻的快照**，构建期只读不重抓（tools/headlines.mjs）。
  # 所以「用户看到最新」这件事，只能靠在**构建之前**重抓一次。
  #
  # 只对**当期**刷（-Date == 北京今天）：往期补发时如果也刷，
  # 等于把今天的热榜写进往期那一期 —— 内容时间倒错。
  # 所以这里有日期守卫，不是开关说了算。
  #
  # 刷新失败不阻断发布（网络抖动时沿用旧快照，构建期会打「已过 N 分钟」的告警）。
  $bjToday = Get-BjDate
  if ($NoHeadlines) {
    Write-Host '  头条：按要求跳过刷新' -ForegroundColor DarkGray
  } elseif ($Date -ne $bjToday) {
    Write-Host "  头条：往期（$Date ≠ 今天 $bjToday），不刷新（别把今天的热榜写进往期）" -ForegroundColor DarkGray
  } else {
    Write-Host '  头条：刷新当期热榜（构建期只读不重抓，过期了只能这样续命）' -ForegroundColor DarkGray
    $pyExe = Find-Python
    if ($pyExe) {
      Invoke-NativeCmd $pyExe @('tools/grab/daily_headlines.py')
      if ($script:NativeExit -ne 0) {
        Write-Host '  ! 头条刷新失败，沿用旧快照（不影响发布）' -ForegroundColor Yellow
      }
    } else {
      Write-Host '  ! 找不到 python，跳过头条刷新（沿用旧快照）' -ForegroundColor Yellow
    }
  }

  # ── 1b 记下旧 manifest 的对象键（孤儿清理的前半段）──────
  #
  # 构建会删掉旧的 manifest.*.js，之后就再也拿不到「上一代引用了哪些对象」。
  # 孤儿 = 旧 manifest 引用过、且新 manifest 不再引用的那些 R2 对象
  # （审稿删一张图 → 序号平移 → 整期换名 → 旧对象没人引用了，却一直占着空间）。
  # 抓不到不阻断发布，只是这次不清理。
  Invoke-NativeCmd 'node' @('tools/orphan-clean.mjs', '--date', $Date, '--capture')
  if ($script:NativeExit -ne 0) {
    Write-Host '  ! 旧键集没抓到，这次不做孤儿清理（不影响发布）' -ForegroundColor Yellow
  }

  Step '2/6 构建页面与图片'
  $buildArgs = @('tools/build.mjs', '--date', $Date)
  if ($Src)     { $buildArgs += @('--src', $Src) }
  if ($SiteUrl) { $buildArgs += @('--site-url', $SiteUrl) }
  if ($NoConvert) { $buildArgs += @('--no-convert') }
  if ($KeepManifest) { $buildArgs += @('--keep-manifest') }
  Invoke-NativeCmd 'node' $buildArgs
  if ($script:NativeExit -ne 0) { throw "构建失败（exit $script:NativeExit）" }
}

# 产物自检：manifest 里引用的每一张图，都必须真的在 R2 母本里。
#
# 为什么必须放在上传之前：
#   页面从 manifest 读图片 URL，图片本体在 R2。两边对不上，线上就是一个
#   裂图格子 —— 构建日志不会报这个错（构建只管自己写出来的那个清单），
#   只有真正去磁盘上点一遍名才会发现。
#
#   踩过（2026-10-28）：删掉中间一张图后序号前移，随机段跟着变，
#   --no-convert 复用没对上，manifest 引用了 21 个不存在的文件，
#   构建日志全程报「成功」。不校验就发出去 = 21 张裂图。
Write-Host '  产物自检：manifest ↔ R2 母本' -ForegroundColor DarkGray
Invoke-NativeCmd 'node' @('tools/verify-build.mjs', '--date', $Date)
if ($script:NativeExit -ne 0) {
  throw '产物自检不通过，已中止（manifest 与 R2 母本对不上，发出去就是裂图）'
}

# ── 2. 探测 R2 ─────────────────────────────────────────────
#
# 探测失败（网络抖动）绝不能当成「R2 不可用」——
# 那会静默掉进静态兜底：把 508 张图（20.64MB）打进部署包，
# 部署包从 60KB 涨到 20MB，图片也失去 R2 那套「随时整目录撤回」的能力。
#
# 踩过：token 续期时网络失败，紧接着 R2 探测也跟着失败，
# 脚本一声不响地走了静态兜底，等发现时部署包已经是 20MB 了。
#
# 所以：探测失败先重试；重试还失败就中止，别猜。
Step '3/6 探测 R2 状态'
$r2Mode = $false
if ($ForceStatic) {
  Write-Host '  --ForceStatic：跳过 R2，直接走静态兜底' -ForegroundColor Yellow
} else {
  $r2Exit = 1
  for ($try = 1; $try -le 3; $try++) {
    Invoke-NativeCmd 'node' @('tools/check-r2.mjs')
    $r2Exit = $script:NativeExit
    if ($r2Exit -eq 0 -or $r2Exit -eq 3 -or $r2Exit -eq 4) { break }
    if ($try -lt 3) {
      Write-Host "  ... 探测失败（第 $try 次），3 秒后重试" -ForegroundColor DarkGray
      Start-Sleep -Seconds 3
    }
  }
  if ($r2Exit -eq 0) {
    $r2Mode = $true
    Write-Host '  -> R2 可用，图片走 R2（私有 bucket，可随时撤回）' -ForegroundColor Green
  } elseif ($r2Exit -eq 3) {
    Write-Host '  -> R2 尚未启用，本次改走静态兜底（图片打进部署包）' -ForegroundColor Yellow
  } elseif ($r2Exit -eq 4) {
    Write-Host '  -> R2 已启用但 bucket 不存在，本次改走静态兜底' -ForegroundColor Yellow
    Write-Host '     跑一次 tools/setup-cloudflare.ps1 就能建好 bucket' -ForegroundColor Yellow
  } else {
    Write-Host ''
    Write-Host '  ✗ R2 探测失败（网络问题），已中止发布。' -ForegroundColor Red
    Write-Host '    这里必须停：静默降级成静态兜底会把 508 张图（20.64MB）打进部署包，' -ForegroundColor Red
    Write-Host '    部署包从 60KB 涨到 20MB，图片也失去 R2 那套「随时撤回」的能力。' -ForegroundColor Red
    Write-Host '    网络好了重跑本命令即可。确实要静态兜底就加 -ForceStatic。' -ForegroundColor Yellow
    throw 'R2 探测失败，已中止（没有静默降级成静态兜底）。'
  }
}

# ── 3. 审稿闸门 ──────────────────────────────────────────────
# 上传 R2 之前必须有人看过图。
#
# 为什么这道闸门不能省：
#   自动化抓来的图总会混进广告图、废图、不该出现的写真。
#   以前是「抓完直接上传部署」，发现不对时东西已经发到群里了 ——
#   撤回要等 24 小时边缘缓存，而且链接已经发出去收不回来。
#
# 凭证：.review-passed-<日期>（tools/review.mjs 审完点「通过审核」生成）
#   - 日期对不上就拒绝（防拿昨天的凭证放今天的行）
#   - 凭证里记了通过时的图片数量；现在数量对不上说明图又变了，凭证作废
#   - 凭证里还记了每个分类各多少张；归属变了（比如把图挪到别的栏目）同样作废
#   - 删图会自动删掉凭证（review.mjs 里做的）
if (-not $SkipUpload -and -not $SkipReview) {
  Step '4/6 审稿闸门'
  if (-not $Date) {
    throw '审稿闸门需要知道是哪一天（-Date）。不想审就加 -SkipReview。'
  }
  $passFile = Join-Path $Root ".review-passed-$Date"
  if (-not (Test-Path $passFile)) {
    Write-Host ''
    Write-Host '  ✗ 还没审稿，不能上传。' -ForegroundColor Red
    Write-Host ''
    Write-Host "    1) 开审稿台：  node tools/review.mjs $Date" -ForegroundColor Yellow
    Write-Host "    2) 浏览器打开 http://localhost:8789/ ，检查全部图片" -ForegroundColor Yellow
    Write-Host "    3) 有要删的先在页面上勾掉并点「应用勾选」" -ForegroundColor Yellow
    Write-Host "    4) 确认没问题就点「通过审核」" -ForegroundColor Yellow
    Write-Host "    5) 再跑一次本命令" -ForegroundColor Yellow
    Write-Host ''
    Write-Host '    确实要跳过审稿：加 -SkipReview（不建议）' -ForegroundColor DarkGray
    throw '审稿未通过，已阻止上传。'
  }
  # 校验凭证：日期 + 图片数量
  $pass = $null
  try { $pass = Get-Content $passFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
  if (-not $pass -or $pass.date -ne $Date) {
    throw "审稿凭证无效（日期不匹配）：$passFile"
  }
  # 源图目录：<图像根>/src/<日期>。Get-SourceDateDir 按平台给默认根目录
  # （Windows ~/image-root，macOS ~/image-root），也认 $env:IMAGE_ROOT。
  $srcDir = Get-SourceDateDir -Date $Date
  $nowCount = 0
  $nowCounts = @{}
  foreach ($c in @('见闻', '见她', '见笑')) {
    $d = Join-Path $srcDir $c
    $n = 0
    if (Test-Path $d) {
      $n = (Get-ChildItem $d -File | Where-Object {
        $_.Extension -match '^\.(jpg|jpeg|png|gif|webp|bmp)$' -and $_.Name -notlike '*_t.webp'
      }).Count
    }
    $nowCounts[$c] = $n
    $nowCount += $n
  }
  if ($nowCount -ne $pass.count) {
    Write-Host ''
    Write-Host "  ✗ 图片数量跟审稿时对不上（审稿时 $($pass.count) 张，现在 $nowCount 张）。" -ForegroundColor Red
    Write-Host '    审完又动过图，凭证作废 —— 请重新审一次。' -ForegroundColor Red
    Remove-Item $passFile -Force -ErrorAction SilentlyContinue
    throw '审稿凭证已失效。'
  }
  # 分类归属也要逐个对得上 ——
  # 只比总数会漏掉这一种改动：把 4 张图从「见笑」挪到「见她」，总数一点没变，
  # 但归属变了 —— 而审稿结论是针对「当时那批图和它们的归属」的。
  if (-not $pass.counts) {
    Write-Host ''
    Write-Host '  ✗ 审稿凭证太旧（里面没有分类计数）。' -ForegroundColor Red
    Write-Host '    回到审稿台重新点一次「通过审核」即可。' -ForegroundColor Red
    Remove-Item $passFile -Force -ErrorAction SilentlyContinue
    throw '审稿凭证已失效（缺分类计数）。'
  }
  $catKey = @{ '见闻' = 'jianwen'; '见她' = 'jianshe'; '见笑' = 'jianxiao' }
  $mismatch = @()
  foreach ($c in @('见闻', '见她', '见笑')) {
    $k = $catKey[$c]
    $was = $pass.counts.$k
    if ($null -eq $was) { $was = -1 }
    if ([int]$was -ne [int]$nowCounts[$c]) {
      $mismatch += "$c（审稿时 $was 张，现在 $($nowCounts[$c]) 张）"
    }
  }
  if ($mismatch.Count -gt 0) {
    Write-Host ''
    Write-Host '  ✗ 图片分类跟审稿时对不上：' -ForegroundColor Red
    foreach ($mm in $mismatch) { Write-Host "      $mm" -ForegroundColor Red }
    Write-Host '    审完又动过图，凭证作废 —— 请重新审一次。' -ForegroundColor Red
    Remove-Item $passFile -Force -ErrorAction SilentlyContinue
    throw '审稿凭证已失效（分类归属变了）。'
  }
  $breakdown = @()
  foreach ($c in @('见闻', '见她', '见笑')) { $breakdown += "$c $($nowCounts[$c])" }
  Write-Host "  ✓ 审稿通过（$Date，$nowCount 张：$($breakdown -join ' / ')，审于 $($pass.passedAt)）" -ForegroundColor Green
} else {
  Step '4/6 跳过审稿闸门'
}

# ── 4. 备好图片 ───────────────────────────────────────────
# ── 4.5 上传前再续一次 token ─────────────────────────────────
#
# 为什么（2026-11-15 实测的真凶之二）：
#   Cloudflare 的 OAuth token **只活 1 小时**（expires_in = 3600）。
#   一次发布要走完「构建（可能十几分钟）→ 产物自检 → R2 探测 → 审稿闸门
#   → 上传（可能十几分钟）→ 部署」—— 整条链路完全可能跨过过期点。
#   2026-11-14 那次发布：开头续期时 token 还剩 12 分钟（判断「有效」放行），
#   上传到一半 token 过期 → **249 个文件 401 code 10000** →
#   整次发布 exit 1，R2 只传了一半，Pages 根本没部署。
#
#   所以：上传前必须再续一次，而且要把新 token **重新导进本进程的环境变量**
#   （续期只改 .env.local；子进程 upload-r2.mjs 继承的是本进程的环境变量）。
Invoke-NativeCmd 'node' @('tools/refresh-token.mjs')
if ($script:NativeExit -ne 0) {
  Write-Host '  ! 上传前续期失败，沿用当前 token（可能是网络抖动）' -ForegroundColor Yellow
}
Import-EnvFile

if (-not $SkipUpload) {
  if ($r2Mode) {
    Step '5/6 上传图片到 R2'
    $upArgs = @('tools/upload-r2.mjs')
    if ($Date) { $upArgs += $Date }
    Invoke-NativeCmd 'node' $upArgs
    if ($script:NativeExit -ne 0) { throw "R2 上传失败（exit $script:NativeExit）" }
  } else {
    Step '5/6 暂存图片到静态产物（R2 兜底）'
    $stArgs = @('tools/stage-static-images.mjs')
    if ($Date) { $stArgs += $Date }
    Invoke-NativeCmd 'node' $stArgs
    if ($script:NativeExit -ne 0) { throw "静态暂存失败（exit $script:NativeExit）" }
  }
} else {
  Step '5/6 跳过图片上传'
}

# ── 4. 部署 ───────────────────────────────────────────────
if (-not $SkipDeploy) {
  Step "6/6 部署 Cloudflare Pages（项目 $Project）"

  # wrangler 4.x 不会自动建项目，先确认一下
  #
  # 同样要避开 `2>&1` + ErrorActionPreference='Stop' 的坑（见下面部署那段的说明）：
  # npx 的 "npm notice" 会被当成 ErrorRecord 抛出来。
  # 走 Invoke-NativeCmdCapture：它内部已经降成 Continue，并把 stderr 合流进 Out。
  $pl = Invoke-NativeCmdCapture 'npx' @('--yes', 'wrangler@latest', 'pages', 'project', 'list')
  $projectList = $pl.Out
  $listCode = $pl.Code
  # 列表查询失败 ≠ 项目不存在。
  #
  # 踩过（2026-11-05）：国内链路到 api.cloudflare.com 会间歇性 ECONNRESET，
  # `pages project list` 失败时 stdout 是空的 → 旧逻辑判成「项目不存在」→
  # 去执行 `pages project create` → create 当然也失败 → 报「Pages 项目创建失败」，
  # 而真实原因只是网络抖动，跟项目存不存在毫无关系。
  #
  # 所以：列表查询失败必须自己中止，不能替它猜「项目不存在」。
  if ($listCode -ne 0) {
    throw "查询 Pages 项目列表失败（exit $listCode）。网络抖动不能当成「项目不存在」，已中止（没做任何创建/部署动作）。"
  }
  $exists = ($projectList | Select-String -SimpleMatch $Project)
  if (-not $exists) {
    Write-Host "  项目不存在，先创建：$Project"
    Invoke-NativeCmd 'npx' @('--yes', 'wrangler@latest', 'pages', 'project', 'create', $Project, '--production-branch', 'main')
    if ($script:NativeExit -ne 0) { throw "Pages 项目创建失败（exit $script:NativeExit）" }
  }

  # binding 段：R2 模式必须有（Function 靠它读图），静态模式必须摘掉
  # （否则 Function bundle 会因 bucket 不存在而部署失败）。
  #
  # 关键是 R2 模式也要显式补上 —— wrangler.toml 里的 binding 段有可能被上一次
  # 静态模式发布摘掉之后没恢复。那样部署出去的是「没有 R2 绑定」的 Function，
  # 图片会静默回退到静态兜底；而静态兜底这时已经被上传脚本清掉了，
  # 结果就是页面能开、图片全挂，而且不报错。
  $bindingRestored = $false
  if (-not $r2Mode) {
    Set-R2Binding $false
    $bindingRestored = $true
  } else {
    Set-R2Binding $true
  }

  try {
    # 这里必须临时把 ErrorActionPreference 改成 Continue。
    #
    # 为什么：PowerShell 5.1 里 `2>&1` 会把原生命令的 stderr 转成 ErrorRecord，
    # 而 $ErrorActionPreference='Stop' 遇到 ErrorRecord 就直接抛异常 ——
    # 于是 npx 打的 "npm notice ..." 提示会被当成本次发布的致命错误，
    # 脚本在部署其实已经成功之后自己 throw 掉，exit=1。
    #
    # 真正的成功与否看 $LASTEXITCODE（wrangler 自己的退出码），不看 stderr 有没有字。
    #
    # 部署本身要重试（2026-11-05 加）：
    #   国内链路到 api.cloudflare.com 会间歇性 ECONNRESET
    #   （Client network socket disconnected before secure TLS connection was established），
    #   wrangler 自己的重试窗口（约 60 秒）不够，于是一次抖动就让整次发布失败。
    #   部署是幂等的（失败就是失败，不会留半成品版本），重试安全。
    $out = @()
    $code = 1
    for ($try = 1; $try -le 4; $try++) {
      # 走 Invoke-NativeCmdCapture：它已经把 ErrorActionPreference 降成 Continue，
      # 并把 stderr 合流进 $out（下面要找 ECONNRESET 就是从 $out 里找）。
      $r = Invoke-NativeCmdCapture 'npx' @('--yes', 'wrangler@latest', 'pages', 'deploy', 'published', '--project-name', $Project, '--branch', 'main', '--commit-dirty=true')
      $out = $r.Out
      $code = $r.Code
      if ($code -eq 0) { break }
      Write-Host ''
      Write-Host "  ... 部署失败（第 $try 次，exit $code）" -ForegroundColor DarkGray
      if ($out -match 'ECONNRESET|disconnected before secure TLS|fetch failed|ENOTFOUND|ETIMEDOUT') {
        Write-Host '     原因：到 api.cloudflare.com 的网络连接被重置（国内链路抖动）' -ForegroundColor DarkGray
      }
      if ($try -lt 4) {
        $wait = 10 * $try
        Write-Host "     $wait 秒后重试 …" -ForegroundColor DarkGray
        Start-Sleep -Seconds $wait
      }
    }
    $out | ForEach-Object { Write-Host $_ }
    if ($code -ne 0) {
      if ($out -match 'R2 bucket .* not found') {
        Write-Host ''
        Write-Host '  R2 bucket 不存在。处理办法：' -ForegroundColor Yellow
        Write-Host '    1) Cloudflare Dashboard -> R2 -> 启用 R2' -ForegroundColor Yellow
        Write-Host '    2) 重跑 tools/setup-cloudflare.ps1（它会建 bucket）' -ForegroundColor Yellow
        Write-Host '    3) 再跑一次本脚本' -ForegroundColor Yellow
      }
      throw "Pages 部署失败（exit $code，已重试 4 次）"
    }
  } finally {
    # 还原 wrangler.toml，保证下次发布默认还是 R2 模式
    if ($bindingRestored) { Set-R2Binding $true }
  }

  $deployUrl = ($out | Select-String -Pattern 'https://[^\s]+\.pages\.dev' | Select-Object -Last 1)
  if ($deployUrl) {
    $url = $deployUrl.Matches[0].Value
    Write-Host ''
    Write-Host "  线上地址 : $url" -ForegroundColor Green
  }
} else {
  Step '6/6 跳过 Pages 部署'
}

# ── 4.5 清掉这一期的孤儿对象（**部署成功之后**才清）────────────
#
# 为什么放在部署之后，而不是上传之后（2026-11-15 晚改）：
#   上传完那一刻，线上还指着**旧 manifest** —— 这时候删旧对象，
#   等于把**线上正在用的图删了**（页面直接裂图）。
#   更糟的是：**Pages 部署要是失败**，线上就一直指着旧 manifest，
#   而它的对象已经被删了 → **线上永久裂图**，直到下一次发布成功才恢复。
#   部署成功之后，线上指的是新 manifest，旧对象没人引用了，这时候删才安全。
#
# 只有「既构建了、又上传了、又部署了」才清：
#   - 没构建（-SkipBuild）：没有新的一代，旧的仍然是当前这一代
#   - 没上传（-SkipUpload）：新对象根本不在 R2 里
#   - 没部署（-SkipDeploy）：线上还指着旧 manifest → 删旧的 = 把线上正在用的图删了
#
# 清不掉不阻断发布 —— 站点已经发上去了，旧对象只是白占空间。
if (-not $SkipUpload -and -not $SkipBuild -and -not $SkipDeploy) {
  Write-Host '  清理孤儿对象（审稿删图会让整期换名，旧对象没人引用了）' -ForegroundColor DarkGray
  Invoke-NativeCmd 'node' @('tools/orphan-clean.mjs', '--date', $Date, '--sweep')
  if ($script:NativeExit -ne 0) {
    Write-Host '  ! 孤儿清理没成功（旧对象还在 R2 里占着空间）—— 不影响本次发布' -ForegroundColor Yellow
  }
}

Write-Host "`n发布完成。" -ForegroundColor Green
if ($SiteUrl) {
  Write-Host "分享链接 : $SiteUrl/" -ForegroundColor Green
  if ($Date) { Write-Host "当天页面 : $SiteUrl/$Date/" -ForegroundColor Green }
  Write-Host "往期列表 : $SiteUrl/archive/" -ForegroundColor Green
  Write-Host "RSS 订阅 : $SiteUrl/feed.xml" -ForegroundColor Green
  # 分享卡片是**按 URL 缓存**的：微信把链接抓一次就把卡片存下来了。
  # 根链接永远是同一个 URL -> 它的卡片会停在缓存的那一天。
  # 当天页面链接的 URL 每期都不同 -> 微信每次都会重新抓 -> 卡片是当期的
  # （每期一张 1200x630 的分享图，见 tools/build-og.mjs）。
  if ($Date) {
    Write-Host '  （想让分享卡片显示当期的图，就发「当天页面」那条链接 —— 根链接的卡片被微信缓存住了）' -ForegroundColor DarkGray
  }
}
if (-not $r2Mode -and -not $SkipDeploy) {
  Write-Host ''
  Write-Host '提示：本次图片走的是静态兜底。启用 R2 后重跑本脚本，图片会自动切到私有 bucket。' -ForegroundColor Yellow
}
