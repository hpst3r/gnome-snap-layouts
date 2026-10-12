// SPDX-License-Identifier: AGPL-3.0-or-later
// Snap Assist: after a picker snap, offer the other windows of the workspace
// as thumbnails to fill the remaining zones one by one (docs/SPEC.md §6 and
// "Seam: Snap Assist").

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

import {
    assistMetrics, fitSize, gridForZone, minimizedIconSize, navigateIndex, selectCandidates,
} from './snapAssistModel.js';

// Logical px; multiplied by the theme scale factor. THUMB_PADDING must match
// the padding of .snap-layouts-assist-thumb in stylesheet.css. Grid sizes are
// in assistMetrics() (snapAssistModel.js).
const THUMB_PADDING = 6;
const ANIMATION_TIME = 150;

const KEY_DIRECTIONS = new Map([
    [Clutter.KEY_Left, 'left'],
    [Clutter.KEY_KP_Left, 'left'],
    [Clutter.KEY_ISO_Left_Tab, 'left'],
    [Clutter.KEY_Right, 'right'],
    [Clutter.KEY_KP_Right, 'right'],
    [Clutter.KEY_Tab, 'right'],
    [Clutter.KEY_Up, 'up'],
    [Clutter.KEY_KP_Up, 'up'],
    [Clutter.KEY_Down, 'down'],
    [Clutter.KEY_KP_Down, 'down'],
    [Clutter.KEY_Home, 'home'],
    [Clutter.KEY_KP_Home, 'home'],
    [Clutter.KEY_End, 'end'],
    [Clutter.KEY_KP_End, 'end'],
]);

const ACTIVATE_KEYS = new Set([
    Clutter.KEY_Return,
    Clutter.KEY_KP_Enter,
    Clutter.KEY_ISO_Enter,
    Clutter.KEY_space,
]);

function animationTime() {
    return St.Settings.get().enable_animations ? ANIMATION_TIME : 0;
}

class SnapAssist {
    constructor(params) {
        this._params = params;
        this._zoneIndex = 0;
        this._placed = new Set([params.window]);
        this._gone = new Set();
        this._closed = false;
        this._signals = [];
        this._windowSignals = new Map();
        this._idleId = 0;
        this._root = null;
        this._rootDestroyId = 0;
        this._fadingRoot = null;
        this._grab = null;
        this._content = null;
        this._scrollView = null;
        this._items = [];
        this._cols = 1;
        this._pressedOutside = false;
    }

