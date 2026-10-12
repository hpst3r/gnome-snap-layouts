// SPDX-License-Identifier: AGPL-3.0-or-later
// Applies snaps and keeps the restore-size bookkeeping for snapped windows.

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {restoreRect, rectsClose} from './layouts.js';

/** After a snap, read back the frame the client actually settled on. */
const SETTLE_MS = 500;

export class Tiler {
    /**
     * @param {(...args) => void} log debug logger
     */
    constructor(log) {
        this._log = log;
        // Meta.Window -> {savedSize, snapped, actual, unmanagedId, settleId}
        this._entries = new Map();
    }

    /**
     * Snap a window to a rect now: unmaximize first if needed; windows that
     * cannot be resized are only moved, centred in the rect. Remembers the
     * pre-snap size for restore-on-drag-out.
     *
     * @param {Meta.Window} window
     * @param {{x, y, width, height}} rect target frame (stage px)
     */
    snap(window, rect) {
        if (!window.get_compositor_private())
            return;  // already unmanaged

        const frame = window.get_frame_rect();
        const wasMaximized = window.is_maximized();
        const prev = this._entries.get(window);
        const savedSize = prev?.savedSize ??
            (wasMaximized ? null : {width: frame.width, height: frame.height});
        this.forget(window);

        if (wasMaximized)
            window.unmaximize();

        if (!window.allows_resize()) {
            const x = Math.round(rect.x + (rect.width - frame.width) / 2);
            const y = Math.round(rect.y + (rect.height - frame.height) / 2);
            this._log('move (not resizable)', window.get_id(), x, y);
            window.move_frame(true, x, y);
            return;
        }

        this._log('snap', window.get_id(), JSON.stringify(rect), 'saved', JSON.stringify(savedSize));
        window.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
        if (!savedSize)
            return;

        const entry = {savedSize, snapped: {...rect}, actual: null, unmanagedId: 0, settleId: 0};
        entry.unmanagedId = window.connect('unmanaged', () => this.forget(window));
        // Clients with size constraints may settle on a slightly different
        // frame; remember that too so the drag-out check still matches.
        entry.settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
            entry.settleId = 0;
            const f = window.get_frame_rect();
            entry.actual = {x: f.x, y: f.y, width: f.width, height: f.height};
            return GLib.SOURCE_REMOVE;
        });
        this._entries.set(window, entry);
    }

    /**
     * Called at the start of every pointer move grab. Forgets windows that
     * were resized by other means; restores the pre-snap size of windows
     * still at their snapped rect when `restore` is on.
     *
     * @param {Meta.Window} window
     * @param {boolean} restore restore-size-on-drag setting
     */
    onMoveBegin(window, restore) {
        const entry = this._entries.get(window);
        if (!entry)
            return;
        const frame = window.get_frame_rect();
        const atSnap = rectsClose(frame, entry.snapped) || rectsClose(frame, entry.actual);
        if (!atSnap) {
            this._log('forget (moved/resized elsewhere)', window.get_id());
            this.forget(window);
            return;
        }
        if (!restore)
            return;

        const [px, py] = global.get_pointer();
        const workArea = Main.layoutManager.getWorkAreaForMonitor(window.get_monitor());
        const r = restoreRect(frame, entry.savedSize, px, py, workArea);
        this.forget(window);
        this._log('restore', window.get_id(), JSON.stringify(r));
        window.move_resize_frame(true, r.x, r.y, r.width, r.height);
    }

    /**
     * Drop the restore bookkeeping of a window.
     *
     * @param {Meta.Window} window
     */
    forget(window) {
        const entry = this._entries.get(window);
        if (!entry)
            return;
        this._entries.delete(window);
        window.disconnect(entry.unmanagedId);
        if (entry.settleId)
            GLib.source_remove(entry.settleId);
    }

    /** Forget every window and remove every source. */
    destroy() {
        for (const window of [...this._entries.keys()])
            this.forget(window);
    }
}
