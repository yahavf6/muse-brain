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

# with_spinner <label> <fn> -- runs <fn> (a shell function, backgrounded) and animates a braille
# spinner on stdout while it runs, then a done/failed line. Skipped -- plain "label... done/failed"
# lines instead -- when stdout isn't a real terminal ([ -t 1 ], the textbook check for "should I
# draw on this fd", distinct from tty_available's "/dev/tty is readable for input" above), so a
# captured log (CI, `| tee`) never fills with \r-redrawn escape junk. The wrapped function's real
# exit status always propagates either way, so `set -e` still catches a genuine failure -- `wait`
# and the plain call are both inside an `if` specifically so their own nonzero status, captured
# on purpose, doesn't trip `set -e` before this function gets to report it and return it itself.
SPIN_FRAMES=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)
with_spinner() {
  local label="$1" fn="$2" rc=0
  if [ ! -t 1 ]; then
    echo "$label..."
    if "$fn"; then rc=0; else rc=$?; fi
    if [ $rc -eq 0 ]; then echo "$label: done"; else echo "$label: failed"; fi
    return $rc
  fi
  # git/npm/launchctl all print their own progress -- capture it instead of letting it interleave
  # with the \r-redrawn spinner line; dump it on failure so a real error is never hidden, only
  # deferred past the spinner.
  local log
  log="$(mktemp)"
  "$fn" >"$log" 2>&1 &
  local pid=$! i=0
  while kill -0 "$pid" 2>/dev/null; do
    printf '\r%s %s...' "${SPIN_FRAMES[$((i % ${#SPIN_FRAMES[@]}))]}" "$label"
    i=$((i + 1))
    sleep 0.1
  done
  if wait "$pid"; then rc=0; else rc=$?; fi
  if [ $rc -eq 0 ]; then
    printf '\r\033[K\xe2\x9c\x93 %s\n' "$label"
  else
    printf '\r\033[K\xe2\x9c\x97 %s failed\n' "$label"
    cat "$log" >&2
  fi
  rm -f "$log"
  return $rc
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
    step_update_repo() { cd "$MUSE_BRAIN_DIR" && git pull --ff-only; }
    with_spinner "Updating muse-brain" step_update_repo
  else
    step_clone_repo() { git clone "$MUSE_BRAIN_REPO" "$MUSE_BRAIN_DIR"; }
    with_spinner "Cloning muse-brain" step_clone_repo
  fi
  REPO_DIR="$MUSE_BRAIN_DIR"
fi

# ---- install deps ------------------------------------------------------------

step_install_deps() { cd "$REPO_DIR" && npm ci --omit=dev --no-audit --no-fund; }
with_spinner "Installing dependencies" step_install_deps

# ---- service ------------------------------------------------------------------

SERVICE_STARTED=
if [ -z "$NO_SERVICE" ]; then
  if [ "$(uname -s)" = "Darwin" ]; then
    step_install_service() { cd "$REPO_DIR" && bash scripts/service.sh install; }
    with_spinner "Installing the background service" step_install_service
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
