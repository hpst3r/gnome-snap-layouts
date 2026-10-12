// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure helpers for Snap Assist (no gi:// or resource:// imports, so they can be
// unit-tested with `gjs -m` outside the shell).

// Logical px at scale 1 (see assistMetrics()).
const ZONE_PADDING = 24;
const SPACING = 16;
const MIN_THUMB = 160;
const MAX_THUMB = 720;
const LABEL_HEIGHT = 28;
const ICON_SIZE = 20;
const LARGE_ICON_SIZE = 32;
const LARGE_ICON_MAX_CANDIDATES = 2;
const MINIMIZED_ICON_MAX = 128;

/**
 * Sizes for the Snap Assist thumbnail grid of one zone, in stage px.
 *
 * Thumbnails may grow up to the zone's inner width or 720 logical px,
 * whichever is smaller, and only scroll below 160 logical px. With one or two
 * candidates the app icon is larger and the title row grows to fit it.
 * The result's grid options can be passed straight to gridForZone().
 *
 * @param {{width: number, height: number}} zoneRect zone size in stage px
 * @param {number} n number of candidates
 * @param {number} [scale] theme scale factor
 * @returns {{padding: number, spacing: number, minThumb: number,
 *   maxThumb: number, labelHeight: number, iconSize: number}} iconSize is
 *   logical px (St icon sizes are scaled by the theme), the rest stage px
 */
export function assistMetrics(zoneRect, n, scale = 1) {
    const iconSize = n <= LARGE_ICON_MAX_CANDIDATES ? LARGE_ICON_SIZE : ICON_SIZE;
    const padding = Math.round(ZONE_PADDING * scale);
    const innerW = Math.max(0, Math.floor(zoneRect.width - 2 * padding));
    return {
        padding,
        spacing: Math.round(SPACING * scale),
        minThumb: Math.round(MIN_THUMB * scale),
        maxThumb: Math.min(innerW, Math.round(MAX_THUMB * scale)),
        labelHeight: Math.round((LABEL_HEIGHT + iconSize - ICON_SIZE) * scale),
        iconSize,
    };
}

/**
 * Icon size for a minimized window's thumbnail, which has no live preview.
 *
 * @param {number} previewW preview area width in stage px
 * @param {number} previewH preview area height in stage px
 * @param {number} [scale] theme scale factor
 * @returns {number} logical px: half the preview's smaller side, 16–128
 */
export function minimizedIconSize(previewW, previewH, scale = 1) {
    const half = Math.floor(Math.min(previewW, previewH) / scale / 2);
    return Math.max(16, Math.min(MINIMIZED_ICON_MAX, half));
}

/**
 * Lay out `n` equally sized thumbnails inside a zone.
 *
 * Each grid cell is `thumbW` wide and `cellH = thumbH + labelHeight` tall,
 * where the preview area `thumbW × thumbH` has the requested aspect ratio
 * (width / height). The largest thumbnail width ≤ `maxThumb` for which all
 * `n` cells fit inside the zone (minus `padding` on every side) wins; ties go
 * to fewer columns. The grid is centered in the zone.
 *
 * Tiny zones: if the best fitting width is below `minThumb`, thumbnails keep
 * `minThumb` width (or the zone's inner width if narrower), as many columns as
 * fit are used and the grid is anchored at the top of the zone with
 * `scroll: true`; `contentHeight` then exceeds the inner height and the caller
 * must put the grid in a vertically scrollable viewport of
 * `innerW × innerH` at (`innerX`, `innerY`). Horizontal overflow never happens.
 *
 * @param {{x: number, y: number, width: number, height: number}} zoneRect zone in stage px
 * @param {number} n number of thumbnails (0..∞)
 * @param {object} [opts]
 * @param {number} [opts.aspect] preview width / height (default 16/10)
 * @param {number} [opts.minThumb] smallest preview width before scrolling (default 96)
 * @param {number} [opts.maxThumb] largest preview width (default 320)
 * @param {number} [opts.spacing] gap between cells (default 12)
 * @param {number} [opts.padding] inset from the zone edges (default 0)
 * @param {number} [opts.labelHeight] extra cell height for the title row (default 0)
 * @returns {{cols: number, rows: number, thumbW: number, thumbH: number,
 *   cellH: number, x0: number, y0: number, contentWidth: number,
 *   contentHeight: number, innerX: number, innerY: number, innerW: number,
 *   innerH: number, scroll: boolean}} integer px; (x0, y0) is the top-left of
 *   the first cell in the same coordinate space as `zoneRect`; cell (c, r) is
 *   at `x0 + c * (thumbW + spacing)`, `y0 + r * (cellH + spacing)`.
 */
