<#
.SYNOPSIS
    一次性配置：Cloudflare 认证 -> R2 bucket -> （可选）访问口令。

.DESCRIPTION
    认证方式按优先级自动尝试：
      A. 复用已有 .env.local
      B. npx wrangler login   —— 浏览器点一次「允许」即可，不用手填 Token（推荐）
      C. 手动输入 Account ID + API Token

    之后自动创建 R2 bucket、探测上传权限、可选设置生命周期规则、可选设置访问口令。
    凭据写入 .env.local（已 gitignore），不会进 git 历史。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools/setup-cloudflare.ps1

.EXAMPLE
    # 让 R2 对象 90 天后自动过期（存储量恒定，历史页会裂图）
    powershell -ExecutionPolicy Bypass -File tools/setup-cloudflare.ps1 -AutoExpireDays 90
#>
param(
  [string]$AccountId,
  [string]$ApiToken,
  [string]$Bucket = 'your-bucket',
  [string]$Project = 'your-project',
  [string]$SiteUrl = 'https://example.com',
  [switch]$WithGate,
  [switch]$SkipPages,
  # R2 生命周期：对象多少天后自动删除。0 = 不设规则（默认，历史全部保留）
  [int]$AutoExpireDays = 0
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# 跨平台公共 helper（北京时间 / 起子进程的 shell / 图像根目录 / 路径拼接）。
. (Join-Path $PSScriptRoot 'common.ps1')

$envFile = Join-Path $Root '.env.local'

function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "  [X]  $m" -ForegroundColor Red; exit 1 }

# ── 工具函数 ──────────────────────────────────────────────

function Get-WranglerConfigPath {
  # wrangler v3 的 OAuth 配置目录按平台分（refresh-token.mjs 用的是同一套路径 ——
  # 两边必须一致，否则一个找到、另一个找不到）：
  #   Windows → %USERPROFILE%\AppData\Roaming\xdg.config\.wrangler\config\
  #   macOS/Linux → $XDG_CONFIG_HOME 或 ~/.config/.wrangler/config/
  $cands = @()
  if (Test-IsWindowsHost) {
    # 路径一律用 Join-Path + 正斜杠拼 —— Windows 照样认（Win32 接受正斜杠），
    # 但源码里不留反斜杠：反斜杠在 macOS 上是**合法文件名字符**，
    # 照抄到 macOS 会把整条路径当成一个文件名。
    $cands += (Join-Path $env:USERPROFILE '.wrangler/config/default.toml')
    $cands += (Join-Path $env:APPDATA 'xdg.config/.wrangler/config/default.toml')
    $cands += (Join-Path $env:USERPROFILE 'AppData/Roaming/xdg.config/.wrangler/config/default.toml')
    # XDG_CONFIG_HOME 可能没设，别拼出根目录路径
    if ($env:XDG_CONFIG_HOME) {
      $cands += (Join-Path $env:XDG_CONFIG_HOME '.wrangler/config/default.toml')
    }
  } else {
    # Unix 上必须用正斜杠 —— 反斜杠在 macOS 上是合法的**文件名字符**，不是分隔符
    if ($env:XDG_CONFIG_HOME) {
      $cands += (Join-Path $env:XDG_CONFIG_HOME '.wrangler/config/default.toml')
    }
    $cands += (Join-Path $HOME '.config/.wrangler/config/default.toml')
  }
  foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}

function Get-TokenFromWranglerConfig {
  $p = Get-WranglerConfigPath
  if (-not $p) { return $null }
  $raw = Get-Content $p -Raw
  # wrangler v3 写 oauth_token，v2 写 api_token
  if ($raw -match 'oauth_token\s*=\s*"([^"]+)"') { return $Matches[1] }
  if ($raw -match 'api_token\s*=\s*"([^"]+)"')   { return $Matches[1] }
  return $null
}

function Test-CloudflareAuth($acct, $tok) {
  try {
    $h = @{ Authorization = "Bearer $tok" }
    $r = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/accounts/$acct" -Headers $h -TimeoutSec 20
    return @{ ok = [bool]$r.success; name = $r.result.name; status = 200 }
  } catch {
    $status = 0
    try { $status = $_.Exception.Response.StatusCode.value__ } catch { }
    return @{ ok = $false; name = $null; status = $status }
  }
}

function Get-AccountList($tok) {
  try {
    $h = @{ Authorization = "Bearer $tok" }
    $r = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/accounts" -Headers $h -TimeoutSec 20
    if ($r.success) { return $r.result }
  } catch { }
  return @()
}

