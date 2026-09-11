import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import UPowerGlib from 'gi://UPowerGlib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const HOVER_LEAVE_DELAY_MS = 200;
const HIT_PAD_X = 24;
const HIT_PAD_Y = 12;
const TOP_MARGIN_MIN = 0;
const TOP_MARGIN_MAX = 40;
const TAB_COUNT = 3;

export default class IsletExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._monitor = Main.layoutManager.primaryMonitor;
        this._centerX = this._monitor.x + (this._monitor.width / 2);

        const initialWidth = 170;
        const initialHeight = 43;
        const topMargin = this._clampTopMargin(this._settings.get_int('top-margin'));

        // Global states
        this._isPlaying = false;
        this._isExpanded = false;
        this._hoverActive = false;
        this._currentTab = 0;
        this._scrollAccumulator = 0;
        this._playerctlBusy = false;
        this._hoverLeaveTimeout = null;
        this._animTarget = null;
        this._tempC = 27;
        this._settingsSignals = [];
        this._focusWindowId = null;
        this._playerctlPath = GLib.find_program_in_path('playerctl');
        if (!this._playerctlPath) {
            const localBin = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'playerctl']);
            if (GLib.file_test(localBin, GLib.FileTest.IS_EXECUTABLE))
                this._playerctlPath = localBin;
        }

        // Invisible hit area — larger and more stable than the visual pill.
        this._hitArea = new St.Widget({
            reactive: true,
            can_focus: true,
            track_hover: true,
            width: initialWidth + HIT_PAD_X * 2,
            height: initialHeight + HIT_PAD_Y * 2,
        });
        this._hitArea.set_position(
            this._centerX - (initialWidth / 2) - HIT_PAD_X,
            Math.max(0, topMargin - HIT_PAD_Y)
        );

        this._island = new St.Bin({
            style_class: 'islet-container',
            reactive: true,
            can_focus: true,
            width: initialWidth,
            height: initialHeight,
            x: HIT_PAD_X,
            y: HIT_PAD_Y,
        });

        this._stack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._island.set_child(this._stack);
        this._hitArea.add_child(this._island);

        // Layer A1: Quick View (Time + Battery)
        this._quickContainer = new St.BoxLayout({
            style_class: 'islet-quick-box',
            vertical: false,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 0,
        });
        this._quickTime = new St.Label({
            text: '--:--',
            style_class: 'islet-text',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this._quickBattery = new St.Label({
            text: '--%',
            style_class: 'islet-text',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.END,
        });
        this._quickContainer.add_child(this._quickTime);
        this._quickContainer.add_child(this._quickBattery);

        // Layer A2: Media Playing
        this._mediaQuickContainer = new St.BoxLayout({
            style_class: 'islet-media-box',
            vertical: false,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 0,
        });

        let musicIcon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            style_class: 'islet-media-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._mediaTitle = new St.Label({
            text: 'Not Playing',
            style_class: 'islet-media-title',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._mediaArtist = new St.Label({
            text: ' • Unknown',
            style_class: 'islet-media-artist',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._mediaQuickContainer.add_child(musicIcon);
        this._mediaQuickContainer.add_child(this._mediaTitle);
        this._mediaQuickContainer.add_child(this._mediaArtist);

        // Layer B: Large View
        this._largeContainer = new St.BoxLayout({
            style_class: 'islet-large-box',
            vertical: true,
            x_expand: true,
            y_expand: true,
            opacity: 0,
        });

        let topRow = new St.BoxLayout({ x_expand: true, y_align: Clutter.ActorAlign.START });
        this._largeWeather = new St.Label({ text: '--°C', style_class: 'islet-weather' });
        let spacer = new St.Widget({ x_expand: true });
        this._largeBattery = new St.Label({ text: '70%', style_class: 'islet-battery-pill' });
        topRow.add_child(this._largeWeather);
        topRow.add_child(spacer);
        topRow.add_child(this._largeBattery);

        this._largeContentStack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });

        // Tab 0: Overview
        this._overviewTab = new St.BoxLayout({
            vertical: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._largeTime = new St.Label({ text: '16:59', style_class: 'islet-large-time' });
        this._largeDate = new St.Label({
            text: 'Sat, Dec 27',
            style_class: 'islet-large-date',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._overviewTab.add_child(this._largeTime);
        this._overviewTab.add_child(this._largeDate);

        // Tab 1: Shortcuts
        this._shortcutsTab = new St.BoxLayout({
            style_class: 'islet-qa-box',
            vertical: false,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 0,
            translation_x: 50,
            reactive: false,
        });

        const quickApps = [
            { name: 'Term', cmd: 'gnome-terminal' },
            { name: 'Files', cmd: 'nautilus' },
            { name: 'Calc', cmd: 'gnome-calculator' },
            { name: 'Browser', uri: 'https://' },
        ];

        quickApps.forEach(app => {
            let btn = new St.Button({
                label: app.name,
                style_class: 'islet-qa-button',
                reactive: true,
                can_focus: true,
            });

            btn.connect('clicked', () => {
                if (!this._island)
                    return;
                try {
                    if (app.uri)
                        Gio.AppInfo.launch_default_for_uri(app.uri, null);
                    else
                        GLib.spawn_command_line_async(app.cmd);
                    this._isExpanded = false;
                    this._currentTab = 0;
                    this._setExpandedTabPickable(false);
                    this._updateIslandView();
                } catch (e) {
                    console.error(`Failed to launch ${app.name}:`, e);
                }
            });

            this._shortcutsTab.add_child(btn);
        });

        // Tab 2: Settings
        this._settingsTab = this._buildSettingsTab();

        this._largeContentStack.add_child(this._overviewTab);
        this._largeContentStack.add_child(this._shortcutsTab);
        this._largeContentStack.add_child(this._settingsTab);
        this._largeContainer.add_child(topRow);
        this._largeContainer.add_child(this._largeContentStack);

        this._stack.add_child(this._quickContainer);
        this._stack.add_child(this._mediaQuickContainer);
        this._stack.add_child(this._largeContainer);

        Main.layoutManager.uiGroup.add_child(this._hitArea);

        this._setupClock();
        this._setupBattery();
        this._setupSpotify();
        this._setupAnimations(initialWidth, initialHeight, topMargin);
        this._setupGestures();
        this._setupSettingsBindings();
        this._setupAutoCollapse();
        this._updateWeatherLabel();
        this._syncSettingsUi();
        this._setExpandedTabPickable(false);
    }

    _clampTopMargin(value) {
        return Math.max(TOP_MARGIN_MIN, Math.min(TOP_MARGIN_MAX, value));
    }

    _buildSettingsTab() {
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

        tab.add_child(this._buildSettingRow('Temp', [
            { label: '°C', value: 'celsius', key: 'temperature-unit' },
            { label: '°F', value: 'fahrenheit', key: 'temperature-unit' },
        ], 'temperature-unit'));

        tab.add_child(this._buildSettingRow('Clock', [
            { label: '24h', value: '24h', key: 'clock-format' },
            { label: '12h', value: '12h', key: 'clock-format' },
        ], 'clock-format'));

        tab.add_child(this._buildSettingRow('Collapse', [
            { label: 'On', value: true, key: 'auto-collapse' },
            { label: 'Off', value: false, key: 'auto-collapse' },
        ], 'auto-collapse'));

        // Position row
        const posRow = new St.BoxLayout({
            style_class: 'islet-settings-row',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        posRow.add_child(new St.Label({
            text: 'Position',
            style_class: 'islet-settings-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        }));

        const minusBtn = new St.Button({
            label: '−',
            style_class: 'islet-settings-chip',
            reactive: true,
            can_focus: true,
        });
        this._marginValueLabel = new St.Label({
            text: `${this._clampTopMargin(this._settings.get_int('top-margin'))}`,
            style_class: 'islet-settings-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const plusBtn = new St.Button({
            label: '+',
            style_class: 'islet-settings-chip',
            reactive: true,
            can_focus: true,
        });

        minusBtn.connect('clicked', () => {
            const next = this._clampTopMargin(this._settings.get_int('top-margin') - 2);
            this._settings.set_int('top-margin', next);
        });
        plusBtn.connect('clicked', () => {
            const next = this._clampTopMargin(this._settings.get_int('top-margin') + 2);
            this._settings.set_int('top-margin', next);
        });

        posRow.add_child(minusBtn);
        posRow.add_child(this._marginValueLabel);
        posRow.add_child(plusBtn);
        tab.add_child(posRow);

        return tab;
    }

    _buildSettingRow(title, options, key) {
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

        if (!this._settingsButtons)
            this._settingsButtons = {};
        this._settingsButtons[key] = [];

        options.forEach(opt => {
            const btn = new St.Button({
                label: opt.label,
                style_class: 'islet-settings-chip',
                reactive: true,
                can_focus: true,
            });
            btn._isletValue = opt.value;
            btn.connect('clicked', () => {
                if (typeof opt.value === 'boolean')
                    this._settings.set_boolean(key, opt.value);
                else
                    this._settings.set_string(key, opt.value);
            });
            this._settingsButtons[key].push(btn);
            segment.add_child(btn);
        });

        row.add_child(segment);
        return row;
    }

    _syncSettingsUi() {
        if (!this._settingsButtons)
            return;

        const unit = this._settings.get_string('temperature-unit');
        const clock = this._settings.get_string('clock-format');
        const autoCollapse = this._settings.get_boolean('auto-collapse');
        const margin = this._clampTopMargin(this._settings.get_int('top-margin'));

        const apply = (key, current) => {
            (this._settingsButtons[key] || []).forEach(btn => {
                if (btn._isletValue === current)
                    btn.add_style_class_name('islet-settings-chip-active');
                else
                    btn.remove_style_class_name('islet-settings-chip-active');
            });
        };

        apply('temperature-unit', unit);
        apply('clock-format', clock);
        apply('auto-collapse', autoCollapse);

        if (this._marginValueLabel)
            this._marginValueLabel.set_text(`${margin}`);
    }

    _setupSettingsBindings() {
        const bind = (key, cb) => {
            const id = this._settings.connect(`changed::${key}`, cb);
            this._settingsSignals.push(id);
        };

        bind('temperature-unit', () => {
            this._updateWeatherLabel();
            this._syncSettingsUi();
        });
        bind('clock-format', () => {
            this._updateTime();
            this._syncSettingsUi();
        });
        bind('auto-collapse', () => this._syncSettingsUi());
        bind('top-margin', () => {
            this._applyTopMargin(this._settings.get_int('top-margin'));
            this._syncSettingsUi();
        });
    }

    _applyTopMargin(value) {
        this._topMargin = this._clampTopMargin(value);
        this._animTarget = null;
        this._updateIslandView();
    }

    _updateWeatherLabel() {
        if (!this._largeWeather)
            return;
        const unit = this._settings.get_string('temperature-unit');
        if (unit === 'fahrenheit') {
            const f = Math.round(this._tempC * 9 / 5 + 32);
            this._largeWeather.set_text(`${f}°F`);
        } else {
            this._largeWeather.set_text(`${Math.round(this._tempC)}°C`);
        }
    }

    _setupAutoCollapse() {
        this._focusWindowId = global.display.connect('notify::focus-window', () => {
            if (!this._island || !this._isExpanded)
                return;
            if (!this._settings.get_boolean('auto-collapse'))
                return;

            const focus = global.display.focus_window;
            // Collapse when a normal client window takes focus
            if (focus && focus.get_window_type && focus.get_window_type() === Meta.WindowType.NORMAL) {
                this._isExpanded = false;
                this._currentTab = 0;
                this._hoverActive = false;
                this._setExpandedTabPickable(false);
                this._updateIslandView();
            }
        });
    }

    _clearHoverLeaveTimeout() {
        if (this._hoverLeaveTimeout) {
            GLib.source_remove(this._hoverLeaveTimeout);
            this._hoverLeaveTimeout = null;
        }
    }

    _setupGestures() {
        const onScroll = (actor, event) => {
            if (!this._island || !this._isExpanded)
                return Clutter.EVENT_PROPAGATE;

            let direction = event.get_scroll_direction();
            let dx = 0;
            let deltaX = 0;
            let deltaY = 0;
            const now = GLib.get_monotonic_time() / 1000; // ms

            if (direction === Clutter.ScrollDirection.SMOOTH) {
                [deltaX, deltaY] = event.get_scroll_delta();
                dx = Math.abs(deltaX) >= Math.abs(deltaY) ? deltaX : deltaY;
                this._lastSmoothScrollMs = now;
            } else if (direction === Clutter.ScrollDirection.UP ||
                       direction === Clutter.ScrollDirection.LEFT) {
                // Touchpads emit discrete events alongside SMOOTH — ignore duplicates
                if (now - (this._lastSmoothScrollMs || 0) < 80)
                    return Clutter.EVENT_STOP;
                dx = -1;
            } else if (direction === Clutter.ScrollDirection.DOWN ||
                       direction === Clutter.ScrollDirection.RIGHT) {
                if (now - (this._lastSmoothScrollMs || 0) < 80)
                    return Clutter.EVENT_STOP;
                dx = 1;
            }

            // One gesture = one tab change
            if (now - (this._lastTabSwitchMs || 0) < 400) {
                this._scrollAccumulator = 0;
                return Clutter.EVENT_STOP;
            }

            this._scrollAccumulator += dx;

            if (this._scrollAccumulator > 1.2) {
                const next = Math.min(this._currentTab + 1, TAB_COUNT - 1);
                this._switchTab(next);
                this._scrollAccumulator = 0;
            } else if (this._scrollAccumulator < -1.2) {
                const prev = Math.max(this._currentTab - 1, 0);
                this._switchTab(prev);
                this._scrollAccumulator = 0;
            }

            return Clutter.EVENT_STOP;
        };

        // Island is reactive and sits above the hit pad, so it must handle scroll too
        this._island.connect('scroll-event', onScroll);
        this._hitArea.connect('scroll-event', onScroll);
    }

    _switchTab(index) {
        if (!this._island || this._currentTab === index)
            return;
        if (index < 0 || index >= TAB_COUNT)
            return;

        this._currentTab = index;
        this._lastTabSwitchMs = GLib.get_monotonic_time() / 1000;

        const duration = 250;
        const mode = Clutter.AnimationMode.EASE_OUT_QUINT;
        const tabs = [this._overviewTab, this._shortcutsTab, this._settingsTab];

        tabs.forEach((tab, i) => {
            if (!tab)
                return;
            const active = i === index;
            tab.reactive = active;
            if (active) {
                tab.ease({ opacity: 255, translation_x: 0, duration, mode });
            } else if (i < index) {
                tab.ease({ opacity: 0, translation_x: -50, duration, mode });
            } else {
                tab.ease({ opacity: 0, translation_x: 50, duration, mode });
            }
        });

        this._setExpandedTabPickable(this._isExpanded);
    }

    _setExpandedTabPickable(expanded) {
        const tabs = [this._overviewTab, this._shortcutsTab, this._settingsTab];
        tabs.forEach((tab, i) => {
            if (!tab)
                return;
            tab.reactive = expanded && i === this._currentTab;
        });
        if (this._largeContainer)
            this._largeContainer.reactive = expanded;

        // Parent.reactive=false is not enough — St.Button children still receive clicks
        const shortcutsOn = expanded && this._currentTab === 1;
        if (this._shortcutsTab) {
            this._shortcutsTab.get_children().forEach(child => {
                child.reactive = shortcutsOn;
                child.can_focus = shortcutsOn;
            });
        }
        const settingsOn = expanded && this._currentTab === 2;
        if (this._settingsTab) {
            this._settingsTab.get_children().forEach(row => {
                row.get_children().forEach(child => {
                    if (child instanceof St.Button) {
                        child.reactive = settingsOn;
                        child.can_focus = settingsOn;
                    } else if (child.get_children) {
                        child.get_children().forEach(grand => {
                            if (grand instanceof St.Button) {
                                grand.reactive = settingsOn;
                                grand.can_focus = settingsOn;
                            }
                        });
                    }
                });
            });
        }
    }

    _setupSpotify() {
        this._updateSpotifyState();
        this._spotifyTimeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            this._updateSpotifyState();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _updateSpotifyState() {
        if (!this._island || this._playerctlBusy)
            return;

        if (!this._playerctlPath) {
            this._playerctlPath = GLib.find_program_in_path('playerctl');
            if (!this._playerctlPath)
                return;
        }

        try {
            this._playerctlBusy = true;
            let proc = Gio.Subprocess.new(
                [this._playerctlPath, 'metadata', '--format', '{{title}}||{{artist}}||{{status}}'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );

            proc.communicate_utf8_async(null, null, (proc, res) => {
                this._playerctlBusy = false;

                if (!this._island)
                    return;

                try {
                    let [success, stdout] = proc.communicate_utf8_finish(res);
                    if (success && stdout) {
                        let parts = stdout.trim().split('||');
                        if (parts.length >= 3) {
                            let title = parts[0] || 'Unknown';
                            let artist = parts[1] || 'Unknown';
                            let status = parts[2].toLowerCase();

                            this._isPlaying = status === 'playing';
                            this._mediaTitle.set_text(title);
                            this._mediaArtist.set_text(` • ${artist}`);
                            this._updateIslandView();
                            return;
                        }
                    }
                } catch (e) {
                    // no active player
                }

                if (this._isPlaying) {
                    this._isPlaying = false;
                    this._updateIslandView();
                }
            });
        } catch (e) {
            this._playerctlBusy = false;
            console.error('Failed to launch playerctl:', e);
            if (this._isPlaying && this._island) {
                this._isPlaying = false;
                this._updateIslandView();
            }
        }
    }

    _setupAnimations(initialWidth, initialHeight, topMargin) {
        this._initialWidth = initialWidth;
        this._initialHeight = initialHeight;
        this._topMargin = topMargin;

        // Use notify::hover — leave-event can still report hover=true mid-handler.
        this._hitArea.connect('notify::hover', () => {
            if (!this._island)
                return;

            if (this._hitArea.hover) {
                this._clearHoverLeaveTimeout();
                this._hoverActive = true;
                if (!this._isExpanded)
                    this._updateIslandView();
            } else {
                this._scrollAccumulator = 0;
                this._clearHoverLeaveTimeout();
                this._hoverLeaveTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOVER_LEAVE_DELAY_MS, () => {
                    this._hoverLeaveTimeout = null;
                    if (!this._island)
                        return GLib.SOURCE_REMOVE;
                    if (!this._hitArea.hover) {
                        this._hoverActive = false;
                        if (!this._isExpanded)
                            this._updateIslandView();
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
        });

        this._island.connect('button-release-event', () => {
            if (!this._island)
                return Clutter.EVENT_STOP;
            this._isExpanded = !this._isExpanded;
            if (this._isExpanded) {
                this._currentTab = 0;
                this._overviewTab.opacity = 255;
                this._overviewTab.translation_x = 0;
                this._shortcutsTab.opacity = 0;
                this._shortcutsTab.translation_x = 50;
                this._settingsTab.opacity = 0;
                this._settingsTab.translation_x = 50;
            }
            this._setExpandedTabPickable(this._isExpanded);
            this._updateIslandView();
            return Clutter.EVENT_STOP;
        });
    }

    _updateIslandView() {
        if (!this._island)
            return;

        let targetWidth, targetHeight, quickOp, mediaOp, largeOp;

        if (this._isExpanded) {
            targetWidth = 380;
            targetHeight = 210;
            quickOp = 0;
            mediaOp = 0;
            largeOp = 255;
        } else if (this._hoverActive) {
            targetHeight = this._initialHeight;
            largeOp = 0;
            if (this._isPlaying) {
                targetWidth = 300;
                quickOp = 0;
                mediaOp = 255;
            } else {
                targetWidth = 265;
                quickOp = 255;
                mediaOp = 0;
            }
        } else {
            targetHeight = this._initialHeight;
            largeOp = 0;
            if (this._isPlaying) {
                targetWidth = 265;
                quickOp = 0;
                mediaOp = 255;
            } else {
                targetWidth = this._initialWidth;
                quickOp = 0;
                mediaOp = 0;
            }
        }

        this._animateTo(targetWidth, targetHeight, quickOp, mediaOp, largeOp);
    }

    _animateTo(targetWidth, targetHeight, quickOpacity, mediaOpacity, largeOpacity) {
        if (!this._island || !this._hitArea)
            return;

        const next = {
            targetWidth,
            targetHeight,
            quickOpacity,
            mediaOpacity,
            largeOpacity,
            topMargin: this._topMargin,
        };
        if (this._animTarget &&
            this._animTarget.targetWidth === next.targetWidth &&
            this._animTarget.targetHeight === next.targetHeight &&
            this._animTarget.quickOpacity === next.quickOpacity &&
            this._animTarget.mediaOpacity === next.mediaOpacity &&
            this._animTarget.largeOpacity === next.largeOpacity &&
            this._animTarget.topMargin === next.topMargin) {
            return;
        }
        this._animTarget = next;

        const hitW = targetWidth + HIT_PAD_X * 2;
        const hitH = targetHeight + HIT_PAD_Y * 2;
        const hitX = this._centerX - (targetWidth / 2) - HIT_PAD_X;
        const hitY = Math.max(0, this._topMargin - HIT_PAD_Y);

        this._hitArea.ease({
            width: hitW,
            height: hitH,
            x: hitX,
            y: hitY,
            duration: 350,
            mode: Clutter.AnimationMode.EASE_OUT_QUINT,
        });

        this._island.ease({
            width: targetWidth,
            height: targetHeight,
            x: HIT_PAD_X,
            y: HIT_PAD_Y,
            duration: 350,
            mode: Clutter.AnimationMode.EASE_OUT_QUINT,
        });

        this._quickContainer.ease({
            opacity: quickOpacity,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._mediaQuickContainer.ease({
            opacity: mediaOpacity,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        // Hide large panel immediately when collapsing so an empty tall pill
        // doesn't flash as a transparent bottom frame while height eases down.
        if (largeOpacity === 0) {
            this._largeContainer.remove_all_transitions();
            this._largeContainer.opacity = 0;
        } else {
            this._largeContainer.ease({
                opacity: largeOpacity,
                duration: 250,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    _setupClock() {
        this._updateTime();
        this._timeTimeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._updateTime();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _updateTime() {
        if (!this._island)
            return;
        let now = GLib.DateTime.new_now_local();
        const fmt = this._settings.get_string('clock-format') === '12h' ? '%I:%M %p' : '%H:%M';
        let timeStr = now.format(fmt);
        // Strip leading zero for 12h on some locales if present as space-padded
        if (this._settings.get_string('clock-format') === '12h')
            timeStr = timeStr.replace(/^0/, '');
        this._quickTime.set_text(timeStr);
        this._largeTime.set_text(timeStr);
        this._largeDate.set_text(now.format('%a, %b %d'));
    }

    _setupBattery() {
        try {
            this._upClient = UPowerGlib.Client.new_full(null);
            this._displayDevice = this._upClient.get_display_device();
            this._updateBattery();
            this._batterySignalId = this._displayDevice.connect('notify::percentage', () => this._updateBattery());
        } catch (e) {
            this._quickBattery.set_text('AC');
            this._largeBattery.set_text('AC');
        }
    }

    _updateBattery() {
        if (!this._island || !this._displayDevice)
            return;
        let pctStr = `${Math.round(this._displayDevice.percentage)}%`;
        this._quickBattery.set_text(pctStr);
        this._largeBattery.set_text(pctStr);
    }

    _removeTransitions() {
        const actors = [
            this._island,
            this._hitArea,
            this._quickContainer,
            this._mediaQuickContainer,
            this._largeContainer,
            this._overviewTab,
            this._shortcutsTab,
            this._settingsTab,
        ];
        for (const actor of actors) {
            if (actor)
                actor.remove_all_transitions();
        }
    }

    disable() {
        this._clearHoverLeaveTimeout();
        this._playerctlBusy = false;

        if (this._focusWindowId) {
            global.display.disconnect(this._focusWindowId);
            this._focusWindowId = null;
        }

        if (this._settings && this._settingsSignals) {
            for (const id of this._settingsSignals)
                this._settings.disconnect(id);
            this._settingsSignals = [];
        }

        if (this._spotifyTimeout) {
            GLib.source_remove(this._spotifyTimeout);
            this._spotifyTimeout = null;
        }
        if (this._timeTimeout) {
            GLib.source_remove(this._timeTimeout);
            this._timeTimeout = null;
        }
        if (this._displayDevice && this._batterySignalId) {
            this._displayDevice.disconnect(this._batterySignalId);
            this._batterySignalId = null;
        }

        this._removeTransitions();

        if (this._hitArea) {
            this._hitArea.destroy();
            this._hitArea = null;
        }
        this._island = null;
        this._animTarget = null;
        this._upClient = null;
        this._displayDevice = null;
        this._settings = null;
        this._settingsButtons = null;
    }
}
