#!/usr/bin/python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Minimal GTK 4 test window for the snap-layouts E2E harness.

Opens one titled, resizable window with a normal GtkHeaderBar so that a
press-and-drag on the headerbar makes the client request an
xdg_toplevel.move, i.e. a real compositor move grab. Must be started with
WAYLAND_DISPLAY pointing at the nested headless shell.
"""

import argparse
import os
import sys

import gi

gi.require_version("Gtk", "4.0")
from gi.repository import Gtk  # noqa: E402


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--title", default="snap-e2e")
    parser.add_argument("--width", type=int, default=800)
    parser.add_argument("--height", type=int, default=500)
    args = parser.parse_args()

    app = Gtk.Application(application_id=None)

    def on_activate(application):
        win = Gtk.ApplicationWindow(application=application)
        win.set_title(args.title)
        win.set_default_size(args.width, args.height)
        header = Gtk.HeaderBar()
        win.set_titlebar(header)
        label = Gtk.Label(label=args.title)
        win.set_child(label)
        if os.environ.get("E2E_CLIENT_DEBUG"):
            # Log pointer input reaching the client (harness debugging).
            def log(*parts):
                print(*parts, flush=True, file=sys.stderr)

            click = Gtk.GestureClick()
            click.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
            click.connect("pressed", lambda _g, n, x, y: log("pressed", n, x, y))
            click.connect("released", lambda _g, n, x, y: log("released", n, x, y))
            win.add_controller(click)
            motion = Gtk.EventControllerMotion()
            motion.connect("enter", lambda _c, x, y: log("enter", x, y))
            motion.connect("leave", lambda _c: log("leave"))
            win.add_controller(motion)
        win.present()

    app.connect("activate", on_activate)
    return app.run([sys.argv[0]])


if __name__ == "__main__":
    sys.exit(main())
