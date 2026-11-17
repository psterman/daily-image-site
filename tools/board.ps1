<#
.SYNOPSIS
    每日图片站 —— 留言板投稿口令（Submit Token）一键开关。

.DESCRIPTION
    投稿口令和图片访问口令（GATE_TOKEN）是两回事，刻意分开：

      GATE_TOKEN    保护「读」—— 给分享链接用，可以随时关掉、随时轮换
      SUBMIT_TOKEN  保护「写」—— 只有拿到口令的人才能留言，要长期稳定

    混成一个会有两个麻烦：
      1. 为了投稿把阅读口令发出去，等于把图片的访问权也发出去了
      2. 轮换阅读口令会把投稿的人一起踢掉

    重要：Pages 的加密环境变量改动后**要下一次部署才生效**。
    所以这个脚本默认只写 secret、不部署；
    等下一次正常发布（tools/publish.ps1）时新口令一起生效。
    想立刻生效就加 -Deploy（但会走一遍发布流程，包含审稿闸门）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools/board.ps1 -Action status

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools/board.ps1 -Action on

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools/board.ps1 -Action on -Token "my-secret"

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools/board.ps1 -Action rotate
#>
param(
  [ValidateSet('status', 'on', 'off', 'rotate')]
  [string]$Action = 'status',
  [string]$Token,
  [string]$Project,
  [string]$SiteUrl,
  [switch]$Deploy
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

# ── 续期 token ─────────────────────────────────────────────
Write-Host '刷新 Cloudflare token …' -ForegroundColor DarkGray
& node tools/refresh-token.mjs | Out-Null
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*CLOUDFLARE_API_TOKEN\s*=\s*(.+?)\s*$') {
    [Environment]::SetEnvironmentVariable('CLOUDFLARE_API_TOKEN', $Matches[1].Trim('"').Trim("'"))
  }
}
$ApiToken = $env:CLOUDFLARE_API_TOKEN
if (-not $ApiToken) { throw '缺少 CLOUDFLARE_API_TOKEN' }

function Get-SecretState {
  # 用 wrangler 读（和写入路径是同一套，实测比 REST 的 GET 可靠）
  $out = & npx --yes wrangler@latest pages secret list --project-name $Project 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  ! 读取密钥列表失败：$($out | Select-Object -Last 1)" -ForegroundColor Yellow
    return $null
  }
  return [bool](($out | Out-String) -match 'SUBMIT_TOKEN')
}