    start() {
        const {zones, monitorIndex} = this._params;
        this._monitor = Main.layoutManager.monitors[monitorIndex];
        if (!this._monitor || !zones?.length || this._candidates().length === 0) {
            // Nothing to offer. Close from an idle so the caller has the
            // handle before onClosed runs.
            this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._idleId = 0;
                this._close(false);
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        this._buildRoot();
        this._connectSignals();
        this._rebuild();
        if (this._closed)
            return;

        const duration = animationTime();
        if (duration > 0) {
            this._root.opacity = 0;
            this._root.ease({
                opacity: 255,
                duration,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    destroy() {
        this._close(false);
        if (this._fadingRoot) {
            this._fadingRoot.remove_all_transitions();
            this._fadingRoot.destroy();
            this._fadingRoot = null;
        }
    }

    _buildRoot() {
        const {x, y, width, height} = this._monitor;
        this._root = new St.Widget({
            name: 'snap-layouts-assist',
            style_class: Main.getStyleVariant() === 'light'
                ? 'snap-layouts-assist light' : 'snap-layouts-assist',
            reactive: true,
            x, y, width, height,
        });
        // A click that starts and ends outside the thumbnails (on the
        // backdrop, a panel, or the root itself, e.g. on another monitor
        // while the grab is held) dismisses the assist. St.Button clicks are
        // recognized by a press gesture, so their events still bubble here
        // and must be told apart by target.
        this._root.add_child(new St.Widget({
            style_class: 'snap-layouts-assist-backdrop',
            reactive: true,
            x: 0, y: 0, width, height,
        }));

        this._root.connect('key-press-event', (_a, event) => this._onKeyPress(event));
        this._root.connect('button-press-event', (_a, event) => {
            this._pressedOutside = !this._isOnThumbnail(event);
            return Clutter.EVENT_PROPAGATE;
        });
        this._root.connect('button-release-event', (_a, event) => {
            if (this._pressedOutside && !this._isOnThumbnail(event))
                this._close(true);
            this._pressedOutside = false;
            return Clutter.EVENT_PROPAGATE;
        });
        this._root.connect('touch-event', (_a, event) => {
            const type = event.type();
            if (type === Clutter.EventType.TOUCH_BEGIN) {
                this._pressedOutside = !this._isOnThumbnail(event);
            } else if (type === Clutter.EventType.TOUCH_END) {
                if (this._pressedOutside && !this._isOnThumbnail(event))
                    this._close(true);
                this._pressedOutside = false;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        // Connected before pushModal so it runs before the modal's own
        // destroy handler and pops the grab exactly once.
        this._rootDestroyId = this._root.connect('destroy', () => {
            this._root = null;
            this._rootDestroyId = 0;
            this._close(false);
        });

        Main.layoutManager.uiGroup.add_child(this._root);
        this._grab = Main.pushModal(this._root);
    }

    _isOnThumbnail(event) {
        const target = global.stage.get_event_actor(event);
        return !!target && this._items.some(i => i.button.contains(target));
    }

    _connectSignals() {
        const connect = (obj, signal, handler) =>
            this._signals.push([obj, obj.connect(signal, handler)]);

        connect(Main.overview, 'showing', () => this._close(false));
        connect(global.workspace_manager, 'active-workspace-changed', () => this._close(false));
        connect(Main.layoutManager, 'monitors-changed', () => this._close(false));
        connect(global.display, 'grab-op-begin', () => this._close(false));
        connect(global.display, 'notify::focus-window', () => {
            const win = global.display.focus_window;
            if (win && !this._placed.has(win) && !this._items.some(i => i.win === win))
                this._close(true);
        });
    }

    _candidates() {
        const workspace = global.workspace_manager.get_active_workspace();
        const windows = global.display.get_tab_list(Meta.TabList.NORMAL, workspace);
        return selectCandidates(windows, {
            monitorIndex: this._params.monitorIndex,
            normalType: Meta.WindowType.NORMAL,
            excluded: new Set([...this._placed, ...this._gone]),
        });
    }

    _watchWindow(win) {
        if (this._windowSignals.has(win))
            return;
        this._windowSignals.set(win, win.connect('unmanaging', () => {
            this._gone.add(win);
            this._rebuild();
        }));
    }

    _rebuild() {
        if (this._closed)
            return;

        this._content?.destroy();
        this._content = null;
        this._scrollView = null;
        this._items = [];

        const {zones} = this._params;
        const candidates = this._candidates();
        if (this._zoneIndex >= zones.length || candidates.length === 0) {
            this._close(true);
            return;
        }
        candidates.forEach(win => this._watchWindow(win));

        this._content = new Clutter.Actor();
        this._root.add_child(this._content);
        for (let i = zones.length - 1; i > this._zoneIndex; i--)
            this._content.add_child(this._buildPlaceholder(i));
        this._content.add_child(this._buildActivePanel(this._zoneIndex, candidates));

        this._items[0]?.button.grab_key_focus();
    }

    _localRect(i) {
        const zone = this._params.zones[i];
        return {
            x: zone.x - this._monitor.x,
            y: zone.y - this._monitor.y,
            width: zone.width,
            height: zone.height,
        };
    }

    _buildPlaceholder(i) {
        const {x, y, width, height} = this._localRect(i);
        return new St.Widget({
            name: `snap-layouts-assist-zone:${i}`,
            style_class: 'snap-layouts-assist-zone placeholder',
            x, y, width, height,
        });
    }

    _buildActivePanel(i, candidates) {
        const rect = this._localRect(i);
        const panel = new St.Widget({
            name: `snap-layouts-assist-zone:${i}`,
            style_class: 'snap-layouts-assist-zone active',
            ...rect,
        });

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const {workArea} = this._params;
        const aspect = workArea?.width > 0 && workArea?.height > 0
            ? Math.min(Math.max(workArea.width / workArea.height, 1), 2.4)
            : 16 / 10;
        const metrics = assistMetrics(rect, candidates.length, scale);
        const grid = gridForZone({x: 0, y: 0, width: rect.width, height: rect.height},
            candidates.length, {aspect, ...metrics});
        this._cols = Math.max(1, grid.cols);

        // The grid lives in a vertical scroll view; it only scrolls when the
        // zone is too small for minThumb-sized thumbnails (see gridForZone).
        const offsetY = grid.y0 - grid.innerY;
        const viewport = new St.Viewport({
            layout_manager: new Clutter.FixedLayout(),
            width: grid.innerW,
            height: Math.max(grid.innerH, offsetY + grid.contentHeight),
        });
        this._scrollView = new St.ScrollView({
            style_class: 'snap-layouts-assist-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: grid.scroll ? St.PolicyType.AUTOMATIC : St.PolicyType.NEVER,
            overlay_scrollbars: true,
            x: grid.innerX,
            y: grid.innerY,
            width: grid.innerW,
            height: grid.innerH,
        });
        this._scrollView.set_child(viewport);
        panel.add_child(this._scrollView);

        const {spacing} = metrics;
        candidates.forEach((win, idx) => {
            const col = idx % grid.cols;
            const row = Math.floor(idx / grid.cols);
            const button = this._buildThumbnail(win, grid, metrics, scale);
            button.set_position(
                grid.x0 - grid.innerX + col * (grid.thumbW + spacing),
                offsetY + row * (grid.cellH + spacing));
            viewport.add_child(button);
            this._items.push({win, button});
        });
        return panel;
    }

    _buildThumbnail(win, grid, metrics, scale) {
        const button = new St.Button({
            name: `snap-layouts-assist-window:${win.get_id()}`,
            style_class: 'snap-layouts-assist-thumb',
            can_focus: true,
            reactive: true,
            track_hover: true,
            width: grid.thumbW,
            height: grid.cellH,
        });
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        button.set_child(box);

        const app = Shell.WindowTracker.get_default().get_window_app(win);
        const header = new St.BoxLayout({
            style_class: 'snap-layouts-assist-thumb-header',
            height: metrics.labelHeight - Math.round(THUMB_PADDING * scale),
            x_expand: true,
        });
        header.add_child(this._appIcon(app, metrics.iconSize));
        const label = new St.Label({
            style_class: 'snap-layouts-assist-thumb-title',
            text: win.get_title() || app?.get_name() || '',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        header.add_child(label);
        box.add_child(header);

        const pad = Math.round(THUMB_PADDING * scale);
        const previewW = Math.max(1, grid.thumbW - 2 * pad);
        const previewH = Math.max(1, grid.thumbH - pad);
        const preview = new St.Bin({
            style_class: 'snap-layouts-assist-thumb-preview',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const actor = win.get_compositor_private();
        if (actor && !win.minimized) {
            const [srcW, srcH] = actor.get_size();
            const size = fitSize(srcW, srcH, previewW, previewH);
            preview.set_child(new Clutter.Clone({
                source: actor,
                width: size.width,
                height: size.height,
            }));
        } else {
            // Minimized windows have no painted actor; show a large icon.
            preview.set_child(this._appIcon(app, minimizedIconSize(previewW, previewH, scale)));
        }
        box.add_child(preview);

        button.connect('clicked', () => this._pick(win));
        button.connect('key-focus-in', () => {
            if (this._scrollView)
                ensureActorVisibleInScrollView(this._scrollView, button);
        });
        return button;
    }

    _appIcon(app, size) {
        return app?.create_icon_texture(size) ?? new St.Icon({
            icon_name: 'application-x-executable',
            icon_size: size,
        });
    }

    _onKeyPress(event) {
        const sym = event.get_key_symbol();
        if (sym === Clutter.KEY_Escape) {
            this._close(true);
            return Clutter.EVENT_STOP;
        }

        const index = this._items.findIndex(i => i.button.has_key_focus());
        const direction = KEY_DIRECTIONS.get(sym);
        if (direction) {
            const next = navigateIndex(index, direction, this._cols, this._items.length);
            this._items[next]?.button.grab_key_focus();
            return Clutter.EVENT_STOP;
        }
        // Normally St.Button turns Enter/space into 'clicked' itself; this
        // covers the case where focus was lost to the root.
        if (ACTIVATE_KEYS.has(sym)) {
            const item = this._items[Math.max(0, index)];
            if (item)
                this._pick(item.win);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_STOP;
    }

    _pick(win) {
        if (this._closed || this._zoneIndex >= this._params.zones.length)
            return;
        const zone = this._params.zones[this._zoneIndex];
        this._placed.add(win);
        this._zoneIndex++;

        if (win.minimized)
            win.unminimize();
        try {
            this._params.snapWindow(win, {...zone});
        } catch (e) {
            logError(e, '[snap-layouts] Snap Assist: snapWindow failed');
        }
        Main.activateWindow(win);
        this._rebuild();
    }

    _close(animate) {
        if (this._closed)
            return;
        this._closed = true;

        if (this._idleId) {
            GLib.source_remove(this._idleId);
            this._idleId = 0;
        }
        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        this._signals = [];
        for (const [win, id] of this._windowSignals)
            win.disconnect(id);
        this._windowSignals.clear();

        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }

        const root = this._root;
        this._root = null;
        this._content = null;
        this._scrollView = null;
        this._items = [];
        if (root) {
            root.disconnect(this._rootDestroyId);
            this._rootDestroyId = 0;
            const duration = animate ? animationTime() : 0;
            if (duration > 0) {
                root.reactive = false;
                this._fadingRoot = root;
                root.ease({
                    opacity: 0,
                    duration,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                    onStopped: () => {
                        if (this._fadingRoot === root)
                            this._fadingRoot = null;
                        root.destroy();
                    },
                });
            } else {
                root.destroy();
            }
        }

        try {
            this._params.onClosed?.();
        } catch (e) {
            logError(e, '[snap-layouts] Snap Assist: onClosed failed');
        }
    }
}

/**
 * Show Snap Assist for the zones left over after a picker snap.
 *
 * Candidates are the normal, non-transient, non-skip-taskbar windows on the active
 * workspace and `p.monitorIndex` (minimized ones included), most recently
 * used first, excluding `p.window` and windows already placed. The first
 * remaining zone shows a thumbnail grid; picking a window snaps it there via
 * `p.snapWindow`, activates it and moves on to the next zone. Closes when the
 * zones or candidates run out, or on Escape, a click outside the thumbnails,
 * overview, workspace switch, monitor change, a new grab or focus moving to
 * an unrelated window.
 *
 * If there is nothing to offer, `onClosed` runs from an idle callback (or
 * from `destroy()` if that comes first) rather than synchronously.
 *
 * @param {object} p see docs/SPEC.md "Seam: Snap Assist"
 * @param {Meta.Window} p.window window just snapped (excluded from candidates)
 * @param {number} p.monitorIndex monitor the zones are on
 * @param {{x: number, y: number, width: number, height: number}} p.workArea
 * @param {Array<{x: number, y: number, width: number, height: number}>} p.zones
 *   remaining zones' target rects in stage px
 * @param {(win: Meta.Window, rect: object) => void} p.snapWindow snaps a picked window
 * @param {() => void} p.onClosed called exactly once when the assist closes
 * @returns {{destroy(): void}} idempotent; closes immediately without animation
 */
export function showSnapAssist(p) {
    const assist = new SnapAssist(p);
    assist.start();
    return {destroy: () => assist.destroy()};
}
