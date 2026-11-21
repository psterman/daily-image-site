<#
.SYNOPSIS
  跨平台公共 helper（Windows / macOS / Linux 通用）。

.DESCRIPTION
  这套流程的入口全是 .ps1。迁到 macOS 时我们**不重写第二份脚本**，
  而是装 PowerShell 7（pwsh）直接跑同一份 .ps1 ——
  唯一要拆掉的是下面这五处 Windows 绑定：

    ① 时区 ID：Windows 叫 'China Standard Time'，macOS/Linux 叫 'Asia/Shanghai'
       .NET 在 Unix 上认不了 Windows 那个名字（抛 TimeZoneNotFoundException）。
       期号全靠这个算 —— 认错就直接差一天，是最危险的一处。
    ② 子进程：Windows 要起 powershell.exe，macOS 要起 pwsh。
    ③ 路径拼接：'tools/x.ps1' 这种反斜杠在 macOS 上**不是分隔符**
       （反斜杠在 Unix 文件名里是合法字符），会变成「找不到文件」。
    ④ python 探测：Windows 的候选目录在 macOS 上不存在。
    ⑤ 图像根目录：统一落在用户家目录下的 image-root（**不写盘符**）。

  用法（在脚本里 dot-source，不是 & 调用 —— & 调用不会把函数带进当前作用域）：
    . (Join-Path $PSScriptRoot 'common.ps1')

.NOTES
  ⚠️ 原生命令退出码的语义也在这里统一：
  PowerShell 7.4 起 $PSNativeCommandUseErrorActionPreference 默认 $true，
  「原生命令退出码非 0」会变成**终止性错误**；而本工程到处是
  「跑一下看退出码，不行就跳过」的老语义（PS 5.1）。
  这里压回 PS 5.1 语义，两个平台的行为才对得上。
#>

# ── 平台判定 ───────────────────────────────────────────────────
#
# $IsWindows 只有 PowerShell 6+ 才有；PS 5.1 上它是 $null。
# 所以判断必须写成「先看版本，再看 $IsWindows」——
# `-and` 是短路求值，PS 5.1 上右边根本不会被求值，不会踩空变量。
function Test-IsWindowsHost {
  if ($PSVersionTable.PSVersion.Major -ge 6) { return [bool]$IsWindows }
  return $true
}

# ── 原生命令退出码：压回 PS 5.1 语义 ───────────────────────────
#
# 为什么必须压：PS 7.4 起，默认 $true，
# 于是「python -c "import cv2" 失败」这种**探测性调用**
# 会直接把整个脚本掀翻（终止性错误），而不是像 PS 5.1 那样
# 「退出码非 0 → 记下来 → 继续」。
# 本工程到处都是这种探测式调用（依赖自检、token 续期、构建校验）。
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
  $PSNativeCommandUseErrorActionPreference = $false
}

