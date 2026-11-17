#!/bin/bash
# macOS 夜间发布包装器 —— 给 launchd 用的。
#
# 为什么要有这个壳：
#   launchd 不做 PATH 查找（它的 EnvironmentVariables PATH 很死板），
#   而 pwsh 的安装位置有好几种（brew cask / 官方 pkg / dotnet tool），
#   所以这里自己按已知路径挨个试，找到就用。
#
# 它只做两件事：找到 pwsh → 跑 tools/night-publish.ps1。
# 真正的流程、闸门、幂等、标记全在那个 .ps1 里 —— **跟 Windows 跑的是同一份**，
# 没有第二套实现，所以不会出现「两边行为慢慢分叉」。
#
# 用法：
#   bash tools/macos/run-night-publish.sh            # 正常跑（闸门会自己判断）
#   bash tools/macos/run-night-publish.sh -Force     # 强行发（跳过闸门）
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$PROJECT_DIR/tools/night-publish.ps1"

PWSH_BIN=""
for c in \
  "$HOME/.dotnet/tools/pwsh" \
  "/opt/homebrew/bin/pwsh" \
  "/usr/local/bin/pwsh" \
  "/usr/bin/pwsh"
do
  if [ -x "$c" ]; then PWSH_BIN="$c"; break; fi
done
if [ -z "$PWSH_BIN" ]; then
  PWSH_BIN="$(command -v pwsh 2>/dev/null || true)"
fi
if [ -z "$PWSH_BIN" ]; then
  echo "[night] 找不到 pwsh（PowerShell 7）。装一个：brew install --cask powershell" >&2
  exit 127
fi

if [ ! -f "$SCRIPT" ]; then
  echo "[night] 找不到 $SCRIPT" >&2
  exit 1
fi

cd "$PROJECT_DIR" || exit 1
echo "[night] 用 $PWSH_BIN 跑 $SCRIPT"
# 不加 -ExecutionPolicy：Unix 上没有执行策略这回事，加了也没意义
# （Windows 那边的 .ps1 入口才需要 Bypass）。
exec "$PWSH_BIN" -NoProfile -File "$SCRIPT" "$@"
