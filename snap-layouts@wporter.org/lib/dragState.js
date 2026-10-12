// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure picker visibility state machine for one window drag. No gi imports.
//
//   blocked --(left band)--> armed --(in band)--> pending --(show delay)--> shown
//                              ^                     |                        |
//                              +----(left band)------+  (outside band and     |
//                              +------------------------ picker for HIDE_DELAY_MS)
//
// A drag that begins with the pointer inside the band (e.g. on the headerbar
// of a maximized window) starts `blocked`, so it only arms once the pointer
// has left the band.
//
// "Hovering" is not a separate phase: while shown, the hovered cell is
// whatever hitTest() returns for the pointer.

/** How long the pointer may stay outside band and picker before hiding. */
export const HIDE_DELAY_MS = 150;
/** Margin around the picker that still counts as inside (px). */
export const PICKER_MARGIN = 24;

/**
 * Initial state of a new drag: never starts with a picker.
 *
 * @param {boolean} [startsInBand] the pointer is inside the trigger band
 *   when the drag begins; the drag then arms only after leaving the band
 * @returns {{phase: string, monitor: number, since: ?number}}
 */
export function initialDragState(startsInBand = false) {
    return Object.freeze({phase: startsInBand ? 'blocked' : 'armed', monitor: -1, since: null});
}

/**
 * Advance the state machine by one pointer sample.
 *
 * @param {{phase: string, monitor: number, since: ?number}} state
 * @param {object} input
 * @param {number} input.now monotonic time in ms
 * @param {number} input.monitor monitor index under the pointer
 * @param {boolean} input.inBand pointer in the trigger band of `monitor`
 * @param {boolean} input.inPicker pointer inside the shown picker (+margin)
 * @param {number} input.showDelay show-delay-ms setting
 * @returns {{phase: string, monitor: number, since: ?number}} new state;
 *   `since` is when the band was entered (pending) or when the pointer left
 *   band and picker (shown; null while inside)
 */
export function stepDragState(state, {now, monitor, inBand, inPicker, showDelay}) {
    switch (state.phase) {
    case 'blocked':
        return inBand ? state : initialDragState();

    case 'armed':
        if (!inBand)
            return state;
        if (showDelay <= 0)
            return Object.freeze({phase: 'shown', monitor, since: null});
        return Object.freeze({phase: 'pending', monitor, since: now});

    case 'pending':
        if (!inBand)
            return initialDragState();
        if (monitor !== state.monitor)
            return Object.freeze({phase: 'pending', monitor, since: now});
        if (now - state.since >= showDelay)
            return Object.freeze({phase: 'shown', monitor, since: null});
        return state;

    case 'shown': {
        const keep = inPicker || (inBand && monitor === state.monitor);
        if (keep)
            return state.since === null ? state : Object.freeze({...state, since: null});
        if (state.since === null)
            return Object.freeze({...state, since: now});
        if (now - state.since >= HIDE_DELAY_MS)
            return initialDragState();
        return state;
    }

    default:
        return initialDragState();
    }
}
