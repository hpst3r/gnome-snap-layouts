// SPDX-License-Identifier: AGPL-3.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {BUILTIN_LAYOUTS, parseCustomLayouts} from './lib/layouts.js';

function spinRow(settings, key, title, subtitle, lower, upper) {
    const row = Adw.SpinRow.new_with_range(lower, upper, 1);
    row.set({title, subtitle});
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function headingRow(label) {
    return new Gtk.ListBoxRow({
        activatable: false,
        selectable: false,
        child: new Gtk.Label({
            label,
            xalign: 0,
            margin_top: 12,
            margin_bottom: 6,
            margin_start: 12,
            margin_end: 12,
            css_classes: ['heading'],
        }),
    });
}

function layoutRow(settings, layout) {
    const row = new Adw.SwitchRow({title: layout.name, subtitle: layout.id});
    const sync = () => {
        const active = !settings.get_strv('disabled-layouts').includes(layout.id);
        if (row.active !== active)
            row.active = active;
    };
    sync();
    const changedId = settings.connect('changed::disabled-layouts', sync);
    row.connect('notify::active', () => {
        const disabled = settings.get_strv('disabled-layouts').filter(id => id !== layout.id);
        if (!row.active)
            disabled.push(layout.id);
        settings.set_strv('disabled-layouts', disabled);
    });
    row.connect('destroy', () => settings.disconnect(changedId));
    return row;
}

function customLayoutsRow(settings, window) {
    const expander = new Adw.ExpanderRow({
        title: 'Custom layouts (JSON)',
        subtitle: 'Array of {"id", "name", "orientation", "zones": [{"x", "y", "w", "h"}]} with fractions ' +
            'of the work area; orientation is "landscape", "portrait" or "any" (default)',
    });

    const buffer = new Gtk.TextBuffer({text: settings.get_string('custom-layouts')});
    const bufferText = () => buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false);
    // Follow changes made elsewhere (another prefs window, gsettings).
    // Text that only differs by surrounding whitespace is left alone so
    // Apply does not reset the cursor.
    const changedId = settings.connect('changed::custom-layouts', () => {
        const value = settings.get_string('custom-layouts');
        const text = bufferText().trim();
        if (text !== value.trim() && !(text === '' && value.trim() === '[]'))
            buffer.text = value;
    });
    window.connect('close-request', () => {
        settings.disconnect(changedId);
        return false;
    });
    const view = new Gtk.TextView({
        buffer,
        monospace: true,
        wrap_mode: Gtk.WrapMode.WORD_CHAR,
        top_margin: 6,
        bottom_margin: 6,
        left_margin: 6,
        right_margin: 6,
    });
    const scroller = new Gtk.ScrolledWindow({
        child: view,
        min_content_height: 160,
        hexpand: true,
    });

    const status = new Gtk.Label({
        xalign: 0,
        wrap: true,
        hexpand: true,
        css_classes: ['dim-label'],
    });
    const apply = new Gtk.Button({label: 'Apply', valign: Gtk.Align.CENTER, css_classes: ['suggested-action']});
    apply.connect('clicked', () => {
        const text = bufferText().trim();
        const json = text === '' ? '[]' : text;
        const {layouts, errors} = parseCustomLayouts(json);
        if (errors.length > 0) {
            status.label = `Not saved:\n${errors.join('\n')}`;
            status.css_classes = ['error'];
            return;
        }
        settings.set_string('custom-layouts', json);
        status.label = `Saved ${layouts.length} custom layout(s).`;
        status.css_classes = ['dim-label'];
    });

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
        margin_top: 6,
        margin_bottom: 6,
        margin_start: 6,
        margin_end: 6,
    });
    const actions = new Gtk.Box({spacing: 6});
    actions.append(status);
    actions.append(apply);
    box.append(scroller);
    box.append(actions);
    expander.add_row(box);
    return expander;
}

export default class SnapLayoutsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;

        const page = new Adw.PreferencesPage({
            title: 'Snap Layouts',
            icon_name: 'view-grid-symbolic',
        });

        const general = new Adw.PreferencesGroup({title: 'General'});
        general.add(switchRow(settings, 'show-indicator', 'Show top bar menu',
            'Quick toggles and a shortcut to these settings in the top bar'));
        page.add(general);

        const trigger = new Adw.PreferencesGroup({
            title: 'Trigger',
            description: 'Drag a window into this band at the top centre of a monitor to show the layout picker',
        });
        trigger.add(spinRow(settings, 'trigger-width', 'Trigger width', 'Percent of the monitor width, centred', 10, 100));
        trigger.add(spinRow(settings, 'trigger-height', 'Trigger height', 'Pixels below the top of the work area', 8, 200));
        trigger.add(spinRow(settings, 'show-delay-ms', 'Show delay', 'Milliseconds in the band before the picker appears', 0, 1000));
        page.add(trigger);

        const snapping = new Adw.PreferencesGroup({title: 'Snapping'});
        snapping.add(spinRow(settings, 'gap', 'Gap', 'Pixels between snapped windows and screen edges', 0, 64));
        snapping.add(switchRow(settings, 'restore-size-on-drag', 'Restore size on drag out',
            'Dragging a snapped window gives it back its previous size'));
        snapping.add(switchRow(settings, 'snap-assist', 'Snap Assist',
            'Offer other windows for the remaining zones after a snap'));
        page.add(snapping);

        const layouts = new Adw.PreferencesGroup({title: 'Layouts'});
        layouts.add(switchRow(settings, 'match-orientation', 'Match monitor orientation',
            'Offer portrait layouts only on portrait monitors and landscape layouts only on landscape ones'));
        for (const [orientation, heading] of [['landscape', 'Landscape'], ['portrait', 'Portrait']]) {
            layouts.add(headingRow(heading));
            for (const layout of BUILTIN_LAYOUTS.filter(l => l.orientation === orientation))
                layouts.add(layoutRow(settings, layout));
        }
        layouts.add(customLayoutsRow(settings, window));
        page.add(layouts);

        const debug = new Adw.PreferencesGroup({title: 'Debug'});
        debug.add(switchRow(settings, 'debug', 'Debug logging', 'Log snapping decisions to the journal'));
        page.add(debug);

        window.add(page);
    }
}
