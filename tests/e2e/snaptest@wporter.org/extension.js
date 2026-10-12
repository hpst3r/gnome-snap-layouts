// SPDX-License-Identifier: AGPL-3.0-or-later
//
// TEST-ONLY helper extension for the snap-layouts E2E harness. It is loaded
// exclusively into the isolated headless shell started by scripts/e2e.sh and
// is never packaged. It exports org.wporter.SnapTest on the (private) session
// bus so the Python driver can inspect windows/actors and inject real pointer
// and keyboard input through Clutter virtual devices.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const BUS_NAME = 'org.wporter.SnapTest';
const OBJECT_PATH = '/org/wporter/SnapTest';

const IFACE_XML = `
<node>
  <interface name="org.wporter.SnapTest">
    <method name="Status"><arg type="s" direction="out"/></method>
    <method name="ListWindows"><arg type="s" direction="out"/></method>
    <method name="GetMonitors"><arg type="s" direction="out"/></method>
    <method name="FindActors">
      <arg name="prefix" type="s" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="GetPointer"><arg type="s" direction="out"/></method>
    <method name="PointerMove">
      <arg name="x" type="d" direction="in"/>
      <arg name="y" type="d" direction="in"/>
    </method>
    <method name="PointerButton">
      <arg name="button" type="u" direction="in"/>
      <arg name="pressed" type="b" direction="in"/>
    </method>
    <method name="Key">
      <arg name="keyval" type="u" direction="in"/>
      <arg name="pressed" type="b" direction="in"/>
    </method>
    <method name="Screenshot">
      <arg name="path" type="s" direction="in"/>
      <arg type="b" direction="out"/>
    </method>
    <method name="HideOverview"/>
    <method name="ActivateWindow">
      <arg name="id" type="t" direction="in"/>
      <arg type="b" direction="out"/>
    </method>
    <method name="MoveResize">
      <arg name="id" type="t" direction="in"/>
      <arg name="x" type="i" direction="in"/>
      <arg name="y" type="i" direction="in"/>
      <arg name="width" type="i" direction="in"/>
      <arg name="height" type="i" direction="in"/>
      <arg type="b" direction="out"/>
    </method>
    <method name="Log">
      <arg name="message" type="s" direction="in"/>
    </method>
    <method name="LaunchApp">
      <arg name="desktop_id" type="s" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
  </interface>
</node>`;

/**
 * @param {Mtk.Rectangle|object} r rectangle-like object
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function rectToJson(r) {
    return {x: r.x, y: r.y, width: r.width, height: r.height};
}

/**
 * @param {number|bigint} id window id as received over D-Bus
 * @returns {Meta.Window|null}
 */
function findWindow(id) {
    const wanted = String(id);
    for (const actor of global.get_window_actors()) {
        const win = actor.meta_window;
        if (win && String(win.get_id()) === wanted)
            return win;
    }
    return null;
}

/**
 * Depth-first walk of an actor tree.
 *
 * @param {Clutter.Actor} actor root
 * @param {(a: Clutter.Actor) => void} fn visitor
 */
function walk(actor, fn) {
    fn(actor);
    for (const child of actor.get_children())
        walk(child, fn);
}

