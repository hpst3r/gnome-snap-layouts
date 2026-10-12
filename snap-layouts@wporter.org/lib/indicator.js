// SPDX-License-Identifier: AGPL-3.0-or-later
// Optional top bar menu: quick switches for the most used settings and a
// shortcut to the preferences window (docs/SPEC.md Amendment 3).

import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const NAME = 'snap-layouts-indicator';

/** Boolean settings shown as switches, in menu order. */
const SWITCHES = [
    {key: 'snap-assist', label: 'Snap Assist'},
    {key: 'restore-size-on-drag', label: 'Restore size on drag-out'},
    {key: 'match-orientation', label: 'Match monitor orientation'},
];

/**
 * First descendant of `actor` carrying `styleClass`, or null.
 *
 * @param {Clutter.Actor} actor root
 * @param {string} styleClass St style class
 * @returns {St.Widget|null}
 */
function findStyled(actor, styleClass) {
    for (const child of actor.get_children()) {
        if (child.has_style_class_name?.(styleClass))
            return child;
        const found = findStyled(child, styleClass);
        if (found)
            return found;
    }
    return null;
}

/** Top bar menu. Constructed only while `show-indicator` is true. */
export class SnapIndicator {
    /**
     * @param {import('resource:///org/gnome/shell/extensions/extension.js').Extension} extension
     * @param {Gio.Settings} settings the extension's settings
     */
    constructor(extension, settings) {
        this._extension = extension;
        this._settings = settings;
        this._settingsIds = [];

        this._button = new PanelMenu.Button(0.0, 'Snap Layouts', false);
        this._button.name = NAME;
        this._button.add_child(new St.Icon({
            icon_name: 'view-grid-symbolic',
            style_class: 'system-status-icon',
        }));

        for (const {key, label} of SWITCHES)
            this._addSwitch(key, label);

        this._button.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const prefsItem = this._button.menu.addAction('Settings…',
            () => this._extension?.openPreferences());
        prefsItem.name = `${NAME}-item:settings`;

        Main.panel.addToStatusArea(extension.uuid, this._button);
    }

    /**
     * Add a switch item kept in sync with boolean `key` in both directions.
     *
     * @param {string} key settings key
     * @param {string} label item text
     */
    _addSwitch(key, label) {
        const item = new PopupMenu.PopupSwitchMenuItem(label,
            this._settings.get_boolean(key));
        item.name = `${NAME}-item:${key}`;
        // Name the switch too so tests can read its :checked pseudo class.
        const toggle = findStyled(item, 'toggle-switch');
        if (toggle)
            toggle.name = `${NAME}-item:${key}:switch`;

        // Both handlers only act on a real difference, so a write never
        // echoes back into another write.
        item.connect('toggled', (_item, state) => {
            if (this._settings && this._settings.get_boolean(key) !== state)
                this._settings.set_boolean(key, state);
        });
        this._settingsIds.push(this._settings.connect(`changed::${key}`, () => {
            const value = this._settings.get_boolean(key);
            if (item.state !== value)
                item.setToggleState(value);
        }));
        this._button.menu.addMenuItem(item);
    }

    /** Remove from the panel and disconnect everything. Idempotent. */
    destroy() {
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        // Destroys the panel container and the menu with its items; the
        // panel drops its statusArea entry on 'destroy'.
        this._button?.destroy();
        this._button = null;
        this._extension = null;
        this._settings = null;
    }
}
