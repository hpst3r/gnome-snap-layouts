// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure layout model: no gi:// or resource:// imports so it runs under plain
// `gjs -m` (unit tests) as well as in the shell and in prefs.

const EPS = 1e-6;
const MAX_ZONES = 12;

/** Base thumbnail width in logical px (before the St scale factor). */
export const THUMB_WIDTH = 112;
/** Space between thumbnails and around the picker edge (logical px). */
export const PICKER_SPACING = 10;
export const PICKER_PADDING = 12;
/** Distance of the picker's top edge below the trigger band (logical px). */
export const PICKER_TOP_OFFSET = 8;
/** Gutter between zone cells inside a thumbnail (logical px). */
export const CELL_GUTTER = 3;
export const MAX_COLUMNS = 4;
/** Longest side of a thumbnail in logical px (caps portrait thumbnails). */
export const THUMB_MAX_SIDE = 176;

/** Valid layout orientations; `any` matches every monitor. */
export const ORIENTATIONS = Object.freeze(['landscape', 'portrait', 'any']);

const freezeLayout = l => Object.freeze({
    id: l.id,
    name: l.name,
    orientation: l.orientation ?? 'any',
    zones: Object.freeze(l.zones.map(z => Object.freeze({...z}))),
});

const LANDSCAPE_LAYOUTS = [
    {
        id: 'halves',
        name: 'Halves',
        zones: [
            {x: 0, y: 0, w: 1 / 2, h: 1},
            {x: 1 / 2, y: 0, w: 1 / 2, h: 1},
        ],
    },
    {
        id: 'two-thirds-left',
        name: 'Two-thirds / third',
        zones: [
            {x: 0, y: 0, w: 2 / 3, h: 1},
            {x: 2 / 3, y: 0, w: 1 / 3, h: 1},
        ],
    },
    {
        id: 'thirds',
        name: 'Thirds',
        zones: [
            {x: 0, y: 0, w: 1 / 3, h: 1},
            {x: 1 / 3, y: 0, w: 1 / 3, h: 1},
            {x: 2 / 3, y: 0, w: 1 / 3, h: 1},
        ],
    },
    {
        id: 'quadrants',
        name: 'Quadrants',
        zones: [
            {x: 0, y: 0, w: 1 / 2, h: 1 / 2},
            {x: 1 / 2, y: 0, w: 1 / 2, h: 1 / 2},
            {x: 0, y: 1 / 2, w: 1 / 2, h: 1 / 2},
            {x: 1 / 2, y: 1 / 2, w: 1 / 2, h: 1 / 2},
        ],
    },
    {
        id: 'half-left-quarters-right',
        name: 'Half + quarters',
        zones: [
            {x: 0, y: 0, w: 1 / 2, h: 1},
            {x: 1 / 2, y: 0, w: 1 / 2, h: 1 / 2},
            {x: 1 / 2, y: 1 / 2, w: 1 / 2, h: 1 / 2},
        ],
    },
    {
        id: 'quarters-left-half-right',
        name: 'Quarters + half',
        zones: [
            {x: 0, y: 0, w: 1 / 2, h: 1 / 2},
            {x: 0, y: 1 / 2, w: 1 / 2, h: 1 / 2},
            {x: 1 / 2, y: 0, w: 1 / 2, h: 1},
        ],
    },
    {
        id: 'quarter-half-quarter',
        name: 'Centre focus',
        zones: [
            {x: 0, y: 0, w: 1 / 4, h: 1},
            {x: 1 / 4, y: 0, w: 1 / 2, h: 1},
            {x: 3 / 4, y: 0, w: 1 / 4, h: 1},
        ],
    },
];

// Zone order is reading order: top to bottom, then left to right.
const PORTRAIT_LAYOUTS = [
    {
        id: 'v-halves',
        name: 'Stacked halves',
        zones: [
            {x: 0, y: 0, w: 1, h: 1 / 2},
            {x: 0, y: 1 / 2, w: 1, h: 1 / 2},
        ],
    },
    {
        id: 'v-thirds',
        name: 'Stacked thirds',
        zones: [
            {x: 0, y: 0, w: 1, h: 1 / 3},
            {x: 0, y: 1 / 3, w: 1, h: 1 / 3},
            {x: 0, y: 2 / 3, w: 1, h: 1 / 3},
        ],
    },
    {
        id: 'v-quarter-half-quarter',
        name: 'Stacked centre focus',
        zones: [
            {x: 0, y: 0, w: 1, h: 1 / 4},
            {x: 0, y: 1 / 4, w: 1, h: 1 / 2},
            {x: 0, y: 3 / 4, w: 1, h: 1 / 4},
        ],
    },
];

