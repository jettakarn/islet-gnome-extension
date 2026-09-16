import St from 'gi://St';
import Clutter from 'gi://Clutter';

export function buildSettingRow(host, title, options, key) {
    const row = new St.BoxLayout({
        style_class: 'islet-settings-row',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    row.add_child(new St.Label({
        text: title,
        style_class: 'islet-settings-label',
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
    }));

    const segment = new St.BoxLayout({
        style_class: 'islet-settings-segment',
        y_align: Clutter.ActorAlign.CENTER,
    });

    if (!host._settingsButtons)
        host._settingsButtons = {};
    host._settingsButtons[key] = [];

    options.forEach(opt => {
        const btn = new St.Button({
            label: opt.label,
            style_class: 'islet-settings-chip',
            reactive: false,
            can_focus: false,
        });
        btn._isletValue = opt.value;
        btn.connect('clicked', () => {
            if (typeof opt.value === 'boolean')
                host._settings.set_boolean(key, opt.value);
            else
                host._settings.set_string(key, opt.value);
        });
        host._settingsButtons[key].push(btn);
        segment.add_child(btn);
    });

    row.add_child(segment);
    return row;
}

export function buildSettingsTab(host) {
    const tab = new St.BoxLayout({
        style_class: 'islet-settings-box',
        vertical: true,
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.FILL,
        y_align: Clutter.ActorAlign.CENTER,
        opacity: 0,
        translation_x: 50,
        reactive: false,
    });

    tab.add_child(buildSettingRow(host, 'Temp', [
        { label: '°C', value: 'celsius', key: 'temperature-unit' },
        { label: '°F', value: 'fahrenheit', key: 'temperature-unit' },
    ], 'temperature-unit'));

    tab.add_child(buildSettingRow(host, 'Clock', [
        { label: '24h', value: '24h', key: 'clock-format' },
        { label: '12h', value: '12h', key: 'clock-format' },
    ], 'clock-format'));

    return tab;
}

export function syncSettingsUi(host) {
    if (!host._settingsButtons)
        return;

    const unit = host._settings.get_string('temperature-unit');
    const clock = host._settings.get_string('clock-format');

    const apply = (key, current) => {
        (host._settingsButtons[key] || []).forEach(btn => {
            if (btn._isletValue === current)
                btn.add_style_class_name('islet-settings-chip-active');
            else
                btn.remove_style_class_name('islet-settings-chip-active');
        });
    };

    apply('temperature-unit', unit);
    apply('clock-format', clock);
}
