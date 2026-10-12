// SPDX-License-Identifier: AGPL-3.0-or-later
// Review PoCs (UX) on the pure model. Skipped unless SNAP_REVIEW=1, so the
// default `make test` stays green. Run: SNAP_REVIEW=1 gjs -m tests/review_ux_test.js
//
// Each test asserts what a Windows 11 snap-layouts user would expect and
// FAILS on the current tree.

import GLib from 'gi://GLib';

import {
    BUILTIN_LAYOUTS, inTriggerBand, pickerGeometry, hitTest,
} from '../snap-layouts@wporter.org/lib/layouts.js';
import {assistMetrics, gridForZone} from '../snap-layouts@wporter.org/lib/snapAssistModel.js';

if (GLib.getenv('SNAP_REVIEW') !== '1') {
    print('review_ux_test: skipped (set SNAP_REVIEW=1)');
} else {
    let failures = 0;
    const check = (cond, name, msg) => {
        print(`${cond ? 'PASS' : 'FAIL'} [${name}] ${msg}`);
        if (!cond)
            failures++;
    };

    // 1920x1080 monitor, 32 px top bar; trigger-width 40.
    const monitor = {x: 0, y: 0, width: 1920, height: 1080};
    const workArea = {x: 0, y: 32, width: 1920, height: 1048};

    // The trigger band must not cover picker cells: otherwise the pointer is
    // already on a zone the moment the picker appears and a plain release
    // near the top snaps the window (see review-trigger-accidental-snap).
    // Amendment 2: the picker sits below the band, for any trigger-height
    // (the old default 48 and the new default 8 included).
    for (const triggerHeight of [8, 48, 200]) {
        const cfg = {triggerWidthPct: 40, triggerHeight};
        const geo = pickerGeometry(monitor, workArea, BUILTIN_LAYOUTS, {triggerHeight});
        const overlapping = [];
        for (const t of geo.thumbs) {
            for (const c of t.cells) {
                const px = Math.round(c.x + c.width / 2);
                const py = Math.round(c.y + 2);
                if (inTriggerBand(monitor, workArea, px, py, cfg) && hitTest(geo, px, py))
                    overlapping.push(`${t.layoutId}:${c.zoneIndex}`);
            }
        }
        check(overlapping.length === 0, 'band-vs-cells',
            `trigger-height ${triggerHeight}: cells reachable from inside the trigger band ` +
            `(y < ${workArea.y + cfg.triggerHeight}, first picker row starts at y ` +
            `${geo.thumbs[0].cells[0].y}): ${overlapping.join(', ')}`);
    }

    // Snap Assist: in a 960x1048 half zone with 2 candidates Windows 11 shows
    // large thumbnails; expect each to use >= 50% of the zone width.
    // (Uses the module's real metrics at scale 1, i.e. the shipped outcome.)
    {
        const zone = {x: 960, y: 32, width: 960, height: 1048};
        const g = gridForZone(zone, 2, {aspect: 1920 / 1048, ...assistMetrics(zone, 2)});
        check(g.thumbW >= zone.width / 2, 'assist-thumb-size',
            `thumbW ${g.thumbW} px in a ${zone.width} px zone (${g.cols}x${g.rows}), ` +
            `content ${g.contentWidth}x${g.contentHeight} of ${g.innerW}x${g.innerH}`);
    }

    print(`${failures} review failure(s)`);
    if (failures > 0)
        (await import('system')).default.exit(1);
}
