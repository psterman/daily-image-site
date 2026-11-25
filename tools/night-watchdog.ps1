<#
.SYNOPSIS
  夜间发布看门狗：检查当夜那一期到底发出去没有，没发出去就发告警。

.DESCRIPTION
  为什么需要它（2026-11-25 加）：
    夜间发布有三条失败路径，**前两条已经被覆盖，第三条是盲区**：

      ① 脚本自己报错（准备失败 / 发布失败）
         → night-publish.ps1 的 catch 兜住了 → 直接发 toast ✓
      ② 闸门/幂等跳过（白天跑、今天已发过）
         → exit 0，**不是失败**，不该告警 ✓
      ③ **进程被硬杀**（机器关机、任务被超时掐掉、蓝屏）
         → 没有 catch、没有 toast、**没有 .done 标记**、
           连「=== NIGHT_DONE exit=N ===」这行结束标记都没写
         → **完全静默**：早上只能靠人自己发现那一期没发 ⚠️

    ③ 正是历史上 11-14/11-15 两次「进程被硬杀、查不到原因」的形态。
    机器每晚 01:12~03:12 自动关机，而发布 00:10 起跑 → 这条路径不是假设，
    是**每晚都可能发生**（2026-11-17 那晚余量只剩 5.3 分钟）。

    看门狗的判据**只看「当夜该发的发了没有」**，不猜原因：
      · 当天的 `.night-publish-<日期>.done` 存在且 `"exit":0` → 发了，不告警；
      · 存在但 exit≠0 → 失败（夜间脚本自己已经告警过了，不重复打扰）；
      · **不存在** → 被硬杀/根本没跑 → 告警 ✓

    刻意**不判「日志停摆多久」** —— 那类判据会误报（见 AGENTS.md：
    判死时只把话术写进内存，不要写回日志文件，否则会刷新 mtime
    导致「多久没动」永远归零）。

.PARAMETER Date
  检查哪一期。默认北京今天。

.PARAMETER Quiet
  只判不发（测试用）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/night-watchdog.ps1
#>
param(
  [string]$Date,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

# 跨平台公共 helper（北京时间 / 工具路径 / toast）。
# 必须 dot-source（`.`）而不是 & 调用 —— & 调用不会把函数带进当前作用域。
. (Join-Path $PSScriptRoot 'common.ps1')

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

if (-not $Date) { $Date = Get-BjDate }
if ($Date -notmatch '^\d{4}-\d{2}-\d{2}$') {
  Write-Host "日期格式不对：'$Date'（应为 YYYY-MM-DD）"
  exit 2
}

$Marker = Join-Path $Root ".night-publish-$Date.done"
$LogFile = Join-Path $Root ".night-publish-$Date.log"

# ── 判据 ─────────────────────────────────────────────────────
#
# ① 有标记且 exit=0 → 发出去了，什么都不用做
if (Test-Path $Marker) {
  $raw = Get-Content $Marker -Raw -ErrorAction SilentlyContinue
  if ($raw -and $raw -match '"exit"\s*:\s*0') {
    Write-Host "  $Date 已发布（exit 0）—— 看门狗无事可做。"
    exit 0
  }
  # ② 有标记但 exit≠0 → 夜间脚本自己已经告警过了，不重复打扰
  Write-Host "  $Date 发布了但退出码非 0（夜间脚本已发过告警，这里不重复）。"
  exit 0
}

# ③ 没有标记 → 被硬杀，或根本没跑起来
$logExists = Test-Path $LogFile
$tail = ''
if ($logExists) {
  try {
    # 只读尾部，不改 mtime（改 mtime 会把「多久没动」这类判据永久归零）
    $tail = (Get-Content $LogFile -Tail 5 -Encoding UTF8 -ErrorAction SilentlyContinue) -join ' | '
  } catch { $tail = '' }
}

$msg = "期号 $Date 没有发布成功（既没有 .done 标记，也没有成功结束标记）。"
if ($logExists) {
  $msg += "`n日志尾部：$tail"
} else {
  $msg += "`n连日志文件都没生成 —— 可能是脚本压根没跑起来。"
}
$msg += "`n检查：机器是否在发布期间关机/重启，或看门狗任务自身是否正常。"

Write-Host $msg -ForegroundColor Red

if (-not $Quiet) {
  # 告警发不出去也不能掀翻看门狗（它只是补位）
  try {
    Send-Alert -Root $Root -Title '夜间发布没有完成' -Body $msg
  } catch {
    Write-Host "  （告警没发出去）"
  }
}

exit 1
