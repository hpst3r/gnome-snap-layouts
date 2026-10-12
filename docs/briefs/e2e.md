# Brief: e2e — headless nested GNOME Shell harness with real pointer drags

Own ONLY: `scripts/e2e.sh`, `scripts/e2e-*.sh`, `tests/e2e/**`. Do not edit
the extension. `make e2e` runs `scripts/e2e.sh`.

Goal: a reproducible, host-isolated end-to-end test that drives REAL pointer
input through Mutter so window move grabs, the extension's picker and the
snap all happen exactly as for a user.

Components:
1. `scripts/e2e.sh [scenario...]`: creates a fresh `.e2e/run-<ts>/` with
   private XDG_CONFIG/DATA/CACHE/STATE/RUNTIME dirs (0700), copies
   `snap-layouts@wporter.org` and the helper extension into its
   `XDG_DATA_HOME/gnome-shell/extensions/`, compiles schemas, then inside ONE
   `dbus-run-session`: sets `org.gnome.shell enabled-extensions` and
   `disable-user-extensions false` via gsettings on the PRIVATE bus/dconf, and
   seeds any extension settings scenarios need; starts
   `gnome-shell --headless --wayland --no-x11 --virtual-monitor 1920x1080
   --wayland-display <unique>` (stderr → run dir log); waits for the helper's
   D-Bus name; runs the driver; kills the shell by PID; exits non-zero on any
   failed scenario or any `JS ERROR`/`Exception`/extension-error line in the
   shell log. It must also skip the welcome tour / overview-at-startup
   if they interfere (e.g. `org.gnome.shell welcome-dialog-last-shown-version`
   set high; close the overview the shell opens at startup via the helper).
   Respect the SPEC isolation rule absolutely — verify by checking that host
   `~/.config/dconf/user` mtime is unchanged before/after (print both).
2. Helper extension `tests/e2e/snaptest@wporter.org/` (test-only, never
   packaged) exporting D-Bus `org.wporter.SnapTest` at `/org/wporter/SnapTest`
   on the private session bus, methods returning JSON strings where sensible:
   `ListWindows()` (id, title, wm_class, frame rect, is_maximized, monitor,
   minimized), `GetMonitors()` (monitor rects + work areas),
   `FindActors(prefix)` (name + transformed stage bounds + visible/mapped of
   every actor under `global.stage` whose name starts with prefix),
   `PointerMove(x, y)`, `PointerButton(button, pressed)`, `Key(keyval, pressed)`
   via a Clutter virtual pointer/keyboard device created in enable(),
   `Screenshot(path)` (whole stage to PNG), `HideOverview()`,
   `ActivateWindow(id)`, `MoveResize(id,x,y,w,h)`, `Log()` maybe.
3. Test client: `tests/e2e/client.py` (run with `/usr/bin/python3`, which has
   gi + Gtk 4) opening a titled window (`--title`, default size) with a
   normal headerbar so a press-and-drag on the headerbar starts a
   compositor move grab. Launched with `WAYLAND_DISPLAY` of the nested shell.
4. Driver `tests/e2e/run.py` (`/usr/bin/python3`, stdlib + `gdbus call` or gi
   Gio): scenario registry, smooth multi-step pointer motion (≥15 steps with
   short sleeps so polling at 60 Hz sees intermediate positions), waits with
   timeouts, screenshot on failure into the run dir, JSON summary.

Scenarios (contract names/geometry from docs/SPEC.md):
- `smoke` (no dependency on the extension's features): one client window;
  press on its headerbar, drag 300 px right/150 px down, release; assert
  frame moved by ≈ that delta. PROVE THIS ONE PASSES.
- `picker-shows`: drag a window's headerbar to top center (x = monitor
  center, y = 10), wait ≤1 s for actor `snap-layouts-picker` visible; move
  away to (center, 500) and assert it hides within 1 s; release.
- `snap-<layout>-<zone>` for: halves:0, halves:1, quadrants:0..3,
  half-left-quarters-right:1, two-thirds-left:0, thirds:2,
  quarter-half-quarter:1: drag to top center, wait for picker, move smoothly
  to the center of `snap-layouts-zone:<id>:<i>` (from FindActors), assert
  `snap-layouts-preview` visible, screenshot, release, assert the window frame
  equals the zone rect computed from the work area with gap 0 (compute it in
  Python by the SPEC zoneRect rule, ±2 px) and the picker is gone.
- `no-zone-no-snap`: show picker, then release at (center, 600): frame not a
  zone rect; picker gone.
- `restore-on-drag-out`: snap to halves:0, then drag the headerbar down
  200 px; assert width/height return to the pre-snap size (±2 px).
- `snap-assist`: three windows; snap one to halves:0; expect
  `snap-layouts-assist` and a `snap-layouts-assist-window:<id>` thumbnail;
  click one; assert that window fills halves:1. (The assist module is built
  in parallel; until merged this may legitimately fail — report it.)
- `disable-cleans-up`: snap once, then disable the extension via the private
  gsettings (enabled-extensions without it) and assert FindActors('snap-layouts')
  is empty and no errors logged; re-enable and run picker-shows again.
- `gap`: set gap 8 via private gsettings; snap quadrants:3; assert inset rect.

The extension itself is being written in parallel (worker "ext"). In your
worktree it does not exist yet beyond metadata/schema/stub — that's expected.
Make `smoke` pass for real now; implement every other scenario completely
against the contract; run them and report their (expected) failures with the
exact reason (e.g. "picker actor never appeared"). Treat any harness bug you
see as yours. Keep the default run fast (< 3 min) and give scenarios names
selectable on the command line.

Tools: bash, /usr/bin/python3, gdbus, gsettings (private session only),
gnome-shell, dbus-run-session, glib-compile-schemas, timeout, kill, pgrep,
make, git, curl (reference sources only).
