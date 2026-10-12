// SPDX-License-Identifier: AGPL-3.0-or-later
// Unit tests for the pure modules. Run: gjs -m tests/layouts_test.js

import {
    BUILTIN_LAYOUTS, validateLayout, parseCustomLayouts, enabledLayouts,
    zoneRect, inTriggerBand, pickerGeometry, hitTest, pointerInPicker,
    restoreRect, rectsClose, MAX_COLUMNS, workAreaOrientation, layoutsForWorkArea,
    THUMB_MAX_SIDE,
} from '../snap-layouts@wporter.org/lib/layouts.js';
import {
    initialDragState, stepDragState, HIDE_DELAY_MS,
} from '../snap-layouts@wporter.org/lib/dragState.js';

let failures = 0;
let passes = 0;
let current = '';

function assert(cond, msg) {
    if (cond) {
        passes++;
        return;
    }
    failures++;
    print(`FAIL [${current}] ${msg}`);
}

function eq(actual, expected, msg) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    assert(a === e, `${msg}: expected ${e}, got ${a}`);
}

function test(name, fn) {
    current = name;
    try {
        fn();
    } catch (e) {
        failures++;
        print(`FAIL [${name}] threw ${e}\n${e.stack}`);
    }
}

const WORK_AREAS = [
    {x: 0, y: 32, width: 1920, height: 1048},
    {x: 0, y: 27, width: 2560, height: 1413},
    {x: 1920, y: 0, width: 1366, height: 768},
];

const area = r => r.width * r.height;
function intersection(a, b) {
    const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
}
const isInt = r => [r.x, r.y, r.width, r.height].every(Number.isInteger);
const containsRect = (outer, r) => r.x >= outer.x && r.y >= outer.y &&
    r.x + r.width <= outer.x + outer.width && r.y + r.height <= outer.y + outer.height;

test('U1 built-ins validate with expected zone counts', () => {
    const counts = {
        'halves': 2,
        'two-thirds-left': 2,
        'thirds': 3,
        'quadrants': 4,
        'half-left-quarters-right': 3,
        'quarters-left-half-right': 3,
        'quarter-half-quarter': 3,
        'v-halves': 2,
        'v-thirds': 3,
        'v-large-two-small': 3,
    };
    eq(BUILTIN_LAYOUTS.map(l => l.id), Object.keys(counts), 'built-in order');
    eq(BUILTIN_LAYOUTS.map(l => l.orientation),
        [...Array(7).fill('landscape'), ...Array(3).fill('portrait')], 'built-in orientations');
    assert(Object.isFrozen(BUILTIN_LAYOUTS), 'BUILTIN_LAYOUTS frozen');
    for (const l of BUILTIN_LAYOUTS) {
        const res = validateLayout(l);
        assert(res.ok, `${l.id} validates (${res.error})`);
        eq(l.zones.length, counts[l.id], `${l.id} zone count`);
        assert(typeof l.name === 'string' && l.name.length > 0, `${l.id} has a name`);
    }
});

test('U2 gap 0 zones tile the work area exactly', () => {
    for (const wa of WORK_AREAS) {
        for (const l of BUILTIN_LAYOUTS) {
            const rects = l.zones.map(z => zoneRect(wa, z, 0));
            const tag = `${l.id} @ ${JSON.stringify(wa)}`;
            assert(rects.every(isInt), `${tag}: integer edges`);
            assert(rects.every(r => containsRect(wa, r)), `${tag}: inside work area`);
            eq(rects.reduce((s, r) => s + area(r), 0), area(wa), `${tag}: area sum`);
            for (let i = 0; i < rects.length; i++) {
                for (let j = i + 1; j < rects.length; j++)
                    eq(intersection(rects[i], rects[j]), 0, `${tag}: zones ${i},${j} disjoint`);
            }
        }
    }
});

test('U3 gap 8 insets outer edges by 8 and separates interior edges by 8', () => {
    const gap = 8;
    for (const wa of WORK_AREAS) {
        for (const l of BUILTIN_LAYOUTS) {
            const tag = `${l.id} @ ${JSON.stringify(wa)}`;
            const plain = l.zones.map(z => zoneRect(wa, z, 0));
            const gapped = l.zones.map(z => zoneRect(wa, z, gap));
            assert(gapped.every(isInt), `${tag}: integer edges`);
            gapped.forEach((r, i) => {
                const p = plain[i];
                // Outer edges are inset exactly `gap` from the work area.
                if (p.x === wa.x)
                    eq(r.x, wa.x + gap, `${tag} z${i} left`);
                if (p.y === wa.y)
                    eq(r.y, wa.y + gap, `${tag} z${i} top`);
                if (p.x + p.width === wa.x + wa.width)
                    eq(r.x + r.width, wa.x + wa.width - gap, `${tag} z${i} right`);
                if (p.y + p.height === wa.y + wa.height)
                    eq(r.y + r.height, wa.y + wa.height - gap, `${tag} z${i} bottom`);
            });
            // Neighbours sharing an interior edge are exactly `gap` apart.
            for (let i = 0; i < plain.length; i++) {
                for (let j = 0; j < plain.length; j++) {
                    if (i === j)
                        continue;
                    const a = plain[i], b = plain[j];
                    const vOverlap = Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);
                    const hOverlap = Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x);
                    if (a.x + a.width === b.x && vOverlap)
                        eq(gapped[j].x - (gapped[i].x + gapped[i].width), gap, `${tag} z${i}|z${j} horizontal gap`);
                    if (a.y + a.height === b.y && hOverlap)
                        eq(gapped[j].y - (gapped[i].y + gapped[i].height), gap, `${tag} z${i}/z${j} vertical gap`);
                }
            }
        }
    }
    // Odd gap still separates neighbours by exactly the gap.
    const [l, r] = BUILTIN_LAYOUTS[0].zones.map(z => zoneRect(WORK_AREAS[0], z, 7));
    eq(r.x - (l.x + l.width), 7, 'odd gap 7');
    eq(l.x, 7, 'odd gap outer');
});