export const BUILTIN_LAYOUTS = Object.freeze([
    ...LANDSCAPE_LAYOUTS.map(l => freezeLayout({...l, orientation: 'landscape'})),
    ...PORTRAIT_LAYOUTS.map(l => freezeLayout({...l, orientation: 'portrait'})),
]);

const isNum = v => typeof v === 'number' && Number.isFinite(v);

function overlapArea(a, b) {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Validate a layout object.
 *
 * @param {*} obj candidate `{id, name, orientation, zones: [{x, y, w, h}]}`;
 *   a missing orientation means `any`
 * @returns {{ok: true, layout: object} | {ok: false, error: string}}
 *   on success `layout` is a normalised frozen copy
 */
export function validateLayout(obj) {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj))
        return {ok: false, error: 'layout must be an object'};
    if (typeof obj.id !== 'string' || obj.id.length === 0)
        return {ok: false, error: 'layout id must be a non-empty string'};
    if (obj.name !== undefined && typeof obj.name !== 'string')
        return {ok: false, error: `${obj.id}: name must be a string`};
    if (obj.orientation !== undefined && !ORIENTATIONS.includes(obj.orientation))
        return {ok: false, error: `${obj.id}: orientation must be one of ${ORIENTATIONS.join(', ')}`};
    if (!Array.isArray(obj.zones))
        return {ok: false, error: `${obj.id}: zones must be an array`};
    if (obj.zones.length < 1 || obj.zones.length > MAX_ZONES)
        return {ok: false, error: `${obj.id}: needs 1–${MAX_ZONES} zones, got ${obj.zones.length}`};

    const zones = [];
    for (const [i, z] of obj.zones.entries()) {
        if (z === null || typeof z !== 'object')
            return {ok: false, error: `${obj.id}: zone ${i} must be an object`};
        if (![z.x, z.y, z.w, z.h].every(isNum))
            return {ok: false, error: `${obj.id}: zone ${i} needs numeric x, y, w, h`};
        if (z.x < -EPS || z.y < -EPS || z.w <= EPS || z.h <= EPS ||
            z.x + z.w > 1 + EPS || z.y + z.h > 1 + EPS)
            return {ok: false, error: `${obj.id}: zone ${i} is outside 0..1`};
        zones.push({x: z.x, y: z.y, w: z.w, h: z.h});
    }
    for (let i = 0; i < zones.length; i++) {
        for (let j = i + 1; j < zones.length; j++) {
            if (overlapArea(zones[i], zones[j]) > EPS)
                return {ok: false, error: `${obj.id}: zones ${i} and ${j} overlap`};
        }
    }
    return {
        ok: true,
        layout: freezeLayout({id: obj.id, name: obj.name ?? obj.id, orientation: obj.orientation, zones}),
    };
}

/**
 * Parse the `custom-layouts` setting.
 *
 * Invalid entries are dropped with one error each; a missing id becomes
 * `custom-<index>`; ids colliding with built-ins or earlier customs get
 * `-2`, `-3`, … suffixes.
 *
 * @param {string} jsonText JSON array of layout objects
 * @returns {{layouts: object[], errors: string[]}}
 */
export function parseCustomLayouts(jsonText) {
    let data;
    try {
        data = JSON.parse(jsonText);
    } catch (e) {
        return {layouts: [], errors: [`invalid JSON: ${e.message}`]};
    }
    if (!Array.isArray(data))
        return {layouts: [], errors: ['custom layouts must be a JSON array']};

    const taken = new Set(BUILTIN_LAYOUTS.map(l => l.id));
    const layouts = [];
    const errors = [];
    data.forEach((entry, index) => {
        let candidate = entry;
        if (entry !== null && typeof entry === 'object' && !Array.isArray(entry) &&
            (entry.id === undefined || entry.id === null || entry.id === ''))
            candidate = {...entry, id: `custom-${index}`};
        const res = validateLayout(candidate);
        if (!res.ok) {
            errors.push(`entry ${index}: ${res.error}`);
            return;
        }
        let id = res.layout.id;
        for (let n = 2; taken.has(id); n++)
            id = `${res.layout.id}-${n}`;
        taken.add(id);
        layouts.push(id === res.layout.id ? res.layout : freezeLayout({...res.layout, id}));
    });
    return {layouts, errors};
}

/**
 * Layouts shown in the picker: built-ins minus disabled ones, then customs.
 *
 * @param {string[]} disabledIds built-in ids to hide
 * @param {object[]} customLayouts validated custom layouts
 * @returns {object[]}
 */
