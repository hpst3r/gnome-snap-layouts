# SPDX-License-Identifier: AGPL-3.0-or-later
"""E2E scenarios for the optional top bar menu (SPEC Amendment 3).

Auto-loaded by run.py; registers through ``import __main__ as R``.
"""

import os
import subprocess
import time

from gi.repository import Gio, GLib

import __main__ as R

NAME = "snap-layouts-indicator"
ITEM = NAME + "-item:"
SWITCH_KEYS = ("snap-assist", "restore-size-on-drag", "match-orientation")
ESCAPE = 0xff1b
SETTLE = 0.45  # menu open/close animations are ~250 ms


def ext_get(ctx, key):
    env = dict(os.environ, GSETTINGS_SCHEMA_DIR=ctx.schema_dir)
    return subprocess.run(["gsettings", "get", R.SCHEMA, key], env=env,
                          check=True, capture_output=True,
                          text=True).stdout.strip()


def exact(ctx, name):
    """Every actor named exactly `name` (FindActors matches prefixes)."""
    return [a for a in ctx.shell.actors(name) if a["name"] == name]


def is_checked(actor):
    return "checked" in (actor.get("pseudoClass") or "").split()


def switch_checked(ctx, key):
    a = ctx.actor(ITEM + key + ":switch")
    if not a:
        raise R.ScenarioFailure("switch actor for %s not found" % key)
    return is_checked(a)


def open_menu(ctx):
    button = ctx.wait_shown(NAME, 1.0)
    ctx.click(*R.centre(button))
    try:
        ctx.wait_shown(ITEM + "settings", 1.0)
    except R.ScenarioFailure:
        ctx.screenshot("no-menu")
        raise R.ScenarioFailure("indicator menu did not open on click")
    time.sleep(SETTLE)


def click_item(ctx, suffix):
    """Click an item on its label side (clear of the switch's own gesture)."""
    item = ctx.wait_shown(ITEM + suffix, 1.0)
    ctx.click(item["x"] + min(40, item["width"] / 4),
              item["y"] + item["height"] / 2)


def menu_closed(ctx):
    return not ctx.shown(ITEM + "settings")


@R.scenario("indicator-present", tags=("indicator",))
def sc_present(ctx):
    a = ctx.wait_shown(NAME, 1.0)
    panel_h = ctx.work_area()["y"]
    ctx.notes.append("indicator at %s (panel height %d)" % (R.fmt_rect(a),
                                                            panel_h))
    if a["y"] > 1 or a["y"] + a["height"] > panel_h + 1:
        raise R.ScenarioFailure("indicator %s not inside the top bar (0..%d)"
                                % (R.fmt_rect(a), panel_h))
    if len(exact(ctx, NAME)) != 1:
        raise R.ScenarioFailure("expected one %s actor, got %d"
                                % (NAME, len(exact(ctx, NAME))))
    time.sleep(SETTLE)
    ctx.screenshot("panel")


@R.scenario("indicator-toggle", tags=("indicator",))
def sc_toggle(ctx):
    offset = ctx.log_size()
    try:
        for i in range(5):
            ctx.ext_set("show-indicator", "false")
            R.wait_for(lambda: not ctx.shell.actors(NAME), 1.0, 0.02,
                       "indicator actors gone (round %d)" % (i + 1))
            ctx.ext_set("show-indicator", "true")
            ctx.wait_shown(NAME, 1.0)
            n = len(exact(ctx, NAME))
            if n != 1:
                raise R.ScenarioFailure("round %d: %d %s actors"
                                        % (i + 1, n, NAME))
            for key in SWITCH_KEYS + ("settings",):
                n = len(exact(ctx, ITEM + key))
                if n != 1:
                    raise R.ScenarioFailure("round %d: %d %s actors"
                                            % (i + 1, n, ITEM + key))
    finally:
        ctx.ext_set("show-indicator", "true")
    errs = ctx.log_errors_since(offset)
    if errs:
        raise R.ScenarioFailure("errors logged while toggling: %s" % errs[:5])
    ctx.notes.append("5 hide/show rounds, one indicator each time")