function Get-CfError($err) {
  # 从 Cloudflare API 的错误响应体里取出错误码（如 10042 = 未启用 R2）
  try {
    $stream = $err.Exception.Response.GetResponseStream()
    $sr = New-Object System.IO.StreamReader($stream)
    $body = $sr.ReadToEnd()
    $sr.Close()
    $j = $body | ConvertFrom-Json
    if ($j.errors -and $j.errors.Count -gt 0) {
      return @{ code = $j.errors[0].code; message = $j.errors[0].message }
    }
  } catch { }
  return $null
}

function Save-Env($acct, $tok) {
  @"
CLOUDFLARE_ACCOUNT_ID=$acct
CLOUDFLARE_API_TOKEN=$tok
R2_BUCKET=$Bucket
PAGES_PROJECT=$Project
SITE_URL=$SiteUrl
"@ | Set-Content -Path $envFile -Encoding UTF8
}

# ── 1. 认证 ───────────────────────────────────────────────
Step '1/5 Cloudflare 认证'

$acct = $AccountId
$tok  = $ApiToken
$authSource = '手动输入'

# A. 复用已有
if (-not $acct -and -not $tok -and (Test-Path $envFile)) {
  Write-Host '  检测到已有 .env.local，先复用：'
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$') { "    $($Matches[1]) = ******" }
  }
  $acct = ($env:CLOUDFLARE_ACCOUNT_ID)
  $tok  = ($env:CLOUDFLARE_API_TOKEN)
  $raw = Get-Content $envFile -Raw
  if ($raw -match 'CLOUDFLARE_ACCOUNT_ID\s*=\s*(\S+)') { $acct = $Matches[1] }
  if ($raw -match 'CLOUDFLARE_API_TOKEN\s*=\s*(\S+)')  { $tok  = $Matches[1] }
  $authSource = '复用 .env.local'
}

# B. wrangler login（浏览器点一次，最省事）
if (-not $acct -or -not $tok) {
  $existing = Get-TokenFromWranglerConfig
  if ($existing) {
    Write-Host '  发现 wrangler 登录态，尝试复用…'
    $tok = $existing
    $authSource = 'wrangler 登录态'
  } else {
    Write-Host ''
    Write-Host '  方式 B：wrangler 浏览器授权（推荐，不用手填 Token）' -ForegroundColor Yellow
    Write-Host '    接下来会打开浏览器，点「Allow / 允许」即可。'
    Write-Host ''
    $ans = (Read-Host '  现在执行 npx wrangler login 吗？(Y/N)').Trim()
    if ($ans -match '^[Yy]') {
      Write-Host '  正在启动 wrangler login，请在新开的浏览器页面点「允许」…' -ForegroundColor Cyan
      & npx --yes wrangler@latest login
      $existing = Get-TokenFromWranglerConfig
      if ($existing) {
        $tok = $existing
        $authSource = 'wrangler login'
      } else {
        Warn '没找到 wrangler 凭据文件，改用方式 C'
      }
    }
  }
}

# C. 手动输入
if (-not $tok) {
  Write-Host ''
  Write-Host '  方式 C：手动填写 API Token' -ForegroundColor Yellow
  Write-Host '    My Profile -> API Tokens -> Create Token' 
  Write-Host '    权限勾 Account -> Workers R2 Storage (Edit)' 
  Write-Host '            Account -> Cloudflare Pages  (Edit)' 
  Write-Host '            Account -> Workers Scripts   (Edit)' 
  Write-Host '    Account ID 不用填 —— 脚本会用 Token 自动查出来' -ForegroundColor DarkGray
  Write-Host ''
  $tok = (Read-Host '  API Token').Trim()
  $authSource = '手动输入'
}

if (-not $tok) { Die '缺少 Token' }

# ── 2. 自动定位账号 + 校验 ────────────────────────────────
Write-Host "  认证来源：$authSource"

# 有 Token 就能列出账号 —— Account ID 不该让用户手填
if (-not $acct -and $tok) {
  # 必须用 @() 包成数组：PS 5.1 下单个对象没有 .Count 属性
  $list = @(Get-AccountList $tok)
  if ($list.Count -eq 1) {
    $acct = $list[0].id
    Ok "自动定位账号：$($list[0].name)"
  } elseif ($list.Count -gt 1) {
    Write-Host ''
    Write-Host '  你名下有多个账号，请选：' -ForegroundColor Yellow
    for ($i = 0; $i -lt $list.Count; $i++) { "    [$($i+1)] $($list[$i].name)" }
    $pick = (Read-Host '  选哪个？(序号)')
    if ($pick -and $pick.Trim() -match '^\d+$' -and [int]$pick -le $list.Count) {
      $acct = $list[[int]$pick - 1].id
    }
  }
}

if (-not $acct) {
  Write-Host ''
  $answer = Read-Host '  Account ID（Cloudflare Dashboard 右侧）'
  $acct = if ($answer) { $answer.Trim() } else { '' }
}
if (-not $acct) { Die '缺少 Account ID' }

$check = Test-CloudflareAuth $acct $tok