export function enabledLayouts(disabledIds, customLayouts) {
    const disabled = new Set(disabledIds ?? []);
    return [...BUILTIN_LAYOUTS.filter(l => !disabled.has(l.id)), ...(customLayouts ?? [])];
}

/**
 * Orientation of a work area: portrait when taller than wide, else
 * landscape (a square counts as landscape).
 *
 * @param {{width: number, height: number}} workArea
 * @returns {'landscape' | 'portrait'}
 */
export function workAreaOrientation(workArea) {
    return workArea.height > workArea.width ? 'portrait' : 'landscape';
}

/**
 * Layouts to offer on a monitor with this work area.
 *
 * @param {object[]} layouts enabled layouts in picker order
 * @param {{width: number, height: number}} workArea
 * @param {boolean} matchOrientation when false every layout is offered
 * @returns {object[]} layouts whose orientation is the work area's or `any`
 *   (order preserved)
 */
export function layoutsForWorkArea(layouts, workArea, matchOrientation) {
    if (!matchOrientation)
        return [...layouts];
    const orientation = workAreaOrientation(workArea);
    return layouts.filter(l => (l.orientation ?? 'any') === 'any' || l.orientation === orientation);
}

/**
 * Integer target rectangle of a zone inside a work area.
 *
 * Edges are rounded on the work-area grid first so adjacent zones share
 * boundaries exactly, then inset by `gap` at work-area edges and by half the
 * gap on interior edges (floor on the leading side, ceil on the trailing side
 * so two neighbours are always exactly `gap` apart).
 *
 * @param {{x: number, y: number, width: number, height: number}} workArea
 * @param {{x: number, y: number, w: number, h: number}} zone fractions
 * @param {number} gap px
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function zoneRect(workArea, zone, gap = 0) {
    gap = Math.max(0, Math.round(gap || 0));
    const lead = Math.ceil(gap / 2);  // inset of a left/top interior edge
    const trail = gap - lead;         // inset of a right/bottom interior edge

    const axis = (origin, size, f, len) => {
        let a = Math.round(origin + f * size);
        let b = Math.round(origin + (f + len) * size);
        a += f <= EPS ? gap : lead;
        b -= f + len >= 1 - EPS ? gap : trail;
        return [a, Math.max(1, b - a)];
    };
    const [x, width] = axis(workArea.x, workArea.width, zone.x, zone.w);
    const [y, height] = axis(workArea.y, workArea.height, zone.y, zone.h);
    return {x, y, width, height};
}

/**
 * Whether the pointer is in the picker trigger band of a monitor.
 *
 * @param {{x, y, width, height}} monitor monitor geometry
 * @param {{x, y, width, height}} workArea the monitor's work area
 * @param {number} px pointer x
 * @param {number} py pointer y
 * @param {{triggerWidthPct: number, triggerHeight: number}} opts
 * @returns {boolean}
 */
export function inTriggerBand(monitor, workArea, px, py, {triggerWidthPct, triggerHeight}) {
    if (px < monitor.x || px >= monitor.x + monitor.width ||
        py < monitor.y || py >= monitor.y + monitor.height)
        return false;
    if (py >= workArea.y + triggerHeight)
        return false;
    const centre = monitor.x + monitor.width / 2;
    return Math.abs(px - centre) <= monitor.width * triggerWidthPct / 100 / 2;
}

/**
 * Absolute stage geometry of the picker and its thumbnails/cells.
 *
 * Thumbnails keep the work-area aspect: `THUMB_WIDTH` wide, unless that
 * would make them taller than `THUMB_MAX_SIDE` (portrait work areas), in
 * which case they are `THUMB_MAX_SIDE` high and narrower (all scaled).
 *
 * @param {{x, y, width, height}} monitor
 * @param {{x, y, width, height}} workArea
 * The top edge sits `PICKER_TOP_OFFSET` (scaled) below the bottom of the
 * trigger band, so no cell is reachable from inside the band.
 *
 * @param {object[]} layouts layouts in picker order
 * @param {{scale?: number, triggerHeight?: number}} [opts] St theme scale
 *   factor; trigger band height below the work-area top (px)
 * @returns {object} see docs/SPEC.md
 */
