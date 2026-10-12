#!/usr/bin/python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""E2E driver for snap-layouts.

Runs INSIDE the private dbus-run-session created by scripts/e2e.sh, talks to
the test helper extension (org.wporter.SnapTest) and injects real pointer
input through Clutter virtual devices, so Mutter's move grab, the extension's
picker and the snap happen exactly as for a user.

    run.py --run-dir DIR [--list] [scenario|glob|tag ...]

Scenario selection: exact names, fnmatch globs (``snap-*``) or tags
(``@review``). With no selection, every scenario without the ``review`` tag
runs. Exit status is non-zero if any selected scenario fails.
"""

import argparse
import fnmatch
import json
import math
import os
import re
import subprocess
import sys
import time
import traceback

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
PY = "/usr/bin/python3"
BUS_NAME = "org.wporter.SnapTest"
OBJECT_PATH = "/org/wporter/SnapTest"
IFACE = "org.wporter.SnapTest"
EXT_UUID = "snap-layouts@wporter.org"
HELPER_UUID = "snaptest@wporter.org"
SCHEMA = "org.gnome.shell.extensions.snap-layouts"

BTN_LEFT = 1  # Clutter.BUTTON_PRIMARY
DRAG_STEPS = 20
STEP_SLEEP = 0.012  # ~80 Hz, faster than the extension's 60 Hz poll is fine
TOL = 2

# Checked on the shell log written while each scenario runs. Startup noise
# from the sandbox (no logind, GDM, ...) happens before the first scenario.
BAD_LOG_RE = re.compile(
    r"JS ERROR|Exception|Extension [^ ]+@[^ ]+:|Could not load extension|"
    r"-CRITICAL|WARNING.*snap-?(layouts|test)")

# SPEC "Layout model" built-ins. Zone order: as listed in the SPEC table,
# row-major (left→right, then top→bottom) where the table is ambiguous.
LAYOUTS = {
    "halves": [(0, 0, 1 / 2, 1), (1 / 2, 0, 1 / 2, 1)],
    "two-thirds-left": [(0, 0, 2 / 3, 1), (2 / 3, 0, 1 / 3, 1)],
    "thirds": [(0, 0, 1 / 3, 1), (1 / 3, 0, 1 / 3, 1), (2 / 3, 0, 1 / 3, 1)],
    "quadrants": [(0, 0, 1 / 2, 1 / 2), (1 / 2, 0, 1 / 2, 1 / 2),
                  (0, 1 / 2, 1 / 2, 1 / 2), (1 / 2, 1 / 2, 1 / 2, 1 / 2)],
    "half-left-quarters-right": [(0, 0, 1 / 2, 1), (1 / 2, 0, 1 / 2, 1 / 2),
                                 (1 / 2, 1 / 2, 1 / 2, 1 / 2)],
    "quarters-left-half-right": [(0, 0, 1 / 2, 1 / 2), (0, 1 / 2, 1 / 2, 1 / 2),
                                 (1 / 2, 0, 1 / 2, 1)],
    "quarter-half-quarter": [(0, 0, 1 / 4, 1), (1 / 4, 0, 1 / 2, 1),
                             (3 / 4, 0, 1 / 4, 1)],
}


class ScenarioFailure(Exception):
    pass


class Skip(Exception):
    pass


def jround(v):
    """JavaScript Math.round (half up), unlike Python's banker's round."""
    return math.floor(v + 0.5)


def zone_rect(wa, zone, gap):
    """SPEC zoneRect: edges snapped to the work area, then inset by gap at
    work-area edges and gap/2 on interior edges."""
    fx, fy, fw, fh = zone
    x0 = jround(wa["x"] + fx * wa["width"])
    x1 = jround(wa["x"] + (fx + fw) * wa["width"])
    y0 = jround(wa["y"] + fy * wa["height"])
    y1 = jround(wa["y"] + (fy + fh) * wa["height"])
    eps = 1e-6
    left = gap if fx < eps else gap / 2
    right = gap if fx + fw > 1 - eps else gap / 2
    top = gap if fy < eps else gap / 2
    bottom = gap if fy + fh > 1 - eps else gap / 2
    return {"x": x0 + left, "y": y0 + top,
            "width": (x1 - x0) - left - right,
            "height": (y1 - y0) - top - bottom}


def rects_close(a, b, tol=TOL):
    return all(abs(a[k] - b[k]) <= tol for k in ("x", "y", "width", "height"))


def fmt_rect(r):
    return "%d,%d %dx%d" % (r["x"], r["y"], r["width"], r["height"])


def centre(r):
    return r["x"] + r["width"] / 2, r["y"] + r["height"] / 2


class ShellProxy:
    """Thin synchronous wrapper around the helper's D-Bus API."""

    def __init__(self):
        self._conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)

    def call(self, method, sig=None, args=(), out=True, timeout_ms=10000):
        params = GLib.Variant(sig, tuple(args)) if sig else None
        deadline = time.monotonic() + 3
        while True:
            try:
                res = self._conn.call_sync(BUS_NAME, OBJECT_PATH, IFACE,
                                           method, params, None,
                                           Gio.DBusCallFlags.NONE,
                                           timeout_ms, None)
                break
            except GLib.Error as e:
                # The helper is briefly gone while the shell re-enables
                # extensions (e.g. after an enabled-extensions change).
                transient = ("UnknownMethod" in e.message or
                             "ServiceUnknown" in e.message or
                             "UnknownObject" in e.message)
                if not transient or time.monotonic() > deadline:
                    raise
                time.sleep(0.05)
        values = res.unpack() if res is not None else ()
        if not out:
            return None
        return values[0] if values else None

    def json(self, method, sig=None, args=()):
        return json.loads(self.call(method, sig, args))

    def status(self):
        return self.json("Status")

    def windows(self):
        return self.json("ListWindows")

    def monitors(self):
        return self.json("GetMonitors")

    def actors(self, prefix):
        return self.json("FindActors", "(s)", (prefix,))

    def pointer(self):
        return self.json("GetPointer")

    def move(self, x, y):
        self.call("PointerMove", "(dd)", (float(x), float(y)), out=False)

    def button(self, pressed, button=BTN_LEFT):
        self.call("PointerButton", "(ub)", (button, pressed), out=False)

    def key(self, keyval, pressed):
        self.call("Key", "(ub)", (keyval, pressed), out=False)

    def screenshot(self, path):
        return self.call("Screenshot", "(s)", (path,), timeout_ms=20000)

    def hide_overview(self):
        self.call("HideOverview", out=False)

    def activate(self, wid):
        return self.call("ActivateWindow", "(t)", (int(wid),))

    def move_resize(self, wid, x, y, w, h):
        return self.call("MoveResize", "(tiiii)",
                         (int(wid), int(x), int(y), int(w), int(h)))

    def log(self, msg):
        self.call("Log", "(s)", (msg,), out=False)