test('U4 validateLayout rejects bad layouts', () => {
    const good = {id: 'a', name: 'A', zones: [{x: 0, y: 0, w: 1, h: 1}]};
    assert(validateLayout(good).ok, 'good layout ok');
    const bad = {
        'negative x': {id: 'a', zones: [{x: -0.1, y: 0, w: 0.5, h: 1}]},
        'x + w > 1': {id: 'a', zones: [{x: 0.6, y: 0, w: 0.5, h: 1}]},
        'y + h > 1': {id: 'a', zones: [{x: 0, y: 0.5, w: 1, h: 0.6}]},
        'zero width': {id: 'a', zones: [{x: 0, y: 0, w: 0, h: 1}]},
        'overlap': {id: 'a', zones: [{x: 0, y: 0, w: 0.6, h: 1}, {x: 0.5, y: 0, w: 0.5, h: 1}]},
        'zero zones': {id: 'a', zones: []},
        '>12 zones': {id: 'a', zones: Array.from({length: 13}, (_, i) => ({x: i / 13, y: 0, w: 1 / 13, h: 1}))},
        'non-numeric': {id: 'a', zones: [{x: '0', y: 0, w: 1, h: 1}]},
        'NaN': {id: 'a', zones: [{x: NaN, y: 0, w: 1, h: 1}]},
        'zones not array': {id: 'a', zones: 'nope'},
        'not object': 42,
        'null': null,
        'array': [],
        'missing id': {zones: [{x: 0, y: 0, w: 1, h: 1}]},
    };
    for (const [name, obj] of Object.entries(bad)) {
        const res = validateLayout(obj);
        assert(!res.ok && typeof res.error === 'string', `rejects ${name}`);
    }
    // Edge-touching zones and 12 zones are fine; float noise within tolerance.
    assert(validateLayout({id: 'a', zones: Array.from({length: 12}, (_, i) => ({x: i / 12, y: 0, w: 1 / 12, h: 1}))}).ok, '12 zones ok');
    assert(validateLayout({id: 'a', zones: [{x: 0.1, y: 0, w: 0.9 + 1e-9, h: 1}]}).ok, 'tolerance ok');
});

test('U4 parseCustomLayouts', () => {
    for (const garbage of ['', '{', 'not json', 'undefined']) {
        const res = parseCustomLayouts(garbage);
        eq(res.layouts, [], `garbage ${JSON.stringify(garbage)} -> no layouts`);
        eq(res.errors.length, 1, `garbage ${JSON.stringify(garbage)} -> one error`);
    }
    for (const nonArray of ['{}', '42', '"x"', 'null']) {
        const res = parseCustomLayouts(nonArray);
        eq(res.layouts, [], `non-array ${nonArray}`);
        eq(res.errors.length, 1, `non-array ${nonArray} error`);
    }
    eq(parseCustomLayouts('[]'), {layouts: [], errors: []}, 'empty array');

    const zones = [{x: 0, y: 0, w: 1, h: 1}];
    const res = parseCustomLayouts(JSON.stringify([
        {id: 'halves', name: 'Mine', zones},   // collides with built-in
        {id: 'mine', zones},
        {id: 'mine', zones},                    // collides with earlier custom
        {name: 'No id', zones},                 // index 3 -> custom-3
        {id: 'broken', zones: []},              // dropped
        'string entry',                         // dropped
        {id: 'mine-2', zones},                  // collides with generated id
    ]));
    eq(res.layouts.map(l => l.id), ['halves-2', 'mine', 'mine-2', 'custom-3', 'mine-2-2'], 'ids');
    eq(res.errors.length, 2, 'two invalid entries');
    eq(res.layouts[0].name, 'Mine', 'name kept');
    eq(res.layouts[3].name, 'No id', 'name kept for generated id');
    eq(res.layouts[1].name, 'mine', 'name defaults to id');

    const enabled = enabledLayouts(['thirds', 'quadrants'], res.layouts);
    eq(enabled.map(l => l.id).slice(0, 5),
        ['halves', 'two-thirds-left', 'half-left-quarters-right', 'quarters-left-half-right', 'quarter-half-quarter'],
        'enabledLayouts filters built-ins in order');
    eq(enabled.length, BUILTIN_LAYOUTS.length - 2 + res.layouts.length, 'customs appended');
    eq(enabled.slice(-res.layouts.length).map(l => l.id), res.layouts.map(l => l.id), 'customs last');
});

