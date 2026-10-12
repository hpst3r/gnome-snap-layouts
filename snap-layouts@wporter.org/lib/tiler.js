// SPDX-License-Identifier: AGPL-3.0-or-later
// Applies snaps and keeps the restore-size bookkeeping for snapped windows.

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {restoreRect, rectsClose} from './layouts.js';

/** How long to wait for a client to apply an unmaximize before snapping. */
const UNMAXIMIZE_TIMEOUT_MS = 300;
/** How long a client may take to answer our move_resize with a frame. */
const SETTLE_TIMEOUT_MS = 1000;

const plainRect = r => ({x: r.x, y: r.y, width: r.width, height: r.height});
const sameOrigin = (a, b, tol = 2) =>
    Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;

export class Tiler {
    /**
     * @param {(...args) => void} log debug logger
     */
    constructor(log) {
        this._log = log;
        // Meta.Window -> {savedSize, snapped, actual, unmanagedId,
        //                 watchIds, timeoutId}
        // `snapped` is null while an unmaximize is pending before the snap.
        this._entries = new Map();
    }

    /**
     * Snap a window to a rect: windows maximized or tiled by mutter are
     * unmaximized first (which also clears mutter's tile mode) and snapped
     * once the client has applied that, so their normal size can be
     * remembered; windows that cannot be resized are only moved, centered in
     * the rect. Remembers the pre-snap size for restore-on-drag-out.
     *
     * @param {Meta.Window} window
     * @param {{x, y, width, height}} rect target frame (stage px)
     */
    snap(window, rect) {
        if (!window.get_compositor_private())
            return;  // already unmanaged

        const keptSize = this._entries.get(window)?.savedSize ?? null;
        this.forget(window);

        if (window.get_maximize_flags() === 0) {
            const frame = window.get_frame_rect();
            this._place(window, rect, keptSize ?? {width: frame.width, height: frame.height});
            return;
        }

        // Mutter's maximize/tile constraints would override move_resize_frame.
        // The normal (unmaximized) size is only known once the client has
        // applied the unmaximize, so place the window after that.
        const before = plainRect(window.get_frame_rect());
        this._log('unmaximize before snap', window.get_id());
        window.unmaximize();
        const entry = this._track(window, {savedSize: keptSize, snapped: null});
        const done = () => {
            if (this._entries.get(window) !== entry)
                return;
            this.forget(window);
            const frame = window.get_frame_rect();
            const normal = window.get_maximize_flags() === 0 && !rectsClose(frame, before, 0)
                ? {width: frame.width, height: frame.height} : null;
            this._place(window, rect, keptSize ?? normal);
        };
        if (!rectsClose(window.get_frame_rect(), before, 0)) {
            done();  // applied synchronously (X11)
            return;
        }
        this._watch(window, entry, ['size-changed', 'position-changed'], done,
            UNMAXIMIZE_TIMEOUT_MS, done);
    }

    /**
     * Move/resize an unmaximized window into a rect and start its restore
     * bookkeeping.
     *
     * @param {Meta.Window} window
     * @param {{x, y, width, height}} rect target frame
     * @param {?{width: number, height: number}} savedSize size to restore
     */
    _place(window, rect, savedSize) {
        const frame = plainRect(window.get_frame_rect());
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

        const entry = this._track(window, {savedSize, snapped: plainRect(rect)});
        // Clients with size constraints may settle on a slightly different
        // frame; remember the client's answer to this move_resize so the
        // drag-out check still matches. Only that answer counts: a later
        // resize (by the user or the app) is not a settled snap.
        const now = window.get_frame_rect();
        if (rectsClose(now, rect))
            return;
        if (sameOrigin(now, rect) &&
            (now.width !== frame.width || now.height !== frame.height)) {
            entry.actual = plainRect(now);  // applied synchronously (X11)
            return;
        }
        const settled = () => {
            const f = window.get_frame_rect();
            if (!sameOrigin(f, rect))
                return;  // not (yet) our configure
            entry.actual = plainRect(f);
            this._unwatch(window, entry);
        };
        this._watch(window, entry, ['size-changed', 'position-changed'], settled,
            SETTLE_TIMEOUT_MS, () => this._unwatch(window, entry));
    }

    /**
     * Register a bookkeeping entry, forgotten when the window is unmanaged.
     *
     * @param {Meta.Window} window
     * @param {object} fields entry fields
     * @returns {object} the entry
     */
    _track(window, fields) {
        const entry = {actual: null, watchIds: [], timeoutId: 0, ...fields};
        entry.unmanagedId = window.connect('unmanaged', () => this.forget(window));
        this._entries.set(window, entry);
        return entry;
    }

    _watch(window, entry, signals, handler, timeoutMs, onTimeout) {
        entry.watchIds = signals.map(sig => window.connect(sig, handler));
        entry.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            entry.timeoutId = 0;
            onTimeout();
            return GLib.SOURCE_REMOVE;
        });
    }

    _unwatch(window, entry) {
        for (const id of entry.watchIds)
            window.disconnect(id);
        entry.watchIds = [];
        if (entry.timeoutId)
            GLib.source_remove(entry.timeoutId);
        entry.timeoutId = 0;
    }

    /**
     * Called at the start of every grab op: whatever the grab does to the
     * window is the user's, not the client settling into its snapped rect.
     * A pending unmaximize-then-snap is abandoned.
     *
     * @param {Meta.Window} window
     */
    onGrabBegin(window) {
        const entry = this._entries.get(window);
        if (!entry)
            return;
        if (!entry.snapped)
            this.forget(window);
        else
            this._unwatch(window, entry);
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
        this._unwatch(window, entry);
    }

    /** Forget every window and remove every source. */
    destroy() {
        for (const window of [...this._entries.keys()])
            this.forget(window);
    }
}
