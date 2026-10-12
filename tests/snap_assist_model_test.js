// SPDX-License-Identifier: AGPL-3.0-or-later
// Unit tests for lib/snapAssistModel.js. Run: gjs -m tests/snap_assist_model_test.js

import System from 'system';

import {
    assistMetrics, gridForZone, fitSize, minimizedIconSize, selectCandidates, navigateIndex,
} from '../snap-layouts@wporter.org/lib/snapAssistModel.js';

let failures = 0;
let count = 0;

function check(cond, msg) {
    count++;
    if (!cond) {
        failures++;
        printerr(`FAIL: ${msg}`);
    }
}

function cellRects(g, n) {
    const rects = [];
    for (let i = 0; i < n; i++) {
        const c = i % g.cols, r = Math.floor(i / g.cols);
        rects.push({
            x: g.x0 + c * (g.thumbW + 12),
            y: g.y0 + r * (g.cellH + 12),
            width: g.thumbW,
            height: g.cellH,
        });
    }
    return rects;
}

function inside(r, zone) {
    return r.x >= zone.x && r.y >= zone.y &&
        r.x + r.width <= zone.x + zone.width &&
        r.y + r.height <= zone.y + zone.height;
}

// --- gridForZone: fits inside zones of many shapes, n = 0..12 -------------
const zones = [
    {x: 0, y: 32, width: 960, height: 1048},        // half of 1080p
    {x: 960, y: 32, width: 960, height: 524},       // quadrant
    {x: 1280, y: 32, width: 640, height: 1048},     // third
    {x: 100, y: 100, width: 1920, height: 300},     // wide strip
    {x: 3840, y: 0, width: 1280, height: 1440},     // second monitor, HiDPI-ish
];
const opts = {aspect: 16 / 10, minThumb: 96, maxThumb: 320, spacing: 12, padding: 16, labelHeight: 28};
for (const zone of zones) {
    for (let n = 0; n <= 12; n++) {
        const g = gridForZone(zone, n, opts);
        const tag = `zone ${JSON.stringify(zone)} n=${n}`;
        if (n === 0) {
            check(g.cols === 0 && g.rows === 0, `${tag}: empty grid`);
            continue;
        }
        check(g.cols * g.rows >= n, `${tag}: grid has room for all`);
        check(g.cols * (g.rows - 1) < n, `${tag}: no empty last row`);
        check(!g.scroll, `${tag}: normal zone does not scroll`);
        check(g.thumbW >= opts.minThumb && g.thumbW <= opts.maxThumb, `${tag}: width in range (${g.thumbW})`);
        check(Math.abs(g.thumbW / g.thumbH - opts.aspect) < 0.02, `${tag}: aspect kept (${g.thumbW}x${g.thumbH})`);
        check(g.cellH === g.thumbH + opts.labelHeight, `${tag}: cellH includes label`);
        const padded = {
            x: zone.x + opts.padding, y: zone.y + opts.padding,
            width: zone.width - 2 * opts.padding, height: zone.height - 2 * opts.padding,
        };
        for (const r of cellRects(g, n))
            check(inside(r, padded), `${tag}: cell ${JSON.stringify(r)} inside zone`);
        for (const v of [g.cols, g.rows, g.thumbW, g.thumbH, g.x0, g.y0])
            check(Number.isInteger(v), `${tag}: integer output`);
        // Centred: equal margins (±1) on both sides.
        const left = g.x0 - padded.x;
        const right = padded.x + padded.width - (g.x0 + g.contentWidth);
        check(Math.abs(left - right) <= 1, `${tag}: horizontally centred`);
    }
}

// Larger zones never give smaller thumbnails.
{
    const small = gridForZone({x: 0, y: 0, width: 600, height: 600}, 4, opts);
    const big = gridForZone({x: 0, y: 0, width: 1200, height: 1200}, 4, opts);
    check(big.thumbW >= small.thumbW, 'bigger zone → bigger or equal thumbs');
}

// maxThumb caps a single window in a huge zone.
{
    const g = gridForZone({x: 0, y: 0, width: 4000, height: 3000}, 1, opts);
    check(g.thumbW === 320 && g.cols === 1 && g.rows === 1, 'single thumb capped at maxThumb');
}

// Wide strip prefers a single row.
{
    const g = gridForZone({x: 0, y: 0, width: 1920, height: 300}, 4, opts);
    check(g.rows === 1 && g.cols === 4, `wide strip uses one row (${g.cols}x${g.rows})`);
}