test('U5 inTriggerBand boundaries', () => {
    const mon = {x: 0, y: 0, width: 1920, height: 1080};
    const wa = {x: 0, y: 32, width: 1920, height: 1048};
    const opts = {triggerWidthPct: 40, triggerHeight: 48};
    // half-width = 1920 * 0.4 / 2 = 384 around centre 960 -> [576, 1344]
    assert(inTriggerBand(mon, wa, 960, 40, opts), 'centre');
    assert(inTriggerBand(mon, wa, 576, 40, opts), 'left edge inclusive');
    assert(!inTriggerBand(mon, wa, 575, 40, opts), 'just left of band');
    assert(inTriggerBand(mon, wa, 1344, 40, opts), 'right edge inclusive');
    assert(!inTriggerBand(mon, wa, 1345, 40, opts), 'just right of band');
    assert(inTriggerBand(mon, wa, 960, 79, opts), 'just above bottom (32 + 48 = 80)');
    assert(!inTriggerBand(mon, wa, 960, 80, opts), 'at bottom edge excluded');
    assert(inTriggerBand(mon, wa, 960, 0, opts), 'over the top panel counts');
    assert(inTriggerBand(mon, wa, 960, 10, opts), 'over the panel counts');
    assert(!inTriggerBand(mon, wa, 960, -1, opts), 'above the monitor');

    const mon2 = {x: 1920, y: 0, width: 1366, height: 768};
    const wa2 = {x: 1920, y: 0, width: 1366, height: 768};
    // centre 2603, half-width 273.2
    assert(inTriggerBand(mon2, wa2, 2603, 5, opts), 'second monitor centre');
    assert(inTriggerBand(mon2, wa2, 2603 - 273, 5, opts), 'second monitor left inside');
    assert(!inTriggerBand(mon2, wa2, 2603 - 274, 5, opts), 'second monitor left outside');
    assert(!inTriggerBand(mon2, wa2, 960, 5, opts), 'pointer on other monitor');
    assert(inTriggerBand(mon, wa, 0, 5, {triggerWidthPct: 100, triggerHeight: 48}), '100% width reaches left edge');
});