def wait_for(pred, timeout, interval=0.02, desc="condition"):
    """Poll pred() until truthy; return its value or raise ScenarioFailure."""
    deadline = time.monotonic() + timeout
    last = None
    while True:
        last = pred()
        if last:
            return last
        if time.monotonic() >= deadline:
            raise ScenarioFailure("timed out after %.1fs waiting for %s"
                                  % (timeout, desc))
        time.sleep(interval)


class Context:
    def __init__(self, run_dir, shell):
        self.run_dir = run_dir
        self.shell = shell
        self.clients = []
        self.px, self.py = 0.0, 0.0
        self.pressed = False
        self.name = ""
        self.log_path = os.environ.get("E2E_SHELL_LOG", "")
        self.schema_dir = os.environ.get("E2E_EXT_SCHEMAS", "")
        self.ext_present = os.environ.get("E2E_EXT_PRESENT", "1") == "1"
        self.notes = []
        self.screenshots = []

    # ---- environment -------------------------------------------------
    def monitor(self):
        return self.shell.monitors()[0]

    def work_area(self):
        return self.monitor()["workArea"]

    def gsettings(self, *args, schema_dir=None):
        env = dict(os.environ)
        if schema_dir:
            env["GSETTINGS_SCHEMA_DIR"] = schema_dir
        subprocess.run(["gsettings", *args], check=True, env=env)

    def ext_set(self, key, value):
        self.gsettings("set", SCHEMA, key, value, schema_dir=self.schema_dir)

    def set_enabled_extensions(self, uuids):
        value = "[" + ", ".join("'%s'" % u for u in uuids) + "]"
        self.gsettings("set", "org.gnome.shell", "enabled-extensions", value)

    def log_size(self):
        try:
            return os.path.getsize(self.log_path)
        except OSError:
            return 0

    def log_errors_since(self, offset):
        if not self.log_path:
            return []
        with open(self.log_path, "rb") as f:
            f.seek(offset)
            text = f.read().decode("utf-8", "replace")
        return [line for line in text.splitlines() if BAD_LOG_RE.search(line)]

    def require_ext(self):
        if not self.ext_present:
            raise ScenarioFailure(
                "%s/extension.js not present in this tree; extension not "
                "enabled" % EXT_UUID)
        st = self.shell.status()["extensions"].get(EXT_UUID)
        # ExtensionState.ACTIVE == 1 in GNOME Shell 50.
        if not st or st["state"] != 1:
            raise ScenarioFailure("extension %s not active: %s" % (EXT_UUID, st))

    def screenshot(self, tag):
        path = os.path.join(self.run_dir, "%s-%s.png" % (self.name, tag))
        try:
            self.shell.screenshot(path)
            self.screenshots.append(path)
        except GLib.Error as e:
            self.notes.append("screenshot %s failed: %s" % (tag, e.message))
        return path

    # ---- windows -----------------------------------------------------
    def spawn(self, title, width=800, height=500):
        env = dict(os.environ, E2E_CLIENT_DEBUG="1")
        proc = subprocess.Popen(
            [PY, os.path.join(HERE, "client.py"), "--title", title,
             "--width", str(width), "--height", str(height)],
            env=env, stdout=subprocess.DEVNULL,
            stderr=open(os.path.join(self.run_dir, "client-%s.log" % title), "w"))
        self.clients.append(proc)

        def find():
            if proc.poll() is not None:
                raise ScenarioFailure("client %s exited with %s"
                                      % (title, proc.returncode))
            for w in self.shell.windows():
                if w["title"] == title and w["normal"]:
                    return w
            return None

        win = wait_for(find, 10, 0.05, "window %r to map" % title)
        self.wait_stable(win["id"])
        return self.window(win["id"])

    def window(self, wid):
        for w in self.shell.windows():
            if w["id"] == wid:
                return w
        raise ScenarioFailure("window %s vanished" % wid)

    def wait_stable(self, wid, timeout=3.0):
        """Wait until the window's frame rect stops changing."""
        prev, same = None, 0
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            cur = self.window(wid)["frame"]
            if cur == prev:
                same += 1
                if same >= 4:
                    return cur
            else:
                same = 0
            prev = cur
            time.sleep(0.03)
        return prev

    def place(self, win, x, y, w, h):
        """Put a window at a known rect (setup only, not via the extension)."""
        self.shell.move_resize(win["id"], x, y, w, h)
        wait_for(lambda: rects_close(self.window(win["id"])["frame"],
                                     {"x": x, "y": y, "width": w, "height": h}),
                 3, 0.03, "window %s placed at %d,%d %dx%d"
                 % (win["title"], x, y, w, h))
        self.shell.activate(win["id"])
        wait_for(lambda: self.window(win["id"])["focused"], 3, 0.03,
                 "window %s focused" % win["title"])
        return self.window(win["id"])

    def close_clients(self):
        for p in self.clients:
            if p.poll() is None:
                p.terminate()
        for p in self.clients:
            try:
                p.wait(timeout=3)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait()
        self.clients = []
        try:
            wait_for(lambda: not [w for w in self.shell.windows() if w["normal"]],
                     3, 0.05, "client windows to unmap")
        except ScenarioFailure as e:
            self.notes.append(str(e))

    # ---- pointer -----------------------------------------------------
    def warp(self, x, y):
        self.shell.move(x, y)
        self.px, self.py = float(x), float(y)

    def glide(self, x, y, steps=DRAG_STEPS, sleep=STEP_SLEEP):
        """Smooth multi-step pointer motion so 60 Hz polling sees the path."""
        x0, y0 = self.px, self.py
        for i in range(1, steps + 1):
            t = i / steps
            self.shell.move(x0 + (x - x0) * t, y0 + (y - y0) * t)
            time.sleep(sleep)
        self.px, self.py = float(x), float(y)

    def press(self):
        self.shell.button(True)
        self.pressed = True

    def release(self):
        if self.pressed:
            self.shell.button(False)
            self.pressed = False

    def click(self, x, y):
        self.glide(x, y, steps=8)
        time.sleep(0.05)
        self.press()
        time.sleep(0.05)
        self.release()

    def headerbar_point(self, win):
        f = win["frame"]
        return f["x"] + f["width"] * 0.35, f["y"] + 18

    def begin_drag(self, win, attempts=4):
        """Press on the headerbar and wiggle past GTK's drag threshold so the
        client asks the compositor for an interactive move grab. Verifies the
        grab really started (the frame follows the pointer) and retries if
        the press was lost (seen right after shell startup). Returns the
        pointer position at press time."""
        f0 = self.window(win["id"])["frame"]
        for attempt in range(1, attempts + 1):
            hx, hy = self.headerbar_point(self.window(win["id"]))
            self.glide(hx, hy, steps=10)
            time.sleep(0.1)
            self.press()
            time.sleep(0.08)
            self.glide(hx + 6, hy + 6, steps=6, sleep=0.02)
            self.glide(hx + 20, hy + 20, steps=6, sleep=0.02)
            time.sleep(0.05)
            try:
                wait_for(lambda: self.window(win["id"])["frame"]["x"] != f0["x"],
                         0.5, 0.02, "move grab")
                if attempt > 1:
                    self.notes.append("move grab started on attempt %d"
                                      % attempt)
                return hx, hy
            except ScenarioFailure:
                self.release()
                # Stay clear of the double-click time so the retry is not
                # taken as a double-click (which would maximize).
                time.sleep(0.6)
                if self.window(win["id"])["is_maximized"]:
                    self.shell.move_resize(win["id"], f0["x"], f0["y"],
                                           f0["width"], f0["height"])
                    self.wait_stable(win["id"])
                self.glide(hx - 40, hy + 120, steps=5)
        raise ScenarioFailure("move grab never started after %d presses on "
                              "the headerbar of %s" % (attempts, win["title"]))

    # ---- extension actors ---------------------------------------------
    def actor(self, name):
        for a in self.shell.actors(name):
            if a["name"] == name:
                return a
        return None

    def shown(self, name):
        a = self.actor(name)
        if a and a["visible"] and a["mapped"] and a["opacity"] > 0:
            return a
        return None

    def wait_shown(self, name, timeout=1.0):
        return wait_for(lambda: self.shown(name), timeout, 0.02,
                        "actor %r visible" % name)

    def wait_hidden(self, name, timeout=1.0):
        return wait_for(lambda: not self.shown(name), timeout, 0.02,
                        "actor %r hidden/destroyed" % name)

    def drag_to_picker(self, win):
        mon = self.monitor()["rect"]
        cx = mon["x"] + mon["width"] / 2
        self.begin_drag(win)
        self.glide(cx, mon["y"] + 10, steps=25)
        try:
            return self.wait_shown("snap-layouts-picker", 1.0)
        except ScenarioFailure:
            self.screenshot("no-picker")
            raise ScenarioFailure("picker actor never appeared (pointer at "
                                  "%d,%d)" % (cx, mon["y"] + 10))

    def snap(self, win, layout, zone, gap=0, shot=True):
        """Drag win onto the picker cell layout:zone and drop it there.
        Returns the expected (zone) rect after asserting the result."""
        self.drag_to_picker(win)
        cell_name = "snap-layouts-zone:%s:%d" % (layout, zone)
        cell = self.actor(cell_name)
        if not cell:
            names = [a["name"] for a in self.shell.actors("snap-layouts-zone:")]
            self.release()
            raise ScenarioFailure("cell %s not found; cells: %s"
                                  % (cell_name, names))
        cx, cy = centre(cell)
        self.glide(cx, cy, steps=20)
        time.sleep(0.1)
        try:
            self.wait_shown("snap-layouts-preview", 1.0)
        except ScenarioFailure:
            self.screenshot("no-preview")
            self.release()
            raise ScenarioFailure("preview never appeared over %s" % cell_name)
        if shot:
            self.screenshot("preview")
        self.release()
        expected = zone_rect(self.work_area(), LAYOUTS[layout][zone], gap)
        try:
            wait_for(lambda: rects_close(self.window(win["id"])["frame"],
                                         expected),
                     2.0, 0.03, "frame == zone rect")
        except ScenarioFailure:
            got = self.window(win["id"])["frame"]
            self.screenshot("bad-frame")
            raise ScenarioFailure("window frame %s != expected %s:%d rect %s"
                                  % (fmt_rect(got), layout, zone,
                                     fmt_rect(expected)))
        self.wait_hidden("snap-layouts-picker", 1.0)
        self.wait_hidden("snap-layouts-preview", 1.0)
        return expected


