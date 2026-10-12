# Snap Layouts for GNOME Shell — SPEC (authoritative)

Windows 11–style snap layouts for GNOME Shell 50 (Wayland, ESM extensions).
UUID `snap-layouts@wporter.org`. License AGPL-3.0-or-later. Target: GNOME Shell
50 / Mutter 18 (`Meta-18`). `metadata.json` `shell-version: ["50"]`.

## MVP behaviour (this wave)

1. **Trigger.** While the user drags a window with the pointer (grab op
   `Meta.GrabOp.MOVING` or `MOVING_UNCONSTRAINED`, compare after masking
   `Meta.GrabOp.WINDOW_FLAG_UNCONSTRAINED` if that flag exists; ignore
   `KEYBOARD_MOVING`), poll the pointer (`global.get_pointer()`) at ~60 Hz
   (GLib timeout, `GLib.PRIORITY_DEFAULT`). Only normal windows
   (`Meta.WindowType.NORMAL`), `allows_move()`, not fullscreen. When the
   pointer is inside the **trigger band** of the monitor under the pointer for
   `show-delay-ms`, show the **picker** on that monitor.
   - Trigger band: `y < workArea.y + trigger-height` and
     `|x − (monitor.x + monitor.width/2)| ≤ monitor.width × trigger-width% / 2`.
     (y may be above workArea.y, i.e. over the top panel.)
2. **Picker.** A translucent rounded panel, horizontally centered on the
   monitor, top edge at `workArea.y + 8` logical px. It contains one
   **thumbnail** per enabled layout, arranged in a grid of at most 4 columns
   (row-major, built-in order then custom). Each thumbnail has the monitor's
   work-area aspect ratio, base width 112 logical px (× `St.ThemeContext`
   scale factor), and shows its zones as rounded cells separated by 3 px.
   The picker stays visible while the pointer is in the trigger band OR inside
   the picker bounds expanded by 24 px; otherwise it hides after 150 ms of
   being outside. A new drag always starts with no picker.
3. **Hover.** Because mutter holds the pointer grab during a move, hover is
   computed by the extension from polled coordinates against geometry from the
   pure model (`lib/layouts.js`), not from St hover events. The hovered cell
   gets pseudo-class `hover`; a full-size **preview** rectangle (translucent,
   accent-coloured, rounded, short ease) shows the zone's target rect on the
   monitor.
4. **Drop.** On `grab-op-end` for the dragged window, if a cell is hovered:
   snap the window to `zoneRect(workArea, zone, gap)`. Unmaximize first if
   `is_maximized()` (Mutter 18: `maximize()`/`unmaximize()` take NO flags).
   Apply `move_resize_frame(true, x, y, w, h)` from an idle/`Meta.later`
   after the grab ends. If `!window.allows_resize()`, only move it centered in
   the zone. If no cell is hovered, do nothing (Mutter's own edge tiling and
   top-edge maximize keep working untouched; never change
   `org.gnome.mutter edge-tiling`). Picker and preview are destroyed/hidden on
   every grab end.
5. **Restore size on drag-out** (`restore-size-on-drag`, default true). On
   snap, remember the window's pre-snap frame size (and the snapped rect)
   keyed by the window; forget it on `unmanaged` or when the window is later
   resized by other means (frame no longer equals snapped rect ±2 px at drag
   start). When a remembered window starts a pointer move grab while still at
   its snapped rect, resize it back to the remembered size, keeping the pointer
   at the same relative x fraction across the window width and the same y
   offset from the top (clamped into the window).
6. **Snap Assist** (`snap-assist`, default true). After a successful snap from
   the picker, if the chosen layout has other zones and there are other
   eligible normal windows on the same workspace and monitor, show Snap Assist:
   each remaining zone gets a translucent panel at its target rect containing
   clickable thumbnails (`Clutter.Clone` of window actors, with app icon +
   title) of eligible windows. Clicking a thumbnail snaps that window into
   that zone (with the same restore-size bookkeeping) and moves on to the next
   remaining zone, excluding windows already placed. Escape, clicking outside
   any thumbnail, a new window grab, focus change to a non-assist window,
   workspace switch, or overview opening dismisses it. Implemented by
   `lib/snapAssist.js` through the seam below.
