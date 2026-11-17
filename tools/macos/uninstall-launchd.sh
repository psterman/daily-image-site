#!/bin/bash
# 卸载 macOS 的夜间发布定时任务。
#
# 用法：
#   bash tools/macos/uninstall-launchd.sh
#
# 只删 launchd 任务，**不动工程里的任何东西**（日志、产物、标记都留着）。
set -uo pipefail

LABEL="com.your-project.night-publish"
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || \
  launchctl unload "$AGENT" 2>/dev/null || true

if [ -f "$AGENT" ]; then
  rm -f "$AGENT"
  echo "已删除 $AGENT"
else
  echo "本来就没有 $AGENT"
fi

echo "已卸载 $LABEL"
