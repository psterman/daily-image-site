<#
.SYNOPSIS
  夜间自动发布（无人值守）：准备 → 发布当期（跳过审稿闸门）。

.DESCRIPTION
  2026-11-15 用户定的夜间流程：
    · 过了午夜（00:00–05:59，机器开着的话）自动跑一遍：抓图 → 头条 → 清洗 → 构建 → 自检，
      然后**不等审稿**直接把当期发出去；
    · 第二天早上由人审稿台审线上的那一期，删掉坏图后再重发（修图 + 刷新见报）。

  为什么窗口是「过了午夜」而不是「晚上 23:00」：
    期号 = 发布日 = 北京今天，而抓图落盘目录 = bj_today（下载当天）——
    期号由「跑的那一刻是几号」决定。23:00 跑算出来的是**当天早上已经发过**的那一期，
    而第二天早上审稿台审的期号会跟它**差一天**。过了午夜跑，两边才对得上。

  为什么可以跳过审稿闸门：用户明确授权（2026-11-15 问卷「接受未审稿直接上线」）。
  已知代价：撤回要等 24 小时边缘缓存，链接发出去就收不回来。

  为什么幂等：开机触发和定时触发可能都落在同一天，所以**今天发过就不再来一遍**
  （否则会重复上传 600 多个对象 + 多部署一次）。

  为什么不用「一键更新.cmd」：那个 .cmd 末尾有 pause，无人值守会永远挂在那儿。

  跨平台：同一份 .ps1 在 macOS 上用 PowerShell 7（pwsh）跑，
  平台差异（时区 ID / 起子进程的 shell / 路径分隔符）都由 tools/common.ps1 吸收。

  为什么每次都带 -NoHeadlines：准备那一步（daily.ps1 的第 2/5 步）已经抓过当期头条了，
  这里再抓一次就是白等 4 分钟。真正需要刷新热榜的是**早晨**那次重发。

.PARAMETER Date
  发布哪一期。默认北京今天。

.PARAMETER Force
  忽略「今天发过了」的标记，强行再发一遍（出问题时手动用）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/night-publish.ps1
#>
param(
  [string]$Date,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# 跨平台公共 helper（北京时间 / 起子进程的 shell / 图像根目录 / 路径拼接）。
# macOS 上跑的是同一份 .ps1（PowerShell 7），helper 负责把那几处 Windows 绑定拆掉。
# 必须 dot-source（`.`）而不是 & 调用 —— & 调用不会把函数带进当前作用域。
. (Join-Path $PSScriptRoot 'common.ps1')

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# ── 日期 ─────────────────────────────────────────────────────
if (-not $Date) {
  # 北京今天。Get-BjNow 在 Windows 上认 'China Standard Time'，
  # 在 macOS/Linux 上认 'Asia/Shanghai' —— 认错就差一期（见 common.ps1）。
  $Date = Get-BjDate
}
if ($Date -notmatch '^\d{4}-\d{2}-\d{2}$') {
  throw "日期格式不对：'$Date'（应为 YYYY-MM-DD）"
}

$LogFile = Join-Path $Root ".night-publish-$Date.log"
$Marker  = Join-Path $Root ".night-publish-$Date.done"

# ── 子进程统一入口 ───────────────────────────────────────────
#
# 为什么不能裸调 `& powershell`：PS 5.1 里子进程往 stderr 写一行字，
# 就会被转成 ErrorRecord，而本脚本 $ErrorActionPreference='Stop' →
# ErrorRecord 变成终止性错误 → 整个夜间流程当场死掉。
# 这跟 2026-11-15 两次发布死掉的是同一个坑（publish.ps1 里的真凶）。
function Invoke-Child {
  param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [string[]]$ChildArgs = @()
  )
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Exe @ChildArgs 2>&1 | ForEach-Object {
      $line = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { [string]$_ }
      Write-Host $line
      Add-Content -Path $LogFile -Value $line -Encoding UTF8
    }
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevEap
  }
}

# ── 时间闸门：只在「过了午夜」的那几个钟头发 ───────────────────
#
# 为什么不是「20:00 之后」（2026-11-15 晚改，原来写的是 -lt 20）：
#   站点的**期号 = 发布日 = 北京今天**，而抓图落盘的目录 = bj_today（下载当天）
#   —— 也就是说**期号由「跑的那一刻是几号」决定**，跟内容日无关。
#   于是 23:00 跑会算出一个**当天早上已经发过**的期号（白跑一遍，
#   还会把早上那一期重新抓一遍）；而第二天早上审稿台审的是「北京今天」那期，
#   跟夜里发的**差一天** —— 审的其实是还没发出去的一期。
#   过了午夜再跑，「北京今天」才正好等于「第二天早上要审的那一期」✓
#   而且内容窗口（昨天 00:00–24:00）到午夜才关闭，这时抓才是完整的。
#
# 所以窗口是 00:00–05:59（天亮前）。天亮以后走人的流程：
#   桌面「上传图片」手动点，或者「一键更新」+ 审稿台。
$bjNow = Get-BjNow
$bjHour = [int]$bjNow.ToString('HH')
if (-not $Force -and $bjHour -ge 6) {
  Write-Host ("  现在是 " + $bjNow.ToString('HH:mm') + " —— 天亮了，不自动发。")
  Write-Host '  白天的流程：桌面「上传图片」手动跑，或「一键更新」+ 审稿台。'
  Write-Host '  （要强行发：加 -Force）'
  exit 0
}

