// SPDX-License-Identifier: AGPL-3.0-or-later
// Layout picker and drop preview actors. Geometry comes from
// pickerGeometry() in layouts.js; hover is driven by the drag watcher
// (mutter holds the pointer grab during a move, so no St hover events).

import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Pop in/out like GNOME's panel menus (boxpointer.js PopupAnimation.FULL:
// POPUP_ANIMATION_TIME 150 ms, scale 0.96, slide by -arrow-rise = 6 px,
// pivot at the edge it hangs from).
const POP_MS = 150;
const POP_SCALE = 0.96;
const POP_RISE = 6;
// Like mutter's tile preview (windowManager.js WINDOW_ANIMATION_TIME).
const PREVIEW_MS = 250;

// Pickers still playing their pop-out; destroyClosingPickers() ends them.
const closing = new Set();

/** Destroy every picker that is still animating out (used on disable). */
export function destroyClosingPickers() {
    // Empty the set first: stopping the transition runs onStopped, which
    // must not destroy the actor a second time.
    const roots = [...closing];
    closing.clear();
    for (const root of roots) {
        root.remove_all_transitions();
        root.destroy();
    }
}

function popRise() {
    return POP_RISE * St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

export class Picker {
    /**
     * @param {object} geometry from pickerGeometry()
     * @param {object[]} layouts layouts in geometry.thumbs order
     * @param {object} [opts]
     * @param {Meta.Window} [opts.window] the window being dragged
     */
    constructor(geometry, layouts, {window = null} = {}) {
        this._geometry = geometry;
        this._window = window;
        this._cells = new Map();
        this._hoverKey = null;

        this._preview = new St.Widget({
            name: 'snap-layouts-preview',
            style_class: 'snap-layouts-preview',
            visible: false,
            reactive: false,
        });

        const styleClass = Main.getStyleVariant() === 'light'
            ? 'snap-layouts-picker light' : 'snap-layouts-picker';
        this._root = new St.Widget({
            name: 'snap-layouts-picker',
            style_class: styleClass,
            reactive: false,
            x: geometry.x,
            y: geometry.y,
            width: geometry.width,
            height: geometry.height,
            opacity: 0,
            pivot_point: new Graphene.Point({x: 0.5, y: 0}),
            scale_x: POP_SCALE,
            scale_y: POP_SCALE,
            translation_y: -popRise(),
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

        // The preview lives among the windows, restacked below the dragged
        // one on every hover, so it never tints the window being dropped.
        global.window_group.add_child(this._preview);
        Main.layoutManager.uiGroup.add_child(this._root);
        // Slide down from the top bar while growing to full size.
        this._root.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            translation_y: 0,
            duration: POP_MS,
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

        this._stackPreview();
        if (!preview.visible) {
            // Grow out of the dragged window, as mutter's tile preview does.
            const from = this._windowRect(rect) ?? rect;
            preview.remove_all_transitions();
            preview.set_position(from.x, from.y);
            preview.set_size(from.width, from.height);
            preview.opacity = 0;
            preview.show();
        }
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

    _windowActor() {
        const actor = this._window?.get_compositor_private();
        return actor?.get_parent() === global.window_group ? actor : null;
    }

    _stackPreview() {
        const actor = this._windowActor();
        if (actor)
            global.window_group.set_child_below_sibling(this._preview, actor);
        else
            global.window_group.set_child_above_sibling(this._preview, null);
    }

    /**
     * The dragged window's frame clipped to the monitor holding `rect`.
     *
     * @param {{x, y, width, height}} rect zone target rect
     * @returns {?{x, y, width, height}} null without a usable window
     */
    _windowRect(rect) {
        if (!this._windowActor())
            return null;
        const f = this._window.get_frame_rect();
        const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
        const m = Main.layoutManager.monitors.find(mon =>
            cx >= mon.x && cx < mon.x + mon.width &&
            cy >= mon.y && cy < mon.y + mon.height);
        const x1 = Math.max(f.x, m?.x ?? -Infinity);
        const y1 = Math.max(f.y, m?.y ?? -Infinity);
        const x2 = Math.min(f.x + f.width, m ? m.x + m.width : Infinity);
        const y2 = Math.min(f.y + f.height, m ? m.y + m.height : Infinity);
        if (x2 <= x1 || y2 <= y1)
            return null;
        return {x: x1, y: y1, width: x2 - x1, height: y2 - y1};
    }

    /**
     * Remove the picker and preview. Idempotent. The preview goes at once;
     * the picker pops out (reverse of its pop-in) unless `animate` is false.
     * A closing picker loses its actor names, so it is never mistaken for
     * the live one.
     *
     * @param {object} [opts]
     * @param {boolean} [opts.animate=true] play the pop-out
     */
    destroy({animate = true} = {}) {
        const root = this._root;
        const preview = this._preview;
        this._root = null;
        this._preview = null;
        if (preview) {
            preview.remove_all_transitions();
            preview.destroy();
        }
        if (root) {
            root.remove_all_transitions();
            if (animate && root.mapped) {
                root.name = '';
                for (const cell of this._cells.values())
                    cell.name = '';
                closing.add(root);
                root.ease({
                    opacity: 0,
                    scale_x: POP_SCALE,
                    scale_y: POP_SCALE,
                    translation_y: -popRise(),
                    duration: POP_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onStopped: () => {
                        if (closing.delete(root))
                            root.destroy();
                    },
                });
            } else {
                root.destroy();
            }
        }
        this._cells.clear();
    }
}