# ---------------------------------------------------------------- scenarios
SCENARIOS = {}


def scenario(name, tags=(), needs_ext=True):
    def deco(fn):
        SCENARIOS[name] = {"fn": fn, "tags": set(tags), "needs_ext": needs_ext}
        return fn
    return deco


def standard_window(ctx, title="snap-e2e", x=200, y=250, w=800, h=500):
    win = ctx.spawn(title, w, h)
    return ctx.place(win, x, y, w, h)


@scenario("smoke", tags=("harness",), needs_ext=False)
def sc_smoke(ctx):
    win = standard_window(ctx)
    f0 = win["frame"]
    hx, hy = ctx.begin_drag(win)
    ctx.glide(hx + 300, hy + 150, steps=30, sleep=0.015)
    time.sleep(0.1)
    ctx.release()
    f1 = ctx.wait_stable(win["id"])
    dx, dy = f1["x"] - f0["x"], f1["y"] - f0["y"]
    ctx.notes.append("frame %s -> %s (delta %d,%d)"
                     % (fmt_rect(f0), fmt_rect(f1), dx, dy))
    # GTK only starts the move after its drag threshold (a few px), so the
    # window may trail the pointer by that much.
    if abs(dx - 300) > 16 or abs(dy - 150) > 16:
        ctx.screenshot("smoke")
        raise ScenarioFailure("window moved by %d,%d, expected ~300,150"
                              % (dx, dy))
    if (f1["width"], f1["height"]) != (f0["width"], f0["height"]):
        raise ScenarioFailure("window size changed during plain move")


