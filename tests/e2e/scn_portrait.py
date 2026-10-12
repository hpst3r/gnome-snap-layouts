#!/usr/bin/python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Portrait layouts and orientation matching (SPEC Amendment 3).

All scenarios are tagged ``portrait`` and need the extra portrait monitor:

    E2E_EXTRA_MONITOR=1080x1920 scripts/e2e.sh @portrait

Monitor 0 is the 1920x1080 primary (top bar), monitor 1 the 1080x1920 one to
its right (no top bar). Expected layouts and rects are computed here from the
SPEC tables, independently of lib/layouts.js.
"""

import json
import time

import __main__ as R

Fail = R.ScenarioFailure

LANDSCAPE = ["halves", "two-thirds-left", "thirds", "quadrants",
             "half-left-quarters-right", "quarters-left-half-right",
             "quarter-half-quarter"]
PORTRAIT_LAYOUTS = {
    "v-halves": [(0, 0, 1, 1 / 2), (0, 1 / 2, 1, 1 / 2)],
    "v-thirds": [(0, 0, 1, 1 / 3), (0, 1 / 3, 1, 1 / 3), (0, 2 / 3, 1, 1 / 3)],
    "v-quarter-half-quarter": [(0, 0, 1, 1 / 4), (0, 1 / 4, 1, 1 / 2),
                               (0, 3 / 4, 1, 1 / 4)],
}
PORTRAIT = list(PORTRAIT_LAYOUTS)
CUSTOM_ANY = [{"id": "e2e-any", "name": "E2E any",
               "zones": [{"x": 0, "y": 0, "w": 1 / 4, "h": 1},
                         {"x": 1 / 4, "y": 0, "w": 3 / 4, "h": 1}]}]
ALL_LAYOUTS = dict(R.LAYOUTS, **PORTRAIT_LAYOUTS,
                   **{"e2e-any": [(0, 0, 1 / 4, 1), (1 / 4, 0, 3 / 4, 1)]})


def portrait(name):
    return R.scenario(name, tags=("portrait",))


def portrait_monitor(ctx):
    mons = ctx.shell.monitors()
    if len(mons) < 2:
        raise Fail("needs the portrait monitor: run with "
                   "E2E_EXTRA_MONITOR=1080x1920 scripts/e2e.sh @portrait "
                   "(got %d monitor(s))" % len(mons))
    m = mons[1]
    wa = m["workArea"]
    if wa["height"] <= wa["width"]:
        raise Fail("monitor 1 work area %s is not portrait" % R.fmt_rect(wa))
    return m


def expected_cells(layout_ids):
    return sorted("snap-layouts-zone:%s:%d" % (lid, i)
                  for lid in layout_ids for i in range(len(ALL_LAYOUTS[lid])))


def cell_names(ctx):
    return sorted(a["name"] for a in ctx.shell.actors("snap-layouts-zone:")
                  if a["name"].startswith("snap-layouts-zone:"))


def picker_on(ctx, win, mon_index):
    """Drag win into the trigger band of monitor mon_index and return the
    shown picker actor. The path to monitor 1 crosses below the top bar:
    along y≈0 the pointer is held at x=1920 by a pressure barrier."""
    mon = ctx.shell.monitors()[mon_index]
    r, wa = mon["rect"], mon["workArea"]
    cx = r["x"] + r["width"] / 2
    ctx.begin_drag(win)
    if mon_index != 0:
        ctx.glide(960, 400, steps=10)
        ctx.glide(cx, 400, steps=30)
    ctx.glide(cx, wa["y"] + 2, steps=25)
    try:
        picker = ctx.wait_shown("snap-layouts-picker", 1.5)
    except Fail:
        ctx.screenshot("no-picker")
        raise
    if not (r["x"] <= picker["x"] and
            picker["x"] + picker["width"] <= r["x"] + r["width"]):
        raise Fail("picker %s not on monitor %d %s"
                   % (R.fmt_rect(picker), mon_index, R.fmt_rect(r)))
    # Cells are created with the picker; give the actor tree a moment.
    time.sleep(0.1)
    return picker


def abandon_drag(ctx, win, mon_index):
    """Leave the picker without hovering a cell, let it hide, then drop and
    let the window settle (a place() racing the end of the move is undone)."""
    r = ctx.shell.monitors()[mon_index]["rect"]
    ctx.glide(r["x"] + r["width"] / 2, r["y"] + r["height"] * 0.6, steps=15)
    ctx.wait_hidden("snap-layouts-picker", 1.5)
    ctx.release()
    time.sleep(0.3)
    ctx.wait_stable(win["id"])


def check_offered(ctx, win, mon_index, layout_ids, what, shot=None):
    picker_on(ctx, win, mon_index)
    got = cell_names(ctx)
    want = expected_cells(layout_ids)
    if shot:
        time.sleep(0.4)  # settled (fade-in finished)
        ctx.screenshot(shot)
    if got != want:
        ctx.release()
        raise Fail("%s: monitor %d cells %s, expected %s (missing %s, extra %s)"
                   % (what, mon_index, got, want,
                      sorted(set(want) - set(got)), sorted(set(got) - set(want))))
    abandon_drag(ctx, win, mon_index)
    ctx.notes.append("monitor %d offers %s" % (mon_index, layout_ids))


def snap_on(ctx, win, mon_index, layout, zone, expect_fixed=None):
    picker_on(ctx, win, mon_index)
    name = "snap-layouts-zone:%s:%d" % (layout, zone)
    cell = ctx.actor(name)
    if not cell:
        names = cell_names(ctx)
        ctx.release()
        raise Fail("cell %s not offered; cells: %s" % (name, names))
    ctx.glide(*R.centre(cell), steps=15)
    time.sleep(0.15)
    try:
        ctx.wait_shown("snap-layouts-preview", 1.0)
    except Fail:
        ctx.release()
        raise Fail("no preview over %s" % name)
    time.sleep(0.4)
    ctx.screenshot("preview-%s-%d" % (layout, zone))
    ctx.release()
    wa = ctx.shell.monitors()[mon_index]["workArea"]
    exp = R.zone_rect(wa, ALL_LAYOUTS[layout][zone], 0)
    if expect_fixed and wa == {"x": 1920, "y": 0, "width": 1080, "height": 1920}:
        if exp != expect_fixed:
            raise Fail("harness rect %s != SPEC rect %s"
                       % (R.fmt_rect(exp), R.fmt_rect(expect_fixed)))
    try:
        R.wait_for(lambda: R.rects_close(ctx.window(win["id"])["frame"], exp),
                   2.0, 0.03, "frame == %s:%d rect" % (layout, zone))
    except Fail:
        got = ctx.window(win["id"])["frame"]
        ctx.screenshot("bad-frame")
        raise Fail("%s:%d on monitor %d: frame %s, expected %s"
                   % (layout, zone, mon_index, R.fmt_rect(got), R.fmt_rect(exp)))
    ctx.wait_hidden("snap-layouts-picker", 1.0)
    ctx.notes.append("%s:%d -> %s" % (layout, zone, R.fmt_rect(exp)))


@portrait("portrait-picker-cells")
def sc_portrait_cells(ctx):
    """Portrait monitor offers exactly the three portrait layouts."""
    portrait_monitor(ctx)
    win = R.standard_window(ctx)
    check_offered(ctx, win, 1, PORTRAIT, "match-orientation on", shot="picker")


@portrait("portrait-snap-v-thirds")
def sc_portrait_v_thirds(ctx):
    portrait_monitor(ctx)
    win = R.standard_window(ctx)
    snap_on(ctx, win, 1, "v-thirds", 2,
            {"x": 1920, "y": 1280, "width": 1080, "height": 640})


@portrait("portrait-snap-v-quarter-half-quarter")
def sc_portrait_v_qhq(ctx):
    portrait_monitor(ctx)
    win = R.standard_window(ctx)
    snap_on(ctx, win, 1, "v-quarter-half-quarter", 1,
            {"x": 1920, "y": 480, "width": 1080, "height": 960})


@portrait("portrait-landscape-unchanged")
def sc_landscape_unchanged(ctx):
    """The landscape primary still offers exactly the 7 landscape layouts."""
    portrait_monitor(ctx)
    win = R.standard_window(ctx)
    check_offered(ctx, win, 0, LANDSCAPE, "match-orientation on")


@portrait("portrait-match-off")
def sc_match_off(ctx):
    """match-orientation false: every layout on both monitors."""
    portrait_monitor(ctx)
    ctx.ext_set("match-orientation", "false")
    try:
        win = R.standard_window(ctx)
        check_offered(ctx, win, 1, LANDSCAPE + PORTRAIT, "match-orientation off",
                      shot="picker-all")
        win = ctx.place(ctx.window(win["id"]), 200, 250, 800, 500)
        check_offered(ctx, win, 0, LANDSCAPE + PORTRAIT, "match-orientation off")
    finally:
        ctx.ext_set("match-orientation", "true")


@portrait("portrait-custom-any")
def sc_custom_any(ctx):
    """A custom layout without orientation is offered on both monitors,
    after the built-ins of each monitor's orientation, and snaps on the
    portrait monitor."""
    portrait_monitor(ctx)
    ctx.ext_set("custom-layouts", "'%s'" % json.dumps(CUSTOM_ANY))
    try:
        win = R.standard_window(ctx)
        check_offered(ctx, win, 1, PORTRAIT + ["e2e-any"], "custom any")
        win = ctx.place(ctx.window(win["id"]), 200, 250, 800, 500)
        check_offered(ctx, win, 0, LANDSCAPE + ["e2e-any"], "custom any")
        win = ctx.place(ctx.window(win["id"]), 200, 250, 800, 500)
        snap_on(ctx, win, 1, "e2e-any", 1)
    finally:
        ctx.ext_set("custom-layouts", "'[]'")
