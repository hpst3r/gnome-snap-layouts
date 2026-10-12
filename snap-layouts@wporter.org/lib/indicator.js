// SPDX-License-Identifier: AGPL-3.0-or-later
// Seam stub (architect). Owned by worker "indicator"; see docs/SPEC.md Amendment 3.

/** Top bar menu. Constructed only while `show-indicator` is true. */
export class SnapIndicator {
    /**
     * @param {import('resource:///org/gnome/shell/extensions/extension.js').Extension} extension
     * @param {Gio.Settings} settings the extension's settings
     */
    constructor(extension, settings) {
        this._extension = extension;
        this._settings = settings;
    }

    /** Remove from the panel and disconnect everything. Idempotent. */
    destroy() {
        this._extension = null;
        this._settings = null;
    }
}
