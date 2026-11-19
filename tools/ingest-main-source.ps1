<#
  ingest-main-source.ps1 —— 把真实 RSS 条目灌入 Supabase platform 共享池

  设计原则（对应 docs/data-model.md 的版权红线）：
    1. 只有「主源编辑池」这一个 authorized 源作为 source_id —— 第三方源不冒充授权；
    2. 每条只写 title + 短摘要(<=160) + 原文链接，rights_status='unknown'，不存图/正文；
    3. canonical_url 归一化去重，与 lib/ingest-map.mjs 的 contentHash 语义一致；
    4. 标签挂到真实 tag_pack uuid；
    5. 用 service_role（secret key）走 Data API 写共享池，PAT 完全不参与；
    6. 灌入后写一条 ai_runs(audit) 留痕（可选）。

  凭证从 .env.local 读取，绝不硬编码。secret key 只在 PowerShell 进程内存里。

  用法：
    powershell -ExecutionPolicy Bypass -File tools/ingest-main-source.ps1 -FeedUrl 'https://aihot.news/feed.xml' -Limit 12 -TagKey 'ai'
#>
param(
  [Parameter(Mandatory = $true)][string]$FeedUrl,
  [int]$Limit = 12,
  [string]$TagKey = 'ai',
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env.local'

function Get-Env($name) {
  $line = Get-Content $envFile -Encoding UTF8 | Where-Object { $_ -like "$name=*" } | Select-Object -First 1
  if (-not $line) { throw "缺少环境变量 $name（见 .env.local）" }
  return ($line -replace "^$name=", '')
}

$url  = Get-Env 'SUPABASE_URL'
$sk   = Get-Env 'SUPABASE_SERVICE_ROLE_KEY'   # service_role：唯一能写共享池的 key
$pk   = Get-Env 'SUPABASE_PUBLISHABLE_KEY'

# 管理端 client（service_role）—— 只在本进程内，绝不打印
$hAdmin = @{
  'apikey'         = $sk
  'Authorization'  = "Bearer $sk"
  'Accept-Profile' = 'platform'
  'Content-Profile'= 'platform'
  'Content-Type'   = 'application/json'
}
# 公开读 client（用于查 tag/source id，只读即可）
$hRead = @{
  'apikey'         = $pk
  'Authorization'  = "Bearer $pk"
  'Accept-Profile' = 'platform'
}

function Fnv1a([string]$s) {
  # 关键：PowerShell 5.1 把 0xffffffff 这类字面量解析成负 Int32，位运算会错。
  # 必须用十进制常量 + UInt64 全程计算，结果才与 JS（Math.imul）一致。
  [uint64]$h = 2166136261      # 0x811c9dc5
  [uint64]$prime = 16777619    # 0x01000193
  [uint64]$mask = 4294967295   # 0xffffffff
  foreach ($ch in $s.ToCharArray()) {
    $h = $h -bxor [uint64][int][char]$ch
    $h = ($h * $prime) -band $mask
  }
  return $h.ToString('x8')
}
function NormUrl([string]$u) {
  return ($u -replace '^https?://','' -replace '[?#].*$','' -replace '/+$','').ToLower()
}
function HtmlDecode([string]$s) {
  $s = $s -replace '<[^>]+>',' '
  $s = [System.Net.WebUtility]::HtmlDecode($s)
  return ($s -replace '\s+',' ').Trim()
}
function Cut([string]$s, [int]$n) {
  if ($s.Length -le $n) { return $s }
  return $s.Substring(0, $n)
}

# 1. 取 source（主源编辑池）与 tag_pack 的真实 id
$sources = Invoke-RestMethod -Uri "$url/rest/v1/sources`?select=id,name,rights_status,allow_snippet&limit=50" -Headers $hRead -Method Get
$mainSrc = @($sources | Where-Object { $_.name -eq '主源编辑池' })[0]
if (-not $mainSrc) { throw '未找到「主源编辑池」source，请先跑 seed-core.sql' }
if ($mainSrc.rights_status -ne 'authorized' -or -not $mainSrc.allow_snippet) {
  throw '主源编辑池必须 rights_status=authorized 且 allow_snippet=true'
}
$packs = Invoke-RestMethod -Uri "$url/rest/v1/tag_packs`?select=id,key&limit=50" -Headers $hRead -Method Get
$tagId = (@($packs | Where-Object { $_.key -eq $TagKey })[0]).id
if (-not $tagId) { throw "未找到标签包 $TagKey" }

# 2. 抓 RSS
Write-Output "抓取 $FeedUrl …"
$r = Invoke-WebRequest -Uri $FeedUrl -TimeoutSec 25 -UseBasicParsing -Headers @{
  'User-Agent' = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36'
}
$xml = [System.Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
$matches = [regex]::Matches($xml, '<item\b[^>]*>([\s\S]*?)</item>')

$rows = @()
$seen = @{}
foreach ($m in $matches) {
  if ($rows.Count -ge $Limit) { break }
  $b = $m.Groups[1].Value
  $title = HtmlDecode ([regex]::Match($b, '<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</title>').Groups[1].Value)
  $linkM = [regex]::Match($b, '<link>\s*(?:<!\[CDATA\[)?([^\s<>\]]+)')
  $link = $linkM.Groups[1].Value.Trim()
  $desc = HtmlDecode ([regex]::Match($b, '<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</description>').Groups[1].Value)
  if (-not $title -or $link -notmatch '^https?://') { continue }
  $key = NormUrl $link
  if ($seen.ContainsKey($key)) { continue }
  $seen[$key] = $true
  $hash = Fnv1a $key
  $pub = Cut $desc 160
  $rows += [pscustomobject]@{
    source_id     = $mainSrc.id
    canonical_url = $link
    content_hash  = $hash
    content_type  = 'article'
    title         = (Cut $title 200)
    summary       = if ($mainSrc.allow_snippet -and $pub) { $pub } else { $null }
    rights_status = 'unknown'   # 第三方条目诚实标记，不冒充 authorized
    language      = 'zh-CN'
    metadata      = @{ publisher = 'RSS主源'; tag_keys = @($TagKey); feed = $FeedUrl } | ConvertTo-Json -Compress
  }
}

Write-Output "解析到 $($rows.Count) 条待灌（去重后）"
if ($WhatIf) { $rows | ForEach-Object { Write-Output ("  · {0}" -f $_.title) }; exit 0 }
if ($rows.Count -eq 0) { Write-Output '无条目，退出'; exit 0 }

# 3. upsert content_items（on_conflict = source_id,content_hash），返回 id
$body = $rows | ConvertTo-Json -Depth 6 -Compress
$ins = Invoke-RestMethod -Uri "$url/rest/v1/content_items`?on_conflict=source_id,content_hash" `
  -Headers @{
    'apikey'=$sk; 'Authorization'="Bearer $sk"; 'Accept-Profile'='platform';
    'Content-Profile'='platform'; 'Content-Type'='application/json';
    'Prefer'='resolution=merge-duplicates,return=representation'
  } -Method Post -Body $body
$ids = @($ins | ForEach-Object { $_.id })
Write-Output "写入 content_items：$($ids.Count) 条"

# 4. 关联 content_tags（复合主键幂等）
$links = @($ids | ForEach-Object { [pscustomobject]@{
  content_item_id = $_
  tag_pack_id     = $tagId
  confidence      = 100
} })
if ($links.Count -gt 0) {
  $lbody = $links | ConvertTo-Json -Compress
  Invoke-RestMethod -Uri "$url/rest/v1/content_tags`?on_conflict=content_item_id,tag_pack_id" `
    -Headers @{
      'apikey'=$sk; 'Authorization'="Bearer $sk"; 'Accept-Profile'='platform';
      'Content-Profile'='platform'; 'Content-Type'='application/json';
      'Prefer'='resolution=merge-duplicates,return=minimal'
    } -Method Post -Body $lbody | Out-Null
  Write-Output "关联 content_tags：$(@($links).Count) 条 → $TagKey"
}

# 5. 验证共享池读得到
$check = Invoke-RestMethod -Uri "$url/rest/v1/content_items`?select=id&limit=1" -Headers $hRead -Method Get
Write-Output ("共享池 content_items 现有可读行数 >= {0}" -f @($check).Count)
Write-Output 'DONE'