if (-not $check.ok) {
  # 可能是账号选错了 —— 列出所有账号让用户挑
  $list = @(Get-AccountList $tok)
  if ($list.Count -gt 0) {
    Write-Host ''
    Write-Host '  你的账号列表：' -ForegroundColor Yellow
    for ($i = 0; $i -lt $list.Count; $i++) { "    [$($i+1)] $($list[$i].name)  ($($list[$i].id))" }
    $pick = Read-Host '  选哪个？(序号)'
    if ($pick -and $pick.Trim() -match '^\d+$' -and [int]$pick -le $list.Count) {
      $acct = $list[[int]$pick - 1].id
      $check = Test-CloudflareAuth $acct $tok
    }
  }
}

if (-not $check.ok) {
  $hint = switch ($check.status) {
    404     { 'Account ID 拼错了（API 返回 404：找不到这个账号）' }
    401     { 'API Token 无效或已过期' }
    403     { 'Token 有效但权限不够 —— 需勾选 Workers R2 Storage / Cloudflare Pages / Workers Scripts' }
    default { "HTTP $($check.status) —— 检查 Account ID 和 Token 是否填反" }
  }
  Die "凭据校验失败：$hint"
}
Ok "凭据有效，账号：$($check.name)"

Save-Env $acct $tok
Ok "凭据已写入 .env.local"

# ── 3. R2 bucket + 上传权限探测 ──────────────────────────
Step "2/5 R2 bucket：$Bucket"
$h = @{ Authorization = "Bearer $tok" }
$bucketOk = $false

# 先探测 R2 是否已启用（错误码 10042 = 未启用，不是权限问题）
$r2Ready = $true
try {
  $r = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/accounts/$acct/r2/buckets" -Headers $h -TimeoutSec 20
  if ($r.result | Where-Object { $_.name -eq $Bucket }) {
    Ok 'bucket 已存在'
    $bucketOk = $true
  }
} catch {
  $cf = Get-CfError $_
  if ($cf -and $cf.code -eq 10042) {
    $r2Ready = $false
  } else {
    Warn "查询 bucket 列表失败：$($_.Exception.Message)"
  }
}

if (-not $r2Ready) {
  Write-Host ''
  Write-Host '  [!]  这个 Cloudflare 账号还没启用 R2' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '  需要你手动开一次（Dashboard 里点一下，1 分钟）：' -ForegroundColor Yellow
  Write-Host '    Cloudflare Dashboard -> 左侧 R2 -> 「Enable R2 / 启用 R2」按钮'
  Write-Host '    免费额度 10GB/月，可能要求绑张卡（不扣费）' -ForegroundColor DarkGray
  Write-Host ''
  Write-Host '  这不妨碍先发版：publish.ps1 会自动走「静态兜底模式」，' -ForegroundColor Green
  Write-Host '  图片打进部署包，页面照常有图，只是不能像 R2 那样随时撤回。' -ForegroundColor Green
  Write-Host ''
  Write-Host '  启用后重跑本脚本（认证已配好，不用重来），再跑一次 publish.ps1 就切回 R2 模式。' -ForegroundColor Green
  Write-Host ''
  $r2Ready = $false
}