test('U6 pickerGeometry and hitTest', () => {
    const mon = {x: 0, y: 0, width: 1920, height: 1080};
    const wa = {x: 0, y: 32, width: 1920, height: 1048};
    const layouts = enabledLayouts([], []);
    const g = pickerGeometry(mon, wa, layouts);
    eq(g.thumbs.length, layouts.length, 'one thumb per layout');
    eq(g.y, wa.y + 8, 'top edge at workArea.y + 8');
    assert(Math.abs(g.x + g.width / 2 - (mon.x + mon.width / 2)) <= 0.5, 'horizontally centred');
    const cols = new Set(g.thumbs.map(t => t.x)).size;
    assert(cols <= MAX_COLUMNS, `≤4 columns (${cols})`);
    eq(g.thumbs[0].width, 112, 'base thumb width');
    assert(Math.abs(g.thumbs[0].height / g.thumbs[0].width - wa.height / wa.width) < 0.01, 'thumb aspect = work area');
    // Row-major order.
    assert(g.thumbs[1].x > g.thumbs[0].x && g.thumbs[1].y === g.thumbs[0].y, 'row-major');
    assert(g.thumbs[4].y > g.thumbs[0].y && g.thumbs[4].x === g.thumbs[0].x, 'wraps after 4');

    const asRect = t => ({x: t.x, y: t.y, width: t.width, height: t.height});
    for (let i = 0; i < g.thumbs.length; i++) {
        const t = g.thumbs[i];
        assert(containsRect(g, asRect(t)), `thumb ${i} inside picker`);
        for (let j = i + 1; j < g.thumbs.length; j++)
            eq(intersection(asRect(t), asRect(g.thumbs[j])), 0, `thumbs ${i},${j} disjoint`);
        for (const c of t.cells) {
            assert(containsRect(t, c), `thumb ${i} cell ${c.zoneIndex} inside thumb`);
            // Hit at the cell centre.
            eq(hitTest(g, c.x + c.width / 2, c.y + c.height / 2),
                {layoutIndex: i, layoutId: t.layoutId, zoneIndex: c.zoneIndex},
                `hit ${t.layoutId}:${c.zoneIndex}`);
        }
    }
    // Gutters and outside.
    const halves = g.thumbs[0];
    const [c0, c1] = halves.cells;
    const gutterX = (c0.x + c0.width + c1.x) / 2;
    assert(c1.x - (c0.x + c0.width) >= 2.9, 'gutter is ~3 px');
    eq(hitTest(g, gutterX, c0.y + c0.height / 2), null, 'gutter between cells');
    eq(hitTest(g, halves.x + 0.5, halves.y + 0.5), null, 'thumb border');
    eq(hitTest(g, halves.x + halves.width + 2, c0.y + 5), null, 'gutter between thumbs');
    eq(hitTest(g, g.x - 10, g.y - 10), null, 'outside picker');
    eq(hitTest(g, 5, 900), null, 'far outside');
    eq(hitTest(null, 5, 5), null, 'null geometry');

    // pointerInPicker margin.
    assert(pointerInPicker(g, g.x + 1, g.y + 1, 0), 'inside');
    assert(!pointerInPicker(g, g.x - 1, g.y + 1, 0), 'outside without margin');
    assert(pointerInPicker(g, g.x - 24, g.y + 1, 24), 'within margin left');
    assert(!pointerInPicker(g, g.x - 25, g.y + 1, 24), 'beyond margin left');
    assert(pointerInPicker(g, g.x + g.width + 23, g.y + g.height + 23, 24), 'within margin bottom-right');
    assert(!pointerInPicker(g, g.x + g.width + 24, g.y + 1, 24), 'beyond margin right');

    // Scale 2 doubles sizes.
    const g2 = pickerGeometry(mon, wa, layouts, {scale: 2});
    eq(g2.width, g.width * 2, 'scale 2 width');
    eq(g2.height, g.height * 2, 'scale 2 height');
    eq(g2.thumbs[0].width, 224, 'scale 2 thumb width');
    assert(Math.abs(g2.thumbs[0].cells[0].width - 2 * g.thumbs[0].cells[0].width) < 1.01, 'scale 2 cell width');
    assert(Math.abs(g2.x + g2.width / 2 - 960) <= 0.5, 'scale 2 centred');

    // Second monitor, fewer layouts than columns.
    const mon2 = {x: 1920, y: 0, width: 1366, height: 768};
    const g3 = pickerGeometry(mon2, mon2, layouts.slice(0, 2));
    assert(Math.abs(g3.x + g3.width / 2 - (1920 + 683)) <= 0.5, 'centred on second monitor');
    eq(g3.y, 8, 'second monitor top');
    eq(new Set(g3.thumbs.map(t => t.y)).size, 1, 'single row');

    // Amendment 2: top edge 8 (scaled) px below the trigger band bottom.
    const g4 = pickerGeometry(mon, wa, layouts, {triggerHeight: 8});
    eq(g4.y, wa.y + 8 + 8, 'top edge at band bottom + 8');
    eq(g4.height, g.height, 'trigger height only moves the picker');
    eq(g4.thumbs[0].y - g4.y, g.thumbs[0].y - g.y, 'thumbs move with the picker');
    const g5 = pickerGeometry(mon, wa, layouts, {scale: 2, triggerHeight: 48});
    eq(g5.y, wa.y + 48 + 16, 'scale 2: band bottom + 16');
    const g6 = pickerGeometry(mon2, mon2, layouts.slice(0, 2), {triggerHeight: 200});
    eq(g6.y, 208, 'second monitor, tall band');
});

test('U6b no picker cell reachable from inside the trigger band', () => {
    const mon = {x: 0, y: 0, width: 1920, height: 1080};
    const wa = {x: 0, y: 32, width: 1920, height: 1048};
    const layouts = enabledLayouts([], []);
    for (const scale of [1, 2, 3]) {
        for (const triggerHeight of [8, 9, 48, 120, 200]) {
            const opts = {triggerWidthPct: 100, triggerHeight};
            const g = pickerGeometry(mon, wa, layouts, {scale, triggerHeight});
            const bandBottom = wa.y + triggerHeight;
            assert(g.y >= bandBottom + 8 * scale, `picker below band (scale ${scale}, h ${triggerHeight})`);
            // The lowest band row never hits a cell, anywhere across the band.
            for (let px = 0; px < mon.width; px += 4) {
                const py = bandBottom - 1;
                if (inTriggerBand(mon, wa, px, py, opts) && hitTest(g, px, py)) {
                    assert(false, `cell hit at ${px},${py} (scale ${scale}, h ${triggerHeight})`);
                    break;
                }
            }
        }
    }
});

