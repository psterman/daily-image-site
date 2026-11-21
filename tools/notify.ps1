param(
  [string]$Title = '任务台',
  [string]$Body = ''
)

# 跨平台公共 helper（北京时间 / 起子进程的 shell / 图像根目录 / 路径拼接 / toast 的 AUMID）。
# 必须 dot-source（`.`）而不是 & 调用 —— & 调用不会把函数带进当前作用域。
. (Join-Path $PSScriptRoot 'common.ps1')

# 用 WinRT 发一条 Windows toast —— 页面关着也能收到。
# 失败一律静默：通知是补位，不是主功能，绝不能因为它掀翻主流程。
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

try {
  if (-not $Body) { exit 0 }

  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null

  # PowerShell 自己的 AUMID —— 没有它 toast 发不出去。
  # 字面量住在 common.ps1 的 Get-ToastAumid：平台字面量（反斜杠路径 +
  # powershell.exe）只放那一个文件，tools/ 下别的 .ps1 里不许出现。
  $aumid = Get-ToastAumid

  $xml = @"
<toast scenario="reminder">
  <visual>
    <binding template="ToastGeneric">
      <text>$([System.Security.SecurityElement]::Escape($Title))</text>
      <text>$([System.Security.SecurityElement]::Escape($Body))</text>
    </binding>
  </visual>
</toast>
"@

  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($xml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid)
  $notifier.Show($toast)
} catch {
  # 发不出去就算了 —— 静默降级
}

exit 0
