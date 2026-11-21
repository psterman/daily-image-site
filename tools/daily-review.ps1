<#
.SYNOPSIS
    一键每日准备：抓图 → 头条 → 清洗 → 榜单/追更 → 构建 → 校验 → 开审稿台（不上传、不部署）。

.DESCRIPTION
    桌面上的「一键更新」快捷方式调的就是这个脚本（工程根目录 一键更新.cmd）。

    为什么要它：
      这条链路原来要人手动敲命令，而且中间哪一步失败只能盯着屏幕看。
      现在一次双击跑完，结束后浏览器自动打开审稿台等着审；
      整轮过程的完整输出落在 .daily-review.log，窗口关了也能翻。

    关键约束：
      - **不上传、不部署。** 上传前必须有人看过图 —— 审稿闸门是硬闸门，
        没有凭证 publish.ps1 直接 exit=1，R2 零上传。
      - 审稿台用**独立进程**起（隐藏、无窗口）：用户手上没有黑窗口可关，
        也就没有「随手关窗口把审稿台连带弄死」的触发条件。
        2026-11-04 那次发布就是这么被腰斩的（详见 README）。
      - 日志靠 Start-Transcript 抓。daily.ps1 里的原生命令都接了 `| Out-Host`，
        不然 PS 5.1 的 transcript 抓不到它们的 stdout（详见 daily.ps1 里的说明）。

.PARAMETER ContentDate
    要抓哪天的内容。默认昨天。

.PARAMETER NoGrab
    跳过抓图（图片已经手动放好了）。

.PARAMETER NoHeadlines
    跳过抓头条。

.PARAMETER NoClean
    跳过图片清洗。

.PARAMETER NoRank
    跳过抓榜单 + 追更（听乐 / 看片 五段的大目录数据）。

.PARAMETER NoConvert
    复用已转码的图片，不重新转码（快 5 倍）。

.PARAMETER SkipReview
    只准备，不开审稿台。

.PARAMETER NoBrowser
    不自动打开浏览器（审稿台照起）。

.PARAMETER ReadyTimeoutSec
    等审稿台就绪的秒数。默认 90。

.PARAMETER Hold
    跑完不自动关窗口，按回车才关（默认成功后等 10 秒自动关，失败时一定保留）。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File tools/daily-review.ps1

.EXAMPLE
    # 只重建 + 开审稿台（不重新抓图）
    powershell -NoProfile -ExecutionPolicy Bypass -File tools/daily-review.ps1 -NoGrab -NoHeadlines
