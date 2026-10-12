# Brief: review-core — adversarial correctness review

You are on a merged tree where `make check` passes and `make e2e` passes
17/17 scenarios (real pointer drags in a host-isolated headless nested
GNOME Shell 50; see `scripts/e2e.sh`, `tests/e2e/run.py`,
`tests/e2e/snaptest@wporter.org`). Read docs/SPEC.md incl. Amendment 1.
Follow the WORKER.md "Review-worker variant": you are READ-ONLY for
production code (`snap-layouts@wporter.org/**`). You MAY add files:
`tests/review_*_test.js` (unit; skip unless env `SNAP_REVIEW=1`, so default
`make test` stays green) and E2E scenarios in a NEW file
`tests/e2e/review_scenarios.py` that `run.py` loads when `SNAP_REVIEW=1`
(you may make the minimal hook edit in run.py/e2e.sh needed for that, plus
options like extra virtual monitors or scale — `--virtual-monitor` can be
repeated). Each finding must be proven by a test that FAILS now (state the
failure output) or, for things not testable, by precise code citation.
Prioritise real user-visible bugs over style. Commit your tests. Report
findings in `contract_issues` as
`[SEVERITY critical|high|medium|low] path:line — problem — evidence — minimal fix`.
Run `make check` and `make e2e` (default) before finishing to show the
default suites are still green, and `SNAP_REVIEW=1 make e2e` / `SNAP_REVIEW=1 make test` to show your PoCs fail.

Focus (behaviour and lifecycle):
- Drag edge cases: dragging a maximized window (mutter unmaximizes on drag),
  a window already tiled by mutter's edge tiling (super+left / edge drag),
  a window snapped by us then re-snapped to another zone, non-resizable
  windows, windows with min-size larger than the zone (e.g. set a GTK min
  size in the client), dialogs/transients, a window closed mid-drag
  (unmanaged during grab), keyboard move (Alt+F7) must not show the picker.
- Lifecycle: disable while picker is visible mid-drag; disable while assist
  is open (modal must pop); settings changed mid-drag; monitors-changed
  mid-drag; signal/source leaks across 20 enable/disable cycles (count
  connected handlers or GLib sources if observable, or actors).
- Multi-monitor: two virtual monitors side by side (1920x1080 + 1280x1024);
  picker appears on the monitor under the pointer and snaps use that
  monitor's work area; drag across monitors with the picker shown.
- Restore-size: snap → drag out restores; snap → user resizes → drag out
  must NOT restore; snap A then snap A again to another zone keeps the
  ORIGINAL pre-snap size; window unmanaged clears the map.
- Mutter interplay: releasing at the very top edge (y=0) above the picker
  must still maximize via mutter and not also snap; dropping at left screen
  edge while the picker is not shown still does mutter half-tiling.
- GNOME extension review-guideline violations (nothing at import time,
  everything torn down in disable, no sync file IO in hot paths, etc.).
