#!/bin/bash
# Uninstall Conductor

PLIST_NAME="com.claude.dashboard"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
APP_PATH="$HOME/Applications/Conductor.app"

launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null \
  || launchctl unload "$PLIST_PATH" 2>/dev/null \
  || true

rm -f "$PLIST_PATH"
[ -d "$APP_PATH" ] && rm -rf "$APP_PATH" && echo "  Removed $APP_PATH"

echo ""
echo "  Conductor uninstalled"
echo "  Service stopped, plist removed."
echo ""
