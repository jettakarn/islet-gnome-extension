import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { SHORTCUT_COUNT, SHORTCUT_LONG_PRESS_MS } from './constants.js';

const DEFAULT_SHORTCUT_IDS = [
    'org.gnome.Terminal.desktop',
    'org.gnome.Nautilus.desktop',
    'org.gnome.Calculator.desktop',
    'firefox.desktop',
];

function desktopIdOf(appInfo) {
    try {
        return appInfo.get_id?.() || null;
    } catch (e) {
        return null;
    }
}

function appInfoForId(id) {
    if (!id)
        return null;
    try {
        return Gio.DesktopAppInfo.new(id);
    } catch (e) {
        return null;
    }
}

function findAppByKeywords(keywords) {
    const all = Gio.AppInfo.get_all();
    for (const app of all) {
        try {
            if (!app.should_show?.())
                continue;
            const id = (desktopIdOf(app) || '').toLowerCase();
            const name = (app.get_name?.() || '').toLowerCase();
            const exec = (app.get_executable?.() || '').toLowerCase();
            for (const kw of keywords) {
                if (id.includes(kw) || name.includes(kw) || exec.includes(kw))
                    return desktopIdOf(app);
            }
        } catch (e) {
            // ignore
        }
    }
    return null;
}

function defaultBrowserId() {
    try {
        const info = Gio.AppInfo.get_default_for_uri_scheme('https');
        const id = desktopIdOf(info);
        if (id)
            return id;
    } catch (e) {
        // ignore
    }
    return findAppByKeywords(['firefox', 'chrome', 'chromium', 'brave', 'epiphany', 'browser']) ||
        'firefox.desktop';
}

function fallbackIdForIndex(index) {
    if (index === 0)
        return findAppByKeywords(['terminal', 'console', 'kgx', 'ptyxis']) || DEFAULT_SHORTCUT_IDS[0];
    if (index === 1)
        return findAppByKeywords(['nautilus', 'files', 'nemo', 'thunar']) || DEFAULT_SHORTCUT_IDS[1];
    if (index === 2)
        return findAppByKeywords(['calculator', 'calc']) || DEFAULT_SHORTCUT_IDS[2];
    return defaultBrowserId();
}

export function resolveShortcutIds(settings) {
    let ids = [];
    try {
        ids = settings.get_strv('shortcut-apps') || [];
    } catch (e) {
        ids = [];
    }

    const out = [];
    for (let i = 0; i < SHORTCUT_COUNT; i++) {
        let id = ids[i] || DEFAULT_SHORTCUT_IDS[i] || '';
        if (!appInfoForId(id))
            id = fallbackIdForIndex(i) || id;
        out.push(id);
    }
    return out;
}

function shortLabel(name) {
    const n = (name || 'App').trim();
    if (n.length <= 10)
        return n;
    return `${n.slice(0, 9)}…`;
}

function listInstallableApps() {
    const apps = [];
    const seen = new Set();
    for (const app of Gio.AppInfo.get_all()) {
        try {
            if (!app.should_show?.())
                continue;
            const id = desktopIdOf(app);
            if (!id || seen.has(id))
                continue;
            seen.add(id);
            apps.push(app);
        } catch (e) {
            // ignore
        }
    }
    apps.sort((a, b) => {
        const an = (a.get_name?.() || '').toLowerCase();
        const bn = (b.get_name?.() || '').toLowerCase();
        return an.localeCompare(bn);
    });
    return apps;
}

function clearChildren(actor) {
    const kids = actor.get_children();
    for (const c of kids)
        actor.remove_child(c);
}

function collapseIsland(host) {
    host._isExpanded = false;
    host._currentTab = 0;
    host._setExpandedTabPickable(false);
    host._updateIslandView();
}

function state(host) {
    if (!host._shortcutsState) {
        host._shortcutsState = {
            pickMode: false,
            pickIndex: -1,
            chipRow: null,
            pickerRoot: null,
            pressTimeout: 0,
            suppressClick: false,
        };
    }
    return host._shortcutsState;
}

function clearPressTimeout(st) {
    if (st.pressTimeout) {
        GLib.source_remove(st.pressTimeout);
        st.pressTimeout = 0;
    }
}

export function exitPickMode(host) {
    const st = state(host);
    const tab = host._shortcutsTab;
    if (!tab)
        return;

    st.pickMode = false;
    st.pickIndex = -1;
    clearPressTimeout(st);

    if (st.pickerRoot) {
        try {
            tab.remove_child(st.pickerRoot);
        } catch (e) {
            // ignore
        }
        st.pickerRoot = null;
    }

    if (st.chipRow) {
        st.chipRow.visible = true;
        st.chipRow.opacity = 255;
    }

    setShortcutsReactive(host, host._isExpanded && host._currentTab === 2);
}

