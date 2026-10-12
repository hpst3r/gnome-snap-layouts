// SPDX-License-Identifier: AGPL-3.0-or-later
// Layout picker and drop preview actors. Geometry comes from
// pickerGeometry() in layouts.js; hover is driven by the drag watcher
// (mutter holds the pointer grab during a move, so no St hover events).

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const FADE_MS = 120;
const PREVIEW_MS = 120;

export class Picker {
    /**
     * @param {object} geometry from pickerGeometry()
     * @param {object[]} layouts layouts in geometry.thumbs order
     */
    constructor(geometry, layouts) {
        this._geometry = geometry;
        this._cells = new Map();
        this._hoverKey = null;

        this._preview = new St.Widget({
            name: 'snap-layouts-preview',
            style_class: 'snap-layouts-preview',
            visible: false,
            reactive: false,
        });

        this._root = new St.Widget({
            name: 'snap-layouts-picker',
            style_class: 'snap-layouts-picker',
            reactive: false,
            x: geometry.x,
            y: geometry.y,
            width: geometry.width,
            height: geometry.height,
            opacity: 0,
        });

        for (const t of geometry.thumbs) {
            const thumb = new St.Widget({
                style_class: 'snap-layouts-thumb',
                x: t.x - geometry.x,
                y: t.y - geometry.y,
                width: t.width,
                height: t.height,
            });
            thumb.accessible_name = layouts[t.layoutIndex]?.name ?? t.layoutId;
            for (const c of t.cells) {
                const cell = new St.Widget({
                    name: `snap-layouts-zone:${t.layoutId}:${c.zoneIndex}`,
                    style_class: 'snap-layouts-cell',
                    x: c.x - t.x,
                    y: c.y - t.y,
                    width: c.width,
                    height: c.height,
                });
                thumb.add_child(cell);
                this._cells.set(`${t.layoutIndex}:${c.zoneIndex}`, cell);
            }
            this._root.add_child(thumb);
        }

        const uiGroup = Main.layoutManager.uiGroup;
        uiGroup.add_child(this._preview);
        uiGroup.add_child(this._root);
        this._root.ease({
            opacity: 255,
            duration: FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    /**
     * Highlight a cell and move the preview to its target rect.
     *
     * @param {?{layoutIndex: number, zoneIndex: number}} hit hovered cell
     * @param {?{x, y, width, height}} rect zone target rect (stage px)
     */
    setHover(hit, rect) {
        const key = hit ? `${hit.layoutIndex}:${hit.zoneIndex}` : null;
        if (key === this._hoverKey)
            return;
        if (this._hoverKey !== null)
            this._cells.get(this._hoverKey)?.remove_style_pseudo_class('hover');
        this._hoverKey = key;

        const preview = this._preview;
        if (key === null || !rect) {
            preview.remove_all_transitions();
            preview.hide();
            return;
        }
        this._cells.get(key)?.add_style_pseudo_class('hover');

        if (!preview.visible) {
            preview.remove_all_transitions();
            preview.set_position(rect.x, rect.y);
            preview.set_size(rect.width, rect.height);
            preview.opacity = 0;
            preview.show();
            preview.ease({
                opacity: 255,
                duration: PREVIEW_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            preview.ease({
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                opacity: 255,
                duration: PREVIEW_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    /** Destroy picker and preview actors. Idempotent. */
    destroy() {
        for (const actor of [this._root, this._preview]) {
            if (!actor)
                continue;
            actor.remove_all_transitions();
            actor.destroy();
        }
        this._root = null;
        this._preview = null;
        this._cells.clear();
    }
}