if (-not $bucketOk) {
  if (-not $r2Ready) {
    Write-Host '  跳过创建 bucket —— 等 R2 在 Dashboard 启用后再跑一次本脚本。' -ForegroundColor DarkGray
  } else {
    try {
      $body = @{ name = $Bucket } | ConvertTo-Json
      $c = Invoke-RestMethod -Method Post -Uri "https://api.cloudflare.com/client/v4/accounts/$acct/r2/buckets" `
           -Headers ($h + @{ 'Content-Type' = 'application/json' }) -Body $body -TimeoutSec 20
      if ($c.success) { Ok 'bucket 已创建'; $bucketOk = $true }
      else { Warn "创建失败：$($c.errors | ConvertTo-Json -Compress)" }
    } catch {
      $cf = Get-CfError $_
      if ($cf -and $cf.code -eq 10042) {
        Write-Host ''
        Write-Host '  [!]  R2 尚未启用。请到 Dashboard -> R2 点「启用」，然后重跑本脚本。' -ForegroundColor Yellow
      } else {
        Warn "创建失败：$($_.Exception.Message)"
      }
    }
  }
}

if ($bucketOk) {
  # 探测：能不能真的往 bucket 里写
  $probe = 'probe-setup-check.txt'
  $bytes = [byte[]]@(0x6F,0x6B)  # "ok"
  try {
    $up = Invoke-WebRequest -Method Put -Uri "https://api.cloudflare.com/client/v4/accounts/$acct/r2/buckets/$Bucket/objects/$probe" `
         -Headers ($h + @{ 'Content-Type' = 'text/plain' }) -Body $bytes -TimeoutSec 25 -UseBasicParsing
    if ($up.StatusCode -eq 200) {
      Ok 'R2 上传权限正常'
      # 删掉探针
      try {
        Invoke-WebRequest -Method Delete -Uri "https://api.cloudflare.com/client/v4/accounts/$acct/r2/buckets/$Bucket/objects/$probe" `
             -Headers $h -TimeoutSec 15 -UseBasicParsing | Out-Null
      } catch { }
    }
  } catch {
    $status = 0
    try { $status = $_.Exception.Response.StatusCode.value__ } catch { }
    if ($status -eq 403) {
      Write-Host ''
      Warn '当前凭据没有 R2 写权限（HTTP 403）'
      Write-Host '    R2 图片上传需要单独的 R2 API Token：' -ForegroundColor Yellow
      Write-Host '      Cloudflare Dashboard -> R2 -> Manage R2 API Tokens -> Create API Token'
      Write-Host '      权限选 Object Read & Write，范围只选 bucket「' -NoNewline -ForegroundColor Cyan
      Write-Host "$Bucket" -NoNewline -ForegroundColor White
      Write-Host '」' -ForegroundColor Cyan
      $rt = (Read-Host '  粘贴 R2 API Token（没有就回车跳过）').Trim()
      if ($rt) {
        Save-Env $acct $rt
        Ok '已改用 R2 API Token（注意：这个 Token 只能上传图片，部署仍走 wrangler login）'
      } else {
        Warn '跳过：图片上传会失败，Pages 部署不受影响'
      }
    } else {
      Warn "上传探测失败（HTTP $status）：$($_.Exception.Message)"
    }
  }
}

# ── 4. R2 生命周期规则（可选）────────────────────────────
Step '3/5 R2 生命周期规则（可选）'
if ($AutoExpireDays -le 0) {
  Warn '不设规则（默认）—— R2 对象永久保留，历史页永不裂图'
  Write-Host '    代价：存储量随天数线性增长（10GB 免费额度约够 3~4 年）' -ForegroundColor DarkGray
  Write-Host '    想设的话：加 -AutoExpireDays 90 之类，删除后历史页对应日期会裂图' -ForegroundColor DarkGray
} elseif (-not $r2Ready) {
  Warn 'R2 还没启用，跳过生命周期规则设置'
} else {
  $ruleName = "auto-expire-$AutoExpireDays"
  Write-Host "  将为对象添加规则：$ruleName（$AutoExpireDays 天后自动删除）"
  Write-Host '  提醒：过期后对应日期的历史页会裂图，且不可恢复。' -ForegroundColor Yellow
  try {
    & npx --yes wrangler@latest r2 bucket lifecycle add $Bucket $ruleName '' --expire-days $AutoExpireDays -y 2>&1 | Write-Host
    Ok "生命周期规则已添加（$AutoExpireDays 天）"
  } catch {
    Warn "添加生命周期规则失败：$($_.Exception.Message)"
  }
  try {
    & npx --yes wrangler@latest r2 bucket lifecycle list $Bucket 2>&1 | Write-Host
  } catch { }
}

# ── 5. Pages 项目 ─────────────────────────────────────────
Step "4/5 Cloudflare Pages 项目：$Project"
if ($SkipPages) {
  Warn '按要求跳过'
} else {
  Write-Host '  首次部署时 wrangler 会自动创建项目，无需手动操作。'
  Write-Host '  部署命令：publish.ps1'
}

# ── 6. 访问口令 ───────────────────────────────────────────
Step '5/5 访问口令（可选）'
if ($WithGate) {
  $gate = (Read-Host '  设置访问口令（回车 = 不启用）')
  if ($gate) {
    $gate | npx --yes wrangler@latest pages secret put GATE_TOKEN --project-name $Project 2>&1 | Write-Host
    Ok 'GATE_TOKEN 已设置：图片需要口令，页面和 logo 仍公开（保证微信分享卡片完整）'
  } else {
    Warn '未设置口令，全站公开'
  }
} else {
  Warn '未启用（全站公开）。需要时加 -WithGate，或之后执行：'
  Write-Host '    npx wrangler pages secret put GATE_TOKEN --project-name ' + $Project
}

Write-Host "`n配置完成。下一步：" -ForegroundColor Green
Write-Host "  powershell -ExecutionPolicy Bypass -File tools/publish.ps1"
Write-Host ""
if (-not $r2Ready) {
  Write-Host "提醒：R2 还没启用，本次发布会走静态兜底模式（图片打进部署包）。" -ForegroundColor Yellow
  Write-Host "      想用 R2 就去 Dashboard -> R2 点「启用」，然后重跑 setup + publish。" -ForegroundColor Yellow
  Write-Host ""
}
Write-Host "  绑定域名（可选）：Pages 项目 -> Custom domains -> $SiteUrl"