function Set-SubmitSecret([string]$Value) {
  # wrangler pages secret bulk 要的格式是 { "KEY": "字符串" }，
  # 不是 { "KEY": { "value": ..., "type": ... } }。
  # 走 wrangler 而不是 REST API：实测 REST 的 PATCH 会「返回成功但根本没写入」。
  $tmp = Join-Path $env:TEMP ("submit-secret-{0}.json" -f ([guid]::NewGuid().ToString('N')))
  $json = @{ SUBMIT_TOKEN = $Value } | ConvertTo-Json -Compress
  # 必须无 BOM：wrangler 读 JSON 时对 BOM 敏感
  [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
  try {
    & npx --yes wrangler@latest pages secret bulk $tmp --project-name $Project
    if ($LASTEXITCODE -ne 0) { throw "写入 SUBMIT_TOKEN 失败（exit $LASTEXITCODE）" }
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

function Remove-SubmitSecret {
  'y' | & npx --yes wrangler@latest pages secret delete SUBMIT_TOKEN --project-name $Project
  if ($LASTEXITCODE -ne 0) { throw "删除 SUBMIT_TOKEN 失败（exit $LASTEXITCODE）" }
}

function New-SubmitToken {
  # 去掉容易看错的字符（0/O、1/l/I），手抄口令时不容易错。
  # 16 位 × 5 bit ≈ 80 bit 熵，够用了。
  $alphabet = '23456789abcdefghjkmnpqrstuvwxyz'
  $bytes = New-Object byte[] 16
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $sb = New-Object System.Text.StringBuilder
  foreach ($b in $bytes) { [void]$sb.Append($alphabet[$b % $alphabet.Length]) }
  return $sb.ToString()
}

function Publish-After {
  if (-not $Deploy) {
    Write-Host ''
    Write-Host '  secret 已写入，但 Pages 的加密变量要**下一次部署**才生效。' -ForegroundColor Yellow
    Write-Host '  下次正常发布（tools/publish.ps1）时会一起生效，不用单独部署。' -ForegroundColor DarkGray
    Write-Host '  想立刻生效就加 -Deploy。' -ForegroundColor DarkGray
    return
  }
  Step '重新部署（让新的口令生效）'
  # 走 helper：只认退出码，不认 stderr（PS 5.1 里子进程一行 stderr 能掀翻调用方）
  $rc = Invoke-PsScript -Script (Get-ToolPath -Root $Root -Name 'publish.ps1')
  if ($rc -ne 0) { throw "部署失败（exit $rc）" }
}

# ── 执行 ─────────────────────────────────────────────────────
switch ($Action) {
  'status' {
    Step '当前投稿口令状态'
    $on = Get-SecretState
    if ($null -eq $on) {
      Write-Host '  状态未知' -ForegroundColor Yellow
      exit 1
    }
    if ($on) {
      Write-Host '  投稿口令：已配置（留言板开放）' -ForegroundColor Yellow
      Write-Host "  留言板地址：$SiteUrl/board/" -ForegroundColor Green
      Write-Host '  把口令发给投稿人，他们凭口令进入留言板。' -ForegroundColor DarkGray
    } else {
      Write-Host '  投稿口令：未配置（留言板关闭，访问返回 503）' -ForegroundColor Green
    }
    exit 0
  }

  'on' {
    Step '开启留言板投稿口令'
    if (-not $Token) {
      # 自动生成：必须够长。16 位 × 5 bit ≈ 80 bit 熵。
      $Token = New-SubmitToken
    } elseif ($Token.Length -lt 5) {
      throw '口令太短，至少 5 位'
    } else {
      # 用户自己指定的口令 —— 尊重用户选择，只提示强度，不拦。
      # 强度提示不是形式主义：留言板是公网上的写入口，
      # 口令一短，爆破空间就小一个量级。
      if ($Token.Length -lt 8) {
        Write-Host "  ! 口令只有 $($Token.Length) 位，强度偏低。" -ForegroundColor Yellow
        Write-Host '    爆破空间会小很多。留言板有 Origin 校验 + 限流兜着，' -ForegroundColor DarkGray
        Write-Host '    但如果投稿范围变大，建议换长一点的：' -ForegroundColor DarkGray
        Write-Host '      tools/board.ps1 -Action rotate' -ForegroundColor DarkGray
      }
    }
    Set-SubmitSecret $Token
    Write-Host '  已写入 SUBMIT_TOKEN（secret 本身读不回来，这里回显本地生成的值）' -ForegroundColor Green
    Publish-After
    Write-Host ''
    Write-Host '  留言板地址（复制这个发给投稿人）：' -ForegroundColor Green
    Write-Host "    $SiteUrl/board/" -ForegroundColor White
    Write-Host ''
    Write-Host '  投稿口令（只有拿到它的人能留言）：' -ForegroundColor Green
    Write-Host "    $Token" -ForegroundColor White
    Write-Host ''
    Write-Host '  把地址和口令一起发给投稿人；他们凭口令进入，30 天内不用重复输入。' -ForegroundColor DarkGray
    exit 0
  }

  'rotate' {
    Step '更换投稿口令'
    if (-not $Token) { $Token = New-SubmitToken }
    Set-SubmitSecret $Token
    Write-Host '  已更新 SUBMIT_TOKEN' -ForegroundColor Green
    Publish-After
    Write-Host "  新口令：$Token" -ForegroundColor White
    exit 0
  }

  'off' {
    Step '关闭留言板'
    Remove-SubmitSecret
    Write-Host '  已删除 SUBMIT_TOKEN' -ForegroundColor Green
    Publish-After
    exit 0
  }
}
