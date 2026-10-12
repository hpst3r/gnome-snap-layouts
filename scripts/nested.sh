#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Interactive, host-isolated nested GNOME Shell for manual testing.
#
#   scripts/nested.sh                 open a devkit window with the working
#                                     tree's extension (= E2E_NESTED=1
#                                     scripts/e2e.sh; see its header)
#   scripts/nested.sh --run CMD ...   start CMD inside the running nested
#                                     session, with its private environment
#
# Apps also open from the nested dash/app grid (standard session services
# are activated on the private session bus).
#
# Environment: NESTED_TIMEOUT=secs stops the nested shell after secs;
# NESTED_HELPER=1 also loads the test helper extension (scripted checks).

set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

if [[ ${1:-} != --run ]]; then
    E2E_NESTED=1 exec "$REPO/scripts/e2e.sh" "$@"
fi
shift
if [[ $# == 0 ]]; then
    echo "usage: $0 --run COMMAND [ARGS...]" >&2
    exit 2
fi

# Newest run dir whose nested shell is still alive.
envfile=''
for f in $(ls -1t "$REPO"/.e2e/run-*/nested.env 2>/dev/null); do
    pid=$(sed -n 's/^NESTED_SHELL_PID=//p' "$f")
    if [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null; then
        envfile=$f
        break
    fi
done
if [[ -z $envfile ]]; then
    echo "no running nested shell (start one with: make nested)" >&2
    exit 1
fi

# Only the private environment: no host bus, display or config.
exec env -i /bin/bash -c 'set -a; . "$1"; set +a; shift; exec "$@"' \
    nested-run "$envfile" "$@"
