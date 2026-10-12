# Brief: fix-ux

You are a FIX worker (WORKER.md main rules apply; ignore the review-worker
variant). The tree is the merged MVP plus two review waves' PoCs. Read
docs/SPEC.md including Amendments 1 and 2. Review PoCs live in
`tests/review_ux_test.js` (unit, `SNAP_REVIEW=1 make test`),
`tests/e2e/review_core_scenarios.py` (`SNAP_REVIEW=core scripts/e2e.sh`) and
`tests/e2e/review_ux_scenarios.py` (`SNAP_REVIEW=ux scripts/e2e.sh`); the
default suites are `make check` and `scripts/e2e.sh`. Only run the PoCs
named below plus the default suites (pass scenario names on the command
line, e.g. `SNAP_REVIEW=core scripts/e2e.sh review-transient-no-picker`).
Do NOT weaken or delete PoC assertions; if a PoC asserts a mechanism rather
than the user-visible outcome, or conflicts with Amendment 2, you may
replace it with a stronger outcome check and MUST list it under
`contract_issues`. Add a regression unit test for every pure-logic fix.
Another fix worker edits other files in parallel (see ownership below) —
never touch its files; if you need a change there, report it.
Before finishing: `make check`, `scripts/e2e.sh` (default, all pass) and your
named PoCs (all pass). Commit with conventional commits.

Own: `lib/picker.js`, `lib/snapAssist.js`, `lib/snapAssistModel.js`,
`tests/snap_assist_model_test.js`, `prefs.js`, `stylesheet.css`, new
`stylesheet-dark.css`/`stylesheet-light.css` if you use them (GNOME Shell
47+ loads them per color scheme; verify with 50.5 source
`js/ui/extensionSystem.js`/`extensionUtils` before relying on it; note
`make pack` must include any new stylesheet — report Makefile changes you
need, the architect applies them), `tests/e2e/review_ux_scenarios.py` (only per
the PoC rule). NOT yours: extension.js, dragWatcher.js, dragState.js,
tiler.js, layouts.js.

Seam already committed by the architect: dragWatcher constructs
`new Picker(geometry, layouts, {window})` where `window` is the dragged
Meta.Window.

Findings to fix:
1. [medium] Snap Assist thumbnails too small (MAX_THUMB 320). Adopt: padding
   24, spacing 16, minThumb 160, maxThumb min(innerW, 720) (× scale), label
   row 28, icon 20 (32 when 1–2 candidates); keep gridForZone's widest-fit
   rule; scroll only below minThumb; minimized fallback icon min(128,
   preview/2). Update unit tests. PoC: review-assist-thumb-size (e2e ux) and
   assist-thumb-size (unit).
2. [low] Drop preview tints the dragged window: put the preview in
   `global.window_group` and restack it directly below the dragged window's
   actor on each hover (as mutter's TilePreview in 50.5
   js/ui/windowManager.js does); first appearance grows from the window's
   frame rect to the zone rect (~250 ms, respecting enable_animations), zone
   changes ease between rects. PoC: review-preview-stacking.
3. [low] Picker colours: unhovered cell rgba(255,255,255,0.38) on dark; a
   light variant (picker rgba(250,250,250,0.88), border rgba(0,0,0,0.12),
   cells rgba(0,0,0,0.18)) when color-scheme is light; hover stays the accent
   colour. Check with review-picker-light / review-picker-dark scenarios and
   LOOK at the crops (Read the PNGs).
4. [low] Snap Assist backdrop rgba(0,0,0,0.30); active panel rgba(36,36,36,0.92)
   (light variant analogous).
5. [low] prefs.js: re-sync the custom-layouts TextBuffer on
   'changed::custom-layouts' when the text differs; disconnect on window close.
6. [low] Snap Assist candidates: exclude transient windows
   (`get_transient_for()`), matching the picker's eligibility rule.
Take one settled screenshot each of picker (dark + light) and assist after
your changes, Read them, and report the paths.
