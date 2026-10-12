#!/usr/bin/python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Snap Assist skips zones already filled by a window (SPEC Amendment 5).

Window A is snapped into one zone first; then B is snapped into another zone
of the same layout. With `assist-skip-occupied` on, A's zone is not offered
and A is not a candidate; with it off, both are. Expected rects come from
the harness's own zone math (R.zone_rect), not from lib/layouts.js.
"""

import time

import __main__ as R

Fail = R.ScenarioFailure

KEY_ESCAPE = 0xff1b


def assist(name):
    return R.scenario(name, tags=("assist",))


def press_escape(ctx):
    ctx.shell.key(KEY_ESCAPE, True)
    ctx.shell.key(KEY_ESCAPE, False)


def snap_and_dismiss(ctx, win, layout, zone):
    """Snap win, then close any assist it opened with Escape."""
    ctx.snap(win, layout, zone, shot=False)
    try:
        ctx.wait_shown("snap-layouts-assist", 0.8)
    except Fail:
        return
    time.sleep(0.2)
    press_escape(ctx)
    ctx.wait_hidden("snap-layouts-assist", 1.5)


def open_windows(ctx):
    """A, B, C, D at rects that fill no quadrant (≤ 46 % of one)."""
    wins = {}
    for title, rect in (("occ-a", (1100, 200, 600, 400)),
                        ("occ-b", (100, 150, 600, 400)),
                        ("occ-c", (300, 600, 600, 400)),
                        ("occ-d", (1000, 650, 600, 380))):
        wins[title[-1]] = R.standard_window(ctx, title, *rect)
    return wins


def assist_zone_rects(ctx):
    """{index: rect} of every shown snap-layouts-assist-zone:<i> actor."""
    out = {}
    for a in ctx.shell.actors("snap-layouts-assist-zone:"):
        if a["visible"] and a["mapped"]:
            out[int(a["name"].rsplit(":", 1)[1])] = a
    return out


def check_zones(ctx, expected, what):
    got = assist_zone_rects(ctx)
    if sorted(got) != list(range(len(expected))):
        raise Fail("%s: assist zone actors %s, expected indices %s"
                   % (what, sorted(got), list(range(len(expected)))))
    for i, rect in enumerate(expected):
        if not R.rects_close(got[i], rect):
            raise Fail("%s: assist zone %d at %s, expected %s"
                       % (what, i, R.fmt_rect(got[i]), R.fmt_rect(rect)))


def check_thumbs(ctx, offered, hidden, what):
    names = {w["id"]: "snap-layouts-assist-window:%s" % w["id"]
             for w in offered + hidden}
    try:
        R.wait_for(lambda: all(ctx.shown(names[w["id"]]) for w in offered),
                   1.5, 0.05, "thumbnails of %s"
                   % [w["title"] for w in offered])
    except Fail:
        present = [a["name"] for a in ctx.shell.actors("snap-layouts-assist-window:")]
        raise Fail("%s: expected thumbnails for %s, found %s"
                   % (what, [w["title"] for w in offered], present))
    for w in hidden:
        if ctx.actor(names[w["id"]]):
            raise Fail("%s: %s offered although it fills a zone"
                       % (what, w["title"]))


def quadrant_rects(ctx, indices):
    wa = ctx.work_area()
    return [R.zone_rect(wa, R.LAYOUTS["quadrants"][i], 0) for i in indices]


def run_quadrants(ctx, skip):
    w = open_windows(ctx)
    snap_and_dismiss(ctx, w["a"], "quadrants", 1)
    ctx.snap(w["b"], "quadrants", 0, shot=False)
    try:
        ctx.wait_shown("snap-layouts-assist", 1.5)
    except Fail:
        ctx.screenshot("no-assist")
        raise Fail("snap-layouts-assist never appeared after snapping B")
    if skip:
        check_zones(ctx, quadrant_rects(ctx, (2, 3)), "skip on")
        check_thumbs(ctx, [w["c"], w["d"]], [w["a"]], "skip on")
        time.sleep(0.4)  # settled: open fade finished
        path = ctx.screenshot("assist-occupied")
        ctx.notes.append("screenshot %s" % path)
    else:
        check_zones(ctx, quadrant_rects(ctx, (1, 2, 3)), "skip off")
        check_thumbs(ctx, [w["a"], w["c"], w["d"]], [], "skip off")
    press_escape(ctx)
    ctx.wait_hidden("snap-layouts-assist", 1.5)


@assist("assist-skip-occupied")
def sc_skip_occupied(ctx):
    run_quadrants(ctx, skip=True)


@assist("assist-skip-occupied-off")
def sc_skip_occupied_off(ctx):
    ctx.ext_set("assist-skip-occupied", "false")
    try:
        run_quadrants(ctx, skip=False)
    finally:
        ctx.ext_set("assist-skip-occupied", "true")


@assist("assist-all-occupied")
def sc_all_occupied(ctx):
    # C would be a candidate, so only the occupancy rule keeps assist away.
    a = R.standard_window(ctx, "occ-a", 1100, 200, 600, 400)
    b = R.standard_window(ctx, "occ-b", 100, 150, 600, 400)
    R.standard_window(ctx, "occ-c", 300, 600, 600, 400)
    snap_and_dismiss(ctx, a, "halves", 1)
    ctx.snap(b, "halves", 0, shot=False)
    deadline = time.monotonic() + 1.0
    while time.monotonic() < deadline:
        if ctx.shown("snap-layouts-assist"):
            ctx.screenshot("unexpected-assist")
            raise Fail("snap-layouts-assist shown although halves:1 is "
                       "filled by A")
        time.sleep(0.05)
