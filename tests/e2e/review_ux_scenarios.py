# SPDX-License-Identifier: AGPL-3.0-or-later
"""Review PoCs (UX / visuals / prefs / HiDPI) for snap-layouts.

Loaded by run.py only when SNAP_REVIEW=ux (scripts/e2e.sh then also adds a
3840x2160 virtual monitor right of the 1920x1080 primary). Every scenario
is tagged ``review``; scenarios tagged ``poc`` assert the behaviour a user
would expect and FAIL on the current tree, ``info`` ones only collect
screenshots/measurements (notes) for the review report.
"""

import json
import os
import subprocess
import time

from gi.repository import Gio, GLib

try:
    from PIL import Image
except ImportError:  # pixel checks are skipped without PIL
    Image = None

R = None  # the run.py module, set by register()

SCHEME_KEY = ("org.gnome.desktop.interface", "color-scheme")
DC_NAME = "org.gnome.Mutter.DisplayConfig"
DC_PATH = "/org/gnome/Mutter/DisplayConfig"


def register(run_module):
    global R
    R = run_module
    for name, (fn, tags) in _PENDING.items():
        R.scenario(name, tags=("review",) + tags)(_normalized(fn))


def _normalized(fn):
    """Run fn with the 1920x1080 monitor primary at 0,0 (scale 1) so the
    run.py helpers that use monitors()[0] behave as in the default suite."""
    def wrapper(ctx):
        mons = ctx.shell.monitors()
        m0 = mons[0]
        if len(mons) > 1 and (m0["rect"]["width"] != 1920 or
                              m0["rect"]["x"] != 0 or
                              any(m["scale"] != 1 for m in mons)):
            apply_scales(ctx, {})
        return fn(ctx)
    return wrapper


_PENDING = {}


def review(name, *tags):
    def deco(fn):
        _PENDING[name] = (fn, tags)
        return fn
    return deco


# ---------------------------------------------------------------- helpers
def fail(msg):
    raise R.ScenarioFailure(msg)


def pixel(path, x, y):
    if Image is None:
        return None
    with Image.open(path) as im:
        return im.convert("RGB").getpixel((int(x), int(y)))


def crop(path, rect, tag):
    """Save a crop of a screenshot next to it; returns the crop path."""
    if Image is None:
        return path
    out = path[:-4] + "-" + tag + ".png"
    with Image.open(path) as im:
        im.crop((int(rect["x"]), int(rect["y"]),
                 int(rect["x"] + rect["width"]),
                 int(rect["y"] + rect["height"]))).save(out)
    return out