@scenario("picker-shows")
def sc_picker_shows(ctx):
    win = standard_window(ctx)
    picker_shows(ctx, win)


def picker_shows(ctx, win):
    mon = ctx.monitor()["rect"]
    cx = mon["x"] + mon["width"] / 2
    picker = ctx.drag_to_picker(win)
    ctx.notes.append("picker at %s" % fmt_rect(picker))
    ctx.screenshot("picker")
    ctx.glide(cx, mon["y"] + 500, steps=20)
    try:
        ctx.wait_hidden("snap-layouts-picker", 1.0)
    finally:
        ctx.release()
    ctx.wait_stable(win["id"])


def make_snap_scenario(layout, zone):
    def fn(ctx):
        win = standard_window(ctx)
        exp = ctx.snap(win, layout, zone)
        ctx.notes.append("snapped to %s" % fmt_rect(exp))
    scenario("snap-%s-%d" % (layout, zone), tags=("snap",))(fn)


for _layout, _zone in [("halves", 0), ("halves", 1),
                       ("quadrants", 0), ("quadrants", 1),
                       ("quadrants", 2), ("quadrants", 3),
                       ("half-left-quarters-right", 1),
                       ("two-thirds-left", 0), ("thirds", 2),
                       ("quarter-half-quarter", 1)]:
    make_snap_scenario(_layout, _zone)


