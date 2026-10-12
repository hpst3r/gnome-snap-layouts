// SPDX-License-Identifier: AGPL-3.0-or-later
// Seam stub (architect). Owned by worker "assist"; see docs/SPEC.md "Seam: Snap Assist".

/**
 * @param {object} p see docs/SPEC.md
 * @returns {{destroy(): void}}
 */
export function showSnapAssist(p) {
    let closed = false;
    const close = () => {
        if (closed)
            return;
        closed = true;
        p.onClosed?.();
    };
    // Stub: nothing to offer yet.
    close();
    return {destroy: close};
}