test('U7 restoreRect', () => {
    const wa = {x: 0, y: 32, width: 1920, height: 1048};
    const snapped = {x: 960, y: 32, width: 960, height: 1048};
    const saved = {width: 800, height: 600};
    // Pointer at 75% across the snapped window, 15 px below its top.
    const r = restoreRect(snapped, saved, 960 + 720, 47, wa);
    eq([r.width, r.height], [800, 600], 'saved size');
    eq(r.x, 1680 - 600, 'relative x kept (75% of 800)');
    eq(r.y, 32, 'y offset kept');
    assert(containsRect(wa, r), 'inside work area');

    // Pointer near the right edge: relative x kept, still inside work area.
    const r2 = restoreRect({x: 0, y: 32, width: 960, height: 1048}, saved, 950, 60, wa);
    assert(Math.abs((950 - r2.x) / r2.width - 950 / 960) < 0.01, 'relative x near right edge');
    eq(r2.y, 32, 'y offset 28 kept');
    assert(containsRect(wa, r2), 'inside work area 2');

    // Would leave the work area: clamped.
    const r3 = restoreRect(snapped, saved, 1919, 40, wa);
    assert(containsRect(wa, r3), 'clamped right');
    const r4 = restoreRect({x: 0, y: 32, width: 960, height: 1048}, saved, 1, 40, wa);
    assert(containsRect(wa, r4), 'clamped left');
    // y offset larger than the restored height is clamped into the window.
    const r5 = restoreRect(snapped, saved, 1440, 900, wa);
    assert(900 >= r5.y && 900 < r5.y + r5.height, 'pointer y inside restored window');
    assert(containsRect(wa, r5), 'inside work area 5');
    // Saved size larger than the work area shrinks to fit.
    const r6 = restoreRect(snapped, {width: 4000, height: 3000}, 1440, 60, wa);
    assert(containsRect(wa, r6), 'oversize clamped');
    // Odd work area on a second monitor.
    const wa2 = {x: 1920, y: 0, width: 1366, height: 768};
    const r7 = restoreRect({x: 1920, y: 0, width: 683, height: 768}, {width: 500, height: 400}, 2100, 12, wa2);
    assert(containsRect(wa2, r7), 'second monitor inside');
    assert(Math.abs((2100 - r7.x) / 500 - 180 / 683) < 0.01, 'second monitor relative x');
});

test('rectsClose', () => {
    const a = {x: 0, y: 0, width: 100, height: 100};
    assert(rectsClose(a, {x: 2, y: -2, width: 102, height: 98}), 'within 2');
    assert(!rectsClose(a, {x: 3, y: 0, width: 100, height: 100}), 'x off by 3');
    assert(rectsClose(a, {x: 3, y: 0, width: 100, height: 100}, 3), 'custom tol');
    assert(!rectsClose(a, null), 'null');
});

test('drag state machine', () => {
    const base = {monitor: 0, inPicker: false, showDelay: 80};
    let s = initialDragState();
    eq(s.phase, 'armed', 'new drag starts armed (no picker)');
    s = stepDragState(s, {...base, now: 0, inBand: false});
    eq(s.phase, 'armed', 'outside band stays armed');
    s = stepDragState(s, {...base, now: 10, inBand: true});
    eq(s.phase, 'pending', 'band entered');
    s = stepDragState(s, {...base, now: 89, inBand: true});
    eq(s.phase, 'pending', 'before delay');
    s = stepDragState(s, {...base, now: 90, inBand: true});
    eq(s.phase, 'shown', 'after delay');
    // Leaving the band but staying in the picker keeps it.
    s = stepDragState(s, {...base, now: 100, inBand: false, inPicker: true});
    eq(s.phase, 'shown', 'in picker');
    s = stepDragState(s, {...base, now: 110, inBand: false, inPicker: false});
    eq(s.phase, 'shown', 'just left');
    s = stepDragState(s, {...base, now: 110 + HIDE_DELAY_MS - 1, inBand: false});
    eq(s.phase, 'shown', 'before hide delay');
    // Coming back resets the hide timer.
    s = stepDragState(s, {...base, now: 270, inBand: false, inPicker: true});
    s = stepDragState(s, {...base, now: 280, inBand: false});
    s = stepDragState(s, {...base, now: 280 + HIDE_DELAY_MS - 1, inBand: false});
    eq(s.phase, 'shown', 'hide timer reset by return');
    s = stepDragState(s, {...base, now: 280 + HIDE_DELAY_MS, inBand: false});
    eq(s.phase, 'armed', 'hidden after delay');

    // Leaving the band while pending cancels.
    s = stepDragState(initialDragState(), {...base, now: 0, inBand: true});
    s = stepDragState(s, {...base, now: 50, inBand: false});
    eq(s.phase, 'armed', 'pending cancelled');
    // Zero delay shows immediately.
    s = stepDragState(initialDragState(), {...base, now: 0, inBand: true, showDelay: 0});
    eq(s.phase, 'shown', 'zero delay');
    // Monitor change while pending restarts the delay.
    s = stepDragState(initialDragState(), {...base, now: 0, inBand: true});
    s = stepDragState(s, {...base, now: 70, inBand: true, monitor: 1});
    s = stepDragState(s, {...base, now: 100, inBand: true, monitor: 1});
    eq(s.phase, 'pending', 'restarted on monitor change');
    eq(s.monitor, 1, 'pending on new monitor');
});

