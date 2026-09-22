#!/bin/bash
# Install/manage the muse-brain launchd service. See docs/contracts.md, docs/design.md.
set -euo pipefail

LABEL="ai.musebrain.brain"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLIST_PATH="${SERVICE_PLIST_OUT:-$HOME/Library/LaunchAgents/$LABEL.plist}"
UID_GUI="gui/$(id -u)"

node_bin() {
  local n major
  n="$(command -v node 2>/dev/null)" || { echo "error: node not found on PATH" >&2; exit 1; }
  major="$("$n" -p "process.versions.node.split('.')[0]")"
  [ "$major" -ge 24 ] || { echo "error: node $major found ($n), need >= 24" >&2; exit 1; }
  printf '%s' "$n"
}

render_plist() {
  local node path_dir
  node="$(node_bin)"
  path_dir="$(dirname "$node")"
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$node</string>
		<string>--no-warnings=ExperimentalWarning</string>
		<string>$REPO_DIR/src/server.ts</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$REPO_DIR</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>$HOME/.brain/logs/launchd.log</string>
	<key>StandardErrorPath</key>
	<string>$HOME/.brain/logs/launchd.log</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>$path_dir:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
		<key>HOME</key>
		<string>$HOME</string>
	</dict>
</dict>
</plist>
PLIST
}

cmd_install() {
  mkdir -p "$HOME/.brain/logs" "$(dirname "$PLIST_PATH")"
  if launchctl print "$UID_GUI/$LABEL" >/dev/null 2>&1; then
    launchctl bootout "$UID_GUI/$LABEL" 2>/dev/null || true
  fi
  render_plist > "$PLIST_PATH"
  launchctl bootstrap "$UID_GUI" "$PLIST_PATH"
  launchctl kickstart -k "$UID_GUI/$LABEL"
  echo "installed $PLIST_PATH, bootstrapped and started $LABEL"
}

cmd_uninstall() {
  launchctl bootout "$UID_GUI/$LABEL" 2>/dev/null || true
  rm -f "$PLIST_PATH"
  echo "uninstalled: bootout $LABEL, removed $PLIST_PATH"
}

cmd_restart() {
  launchctl kickstart -k "$UID_GUI/$LABEL"
  echo "restarted $LABEL"
}

cmd_status() {
  launchctl print "$UID_GUI/$LABEL" 2>&1 | head -20
  echo "---"
  curl -s http://127.0.0.1:4747/api/version || echo "server not responding"
}

case "${1:-}" in
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  restart) cmd_restart ;;
  status) cmd_status ;;
  render) render_plist ;;
  *) echo "usage: $0 {install|uninstall|restart|status|render}" >&2; exit 1 ;;
esac