@R.scenario("indicator-switches", tags=("indicator",))
def sc_switches(ctx):
    for key in SWITCH_KEYS:
        if ext_get(ctx, key) != "true" or not switch_checked(ctx, key):
            raise R.ScenarioFailure("%s: setting %s / switch checked %s, "
                                    "expected both true"
                                    % (key, ext_get(ctx, key),
                                       switch_checked(ctx, key)))
    try:
        open_menu(ctx)
        ctx.screenshot("menu")
        click_item(ctx, "snap-assist")
        R.wait_for(lambda: ext_get(ctx, "snap-assist") == "false", 1.0, 0.05,
                   "snap-assist false after clicking the switch item")
        if switch_checked(ctx, "snap-assist"):
            raise R.ScenarioFailure("switch still checked after click")
        R.wait_for(lambda: menu_closed(ctx), 1.0, 0.05,
                   "menu closed after activating the item")

        # External change → switch follows, no write back.
        ctx.ext_set("snap-assist", "true")
        R.wait_for(lambda: switch_checked(ctx, "snap-assist"), 1.0, 0.02,
                   "switch checked after external change")
        ctx.ext_set("match-orientation", "false")
        R.wait_for(lambda: not switch_checked(ctx, "match-orientation"),
                   1.0, 0.02, "match-orientation switch unchecked")
        time.sleep(0.2)
        if ext_get(ctx, "snap-assist") != "true":
            raise R.ScenarioFailure("snap-assist bounced back to %s"
                                    % ext_get(ctx, "snap-assist"))

        open_menu(ctx)
        ctx.screenshot("menu-external")
        tap = ctx.shell.key
        tap(ESCAPE, True)
        tap(ESCAPE, False)
        R.wait_for(lambda: menu_closed(ctx), 1.0, 0.05,
                   "menu closed on Escape")
        ctx.notes.append("click -> snap-assist false; external true -> "
                         "switch checked; Escape closed the menu")
    finally:
        ctx.ext_set("snap-assist", "true")
        ctx.ext_set("match-orientation", "true")


def start_prefs_service(ctx):
    """Run the shell's prefs service by hand: the isolated session bus can
    only activate dconf (scripts/e2e.sh), which keeps it isolated."""
    log = open(os.path.join(ctx.run_dir, "%s-prefs-service.log" % ctx.name),
               "w")
    proc = subprocess.Popen(
        ["/usr/bin/gjs", "-m",
         "/usr/share/gnome-shell/org.gnome.Shell.Extensions"],
        stdout=log, stderr=subprocess.STDOUT)
    ctx.clients.append(proc)

    def owned():
        r = ctx.shell._conn.call_sync(
            "org.freedesktop.DBus", "/org/freedesktop/DBus",
            "org.freedesktop.DBus", "NameHasOwner",
            GLib.Variant("(s)", ("org.gnome.Shell.Extensions",)),
            None, Gio.DBusCallFlags.NONE, 2000, None)
        return r.unpack()[0]
    R.wait_for(owned, 10, 0.1, "org.gnome.Shell.Extensions on the bus")
    return proc


@R.scenario("indicator-settings", tags=("indicator",))
def sc_settings(ctx):
    start_prefs_service(ctx)
    if any(w["title"] == "Snap Layouts" for w in ctx.shell.windows()):
        raise R.ScenarioFailure("prefs window open before the click")
    open_menu(ctx)
    click_item(ctx, "settings")

    def prefs_win():
        for w in ctx.shell.windows():
            if w["title"] == "Snap Layouts":
                return w
        return None
    try:
        win = R.wait_for(prefs_win, 10, 0.1, "prefs window after Settings…")
    except R.ScenarioFailure:
        ctx.screenshot("no-prefs")
        raise
    ctx.wait_stable(win["id"])
    R.wait_for(lambda: menu_closed(ctx), 1.0, 0.05, "menu closed")
    time.sleep(SETTLE)
    ctx.screenshot("prefs")
    ctx.notes.append("prefs window %r %s" % (win["title"],
                                             R.fmt_rect(win["frame"])))


@R.scenario("indicator-disable", tags=("indicator", "lifecycle"))
def sc_disable(ctx):
    ctx.wait_shown(NAME, 1.0)
    offset = ctx.log_size()
    ctx.set_enabled_extensions([R.HELPER_UUID])
    try:
        R.wait_for(lambda: ctx.shell.status()["extensions"]
                   .get(R.EXT_UUID, {}).get("state") != 1,
                   3, 0.05, "extension to leave ACTIVE state")
        time.sleep(0.3)
        left = ctx.shell.actors(NAME)
        if left:
            raise R.ScenarioFailure("indicator actors left after disable: %s"
                                    % [x["name"] for x in left])
        errs = ctx.log_errors_since(offset)
        if errs:
            raise R.ScenarioFailure("errors logged on disable: %s" % errs[:5])
    finally:
        ctx.set_enabled_extensions([R.HELPER_UUID, R.EXT_UUID])
    R.wait_for(lambda: ctx.shell.status()["extensions"]
               .get(R.EXT_UUID, {}).get("state") == 1,
               3, 0.05, "extension ACTIVE again after re-enable")
    ctx.wait_shown(NAME, 1.0)
    n = len(exact(ctx, NAME))
    if n != 1:
        raise R.ScenarioFailure("%d %s actors after re-enable" % (n, NAME))