test('drag starting inside the band', () => {
    const base = {monitor: 0, inPicker: false, showDelay: 0};
    let s = initialDragState(true);
    eq(s.phase, 'blocked', 'starts blocked');
    s = stepDragState(s, {...base, now: 0, inBand: true});
    eq(s.phase, 'blocked', 'staying in the band never shows the picker');
    s = stepDragState(s, {...base, now: 500, inBand: true, inPicker: true});
    eq(s.phase, 'blocked', 'still blocked later');
    s = stepDragState(s, {...base, now: 510, inBand: false});
    eq(s.phase, 'armed', 'armed after leaving the band');
    s = stepDragState(s, {...base, now: 520, inBand: true});
    eq(s.phase, 'shown', 'shows on re-entry');
    eq(initialDragState(false).phase, 'armed', 'outside the band starts armed');
});

// ---- Amendment 3: portrait layouts and orientation matching ----

const PORTRAIT_WORK_AREAS = [
    {x: 1920, y: 0, width: 1080, height: 1920},
    {x: 0, y: 32, width: 1080, height: 1888},
    {x: 0, y: 0, width: 1200, height: 1920},
];
const PORTRAIT_IDS = ['v-halves', 'v-thirds', 'v-large-two-small'];
const LANDSCAPE_IDS = BUILTIN_LAYOUTS.filter(l => l.orientation === 'landscape').map(l => l.id);
const byId = id => BUILTIN_LAYOUTS.find(l => l.id === id);

test('P1 portrait built-ins: zones as in the SPEC, reading order', () => {
    const t = 1 / 3;
    eq(byId('v-halves').zones, [{x: 0, y: 0, w: 1, h: 0.5}, {x: 0, y: 0.5, w: 1, h: 0.5}], 'v-halves');
    eq(byId('v-thirds').zones, [{x: 0, y: 0, w: 1, h: t}, {x: 0, y: t, w: 1, h: t},
        {x: 0, y: 2 / 3, w: 1, h: t}], 'v-thirds');
    eq(byId('v-large-two-small').zones, [{x: 0, y: 0, w: 1, h: 0.5}, {x: 0, y: 0.5, w: 0.5, h: 0.5},
        {x: 0.5, y: 0.5, w: 0.5, h: 0.5}], 'v-large-two-small');
    eq(PORTRAIT_IDS.map(id => byId(id).name), ['Stacked halves', 'Stacked thirds', 'Large + two small'], 'names');
    for (const id of PORTRAIT_IDS) {
        assert(Object.isFrozen(byId(id)) && Object.isFrozen(byId(id).zones), `${id} frozen`);
        eq(validateLayout(byId(id)).layout?.orientation, 'portrait', `${id} validates as portrait`);
    }
});

test('P2 portrait work areas tile exactly (gap 0) and gap 8 separates by 8', () => {
    for (const wa of PORTRAIT_WORK_AREAS) {
        for (const l of BUILTIN_LAYOUTS) {
            const tag = `${l.id} @ ${JSON.stringify(wa)}`;
            const rects = l.zones.map(z => zoneRect(wa, z, 0));
            assert(rects.every(isInt), `${tag}: integer edges`);
            assert(rects.every(r => containsRect(wa, r)), `${tag}: inside`);
            eq(rects.reduce((s, r) => s + area(r), 0), area(wa), `${tag}: no holes`);
            for (let i = 0; i < rects.length; i++) {
                for (let j = i + 1; j < rects.length; j++)
                    eq(intersection(rects[i], rects[j]), 0, `${tag}: ${i},${j} disjoint`);
            }

            const gapped = l.zones.map(z => zoneRect(wa, z, 8));
            assert(gapped.every(isInt), `${tag}: gap 8 integer edges`);
            gapped.forEach((r, i) => {
                const p = rects[i];
                if (p.x === wa.x)
                    eq(r.x, wa.x + 8, `${tag} z${i} left`);
                if (p.y === wa.y)
                    eq(r.y, wa.y + 8, `${tag} z${i} top`);
                if (p.x + p.width === wa.x + wa.width)
                    eq(r.x + r.width, wa.x + wa.width - 8, `${tag} z${i} right`);
                if (p.y + p.height === wa.y + wa.height)
                    eq(r.y + r.height, wa.y + wa.height - 8, `${tag} z${i} bottom`);
                assert(containsRect(p, r), `${tag} z${i} inset inside its gap-0 rect`);
            });
            for (let i = 0; i < rects.length; i++) {
                for (let j = 0; j < rects.length; j++) {
                    const a = rects[i], b = rects[j];
                    const vOverlap = Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);
                    const hOverlap = Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x);
                    if (i !== j && a.x + a.width === b.x && vOverlap)
                        eq(gapped[j].x - (gapped[i].x + gapped[i].width), 8, `${tag} z${i}|z${j}`);
                    if (i !== j && a.y + a.height === b.y && hOverlap)
                        eq(gapped[j].y - (gapped[i].y + gapped[i].height), 8, `${tag} z${i}/z${j}`);
                }
            }
        }
    }
    // Exact rects on the E2E portrait monitor (1080x1920 at x 1920).
    const wa = PORTRAIT_WORK_AREAS[0];
    eq(byId('v-thirds').zones.map(z => zoneRect(wa, z, 0)), [
        {x: 1920, y: 0, width: 1080, height: 640},
        {x: 1920, y: 640, width: 1080, height: 640},
        {x: 1920, y: 1280, width: 1080, height: 640},
    ], 'v-thirds rects');
    eq(byId('v-large-two-small').zones.map(z => zoneRect(wa, z, 0)), [
        {x: 1920, y: 0, width: 1080, height: 960},
        {x: 1920, y: 960, width: 540, height: 960},
        {x: 2460, y: 960, width: 540, height: 960},
    ], 'v-large-two-small rects');
    eq(zoneRect(PORTRAIT_WORK_AREAS[1], byId('v-thirds').zones[1], 0),
        {x: 0, y: 661, width: 1080, height: 630}, 'v-thirds:1 with a top bar (rounded edges)');
});

