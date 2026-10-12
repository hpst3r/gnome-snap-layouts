#!/usr/bin/python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Adversarial review scenarios (review-core), all tagged ``review``.

Loaded by run.py only when SNAP_REVIEW=1 (scripts/e2e.sh then also adds a
second 1280x1024 virtual monitor right of the 1920x1080 one). Each scenario
asserts the behaviour the SPEC / brief requires, so a FAIL is a finding.
Scenarios tagged ``diag`` are harness controls/diagnostics, run only on
request, e.g. ``make e2e SNAP_REVIEW="@diag"`` (SNAP_REVIEW may hold any
scenario/tag selection).

Run as a script (``review_scenarios.py --client ...``) this file is a small
GTK 4 client with options the harness client lacks (fixed size, minimum
size, transient child window).
"""

import os
import subprocess
import sys
import time

KEY_SUPER = 0xffeb
KEY_ALT = 0xffe9
KEY_LEFT = 0xff51
KEY_UP = 0xff52
KEY_F7 = 0xffc4
KEY_ESCAPE = 0xff1b
KEY_RETURN = 0xff0d


# ------------------------------------------------------------------ client
def client_main():
    import argparse

    import gi
    gi.require_version("Gtk", "4.0")
    from gi.repository import Gtk

    ap = argparse.ArgumentParser()
    ap.add_argument("--client", action="store_true")
    ap.add_argument("--title", default="review")
    ap.add_argument("--width", type=int, default=800)
    ap.add_argument("--height", type=int, default=500)
    ap.add_argument("--fixed", action="store_true", help="not resizable")
    ap.add_argument("--min", type=int, nargs=2, metavar=("W", "H"),
                    help="minimum content size")
    ap.add_argument("--child", action="store_true",
                    help="also open a non-modal transient child '<title>-child'")
    args = ap.parse_args()
    app = Gtk.Application(application_id=None)

    def make(title, w, h):
        win = Gtk.ApplicationWindow(application=app)
        win.set_title(title)
        win.set_default_size(w, h)
        win.set_titlebar(Gtk.HeaderBar())
        label = Gtk.Label(label=title)
        if args.min:
            label.set_size_request(*args.min)
        win.set_child(label)
        win.set_resizable(not args.fixed)
        return win

    def on_activate(_app):
        parent = make(args.title, args.width, args.height)
        parent.present()
        if args.child:
            child = make(args.title + "-child", 500, 300)
            child.set_transient_for(parent)
            child.set_modal(False)
            child.present()

    app.connect("activate", on_activate)
    return app.run([sys.argv[0]])


if __name__ == "__main__":
    sys.exit(client_main())


# ------------------------------------------------------------------ scenarios
import __main__ as R  # noqa: E402  (run.py)

Fail = R.ScenarioFailure
HERE = os.path.dirname(os.path.abspath(__file__))


def review(name):
    return R.scenario(name, tags=("review",))


def combo(ctx, *keys):
    for k in keys:
        ctx.shell.key(k, True)
        time.sleep(0.02)
    for k in reversed(keys):
        ctx.shell.key(k, False)
        time.sleep(0.02)
    time.sleep(0.3)


def spawn_custom(ctx, title, *extra, width=800, height=500, find_title=None):
    proc = subprocess.Popen(
        [R.PY, os.path.abspath(__file__), "--client", "--title", title,
         "--width", str(width), "--height", str(height), *extra],
        stdout=subprocess.DEVNULL,
        stderr=open(os.path.join(ctx.run_dir, "client-%s.log" % title), "w"))
    ctx.clients.append(proc)
    want = find_title or title

    def find():
        if proc.poll() is not None:
            raise Fail("client %s exited with %s" % (title, proc.returncode))
        for w in ctx.shell.windows():
            if w["title"] == want:
                return w
        return None

    win = R.wait_for(find, 10, 0.05, "window %r to map" % want)
    ctx.wait_stable(win["id"])
    return ctx.window(win["id"]), proc


def monitors(ctx):
    return ctx.shell.monitors()


def zone(ctx, layout, i, mon=0, gap=0):
    return R.zone_rect(monitors(ctx)[mon]["workArea"], R.LAYOUTS[layout][i], gap)


def frame(ctx, win):
    return ctx.window(win["id"])["frame"]


def expect_frame(ctx, win, exp, what, timeout=2.0):
    try:
        R.wait_for(lambda: R.rects_close(frame(ctx, win), exp), timeout, 0.03, what)
    except Fail:
        ctx.screenshot("bad-frame")
        raise Fail("%s: frame %s, expected %s" % (what, R.fmt_rect(frame(ctx, win)),
                                                  R.fmt_rect(exp)))


def drag_out(ctx, win, dx=0, dy=200):
    hx, hy = ctx.begin_drag(ctx.window(win["id"]))
    ctx.glide(hx + dx, hy + dy, steps=20, sleep=0.015)
    time.sleep(0.1)
    ctx.release()
    return ctx.wait_stable(win["id"])


def pickers(ctx):
    return [a for a in ctx.shell.actors("snap-layouts-picker")
            if a["name"] == "snap-layouts-picker"]


def set_ext_enabled(ctx, on):
    uuids = [R.HELPER_UUID, R.EXT_UUID] if on else [R.HELPER_UUID]
    ctx.set_enabled_extensions(uuids)
    R.wait_for(lambda: (ctx.shell.status()["extensions"].get(R.EXT_UUID, {})
                        .get("state") == 1) == on, 3, 0.02,
               "extension %s" % ("enabled" if on else "disabled"))


def open_assist(ctx, layout="halves", zone_index=0, others=1):
    others = [R.standard_window(ctx, "assist-o%d" % i, 150 + 80 * i, 200 + 40 * i)
              for i in range(others)]
    main = R.standard_window(ctx, "assist-main", 300, 250)
    ctx.snap(main, layout, zone_index, shot=False)
    ctx.wait_shown("snap-layouts-assist", 1.5)
    return main, others


def snap_loose(ctx, win, layout, zone_index):
    """ctx.snap() for windows that need a longer pull to start moving."""
    loose_drag_begin(ctx, win)
    mon = ctx.monitor()["rect"]
    ctx.glide(mon["width"] / 2, 10, steps=25)
    ctx.wait_shown("snap-layouts-picker", 1.5)
    cell = ctx.actor("snap-layouts-zone:%s:%d" % (layout, zone_index))
    ctx.glide(*R.centre(cell), steps=15)
    time.sleep(0.15)
    ctx.release()
    expect_frame(ctx, win, zone(ctx, layout, zone_index),
                 "snap to %s:%d" % (layout, zone_index))


def pick_in_assist(ctx, win):
    name = "snap-layouts-assist-window:%s" % win["id"]
    thumb = R.wait_for(lambda: ctx.shown(name), 1.5, 0.05, name)
    time.sleep(0.3)
    thumb = ctx.shown(name) or thumb
    ctx.click(*R.centre(thumb))


# ------------------------------------------------------------ drag edge cases
@review("review-keyboard-move-no-picker")
def sc_keyboard_move(ctx):
    """Alt+F7 (KEYBOARD_MOVING) must never show the picker."""
    win = R.standard_window(ctx)
    mon = ctx.monitor()["rect"]
    combo(ctx, KEY_ALT, KEY_F7)
    try:
        for x, y in [(mon["width"] / 2, 300), (mon["width"] / 2, 20),
                     (mon["width"] / 2 + 10, 12)]:
            ctx.glide(x, y, steps=15)
            time.sleep(0.25)
            if ctx.shown("snap-layouts-picker"):
                raise Fail("picker shown during keyboard move (Alt+F7)")
    finally:
        combo(ctx, KEY_ESCAPE)
    ctx.wait_stable(win["id"])


@R.scenario("review-top-edge-maximize", tags=("diag",))
def sc_top_edge(ctx):
    """Picker shown, release at y=0 above it: mutter maximizes, no snap.
    Diag only: mutter edge tiling/maximize does not trigger in the headless
    harness even with the extension disabled (diag-top-edge-noext)."""
    win = R.standard_window(ctx)
    mon = ctx.monitor()["rect"]
    ctx.drag_to_picker(win)
    ctx.glide(mon["width"] / 2, 0, steps=10)
    time.sleep(0.4)
    ctx.release()
    try:
        R.wait_for(lambda: ctx.window(win["id"])["is_maximized"], 2, 0.05,
                   "mutter top-edge maximize")
    except Fail:
        raise Fail("not maximized after release at top edge; frame %s"
                   % R.fmt_rect(frame(ctx, win)))
    ctx.wait_hidden("snap-layouts-picker")


@R.scenario("review-left-edge-tiling", tags=("diag",))
def sc_left_edge(ctx):
    """Without the picker, dropping at the left edge still half-tiles.
    Diag only (see diag-left-edge-noext)."""
    win = R.standard_window(ctx)
    ctx.begin_drag(win)
    ctx.glide(0, 540, steps=20)
    time.sleep(0.5)
    if ctx.shown("snap-layouts-picker"):
        raise Fail("picker shown at the left edge")
    ctx.release()
    expect_frame(ctx, win, zone(ctx, "halves", 0), "mutter left tile")


@review("review-snap-mutter-tiled-window")
def sc_tiled_drag(ctx):
    """Super+Left tiled window dragged onto a zone snaps there; dragging it
    out restores the pre-tile size."""
    win = R.standard_window(ctx)
    combo(ctx, KEY_SUPER, KEY_LEFT)
    expect_frame(ctx, win, zone(ctx, "halves", 0), "super+left tile")
    snap_loose(ctx, win, "quadrants", 3)
    f = drag_out(ctx, win)
    if (f["width"], f["height"]) != (800, 500):
        raise Fail("after drag-out size %dx%d, expected 800x500"
                   % (f["width"], f["height"]))


@review("review-assist-tiled-candidate")
def sc_assist_tiled(ctx):
    """Snap Assist pick of a window mutter tiled with Super+Left must land in
    the offered zone (tiling constraints must be cleared first)."""
    other = R.standard_window(ctx, "assist-o0", 150, 200)
    combo(ctx, KEY_SUPER, KEY_LEFT)
    expect_frame(ctx, other, zone(ctx, "halves", 0), "super+left tile")
    main = R.standard_window(ctx, "assist-main", 300, 250)
    ctx.snap(main, "quadrants", 0, shot=False)
    ctx.wait_shown("snap-layouts-assist", 1.5)
    pick_in_assist(ctx, other)
    expect_frame(ctx, other, zone(ctx, "quadrants", 1),
                 "tiled window picked into quadrants:1")


@review("review-assist-maximized-candidate")
def sc_assist_maximized(ctx):
    """Snap Assist pick of a maximized window lands in the zone; dragging it
    out afterwards gives back its normal (pre-maximize) size."""
    other = R.standard_window(ctx, "assist-o0", 150, 200)
    combo(ctx, KEY_SUPER, KEY_UP)
    R.wait_for(lambda: ctx.window(other["id"])["is_maximized"], 2, 0.05,
               "super+up maximize")
    main = R.standard_window(ctx, "assist-main", 300, 250)
    ctx.snap(main, "halves", 0, shot=False)
    ctx.wait_shown("snap-layouts-assist", 1.5)
    pick_in_assist(ctx, other)
    expect_frame(ctx, other, zone(ctx, "halves", 1),
                 "maximized window picked into halves:1")
    ctx.wait_hidden("snap-layouts-assist", 1.5)
    loose_drag_begin(ctx, other)
    ctx.glide(700, 600, steps=15)
    time.sleep(0.1)
    ctx.release()
    f = ctx.wait_stable(other["id"])
    if (f["width"], f["height"]) != (800, 500):
        raise Fail("dragging the assist-snapped (was maximized) window out "
                   "kept %dx%d instead of restoring 800x500"
                   % (f["width"], f["height"]))


@review("review-nonresizable")
def sc_nonresizable(ctx):
    """Non-resizable window: moved centred in the zone, size kept."""
    win, _ = spawn_custom(ctx, "fixed", "--fixed", width=600, height=400)
    win = ctx.place(win, 200, 250, win["frame"]["width"], win["frame"]["height"])
    f0 = win["frame"]
    ctx.drag_to_picker(win)
    cell = ctx.actor("snap-layouts-zone:halves:1")
    ctx.glide(*R.centre(cell), steps=15)
    time.sleep(0.15)
    ctx.release()
    z = zone(ctx, "halves", 1)
    exp = {"x": R.jround(z["x"] + (z["width"] - f0["width"]) / 2),
           "y": R.jround(z["y"] + (z["height"] - f0["height"]) / 2),
           "width": f0["width"], "height": f0["height"]}
    expect_frame(ctx, win, exp, "fixed-size window centred in halves:1")


@review("review-min-size-larger-than-zone")
def sc_min_size(ctx):
    """A window whose minimum size exceeds the zone must stay on screen."""
    win, _ = spawn_custom(ctx, "minsize", "--min", "1100", "650",
                          width=1150, height=700)
    win = ctx.place(win, 100, 150, win["frame"]["width"], win["frame"]["height"])
    ctx.drag_to_picker(win)
    cell = ctx.actor("snap-layouts-zone:quadrants:3")
    ctx.glide(*R.centre(cell), steps=15)
    time.sleep(0.15)
    ctx.release()
    time.sleep(1.0)
    f = ctx.wait_stable(win["id"])
    wa = ctx.work_area()
    ctx.notes.append("min-size window after quadrants:3 snap: %s" % R.fmt_rect(f))
    if f["x"] + f["width"] > wa["x"] + wa["width"] + R.TOL or \
            f["y"] + f["height"] > wa["y"] + wa["height"] + R.TOL:
        raise Fail("window %s extends past the work area %s (its minimum "
                   "size is larger than the zone)"
                   % (R.fmt_rect(f), R.fmt_rect(wa)))


@review("review-transient-no-picker")
def sc_transient(ctx):
    """Dragging a transient (dialog-like) child window must not offer the
    picker (SPEC: only normal windows)."""
    _parent, _ = spawn_custom(ctx, "parent", "--child")
    child = R.wait_for(lambda: next((w for w in ctx.shell.windows()
                                     if w["title"] == "parent-child"), None),
                       5, 0.05, "child window")
    ctx.notes.append("child window type=%s normal=%s" % (child["type"], child["normal"]))
    child = ctx.place(child, 300, 300, child["frame"]["width"], child["frame"]["height"])
    mon = ctx.monitor()["rect"]
    ctx.begin_drag(child)
    ctx.glide(mon["width"] / 2, 10, steps=20)
    time.sleep(0.5)
    shown = ctx.shown("snap-layouts-picker")
    ctx.release()
    if shown:
        raise Fail("picker shown while dragging a transient child window "
                   "(type %s)" % child["type"])


@review("review-close-mid-drag")
def sc_close_mid_drag(ctx):
    """Window unmanaged during the grab: picker goes away, nothing breaks,
    the next drag works."""
    win, proc = spawn_custom(ctx, "doomed")
    win = ctx.place(win, 200, 250, 800, 500)
    ctx.drag_to_picker(win)
    proc.kill()
    proc.wait()
    try:
        ctx.wait_hidden("snap-layouts-picker", 2.0)
    finally:
        ctx.release()
    other = R.standard_window(ctx, "after")
    ctx.snap(other, "halves", 1, shot=False)


@review("review-restore-pointer-fraction")
def sc_restore_fraction(ctx):
    """SPEC 5: drag-out keeps the pointer at the same relative x across the
    window. Uses the right half so a stale drag anchor would show."""
    win = R.standard_window(ctx)
    snapped = ctx.snap(win, "halves", 1, shot=False)
    hx, _hy = ctx.headerbar_point(ctx.window(win["id"]))
    frac0 = (hx - snapped["x"]) / snapped["width"]
    hx, hy = ctx.begin_drag(ctx.window(win["id"]))
    ctx.glide(hx - 100, hy + 200, steps=20, sleep=0.015)
    time.sleep(0.2)
    f = frame(ctx, win)
    p = ctx.shell.pointer()
    ctx.release()
    frac = (p["x"] - f["x"]) / f["width"]
    ctx.notes.append("grab fraction %.2f -> %.2f, frame %s pointer %d,%d"
                     % (frac0, frac, R.fmt_rect(f), p["x"], p["y"]))
    if f["width"] != 800:
        raise Fail("not restored: %s" % R.fmt_rect(f))
    if abs(frac - frac0) > 0.06:
        raise Fail("pointer at %.2f of restored window width, grabbed at %.2f "
                   "(frame %s, pointer %d,%d)" % (frac, frac0, R.fmt_rect(f),
                                                  p["x"], p["y"]))


# ------------------------------------------------------------- restore-size
@review("review-resnap-keeps-original-size")
def sc_resnap(ctx):
    win = R.standard_window(ctx)
    ctx.snap(win, "halves", 0, shot=False)
    ctx.snap(ctx.window(win["id"]), "quadrants", 3, shot=False)
    f = drag_out(ctx, win, dx=-300)
    if (f["width"], f["height"]) != (800, 500):
        raise Fail("after re-snap + drag-out size %dx%d, expected original "
                   "800x500" % (f["width"], f["height"]))


@review("review-resnap-no-restore-setting")
def sc_resnap_norestore(ctx):
    """restore-size-on-drag off: re-snapping must still not lose track (and
    must not restore); turning it back on later restores the ORIGINAL size."""
    ctx.ext_set("restore-size-on-drag", "false")
    try:
        win = R.standard_window(ctx)
        ctx.snap(win, "halves", 0, shot=False)
        ctx.snap(ctx.window(win["id"]), "quadrants", 3, shot=False)
    finally:
        ctx.ext_set("restore-size-on-drag", "true")
    f = drag_out(ctx, win, dx=-300)
    if (f["width"], f["height"]) != (800, 500):
        raise Fail("size %dx%d, expected original 800x500"
                   % (f["width"], f["height"]))


@review("review-resize-then-dragout-no-restore")
def sc_resize_no_restore(ctx):
    """snap -> user resizes -> drag out must NOT restore. The resize happens
    shortly after the snap (within the extension's 500 ms settle window)."""
    win = R.standard_window(ctx)
    exp = ctx.snap(win, "halves", 0, shot=False)
    time.sleep(0.15)
    ctx.shell.move_resize(win["id"], exp["x"], exp["y"], 700, 600)
    R.wait_for(lambda: frame(ctx, win)["width"] == 700, 2, 0.03, "user resize")
    time.sleep(1.0)
    f = drag_out(ctx, win, dx=200)
    if (f["width"], f["height"]) != (700, 600):
        raise Fail("user-resized window restored to %dx%d on drag-out "
                   "(expected to keep 700x600)" % (f["width"], f["height"]))


@review("review-resize-late-then-dragout-no-restore")
def sc_resize_late(ctx):
    win = R.standard_window(ctx)
    exp = ctx.snap(win, "halves", 0, shot=False)
    time.sleep(1.0)
    ctx.shell.move_resize(win["id"], exp["x"], exp["y"], 700, 600)
    R.wait_for(lambda: frame(ctx, win)["width"] == 700, 2, 0.03, "user resize")
    f = drag_out(ctx, win, dx=200)
    if (f["width"], f["height"]) != (700, 600):
        raise Fail("user-resized window restored to %dx%d"
                   % (f["width"], f["height"]))


# ------------------------------------------------------------------ lifecycle
@review("review-disable-mid-drag")
def sc_disable_mid_drag(ctx):
    # The first enabled-extensions change of a session can reload the
    # helper (and its virtual pointer, losing the pressed button); do one
    # toggle up front (diag-nopicker-disable-release shows it).
    set_ext_enabled(ctx, False)
    set_ext_enabled(ctx, True)
    win = R.standard_window(ctx)
    ctx.drag_to_picker(win)
    try:
        set_ext_enabled(ctx, False)
        time.sleep(0.2)
        left = ctx.shell.actors("snap-layouts")
        if left:
            raise Fail("actors left after disable mid-drag: %s"
                       % [a["name"] for a in left])
        set_ext_enabled(ctx, True)
        # Still dragging: hovering a cell position and releasing must not
        # snap (the new instance never saw this grab begin) nor throw.
        ctx.glide(ctx.monitor()["rect"]["width"] / 2, 60, steps=10)
        time.sleep(0.3)
    finally:
        set_ext_enabled(ctx, True)
        ctx.release()
    ctx.wait_stable(win["id"])
    ctx.snap(ctx.place(ctx.window(win["id"]), 200, 250, 800, 500),
             "halves", 0, shot=False)


@review("review-disable-assist-open")
def sc_disable_assist(ctx):
    open_assist(ctx)
    if ctx.shell.status()["modalCount"] < 1:
        raise Fail("assist open but modalCount 0")
    try:
        set_ext_enabled(ctx, False)
        time.sleep(0.3)
        st = ctx.shell.status()
        left = ctx.shell.actors("snap-layouts")
        if st["modalCount"] != 0:
            raise Fail("modalCount %d after disable with assist open"
                       % st["modalCount"])
        if left:
            raise Fail("actors left: %s" % [a["name"] for a in left])
    finally:
        set_ext_enabled(ctx, True)


@review("review-enable-disable-cycles")
def sc_cycles(ctx):
    """20 enable/disable cycles (with a snap in between to populate the
    restore map) leave exactly one live picker and no stray actors."""
    win = R.standard_window(ctx)
    ctx.snap(win, "halves", 0, shot=False)
    for i in range(20):
        set_ext_enabled(ctx, False)
        left = ctx.shell.actors("snap-layouts")
        if left:
            raise Fail("cycle %d: actors left %s" % (i, [a["name"] for a in left]))
        set_ext_enabled(ctx, True)
    win = ctx.place(ctx.window(win["id"]), 200, 250, 800, 500)
    ctx.drag_to_picker(win)
    n = len(pickers(ctx))
    ctx.release()
    if n != 1:
        raise Fail("%d picker actors after 20 cycles (leaked watchers?)" % n)


@review("review-settings-change-mid-drag")
def sc_settings_mid_drag(ctx):
    """Changing disabled-layouts while the picker is shown must not make the
    drop use a different layout than the hovered cell."""
    win = R.standard_window(ctx)
    ctx.drag_to_picker(win)
    cell = ctx.actor("snap-layouts-zone:thirds:2")
    ctx.glide(*R.centre(cell), steps=15)
    time.sleep(0.15)
    ctx.ext_set("disabled-layouts", "['halves']")
    try:
        time.sleep(0.2)
        ctx.release()
        expect_frame(ctx, win, zone(ctx, "thirds", 2), "drop on thirds:2")
    finally:
        ctx.ext_set("disabled-layouts", "[]")


# --------------------------------------------------------------- multi-monitor
def second_monitor(ctx):
    mons = monitors(ctx)
    if len(mons) < 2:
        raise Fail("needs 2 monitors (SNAP_REVIEW=1 scripts/e2e.sh adds one); "
                   "got %d" % len(mons))
    ctx.notes.append("monitors: %s" % [(m["rect"], m["workArea"]) for m in mons])
    return mons[1]


def drag_to_picker_on(ctx, win, mon):
    r = mon["rect"]
    ctx.begin_drag(win)
    ctx.glide(r["x"] + r["width"] / 2, mon["workArea"]["y"] + 10, steps=30)
    return ctx.wait_shown("snap-layouts-picker", 1.5)


@review("review-multimonitor-snap")
def sc_mm_snap(ctx):
    m1 = second_monitor(ctx)
    win = R.standard_window(ctx)
    picker = drag_to_picker_on(ctx, win, m1)
    r = m1["rect"]
    if not (r["x"] <= picker["x"] and picker["x"] + picker["width"] <= r["x"] + r["width"]):
        ctx.release()
        raise Fail("picker %s not on monitor 1 %s" % (R.fmt_rect(picker), R.fmt_rect(r)))
    cell = ctx.actor("snap-layouts-zone:halves:1")
    ctx.glide(*R.centre(cell), steps=15)
    time.sleep(0.15)
    ctx.release()
    expect_frame(ctx, win, zone(ctx, "halves", 1, mon=1), "halves:1 on monitor 1")


@review("review-multimonitor-cross")
def sc_mm_cross(ctx):
    """Picker shown on monitor 0, pointer carried over to monitor 1's band:
    the picker moves to monitor 1 and the drop uses monitor 1's work area."""
    m1 = second_monitor(ctx)
    win = R.standard_window(ctx)
    ctx.drag_to_picker(win)
    r = m1["rect"]
    # (Along y=10 the pointer is stopped at x=1920 by the shell's top-left
    # pressure barrier of monitor 1, so go round below the top bar.)
    ctx.glide(960, 300, steps=10)
    ctx.glide(r["x"] + r["width"] / 2, 300, steps=30)
    ctx.glide(r["x"] + r["width"] / 2, m1["workArea"]["y"] + 10, steps=15)
    time.sleep(0.5)
    ps = pickers(ctx)
    if len(ps) != 1 or not (r["x"] <= ps[0]["x"] < r["x"] + r["width"]):
        ctx.release()
        raise Fail("after crossing, pickers at %s; expected one on monitor 1"
                   % [R.fmt_rect(p) for p in ps])
    cell = ctx.actor("snap-layouts-zone:quadrants:0")
    ctx.glide(*R.centre(cell), steps=15)
    time.sleep(0.15)
    ctx.release()
    expect_frame(ctx, win, zone(ctx, "quadrants", 0, mon=1), "quadrants:0 on monitor 1")


@review("review-multimonitor-restore")
def sc_mm_restore(ctx):
    """Window snapped on monitor 1, dragged out: restored size."""
    m1 = second_monitor(ctx)
    win = R.standard_window(ctx)
    drag_to_picker_on(ctx, win, m1)
    cell = ctx.actor("snap-layouts-zone:halves:0")
    ctx.glide(*R.centre(cell), steps=15)
    time.sleep(0.15)
    ctx.release()
    expect_frame(ctx, win, zone(ctx, "halves", 0, mon=1), "halves:0 on monitor 1")
    f = drag_out(ctx, win, dx=-150)
    if (f["width"], f["height"]) != (800, 500):
        raise Fail("size %dx%d after drag-out on monitor 1" % (f["width"], f["height"]))


# ------------------------------------------------- diagnostics / controls
def diag(name):
    return R.scenario(name, tags=("diag",))


def loose_drag_begin(ctx, win):
    """begin_drag for windows mutter keeps stuck until a larger 'shake
    loose' distance (tiled / maximized-like windows)."""
    f0 = frame(ctx, win)
    hx, hy = ctx.headerbar_point(ctx.window(win["id"]))
    ctx.glide(hx, hy, steps=8)
    time.sleep(0.1)
    ctx.press()
    time.sleep(0.08)
    ctx.glide(hx + 10, hy + 10, steps=5, sleep=0.02)
    ctx.glide(hx + 60, hy + 150, steps=15, sleep=0.02)
    R.wait_for(lambda: frame(ctx, win) != f0, 1.0, 0.02, "loose move grab")
    return hx, hy


@diag("diag-left-edge-noext")
def dg_left_noext(ctx):
    set_ext_enabled(ctx, False)
    try:
        win = R.standard_window(ctx)
        ctx.begin_drag(win)
        ctx.glide(0, 540, steps=20)
        time.sleep(0.5)
        ctx.release()
        f = ctx.wait_stable(win["id"])
        ctx.notes.append("no extension, release at left edge: %s" % R.fmt_rect(f))
    finally:
        set_ext_enabled(ctx, True)


@diag("diag-top-edge-noext")
def dg_top_noext(ctx):
    set_ext_enabled(ctx, False)
    try:
        win = R.standard_window(ctx)
        ctx.begin_drag(win)
        ctx.glide(960, 0, steps=20)
        time.sleep(0.5)
        ctx.release()
        f = ctx.wait_stable(win["id"])
        ctx.notes.append("no extension, release at top edge: %s max=%s"
                         % (R.fmt_rect(f), ctx.window(win["id"])["is_maximized"]))
    finally:
        set_ext_enabled(ctx, True)


@diag("diag-toggle-mid-drag")
def dg_toggle(ctx):
    """Does toggling enabled-extensions during a press break the harness's
    virtual button state? (window still follows after release = stuck grab)"""
    win = R.standard_window(ctx)
    hx, hy = ctx.begin_drag(win)
    ctx.glide(hx + 50, hy + 300, steps=10)
    set_ext_enabled(ctx, False)
    set_ext_enabled(ctx, True)
    ctx.release()
    time.sleep(0.3)
    f1 = frame(ctx, win)
    ctx.glide(hx + 300, hy + 400, steps=10)
    time.sleep(0.3)
    f2 = frame(ctx, win)
    ctx.notes.append("after release %s, after moving pointer %s"
                     % (R.fmt_rect(f1), R.fmt_rect(f2)))
    if f1 != f2:
        raise Fail("window still follows the pointer after release")


@diag("diag-gap-mid-drag")
def dg_gap(ctx):
    win = R.standard_window(ctx)
    hx, hy = ctx.begin_drag(win)
    ctx.glide(hx + 50, hy + 300, steps=10)
    ctx.ext_set("gap", "4")
    ctx.ext_set("gap", "0")
    ctx.release()
    time.sleep(0.3)
    f1 = frame(ctx, win)
    ctx.glide(hx + 300, hy + 400, steps=10)
    time.sleep(0.3)
    f2 = frame(ctx, win)
    if f1 != f2:
        raise Fail("window still follows the pointer after release")


@diag("diag-mm-paths")
def dg_mm(ctx):
    """Which pointer paths onto monitor 1 make the picker appear there."""
    m1 = second_monitor(ctx)
    r = m1["rect"]
    tx, ty = r["x"] + r["width"] / 2, 10
    results = []
    for label, path in [
        ("diag from below", [(tx, 400), (tx, ty)]),
        ("along y=10", [(960, 10), (tx, ty)]),
        ("along y=200 then up", [(960, 200), (tx, 200), (tx, ty)]),
        ("via picker then below", [(960, 10), (960, 300), (tx, 300), (tx, ty)]),
    ]:
        win = R.standard_window(ctx, "mm")
        ctx.begin_drag(win)
        for x, y in path:
            ctx.glide(x, y, steps=25)
            time.sleep(0.3)
        p = ctx.shell.pointer()
        ps = [R.fmt_rect(a) for a in pickers(ctx)]
        ctx.release()
        results.append("%s: pointer %d,%d pickers %s" % (label, p["x"], p["y"], ps))
        ctx.close_clients()
    ctx.notes.extend(results)


def _stuck_after(ctx, setup):
    win = R.standard_window(ctx)
    ctx.drag_to_picker(win)
    setup()
    ctx.release()
    time.sleep(0.3)
    f1 = frame(ctx, win)
    ctx.glide(400, 700, steps=10)
    time.sleep(0.3)
    f2 = frame(ctx, win)
    ctx.notes.append("after release %s, after moving pointer %s"
                     % (R.fmt_rect(f1), R.fmt_rect(f2)))
    if f1 != f2:
        raise Fail("move grab still active after button release")


@diag("diag-picker-disable-release")
def dg_pd(ctx):
    try:
        _stuck_after(ctx, lambda: set_ext_enabled(ctx, False))
    finally:
        set_ext_enabled(ctx, True)


@diag("diag-picker-toggle-release")
def dg_pt(ctx):
    _stuck_after(ctx, lambda: (set_ext_enabled(ctx, False), set_ext_enabled(ctx, True)))


@diag("diag-picker-gap-release")
def dg_pg(ctx):
    _stuck_after(ctx, lambda: (ctx.ext_set("gap", "4"), ctx.ext_set("gap", "0")))


@diag("diag-picker-wait-release")
def dg_pw(ctx):
    _stuck_after(ctx, lambda: time.sleep(1.0))


@diag("diag-nopicker-disable-release")
def dg_npd(ctx):
    """Control: same as diag-picker-disable-release but the pointer never
    reaches the trigger band (no picker)."""
    win = R.standard_window(ctx)
    hx, hy = ctx.begin_drag(win)
    ctx.glide(hx + 100, hy + 250, steps=10)
    try:
        set_ext_enabled(ctx, False)
        ctx.release()
        time.sleep(0.3)
        f1 = frame(ctx, win)
        ctx.glide(400, 700, steps=10)
        time.sleep(0.3)
        f2 = frame(ctx, win)
    finally:
        set_ext_enabled(ctx, True)
    ctx.notes.append("after release %s, after moving pointer %s"
                     % (R.fmt_rect(f1), R.fmt_rect(f2)))
    if f1 != f2:
        raise Fail("move grab still active after button release")
