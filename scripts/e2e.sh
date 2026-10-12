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
#   E2E_NESTED=1      interactive mode (`make nested`, scripts/nested.sh):
#                     instead of the headless test run, open a visible
#                     mutter-devkit window on the host Wayland display with
#                     only the extension under test enabled, at schema
#                     defaults; no driver runs. Ends when the devkit window
#                     is closed. See "Nested mode" below.
#   NESTED_TIMEOUT=s  nested mode: stop the shell after s seconds (default:
#                     run until the window is closed)
#   NESTED_HELPER=1   nested mode: also load the test helper extension
#                     (org.wporter.SnapTest: LaunchApp, ListWindows,
#                     Screenshot) for scripted checks; off by default

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
    # Nested mode loads the test helper only with NESTED_HELPER=1.
    if [[ -z ${E2E_NESTED:-} || -n ${NESTED_HELPER:-} ]]; then
        cp -r "$REPO/tests/e2e/$HELPER" "$EXT_DIR/"
    fi
    rm -f "$EXT_DIR/$UUID/schemas/gschemas.compiled"
    glib-compile-schemas "$EXT_DIR/$UUID/schemas"

    # Nested mode: the only thing taken from the host is the Wayland display
    # socket, passed by absolute path so the private XDG_RUNTIME_DIR stays.
    NESTED_ENV=()
    if [[ -n ${E2E_NESTED:-} ]]; then
        HOST_WL=${WAYLAND_DISPLAY:-}
        [[ -n $HOST_WL && $HOST_WL != /* ]] && HOST_WL=${XDG_RUNTIME_DIR:-}/$HOST_WL
        if [[ -z ${WAYLAND_DISPLAY:-} || ! -S $HOST_WL ]]; then
            echo "nested mode needs a host Wayland session (WAYLAND_DISPLAY='${WAYLAND_DISPLAY:-}')" >&2
            exit 1
        fi
        NESTED_ENV=(E2E_NESTED=1 E2E_HOST_WAYLAND="$HOST_WL"
            NESTED_TIMEOUT="${NESTED_TIMEOUT:-}" NESTED_HELPER="${NESTED_HELPER:-}")
    fi

    # Private D-Bus configs. The test session bus can only activate dconf
    # (no portals, evolution, ...; nested mode: see below). A separate empty "system" bus keeps the
    # nested shell away from the host's logind/GDM/NetworkManager: with the
    # real system bus it would monitor the host login session, register it
    # with GDM and could set the host session's LockedHint.
    mkdir -p "$RUN/dbus/services"
    cp /usr/share/dbus-1/services/ca.desrt.dconf.service "$RUN/dbus/services/"
    write_bus_conf() { # type listen-address servicedir|standard|"" file
        {
            echo '<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"'
            echo ' "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">'
            echo "<busconfig><type>$1</type><listen>$2</listen>"
            echo '<auth>EXTERNAL</auth>'
            if [[ $3 == standard ]]; then
                echo '<standard_session_servicedirs/>'
            elif [[ -n $3 ]]; then
                echo "<servicedir>$3</servicedir>"
            fi
            echo '<policy context="default"><allow send_destination="*" eavesdrop="true"/>'
            echo '<allow eavesdrop="true"/><allow own="*"/></policy></busconfig>'
        } >"$4"
    }
    SESSION_SERVICES=$RUN/dbus/services
    RT=$RUN/rt
    if [[ -n ${E2E_NESTED:-} ]]; then
        # Nested mode (Amendment 5): apps must open. Most GNOME apps are
        # DBusActivatable (the shell launches them through
        # org.freedesktop.Application on the session bus) and use gvfs,
        # portals, keyring, ... So the private session bus activates every
        # standard session service ($XDG_DATA_HOME, $XDG_DATA_DIRS and
        # $XDG_RUNTIME_DIR dbus-1/services), each started with the private
        # environment. The system bus stays private and empty.
        SESSION_SERVICES=standard
        # pipewire-0-manager, gvfs and app sockets under $RUN/rt overflow
        # sun_path in deep checkouts: use a short private runtime dir,
        # linked as $RUN/rt and removed afterwards.
        RT=$(mktemp -d "${TMPDIR:-/tmp}/snapnest-XXXXXX")
        chmod 0700 "$RT"
        rmdir "$RUN/rt"
        ln -s "$RT" "$RUN/rt"
    fi
    # Fixed short socket names: unix:dir= appends dbus-XXXXXXXXXX, which
    # overflows sun_path (107 bytes) for deep checkouts such as worktrees.
    write_bus_conf session "unix:path=$RT/bus" "$SESSION_SERVICES" "$RUN/dbus/session.conf"
    SYSTEM_SOCK=$RT/sysbus  # keep short: AF_UNIX paths max 107 bytes
    write_bus_conf system "unix:path=$SYSTEM_SOCK" "" "$RUN/dbus/system.conf"
    dbus-daemon --config-file="$RUN/dbus/system.conf" --nofork --nopidfile \
        2>>"$RUN/session.log" &
    SYSTEM_BUS_PID=$!
    if [[ -n ${E2E_NESTED:-} ]]; then
        trap 'kill "$SYSTEM_BUS_PID" 2>/dev/null || true; rm -rf "$RT"' EXIT
    else
        trap 'kill "$SYSTEM_BUS_PID" 2>/dev/null || true' EXIT
    fi
    for _ in $(seq 50); do
        [[ -S $SYSTEM_SOCK ]] && break
        sleep 0.1
    done
    if [[ ! -S $SYSTEM_SOCK ]]; then
        echo "private system bus failed to start (see $RUN/session.log)" >&2
        exit 1
    fi

    # Nested mode: every process of the private session (shell, devkit
    # viewer, pipewire, bus-activated services, clients started with
    # scripts/nested.sh --run) carries E2E_RUN=$RUN; stop any survivors.
    run_pids() {
        local p
        for p in /proc/[0-9]*; do
            [[ -O $p ]] || continue
            if tr '\0' '\n' 2>/dev/null <"$p/environ" | grep -qxF "E2E_RUN=$1"; then
                echo "${p#/proc/}"
            fi
        done
    }
    reap_nested() {
        local pids sig
        for sig in TERM KILL; do
            for _ in $(seq 30); do
                pids=$(run_pids "$1")
                [[ -z $pids ]] && return 0
                sleep 0.1
            done
            echo "stopping leftover processes (SIG$sig): $(echo $pids)"
            # shellcheck disable=SC2086
            kill -s "$sig" $pids 2>/dev/null || true
        done
    }

    HOST_DCONF=$HOME/.config/dconf/user
    host_mtime() { stat -c '%.9Y' "$HOST_DCONF" 2>/dev/null || echo missing; }
    BEFORE=$(host_mtime)

    status=0
    # Nested mode: Ctrl+C reaches every process in the terminal's group;
    # keep going here so the cleanup and isolation check below still run.
    [[ -n ${E2E_NESTED:-} ]] && trap 'echo "interrupted"' INT
    env -i \
        "${NESTED_ENV[@]}" \
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
        SNAP_REVIEW="${SNAP_REVIEW:-}" E2E_EXTRA_MONITOR="${E2E_EXTRA_MONITOR:-}" \
        E2E_CLIENT_DEBUG="${E2E_CLIENT_DEBUG:-}" E2E_HOLD="${E2E_HOLD:-}" \
        dbus-run-session --config-file="$RUN/dbus/session.conf" \
        -- "$REPO/scripts/e2e.sh" "$@" \
        2>>"$RUN/session.log" || status=$?
    [[ -n ${E2E_NESTED:-} ]] && reap_nested "$RUN"
    kill "$SYSTEM_BUS_PID" 2>/dev/null || true
    wait "$SYSTEM_BUS_PID" 2>/dev/null || true
    trap - EXIT
    if [[ -n ${E2E_NESTED:-} ]]; then
        trap - INT
        # The private runtime dir (bus, pipewire, wayland, gvfs sockets).
        rm -rf "$RT"
    fi

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

# ---- Nested mode (E2E_NESTED=1): a visible, interactive shell.
#
# `gnome-shell --devkit` runs mutter's headless backend and spawns
# /usr/libexec/mutter-devkit, a GTK viewer that inherits the shell's
# environment except WAYLAND_DISPLAY, which mutter resets to the value the
# shell itself was started with (here: the host socket's absolute path, so
# the viewer is the only client of the host compositor). The viewer talks to
# the nested shell over the PRIVATE session bus (org.gnome.Mutter.Devkit,
# ScreenCast, RemoteDesktop/EIS) and receives the monitor frames over
# PipeWire, so a private pipewire + wireplumber (policy only: no ALSA,
# Bluetooth, camera, logind or portal access) runs in the private
# XDG_RUNTIME_DIR. Closing the viewer terminates the shell.
# Session bus activation: all standard session services (apps, gvfs,
# portals, ...), started inside the private environment; there is no systemd
# user manager on the private bus, so the shell cannot put launched apps into
# transient scopes (a harmless "Could not create transient scope" warning).
# Monitors: each viewer window is one virtual monitor sized by the window
# (viewer menu: "Add Monitor"); --virtual-monitor would add a monitor that
# no viewer window shows, so it is not offered here.
nested_main() {
    # Globals (not local): nested_cleanup may run from the EXIT trap.
    pw_pid='' wp_pid='' shell_pid='' viewer_pid='' state='' status=0
    gsettings set org.gnome.shell disable-user-extensions false
    if [[ -n ${NESTED_HELPER:-} ]]; then
        gsettings set org.gnome.shell enabled-extensions "['$HELPER', '$UUID']"
    else
        gsettings set org.gnome.shell enabled-extensions "['$UUID']"
    fi
    gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'
    # The private session cannot unlock a lock screen (no GDM/PAM on the
    # empty system bus), so never lock or blank.
    gsettings set org.gnome.desktop.session idle-delay 0
    gsettings set org.gnome.desktop.screensaver lock-enabled false
    # Schema defaults for the extension, except debug logging.
    GSETTINGS_SCHEMA_DIR=$EXT_SCHEMAS gsettings set org.gnome.shell.extensions.snap-layouts debug true
    # Devkit menu launchers: run inside the nested session (the viewer adds
    # the nested WAYLAND_DISPLAY). The dash and app grid work as well.
    gsettings set org.gnome.mutter.devkit launchers \
        "[('exec', 'gnome-text-editor --standalone', ''), ('exec', 'nautilus --new-window', ''), ('exec', 'ptyxis --standalone', ''), ('exec', '/usr/bin/python3 $E2E_REPO/tests/e2e/client.py --title client', '')]"
    # There is no systemd user manager here (the host's must not be used),
    # so `systemd-run --user --scope CMD` cannot work. Ptyxis wraps every
    # shell in it when `systemd-run --version` reports systemd, and shows
    # "Failed to connect to user scope bus". This shim, first in PATH,
    # reports no systemd and runs scope requests without a scope.
    mkdir -p "$RUN/bin"
    cat >"$RUN/bin/systemd-run" <<'EOF'
#!/bin/sh
# Nested-shell shim: no systemd user manager in the private session.
[ "$1" = --version ] && { echo "nested-shell shim (no systemd user manager)"; exit 0; }
case " $* " in *" --scope "*) ;; *) echo "systemd-run: not available in the nested shell" >&2; exit 1 ;; esac
while [ $# -gt 0 ]; do
    case $1 in
        --) shift; break ;;
        -*) shift ;;
        *) break ;;
    esac
done
exec "$@"
EOF
    chmod +x "$RUN/bin/systemd-run"
    export PATH="$RUN/bin:$PATH"
    # gnome-control-center only runs under GNOME; portals pick their GNOME
    # backend (talking to the nested shell) from it as well.
    export XDG_CURRENT_DESKTOP=GNOME
    # Bus-activated apps and services show on the nested display.
    dbus-update-activation-environment WAYLAND_DISPLAY="$DISPLAY_NAME" GDK_BACKEND=wayland \
        PATH="$PATH" XDG_CURRENT_DESKTOP=GNOME

    mkdir -p "$RUN/config/pipewire/pipewire.conf.d"
    cat >"$RUN/config/pipewire/pipewire.conf.d/50-nested.conf" <<'EOF'
# Private pipewire for the devkit viewer: no realtime (RTKit), portal,
# X11 bell or JACK D-Bus detection.
context.properties = {
    module.rt = false
    module.portal = false
    module.x11.bell = false
    module.jackdbus-detect = false
}
EOF
    pipewire >"$RUN/pipewire.log" 2>&1 &
    pw_pid=$!
    for _ in $(seq 50); do
        [[ -S $XDG_RUNTIME_DIR/pipewire-0 ]] && break
        sleep 0.1
    done
    if [[ ! -S $XDG_RUNTIME_DIR/pipewire-0 ]]; then
        echo "private pipewire failed to start (see $RUN/pipewire.log)"
        kill "$pw_pid" 2>/dev/null || true
        return 1
    fi
    wireplumber --profile policy >"$RUN/wireplumber.log" 2>&1 &
    wp_pid=$!

    env -u GSK_RENDERER WAYLAND_DISPLAY="$E2E_HOST_WAYLAND" \
        gnome-shell --devkit --wayland --no-x11 \
        --wayland-display "$DISPLAY_NAME" >"$LOG" 2>&1 &
    shell_pid=$!

    nested_cleanup() {
        local pid
        for pid in "$shell_pid" "$wp_pid" "$pw_pid"; do
            [[ -n $pid ]] || continue
            kill -TERM "$pid" 2>/dev/null || true
            for _ in $(seq 50); do
                kill -0 "$pid" 2>/dev/null || break
                sleep 0.1
            done
            kill -KILL "$pid" 2>/dev/null || true
            wait "$pid" 2>/dev/null || true
        done
    }
    trap nested_cleanup EXIT

    # Ready = the devkit viewer is running and the extension is ACTIVE.
    state=''
    viewer_pid=''
    for _ in $(seq 300); do
        if ! kill -0 "$shell_pid" 2>/dev/null; then
            echo "gnome-shell exited during startup; log tail:"
            tail -n 40 "$LOG"
            return 1
        fi
        [[ -n $viewer_pid ]] || viewer_pid=$(pgrep -P "$shell_pid" -x mutter-devkit || true)
        state=$(gnome-extensions info "$UUID" 2>/dev/null | sed -n 's/^ *State: //p')
        [[ -n $viewer_pid && $state == ACTIVE ]] && break
        sleep 0.1
    done

    printf '%s=%q\n' \
        E2E_RUN "$RUN" HOME "$HOME" USER "$USER" LOGNAME "$LOGNAME" \
        PATH "$PATH" LANG "$LANG" \
        XDG_CONFIG_HOME "$XDG_CONFIG_HOME" XDG_DATA_HOME "$XDG_DATA_HOME" \
        XDG_CACHE_HOME "$XDG_CACHE_HOME" XDG_STATE_HOME "$XDG_STATE_HOME" \
        XDG_RUNTIME_DIR "$XDG_RUNTIME_DIR" XDG_SESSION_TYPE wayland \
        XDG_DATA_DIRS "$XDG_DATA_DIRS" XDG_CURRENT_DESKTOP GNOME \
        NO_AT_BRIDGE 1 GTK_A11Y none \
        DBUS_SESSION_BUS_ADDRESS "$DBUS_SESSION_BUS_ADDRESS" \
        DBUS_SYSTEM_BUS_ADDRESS "$DBUS_SYSTEM_BUS_ADDRESS" \
        WAYLAND_DISPLAY "$DISPLAY_NAME" GDK_BACKEND wayland \
        NESTED_SHELL_PID "$shell_pid" NESTED_SHELL_LOG "$LOG" \
        >"$RUN/nested.env"

    cat <<EOF
nested gnome-shell pid $shell_pid, devkit viewer pid ${viewer_pid:-NOT RUNNING}
extension $UUID: ${state:-unknown}
wayland display $XDG_RUNTIME_DIR/$DISPLAY_NAME, shell log $LOG
launch apps inside (devkit menu has launchers too):
  $E2E_REPO/scripts/nested.sh --run gnome-text-editor --standalone
  $E2E_REPO/scripts/nested.sh --run /usr/bin/python3 $E2E_REPO/tests/e2e/client.py
  (private environment: $RUN/nested.env)
close the devkit window (or Ctrl+C) to stop.
EOF
    if [[ -z $viewer_pid || $state != ACTIVE ]]; then
        echo "WARNING: nested session not fully up (see $LOG, $RUN/session.log)"
    fi

    status=0
    if [[ -n ${NESTED_TIMEOUT:-} ]]; then
        sleep "$NESTED_TIMEOUT" &
        timer_pid=$!
        wait -n "$shell_pid" "$timer_pid" || true
        kill "$timer_pid" 2>/dev/null || true
        kill -TERM "$shell_pid" 2>/dev/null || true
    fi
    wait "$shell_pid" || status=$?
    echo "gnome-shell exited (status $status)"
    nested_cleanup
    trap - EXIT
    grep -En 'JS ERROR|Extension [^ ]+@[^ ]+:|Could not load extension|(CRITICAL|WARNING).*snap-?layouts' \
        "$LOG" | head -n 20 || true
    return 0
}
if [[ -n ${E2E_NESTED:-} ]]; then
    nested_main
    exit
fi

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
# E2E_EXTRA_MONITOR=WxH adds one more monitor to the right (e.g. 1080x1920
# portrait for the @portrait scenarios; `make e2e` runs that second pass).
[[ -n ${E2E_EXTRA_MONITOR:-} ]] && EXTRA_MONITORS+=(--virtual-monitor "$E2E_EXTRA_MONITOR")
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
