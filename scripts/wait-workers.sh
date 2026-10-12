#!/usr/bin/env bash
# Block until every named worker has written $REPO_ROOT/.runs/<name>/exit, then print a summary.
# Safe to re-arm after a Hermes restart (it only watches files).
# Usage: wait-workers.sh <name>...   (run via terminal(background=true, notify_on_complete=true))
set -uo pipefail
root="${REPO_ROOT:?set REPO_ROOT}"
[ "$#" -gt 0 ] || { echo "usage: wait-workers.sh <name>..." >&2; exit 2; }
while :; do
  pending=0
  for n in "$@"; do
    [ -f "$root/.runs/$n/exit" ] && continue
    unit="$(printf '%s' "claude-worker-$(basename "$root")-$n" | tr -c 'A-Za-z0-9_.-' '-')"
    # A unit that vanished without an exit file was killed (e.g. OOM/stop): record it so we never hang.
    if ! systemctl --user is-active --quiet "$unit" && ! systemctl --user is-activating --quiet "$unit" 2>/dev/null; then
      sleep 2
      [ -f "$root/.runs/$n/exit" ] || echo "exit=lost (unit $unit not running, no exit file)" > "$root/.runs/$n/exit"
      continue
    fi
    pending=$((pending + 1))
  done
  [ "$pending" -eq 0 ] && break
  sleep 20
done
for n in "$@"; do printf '%s: %s\n' "$n" "$(cat "$root/.runs/$n/exit")"; done
