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
2. **Picker.** A translucent rounded panel, horizontally centred on the
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
   after the grab ends. If `!window.allows_resize()`, only move it centred in
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
| `trigger-width` | i | 40 | 10–100 (% of monitor width, centred) |
| `trigger-height` | i | 48 | 8–200 (px below work-area top) |
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
| `quarter-half-quarter` | Centre focus | ¼ \| ½ \| ¼ |

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

## Later (not this wave)

- Modular/dynamic layout: drag over a region of a free-form grid in the
  picker to define a zone on the fly; zones adapt like a tiling WM.
- Optional keyboard mode (off by default).
- Snap groups (restore a group of snapped windows together).
