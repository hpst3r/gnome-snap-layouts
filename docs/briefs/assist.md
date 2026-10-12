# Brief: assist — Snap Assist (SPEC §6 and "Seam: Snap Assist")

Own ONLY: `snap-layouts@wporter.org/lib/snapAssist.js` (replace the stub),
optional `lib/snapAssistModel.js` (pure helpers), the stylesheet block between
`/* snap-assist:begin */` and `/* snap-assist:end */` (the file may not exist
in your worktree: create `stylesheet.css` containing ONLY that marked block;
the architect merges it), and `tests/snap_assist_model_test.js`.

Implement `showSnapAssist(p)` exactly per the seam signature:
- Candidates: normal (`Meta.WindowType.NORMAL`), not minimized? (include
  minimized windows like Windows does — show them, and unminimize on pick),
  not skip-taskbar, on the active workspace, on `p.monitorIndex`, excluding
  `p.window` and windows already placed in this assist session; most recently
  used first (`global.display.get_tab_list(Meta.TabList.NORMAL, workspace)`).
- For the FIRST remaining zone (then the next after each pick), show a panel
  at the zone rect named `snap-layouts-assist-zone:<i>` containing a grid of
  thumbnails (`snap-layouts-assist-window:<id>` St.Button: `Clutter.Clone` of
  `win.get_compositor_private()` scaled to fit, app icon via
  `Shell.WindowTracker.get_default().get_window_app(win)`, ellipsized title).
  Show the other remaining zones as dim outlined placeholders. Root actor
  `snap-layouts-assist`, a full-monitor reactive backdrop so clicks outside
  thumbnails dismiss. Thumbnails reachable by keyboard (arrow keys move focus,
  Enter picks, Escape dismisses) — grab key focus with `Main.pushModal`
  on the root and `Main.popModal` on close (check the 50.5 `pushModal`
  signature via the reference sources).
- Pick → `p.snapWindow(win, zoneRect)`, activate the window
  (`Main.activateWindow(win)`), advance; close when zones or candidates run out.
- Dismiss on Escape, backdrop click, overview showing
  (`Main.overview` 'showing'), workspace switch
  (`global.workspace_manager` 'active-workspace-changed'), monitors-changed,
  or a candidate/placed window unmanaging (rebuild without it; close if none
  left). `onClosed` fires exactly once. `destroy()` idempotent, disconnects
  every signal, pops modal, destroys actors.
- Size thumbnails to fit the zone: pure helper `gridForZone(zoneRect, n,
  {aspect, minThumb, maxThumb, spacing})` -> {cols, rows, thumbW, thumbH, x0, y0}
  unit-tested (fits inside zone, preserves window aspect per thumb, n=0..12,
  tiny zones fall back to a scrollable/cap behaviour you document).
- Light ease-in/out (≤150 ms) respecting `St.Settings.get().enable_animations`.

Verification: `make check` with your unit tests; then an isolated headless
shell smoke per the SPEC isolation rule. Since the drag/picker side is built
in parallel by another worker, add a TEMPORARY dev harness file under
`.e2e/` (gitignored, not committed) — e.g. a throwaway extension in the
private `XDG_DATA_HOME` that imports your module via a file URI and calls
`showSnapAssist` with 2–3 fake zones while 2–3 GTK4 test windows are open
(`/usr/bin/python3` has `gi` with Gtk 4; plain `python3` in PATH may not) —
and prove: actors with the contract names appear, a synthetic pick calls
`snapWindow` with the right rect, Escape/destroy closes with `onClosed` once,
and no JS errors. Pointer/keyboard input injection, if you need it: a Clutter
virtual device (`Clutter.get_default_backend().get_default_seat()
.create_virtual_device(...)`) inside your harness extension. Save one
screenshot of the assist in the headless shell to `.e2e/assist.png`
(e.g. `Shell.Screenshot` from inside the harness) and report its path.

Tools: gjs, node, glib-compile-schemas, make, git, gnome-shell,
dbus-run-session, gsettings (private session only), /usr/bin/python3,
timeout, kill, curl (reference sources only).
