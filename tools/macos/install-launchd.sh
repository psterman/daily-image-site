#!/bin/bash
# 把夜间发布装成 macOS 的 launchd 定时任务（对标 Windows 那边的
# 「计划任务 DailyImageSite-NightPublish-0010」+「启动文件夹 your-project-night.cmd」）。
#
# 用法（在项目根目录）：
#   bash tools/macos/install-launchd.sh
#
# 装完检查：
#   launchctl print gui/$(id -u)/com.your-project.night-publish | head -20
#
# ⚠️ 装之前先看 docs/macos-migration.md —— 依赖（pwsh / node / python / ffmpeg）
#    和「不能注销、不能睡眠」这两条是前提，launchd 本身不管这些。
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LABEL="com.your-project.night-publish"
AGENT_DIR="$HOME/Library/LaunchAgents"
AGENT="$AGENT_DIR/$LABEL.plist"
TEMPLATE="$PROJECT_DIR/tools/macos/$LABEL.plist"

if [ ! -f "$TEMPLATE" ]; then
  echo "找不到模板：$TEMPLATE" >&2
  exit 1
fi

# ── 前置检查 ──────────────────────────────────────────────────
MISSING=""
if ! command -v pwsh >/dev/null 2>&1 \
   && [ ! -x "/opt/homebrew/bin/pwsh" ] && [ ! -x "/usr/local/bin/pwsh" ] \
   && [ ! -x "$HOME/.dotnet/tools/pwsh" ]; then
  MISSING="$MISSING pwsh(brew install --cask powershell)"
fi
command -v node >/dev/null 2>&1 || MISSING="$MISSING node(brew install node)"
command -v python3 >/dev/null 2>&1 || MISSING="$MISSING python3(brew install python@3.12)"
command -v ffmpeg >/dev/null 2>&1 || MISSING="$MISSING ffmpeg(brew install ffmpeg)"
if [ -n "$MISSING" ]; then
  echo "缺这些依赖：$MISSING" >&2
  echo "先装上再重跑本脚本。" >&2
  exit 1
fi

# ── 写 plist ─────────────────────────────────────────────────
mkdir -p "$AGENT_DIR"
# 用真实项目路径替换模板里的占位符。
# 先把路径里的 sed 特殊字符转义掉（| 是分隔符，& 是「匹配到的内容」，
# \ 是转义符）—— 项目路径里真出现这些字符的概率很低，但出了就是难查的坑。
ESCAPED_DIR="$(printf '%s' "$PROJECT_DIR" | sed -e 's/[&|\\]/\\&/g')"
sed "s|__PROJECT_DIR__|$ESCAPED_DIR|g" "$TEMPLATE" > "$AGENT"
echo "已写入 $AGENT"

# ── 装载 ─────────────────────────────────────────────────────
# bootout/unload 先做一次：重复安装时 launchd 会报「already loaded」。
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || \
  launchctl unload "$AGENT" 2>/dev/null || true

if launchctl bootstrap "gui/$UID" "$AGENT" 2>/dev/null; then
  echo "已 bootstrap（macOS 10.10+ 的现代方式）"
else
  launchctl load "$AGENT"
  echo "已 load（旧版方式）"
fi

echo ""
launchctl list | grep "$LABEL" || echo "（launchctl list 里没看到 $LABEL —— 看下面的日志）"

# ── 睡眠设置 ─────────────────────────────────────────────────
echo ""
echo "—— 当前的电源设置 ——"
pmset -g custom 2>/dev/null || echo "（读不到 pmset）"
echo ""
echo "要让它 24 小时不休眠（接电时），跑："
echo "    sudo pmset -c sleep 0"
echo ""
echo "说明：**显示器可以照常息屏** —— macOS 息屏只关显示器，后台任务照跑。"
echo "      真正打断它的是「系统睡眠」。"
echo "      另外 LaunchAgent 属于用户会话，**注销登录后就不会再跑了**（锁屏无妨）。"

echo ""
echo "—— 装完了，下一步 ——"
echo "1) 手动试跑一次（绕开闸门，会真的发布）："
echo "     bash tools/macos/run-night-publish.sh -Force"
echo "2) 或者先干跑看闸门行为（现在是白天，应该被挡住）："
echo "     bash tools/macos/run-night-publish.sh"
echo "3) 看日志："
echo "     tail -f \"$PROJECT_DIR/.night-publish-console.log\""
