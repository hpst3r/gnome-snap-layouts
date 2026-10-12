#!/usr/bin/env bash
# Detach one worker (scripts/run-worker.sh <name>) as a transient systemd USER SERVICE, so it
# survives Hermes/desktop/terminal restarts. Returns immediately.
# Usage: launch-worker.sh <name>
# Env: same as run-worker.sh (REPO_ROOT required). WORKER_MEM (default 6G) and WORKER_NICE
#   (default 10) become service properties (no nested scope).
# Output: $REPO_ROOT/.runs/<name>/{result.json,stderr.log,exit}; `exit` holds "exit=<rc>" when done.
# Manage: systemctl --user status|stop <unit>; unit name printed on stdout.
set -euo pipefail
name="$1"
root="${REPO_ROOT:?set REPO_ROOT}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$root/.runs/$name"
mkdir -p "$out"
rm -f "$out/exit"
unit="claude-worker-$(basename "$root")-$name"
unit="$(printf '%s' "$unit" | tr -c 'A-Za-z0-9_.-' '-')"

if systemctl --user is-active --quiet "$unit"; then
  echo "$unit is already running" >&2; exit 4
fi
systemctl --user reset-failed "$unit" 2>/dev/null || true

# The user manager does not inherit this shell's environment: pass what the worker needs.
envs=(-E PATH="$PATH" -E HOME="$HOME" -E WORKER_NO_SCOPE=1)
for v in REPO_ROOT WT_ROOT WT_DIR WORKER_MODEL WORKER_TOOLS WORKER_MEM CLAUDE_GATE_ACCOUNT; do
  if [ -n "${!v:-}" ]; then envs+=(-E "$v=${!v}"); fi
done

systemd-run --user --unit="$unit" --collect -q \
  -p WorkingDirectory="$root" \
  -p MemoryMax="${WORKER_MEM:-6G}" -p MemorySwapMax=0 -p Nice="${WORKER_NICE:-10}" \
  "${envs[@]}" \
  /bin/bash -c '"$0" "$1"; rc=$?; echo "exit=$rc" > "$2/exit"; exit $rc' \
  "$here/run-worker.sh" "$name" "$out"
echo "$unit"