@scenario("no-zone-no-snap")
def sc_no_zone(ctx):
    win = standard_window(ctx)
    mon = ctx.monitor()["rect"]
    cx = mon["x"] + mon["width"] / 2
    ctx.drag_to_picker(win)
    ctx.glide(cx, mon["y"] + 600, steps=20)
    time.sleep(0.1)
    ctx.release()
    f = ctx.wait_stable(win["id"])
    w = ctx.window(win["id"])
    wa = ctx.work_area()
    for lid, zones in LAYOUTS.items():
        for i, z in enumerate(zones):
            if rects_close(f, zone_rect(wa, z, 0)):
                raise ScenarioFailure("window snapped to %s:%d without a "
                                      "hovered zone" % (lid, i))
    if w["is_maximized"]:
        raise ScenarioFailure("window maximized on release at (centre, 600)")
    if (f["width"], f["height"]) != (800, 500):
        raise ScenarioFailure("window size changed to %dx%d"
                              % (f["width"], f["height"]))
    ctx.wait_hidden("snap-layouts-picker", 1.0)


@scenario("restore-on-drag-out")
def sc_restore(ctx):
    win = standard_window(ctx)
    pre = win["frame"]
    ctx.snap(win, "halves", 0)
    win = ctx.window(win["id"])
    hx, hy = ctx.begin_drag(win)
    ctx.glide(hx, hy + 200, steps=25, sleep=0.015)
    time.sleep(0.1)
    ctx.release()
    f = ctx.wait_stable(win["id"])
    ctx.notes.append("after drag-out: %s (pre-snap %s)"
                     % (fmt_rect(f), fmt_rect(pre)))
    if abs(f["width"] - pre["width"]) > TOL or \
            abs(f["height"] - pre["height"]) > TOL:
        ctx.screenshot("restore")
        raise ScenarioFailure("size after drag-out %dx%d, expected pre-snap "
                              "%dx%d" % (f["width"], f["height"],
                                         pre["width"], pre["height"]))
    px = ctx.shell.pointer()
    if not (f["x"] <= px["x"] <= f["x"] + f["width"] and
            f["y"] <= px["y"] <= f["y"] + f["height"]):
        raise ScenarioFailure("pointer %d,%d not inside restored window %s"
                              % (px["x"], px["y"], fmt_rect(f)))


