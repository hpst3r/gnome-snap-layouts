// SPDX-License-Identifier: AGPL-3.0-or-later
// Watches pointer move grabs, polls the pointer and drives the picker.
// All decisions are made by the pure functions in layouts.js/dragState.js.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    hitTest, inTriggerBand, layoutsForWorkArea, pickerGeometry, pointerInPicker, zoneRect,
} from './layouts.js';
import {initialDragState, stepDragState, PICKER_MARGIN} from './dragState.js';
import {Picker, destroyClosingPickers} from './picker.js';

const POLL_MS = 16;  // ~60 Hz

// MOVING_UNCONSTRAINED is MOVING | WINDOW_FLAG_UNCONSTRAINED; the flag itself
// is not exported by every Mutter version.
const UNCONSTRAINED_FLAG = Meta.GrabOp.WINDOW_FLAG_UNCONSTRAINED ??
    (Meta.GrabOp.MOVING_UNCONSTRAINED & ~Meta.GrabOp.MOVING);

/**
 * Whether a grab op is a pointer (not keyboard) window move.
 *
 * @param {Meta.GrabOp} op
 * @returns {boolean}
 */
export function isPointerMove(op) {
    return (op & ~UNCONSTRAINED_FLAG) === Meta.GrabOp.MOVING;
}

/**
 * Whether a window may be snapped from the picker. Transient windows
 * (dialogs and other children of a parent window) never are.
 *
 * @param {Meta.Window} window
 * @returns {boolean}
 */
export function isEligible(window) {
    return !!window &&
        window.get_window_type() === Meta.WindowType.NORMAL &&
        !window.get_transient_for() &&
        window.allows_move() &&
        !window.is_fullscreen();
}