class SnapTestService {
    constructor(uuid) {
        this._uuid = uuid;
        const seat = Clutter.get_default_backend().get_default_seat();
        this._pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE_XML, this);
        this._dbus.export(Gio.DBus.session, OBJECT_PATH);
        this._nameId = Gio.bus_own_name_on_connection(Gio.DBus.session,
            BUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null);
    }

    destroy() {
        if (this._nameId) {
            Gio.bus_unown_name(this._nameId);
            this._nameId = 0;
        }
        this._dbus?.unexport();
        this._dbus = null;
        this._pointer = null;
        this._keyboard = null;
    }

    Status() {
        const extensions = {};
        for (const uuid of Main.extensionManager.getUuids()) {
            const ext = Main.extensionManager.lookup(uuid);
            extensions[uuid] = {state: ext.state, error: ext.error ? String(ext.error) : ''};
        }
        return JSON.stringify({
            startingUp: Boolean(Main.layoutManager._startingUp),
            overviewVisible: Main.overview.visible,
            modalCount: Main.modalCount,
            extensions,
        });
    }

    ListWindows() {
        const windows = global.get_window_actors()
            .map(a => a.meta_window)
            .filter(w => w)
            .map(w => ({
                id: String(w.get_id()),
                title: w.get_title(),
                wm_class: w.get_wm_class(),
                type: w.get_window_type(),
                normal: w.get_window_type() === Meta.WindowType.NORMAL,
                frame: rectToJson(w.get_frame_rect()),
                is_maximized: w.is_maximized(),
                monitor: w.get_monitor(),
                minimized: w.minimized,
                focused: w.has_focus(),
                workspace: w.get_workspace()?.index() ?? -1,
            }));
        return JSON.stringify(windows);
    }

    GetMonitors() {
        const monitors = Main.layoutManager.monitors.map((m, i) => ({
            index: i,
            rect: {x: m.x, y: m.y, width: m.width, height: m.height},
            scale: m.geometry_scale,
            workArea: rectToJson(Main.layoutManager.getWorkAreaForMonitor(i)),
            primary: i === Main.layoutManager.primaryIndex,
        }));
        return JSON.stringify(monitors);
    }

    FindActors(prefix) {
        const found = [];
        walk(global.stage, actor => {
            const name = actor.get_name();
            if (!name || !name.startsWith(prefix))
                return;
            const ext = actor.get_transformed_extents();
            found.push({
                name,
                x: ext.origin.x,
                y: ext.origin.y,
                width: ext.size.width,
                height: ext.size.height,
                visible: actor.visible,
                mapped: actor.mapped,
                opacity: actor.opacity,
                pseudoClass: actor.get_style_pseudo_class?.() ?? null,
            });
        });
        return JSON.stringify(found);
    }

    GetPointer() {
        const [x, y, mods] = global.get_pointer();
        return JSON.stringify({x, y, mods});
    }

    PointerMove(x, y) {
        this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
    }

    PointerButton(button, pressed) {
        this._pointer.notify_button(GLib.get_monotonic_time(), button,
            pressed ? Clutter.ButtonState.PRESSED : Clutter.ButtonState.RELEASED);
    }

    Key(keyval, pressed) {
        this._keyboard.notify_keyval(GLib.get_monotonic_time(), keyval,
            pressed ? Clutter.KeyState.PRESSED : Clutter.KeyState.RELEASED);
    }

    ScreenshotAsync([path], invocation) {
        const file = Gio.File.new_for_path(path);
        let stream;
        try {
            stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
        } catch (e) {
            invocation.return_gerror(e);
            return;
        }
        const shooter = new Shell.Screenshot();
        shooter.screenshot(false, stream, (obj, res) => {
            let ok = false;
            try {
                obj.screenshot_finish(res);
                ok = true;
            } catch (e) {
                console.error(`[snaptest] screenshot failed: ${e.message}`);
            }
            stream.close(null);
            invocation.return_value(new GLib.Variant('(b)', [ok]));
        });
    }

    HideOverview() {
        Main.overview.hide();
    }

    ActivateWindow(id) {
        const win = findWindow(id);
        if (!win)
            return false;
        Main.activateWindow(win);
        return true;
    }

    MoveResize(id, x, y, width, height) {
        const win = findWindow(id);
        if (!win)
            return false;
        if (win.is_maximized())
            win.unmaximize();
        win.move_resize_frame(true, x, y, width, height);
        return true;
    }

    Log(message) {
        console.log(`[snaptest] ${message}`);
    }

    /**
     * Launches an app the way the dash/app grid does (nested-mode checks).
     *
     * @param {string} desktopId e.g. "org.gnome.TextEditor.desktop"
     * @returns {string} JSON {ok, error?, state?}
     */
    LaunchApp(desktopId) {
        const app = Shell.AppSystem.get_default().lookup_app(desktopId);
        if (!app)
            return JSON.stringify({ok: false, error: `no app ${desktopId}`});
        try {
            if (app.can_open_new_window())
                app.open_new_window(-1);
            else
                app.activate();
        } catch (e) {
            return JSON.stringify({ok: false, error: e.message});
        }
        return JSON.stringify({ok: true, state: app.state});
    }
}

export default class SnapTestExtension extends Extension {
    enable() {
        this._service = new SnapTestService(this.uuid);
    }

    disable() {
        this._service?.destroy();
        this._service = null;
    }
}
