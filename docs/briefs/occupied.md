# Brief: occupied — Snap Assist skips occupied zones

You are a worker (docs/WORKER.md main rules). The tree is verified
(`make check`, `scripts/e2e.sh` 22/22, portrait pass 6/6, review suites
green). Read docs/SPEC.md incl. Amendments 1–5. Another worker runs in
parallel on other files — never edit its files; report needed changes under
`contract_issues`. Spelling: American ("center", "color"). Before finishing:
`make check`, `scripts/e2e.sh`, your new scenarios, plus
`E2E_EXTRA_MONITOR=1080x1920 scripts/e2e.sh @portrait`,
`SNAP_REVIEW=core scripts/e2e.sh`, `SNAP_REVIEW=ux scripts/e2e.sh` once at
the end. Commit with conventional commits.

Own: `extension.js`, `lib/layouts.js`, `lib/snapAssist.js` (only the
`excludeWindows` seam addition in candidate selection — and
`lib/snapAssistModel.js` selectCandidates if that is where filtering lives),
`prefs.js`, `tests/layouts_test.js`, `tests/snap_assist_model_test.js`, new
`tests/e2e/scn_assist_occupied.py`. NOT yours: scripts/, tests/e2e/run.py,
tests/e2e/snaptest@wporter.org/, Makefile, schema (key
`assist-skip-occupied` already added by the architect).

Implement SPEC Amendment 5 "assist-skip-occupied". Read occupying windows'
frames at drop time (after the snap of the dragged window is applied is not
needed — exclude the dragged window). Unit tests for rectCoverage /
occupiedZoneIndices (exact fit, terminal-grid shortfall within 10%,
half-overlap not occupied, a window larger than the zone, maximized window
covering everything ⇒ not occupying a quarter since ofFrame < 0.9, empty
inputs) and for candidate exclusion.

E2E `tests/e2e/scn_assist_occupied.py` (default tag e.g. `assist`):
- `assist-skip-occupied`: window A snapped to quadrants:1 (dismiss its
  assist with Escape); windows B, C, D open; snap B to quadrants:0 →
  assist zones exclude quadrants:1's rect (assert via the
  `snap-layouts-assist-zone:<i>` actor bounds), A is not offered as a
  thumbnail, C and D are;
- `assist-skip-occupied-off`: same with the setting false → zone quadrants:1
  offered and A is a candidate;
- `assist-all-occupied`: halves:1 occupied by A, snap B to halves:0 → no
  `snap-layouts-assist` appears within 1 s.
Take a settled screenshot of the first, Read it, report its path.
