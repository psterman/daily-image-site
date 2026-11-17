<#
.SYNOPSIS
    每日图片站 —— 图片访问口令（Gate）一键开关。

.DESCRIPTION
    口令模式只锁 /img/*，页面 HTML 与 /assets/ 保持公开：
    微信生成分享卡片靠的是不执行 JS 的爬虫，爬虫要能拿到 <title> 和 og:image，
    否则卡片会变成空白。全站锁死反而适得其反。

    开启后的效果：
      - 单张图片的裸链（别人从页面上复制出来的）返回 401，没法单独抓去举报/传播
      - 微信爬虫在 HTML 里读不到正文图片 URL，也拿不到图片内容
      - 分享链接带 ?k=<口令>，用户点开后 302 跳到干净地址栏，cookie 记住一年
      - 群友体验完全不变：点开就是图，不需要额外操作

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools/gate.ps1 -Action status

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools/gate.ps1 -Action on

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools/gate.ps1 -Action off
#>
param(
  [ValidateSet('status', 'on', 'off', 'rotate')]
  [string]$Action = 'status',
  [string]$Token,
  [string]$Project,
  [string]$SiteUrl,
  [switch]$NoDeploy
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# 跨平台公共 helper（北京时间 / 起子进程的 shell / 图像根目录 / 路径拼接）。
. (Join-Path $PSScriptRoot 'common.ps1')

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

# ── 加载 .env.local ─────────────────────────────────────────
$envFile = Join-Path $Root '.env.local'
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$') {
      $k = $Matches[1]; $v = $Matches[2].Trim('"').Trim("'")
      if (-not [Environment]::GetEnvironmentVariable($k)) {
        [Environment]::SetEnvironmentVariable($k, $v)
      }
    }
  }
}

if (-not $Project) { $Project = $env:PAGES_PROJECT }
if (-not $Project) { $Project = 'your-project' }
if (-not $SiteUrl) { $SiteUrl = $env:SITE_URL }
if (-not $SiteUrl) { $SiteUrl = 'https://example.com' }
$AccountId = $env:CLOUDFLARE_ACCOUNT_ID

if (-not $AccountId) { throw '缺少 CLOUDFLARE_ACCOUNT_ID，先跑 tools/setup-cloudflare.ps1' }

# ── 先续期 token（OAuth token 只有几小时寿命） ─────────────────
Write-Host '刷新 Cloudflare token …' -ForegroundColor DarkGray
& node tools/refresh-token.mjs | Out-Null
# refresh-token.mjs 会把新 token 写回 .env.local，这里重新读一次
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*CLOUDFLARE_API_TOKEN\s*=\s*(.+?)\s*$') {
    [Environment]::SetEnvironmentVariable('CLOUDFLARE_API_TOKEN', $Matches[1].Trim('"').Trim("'"))
  }
}
$ApiToken = $env:CLOUDFLARE_API_TOKEN
if (-not $ApiToken) { throw '缺少 CLOUDFLARE_API_TOKEN' }

$Headers = @{ Authorization = "Bearer $ApiToken"; 'Content-Type' = 'application/json' }
$Base = "https://api.cloudflare.com/client/v4/accounts/$AccountId/pages/projects/$Project/secrets"

function Get-GateState {
  # 用 wrangler 读（REST 的 GET 列表虽然能通，但和写入路径不是同一套，
  # 实测 wrangler 这条更可靠）
  $out = & npx --yes wrangler@latest pages secret list --project-name $Project 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  ! 读取密钥列表失败：$($out | Select-Object -Last 1)" -ForegroundColor Yellow
    return $null
  }
  return [bool](($out | Out-String) -match 'GATE_TOKEN')
}

function Set-GateSecret([string]$Value) {
  # wrangler pages secret bulk 要的格式是 { "KEY": "字符串" }，
  # 不是 { "KEY": { "value": ..., "type": ... } } —— 用错格式它会直接报错。
  # 走 wrangler 而不是 REST API：实测 REST 的 PATCH 会「返回成功但根本没写入」。
  $tmp = Join-Path $env:TEMP ("gate-secret-{0}.json" -f ([guid]::NewGuid().ToString('N')))
  $json = @{ GATE_TOKEN = $Value } | ConvertTo-Json -Compress
  # 必须无 BOM：wrangler 读 JSON 时对 BOM 敏感
  [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
  try {
    & npx --yes wrangler@latest pages secret bulk $tmp --project-name $Project
    if ($LASTEXITCODE -ne 0) { throw "写入 GATE_TOKEN 失败（exit $LASTEXITCODE）" }
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

function Remove-GateSecret {
  # wrangler 的 secret delete 可能会问一句确认，喂一个 y 进去避免卡住
  'y' | & npx --yes wrangler@latest pages secret delete GATE_TOKEN --project-name $Project
  if ($LASTEXITCODE -ne 0) { throw "删除 GATE_TOKEN 失败（exit $LASTEXITCODE）" }
}

function New-GateToken {
  $bytes = New-Object byte[] 16
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return (-join ($bytes | ForEach-Object { $_.ToString('x2') }))
}

function Publish-After {
  if ($NoDeploy) {
    Write-Host '  （按 -NoDeploy 跳过部署，线上暂不生效）' -ForegroundColor Yellow
    return
  }
  Step '重新部署（让新的密钥生效）'
  # 走 helper：只认退出码，不认 stderr（PS 5.1 里子进程一行 stderr 能掀翻调用方）
  $rc = Invoke-PsScript -Script (Get-ToolPath -Root $Root -Name 'publish.ps1') -ScriptArgs @('-SkipBuild')
  if ($rc -ne 0) { throw "部署失败（exit $rc）" }
}

# ── 执行 ─────────────────────────────────────────────────────
switch ($Action) {
  'status' {
    Step '当前口令状态'
    $on = Get-GateState
    if ($null -eq $on) {
      Write-Host '  状态未知' -ForegroundColor Yellow
      exit 1
    }
    if ($on) {
      Write-Host '  口令：已开启（图片需要凭证）' -ForegroundColor Yellow
      Write-Host "  分享链接：$SiteUrl/?k=<口令>" -ForegroundColor Green
      Write-Host '  注意：口令开启后必须用带 ?k= 的链接分享，否则图片加载不出来。' -ForegroundColor Yellow
    } else {
      Write-Host '  口令：未开启（全站公开）' -ForegroundColor Green
      Write-Host "  分享链接：$SiteUrl/" -ForegroundColor Green
    }
    exit 0
  }

  'on' {
    Step '开启图片访问口令'
    if (-not $Token) { $Token = New-GateToken }
    Set-GateSecret $Token
    Write-Host "  已写入 GATE_TOKEN（值不在此回显）" -ForegroundColor Green
    Publish-After
    Write-Host ''
    Write-Host '  分享链接（复制这个发群里）：' -ForegroundColor Green
    Write-Host "    $SiteUrl/?k=$Token" -ForegroundColor White
    Write-Host ''
    Write-Host '  群友点开后会自动 302 跳到干净地址栏，cookie 记住一年，' -ForegroundColor DarkGray
    Write-Host '  页面和图片都能正常看，体验和公开模式完全一样。' -ForegroundColor DarkGray
    Write-Host '  关掉口令：tools/gate.ps1 -Action off' -ForegroundColor DarkGray
    exit 0
  }

  'rotate' {
    Step '更换口令'
    if (-not $Token) { $Token = New-GateToken }
    Set-GateSecret $Token
    Write-Host '  已更新 GATE_TOKEN' -ForegroundColor Green
    Publish-After
    Write-Host "  新的分享链接：$SiteUrl/?k=$Token" -ForegroundColor White
    exit 0
  }

  'off' {
    Step '关闭图片访问口令'
    Remove-GateSecret
    Write-Host '  已删除 GATE_TOKEN' -ForegroundColor Green
    Publish-After
    Write-Host "  分享链接：$SiteUrl/" -ForegroundColor Green
    exit 0
  }
}
