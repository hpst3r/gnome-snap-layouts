# Brief: nested-apps — make the isolated nested shell usable

You are a worker (docs/WORKER.md main rules). The tree is verified
(`make check`, `scripts/e2e.sh` 22/22, portrait pass 6/6, review suites
green). Read docs/SPEC.md incl. Amendments 1–5. Another worker runs in
parallel on other files — never edit its files; report needed changes under
`contract_issues`. Spelling: American ("center", "color"). Before finishing:
`make check`, `scripts/e2e.sh`, your new scenarios, plus
`E2E_EXTRA_MONITOR=1080x1920 scripts/e2e.sh @portrait`,
`SNAP_REVIEW=core scripts/e2e.sh`, `SNAP_REVIEW=ux scripts/e2e.sh` once at
the end. Commit with conventional commits.

Own: `scripts/e2e.sh` (nested-mode code paths only; test modes must stay
byte-for-byte equivalent in behaviour), `scripts/nested.sh`,
`tests/e2e/snaptest@wporter.org/` (test-only helper; you may add methods),
Makefile `nested` target + README nested lines. NOT yours: everything under
`snap-layouts@wporter.org/`, tests/e2e/run.py and scn_*/review_* files.

User report (live, on their desktop): in `make nested`, NOTHING can be
opened — no GNOME app launches; "D-Bus seems broken". Known cause candidate:
the private session bus only activates dconf + org.gnome.Shell.Extensions
(scripts/e2e.sh ~line 88–104, 208), so DBusActivatable apps
(gnome-text-editor, nautilus, …) and services they need (gvfs, portals,
etc.) cannot start; also check whether GNOME Shell 50's app launching needs
the systemd user manager (org.freedesktop.systemd1 on the session bus) and
what happens without it, and whether apps need the system bus.
Follow SPEC Amendment 5 "Nested shell usability" for what may be relaxed.

Reproduce first, with evidence: start nested mode with a short
`NESTED_TIMEOUT` (the window appears on the user's desktop — keep each
attempt ≤ 60 s), and launch apps THE WAY THE USER DOES — through the
shell: add a helper method (e.g. `LaunchApp(desktop_id)` calling
`Shell.AppSystem.get_default().lookup_app(id).activate()` / `open_new_window`)
and enable the helper in nested mode only under an env flag your
verification uses (`NESTED_HELPER=1`; default `make nested` must not enable
it), then `ListWindows` to see whether a window appeared. Test at least:
org.gnome.TextEditor, org.gnome.Nautilus, org.gnome.Ptyxis (or the installed
terminal), org.gnome.Calculator, org.gnome.Settings, plus
`scripts/nested.sh --run <cmd>`. Capture the failing log lines (shell log,
session bus log) BEFORE fixing; then fix; then show each app opening a
window (ListWindows output) and, via the helper's Screenshot, one PNG with
two apps open — Read it and report the path.
Re-prove isolation after the fix: host `~/.config/dconf/user` mtime
unchanged; no process of the nested run connected to the HOST session bus
(`/proc/<pid>/environ` + `ss -xp` for every process in the run's cgroup or
process tree); state precisely whether the host system bus is used and why.
List in `unresolved` what only the user can confirm.
