# Brief: indicator — optional top bar menu

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

Own: `lib/indicator.js` (replace the stub; keep the constructor/destroy
signature), `stylesheet.css` only if needed (append a block), new
`tests/e2e/scn_indicator.py`. NOT yours: extension.js (seam done: creates and
destroys SnapIndicator on `changed::show-indicator`), prefs.js (the portrait
worker adds the "Show top bar menu" switch), layouts.js, dragWatcher.js,
schema, Makefile, run.py, e2e.sh.

Use GNOME 50.5 sources for PanelMenu.Button / PopupSwitchMenuItem /
addToStatusArea / Extension.openPreferences (fetch per WORKER.md). Bind the
switches to settings in both directions without feedback loops; destroy()
must disconnect everything and remove the button from the panel
(`button.destroy()` is enough for addToStatusArea buttons — verify).

E2E `tests/e2e/scn_indicator.py` (default tags, e.g. `("indicator",)`):
- `indicator-present`: actor `snap-layouts-indicator` visible in the panel by
  default;
- `indicator-toggle`: setting show-indicator false (private gsettings, as the
  harness does for other keys) removes it within 1 s; true restores it; no
  errors logged; repeat 5×, no duplicate actors;
- `indicator-switches`: click the indicator, click the Snap Assist item →
  `snap-assist` reads false; external change back to true updates the
  switch state (inspect the item's `state`/`checked` via FindActors output
  or extend only your own scenario helpers); close the menu with Escape;
- `indicator-settings`: click "Settings…" → a preferences window for the
  extension appears (ListWindows; review_ux_scenarios.py
  `review-prefs-open` shows how prefs were opened in this harness — the
  isolated session bus may need the org.gnome.Shell.Extensions service to
  be activatable; if openPreferences cannot work inside the isolated
  harness, prove the call is made (e.g. debug log line) and report it
  precisely instead of weakening isolation);
- `indicator-disable`: disable the extension (as disable-cleans-up does) →
  no `snap-layouts-indicator` actor remains.
