// SPDX-License-Identifier: AGPL-3.0-or-later
// Snap Layouts: drag a window to the top center of a monitor, drop it onto a
// zone of the layout picker.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    enabledLayouts, occupiedZoneIndices, parseCustomLayouts, zoneRect,
} from './lib/layouts.js';
import {DragWatcher, isPointerMove} from './lib/dragWatcher.js';
import {Tiler} from './lib/tiler.js';
import {showSnapAssist} from './lib/snapAssist.js';
import {SnapIndicator} from './lib/indicator.js';

export default class SnapLayoutsExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._config = null;
        this._settingsId = this._settings.connect('changed', () => {
            this._config = null;
        });
        this._indicator = null;
        this._indicatorId = this._settings.connect('changed::show-indicator',
            () => this._syncIndicator());
        this._syncIndicator();
        this._idleIds = new Set();
        this._assist = null;

        this._tiler = new Tiler(this._log.bind(this));
        this._watcher = new DragWatcher({
            getConfig: () => this._getConfig(),
            onGrabBegin: (window, op) => this._onGrabBegin(window, op),
            onDrop: drop => this._onDrop(drop),
            log: this._log.bind(this),
        });
    }

    disable() {
        if (this._indicatorId)
            this._settings.disconnect(this._indicatorId);
        this._indicatorId = 0;
        this._indicator?.destroy();
        this._indicator = null;
        this._watcher?.destroy();
        this._watcher = null;
        this._closeAssist();
        this._tiler?.destroy();
        this._tiler = null;
        for (const id of this._idleIds ?? [])
            GLib.source_remove(id);
        this._idleIds = null;
        if (this._settingsId)
            this._settings.disconnect(this._settingsId);
        this._settingsId = 0;
        this._settings = null;
        this._config = null;
    }

    /** Create or destroy the top bar menu to match `show-indicator`. */
    _syncIndicator() {
        const want = this._settings.get_boolean('show-indicator');
        if (want && !this._indicator) {
            this._indicator = new SnapIndicator(this, this._settings);
        } else if (!want && this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    _log(...args) {
        if (this._getConfig().debug)
            console.log('[snap-layouts]', ...args);
    }

    /** Settings snapshot, rebuilt lazily after any change. */
    _getConfig() {
        if (this._config)
            return this._config;
        const s = this._settings;
        const {layouts: custom, errors} = parseCustomLayouts(s.get_string('custom-layouts'));
        this._config = {
            triggerWidthPct: s.get_int('trigger-width'),
            triggerHeight: s.get_int('trigger-height'),
            showDelay: s.get_int('show-delay-ms'),
            gap: s.get_int('gap'),
            restore: s.get_boolean('restore-size-on-drag'),
            snapAssist: s.get_boolean('snap-assist'),
            assistSkipOccupied: s.get_boolean('assist-skip-occupied'),
            debug: s.get_boolean('debug'),
            matchOrientation: s.get_boolean('match-orientation'),
            // All enabled layouts; filter per monitor with layoutsForWorkArea().
            layouts: enabledLayouts(s.get_strv('disabled-layouts'), custom),
        };
        if (errors.length > 0)
            this._log('custom-layouts:', errors.join('; '));
        return this._config;
    }

    _onGrabBegin(window, op) {
        this._closeAssist();
        if (!window)
            return;
        this._tiler.onGrabBegin(window);
        if (isPointerMove(op))
            this._tiler.onMoveBegin(window, this._getConfig().restore);
    }

    _onDrop({window, monitorIndex, workArea, layout, zoneIndex}) {
        const cfg = this._getConfig();
        const rect = zoneRect(workArea, layout.zones[zoneIndex], cfg.gap);
        // Mutter finishes its own move after grab-op-end; snap afterwards.
        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._idleIds.delete(id);
            if (!window.get_compositor_private())
                return GLib.SOURCE_REMOVE;
            this._tiler.snap(window, rect);
            if (cfg.snapAssist && layout.zones.length > 1) {
                const rects = layout.zones.map(z => zoneRect(workArea, z, cfg.gap));
                const {occupied, occupants} = cfg.assistSkipOccupied
                    ? this._occupancy(rects, window, monitorIndex)
                    : {occupied: new Set(), occupants: []};
                const zones = rects.filter((_r, i) => i !== zoneIndex && !occupied.has(i));
                this._log('assist: occupied zones', [...occupied].join(',') || 'none');
                if (zones.length > 0) {
                    this._openAssist({
                        window, monitorIndex, workArea, zones,
                        excludeWindows: occupants,
                    });
                }
            }
            return GLib.SOURCE_REMOVE;
        });
        this._idleIds.add(id);
    }

    /**
     * Zones of a layout already filled by other windows (Amendment 5), read
     * from the current frames of the normal, non-transient, non-minimized
     * windows on the active workspace and the monitor, except `dragged`.
     *
     * @param {Array<{x, y, width, height}>} rects the layout's zone rects
     * @param {Meta.Window} dragged the window just snapped
     * @param {number} monitorIndex
     * @returns {{occupied: Set<number>, occupants: Meta.Window[]}} indices
     *   into `rects`, and the windows filling any of them
     */
    _occupancy(rects, dragged, monitorIndex) {
        const workspace = global.workspace_manager.get_active_workspace();
        const occupied = new Set();
        const occupants = [];
        for (const win of global.display.get_tab_list(Meta.TabList.NORMAL, workspace)) {
            if (win === dragged || win.minimized ||
                win.get_window_type() !== Meta.WindowType.NORMAL ||
                win.get_transient_for() || win.get_monitor() !== monitorIndex)
                continue;
            const filled = occupiedZoneIndices(rects, [win.get_frame_rect()]);
            if (filled.size === 0)
                continue;
            occupants.push(win);
            filled.forEach(i => occupied.add(i));
        }
        return {occupied, occupants};
    }

    _openAssist({window, monitorIndex, workArea, zones, excludeWindows}) {
        this._closeAssist();
        // Keep the handle until the next assist, grab or disable even after
        // onClosed: destroy() is idempotent and also ends a closing fade.
        try {
            this._assist = showSnapAssist({
                window,
                monitorIndex,
                workArea,
                zones,
                excludeWindows,
                snapWindow: (win, rect) => this._tiler?.snap(win, rect),
                onClosed: () => {},
            });
        } catch (e) {
            console.error('[snap-layouts] snap assist failed:', e);
        }
    }

    _closeAssist() {
        const assist = this._assist;
        this._assist = null;
        assist?.destroy();
    }
}