@scenario("snap-assist", tags=("assist",))
def sc_snap_assist(ctx):
    a = standard_window(ctx, "assist-a", 150, 200)
    b = standard_window(ctx, "assist-b", 450, 300)
    c = standard_window(ctx, "assist-c", 300, 250)
    ctx.snap(c, "halves", 0)
    try:
        ctx.wait_shown("snap-layouts-assist", 1.5)
    except ScenarioFailure:
        ctx.screenshot("no-assist")
        raise ScenarioFailure("snap-layouts-assist never appeared after snap")
    thumbs = {}

    def find_thumbs():
        for w in (a, b):
            t = ctx.shown("snap-layouts-assist-window:%s" % w["id"])
            if t:
                thumbs[w["id"]] = t
        return thumbs

    try:
        wait_for(find_thumbs, 1.5, 0.05, "assist window thumbnails")
    except ScenarioFailure:
        names = [x["name"] for x in ctx.shell.actors("snap-layouts-assist")]
        ctx.screenshot("no-thumbs")
        raise ScenarioFailure("no snap-layouts-assist-window:<id> thumbnail "
                              "for windows %s; assist actors: %s"
                              % ([a["id"], b["id"]], names))
    ctx.screenshot("assist")
    wid, thumb = next(iter(thumbs.items()))
    time.sleep(0.3)  # let the open animation finish before clicking
    thumb = ctx.shown(thumb["name"]) or thumb
    ctx.click(*centre(thumb))
    expected = zone_rect(ctx.work_area(), LAYOUTS["halves"][1], 0)
    try:
        wait_for(lambda: rects_close(ctx.window(wid)["frame"], expected),
                 2.0, 0.03, "picked window fills halves:1")
    except ScenarioFailure:
        ctx.screenshot("assist-bad")
        raise ScenarioFailure("picked window frame %s != halves:1 %s"
                              % (fmt_rect(ctx.window(wid)["frame"]),
                                 fmt_rect(expected)))
    ctx.wait_hidden("snap-layouts-assist", 1.5)


