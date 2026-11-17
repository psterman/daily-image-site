<#
.SYNOPSIS
  手动上传：抓图 → 头条 → 清洗 → 构建 → 自检 → 上传 R2 → 部署 Pages。

.DESCRIPTION
  桌面上那个「上传图片」双击入口走的就是这个脚本。
  它跟夜间自动发布（tools/night-publish.ps1）是**同一套流程**，只差三件事：

    1. **没有时间闸门** —— 手动点就是有意的，任何时候都能跑。
    2. **当天已经发过会先问一句** —— 避免白跑一遍（重复上传 600 多个对象 + 一次部署）。
    3. **日志另开一份**（.manual-publish-<日期>.log），跟夜间那份不混。

  为什么跳过审稿闸门：用户明确授权（2026-11-15 问卷「接受未审稿直接上线」）。
  已知代价：撤回要等 24 小时边缘缓存，链接发出去就收不回来。
  想审完再发，走审稿台那条（tools/morning-review.ps1 → 页面上的「通过审核并发布」）。

  **发的是哪一期**：
    期号 = 北京今天，内容 = 北京昨天（站点的既有约定，见 AGENTS.md）。
    抓图落盘的目录 = bj_today（下载当天），所以「期号」由跑的那一刻是几号决定。
    · 早上点 → 发的是**今天该发的那一期**（跟原来的早上手动流程一样）
    · 晚上点 → 发的是今天这一期（如果凌晨的自动发布已经发过，就是重发一遍，幂等）

  **重复抓图不会把用户删掉的图带回来** —— 抓取台账（.fetch-ledger.json）在发请求前
  就跳过「以前抓过的 URL」，所以删掉的图不会被重新下载。

.PARAMETER Date
  发布哪一期（期号）。默认北京今天。

.PARAMETER Force
  当天已经发过也照发，不再问。

.PARAMETER NoBrowser
  完成后不开浏览器。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/manual-publish.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/manual-publish.ps1 -Force
