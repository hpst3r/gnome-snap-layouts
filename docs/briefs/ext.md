# Brief: ext — core extension (picker, drag watcher, tiling, prefs)

Own: `snap-layouts@wporter.org/extension.js`, `prefs.js`, `stylesheet.css`
(outside the snap-assist marker block — create the file with an empty
`/* snap-assist:begin */\n/* snap-assist:end */` block at the end),
`lib/layouts.js`, any other `lib/*.js` you need EXCEPT `lib/snapAssist*.js`,
and `tests/layouts_test.js`.

Implement SPEC sections 1–5, 7, 8, Settings, Layout model, Actor naming,
Prefs, and the extension side of the Snap Assist seam (call
`showSnapAssist` from `./lib/snapAssist.js` exactly as specified; the
committed stub closes immediately — that is fine; pass a real `snapWindow`
callback that applies the same snap path + restore bookkeeping as a picker drop).

Suggested structure (yours to refine): `lib/layouts.js` (pure model),
`lib/dragWatcher.js` (grab-op-begin/end + pointer poll → state machine
idle → armed → picker-shown → hovering), `lib/picker.js` (St actors built from
`pickerGeometry`, hover highlight, preview rect), `lib/tiler.js` (snap,
unmaximize, restore-size map), `extension.js` (wiring, settings, lifecycle).
Keep every decision you can (trigger band, hit test, rect math, restore rect,
state transitions if feasible) in pure functions with unit tests.

Unit tests (`tests/layouts_test.js`, plain `gjs -m`, tiny assert helper, exit
non-zero on failure via `(await import('system')).default.exit(1)`) must prove:
- U1 every built-in validates; zone counts: halves 2, two-thirds-left 2,
  thirds 3, quadrants 4, half-left-quarters-right 3, quarters-left-half-right 3,
  quarter-half-quarter 3.
- U2 for every built-in, on work areas {0,32,1920,1048}, {0,27,2560,1413},
  {1920,0,1366,768} (odd sizes) with gap 0: zone rects cover the work area
  exactly — no gaps, no overlaps (pixel-area sum equals work-area area and
  pairwise intersections are empty) and every edge is integer.
- U3 gap 8: outer edges inset 8, interior edges separated by exactly 8 px.
- U4 validateLayout rejects: out-of-range fractions, overlap, zero zones,
  >12 zones, non-numeric; parseCustomLayouts handles garbage JSON, non-array,
  id collision suffixing, missing id.
- U5 inTriggerBand boundaries (just inside/outside each edge; pointer above
  work area over the panel counts).
- U6 pickerGeometry: thumbs never overlap, cells lie inside their thumb,
  picker horizontally centred on monitor, ≤4 columns, scale 2 doubles sizes;
  hitTest returns the right cell at each cell centre and null in gutters and
  outside; pointerInPicker margin.
- U7 restoreRect keeps the pointer's relative x and stays inside the work area.

In-shell smoke (required): start an isolated headless shell per the SPEC
isolation rule with your extension installed in its `XDG_DATA_HOME`
(copy, compile schema), enabled via its private dconf
(`gsettings set org.gnome.shell enabled-extensions "['snap-layouts@wporter.org']"`
run INSIDE the `dbus-run-session` with the same XDG_* env — never on the host
bus), and confirm from shell stderr that the extension enables with no JS
errors and no warnings mentioning snap-layouts. A separate E2E worker is
building `scripts/e2e.sh` + real-drag scenarios in parallel — you do NOT need
to automate drags, but if you can cheaply prove the enable/disable cycle
(e.g. toggling enabled-extensions inside the private session) do so.
Record the exact commands you used in `tests_run`.

Tools: gjs, node, glib-compile-schemas, gnome-extensions pack, make, git,
gnome-shell, dbus-run-session, gsettings (private session only), timeout,
kill, curl (reference sources only).