export function pickerGeometry(monitor, workArea, layouts, {scale = 1, triggerHeight = 0} = {}) {
    const padding = PICKER_PADDING * scale;
    const spacing = PICKER_SPACING * scale;
    let thumbW = THUMB_WIDTH * scale;
    let thumbH = Math.round(thumbW * workArea.height / workArea.width);
    if (thumbH > THUMB_MAX_SIDE * scale) {
        thumbH = THUMB_MAX_SIDE * scale;
        thumbW = Math.round(thumbH * workArea.width / workArea.height);
    }
    const inset = CELL_GUTTER / 2 * scale;

    const n = layouts.length;
    const cols = Math.max(1, Math.min(MAX_COLUMNS, n));
    const rows = Math.max(1, Math.ceil(n / cols));
    const width = 2 * padding + cols * thumbW + (cols - 1) * spacing;
    const height = 2 * padding + rows * thumbH + (rows - 1) * spacing;
    const x = Math.round(monitor.x + (monitor.width - width) / 2);
    const y = workArea.y + Math.max(0, triggerHeight) + PICKER_TOP_OFFSET * scale;

    const thumbs = layouts.map((layout, layoutIndex) => {
        const tx = x + padding + (layoutIndex % cols) * (thumbW + spacing);
        const ty = y + padding + Math.floor(layoutIndex / cols) * (thumbH + spacing);
        // Cells occupy the thumbnail inset by half a gutter, then each cell is
        // inset by another half gutter: 3 px between cells and at the edges.
        const iw = thumbW - 2 * inset;
        const ih = thumbH - 2 * inset;
        const cells = layout.zones.map((z, zoneIndex) => ({
            zoneIndex,
            x: tx + inset + z.x * iw + inset,
            y: ty + inset + z.y * ih + inset,
            width: Math.max(1, z.w * iw - 2 * inset),
            height: Math.max(1, z.h * ih - 2 * inset),
        }));
        return {layoutIndex, layoutId: layout.id, x: tx, y: ty, width: thumbW, height: thumbH, cells};
    });
    return {x, y, width, height, padding, thumbs};
}

const inside = (r, px, py) =>
    px >= r.x && px < r.x + r.width && py >= r.y && py < r.y + r.height;

/**
 * Cell under a point.
 *
 * @param {object} geometry from pickerGeometry
 * @param {number} px
 * @param {number} py
 * @returns {{layoutIndex: number, layoutId: string, zoneIndex: number} | null}
 */
export function hitTest(geometry, px, py) {
    if (!geometry)
        return null;
    for (const thumb of geometry.thumbs) {
        if (!inside(thumb, px, py))
            continue;
        for (const cell of thumb.cells) {
            if (inside(cell, px, py))
                return {layoutIndex: thumb.layoutIndex, layoutId: thumb.layoutId, zoneIndex: cell.zoneIndex};
        }
        return null;
    }
    return null;
}

/**
 * Whether a point is within the picker bounds expanded by `margin`.
 *
 * @param {object} geometry from pickerGeometry
 * @param {number} px
 * @param {number} py
 * @param {number} margin px
 * @returns {boolean}
 */
export function pointerInPicker(geometry, px, py, margin = 0) {
    return px >= geometry.x - margin && px < geometry.x + geometry.width + margin &&
        py >= geometry.y - margin && py < geometry.y + geometry.height + margin;
}

/**
 * Frame for a snapped window being dragged out at its pre-snap size: keeps
 * the pointer at the same relative x across the width and the same offset
 * from the top (clamped into the window), then clamps into the work area.
 *
 * @param {{x, y, width, height}} snappedRect current (snapped) frame
 * @param {{width: number, height: number}} savedSize pre-snap size
 * @param {number} px pointer x
 * @param {number} py pointer y
 * @param {{x, y, width, height}} workArea
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function restoreRect(snappedRect, savedSize, px, py, workArea) {
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const width = Math.round(clamp(savedSize.width, 1, workArea.width));
    const height = Math.round(clamp(savedSize.height, 1, workArea.height));
    const fx = clamp((px - snappedRect.x) / snappedRect.width, 0, 1);
    const dy = clamp(py - snappedRect.y, 0, height - 1);
    const x = Math.round(px - fx * width);
    const y = Math.round(py - dy);
    return {
        x: clamp(x, workArea.x, workArea.x + workArea.width - width),
        y: clamp(y, workArea.y, workArea.y + workArea.height - height),
        width,
        height,
    };
}

/**
 * Whether two rects are equal within `tol` px on every edge.
 *
 * @param {{x, y, width, height}} a
 * @param {{x, y, width, height}} b
 * @param {number} [tol]
 * @returns {boolean}
 */
export function rectsClose(a, b, tol = 2) {
    if (!a || !b)
        return false;
    return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol &&
        Math.abs(a.width - b.width) <= tol && Math.abs(a.height - b.height) <= tol;
}