7. **Multi-monitor / HiDPI.** Everything is per the monitor under the pointer,
   using `Main.layoutManager.getWorkAreaForMonitor(i)`. Sizes are logical px.
8. **Clean disable.** `disable()` disconnects every signal, removes every GLib
   source, destroys every actor, clears all maps, nulls settings. After
   disable no actor named `snap-layouts-*` remains in `global.stage`.
   Nothing is created at import time. Follow GNOME extension review rules.

## Settings (`org.gnome.shell.extensions.snap-layouts`, path `/org/gnome/shell/extensions/snap-layouts/`)

| key | type | default | range/notes |
|---|---|---|---|
| `trigger-width` | i | 40 | 10–100 (% of monitor width, centered) |
| `trigger-height` | i | 8 (Amendment 2) | 8–200 (px below work-area top) |
| `show-delay-ms` | i | 80 | 0–1000 |
| `gap` | i | 0 | 0–64 (px between zones and at work-area edges) |
| `restore-size-on-drag` | b | true | |
| `snap-assist` | b | true | |
| `disabled-layouts` | as | [] | ids of built-ins to hide |
| `custom-layouts` | s | `'[]'` | JSON array of layout objects, appended after built-ins |
| `debug` | b | false | log decisions via `console.debug`/`console.log` with prefix `[snap-layouts]` |

Settings changes apply live (next drag) without re-enable.

## Layout model (`lib/layouts.js` — PURE JS, no `gi://`/`resource://` imports)

A layout: `{id: string, name: string, zones: Zone[]}`; a zone is fractions of
the work area `{x, y, w, h}` with 0 ≤ x, y; w, h > 0; x + w ≤ 1, y + h ≤ 1
(tolerance 1e-6). Zones must not overlap (area-overlap tolerance 1e-6) and
must number 1–12. Built-ins, in picker order:

| id | name | zones |
|---|---|---|
| `halves` | Halves | ½ \| ½ |
| `two-thirds-left` | Two-thirds / third | ⅔ \| ⅓ |
| `thirds` | Thirds | ⅓ \| ⅓ \| ⅓ |
| `quadrants` | Quadrants | 2×2 |
| `half-left-quarters-right` | Half + quarters | left ½ full height; right ½ split into top/bottom |
| `quarters-left-half-right` | Quarters + half | left ½ split top/bottom; right ½ full height |
| `quarter-half-quarter` | Center focus | ¼ \| ½ \| ¼ |

Exports (exact names; the shell code and tests depend on them):

```js
export const BUILTIN_LAYOUTS;                 // frozen array, table above
export function validateLayout(obj) -> {ok: true, layout} | {ok: false, error: string}
export function parseCustomLayouts(jsonText) -> {layouts: Layout[], errors: string[]}
    // invalid entries are dropped with an error each; missing id -> `custom-<index>`;
    // ids colliding with built-ins or earlier customs get `-2`, `-3`… suffixes;
    // non-array / unparsable JSON -> {layouts: [], errors: [msg]}
export function enabledLayouts(disabledIds, customLayouts) -> Layout[]
export function zoneRect(workArea, zone, gap) -> {x, y, width, height}
    // integer logical px. Edges snap to the work area so adjacent zones share
    // boundaries exactly (compute edges as round(workArea.x + f*width) then
    // subtract), then inset: gap at work-area edges, gap/2 on interior edges
    // (gap = 0 -> zones tile the work area exactly with no holes/overlap).
export function inTriggerBand(monitor, workArea, px, py, {triggerWidthPct, triggerHeight}) -> bool
export function pickerGeometry(monitor, workArea, layouts, {scale = 1} = {}) ->
    {x, y, width, height, padding, thumbs: [{layoutIndex, layoutId, x, y, width, height,
      cells: [{zoneIndex, x, y, width, height}]}]}
    // all coordinates absolute stage px; cells inset by 1.5*scale (3 px gutters)
export function hitTest(geometry, px, py) -> {layoutIndex, layoutId, zoneIndex} | null
export function pointerInPicker(geometry, px, py, margin) -> bool
export function restoreRect(snappedRect, savedSize, px, py, workArea) -> {x, y, width, height}
export function rectsClose(a, b, tol = 2) -> bool
```

