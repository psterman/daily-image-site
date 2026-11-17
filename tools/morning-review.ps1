<#
.SYNOPSIS
  早晨：起审稿台（当期）→ 人审 → 点「通过审核并发布」。

.DESCRIPTION
  夜间流程（tools/night-publish.ps1）已经把当期发上去了。早晨这一段只做三件事：

    1. 起审稿台，审**线上的当期**（北京今天那期）
    2. 人审：删掉坏图 → 点「通过审核并发布」
    3. 发布时自动：刷新当期热榜（见报）+ 清理这一期的孤儿对象
       （这两个钩子都在 tools/publish.ps1 里）

  为什么审稿台要经 tools/start-review.mjs 起：
    审稿台是长驻进程。直接 `node tools/review.mjs` 起的会落在 Job Object 里，
    宿主退出或机器重启时被**强杀**（无 stderr、无退出码、无事件日志）。
    start-review.mjs 走 explorer.exe 起，进程不在任何 Job 里。

.PARAMETER Date
  审哪一期。默认北京今天（当期）。
#>
param(
  [string]$Date
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# 跨平台公共 helper（北京时间 / 起子进程的 shell / 图像根目录 / 路径拼接）。
# macOS 上跑的是同一份 .ps1（PowerShell 7），helper 负责把那几处 Windows 绑定拆掉。
. (Join-Path $PSScriptRoot 'common.ps1')

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# ── 期号：默认当期（北京今天）────────────────────────────────
if (-not $Date) {
  $Date = Get-BjDate
}
if ($Date -notmatch '^\d{4}-\d{2}-\d{2}$') {
  throw "日期格式不对：'$Date'（应为 YYYY-MM-DD）"
}

# ── 起审稿台 ─────────────────────────────────────────────────
#
# 走 start-review.mjs（explorer.exe 脱 Job Object），别直接起 review.mjs。
# 子进程写 stderr 会变成 ErrorRecord，顶着 'Stop' 会把整个脚本掀翻
# （跟 publish.ps1 踩过的同一个坑），所以这里先降成 Continue。
#
# node 的可执行名：Windows 是 node.exe，macOS/Linux 是 node（没有 .exe 后缀）——
# 只认 node.exe 的话，macOS 上这一步直接找不到（PowerShell 的 Get-Command
# 在 Windows 上对 'node' 也会返回 node.exe，所以两个都试最省事）。
$nodeExe = $null
foreach ($cmd in @('node.exe', 'node')) {
  $c = Get-Command $cmd -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue
  if ($c) { $nodeExe = $c; break }
}
if (-not $nodeExe) { throw '找不到 node —— 审稿台起不来。' }

$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  & $nodeExe (Get-ToolPath -Root $Root -Name 'start-review.mjs') $Date
  $rc = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $prevEap
}
if ($rc -ne 0) { throw "审稿台没起来（exit $rc）" }

# ── 打开浏览器 ───────────────────────────────────────────────
$portFile = Join-Path $Root '.review-port'
$port = ''
if (Test-Path $portFile) { $port = (Get-Content $portFile -Raw -ErrorAction SilentlyContinue).Trim() }
if ($port -match '^\d+$') {
  try { Start-Process ("http://localhost:$port/") } catch { }
}

Write-Host ''
if ($port -match '^\d+$') {
  Write-Host ("  审稿台 : http://localhost:$port/   （$Date）") -ForegroundColor Green
} else {
  Write-Host ("  审稿台已起（期号 $Date）—— 端口没读到，手动开一下") -ForegroundColor Green
}
Write-Host '  审完点「通过审核」；要发出去再点「通过审核并发布」。' -ForegroundColor Yellow
Write-Host '  （发布是不可逆的 —— 发出去收不回来，所以刻意分成两个按钮。）' -ForegroundColor DarkGray
Write-Host '  发布时会自动刷新当期热榜（见报），并清理这一期的孤儿对象。' -ForegroundColor DarkGray