export class DragWatcher {
    /**
     * @param {object} p
     * @param {() => object} p.getConfig current settings snapshot:
     *   {triggerWidthPct, triggerHeight, showDelay, gap, matchOrientation,
     *   layouts} (all enabled layouts; filtered per monitor here)
     * @param {(window: Meta.Window, op: Meta.GrabOp) => void} p.onGrabBegin
     *   called for every grab begin (before any picker logic)
     * @param {(drop: object) => void} p.onDrop called after a grab ends over
     *   a cell: {window, monitorIndex, workArea, layout, zoneIndex}
     * @param {(...args) => void} p.log debug logger
     */
    constructor({getConfig, onGrabBegin, onDrop, log}) {
        this._getConfig = getConfig;
        this._onGrabBegin = onGrabBegin;
        this._onDrop = onDrop;
        this._log = log;
        this._session = null;
        this._pollId = 0;
        this._signalIds = [
            global.display.connect('grab-op-begin', (_d, window, op) => this._begin(window, op)),
            global.display.connect('grab-op-end', (_d, window) => this._end(window)),
        ];
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed',
            () => this._resetSession());
    }

    _begin(window, op) {
        this._endSession();
        this._onGrabBegin(window, op);
        if (!isPointerMove(op) || !isEligible(window))
            return;

        this._log('drag begin', window.get_id(), op);
        this._session = {
            window,
            state: initialDragState(this._sample(this._getConfig())?.inBand),
            picker: null,
            geometry: null,
            layouts: [],
            workArea: null,
            monitorIndex: -1,
            hit: null,
        };
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _end(window) {
        const s = this._session;
        if (!s || s.window !== window)
            return;
        // Sample the release position once more before deciding.
        this._tick();
        const hit = s.hit;
        const drop = hit ? {
            window,
            monitorIndex: s.monitorIndex,
            workArea: s.workArea,
            layout: s.layouts[hit.layoutIndex],
            zoneIndex: hit.zoneIndex,
        } : null;
        this._endSession();
        this._log('drag end', window.get_id(), hit ? `${hit.layoutId}:${hit.zoneIndex}` : 'no zone');
        if (drop)
            this._onDrop(drop);
    }

    /**
     * Pointer position and whether it is in the trigger band of the monitor
     * under it; null while no monitor is known.
     *
     * @param {object} cfg settings snapshot
     * @returns {?{px: number, py: number, monitorIndex: number, inBand: boolean}}
     */
    _sample(cfg) {
        const [px, py] = global.get_pointer();
        const monitorIndex = global.display.get_current_monitor();
        const monitor = Main.layoutManager.monitors[monitorIndex];
        if (!monitor)
            return null;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
        const inBand = inTriggerBand(monitor, workArea, px, py, cfg);
        return {px, py, monitorIndex, inBand};
    }

    _tick() {
        const s = this._session;
        if (!s)
            return;
        const cfg = this._getConfig();
        const sample = this._sample(cfg);
        if (!sample)
            return;
        const {px, py, monitorIndex, inBand} = sample;

        const next = stepDragState(s.state, {
            now: GLib.get_monotonic_time() / 1000,
            monitor: monitorIndex,
            inBand,
            inPicker: s.geometry ? pointerInPicker(s.geometry, px, py, PICKER_MARGIN) : false,
            showDelay: cfg.showDelay,
        });
        const wasShown = s.state.phase === 'shown';
        s.state = next;

        if (next.phase === 'shown' && !wasShown)
            this._showPicker(next.monitor, cfg);
        else if (next.phase !== 'shown' && wasShown)
            this._hidePicker();

        if (!s.picker)
            return;
        const hit = hitTest(s.geometry, px, py);
        const same = hit && s.hit && hit.layoutIndex === s.hit.layoutIndex &&
            hit.zoneIndex === s.hit.zoneIndex;
        if (same || (!hit && !s.hit))
            return;
        s.hit = hit;
        const rect = hit
            ? zoneRect(s.workArea, s.layouts[hit.layoutIndex].zones[hit.zoneIndex], cfg.gap)
            : null;
        s.picker.setHover(hit, rect);
    }

    _showPicker(monitorIndex, cfg) {
        const s = this._session;
        const monitor = Main.layoutManager.monitors[monitorIndex];
        if (!monitor)
            return;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
        const wa = {x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height};
        const layouts = layoutsForWorkArea(cfg.layouts, wa, cfg.matchOrientation ?? true);
        if (layouts.length === 0) {
            this._log('no layouts for monitor', monitorIndex);
            return;
        }
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        s.monitorIndex = monitorIndex;
        s.workArea = wa;
        s.layouts = layouts;
        s.geometry = pickerGeometry(monitor, s.workArea, s.layouts,
            {scale, triggerHeight: cfg.triggerHeight});
        s.picker = new Picker(s.geometry, s.layouts, {window: s.window});
        s.hit = null;
        this._log('picker shown on monitor', monitorIndex);
    }

    _hidePicker({animate = true} = {}) {
        const s = this._session;
        s.picker?.destroy({animate});
        s.picker = null;
        s.geometry = null;
        s.hit = null;
        this._log('picker hidden');
    }

    /**
     * Monitor layout changed mid-drag: the picker geometry is stale, so hide
     * it and start over as if the drag had just begun.
     */
    _resetSession() {
        const s = this._session;
        if (!s)
            return;
        if (s.picker)
            this._hidePicker({animate: false});
        s.state = initialDragState(this._sample(this._getConfig())?.inBand);
        s.monitorIndex = -1;
        s.workArea = null;
        s.layouts = [];
        this._log('monitors changed: drag reset');
    }

    _endSession({animate = true} = {}) {
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
        if (!this._session)
            return;
        this._session.picker?.destroy({animate});
        this._session = null;
    }

    /** Disconnect signals, stop polling and destroy the picker. */
    destroy() {
        this._endSession({animate: false});
        destroyClosingPickers();
        for (const id of this._signalIds)
            global.display.disconnect(id);
        this._signalIds = [];
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
    }
}
