# Brief: review-ux — UX, visuals, prefs, HiDPI

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

Focus (what a user sees). Take screenshots via the helper's Screenshot and
LOOK at them (Read the PNG) — judge as a Windows 11 snap-layouts user would.
- Picker: legibility on light and dark wallpapers / light and dark
  `org.gnome.desktop.interface color-scheme` (set in the private dconf);
  hover highlight clarity; picker placement relative to the top bar; whether
  the trigger band (40% width, 48 px) is discoverable but not accidental
  (e.g. a normal drag across the top half of the screen should not pop it).
- Drop preview: visibility, animation, does it look like mutter's tile preview.
- Snap Assist: in the merged run the thumbnails in a 960x1048 half zone are
  ~250 px wide in a single narrow column — assess against Windows 11 (which
  uses large thumbnails filling the zone) and propose concrete sizing rules
  (numbers). Check the zone panel is visibly delineated, titles readable,
  keyboard focus ring visible, minimized-window icon fallback.
- HiDPI: run with a virtual monitor at scale 2 (find how: e.g.
  `org.gnome.desktop.interface scaling-factor` or a monitors.xml in the
  private config, or `--virtual-monitor 3840x2160` + mutter experimental
  features in private dconf) and check sizes/snap rects in logical px.
- Prefs: open the preferences window inside the isolated session (e.g.
  `gnome-extensions prefs snap-layouts@wporter.org` run with the private
  session env, or the org.gnome.Shell.Extensions app), screenshot it, verify
  each control writes the right key (read back with gsettings in the private
  session), custom-layouts JSON Apply with valid and invalid JSON, and that
  the picker reflects disabled/custom layouts on the next drag.
Deliver: findings (with screenshot paths under `.e2e/`) + the concrete
recommended values/designs in `assumptions` or `unresolved`.
