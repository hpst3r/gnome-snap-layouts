# Worker rules (read first)

You implement ONE slice of a GNOME Shell 50 extension in an isolated git
worktree. Read `docs/SPEC.md` (authoritative) before writing code. The main
repo is also readable at the path given by `--add-dir`.

Hard rules:
- Edit ONLY the files your brief assigns (SPEC "Files and ownership"). Do not
  edit docs/, metadata.json, the schema or the Makefile. If the contract is
  insufficient, work around it in your files and report under `contract_issues`.
- GNOME 45+ ESM only: `import X from 'gi://X'`,
  `resource:///org/gnome/shell/...`. Pure modules (`lib/layouts.js`) import
  nothing from gi/resource so `gjs -m` tests run outside the shell.
- API facts for THIS host (Mutter 18, verified by the architect via
  introspection): `Meta.Window.maximize()`/`unmaximize()` take no args;
  `is_maximized()` exists, `get_maximized()` does not; `set_maximize_flags(f)`
  and `set_unmaximize_flags(f)` exist; `move_resize_frame(user_op, x, y, w, h)`.
  `Meta.GrabOp` has MOVING, MOVING_UNCONSTRAINED, KEYBOARD_MOVING, ...
  Probe other APIs the same way before relying on them:
  `GI_TYPELIB_PATH=/usr/lib64/mutter-18 LD_LIBRARY_PATH=/usr/lib64/mutter-18 gjs -c "imports.gi.versions.Meta='18'; ..."`
  (put such probes in a small script file under `.e2e/` if inline `-c` is blocked).
  GNOME Shell / Mutter JS & API sources for reference: `curl -sL
  https://gitlab.gnome.org/GNOME/gnome-shell/-/raw/50.5/js/ui/<file>.js`
  (mutter: `.../GNOME/mutter/-/raw/50.5/...`); save under `.e2e/ref/`.
  (`gresource` is not installed; the JS is embedded in libshell-18.so.) Do not copy third-party extension code (license).
- Isolation rule in SPEC is absolute: never touch the host GNOME session,
  host dconf/gsettings or host extension dirs.
- Bounded resources: your process tree is capped (MemoryMax); one headless
  shell at a time; kill shells you start by PID.
- Readable code, SPDX header `// SPDX-License-Identifier: AGPL-3.0-or-later`,
  4-space indent, GNOME JS style. JSDoc on exported functions.
- Before finishing: `make check` passes in your worktree. Commit on the current
  branch with conventional commits (`feat(ext): ...`). Do not push or merge.

Final answer: ONLY the JSON object required by the schema. Distinguish
verified facts (commands run + results) from assumptions.

## Review-worker variant
READ-ONLY for production code. Prove each suspected bug with a focused test
(unit test in `tests/review_*_test.js` or an E2E scenario) that FAILS, gated
so the default suite stays green (unit: skip unless `SNAP_REVIEW=1` env var;
E2E: scenario tagged `review`). Report findings in `contract_issues` as
`[SEVERITY critical|high|medium|low] path:line — problem — evidence — minimal fix`.