@scenario("disable-cleans-up", tags=("lifecycle",))
def sc_disable(ctx):
    win = standard_window(ctx)
    ctx.snap(win, "halves", 0, shot=False)
    offset = ctx.log_size()
    ctx.set_enabled_extensions([HELPER_UUID])
    try:
        wait_for(lambda: ctx.shell.status()["extensions"]
                 .get(EXT_UUID, {}).get("state") != 1,
                 3, 0.05, "extension to leave ACTIVE state")
        time.sleep(0.3)
        left = ctx.shell.actors("snap-layouts")
        if left:
            raise ScenarioFailure("actors left after disable: %s"
                                  % [x["name"] for x in left])
        errs = ctx.log_errors_since(offset)
        if errs:
            raise ScenarioFailure("errors logged on disable: %s" % errs[:5])
    finally:
        ctx.set_enabled_extensions([HELPER_UUID, EXT_UUID])
    wait_for(lambda: ctx.shell.status()["extensions"]
             .get(EXT_UUID, {}).get("state") == 1,
             3, 0.05, "extension ACTIVE again after re-enable")
    win = ctx.place(ctx.window(win["id"]), 200, 250, 800, 500)
    picker_shows(ctx, win)


@scenario("gap", tags=("settings",))
def sc_gap(ctx):
    ctx.ext_set("gap", "8")
    try:
        win = standard_window(ctx)
        exp = ctx.snap(win, "quadrants", 3, gap=8)
        ctx.notes.append("gap 8 rect %s" % fmt_rect(exp))
    finally:
        ctx.ext_set("gap", "0")


# SNAP_REVIEW=1 runs the @review scenarios; any other non-empty value is a
# space-separated scenario/tag selection (with the review scenarios loaded).
SNAP_REVIEW = os.environ.get("SNAP_REVIEW", "")
if SNAP_REVIEW:
    import review_scenarios  # noqa: E402,F401  (registers @review scenarios)


# ---------------------------------------------------------------- runner
def select(names):
    if not names and SNAP_REVIEW:
        names = ["@review"] if SNAP_REVIEW == "1" else SNAP_REVIEW.split()
    if not names:
        return [n for n, s in SCENARIOS.items() if "review" not in s["tags"]]
    out = []
    for pat in names:
        if pat.startswith("@"):
            hits = [n for n, s in SCENARIOS.items() if pat[1:] in s["tags"]]
        else:
            hits = [n for n in SCENARIOS if fnmatch.fnmatchcase(n, pat)]
        if not hits:
            raise SystemExit("unknown scenario/tag: %s (see --list)" % pat)
        out += [h for h in hits if h not in out]
    return out