// Tie at maxThumb: a wide quadrant lays two windows side by side, a tall
// zone stacks them.
{
    const wide = gridForZone({x: 960, y: 32, width: 960, height: 524}, 2, opts);
    check(wide.cols === 2 && wide.rows === 1 && wide.thumbW === 320, `wide tie → side by side (${wide.cols}x${wide.rows})`);
    const tall = gridForZone({x: 0, y: 0, width: 700, height: 1400}, 2, opts);
    check(tall.cols === 1 && tall.rows === 2 && tall.thumbW === 320, `tall tie → stacked (${tall.cols}x${tall.rows})`);
}

// Tall narrow zone prefers a single column.
{
    const g = gridForZone({x: 0, y: 0, width: 400, height: 1400}, 3, opts);
    check(g.cols === 1 && g.rows === 3, `tall zone uses one column (${g.cols}x${g.rows})`);
}

// --- tiny zones: fall back to minThumb + vertical scroll ------------------
{
    const zone = {x: 10, y: 20, width: 300, height: 200};
    const g = gridForZone(zone, 12, opts);
    check(g.scroll, 'tiny zone with 12 windows scrolls');
    check(g.thumbW === 96, `tiny zone keeps minThumb width (${g.thumbW})`);
    check(g.cols === 2, `tiny zone uses as many columns as fit (${g.cols})`);
    check(g.contentWidth <= g.innerW, 'tiny zone never overflows horizontally');
    check(g.contentHeight > g.innerH, 'tiny zone content taller than viewport');
    check(g.y0 === g.innerY, 'scrolling grid anchored at top');
    check(g.innerX === 26 && g.innerY === 36 && g.innerW === 268 && g.innerH === 168, 'viewport is the padded zone');
}
{
    // Narrower than minThumb: shrink to the zone, one column.
    const g = gridForZone({x: 0, y: 0, width: 80, height: 60}, 3, opts);
    check(g.cols === 1 && g.thumbW === 48 && g.scroll, `sliver zone: 1 column of inner width (${g.thumbW})`);
}
{
    // Degenerate zone (padding eats it): empty grid, no crash.
    const g = gridForZone({x: 0, y: 0, width: 20, height: 20}, 3, opts);
    check(g.cols === 0 && g.thumbW === 0, 'zone smaller than padding gives empty grid');
}
{
    // Defaults work without options.
    const g = gridForZone({x: 0, y: 0, width: 800, height: 600}, 2);
    check(g.cols >= 1 && g.thumbW > 0 && !g.scroll, 'defaults produce a grid');
}

// --- assistMetrics: Windows 11-sized thumbnails --------------------------
{
    // Two candidates in a 960x1048 half zone of a 1920x1080 monitor: each
    // thumbnail takes at least half the zone width (review-assist-thumb-size).
    const zone = {x: 960, y: 32, width: 960, height: 1048};
    const m = assistMetrics(zone, 2);
    check(m.padding === 24 && m.spacing === 16 && m.minThumb === 160, `metrics at scale 1 ${JSON.stringify(m)}`);
    check(m.maxThumb === 720 && m.iconSize === 32, `2 candidates: max 720, large icon ${JSON.stringify(m)}`);
    check(m.labelHeight >= m.iconSize + 6, `title row fits the large icon ${JSON.stringify(m)}`);
    const g = gridForZone(zone, 2, {aspect: 1920 / 1048, ...m});
    check(g.thumbW >= zone.width / 2 && !g.scroll, `half zone, 2 windows: thumbW ${g.thumbW}`);

    const m3 = assistMetrics(zone, 3);
    check(m3.iconSize === 20 && m3.labelHeight === 28, `3+ candidates: small icon ${JSON.stringify(m3)}`);

    // maxThumb never exceeds the inner zone width.
    const narrow = assistMetrics({width: 500, height: 900}, 1);
    check(narrow.maxThumb === 452, `narrow zone caps maxThumb at inner width (${narrow.maxThumb})`);

    // HiDPI: everything scales.
    const m2 = assistMetrics({width: 3840, height: 2096}, 4, 2);
    check(m2.padding === 48 && m2.spacing === 32 && m2.minThumb === 320 &&
        m2.maxThumb === 1440 && m2.labelHeight === 56 && m2.iconSize === 20, `scale 2 ${JSON.stringify(m2)}`);

    // Every built-in zone shape of a 1080p work area: no scrolling up to 6
    // candidates, thumbnails never below minThumb.
    for (const z of zones) {
        for (let n = 1; n <= 6; n++) {
            const mm = assistMetrics(z, n);
            const gg = gridForZone(z, n, {aspect: 1920 / 1048, ...mm});
            const tag = `zone ${z.width}x${z.height} n=${n}`;
            check(gg.thumbW <= mm.maxThumb, `${tag}: ≤ maxThumb (${gg.thumbW})`);
            if (!gg.scroll)
                check(gg.thumbW >= mm.minThumb, `${tag}: ≥ minThumb (${gg.thumbW})`);
        }
    }
    check(!gridForZone(zones[1], 4, {aspect: 1920 / 1048, ...assistMetrics(zones[1], 4)}).scroll,
        'quadrant with 4 windows does not scroll');
}