test('P3 custom layout orientation', () => {
    const zones = [{x: 0, y: 0, w: 1, h: 1}];
    eq(validateLayout({id: 'a', zones}).layout?.orientation, 'any', 'missing -> any');
    for (const o of ['landscape', 'portrait', 'any'])
        eq(validateLayout({id: 'a', zones, orientation: o}).layout?.orientation, o, `${o} kept`);
    for (const bad of ['Portrait', 'vertical', '', null, 1, true, ['portrait'], {}]) {
        const res = validateLayout({id: 'a', zones, orientation: bad});
        assert(!res.ok && /orientation/.test(res.error), `rejects orientation ${JSON.stringify(bad)}`);
    }
    const res = parseCustomLayouts(JSON.stringify([
        {id: 'p', zones, orientation: 'portrait'},
        {id: 'x', zones, orientation: 'sideways'},
        {id: 'v-halves', zones},          // collides with a portrait built-in
        {zones, orientation: 'landscape'},
    ]));
    eq(res.layouts.map(l => [l.id, l.orientation]),
        [['p', 'portrait'], ['v-halves-2', 'any'], ['custom-3', 'landscape']], 'parsed ids/orientations');
    eq(res.errors.length, 1, 'bad orientation drops only that entry');
    assert(/entry 1/.test(res.errors[0]), 'error names the entry');
});

test('P4 workAreaOrientation', () => {
    eq(workAreaOrientation({x: 0, y: 0, width: 1920, height: 1080}), 'landscape', '16:9');
    eq(workAreaOrientation({x: 1920, y: 0, width: 1080, height: 1920}), 'portrait', '9:16');
    eq(workAreaOrientation({x: 0, y: 0, width: 1000, height: 1000}), 'landscape', 'square -> landscape');
    eq(workAreaOrientation({x: 0, y: 0, width: 1000, height: 1001}), 'portrait', 'just taller');
    // A tall top bar can make a square monitor's work area landscape.
    eq(workAreaOrientation({x: 0, y: 32, width: 1080, height: 1048}), 'landscape', 'work area, not monitor');
});

test('P5 layoutsForWorkArea', () => {
    const land = {x: 0, y: 32, width: 1920, height: 1048};
    const port = {x: 1920, y: 0, width: 1080, height: 1920};
    const zones = [{x: 0, y: 0, w: 1, h: 1}];
    const {layouts: customs} = parseCustomLayouts(JSON.stringify([
        {id: 'c-any', zones},
        {id: 'c-port', zones, orientation: 'portrait'},
        {id: 'c-land', zones, orientation: 'landscape'},
        {id: 'c-any2', zones, orientation: 'any'},
    ]));
    const all = enabledLayouts([], customs);
    const ids = ls => ls.map(l => l.id);

    eq(ids(layoutsForWorkArea(all, land, true)), [...LANDSCAPE_IDS, 'c-any', 'c-land', 'c-any2'], 'landscape, matched');
    eq(ids(layoutsForWorkArea(all, port, true)), [...PORTRAIT_IDS, 'c-any', 'c-port', 'c-any2'], 'portrait, matched');
    eq(ids(layoutsForWorkArea(all, land, false)), ids(all), 'landscape, unmatched: all in order');
    eq(ids(layoutsForWorkArea(all, port, false)), ids(all), 'portrait, unmatched: all in order');
    eq(ids(layoutsForWorkArea(enabledLayouts([], []), port, true)), PORTRAIT_IDS, 'built-ins only: 3 portrait');
    eq(layoutsForWorkArea(enabledLayouts([], []), land, true).length, 7, 'built-ins only: 7 landscape');
    eq(ids(layoutsForWorkArea(enabledLayouts(['v-thirds'], []), port, true)),
        ['v-halves', 'v-large-two-small'], 'disabled portrait built-in hidden');
    eq(layoutsForWorkArea(enabledLayouts(PORTRAIT_IDS, []), port, true), [], 'nothing left -> empty');
    eq(layoutsForWorkArea([], land, false), [], 'empty in, empty out');
    // Layout objects without an orientation (older callers) count as `any`.
    eq(ids(layoutsForWorkArea([{id: 'bare', zones}], port, true)), ['bare'], 'no orientation -> any');
    const copy = layoutsForWorkArea(all, land, false);
    assert(copy !== all, 'returns a new array');
});