## Actor naming contract (used by the E2E harness — do not deviate)

- picker root: `name = 'snap-layouts-picker'`
- picker cell: `name = 'snap-layouts-zone:<layoutId>:<zoneIndex>'`
- drop preview: `'snap-layouts-preview'`
- Snap Assist root: `'snap-layouts-assist'`; per-zone panel
  `'snap-layouts-assist-zone:<i>'` (i = index into the `zones` array passed in);
  window thumbnail button `'snap-layouts-assist-window:<window.get_id()>'`.

All of these are added under `Main.layoutManager.uiGroup` (or via
`Main.layoutManager.addTopChrome` / `addChrome`) so the harness can find them
by walking `global.stage`.

## Seam: Snap Assist (`lib/snapAssist.js`)

```js
/**
 * @param {object} p
 * @param {Meta.Window} p.window        window just snapped (excluded from candidates)
 * @param {number} p.monitorIndex
 * @param {{x,y,width,height}} p.workArea
 * @param {Array<{x,y,width,height}>} p.zones   remaining zones' target rects (stage px, gap applied)
 * @param {(win: Meta.Window, rect) => void} p.snapWindow  call to snap a chosen window
 *        (the caller applies unmaximize/move_resize/restore bookkeeping)
 * @param {() => void} p.onClosed      called exactly once when assist closes for any reason
 * @returns {{destroy(): void}}         idempotent
 */
export function showSnapAssist(p)
```

`extension.js` owns the lifecycle: it calls `showSnapAssist` after a picker
snap (when `snap-assist` is on and remaining zones exist), destroys any open
assist before a new one, on any new grab begin, and on disable.
`snapAssist.js` decides candidate windows itself and owns its own signal
connections (it must disconnect all on destroy).

## Files and ownership

```
snap-layouts@wporter.org/metadata.json        architect
snap-layouts@wporter.org/schemas/*.gschema.xml architect
snap-layouts@wporter.org/extension.js          worker ext
snap-layouts@wporter.org/prefs.js              worker ext
snap-layouts@wporter.org/lib/layouts.js        worker ext
snap-layouts@wporter.org/lib/*.js (other)      worker ext (except snapAssist*.js)
snap-layouts@wporter.org/lib/snapAssist*.js    worker assist
snap-layouts@wporter.org/stylesheet.css        worker ext; assist appends ONLY a
                                               block between `/* snap-assist:begin */`
                                               and `/* snap-assist:end */` markers
tests/*_test.js                                ext: layouts_test.js; assist: snap_assist_*_test.js
tests/e2e/**, scripts/e2e*.sh                  worker e2e
Makefile                                       architect (workers report needed changes)
```

## Prefs (`prefs.js`, Adw)

One page, groups: **Trigger** (trigger width %, trigger height px, show delay
ms — `Adw.SpinRow`), **Snapping** (gap spin row, restore-size switch, snap
assist switch), **Layouts** (one `Adw.SwitchRow` per built-in bound to
membership in `disabled-layouts`; an "Custom layouts (JSON)" expander with a
multi-line `Gtk.TextView`, an Apply button that validates with
`parseCustomLayouts` and shows errors in a label without saving invalid JSON),
**Debug** (debug switch). prefs.js may import `./lib/layouts.js`.

## Verification ladder

1. `make test` — `gjs -m` unit tests for pure modules (no GI needed).
2. `make check` — syntax check every JS file with `node --check`, schema
   `glib-compile-schemas --strict --dry-run`.
