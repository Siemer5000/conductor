#!/bin/bash
# Install Conductor as a macOS LaunchAgent
# Auto-starts on login, restarts on crash
# Works from any directory — no hardcoded paths

set -e

# Resolve the repo root (parent of scripts/)
DASHBOARD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_NAME="com.claude.dashboard"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
LOG_DIR="$HOME/.claude/dashboard-logs"
APP_DIR="$HOME/Applications"

# Detect Node.js
NODE_PATH=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -x "$candidate" ]; then NODE_PATH="$candidate"; break; fi
done
if [ -z "$NODE_PATH" ]; then
  NODE_PATH=$(which node 2>/dev/null)
fi
if [ -z "$NODE_PATH" ]; then
  echo "Error: Node.js not found. Install it from https://nodejs.org or via Homebrew."
  exit 1
fi

# Install npm dependencies if needed
if [ ! -d "$DASHBOARD_DIR/node_modules" ]; then
  echo "Installing dependencies..."
  cd "$DASHBOARD_DIR" && npm install --silent
fi

# Create log directory
mkdir -p "$LOG_DIR"
mkdir -p "$APP_DIR"

# Stop existing service if running
launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null \
  || launchctl unload "$PLIST_PATH" 2>/dev/null \
  || true

# Write plist
cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${DASHBOARD_DIR}/server.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${DASHBOARD_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
EOF

# Load and start
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null \
  || launchctl load "$PLIST_PATH"

# Compile macOS Dock app (optional — skip if osacompile unavailable)
APP_PATH="$APP_DIR/Conductor.app"
if command -v osacompile &>/dev/null && [ -f "$DASHBOARD_DIR/scripts/launch-dashboard.applescript" ]; then
  osacompile -o "$APP_PATH" "$DASHBOARD_DIR/scripts/launch-dashboard.applescript" 2>/dev/null && \
    echo "  Dock app: $APP_PATH (drag to Dock)"
fi

echo ""
echo "  Conductor installed"
echo "  ────────────────────────────────"
echo "  URL:      http://localhost:3456"
echo "  Logs:     ${LOG_DIR}/"
echo "  Plist:    ${PLIST_PATH}"
echo ""
echo "  Auto-starts on login. Restarts on crash."
echo "  To stop:  launchctl bootout gui/\$(id -u) ${PLIST_PATH}"
echo "  To start: launchctl bootstrap gui/\$(id -u) ${PLIST_PATH}"
echo ""
