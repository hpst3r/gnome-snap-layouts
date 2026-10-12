# Brief: fix-core

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

Own: `extension.js`, `lib/dragWatcher.js`, `lib/dragState.js`,
`lib/tiler.js`, `lib/layouts.js`, `tests/layouts_test.js`,
`tests/review_ux_test.js` (only to adapt band-vs-cells to the Amendment 2
picker position if needed), `tests/e2e/review_core_scenarios.py` (only per
the PoC rule above). NOT yours: picker.js, snapAssist*.js, prefs.js,
stylesheets, schema.

Findings to fix (from review-core / review-ux):
1. [high] tiler.js snap(): windows half-tiled by mutter (Super+Left/Right or
   edge drag; `get_maximize_flags() !== 0` / tile mode) are not untiled, so
   mutter's constraint overrides move_resize_frame. Untile/unmaximize
   (set_unmaximize_flags(BOTH) + unmaximize(); verify it clears tile mode in
   mutter 50.5 source `src/core/window.c`) before placing; savedSize must be
   the pre-tile/pre-maximize normal size. PoC: review-assist-tiled-candidate.
2. [medium] maximized window snapped via Snap Assist keeps no restore entry;
   take savedSize from the unmaximized frame (or the window's saved
   unmaximized rect) so drag-out restores it. PoC:
   review-assist-maximized-candidate.
3. [medium] 500 ms settle timer accepts a user resize/move made within 500 ms
   as the snapped rect → wrongly restored later. Record the settled rect only
   from the client's response to OUR move_resize (e.g. first size-changed
   after the snap, only if position still equals the snapped origin), cancel
   on any grab/other resize. PoC: review-resize-then-dragout-no-restore (and
   review-resize-late-then-dragout-no-restore must still pass).
4. [low] dragWatcher isEligible(): exclude `window.get_transient_for()`.
   PoC: review-transient-no-picker.
5. [low] monitors-changed during a drag: reset the drag session to idle and
   hide the picker (connect Main.layoutManager 'monitors-changed'; disconnect
   on destroy).
6. [low] extension.js: keep the Snap Assist handle until disable and always
   call its idempotent destroy() in disable(), even after onClosed (fading
   root otherwise outlives disable).
7. [high/medium, UX] Trigger per Amendment 2: new default trigger-height 8
   (architect already changed the schema); picker top = band bottom + 8
   (`pickerGeometry(..., {scale, triggerHeight})`, scale-aware), so no cell is
   reachable from inside the band for ANY trigger-height; a drag that BEGINS
   with the pointer inside the band does not arm until the pointer has left
   the band once (dragState). PoCs: review-trigger-horizontal-drag,
   review-trigger-accidental-snap (ux module), band-vs-cells (unit). Update
   tests/layouts_test.js U6 for the new geometry.