function enterPickMode(host, index) {
    const st = state(host);
    const tab = host._shortcutsTab;
    if (!tab || !host._island)
        return;

    st.pickMode = true;
    st.pickIndex = index;
    st.suppressClick = true;
    clearPressTimeout(st);

    if (st.chipRow)
        st.chipRow.visible = false;

    if (st.pickerRoot) {
        try {
            tab.remove_child(st.pickerRoot);
        } catch (e) {
            // ignore
        }
        st.pickerRoot = null;
    }

    const picker = new St.BoxLayout({
        style_class: 'islet-qa-picker',
        vertical: true,
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.FILL,
        y_align: Clutter.ActorAlign.FILL,
    });

    const cancel = new St.Button({
        label: 'Cancel',
        style_class: 'islet-qa-cancel',
        x_align: Clutter.ActorAlign.CENTER,
        reactive: true,
        can_focus: true,
    });
    cancel.connect('clicked', () => exitPickMode(host));
    picker.add_child(cancel);

    const scroll = new St.ScrollView({
        style_class: 'islet-qa-picker-scroll',
        x_expand: true,
        y_expand: true,
        overlay_scrollbars: true,
    });
    try {
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
    } catch (e) {
        // ignore
    }

    const list = new St.BoxLayout({
        style_class: 'islet-qa-picker-list',
        vertical: true,
        x_expand: true,
    });

    for (const app of listInstallableApps()) {
        const id = desktopIdOf(app);
        const row = new St.Button({
            style_class: 'islet-qa-picker-row',
            x_expand: true,
            reactive: true,
            can_focus: true,
        });
        const rowBox = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const icon = new St.Icon({
            style_class: 'islet-qa-picker-icon',
            icon_size: 18,
            y_align: Clutter.ActorAlign.CENTER,
        });
        try {
            const gicon = app.get_icon?.();
            if (gicon)
                icon.gicon = gicon;
        } catch (e) {
            // ignore
        }
        const label = new St.Label({
            text: app.get_name?.() || id || 'App',
            style_class: 'islet-qa-picker-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        rowBox.add_child(icon);
        rowBox.add_child(label);
        row.set_child(rowBox);
        row.connect('clicked', () => {
            if (!host._settings || index < 0)
                return;
            const next = resolveShortcutIds(host._settings);
            next[index] = id;
            host._settings.set_strv('shortcut-apps', next);
            exitPickMode(host);
            rebuildShortcuts(host);
        });
        list.add_child(row);
    }

    try {
        scroll.set_child(list);
    } catch (e) {
        try {
            scroll.add_child(list);
        } catch (e2) {
            scroll.add_actor?.(list);
        }
    }
    picker.add_child(scroll);
    tab.add_child(picker);
    st.pickerRoot = picker;

    setShortcutsReactive(host, true);
}

function makeChip(host, id, index) {
    const st = state(host);
    const info = appInfoForId(id);
    const name = info?.get_name?.() || 'App';
    const btn = new St.Button({
        label: shortLabel(name),
        style_class: 'islet-qa-button',
        reactive: false,
        can_focus: false,
    });
    btn._isletDesktopId = id;
    btn._isletShortcutIndex = index;

    btn.connect('button-press-event', () => {
        clearPressTimeout(st);
        st.suppressClick = false;
        st.pressTimeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            SHORTCUT_LONG_PRESS_MS,
            () => {
                st.pressTimeout = 0;
                st.suppressClick = true;
                enterPickMode(host, index);
                return GLib.SOURCE_REMOVE;
            }
        );
        return Clutter.EVENT_PROPAGATE;
    });

    btn.connect('button-release-event', () => {
        clearPressTimeout(st);
        // Stop bubble to island toggle after long-press opened picker
        if (st.pickMode || st.suppressClick)
            return Clutter.EVENT_STOP;
        return Clutter.EVENT_PROPAGATE;
    });

    btn.connect('leave-event', () => {
        clearPressTimeout(st);
        return Clutter.EVENT_PROPAGATE;
    });

    btn.connect('clicked', () => {
        if (st.suppressClick || st.pickMode) {
            st.suppressClick = false;
            return;
        }
        if (!host._island)
            return;
        try {
            const app = appInfoForId(id);
            if (app)
                app.launch([], null);
            else
                console.error(`Shortcut app missing: ${id}`);
            collapseIsland(host);
        } catch (e) {
            console.error(`Failed to launch shortcut ${id}:`, e);
        }
    });

    return btn;
}

export function rebuildShortcuts(host) {
    const st = state(host);
    const tab = host._shortcutsTab;
    if (!tab || !host._settings)
        return;

    if (st.pickMode)
        exitPickMode(host);

    if (!st.chipRow) {
        st.chipRow = new St.BoxLayout({
            style_class: 'islet-qa-chips',
            vertical: false,
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        tab.add_child(st.chipRow);
    }

    clearChildren(st.chipRow);
    const ids = resolveShortcutIds(host._settings);
    for (let i = 0; i < ids.length; i++)
        st.chipRow.add_child(makeChip(host, ids[i], i));

    st.chipRow.visible = true;
    setShortcutsReactive(host, host._isExpanded && host._currentTab === 2);
}

export function buildShortcutsTab(host) {
    const tab = new St.BoxLayout({
        style_class: 'islet-qa-box',
        vertical: true,
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.FILL,
        y_align: Clutter.ActorAlign.CENTER,
        opacity: 0,
        translation_x: 50,
        reactive: false,
    });
    host._shortcutsTab = tab;
    state(host);
    rebuildShortcuts(host);
    return tab;
}

export function setShortcutsReactive(host, on) {
    const st = state(host);
    const tab = host._shortcutsTab;
    if (!tab)
        return;

    tab.reactive = on;

    if (st.pickMode && st.pickerRoot) {
        if (st.chipRow) {
            st.chipRow.get_children().forEach(c => {
                c.reactive = false;
                c.can_focus = false;
            });
        }
        const walk = actor => {
            if (!actor)
                return;
            if (actor instanceof St.Button) {
                actor.reactive = on;
                actor.can_focus = on;
            }
            if (actor.get_children) {
                for (const c of actor.get_children())
                    walk(c);
            }
        };
        walk(st.pickerRoot);
        return;
    }

    if (st.chipRow) {
        st.chipRow.get_children().forEach(c => {
            c.reactive = on;
            c.can_focus = on;
        });
    }
}

export function onShortcutsTabHidden(host) {
    if (state(host).pickMode)
        exitPickMode(host);
}