// --- minimizedIconSize ----------------------------------------------------
{
    check(minimizedIconSize(720, 393) === 128, `big preview → 128 (${minimizedIconSize(720, 393)})`);
    check(minimizedIconSize(160, 87) === 43, `small preview → half (${minimizedIconSize(160, 87)})`);
    check(minimizedIconSize(20, 10) === 16, 'tiny preview → 16');
    check(minimizedIconSize(1440, 786, 2) === 128, 'scale 2 → logical px');
}

// --- fitSize ---------------------------------------------------------------
{
    const s = fitSize(1920, 1080, 320, 200);
    check(s.width === 320 && s.height === 180, `fitSize width-bound ${JSON.stringify(s)}`);
    const t = fitSize(800, 1200, 320, 200);
    check(t.height === 200 && t.width === 133, `fitSize height-bound ${JSON.stringify(t)}`);
    const u = fitSize(100, 50, 320, 200);
    check(u.width === 100 && u.height === 50, 'fitSize never upscales');
    const v = fitSize(0, 0, 50, 40);
    check(v.width === 50 && v.height === 40, 'fitSize with empty source fills box');
}

// --- selectCandidates ----------------------------------------------------------
{
    const NORMAL = 0, DIALOG = 3;
    const mk = (name, {type = NORMAL, skip = false, monitor = 0, transientFor = null} = {}) => ({
        name,
        get_window_type: () => type,
        is_skip_taskbar: () => skip,
        get_monitor: () => monitor,
        get_transient_for: () => transientFor,
    });
    const a = mk('a'), b = mk('b'), c = mk('c', {type: DIALOG}),
        d = mk('d', {skip: true}), e = mk('e', {monitor: 1}), f = mk('f');
    const res = selectCandidates([f, a, b, c, d, e, a, null], {
        monitorIndex: 0, normalType: NORMAL, excluded: new Set([b]),
    });
    check(res.map(w => w.name).join() === 'f,a', `selectCandidates keeps MRU order & filters (${res.map(w => w.name)})`);
    const res2 = selectCandidates([a, e], {monitorIndex: 1, normalType: NORMAL});
    check(res2.length === 1 && res2[0] === e, 'selectCandidates honours monitor');
    const res3 = selectCandidates([a, f], {monitorIndex: 0, normalType: NORMAL, excluded: [a, f]});
    check(res3.length === 0, 'selectCandidates accepts array exclusions');
    // Transient NORMAL windows (e.g. a modal-less child) are not offered.
    const t = mk('t', {transientFor: a});
    const res4 = selectCandidates([t, a], {monitorIndex: 0, normalType: NORMAL});
    check(res4.length === 1 && res4[0] === a, `selectCandidates drops transient windows (${res4.map(w => w.name)})`);
}

// --- navigateIndex ---------------------------------------------------------
{
    // 3 columns, 7 cells:  0 1 2 / 3 4 5 / 6
    check(navigateIndex(-1, 'right', 3, 7) === 0, 'nothing focused → first');
    check(navigateIndex(-1, 'end', 3, 7) === 6, 'nothing focused + End → last');
    check(navigateIndex(0, 'left', 3, 7) === 0, 'left clamps at start');
    check(navigateIndex(2, 'right', 3, 7) === 3, 'right continues to next row');
    check(navigateIndex(6, 'right', 3, 7) === 6, 'right clamps at end');
    check(navigateIndex(4, 'up', 3, 7) === 1, 'up');
    check(navigateIndex(1, 'up', 3, 7) === 1, 'up clamps at first row');
    check(navigateIndex(1, 'down', 3, 7) === 4, 'down');
    check(navigateIndex(5, 'down', 3, 7) === 6, 'down into short last row → last cell');
    check(navigateIndex(6, 'down', 3, 7) === 6, 'down clamps at last row');
    check(navigateIndex(4, 'home', 3, 7) === 0, 'home');
    check(navigateIndex(4, 'end', 3, 7) === 6, 'end');
    check(navigateIndex(0, 'down', 3, 0) === -1, 'empty grid');
}

print(`${count - failures}/${count} checks passed`);
if (failures > 0)
    System.exit(1);