3. `make pack` — zip contains extension.js, prefs.js, metadata.json,
   stylesheet.css, lib/*, schemas/.
4. `make e2e` — isolated headless nested gnome-shell (see E2E brief) loads the
   extension with no JS errors and runs the real-drag scenarios.
5. User live test (log out/in or `make nested`).

## Isolation rule (all workers, all shells you start)

Never touch the host session: no `gnome-extensions enable/disable`, no
`gsettings`/`dconf` writes, no symlinks into `~/.local/share/gnome-shell`.
Any gnome-shell you start must be `dbus-run-session` + `--headless` with
`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME` and
`XDG_RUNTIME_DIR` pointing at a fresh dir under `$REPO/.e2e/` (gitignored), a
unique `--wayland-display`, and `--no-x11`. Kill it by PID when done.

## Amendment 1 (after wave 1 merge)

- **Isolation:** `dbus-run-session` + private XDG dirs is NOT enough — the
  nested shell otherwise reaches the HOST system bus (logind session
  monitoring, GDM RegisterSession, possible SetLockedHint/inhibitors). Any
  headless shell must be started through `scripts/e2e.sh` (private system
  bus, dconf-only session bus); use `E2E_HOLD=1` or its scenario hooks for
  ad-hoc work. Never start gnome-shell any other way.
- **Zone order** is row-major / reading order: quadrants 0=TL 1=TR 2=BL 3=BR;
  half-left-quarters-right [left, right-top, right-bottom];
  quarters-left-half-right [left-top, left-bottom, right].
- **Snap Assist:** thumbnails are offered for one remaining zone at a time (the
  next in zone order); later zones show as dim placeholders. `onClosed` may
  fire asynchronously (idle) when there is nothing to offer; callers must not
  rely on it having fired when `showSnapAssist` returns.
- The extension must tolerate being disabled/re-enabled at any moment
  (including mid-drag and while assist is open), e.g. by another extension's
  toggle.

## Amendment 2 (after review wave)

- **Trigger (W11-like):** default `trigger-height` is now **8** (the band is
  the top bar plus 8 px below the work-area top). The picker's top edge is
  `bandBottom + 8 × scale` (`pickerGeometry(monitor, workArea, layouts,
  {scale, triggerHeight})`), so no picker cell is ever reachable from inside
  the band, for any trigger-height. A drag that BEGINS with the pointer
  inside the band (e.g. grabbing a maximized/top-snapped window's headerbar)
  does not arm until the pointer has left the band once.
- **Picker construction:** `new Picker(geometry, layouts, {window})` — the
  dragged window, so the drop preview can be stacked directly below it in
  `global.window_group` (like mutter's tile preview) instead of tinting it.
- **Snap targets:** windows tiled by mutter (tile mode / partial maximize
  flags) and maximized windows are untiled/unmaximized before placement; the
  remembered restore size is their normal (unmaximized) size.
- **Eligibility:** transient windows (`get_transient_for()` non-null) never
  show the picker and are never Snap Assist candidates.
- **Review suites:** `make review` runs `SNAP_REVIEW=1 make test`,
  `SNAP_REVIEW=core scripts/e2e.sh`, `SNAP_REVIEW=ux scripts/e2e.sh`; after the
  fix wave they are regression suites and must pass (except `@diag`).

## Amendment 3 (portrait layouts, orientation matching, top bar menu)

### Portrait layouts and orientation
- A layout gains `orientation: 'landscape' | 'portrait' | 'any'`.
  Existing built-ins are `landscape`. New built-ins, `portrait`, appended in
  this order (zone order = reading order, top to bottom, then left to right):

  | id | name | zones (fractions x,y,w,h) |
  |---|---|---|
  | `v-halves` | Stacked halves | (0,0,1,½) (0,½,1,½) |
  | `v-thirds` | Stacked thirds | (0,0,1,⅓) (0,⅓,1,⅓) (0,⅔,1,⅓) |
  | `v-quarter-half-quarter` | Stacked center focus | (0,0,1,¼) (0,¼,1,½) (0,¾,1,¼) — the vertical `quarter-half-quarter`, as on Windows 11 portrait (user decision, supersedes the first draft `v-large-two-small`) |

- Custom layouts may set `orientation`; missing → `any`; any other value is a
  validation error for that entry.
- A monitor is **portrait** when its work area's height > width, else
  landscape. With `match-orientation` true (default), the picker offers
  enabled layouts whose orientation is that monitor's or `any`; with false,
  every enabled layout everywhere. If the filter leaves nothing, the picker
  is not shown.
- Pure API addition in `lib/layouts.js`:
  `workAreaOrientation(workArea) -> 'landscape'|'portrait'` and
  `layoutsForWorkArea(layouts, workArea, matchOrientation) -> Layout[]`
  (order preserved). `extension.js` config already exposes
  `matchOrientation` (architect seam); `dragWatcher` applies the filter when
  it shows the picker.
- Picker thumbnails keep the work-area aspect. For portrait work areas the
  thumbnail HEIGHT is `THUMB_WIDTH × scale` × (work-area h/w) capped so the
  thumbnail's longer side ≤ 176 × scale (keep the picker compact).
- Prefs: the Layouts group lists built-ins under "Landscape" and "Portrait"
  headings; a "Match monitor orientation" switch (`match-orientation`).

### Top bar menu (`show-indicator`, default true)
- `lib/indicator.js` `SnapIndicator(extension, settings)` — a
  `PanelMenu.Button` added with `Main.panel.addToStatusArea(uuid, …)`, icon
  `view-grid-symbolic`, accessible name "Snap Layouts", actor name
  `snap-layouts-indicator`. Menu items (actor names in brackets):
  - switch "Snap Assist" (`snap-layouts-indicator-item:snap-assist`) bound to `snap-assist`
  - switch "Restore size on drag-out" (`…:restore-size-on-drag`)
  - switch "Match monitor orientation" (`…:match-orientation`)
  - separator; "Settings…" (`…:settings`) → `extension.openPreferences()`.
  Switches reflect external setting changes live. `destroy()` is idempotent
  and disconnects every signal.
- `extension.js` (architect seam, done) creates/destroys it live on
  `changed::show-indicator`. Prefs gets a "Show top bar menu" switch.

### E2E
- Feature scenario modules `tests/e2e/scn_*.py` are auto-loaded by run.py
  (`import __main__ as R; @R.scenario(...)`). Tag `portrait` scenarios run
  only with `E2E_EXTRA_MONITOR=1080x1920` (second monitor, right of the
  primary); `make e2e` runs the default pass and then `@portrait`.

## Amendment 4 (interactive nested shell)

`make nested` → `scripts/nested.sh` → `E2E_NESTED=1 scripts/e2e.sh` is the
only allowed way to start a visible `--devkit` shell. It gets the same
isolation as the test modes (private XDG dirs, private session bus, empty
private system bus) plus a private PipeWire + `wireplumber --profile policy`
for the devkit viewer's screencast; the viewer's only host resource is the
host Wayland display socket. `scripts/nested.sh --run CMD` starts a client
inside the newest nested shell. Extra monitors: use the viewer's "Add
Monitor" menu (devkit monitors are viewer windows, not `--virtual-monitor`).

## Amendment 5 (Snap Assist skips occupied zones; nested usability)

### `assist-skip-occupied` (b, default true)
After a picker snap into layout L on monitor M, a remaining zone Z of L is
**occupied** when some other window W — normal, not transient, not
minimized, on the active workspace and on M, not the dragged window — has a
frame rect R with `area(R ∩ Z) ≥ 0.9·area(Z)` and `area(R ∩ Z) ≥ 0.9·area(R)`
(tolerates terminals' character-grid sizing). With the setting on:
occupied zones are not passed to Snap Assist; windows occupying any zone of
L are excluded from its candidates (seam addition: optional
`p.excludeWindows: Meta.Window[]` in `showSnapAssist`); if no zones remain,
Snap Assist is not shown. With it off, behaviour is unchanged. Pure helper
in `lib/layouts.js`: `rectCoverage(zone, frame) -> {ofZone, ofFrame}` and
`occupiedZoneIndices(zoneRects, frameRects, threshold = 0.9) -> Set<number>`.
Prefs: switch under Snapping, below Snap Assist ("Skip zones already
filled"), insensitive when Snap Assist is off. Top bar menu unchanged.

### Nested shell usability
The user found the fully isolated `make nested` unusable (no GNOME app
opens: session-bus activation was restricted to dconf + Extensions). The
user accepts less isolation for the interactive nested shell. Hard
requirements that remain: host dconf never written; host GNOME session's
extension state and settings untouched; the HOST session bus is never
used. Relax whatever else is necessary (standard session service
activation on the private bus; host system bus only if an essential app
path needs it — document why).

## Later (not this wave)

- Modular/dynamic layout: drag over a region of a free-form grid in the
  picker to define a zone on the fly; zones adapt like a tiling WM.
- Optional keyboard mode (off by default).
- Snap groups (restore a group of snapped windows together).