def luminance(rgb):
    def lin(c):
        c /= 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (lin(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def settle(seconds=0.4):
    """Let open/hover animations (<=150 ms) finish before a screenshot."""
    time.sleep(seconds)


def set_scheme(ctx, value):
    ctx.gsettings("set", *SCHEME_KEY, value)


def dc_call(ctx, method, args=None, sig=None):
    params = GLib.Variant(sig, args) if sig else None
    res = ctx.shell._conn.call_sync(DC_NAME, DC_PATH, DC_NAME, method, params,
                                    None, Gio.DBusCallFlags.NONE, 10000, None)
    return res.unpack()


def display_state(ctx):
    serial, monitors, logical, props = dc_call(ctx, "GetCurrentState")
    return serial, monitors, logical, props


def apply_scales(ctx, scales):
    """Re-apply the current logical layout with per-connector scales,
    laying monitors out left to right. Returns the new monitors list."""
    serial, monitors, logical, props = display_state(ctx)
    mode_of = {}
    for (conn, _v, _p, _s), modes, _mprops in monitors:
        cur = [m for m in modes if m[6].get("is-current")]
        mode_of[conn] = (cur or modes)[0]
    layout_mode = props.get("layout-mode", 1)  # 1 logical, 2 physical
    configs, x = [], 0
    for conn in sorted(mode_of, key=lambda c: c):
        mode = mode_of[conn]
        scale = scales.get(conn, 1.0)
        configs.append((x, 0, scale, 0, x == 0, [(conn, mode[0], {})]))
        w = mode[1]
        x += int(round(w / scale)) if layout_mode == 1 else w
    dc_call(ctx, "ApplyMonitorsConfig",
            (serial, 1, configs, {}), "(uua(iiduba(ssa{sv}))a{sv})")
    time.sleep(1.0)
    return ctx.shell.monitors()


def place_on(ctx, win, mon, dx, dy, w=800, h=500):
    wa = mon["workArea"]
    return ctx.place(win, wa["x"] + dx, wa["y"] + dy, w, h)


def glide_watch(ctx, x, y, name, steps=40, sleep=0.012):
    """Like ctx.glide but polls actor `name` every few steps; returns the
    pointer position at which it was first seen shown, else None."""
    x0, y0 = ctx.px, ctx.py
    seen = None
    for i in range(1, steps + 1):
        t = i / steps
        px, py = x0 + (x - x0) * t, y0 + (y - y0) * t
        ctx.shell.move(px, py)
        time.sleep(sleep)
        if seen is None and i % 2 == 0 and ctx.shown(name):
            seen = (round(px), round(py))
    ctx.px, ctx.py = float(x), float(y)
    if seen is None:
        time.sleep(0.15)
        if ctx.shown(name):
            seen = (round(x), round(y))
    return seen


# ---------------------------------------------------------------- probe
@review("review-probe", "info")
def sc_probe(ctx):
    serial, monitors, logical, props = display_state(ctx)
    ctx.notes.append("layout-mode %s (1=logical 2=physical), "
                     "supports-changing-layout-mode %s"
                     % (props.get("layout-mode"),
                        props.get("supports-changing-layout-mode")))
    for (conn, vendor, product, _s), modes, _p in monitors:
        cur = [m for m in modes if m[6].get("is-current")]
        if cur:
            ctx.notes.append("%s %s %s: mode %s supported scales %s"
                             % (conn, vendor, product, cur[0][0],
                                [round(s, 2) for s in cur[0][5]]))
    ctx.notes.append("shell monitors: %s" % json.dumps(ctx.shell.monitors()))


# ---------------------------------------------------------------- picker
def picker_shot(ctx, scheme, tag):
    """Drag to the picker, hover halves:0, screenshot (settled) and measure
    picker/cell/hover contrast against the wallpaper."""
    set_scheme(ctx, scheme)
    settle(0.8)
    win = R.standard_window(ctx)
    picker = ctx.drag_to_picker(win)
    # Park the pointer in the band left of the picker (no cell hovered).
    # Amendment 2: the band ends trigger-height (default 8) px below the
    # work-area top, so stay within 2 px of it.
    ctx.glide(picker["x"] - 40, ctx.monitor()["workArea"]["y"] + 2, steps=10)
    settle()
    idle = ctx.screenshot(tag + "-idle")
    cell = ctx.actor("snap-layouts-zone:halves:0")
    other = ctx.actor("snap-layouts-zone:halves:1")
    ctx.glide(*R.centre(cell), steps=10)
    settle()
    hover = ctx.screenshot(tag + "-hover")
    pseudo = ctx.actor("snap-layouts-zone:halves:0")["pseudoClass"]
    ctx.release()
    ctx.wait_stable(win["id"])
    box = {"x": picker["x"] - 30, "y": 0, "width": picker["width"] + 60,
           "height": picker["y"] + picker["height"] + 30}
    crop(idle, box, "crop")
    crop(hover, box, "crop")
    if Image is None:
        return {}
    bg = pixel(idle, picker["x"] + 4, picker["y"] + picker["height"] / 2)
    outside = pixel(idle, picker["x"] - 20, picker["y"] + picker["height"] / 2)
    c_idle = pixel(idle, *R.centre(other))
    c_hover = pixel(hover, *R.centre(cell))
    m = {
        "scheme": scheme,
        "picker_bg": bg, "wallpaper": outside,
        "cell": c_idle, "cell_hover": c_hover, "pseudo": pseudo,
        "picker_vs_wallpaper": round(contrast(bg, outside), 2),
        "cell_vs_picker": round(contrast(c_idle, bg), 2),
        "hover_vs_cell": round(contrast(c_hover, c_idle), 2),
    }
    ctx.notes.append(json.dumps(m))
    return m


@review("review-picker-dark", "info", "visual")
def sc_picker_dark(ctx):
    try:
        picker_shot(ctx, "prefer-dark", "dark")
    finally:
        set_scheme(ctx, "default")


@review("review-picker-light", "info", "visual")
def sc_picker_light(ctx):
    try:
        picker_shot(ctx, "prefer-light", "light")
    finally:
        set_scheme(ctx, "default")


@review("review-top-edge-overlap", "info", "visual")
def sc_top_edge(ctx):
    """Pointer on the top bar at the centre: picker and Mutter's own
    top-edge maximize preview are both shown."""
    win = R.standard_window(ctx)
    mon = ctx.monitor()["rect"]
    ctx.drag_to_picker(win)
    ctx.glide(mon["x"] + mon["width"] / 2, mon["y"] + 4, steps=10)
    settle(0.5)
    ctx.screenshot("top-edge")
    ctx.release()
    f = ctx.wait_stable(win["id"])
    ctx.notes.append("released on top bar centre: maximized=%s frame %s"
                     % (ctx.window(win["id"])["is_maximized"], R.fmt_rect(f)))


# ---------------------------------------------------------------- trigger
@review("review-trigger-horizontal-drag", "poc", "trigger")
def sc_trigger_horizontal(ctx):
    """Repositioning a window along the top of the screen (titlebar just
    below the top bar) must not pop the picker: Windows 11 only offers the
    flyout when the pointer reaches the top edge."""
    wa = ctx.monitor()["workArea"]
    win = R.standard_window(ctx, x=40, y=wa["y"])
    hx, hy = ctx.begin_drag(win)
    ctx.notes.append("drag starts at %d,%d" % (ctx.px, ctx.py))
    if ctx.shown("snap-layouts-picker"):
        fail("picker already shown at drag start")
    # ~2700 px/s, a brisk but ordinary drag, at constant height.
    seen = glide_watch(ctx, 1700, ctx.py, "snap-layouts-picker", steps=40)
    ctx.release()
    ctx.wait_stable(win["id"])
    if seen:
        ctx.screenshot("popped")
        fail("picker popped during a horizontal drag at y=%d (work area top "
             "%d, i.e. %d px below the top bar), first seen at %s"
             % (ctx.py, wa["y"], ctx.py - wa["y"], seen))


@review("review-trigger-accidental-snap", "poc", "trigger")
def sc_trigger_accidental_snap(ctx):
    """Dragging a window up to the top (to park it there) and releasing a
    bit below the top bar must not snap it: the trigger band (work-area top
    + 48 px) overlaps the picker's first row (top at work-area top + 8), so
    the pointer is already on a cell the moment the picker appears."""
    wa = ctx.monitor()["workArea"]
    win = R.standard_window(ctx, x=500, y=400)
    pre = win["frame"]
    ctx.begin_drag(win)
    target = (900, wa["y"] + 30)
    ctx.glide(*target, steps=25)
    time.sleep(0.4)
    hovered = [a["name"] for a in ctx.shell.actors("snap-layouts-zone:")
               if a["pseudoClass"] and "hover" in a["pseudoClass"]]
    ctx.screenshot("before-release")
    ctx.release()
    f = ctx.wait_stable(win["id"])
    ctx.notes.append("released at %s; hovered %s; frame %s -> %s"
                     % (target, hovered, R.fmt_rect(pre), R.fmt_rect(f)))
    if (f["width"], f["height"]) != (pre["width"], pre["height"]):
        fail("window snapped to %s by releasing at %s (%d px below the top "
             "bar) without ever moving onto the picker; hovered %s"
             % (R.fmt_rect(f), target, target[1] - wa["y"], hovered))


# ---------------------------------------------------------------- preview
@review("review-preview-stacking", "poc", "visual")
def sc_preview_stacking(ctx):
    """Mutter's tile preview sits below the dragged window
    (windowManager.js TilePreview: set_child_below_sibling(windowActor));
    ours is in uiGroup above every window and tints the dragged window."""
    if Image is None:
        raise R.Skip("PIL missing")
    win = R.standard_window(ctx, x=1000, y=300)
    ref = ctx.screenshot("ref")
    f0 = ctx.window(win["id"])["frame"]
    # A point in the client area, away from the label.
    ox, oy = 60, 200
    ref_px = pixel(ref, f0["x"] + ox, f0["y"] + oy)
    ctx.drag_to_picker(win)
    cell = ctx.actor("snap-layouts-zone:halves:0")
    ctx.glide(*R.centre(cell), steps=15)
    settle()
    shot = ctx.screenshot("hover")
    f1 = ctx.window(win["id"])["frame"]
    prev = ctx.shown("snap-layouts-preview")
    ctx.release()
    ctx.wait_stable(win["id"])
    px, py = f1["x"] + ox, f1["y"] + oy
    inside = prev and prev["x"] <= px < prev["x"] + prev["width"] and \
        prev["y"] <= py < prev["y"] + prev["height"]
    if not inside:
        raise R.Skip("sample point %d,%d not inside preview %s"
                     % (px, py, prev))
    got = pixel(shot, px, py)
    ctx.notes.append("window pixel at rest %s, under preview %s" % (ref_px, got))
    if max(abs(a - b) for a, b in zip(ref_px, got)) > 12:
        fail("dragged window is tinted by the drop preview (%s -> %s): the "
             "preview is stacked above the window, unlike Mutter's tile "
             "preview" % (ref_px, got))


# ---------------------------------------------------------------- assist
def open_assist(ctx, n_others=2, minimize_first=False):
    others = []
    for i in range(n_others):
        others.append(R.standard_window(ctx, "assist-%d" % i, 150 + 100 * i,
                                        200 + 40 * i))
    if minimize_first:
        # <Super>h: default "minimize" keybinding, on the focused window.
        ctx.shell.activate(others[0]["id"])
        R.wait_for(lambda: ctx.window(others[0]["id"])["focused"], 2, 0.05,
                   "focus")
        ctx.shell.key(0xffeb, True)
        ctx.shell.key(0x68, True)
        ctx.shell.key(0x68, False)
        ctx.shell.key(0xffeb, False)
        R.wait_for(lambda: ctx.window(others[0]["id"])["minimized"], 2, 0.05,
                   "window minimized")
    main = R.standard_window(ctx, "assist-main", 300, 250)
    ctx.snap(main, "halves", 0)
    ctx.wait_shown("snap-layouts-assist", 1.5)
    R.wait_for(lambda: ctx.shell.actors("snap-layouts-assist-window:"), 1.5,
               0.05, "assist thumbnails")
    settle(0.5)
    return main, others


@review("review-assist-thumb-size", "poc", "assist")
def sc_assist_size(ctx):
    """Windows 11 fills the free zone with large thumbnails. With two
    candidates in a 960x1048 half zone we expect each thumbnail to use at
    least half the zone width (here: <= 320 px, i.e. a third)."""
    open_assist(ctx, 2)
    shot = ctx.screenshot("assist")
    zone = ctx.actor("snap-layouts-assist-zone:0")
    thumbs = [a for a in ctx.shell.actors("snap-layouts-assist-window:")
              if a["visible"]]
    ctx.notes.append("zone %s; thumbs %s" % (
        R.fmt_rect(zone), [R.fmt_rect(t) for t in thumbs]))
    if Image is not None:
        # Is the active panel delineated from the backdrop?
        inside = pixel(shot, zone["x"] + 8, zone["y"] + zone["height"] - 8)
        outside_pt = (zone["x"] - 8, zone["y"] + zone["height"] - 8)
        outside = pixel(shot, *outside_pt)
        ctx.notes.append("panel px %s vs outside px %s (contrast %.2f)"
                         % (inside, outside, contrast(inside, outside)))
    used = sum(t["width"] * t["height"] for t in thumbs) / \
        (zone["width"] * zone["height"])
    ctx.notes.append("thumbnails cover %.0f%% of the zone" % (100 * used))
    ctx.shell.key(0xff1b, True)
    ctx.shell.key(0xff1b, False)
    widest = max(t["width"] for t in thumbs)
    if widest < 0.5 * zone["width"]:
        fail("Snap Assist thumbnails are %d px wide in a %d px wide zone "
             "(%.0f%%) and cover %.0f%% of its area"
             % (widest, zone["width"], 100 * widest / zone["width"],
                100 * used))


@review("review-assist-keyboard", "info", "assist")
def sc_assist_keyboard(ctx):
    open_assist(ctx, 3)
    ctx.screenshot("focus-first")
    ctx.shell.key(0xff54, True)   # Down
    ctx.shell.key(0xff54, False)
    settle(0.3)
    ctx.screenshot("focus-down")
    ctx.shell.key(0xff1b, True)
    ctx.shell.key(0xff1b, False)
    ctx.wait_hidden("snap-layouts-assist", 1.5)


@review("review-assist-minimized", "info", "assist")
def sc_assist_minimized(ctx):
    open_assist(ctx, 2, minimize_first=True)
    ctx.screenshot("minimized")
    ctx.shell.key(0xff1b, True)
    ctx.shell.key(0xff1b, False)


@review("review-assist-quadrants", "info", "assist")
def sc_assist_quadrants(ctx):
    """Quarter zones (960x524) with three candidates."""
    others = [R.standard_window(ctx, "q-%d" % i, 150 + 80 * i, 200 + 40 * i)
              for i in range(3)]
    main = R.standard_window(ctx, "q-main", 300, 250)
    ctx.snap(main, "quadrants", 0)
    ctx.wait_shown("snap-layouts-assist", 1.5)
    settle(0.5)
    ctx.screenshot("assist")
    zone = ctx.actor("snap-layouts-assist-zone:0")
    thumbs = [a for a in ctx.shell.actors("snap-layouts-assist-window:")]
    ctx.notes.append("zone %s thumbs %s" % (
        R.fmt_rect(zone), [R.fmt_rect(t) for t in thumbs]))
    ctx.shell.key(0xff1b, True)
    ctx.shell.key(0xff1b, False)
    ctx.notes.append("%d other windows" % len(others))


# ---------------------------------------------------------------- settings
@review("review-layout-settings-live", "verify", "settings")
def sc_layout_settings(ctx):
    """disabled-layouts and custom-layouts reach the picker on the next drag
    (verification; expected to pass)."""
    custom = json.dumps([{"id": "wide-centre", "name": "Wide centre",
                          "zones": [{"x": 0.1, "y": 0, "w": 0.8, "h": 1}]}])
    ctx.ext_set("disabled-layouts", "['thirds', 'quadrants']")
    ctx.ext_set("custom-layouts", custom)
    try:
        win = R.standard_window(ctx)
        ctx.drag_to_picker(win)
        settle()
        names = sorted({a["name"].split(":")[1]
                        for a in ctx.shell.actors("snap-layouts-zone:")})
        ctx.screenshot("picker")
        ctx.release()
        ctx.notes.append("picker layouts: %s" % names)
        if "thirds" in names or "quadrants" in names:
            fail("disabled layouts still offered: %s" % names)
        if "wide-centre" not in names:
            fail("custom layout missing: %s" % names)
    finally:
        ctx.ext_set("disabled-layouts", "[]")
        ctx.ext_set("custom-layouts", "'[]'")


# ---------------------------------------------------------------- HiDPI
@review("review-hidpi", "info", "hidpi")
def sc_hidpi(ctx):
    """Scale 2 on the 3840x2160 monitor; picker and snap rects on it must be
    in logical px (picker thumb width 112 logical, rect == zoneRect(wa))."""
    serial, monitors, logical, props = display_state(ctx)
    conns = sorted(m[0][0] for m in monitors)
    if len(conns) < 2:
        raise R.Skip("needs the second (4K) virtual monitor")
    big = None
    for (conn, *_r), modes, _p in monitors:
        cur = [m for m in modes if m[6].get("is-current")]
        if cur and cur[0][1] == 3840:
            big = conn
    mons = apply_scales(ctx, {big: 2.0})
    ctx.notes.append("monitors after scale 2: %s" % json.dumps(mons))
    try:
        hi = max(mons, key=lambda m: m["scale"])
        if hi["scale"] < 2:
            fail("could not apply scale 2: %s" % mons)
        wa = hi["workArea"]
        win = R.standard_window(ctx, "hidpi")
        win = place_on(ctx, win, hi, 200, 200, 800, 500)
        ctx.begin_drag(win)
        cx = hi["rect"]["x"] + hi["rect"]["width"] / 2
        ctx.glide(cx, hi["rect"]["y"] + 2, steps=25)
        picker = ctx.wait_shown("snap-layouts-picker", 1.0)
        settle()
        cell = ctx.actor("snap-layouts-zone:halves:1")
        ctx.glide(*R.centre(cell), steps=10)
        settle()
        shot = ctx.screenshot("picker")
        crop(shot, hi["rect"], "mon")
        ctx.notes.append("picker on scale-2 monitor: %s; cell halves:1 %s"
                         % (R.fmt_rect(picker), R.fmt_rect(cell)))
        ctx.release()
        exp = R.zone_rect(wa, R.LAYOUTS["halves"][1], 0)
        R.wait_for(lambda: R.rects_close(ctx.window(win["id"])["frame"], exp),
                   2, 0.05, "snapped on hidpi")
        ctx.notes.append("snapped %s == %s" % (
            R.fmt_rect(ctx.window(win["id"])["frame"]), R.fmt_rect(exp)))
    finally:
        apply_scales(ctx, {})


# ---------------------------------------------------------------- prefs
@review("review-prefs-open", "info", "prefs")
def sc_prefs_open(ctx):
    proc = start_prefs(ctx)
    try:
        ctx.screenshot("prefs")
    finally:
        stop_prefs(ctx, proc)


def start_prefs(ctx):
    log = open(os.path.join(ctx.run_dir, "prefs-service.log"), "w")
    proc = subprocess.Popen(
        ["/usr/bin/gjs", "-m", "/usr/share/gnome-shell/org.gnome.Shell.Extensions"],
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
    ctx.shell._conn.call_sync(
        "org.gnome.Shell.Extensions", "/org/gnome/Shell/Extensions",
        "org.gnome.Shell.Extensions", "OpenExtensionPrefs",
        GLib.Variant("(ssa{sv})", (R.EXT_UUID, "", {})),
        None, Gio.DBusCallFlags.NONE, 10000, None)

    def prefs_win():
        for w in ctx.shell.windows():
            if w["title"] == "Snap Layouts":
                return w
        return None
    win = R.wait_for(prefs_win, 10, 0.1, "prefs window")
    ctx.wait_stable(win["id"])
    ctx.notes.append("prefs window as opened: %s" % R.fmt_rect(win["frame"]))
    # On the tall 4K monitor (x >= 1920, scale 1) so every row, including
    # the expanded custom-layouts editor, is on screen for the clicks below.
    # Move first: Mutter clamps the size to the current monitor's work area.
    ctx.shell.move_resize(win["id"], PREFS_X, PREFS_Y, 700, 1000)
    ctx.wait_stable(win["id"])
    ctx.shell.move_resize(win["id"], PREFS_X, PREFS_Y, 700, 1900)
    ctx.wait_stable(win["id"])
    win = ctx.window(win["id"])
    settle(0.8)
    ctx.notes.append("prefs window %r %s" % (win["title"],
                                             R.fmt_rect(win["frame"])))
    return proc


def stop_prefs(ctx, proc):
    if proc.poll() is None:
        proc.terminate()


def ext_get(ctx, key):
    env = dict(os.environ, GSETTINGS_SCHEMA_DIR=ctx.schema_dir)
    return subprocess.run(["gsettings", "get", R.SCHEMA, key], env=env,
                          check=True, capture_output=True,
                          text=True).stdout.strip()


def tap(ctx, keyval, mods=()):
    for m in mods:
        ctx.shell.key(m, True)
    ctx.shell.key(keyval, True)
    ctx.shell.key(keyval, False)
    for m in reversed(mods):
        ctx.shell.key(m, False)
    time.sleep(0.03)


def type_text(ctx, text):
    for ch in text:
        tap(ctx, ord(ch))


CTRL, TAB, SPACE = 0xffe3, 0xff09, 0x20
PREFS_X, PREFS_Y = 2000, 40

# Window-relative points in the prefs window (measured on
# review-prefs-open-prefs.png).
PREFS_POINTS = {
    "trigger-width+": (593, 153),
    "gap+": (593, 381),
    "snap-assist": (588, 491),
    "thirds": (588, 719),
    "custom-expander": (602, 994),
    "custom-text": (350, 1080),
}


@review("review-prefs-controls", "verify", "prefs")
def sc_prefs_controls(ctx):
    """Each prefs control writes its key; custom-layouts Apply rejects
    invalid JSON (nothing saved) and saves valid JSON."""
    proc = start_prefs(ctx)
    results = {}
    try:
        def click(name):
            x, y = PREFS_POINTS[name]
            ctx.click(PREFS_X + x, PREFS_Y + y)
            time.sleep(0.3)

        click("trigger-width+")
        results["trigger-width"] = ext_get(ctx, "trigger-width")
        click("gap+")
        results["gap"] = ext_get(ctx, "gap")
        click("snap-assist")
        results["snap-assist"] = ext_get(ctx, "snap-assist")
        click("thirds")
        results["disabled-layouts"] = ext_get(ctx, "disabled-layouts")
        ctx.screenshot("after-clicks")

        click("custom-expander")
        settle(0.4)
        ctx.screenshot("expanded")
        click("custom-text")
        tap(ctx, ord("a"), (CTRL,))
        type_text(ctx, '[{"name": "Bad", "zones": [{"x": 0.5, "y": 0, '
                       '"w": 0.9, "h": 1}]}]')
        # Tab out of the text view to Apply (TextView eats plain Tab).
        tap(ctx, TAB, (CTRL,))
        tap(ctx, SPACE)
        settle(0.4)
        results["custom-after-invalid"] = ext_get(ctx, "custom-layouts")
        ctx.screenshot("invalid-json")

        tap(ctx, TAB, (0xffe1,))  # back to the text view (Shift+Tab)
        settle(0.2)
        tap(ctx, ord("a"), (CTRL,))
        type_text(ctx, '[{"name": "Wide", "zones": [{"x": 0.1, "y": 0, '
                       '"w": 0.8, "h": 1}]}]')
        tap(ctx, TAB, (CTRL,))
        tap(ctx, SPACE)
        settle(0.4)
        results["custom-after-valid"] = ext_get(ctx, "custom-layouts")
        ctx.screenshot("valid-json")
    finally:
        stop_prefs(ctx, proc)
        ctx.notes.append(json.dumps(results))
        for key, val in (("trigger-width", "40"), ("gap", "0"),
                         ("snap-assist", "true"), ("disabled-layouts", "[]"),
                         ("custom-layouts", "'[]'")):
            ctx.ext_set(key, val)
    expect = {"trigger-width": "41", "gap": "1", "snap-assist": "false",
              "disabled-layouts": "['thirds']", "custom-after-invalid": "'[]'"}
    bad = {k: (results.get(k), v) for k, v in expect.items()
           if results.get(k) != v}
    if "Wide" not in results.get("custom-after-valid", ""):
        bad["custom-after-valid"] = (results.get("custom-after-valid"),
                                     "contains Wide")
    if bad:
        fail("prefs keys (got, expected): %s" % bad)


@review("review-top-edge-maximize", "info", "trigger")
def sc_top_edge_maximize(ctx):
    """SPEC: Mutter's top-edge maximize keeps working. Release a drag with
    the pointer on the top bar at the monitor centre (picker shown, no cell
    hovered), with the extension enabled, then disabled, and compare."""
    mon = ctx.monitor()["rect"]
    out = {}
    for enabled in (True, False):
        if not enabled:
            ctx.set_enabled_extensions([R.HELPER_UUID])
            R.wait_for(lambda: ctx.shell.status()["extensions"]
                       .get(R.EXT_UUID, {}).get("state") != 1,
                       3, 0.05, "extension disabled")
        try:
            win = R.standard_window(ctx, "edge-%s" % enabled)
            ctx.begin_drag(win)
            ctx.glide(mon["x"] + mon["width"] / 2, mon["y"] + 4, steps=25)
            settle(0.5)
            ctx.screenshot("edge-%s" % ("on" if enabled else "off"))
            ctx.release()
            R.wait_for(lambda: ctx.window(win["id"])["is_maximized"], 1.5,
                       0.05, "maximize") if not enabled else time.sleep(1.0)
            out[enabled] = ctx.window(win["id"])["is_maximized"]
        except R.ScenarioFailure as e:
            out[enabled] = "error: %s" % e
        finally:
            ctx.release()
            ctx.close_clients()
            if not enabled:
                ctx.set_enabled_extensions([R.HELPER_UUID, R.EXT_UUID])
                R.wait_for(lambda: ctx.shell.status()["extensions"]
                           .get(R.EXT_UUID, {}).get("state") == 1,
                           3, 0.05, "extension re-enabled")
    ctx.notes.append("maximized on top-bar release: enabled=%s disabled=%s"
                     % (out[True], out[False]))
    if out[False] is True and out[True] is not True:
        fail("top-edge maximize broken by the extension: released on the "
             "top bar centre -> maximized=%s (extension disabled: %s)"
             % (out[True], out[False]))
