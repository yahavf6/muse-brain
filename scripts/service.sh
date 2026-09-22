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
  case "$major" in ''|*[!0-9]*) echo "error: could not read node version from $n" >&2; exit 1 ;; esac
  [ "$major" -ge 24 ] || { echo "error: node $major found ($n), need >= 24" >&2; exit 1; }
  printf '%s' "$n"
}

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

render_plist() {
  local node path_dir node_x repo_x home_x pathdir_x
  node="$(node_bin)"
  path_dir="$(dirname "$node")"
  node_x="$(xml_escape "$node")"
  repo_x="$(xml_escape "$REPO_DIR")"
  home_x="$(xml_escape "$HOME")"
  pathdir_x="$(xml_escape "$path_dir")"
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$node_x</string>
		<string>--no-warnings=ExperimentalWarning</string>
		<string>$repo_x/src/server.ts</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$repo_x</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>$home_x/.brain/logs/launchd.log</string>
	<key>StandardErrorPath</key>
	<string>$home_x/.brain/logs/launchd.log</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>$pathdir_x:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
		<key>HOME</key>
		<string>$home_x</string>
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
  # launchd bootout can return before the job is actually unloaded, so a bootstrap
  # right after can race it; retry a few times instead of failing the install.
  local attempt=1
  until launchctl bootstrap "$UID_GUI" "$PLIST_PATH"; do
    [ "$attempt" -ge 3 ] && { echo "error: launchctl bootstrap failed after 3 attempts" >&2; exit 1; }
    attempt=$((attempt + 1))
    sleep 1
  done
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
  launchctl print "$UID_GUI/$LABEL" 2>&1 | head -20 || true
  echo "---"
  curl -s "http://127.0.0.1:${BRAIN_PORT:-4747}/api/version" || echo "server not responding"
}

case "${1:-}" in
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  restart) cmd_restart ;;
  status) cmd_status ;;
  render) render_plist ;;
  *) echo "usage: $0 {install|uninstall|restart|status|render}" >&2; exit 1 ;;
esac
