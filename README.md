# gnome-snap-layouts

Windows 11–style snap layouts for GNOME Shell 50. Drag a window towards the
top center of a monitor, a layout picker drops down, release over a zone.

Status: in development. See `docs/SPEC.md`.

```
make test     # unit tests (gjs)
make check    # + syntax and schema checks
make pack     # build/snap-layouts@wporter.org.shell-extension.zip
make e2e      # headless nested gnome-shell, real pointer drags
make nested   # isolated nested gnome-shell in a window (mutter-devkit); apps:
              #   scripts/nested.sh --run gnome-text-editor --standalone
make install  # symlink into ~/.local/share/gnome-shell/extensions (re-login on Wayland)
```

License: AGPL-3.0-or-later.