export function gridForZone(zoneRect, n, opts = {}) {
    const {
        aspect = 16 / 10,
        minThumb = 96,
        maxThumb = 320,
        spacing = 12,
        padding = 0,
        labelHeight = 0,
    } = opts;

    const innerX = Math.round(zoneRect.x + padding);
    const innerY = Math.round(zoneRect.y + padding);
    const innerW = Math.max(0, Math.floor(zoneRect.width - 2 * padding));
    const innerH = Math.max(0, Math.floor(zoneRect.height - 2 * padding));
    const inner = {innerX, innerY, innerW, innerH};

    if (n <= 0 || innerW <= 0) {
        return {
            cols: 0, rows: 0, thumbW: 0, thumbH: 0, cellH: 0,
            x0: innerX + Math.floor(innerW / 2), y0: innerY + Math.floor(innerH / 2),
            contentWidth: 0, contentHeight: 0, ...inner, scroll: false,
        };
    }

    // Widest preview that lets all n cells fit, over every column count.
    // Ties (e.g. everything capped at maxThumb) go to the grid whose shape
    // is closest to the zone's.
    const zoneShape = Math.log(Math.max(1, innerW) / Math.max(1, innerH));
    const shapeMismatch = (cols, w) => {
        const rows = Math.ceil(n / cols);
        const contentW = cols * w + (cols - 1) * spacing;
        const contentH = rows * (w / aspect + labelHeight) + (rows - 1) * spacing;
        return Math.abs(Math.log(contentW / contentH) - zoneShape);
    };
    let best = {cols: 1, w: -Infinity};
    for (let cols = 1; cols <= n; cols++) {
        const rows = Math.ceil(n / cols);
        const byWidth = (innerW - (cols - 1) * spacing) / cols;
        const cellHMax = (innerH - (rows - 1) * spacing) / rows;
        const byHeight = (cellHMax - labelHeight) * aspect;
        const w = Math.floor(Math.min(byWidth, byHeight, maxThumb));
        if (w > best.w || (w === best.w && w > 0 &&
            shapeMismatch(cols, w) < shapeMismatch(best.cols, w)))
            best = {cols, w};
    }

    let cols, thumbW, scroll = false;
    if (best.w >= minThumb) {
        cols = best.cols;
        thumbW = best.w;
    } else {
        thumbW = Math.max(1, Math.min(minThumb, innerW));
        cols = Math.max(1, Math.min(n, Math.floor((innerW + spacing) / (thumbW + spacing))));
    }

    const rows = Math.ceil(n / cols);
    const thumbH = Math.max(1, Math.floor(thumbW / aspect));
    const cellH = thumbH + labelHeight;
    const contentWidth = cols * thumbW + (cols - 1) * spacing;
    const contentHeight = rows * cellH + (rows - 1) * spacing;
    if (contentHeight > innerH)
        scroll = true;

    const x0 = innerX + Math.floor((innerW - contentWidth) / 2);
    const y0 = scroll ? innerY : innerY + Math.floor((innerH - contentHeight) / 2);

    return {
        cols, rows, thumbW, thumbH, cellH, x0, y0,
        contentWidth, contentHeight, ...inner, scroll,
    };
}

/**
 * Scale a `srcW × srcH` box to fit inside `boxW × boxH`, preserving aspect
 * ratio and never upscaling.
 *
 * @param {number} srcW source width
 * @param {number} srcH source height
 * @param {number} boxW available width
 * @param {number} boxH available height
 * @returns {{width: number, height: number}} integer px, at least 1×1
 */
export function fitSize(srcW, srcH, boxW, boxH) {
    if (srcW <= 0 || srcH <= 0)
        return {width: Math.max(1, Math.floor(boxW)), height: Math.max(1, Math.floor(boxH))};
    const scale = Math.min(boxW / srcW, boxH / srcH, 1);
    return {
        width: Math.max(1, Math.round(srcW * scale)),
        height: Math.max(1, Math.round(srcH * scale)),
    };
}

/**
 * Filter an MRU window list down to Snap Assist candidates, keeping order.
 *
 * Duck-typed so it can be tested with fakes: windows need
 * `get_window_type()`, `is_skip_taskbar()`, `get_monitor()` and optionally
 * `get_transient_for()`. Transient windows (dialogs of another window) are
 * left out, matching the picker's eligibility rule. Minimized windows are
 * kept (they are unminimized when picked).
 *
 * @param {object[]} windows most recently used first
 * @param {object} opts
 * @param {number} opts.monitorIndex only windows on this monitor
 * @param {number} opts.normalType value of `Meta.WindowType.NORMAL`
 * @param {Set<object>|object[]} [opts.excluded] windows to leave out
 * @returns {object[]} candidates, most recently used first
 */
export function selectCandidates(windows, {monitorIndex, normalType, excluded = []}) {
    const skip = excluded instanceof Set ? excluded : new Set(excluded);
    const seen = new Set();
    return windows.filter(w => {
        if (!w || skip.has(w) || seen.has(w))
            return false;
        seen.add(w);
        return w.get_window_type() === normalType &&
            !w.is_skip_taskbar() &&
            !w.get_transient_for?.() &&
            w.get_monitor() === monitorIndex;
    });
}

/**
 * Move keyboard focus in a row-major grid.
 *
 * Left/right wrap across rows; up/down stay in the column and clamp at the
 * first/last row (moving down into a short last row lands on its last cell).
 *
 * @param {number} index current index (−1 = nothing focused yet)
 * @param {'left'|'right'|'up'|'down'|'home'|'end'} direction
 * @param {number} cols grid columns (≥ 1)
 * @param {number} n number of cells
 * @returns {number} new index in [0, n), or −1 when n is 0
 */
export function navigateIndex(index, direction, cols, n) {
    if (n <= 0)
        return -1;
    cols = Math.max(1, cols);
    if (index < 0 || index >= n)
        return direction === 'end' ? n - 1 : 0;

    switch (direction) {
    case 'left':
        return Math.max(0, index - 1);
    case 'right':
        return Math.min(n - 1, index + 1);
    case 'up':
        return index - cols >= 0 ? index - cols : index;
    case 'down': {
        if (index + cols < n)
            return index + cols;
        const lastRow = Math.floor((n - 1) / cols);
        return Math.floor(index / cols) < lastRow ? n - 1 : index;
    }
    case 'home':
        return 0;
    case 'end':
        return n - 1;
    default:
        return index;
    }
}
