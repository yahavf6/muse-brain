#!/bin/bash
# One-command bootstrap: curl -fsSL https://raw.githubusercontent.com/yahavf6/muse-brain/main/install.sh | bash
# Gets a fresh machine from nothing to a running brain plus the connect wizard (src/setup.ts).
# bash 3.2 compatible (macOS system bash) -- same constraint hooks/brain-hook.sh states in its
# own header, because `bash install.sh` / `| bash` resolves to that bash unless the caller
# already has a newer one first on PATH. POSIX [ ] tests, no associative arrays, no ${var,,}.
set -euo pipefail

YES=
NO_SERVICE=
for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    --no-service) NO_SERVICE=1 ;;
  esac
done

# Capture whether the caller explicitly set MUSE_BRAIN_REPO *before* defaulting it -- that's
# what decides whether the "already inside a checkout" shortcut below is allowed to apply.
CALLER_SET_REPO=
[ -n "${MUSE_BRAIN_REPO:-}" ] && CALLER_SET_REPO=1
: "${MUSE_BRAIN_DIR:=$HOME/.muse-brain}"
: "${MUSE_BRAIN_REPO:=https://github.com/yahavf6/muse-brain.git}"

# ---- preflight -------------------------------------------------------------

# tty_available -- true only if /dev/tty can actually be opened as this process's controlling
# terminal. `[ -r /dev/tty ]` is NOT this check: it only tests the device file's permission bit,
# which is always readable (crw-rw-rw-) even with no terminal attached at all (CI, a Docker RUN
# step, cron, `ssh host cmd` without -t) -- so it reports "yes" when there is in fact no tty.
tty_available() {
  ( exec < /dev/tty ) 2>/dev/null
}

# offer_brew <formula> -- tries `brew install <formula>` when brew exists, asking on /dev/tty
# first (never stdin -- this script is commonly piped from curl, so stdin is the download, not
# a terminal). Returns 1 (caller falls back to fixit) if brew is missing, declined, or fails.
offer_brew() {
  local name="$1" reply
  command -v brew >/dev/null 2>&1 || return 1
  if [ -n "$YES" ]; then
    brew install "$name" && return 0 || return 1
  fi
  if tty_available; then
    printf 'Install %s with Homebrew? [Y/n] ' "$name" > /dev/tty
    read -r reply < /dev/tty || reply=""
    case "$reply" in
      [Nn]*) return 1 ;;
      *) brew install "$name" && return 0 || return 1 ;;
    esac
  fi
  return 1
}

fixit() {
  local name="$1"
  echo "error: $name not found." >&2
  echo "  fix: brew install $name   # macOS" >&2
  echo "       sudo apt-get install -y $name   # Debian/Ubuntu (adjust for your distro)" >&2
  exit 1
}

# git/curl/sqlite3 ship with macOS -- no brew offer needed, just a clear fix-it message.
for t in git curl sqlite3; do
  command -v "$t" >/dev/null 2>&1 || fixit "$t"
done

command -v jq >/dev/null 2>&1 || offer_brew jq || fixit jq

# node_bin-style check, adapted from scripts/service.sh: must be on PATH and >= 24.
check_node_version() {
  local n major
  n="$(command -v node 2>/dev/null)" || { echo "error: node not found on PATH" >&2; exit 1; }
  major="$("$n" -p "process.versions.node.split('.')[0]" 2>/dev/null)" || major=""
  case "$major" in ''|*[!0-9]*) echo "error: could not read node version from $n" >&2; exit 1 ;; esac
  if [ "$major" -lt 24 ]; then
    echo "error: node $major found ($n), need >= 24" >&2
    echo "  fix: brew upgrade node   # macOS, or install from https://nodejs.org" >&2
    exit 1
  fi
}
command -v node >/dev/null 2>&1 || offer_brew node || fixit node
check_node_version

# ---- get the repo -----------------------------------------------------------

REPO_DIR=""
if [ -z "$CALLER_SET_REPO" ]; then
  SRC_DIR=""
  if [ -n "${BASH_SOURCE[0]:-}" ]; then
    SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)" || SRC_DIR=""
  fi
  # only take the shortcut when this script is itself sitting inside a real checkout.
  [ -n "$SRC_DIR" ] && [ -f "$SRC_DIR/src/server.ts" ] && REPO_DIR="$SRC_DIR"
fi

if [ -z "$REPO_DIR" ]; then
  if [ -d "$MUSE_BRAIN_DIR/.git" ]; then
    (cd "$MUSE_BRAIN_DIR" && git pull --ff-only)
  else
    git clone "$MUSE_BRAIN_REPO" "$MUSE_BRAIN_DIR"
  fi
  REPO_DIR="$MUSE_BRAIN_DIR"
fi

# ---- install deps ------------------------------------------------------------

(cd "$REPO_DIR" && npm ci --omit=dev --no-audit --no-fund)

# ---- service ------------------------------------------------------------------

SERVICE_STARTED=
if [ -z "$NO_SERVICE" ]; then
  if [ "$(uname -s)" = "Darwin" ]; then
    (cd "$REPO_DIR" && bash scripts/service.sh install)
    SERVICE_STARTED=1
  else
    echo "Linux service isn't automated yet -- start the server yourself: cd $REPO_DIR && npm start"
  fi
fi

if [ -n "$SERVICE_STARTED" ]; then
  # matches the spirit of scripts/service.sh's bootstrap retry loop.
  UP=
  i=1
  while [ "$i" -le 5 ]; do
    if curl -s "http://127.0.0.1:${BRAIN_PORT:-4747}/api/version" >/dev/null 2>&1; then
      UP=1
      break
    fi
    sleep 1
    i=$((i + 1))
  done
  if [ -n "$UP" ]; then
    echo "brain server is up on :${BRAIN_PORT:-4747}"
  else
    echo "warning: brain server did not respond after install -- check ~/.brain/logs/launchd.log"
  fi
fi

# ---- connect wizard -------------------------------------------------------------

cd "$REPO_DIR"
if [ -n "$YES" ] || ! tty_available; then
  node --no-warnings=ExperimentalWarning src/setup.ts --yes
else
  # this script's own stdin is the piped curl content, not a terminal -- read prompts from
  # /dev/tty directly so setup.ts can still ask interactively.
  node --no-warnings=ExperimentalWarning src/setup.ts < /dev/tty
fi

exit 0