#>
param(
  [string]$Date,
  [switch]$Force,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# 跨平台公共 helper（北京时间 / 起子进程的 shell / 图像根目录 / 路径拼接）。
# macOS 上跑的是同一份 .ps1（PowerShell 7），helper 负责把那几处 Windows 绑定拆掉。
# 必须 dot-source（`.`）而不是 & 调用 —— & 调用不会把函数带进当前作用域。
. (Join-Path $PSScriptRoot 'common.ps1')

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# ── 期号 ─────────────────────────────────────────────────────
if (-not $Date) {
  # 北京今天。Get-BjNow 在 Windows 上认 'China Standard Time'，
  # 在 macOS/Linux 上认 'Asia/Shanghai' —— 认错就差一期（见 common.ps1）。
  $Date = Get-BjDate
}
if ($Date -notmatch '^\d{4}-\d{2}-\d{2}$') {
  throw "日期格式不对：'$Date'（应为 YYYY-MM-DD）"
}

$LogFile = Join-Path $Root ".manual-publish-$Date.log"
# 幂等标记跟夜间流程**共用同一个文件**：
# 谁先发过就算发过了，另一边不再重复上传（600 多个对象 + 一次部署，不便宜）。
$Marker = Join-Path $Root ".night-publish-$Date.done"

# ── 子进程统一入口 ───────────────────────────────────────────
#
# 为什么不能裸调 `& powershell`：PS 5.1 里子进程往 stderr 写一行字，
# 就会被转成 ErrorRecord，而本脚本 $ErrorActionPreference='Stop' →
# ErrorRecord 变成终止性错误 → 整个流程当场死掉。
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

# ── 幂等：今天发过了就问一句 ─────────────────────────────────
#
# 注意这里**不问**「期号对不对」——期号只有一种取法（北京今天），
# 问的是「要不要白跑一遍」。用户明确要重发就输入 y。
if (-not $Force -and (Test-Path $Marker)) {
  $old = Get-Content $Marker -Raw -ErrorAction SilentlyContinue
  if ($old -and $old -match '"exit"\s*:\s*0') {
    $at = ''
    if ($old -match '"at"\s*:\s*"([^"]+)"') { $at = $Matches[1] }
    Write-Host ''
    Write-Host "  今天（$Date）已经发过了。$at" -ForegroundColor Yellow
    $answer = ''
    try {
      $answer = Read-Host '  还要再发一遍吗？输入 y 继续，直接回车跳过'
    } catch {
      $answer = ''
    }
    if ($answer -notmatch '^(y|yes|Y|YES)$') {
      Write-Host '  跳过。（要强行再发一遍：加 -Force）' -ForegroundColor DarkGray
      exit 0
    }
    Write-Host '  继续重发。' -ForegroundColor Cyan
  }
}

Write-Host ''
Write-Host ('手动上传 · ' + $Date) -ForegroundColor Cyan
Write-Host ('=' * 52) -ForegroundColor Cyan
Write-Host '  抓图 → 头条 → 清洗 → 构建 → 自检 → 上传 R2 → 部署 Pages'
Write-Host '  （跳过审稿闸门 —— 用户 2026-11-15 授权；撤回要等 24h 边缘缓存）' -ForegroundColor DarkGray

# 重开一份日志
Set-Content -Path $LogFile -Value '' -Encoding UTF8

$exitCode = 0
try {
  # ── 1/2 准备 ───────────────────────────────────────────────
  Write-Host ''
  Write-Host '  [1/2] 准备（抓图 → 头条 → 清洗 → 构建 → 自检）' -ForegroundColor Cyan
  $rc = Invoke-Child (Get-ShellExe) @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Get-ToolPath -Root $Root -Name 'daily-review.ps1'),
    '-SkipReview', '-NoBrowser'
  )
  if ($rc -ne 0) { throw "准备失败（exit $rc）—— 这一期没准备好，不发。" }

  # ── 2/2 上传 + 部署 ────────────────────────────────────────
  Write-Host ''
  Write-Host '  [2/2] 上传 + 部署（跳过审稿闸门）' -ForegroundColor Cyan
  $rc = Invoke-Child (Get-ShellExe) @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Get-ToolPath -Root $Root -Name 'publish.ps1'),
    '-Date', $Date, '-SkipReview', '-NoConvert', '-NoHeadlines'
  )
  if ($rc -ne 0) { throw "上传失败（exit $rc）" }
} catch {
  $exitCode = 1
  Write-Host ''
  Write-Host ('上传失败：' + $_.Exception.Message) -ForegroundColor Red
}

# 标记 + 结束标记
# 结束标记很重要：没有它就没法判断「它是正常跑完了，还是中途死了」。
#
# ⚠️ 变量名别写成 `$marker` —— **PowerShell 变量名大小写不敏感**，
# `$marker` 和上面的 `$Marker`（路径）是**同一个变量**！
# 一旦在这里重新赋值，路径就被覆盖成 JSON 字符串，
# 后面 `Set-Content -Path $Marker` 会把 JSON 当路径用 →
# 报「找不到与参数名称"Encoding"匹配的参数」（因为带换行和 { 的路径绑不上参数集），
# **标记文件根本写不出来** → 幂等失效 → 每次都重发一遍。
$markerJson = @{ date = $Date; exit = $exitCode; at = (Get-Date).ToString('o'); by = 'manual' } | ConvertTo-Json
Set-Content -Path $Marker -Value $markerJson -Encoding UTF8
Add-Content -Path $LogFile -Value ("=== MANUAL_DONE exit=$exitCode ===") -Encoding UTF8

Write-Host ''
if ($exitCode -eq 0) {
  Write-Host ("  上传完成（$Date）。日志：$LogFile") -ForegroundColor Green
  Write-Host '  线上：https://example.com/' -ForegroundColor Green
  Write-Host '  要审这一期：开审稿台（tools/morning-review.ps1）→ 删坏图 → 点「通过审核并发布」。' -ForegroundColor DarkGray
  if (-not $NoBrowser) {
    try { Start-Process 'https://example.com/' } catch { }
  }
} else {
  Write-Host ("  上传失败（$Date）。日志：$LogFile") -ForegroundColor Red
}
exit $exitCode