# ── 幂等：今天发过了就别再来一遍 ─────────────────────────────
if (-not $Force -and (Test-Path $Marker)) {
  $old = Get-Content $Marker -Raw -ErrorAction SilentlyContinue
  if ($old -and $old -match '"exit"\s*:\s*0') {
    Write-Host "  今天（$Date）已经发过了 —— 跳过。"
    Write-Host '  （要强行再发一遍：加 -Force）'
    exit 0
  }
}

Write-Host ''
Write-Host ('夜间自动发布 · ' + $Date) -ForegroundColor Cyan
Write-Host ('=' * 52) -ForegroundColor Cyan

# 重开一份日志
Set-Content -Path $LogFile -Value '' -Encoding UTF8

$exitCode = 0
try {
  # ── 1/2 准备 ───────────────────────────────────────────────
  Write-Host ''
  Write-Host '  [1/2] 准备（抓图 → 头条 → 清洗 → 构建 → 自检）' -ForegroundColor Cyan
  # 抓图总时间预算（秒）。给「抓图」这一步封顶：上游一慢（t.me read timeout
  # 反复出现）就可能跑到一半被关机硬杀 —— 机器每晚 01:12~03:12 自动关机，
  # 而这一轮 00:10 起跑（2026-11-17 那晚余量只剩 5.3 分钟）。
  # 超预算就带着已抓到的素材继续（少几张图，但这一期照样按时发出去）。
  # 25 分钟 = 1500 秒：实测最慢的一晚是 28 分钟，25 分钟留得住；
  # 也远低于「离关机至少还有 45 分钟」的余量。
  $env:MEMES_GRAB_BUDGET_SEC = '1500'
  $rc = Invoke-Child (Get-ShellExe) @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Get-ToolPath -Root $Root -Name 'daily-review.ps1'),
    '-SkipReview', '-NoBrowser'
  )
  if ($rc -ne 0) { throw "准备失败（exit $rc）—— 这一期没准备好，不发。" }

  # ── 2/2 发布当期（跳过审稿闸门）────────────────────────────
  Write-Host ''
  Write-Host '  [2/2] 发布当期（跳过审稿闸门 —— 用户 2026-11-15 授权）' -ForegroundColor Cyan
  $rc = Invoke-Child (Get-ShellExe) @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Get-ToolPath -Root $Root -Name 'publish.ps1'),
    '-Date', $Date, '-SkipReview', '-NoConvert', '-NoHeadlines'
  )
  if ($rc -ne 0) { throw "发布失败（exit $rc）" }
} catch {
  $exitCode = 1
  Write-Host ''
  Write-Host ('夜间流程失败：' + $_.Exception.Message) -ForegroundColor Red

  # ── 失败告警（2026-11-25 加）─────────────────────────────────
  #
  # 为什么在这里发：原来**只有定时任务台**（night-dashboard.mjs）在它自己
  # 判定出错时才发 toast，而任务台是**手动起的 GUI 进程**、没有任何自启动
  # （机器每次重启就没了）→ 夜里发布失败时**一个通知都不会发**。
  # 现在由夜间脚本自己发 —— 不依赖任何常驻进程。
  #
  # 失败才发（成功不发）；通知发不出去也不影响主流程（Send-Alert 内部吞异常）。
  try {
    Send-Alert -Root $Root -Title '夜间发布失败' -Body (
      "期号 {0}`n原因：{1}`n日志：{2}" -f $Date, $_.Exception.Message, $LogFile
    )
  } catch {
    # 静默降级 —— 通知永远不能掀翻主流程
  }
}

# 标记 + 结束标记
# 结束标记很重要：没有它就没法判断「它是正常跑完了，还是中途死了」。
#
# ⚠️ 变量名别写成 `$marker` —— **PowerShell 变量名大小写不敏感**，
# `$marker` 和上面的 `$Marker`（路径）是**同一个变量**！
# 一旦在这里重新赋值，路径就被覆盖成 JSON 字符串，
# 后面 `Set-Content -Path $Marker` 会把 JSON 当路径用 →
# 报「找不到与参数名称"Encoding"匹配的参数」，
# **标记文件根本写不出来** → 幂等失效 → 每次都重发一遍。
$markerJson = @{ date = $Date; exit = $exitCode; at = (Get-Date).ToString('o') } | ConvertTo-Json
Set-Content -Path $Marker -Value $markerJson -Encoding UTF8
Add-Content -Path $LogFile -Value ("=== NIGHT_DONE exit=$exitCode ===") -Encoding UTF8

Write-Host ''
if ($exitCode -eq 0) {
  Write-Host ("  夜间发布完成（$Date）。日志：$LogFile") -ForegroundColor Green
} else {
  Write-Host ("  夜间发布失败（$Date）。日志：$LogFile") -ForegroundColor Red
}

# ── 日志轮转 ────────────────────────────────────────────────
#
# `.night-publish-console.log` / `.daily-review.log` 是 `cmd >>` 写出来的 ——
# **只追加、永不清理**（实测 11 天涨到 505 KB / 664 KB，一年能到十几 MB，
# 而且每次排查都要 tail 它 → 越大越慢）。
#
# 轮转放在**最后**（成功和失败都轮）：切历史 + 原地清空，保留最近 7 份。
# 轮转失败绝不影响发布结果（它只是清磁盘）。
try {
  $rotate = Get-ToolPath -Root $Root -Name 'rotate-logs.mjs'
  if (Test-Path $rotate) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) {
      & $node.Source $rotate | Out-Null
    }
  }
} catch {
  # 轮转失败就失败 —— 不影响发布
}

exit $exitCode