test('P6 portrait pickerGeometry', () => {
    const mon = {x: 1920, y: 0, width: 1080, height: 1920};
    for (const [wa, mon2] of [[PORTRAIT_WORK_AREAS[0], mon],
        [PORTRAIT_WORK_AREAS[1], {x: 0, y: 0, width: 1080, height: 1920}],
        [PORTRAIT_WORK_AREAS[2], {x: 0, y: 0, width: 1200, height: 1920}]]) {
        for (const scale of [1, 2]) {
            for (const layouts of [layoutsForWorkArea(enabledLayouts([], []), wa, true), enabledLayouts([], [])]) {
                const tag = `${JSON.stringify(wa)} x${scale} n${layouts.length}`;
                const g = pickerGeometry(mon2, wa, layouts, {scale, triggerHeight: 8});
                eq(g.thumbs.length, layouts.length, `${tag}: one thumb per layout`);
                eq(g.y, wa.y + 8 + 8 * scale, `${tag}: top edge`);
                assert(Math.abs(g.x + g.width / 2 - (mon2.x + mon2.width / 2)) <= 0.5, `${tag}: centred`);
                assert(g.x >= mon2.x && g.x + g.width <= mon2.x + mon2.width, `${tag}: inside monitor`);
                const asRect = t => ({x: t.x, y: t.y, width: t.width, height: t.height});
                for (const [i, t] of g.thumbs.entries()) {
                    eq(t.height, THUMB_MAX_SIDE * scale, `${tag}: thumb ${i} height capped`);
                    assert(Math.max(t.width, t.height) <= THUMB_MAX_SIDE * scale, `${tag}: longer side ≤ cap`);
                    assert(t.width < t.height, `${tag}: thumb ${i} portrait`);
                    assert(Math.abs(t.width / t.height - wa.width / wa.height) < 0.01,
                        `${tag}: thumb ${i} keeps the work-area aspect`);
                    assert(containsRect(g, asRect(t)), `${tag}: thumb ${i} inside picker`);
                    for (let j = i + 1; j < g.thumbs.length; j++)
                        eq(intersection(asRect(t), asRect(g.thumbs[j])), 0, `${tag}: thumbs ${i},${j} disjoint`);
                    for (const c of t.cells) {
                        assert(containsRect(t, c), `${tag}: ${t.layoutId}:${c.zoneIndex} inside thumb`);
                        eq(hitTest(g, c.x + c.width / 2, c.y + c.height / 2),
                            {layoutIndex: i, layoutId: t.layoutId, zoneIndex: c.zoneIndex},
                            `${tag}: hit ${t.layoutId}:${c.zoneIndex}`);
                    }
                }
            }
        }
    }
    // Exact numbers for the E2E monitor: 176 high, 99 wide, single row of 3.
    const wa = PORTRAIT_WORK_AREAS[0];
    const g = pickerGeometry(mon, wa, layoutsForWorkArea(enabledLayouts([], []), wa, true));
    eq(g.thumbs.map(t => [t.layoutId, t.width, t.height]),
        [['v-halves', 99, 176], ['v-thirds', 99, 176], ['v-large-two-small', 99, 176]], 'thumb sizes');
    eq(new Set(g.thumbs.map(t => t.y)).size, 1, 'single row');
    eq(g.height, 2 * 12 + 176, 'picker height');
    // v-thirds cells are stacked with 3 px gutters; the gutter is not a hit.
    const [c0, c1] = g.thumbs[1].cells;
    assert(Math.abs(c1.y - (c0.y + c0.height) - 3) < 1e-9, 'stacked gutter 3 px');
    eq(hitTest(g, c0.x + c0.width / 2, (c0.y + c0.height + c1.y) / 2), null, 'stacked gutter not a hit');
    // Landscape thumbnails are unaffected by the cap.
    const gl = pickerGeometry({x: 0, y: 0, width: 1920, height: 1080}, {x: 0, y: 32, width: 1920, height: 1048},
        enabledLayouts([], []));
    eq([gl.thumbs[0].width, gl.thumbs[0].height], [112, 61], 'landscape thumb unchanged');
    // Square: 112 x 112, under the cap.
    const gs = pickerGeometry({x: 0, y: 0, width: 1000, height: 1000}, {x: 0, y: 0, width: 1000, height: 1000},
        enabledLayouts([], []));
    eq([gs.thumbs[0].width, gs.thumbs[0].height], [112, 112], 'square thumb');
});

print(`${passes} assertions passed, ${failures} failed`);
if (failures > 0)
    (await import('system')).default.exit(1);