# ── 北京时间 ───────────────────────────────────────────────────
#
# 期号 = 北京今天，而期号由「跑的那一刻是几号」决定（见 AGENTS.md）。
# 时区认错 → 期号差一天 → 整个「夜里发 / 早上审」的循环错位。
function Get-BjNow {
  <#
    返回北京时间的 DateTime。
    Windows 的时区 ID 是 'China Standard Time'，macOS/Linux 是 'Asia/Shanghai'。
    两个都试，先成功先用 —— Windows 上第一个就中，行为跟以前完全一样。
  #>
  foreach ($tzId in @('China Standard Time', 'Asia/Shanghai')) {
    try {
      return [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId((Get-Date), $tzId)
    } catch { }
  }
  # 两个都不认（机器时区库坏了）：退回本地时间，但要说清楚，别闷声发错期号。
  Write-Warning "认不出北京时区（China Standard Time / Asia/Shanghai），退回本机本地时间。"
  return (Get-Date)
}

function Get-BjDate {
  <#
    北京今天，格式 yyyy-MM-dd。
  #>
  return (Get-BjNow).ToString('yyyy-MM-dd')
}

# ── 起子进程用的 PowerShell ────────────────────────────────────
function Get-ShellExe {
  <#
    起子进程用的 PowerShell 可执行名。
    Windows → powershell.exe（系统自带，行为跟现在完全一样）
    macOS/Linux → pwsh（PowerShell 7，brew install --cask powershell）

    不要用 $PSHOME 去拼绝对路径：PS 5.1 的 $PSHOME 里是 powershell.exe，
    macOS 上装 pwsh 的方式不止一种（brew cask / 官方 pkg / dotnet tool），
    硬拼容易找错。按平台给命令名、靠 PATH 解析最稳。
  #>
  if (Test-IsWindowsHost) { return 'powershell.exe' }
  return 'pwsh'
}

# ── Windows toast 的 AppUserModelID ───────────────────────────
function Get-ToastAumid {
  <#
    发 Windows toast 必须指定**注册过的** AppUserModelID（AUMID），
    系统不认这个 AUMID → 通知发不出去，而且**不报错**（最难查的一类静默失败）。
    PowerShell 自己的 AUMID 就是下面这个。

    ⚠️ 这个字面量**必须住在 common.ps1**，不能写在 notify.ps1 里：
      它同时含**反斜杠路径**和**硬编码的 powershell.exe**，
      而工程约定是「平台字面量只放 common.ps1 一个文件」
      （test-night-flow.mjs 那两条扫描会把 tools/ 下别的 .ps1
        里的反斜杠路径 / 硬编码 powershell.exe 判红；
        那两条扫描都显式豁免 common.ps1）。
      所以 notify.ps1 只调这个函数，不自己拼。
  #>
  return '{1AC14E77-02E7-4E5D-B744-2EB1AE519E7B}\WindowsPowerShell\v1.0\powershell.exe'
}

# ── 图像根目录 ─────────────────────────────────────────────────
function Get-ImageRoot {
  <#
    图像根目录（src/ 和 r2/ 的父目录）。
    优先 $env:IMAGE_ROOT（.env.local 里也能设）；
    没有就落在**用户家目录**下的 image-root —— 所有平台一致。

    刻意不写盘符：写死 'D:\xxx' 的话，macOS 上没有 D 盘 →
    读源图的地方会静默拿到空目录（症状只是「今天没图」，**没有报错**）。
    Windows 没有 $HOME 这个自动变量，用 $env:USERPROFILE；
    macOS/Linux 有 $HOME。
  #>
  if ($env:IMAGE_ROOT) { return $env:IMAGE_ROOT }
  if (Test-IsWindowsHost) { return (Join-Path $env:USERPROFILE 'image-root') }
  return (Join-Path $HOME 'image-root')
}

function Get-SourceDateDir {
  <#
    某一期的源图目录：<图像根>/src/<日期>。
    站点「日期页 = 目录名」，图就在 src\<发布日>\ 里。
  #>
  param([Parameter(Mandatory = $true)][string]$Date)
  return (Join-Path (Join-Path (Get-ImageRoot) 'src') $Date)
}

# ── tools/ 下的文件 ────────────────────────────────────────────
function Get-ToolPath {
  <#
    tools/ 下某个文件的完整路径。
    不要写 'tools/xxx' —— 反斜杠在 macOS 上不是分隔符，
    'tools/daily-review.ps1' 在 macOS 上会被当成**一个文件名**（反斜杠是合法文件名字符），
    于是报「找不到文件」。所以永远用 Join-Path 拼。
  #>
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Name
  )
  return (Join-Path (Join-Path $Root 'tools') $Name)
}

# ── 起另一个 .ps1 子进程 ──────────────────────────────────────
function Invoke-PsScript {
  <#
    起一个 .ps1 子进程，**只认退出码，不认 stderr**。

    为什么：PS 5.1 里子进程往 stderr 写一行字就会被转成 ErrorRecord，
    而调用方 $ErrorActionPreference='Stop' → ErrorRecord 变成终止性错误
    → 整个脚本当场死掉（publish.ps1 为这件事死过两次）。
    macOS 上的 PowerShell 7 行为又不一样（stderr 不再自动变成 ErrorRecord），
    这里统一成「只看退出码」，两个平台的行为才对得上。

    stdout 接 Out-Host：屏幕照常实时刷，但**不混进函数返回值** ——
    返回值必须只有退出码，不然 `if ($rc -ne 0)` 会误判。
  #>
  param(
    [Parameter(Mandatory = $true)][string]$Script,
    [string[]]$ScriptArgs = @()
  )
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & (Get-ShellExe) '-NoProfile' '-ExecutionPolicy' 'Bypass' '-File' $Script @ScriptArgs | Out-Host
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevEap
  }
}
