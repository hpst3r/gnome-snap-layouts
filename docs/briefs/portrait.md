# Brief: portrait — portrait layouts + orientation matching

You are a feature worker (docs/WORKER.md main rules). The tree is the
verified MVP (`make check`, `scripts/e2e.sh` 17/17, review suites green).
Implement your part of docs/SPEC.md **Amendment 3** exactly. Another worker
implements the other part in parallel — never edit its files; report needed
changes under `contract_issues`. Isolation rule (SPEC + Amendment 1) is
absolute: only start gnome-shell through `scripts/e2e.sh`.
Before finishing: `make check`; `scripts/e2e.sh` (default 17 must still
pass, plus your new default scenarios); your new scenarios; and the review
regression suites you might affect (`SNAP_REVIEW=core scripts/e2e.sh`,
`SNAP_REVIEW=ux scripts/e2e.sh`, `SNAP_REVIEW=1 make test`) — run each
review suite once at the end. Take settled screenshots (wait ≥0.4 s) of the
new UI, Read them, judge them, and report the paths. Commit with
conventional commits.

Own: `lib/layouts.js`, `lib/dragWatcher.js`, `prefs.js`,
`tests/layouts_test.js`, new `tests/e2e/scn_portrait.py`. NOT yours:
extension.js (seam done: config has `matchOrientation`), lib/indicator.js,
tests/e2e/scn_indicator.py, schema (keys `match-orientation`, `show-indicator`
already added), Makefile, run.py, e2e.sh.

Prefs: also add a "Show top bar menu" switch bound to `show-indicator`
(General group at the top) — the indicator worker relies on you for that.

Unit tests (extend tests/layouts_test.js): new built-ins validate, counts
2/3/3, exact tiling (no holes/overlaps, integer edges) on portrait work areas
{1920,0,1080,1920}, {0,32,1080,1888}, {0,0,1200,1920}, gap 0 and gap 8;
orientation validation for customs (missing→any, bad value rejected);
workAreaOrientation (square→landscape); layoutsForWorkArea for both
orientations with matchOrientation true/false and `any` customs; portrait
pickerGeometry thumbs respect the 176 cap, cells inside thumbs, hitTest.
Existing U1 expectations for built-in order/counts must be updated, not
deleted.

E2E `tests/e2e/scn_portrait.py` (tags `("portrait",)`; run with
`E2E_EXTRA_MONITOR=1080x1920 scripts/e2e.sh @portrait`; the second monitor
sits right of the 1920x1080 primary and has no top bar — note review-core's
finding that a pointer gliding along y≈0 is stopped at x=1920 by a pressure
barrier, so cross below the top bar first):
- portrait picker on monitor 1 offers exactly the cells of v-halves,
  v-thirds, v-large-two-small (FindActors 'snap-layouts-zone:'), none
  landscape; snap v-thirds:2 and v-large-two-small:2 land on the exact
  SPEC rects (compute independently in Python);
- landscape monitor 0 still offers exactly the 7 landscape layouts;
- match-orientation false → both monitors offer all 10;
- a custom layout without orientation appears on both monitors.
