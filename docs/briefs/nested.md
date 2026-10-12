# Brief: nested — isolated interactive `make nested`

Own: `scripts/e2e.sh` (add a nested mode; keep all existing behaviour and
isolation byte-for-byte for the test modes), optional new
`scripts/nested.sh` wrapper, `Makefile` target `nested` (you may edit just
that target and its comment), README "make nested" line.

Problem (verified by the architect): the current `make nested` runs
`make install` (host symlink) and a bare
`dbus-run-session -- gnome-shell --devkit --wayland`. That shares the HOST
dconf database (the user's two runs changed host `~/.config/dconf/user`) and
the HOST system bus (logind/GDM; see SPEC Amendment 1). The user wants the
interactive nested shell isolated exactly like the E2E harness.

Goal: `make nested` (and `E2E_NESTED=1 scripts/e2e.sh` or
`scripts/nested.sh`) opens a VISIBLE devkit nested GNOME Shell window on the
user's desktop where:
- the extension under test is copied from the working tree (not the host
  symlink — do NOT run `make install`), its schema compiled, and it is
  enabled in a PRIVATE dconf; snap-layouts settings at schema defaults (not
  the e2e seeds gap 0/debug true; `debug` true is OK for logs);
- private XDG_CONFIG/DATA/CACHE/STATE/RUNTIME dirs, private session bus
  (dconf-only activation, plus whatever the devkit viewer and the
  org.gnome.Shell.Extensions prefs service need — e.g. allow activating the
  Extensions prefs app so the top bar "Settings…" item works inside the
  nested shell; document exactly what you allow), empty private system bus;
- the snaptest helper extension is NOT enabled; welcome dialog suppressed;
  hot corners default; no driver runs; the script waits until the user
  closes the devkit window / the shell exits, then cleans up (kill buses,
  remove runtime symlinks) and prints the host dconf mtime before/after and
  fails loudly on a change;
- a way to launch test apps inside it: print a ready-to-paste command,
  e.g. `scripts/nested.sh --run gnome-text-editor` or an env file under the
  run dir, that starts a client on the nested Wayland display with the
  private env (GTK4 apps like gnome-text-editor, nautilus, gnome-terminal,
  or tests/e2e/client.py);
- optional `NESTED_MONITORS="1920x1080 1080x1920"` to choose virtual
  monitor(s) if devkit supports `--virtual-monitor` (check `gnome-shell
  --help-all`/mutter source for 50.5 devkit options).

Key unknown to solve: the devkit viewer (`mutter-devkit`, package
mutter-devkit 50.5) must appear on the HOST compositor while the nested
shell lives on the private buses. Read mutter 50.5 source (devkit/ and
src/backends/*devkit*/ or similar; fetch per WORKER.md) to learn how the
viewer is launched and what env it inherits (WAYLAND_DISPLAY of the host —
an absolute socket path like `$HOST_XDG_RUNTIME_DIR/$WAYLAND_DISPLAY` works
for libwayland — and which bus it uses to talk to the nested compositor).
Give the viewer only what it needs from the host (the display socket),
nothing else (no host session/system bus).

Verification you can do without the user: start it, prove the nested shell
and the `mutter-devkit` viewer process are running with the private
DBUS_SESSION_BUS_ADDRESS / DBUS_SYSTEM_BUS_ADDRESS (read
`/proc/<pid>/environ`), that the viewer connected to the host display (its
log / `/proc/<pid>/fd` socket or a visible top-level reported by
`gdbus`-free means — do NOT query the host shell over the host session bus),
that the extension is ACTIVE inside (shell log line with debug, or the
gnome-extensions CLI run with the PRIVATE env), launch a test client with
your printed command, then stop it by killing the nested shell by PID and
confirm cleanup + unchanged host dconf mtime. Keep the window open at most
~30 s per attempt (it appears on the user's desktop). The default test
suites must stay green: `make check`, `scripts/e2e.sh` — run once at the end.

Commit with conventional commits. In `unresolved`, list precisely what only
the user can confirm (e.g. that the window shows and accepts input).
