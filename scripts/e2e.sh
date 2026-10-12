#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Host-isolated end-to-end test: runs a private headless GNOME Shell with the
# snap-layouts extension and the test helper extension, then drives real
# pointer drags through Mutter via tests/e2e/run.py.
#
#   scripts/e2e.sh [--list] [scenario|tag ...]
#
# Everything (HOME, XDG dirs, dconf database, D-Bus session bus, a private
# empty "system" bus, Wayland socket) lives under .e2e/run-<timestamp>/.
# The host session, host dconf, host logind/GDM and host extension
# directories are never touched.
#
# Environment:
#   E2E_TIMEOUT=secs  overall timeout for the driver (default 240)
#   E2E_EXT_SRC=dir   extension directory to test (default ./snap-layouts@wporter.org)
#   E2E_HOLD=1        keep the private shell running after the scenarios
#                     until $RUN/hold is removed (debugging)

set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
UUID=snap-layouts@wporter.org
HELPER=snaptest@wporter.org
PY=/usr/bin/python3

if [[ ${1:-} == --list ]]; then
    exec "$PY" "$REPO/tests/e2e/run.py" --list
fi

if [[ -z ${E2E_INNER:-} ]]; then
    # ---- outer stage: prepare the isolated run dir, then re-exec inside a
    # private D-Bus session with a fully private environment.
    RUN=$REPO/.e2e/run-$(date +%Y%m%d-%H%M%S)-$$
    mkdir -p "$RUN"
    for d in home config data cache state rt; do
        mkdir -p "$RUN/$d"
        chmod 0700 "$RUN/$d"
    done

    EXT_DIR=$RUN/data/gnome-shell/extensions
    mkdir -p "$EXT_DIR"
    # E2E_EXT_SRC lets the harness test another tree (e.g. a merge
    # candidate) without touching this one.
    EXT_SRC=${E2E_EXT_SRC:-$REPO/$UUID}
    cp -r "$EXT_SRC" "$EXT_DIR/$UUID"
    cp -r "$REPO/tests/e2e/$HELPER" "$EXT_DIR/"
    rm -f "$EXT_DIR/$UUID/schemas/gschemas.compiled"
    glib-compile-schemas "$EXT_DIR/$UUID/schemas"

    # Private D-Bus configs. The session bus can only activate dconf (no
    # portals, evolution, ...). A separate empty "system" bus keeps the
    # nested shell away from the host's logind/GDM/NetworkManager: with the
    # real system bus it would monitor the host login session, register it
    # with GDM and could set the host session's LockedHint.
    mkdir -p "$RUN/dbus/services"
    cp /usr/share/dbus-1/services/ca.desrt.dconf.service "$RUN/dbus/services/"
    write_bus_conf() { # type listen-address servicedir|""
        {
            echo '<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"'
            echo ' "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">'
            echo "<busconfig><type>$1</type><listen>$2</listen>"
            echo '<auth>EXTERNAL</auth>'
            [[ -n $3 ]] && echo "<servicedir>$3</servicedir>"
            echo '<policy context="default"><allow send_destination="*" eavesdrop="true"/>'
            echo '<allow eavesdrop="true"/><allow own="*"/></policy></busconfig>'
        } >"$4"
    }
    # Fixed short socket names: unix:dir= appends dbus-XXXXXXXXXX, which
    # overflows sun_path (107 bytes) for deep checkouts such as worktrees.
    write_bus_conf session "unix:path=$RUN/rt/bus" "$RUN/dbus/services" "$RUN/dbus/session.conf"
    SYSTEM_SOCK=$RUN/rt/sysbus  # keep short: AF_UNIX paths max 107 bytes
    write_bus_conf system "unix:path=$SYSTEM_SOCK" "" "$RUN/dbus/system.conf"
    dbus-daemon --config-file="$RUN/dbus/system.conf" --nofork --nopidfile \
        2>>"$RUN/session.log" &
    SYSTEM_BUS_PID=$!
    trap 'kill "$SYSTEM_BUS_PID" 2>/dev/null || true; [[ $RT == /tmp/* ]] && rm -f "$RT"' EXIT
    for _ in $(seq 50); do
        [[ -S $SYSTEM_SOCK ]] && break
        sleep 0.1
    done
    if [[ ! -S $SYSTEM_SOCK ]]; then
        echo "private system bus failed to start (see $RUN/session.log)" >&2
        exit 1
    fi

    HOST_DCONF=$HOME/.config/dconf/user
    host_mtime() { stat -c '%.9Y' "$HOST_DCONF" 2>/dev/null || echo missing; }
    BEFORE=$(host_mtime)

    status=0
    env -i \
        DBUS_SYSTEM_BUS_ADDRESS="unix:path=$SYSTEM_SOCK" \
        HOME="$RUN/home" USER="${USER:-}" LOGNAME="${LOGNAME:-}" \
        PATH="/usr/local/bin:/usr/bin:/bin" LANG=C.UTF-8 \
        XDG_CONFIG_HOME="$RUN/config" XDG_DATA_HOME="$RUN/data" \
        XDG_CACHE_HOME="$RUN/cache" XDG_STATE_HOME="$RUN/state" \
        XDG_RUNTIME_DIR="$RT" XDG_SESSION_TYPE=wayland \
        XDG_DATA_DIRS="/usr/local/share:/usr/share" \
        NO_AT_BRIDGE=1 GTK_A11Y=none GSK_RENDERER=cairo \
        E2E_INNER=1 E2E_RUN="$RUN" E2E_REPO="$REPO" \
        E2E_TIMEOUT="${E2E_TIMEOUT:-$([[ -n ${SNAP_REVIEW:-} ]] && echo 900 || echo 240)}" \
        SNAP_REVIEW="${SNAP_REVIEW:-}" \
        E2E_CLIENT_DEBUG="${E2E_CLIENT_DEBUG:-}" E2E_HOLD="${E2E_HOLD:-}" \
        dbus-run-session --config-file="$RUN/dbus/session.conf" \
        -- "$REPO/scripts/e2e.sh" "$@" \
        2>>"$RUN/session.log" || status=$?
    kill "$SYSTEM_BUS_PID" 2>/dev/null || true
    wait "$SYSTEM_BUS_PID" 2>/dev/null || true
    trap - EXIT
    [[ $RT == /tmp/* ]] && rm -f "$RT"

    AFTER=$(host_mtime)
    echo "host dconf mtime before: $BEFORE"
    echo "host dconf mtime after:  $AFTER"
    if [[ $BEFORE != "$AFTER" ]]; then
        echo "ISOLATION VIOLATION: host dconf database changed" >&2
        status=1
    fi
    echo "run dir: $RUN"
    exit "$status"
fi

# ---- inner stage: running inside the private dbus-run-session.
RUN=$E2E_RUN
LOG=$RUN/gnome-shell.log
EXT_SCHEMAS=$RUN/data/gnome-shell/extensions/$UUID/schemas
DISPLAY_NAME=wl-$$  # short: $XDG_RUNTIME_DIR/<name> must fit sun_path

# Only enable the extension under test if it actually has an extension.js;
# otherwise the harness itself (smoke) can still be exercised.
ENABLED="'$HELPER'"
if [[ -f $RUN/data/gnome-shell/extensions/$UUID/extension.js ]]; then
    # Helper first: disabling an extension makes the shell disable and
    # re-enable every extension enabled after it.
    ENABLED="$ENABLED, '$UUID'"
    export E2E_EXT_PRESENT=1
else
    echo "WARNING: $UUID/extension.js missing; extension under test NOT enabled"
    export E2E_EXT_PRESENT=0
fi

gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell enabled-extensions "[$ENABLED]"
gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'
# Keep the private session from locking/blanking mid-test.
gsettings set org.gnome.desktop.session idle-delay 0
gsettings set org.gnome.desktop.screensaver lock-enabled false
# Deterministic defaults for the extension under test.
GSETTINGS_SCHEMA_DIR=$EXT_SCHEMAS gsettings set org.gnome.shell.extensions.snap-layouts gap 0
GSETTINGS_SCHEMA_DIR=$EXT_SCHEMAS gsettings set org.gnome.shell.extensions.snap-layouts debug true

# Review runs: SNAP_REVIEW=core adds a 1280x1024 monitor, SNAP_REVIEW=ux a
# 4K monitor, right of the primary (see tests/e2e/review_*_scenarios.py).
EXTRA_MONITORS=()
case ${SNAP_REVIEW:-} in
    core) EXTRA_MONITORS=(--virtual-monitor 1280x1024) ;;
    ux)   EXTRA_MONITORS=(--virtual-monitor 3840x2160) ;;
    '') ;;
    *) echo "SNAP_REVIEW must be core or ux (got '$SNAP_REVIEW')" >&2; exit 2 ;;
esac
gnome-shell --headless --wayland --no-x11 \
    --virtual-monitor 1920x1080 "${EXTRA_MONITORS[@]}" \
    --wayland-display "$DISPLAY_NAME" \
    >"$LOG" 2>&1 &
SHELL_PID=$!
echo "gnome-shell pid $SHELL_PID, wayland display $DISPLAY_NAME, log $LOG"

cleanup() {
    if kill -0 "$SHELL_PID" 2>/dev/null; then
        kill -TERM "$SHELL_PID" 2>/dev/null || true
        for _ in $(seq 50); do
            kill -0 "$SHELL_PID" 2>/dev/null || break
            sleep 0.1
        done
        kill -KILL "$SHELL_PID" 2>/dev/null || true
    fi
    wait "$SHELL_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for the helper's bus name (= shell up and extensions loaded).
ready=0
for _ in $(seq 300); do
    if ! kill -0 "$SHELL_PID" 2>/dev/null; then
        echo "gnome-shell exited during startup; log tail:"
        tail -n 40 "$LOG"
        exit 1
    fi
    if gdbus call --session --dest org.freedesktop.DBus \
        --object-path /org/freedesktop/DBus \
        --method org.freedesktop.DBus.NameHasOwner org.wporter.SnapTest \
        2>/dev/null | grep -q true; then
        ready=1
        break
    fi
    sleep 0.1
done
if [[ $ready != 1 ]]; then
    echo "helper D-Bus name never appeared; log tail:"
    tail -n 40 "$LOG"
    exit 1
fi

export WAYLAND_DISPLAY=$DISPLAY_NAME GDK_BACKEND=wayland
export E2E_EXT_SCHEMAS=$EXT_SCHEMAS E2E_SHELL_LOG=$LOG
status=0
timeout --kill-after=10 "$E2E_TIMEOUT" \
    /usr/bin/python3 "$E2E_REPO/tests/e2e/run.py" --run-dir "$RUN" "$@" 2>&1 \
    || status=$?

# Debug aid: E2E_HOLD=1 keeps the private shell alive (max 10 min) until
# $RUN/hold is removed; source $RUN/session.env to talk to it.
if [[ -n ${E2E_HOLD:-} ]]; then
    printf 'export DBUS_SESSION_BUS_ADDRESS=%q WAYLAND_DISPLAY=%q XDG_RUNTIME_DIR=%q GDK_BACKEND=wayland E2E_SHELL_LOG=%q E2E_EXT_SCHEMAS=%q\n' \
        "$DBUS_SESSION_BUS_ADDRESS" "$WAYLAND_DISPLAY" "$XDG_RUNTIME_DIR" \
        "$LOG" "$EXT_SCHEMAS" >"$RUN/session.env"
    touch "$RUN/hold"
    echo "HOLDING: source $RUN/session.env; rm $RUN/hold to finish"
    for _ in $(seq 6000); do
        [[ -e $RUN/hold ]] || break
        sleep 0.1
    done
fi

cleanup
trap - EXIT

# Fail on any JS error / exception / extension error in the shell log.
# (logError() on extension failures is logged as "GNOME Shell-CRITICAL ...
# Extension <uuid>: ..."; console.error/warn as CRITICAL/WARNING.)
BAD_RE='JS ERROR|Exception|Extension [^ ]+@[^ ]+:|Could not load extension|Gjs-CRITICAL|(CRITICAL|WARNING).*snap-?(layouts|test)'
if grep -En "$BAD_RE" "$LOG" >"$RUN/log-errors.txt"; then
    echo "FAIL: errors in gnome-shell log ($LOG):"
    head -n 40 "$RUN/log-errors.txt"
    status=1
else
    echo "shell log clean (no JS errors/exceptions)"
fi
exit "$status"