def wait_shell_ready(shell):
    st = wait_for(lambda: (lambda s: s if not s["startingUp"] else None)(
        shell.status()), 30, 0.1, "shell startup to complete")
    for _ in range(50):
        shell.hide_overview()
        st = shell.status()
        if not st["overviewVisible"]:
            break
        time.sleep(0.1)
    else:
        raise ScenarioFailure("overview would not hide")
    return st


def warm_up(ctx, budget=30.0):
    """Drag a throwaway window until Mutter starts a move grab.

    Right after startup the first pointer presses on a fresh client can get
    lost (observed on Mutter 18 headless: the client never sees the press).
    Doing this once up front keeps scenario timings and results stable."""
    ctx.name = "warmup"
    ctx.notes = []
    t0 = time.monotonic()
    tries = 0
    try:
        win = standard_window(ctx, "warmup")
        while time.monotonic() - t0 < budget:
            tries += 1
            try:
                ctx.begin_drag(win, attempts=1)
                ctx.release()
                return "move grab after %d tries, %.1fs" % (
                    tries, time.monotonic() - t0)
            except ScenarioFailure:
                ctx.release()
        return "WARNING: no move grab within %.0fs (%d tries)" % (budget, tries)
    finally:
        ctx.release()
        ctx.close_clients()


def run_one(ctx, name):
    spec = SCENARIOS[name]
    ctx.name = name
    ctx.notes, ctx.screenshots = [], []
    offset = ctx.log_size()
    t0 = time.monotonic()
    result = {"name": name, "status": "pass", "error": ""}
    ctx.shell.log("scenario %s begin" % name)
    try:
        if spec["needs_ext"]:
            ctx.require_ext()
        ctx.shell.hide_overview()
        ctx.warp(1700, 1000)
        spec["fn"](ctx)
    except ScenarioFailure as e:
        result.update(status="fail", error=str(e))
    except Exception as e:  # harness bug or D-Bus error: still a failure
        result.update(status="fail", error="%s: %s" % (type(e).__name__, e))
        result["traceback"] = traceback.format_exc()
    finally:
        try:
            ctx.release()
        except Exception:
            pass
        if result["status"] == "fail":
            ctx.screenshot("failure")
        ctx.close_clients()
    errs = ctx.log_errors_since(offset)
    if errs:
        result["log_errors"] = errs[:20]
        if result["status"] == "pass":
            result.update(status="fail",
                          error="errors in shell log: %s" % errs[0])
    result["seconds"] = round(time.monotonic() - t0, 2)
    result["notes"] = ctx.notes
    result["screenshots"] = ctx.screenshots
    ctx.shell.log("scenario %s end: %s" % (name, result["status"]))
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-dir", default=".")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("scenarios", nargs="*")
    args = ap.parse_args()
    if args.list:
        for n, s in SCENARIOS.items():
            print("%-32s %s" % (n, " ".join("@" + t for t in sorted(s["tags"]))))
        return 0
    names = select(args.scenarios)
    shell = ShellProxy()
    st = wait_shell_ready(shell)
    print("shell ready: %s" % json.dumps(st))
    ctx = Context(args.run_dir, shell)
    print("monitor: %s" % json.dumps(ctx.monitor()))
    print("warm-up: %s" % warm_up(ctx), flush=True)
    results = []
    for name in names:
        r = run_one(ctx, name)
        results.append(r)
        line = "%-4s %-32s %5.1fs" % (r["status"].upper(), name, r["seconds"])
        if r["error"]:
            line += "  " + r["error"]
        print(line, flush=True)
        for n in r["notes"]:
            print("       note: " + n, flush=True)
    summary = {
        "passed": sum(r["status"] == "pass" for r in results),
        "failed": sum(r["status"] == "fail" for r in results),
        "results": results,
    }
    with open(os.path.join(args.run_dir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2)
    print("summary: %d passed, %d failed (%s)"
          % (summary["passed"], summary["failed"],
             os.path.join(args.run_dir, "summary.json")))
    return 1 if summary["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