#>
param(
  [string]$ContentDate,
  [switch]$NoGrab,
  [switch]$NoHeadlines,
  [switch]$NoClean,
  [switch]$NoRank,
  [switch]$NoConvert,
  [switch]$SkipReview,
  [switch]$NoBrowser,
  [int]$ReadyTimeoutSec = 90,
  [switch]$Hold
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

# 跨平台公共 helper（北京时间 / 起子进程的 shell / 图像根目录 / 路径拼接）。
# macOS 上跑的是同一份 .ps1（PowerShell 7），helper 负责把那几处 Windows 绑定拆掉。
. (Join-Path $PSScriptRoot 'common.ps1')
Set-Location $Root

# 控制台用 UTF-8 —— 不然中文的阶段标题在 cmd 窗口里是乱码。
# 一键更新.cmd 里也有一句 chcp 65001，两边都设一遍更稳。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# python 的 stdout 也强制 UTF-8。
#
# 不设的话，python 按控制台代码页输出（中文 Windows 上是 GBK），
# 而 PowerShell 这边已经是 UTF-8 —— 两边对不上，
# 结果是：屏幕上部分中文是乱码，.daily-review.log 里也是乱码。
#
# 只在这个包装脚本里设，不动 daily.ps1 ——
# 手动跑 daily.ps1 时控制台可能还是 GBK，那时候按 GBK 输出才是对的。
$env:PYTHONIOENCODING = 'utf-8'

$LogFile   = Join-Path $Root '.daily-review.log'
$LockFile  = Join-Path $Root '.daily-review.lock'
$PortFile  = Join-Path $Root '.review-port'

function Rule($t)  { Write-Host ("`n=== $t ===  [" + (Get-BjNow).ToString('HH:mm:ss') + "]") -ForegroundColor Cyan }
function Ok($t)   { Write-Host "  [OK] $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  [!]  $t" -ForegroundColor Yellow }

# ── 日志 ─────────────────────────────────────────────────────
# Start-Transcript 抓的是**本进程**的 host 输出。
# daily.ps1 是 in-process 调用的（不 spawn 子进程），所以它的阶段标题也进得来。
$transcriptOn = $false
try {
  Start-Transcript -Path $LogFile -Append | Out-Null
  $transcriptOn = $true
} catch {
  Write-Host "  [!] 日志写不了（$($_.Exception.Message)），本次不带日志继续。"
}

Write-Host ''
Write-Host ('=' * 60) -ForegroundColor DarkGray
Write-Host ('  一键更新 · 每日准备 · ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -ForegroundColor Cyan
Write-Host ('=' * 60) -ForegroundColor DarkGray

# ── 锁：防止手抖连点两下 ─────────────────────────────────────
# 锁里存 PID。判断「是不是还在跑」靠 PID 活不活，
# 而不是靠文件在不在 —— 上一次崩了会留下一个死 PID 的锁文件，
# 那样第二天就再也跑不了。
if (Test-Path $LockFile) {
  $old = (Get-Content $LockFile -Raw -ErrorAction SilentlyContinue)
  if ($old -and $old.Trim() -match '^\d+$') {
    $proc = Get-Process -Id ([int]$old.Trim()) -ErrorAction SilentlyContinue
    if ($proc) {
      Write-Host ''
      Write-Host "  已经有一轮在跑了（PID $($old.Trim())），这次不重复跑。" -ForegroundColor Yellow
      Write-Host ''
      if (-not $Hold) { Start-Sleep -Seconds 3 }
      if ($transcriptOn) { Stop-Transcript | Out-Null }
      exit 0
    }
  }
}
Set-Content -Path $LockFile -Value $PID -Encoding ASCII

# ── 审稿台：复用还是新起 ────────────────────────────────────
# .review-port 里记着上一个审稿台的实际端口。
# 它还活着、而且审的就是这一期 → 直接复用，别再起一个（起多了端口一路往上飘）。
function Get-LiveReviewPort([string]$date) {
  if (-not (Test-Path $PortFile)) { return $null }
  $raw = Get-Content $PortFile -Raw -ErrorAction SilentlyContinue
  if (-not $raw) { return $null }
  $port = $raw.Trim()
  if ($port -notmatch '^\d+$') { return $null }
  try {
    $r = Invoke-WebRequest -Uri ("http://127.0.0.1:$port/") -UseBasicParsing -TimeoutSec 3
    # 页面上有「审稿台 · <日期>」，用它确认这个服务审的是不是本期。
    # 光看端口活着不够 —— 上一期的审稿台也可能还开着，审错期比不审更糟。
    if ($r.StatusCode -eq 200 -and $r.Content -match ('审稿台 · ' + [regex]::Escape($date))) {
      return [int]$port
    }
  } catch { }
  return $null
}

function Open-Browser([string]$url) {
  try {
    Start-Process $url
    return $true
  } catch {
    Warn ("浏览器没自动打开，手动开一下：$url")
    return $false
  }
}

$publishDate = ''
$countsLine = ''
$reviewUrl = ''

try {
  # ── 1. 每日准备 ───────────────────────────────────────────
  Rule '1/3 每日准备（抓图 → 头条 → 清洗 → 榜单/追更 → 构建）'

  $dailyArgs = @{}
  if ($ContentDate)   { $dailyArgs['ContentDate']   = $ContentDate }
  if ($NoGrab)        { $dailyArgs['NoGrab']        = $true }
  if ($NoHeadlines)   { $dailyArgs['NoHeadlines']   = $true }
  if ($NoClean)       { $dailyArgs['NoClean']       = $true }
  if ($NoRank)        { $dailyArgs['NoRank']        = $true }
  if ($NoConvert)     { $dailyArgs['NoConvert']     = $true }

  # in-process 调用，不 spawn 子进程 ——
  # 这样 daily.ps1 的 Write-Host 阶段标题能被本进程的 transcript 抓到。
  & (Get-ToolPath -Root $Root -Name 'daily.ps1') @dailyArgs

  # ── 2. 校验构建产物 ───────────────────────────────────────
  Rule '2/3 校验构建产物'

  # 发布日期从 .publish-date 读 —— 不自己再算一遍。
  # daily.ps1 已经算过一次并且写下来了，两边各算一次迟早会对不上。
  $dateFile = Join-Path $Root '.publish-date'
  if (-not (Test-Path $dateFile)) {
    throw '构建完了却没找到 .publish-date —— 日期对不上，先别审。'
  }
  $publishDate = (Get-Content $dateFile -Raw).Trim()
  if ($publishDate -notmatch '^\d{4}-\d{2}-\d{2}$') {
    throw ".publish-date 里不是日期（'$publishDate'）—— 先别审。"
  }
  Ok "发布日 $publishDate"

  # verify-build 的输出走 host：屏幕上看得见，日志里也留得住。
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $verifyOut = @(
      & node (Get-ToolPath -Root $Root -Name 'verify-build.mjs') --date $publishDate *>&1 |
        ForEach-Object {
          $line = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { [string]$_ }
          Write-Host $line
          $line
        }
    )
    $verifyCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevEap
  }
  foreach ($l in $verifyOut) {
    # 只取「见闻 N / 见她 N / 见笑 N」这一段，别把整行校验输出都搬到摘要里
    if ($l -match '(见闻\s+\d+\s*/\s*见她\s+\d+\s*/\s*见笑\s+\d+)') { $countsLine = $Matches[1] }
  }
  if ($verifyCode -ne 0) {
    throw "构建产物自检没通过（exit $verifyCode）—— 先别审，看看上面哪一条不对。"
  }
  Ok '产物自检通过'

  # ── 3. 审稿台 ─────────────────────────────────────────────
  if ($SkipReview) {
    Rule '3/3 跳过审稿台（-SkipReview）'
    Ok '只准备，不开审稿台'
  } else {
    Rule '3/3 开审稿台'

    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { throw '找不到 node —— 审稿台起不来。' }

    $live = Get-LiveReviewPort $publishDate
    if ($live) {
      Ok "审稿台已经在跑（端口 $live），直接用"
      $reviewUrl = "http://localhost:$live/"
    } else {
      # 用 tools/start-review.mjs 起，而不是直接 Start-Process node：
      #
      #   **detached（DETACHED_PROCESS）= 审稿台不继承任何控制台。**
      #   这是「Windows 控制台连坐」的根治办法 ——
      #   直接 Start-Process 的话，审稿台会挂在这个准备窗口的控制台上，
      #   窗口一关（或者用户顺手点 X）审稿台就没了。
      #   没有控制台 = 不受任何控制台销毁影响，发布子进程也一样。
      #
      #   2026-11-08 实测：审稿台的 stdout/stderr 现在落到
      #   .review-station-<日期>.out.log / .err.log（它是隐藏的，屏幕上什么都看不到）。
      $StnOutLog = Join-Path $Root ".review-station-$publishDate.out.log"
      $StnErrLog = Join-Path $Root ".review-station-$publishDate.err.log"

      $pidText = & node (Get-ToolPath -Root $Root -Name 'start-review.mjs') $publishDate
      $stationPid = ($pidText | Select-Object -Last 1)
      if (-not $stationPid -or $stationPid -notmatch '^\d+$') {
        throw "审稿台启动器没返回 PID（输出：$pidText）"
      }

      # 等它把端口写下来（.review-port）
      $deadline = (Get-Date).AddSeconds($ReadyTimeoutSec)
      $port = $null
      while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 400
        $live = Get-LiveReviewPort $publishDate
        if ($live) { $port = $live; break }
        $alive = Get-Process -Id ([int]$stationPid) -ErrorAction SilentlyContinue
        if (-not $alive) {
          $err = ''
          if (Test-Path $StnErrLog) { $err = (Get-Content $StnErrLog -Raw -ErrorAction SilentlyContinue) }
          throw ("审稿台起不来（PID $stationPid 已退出）" + $(if ($err) { "`n$err" } else { '' }))
        }
      }
      if (-not $port) {
        throw "审稿台 ${ReadyTimeoutSec} 秒内没就绪 —— 手工起一个看看：node tools/review.mjs $publishDate"
      }
      Ok "审稿台已就绪（端口 $port，PID $stationPid）"
      $reviewUrl = "http://localhost:$port/"
    }

    if (-not $NoBrowser) {
      if (Open-Browser $reviewUrl) { Ok "浏览器已打开 $reviewUrl" }
    }
  }

  # ── 收尾 ───────────────────────────────────────────────────
  Write-Host ''
  Write-Host ('=' * 60) -ForegroundColor Cyan
  Write-Host '  准备完成 —— 等你审' -ForegroundColor Cyan
  Write-Host ('=' * 60) -ForegroundColor Cyan
  Write-Host ''
  Write-Host ("  发布日 : $publishDate") -ForegroundColor White
  if ($countsLine) { Write-Host ("  图片   : $countsLine") -ForegroundColor White }
  if ($reviewUrl)  { Write-Host ("  审稿台 : $reviewUrl") -ForegroundColor White }
  Write-Host ("  日志   : $LogFile") -ForegroundColor DarkGray
  Write-Host ''
  Write-Host '  审完点「通过审核」；要发出去再点「通过审核并发布」。' -ForegroundColor Yellow
  Write-Host '  （发布是不可逆的 —— 发出去收不回来，所以刻意分成两个按钮。）' -ForegroundColor DarkGray
  Write-Host ''

  if ($Hold) {
    Read-Host '  按回车关闭'
  } else {
    Start-Sleep -Seconds 10
  }
  exit 0
}
catch {
  Write-Host ''
  Write-Host ('=' * 60) -ForegroundColor Red
  Write-Host '  出错了 —— 这一期没准备好，先别审' -ForegroundColor Red
  Write-Host ('=' * 60) -ForegroundColor Red
  Write-Host ''
  Write-Host ('  ' + $_.Exception.Message) -ForegroundColor Red
  Write-Host ''
  Write-Host ("  日志：$LogFile") -ForegroundColor DarkGray
  Write-Host ''
  # 这里不 Read-Host —— 非交互跑（定时任务、测试）时 Read-Host 会直接挂住。
  # 屏幕上留 15 秒够了；根目录的 一键更新.cmd 后面还有一句 pause 兜底。
  Start-Sleep -Seconds 15
  exit 1
}
finally {
  # 清锁：写空就行，不用删文件（删文件在 Windows 上还得考虑回收站）。
  # 判「还在跑」靠 PID 活不活，所以锁文件留着也不碍事。
  try { Set-Content -Path $LockFile -Value '' -Encoding ASCII } catch { }
  if ($transcriptOn) { try { Stop-Transcript | Out-Null } catch { } }
}
