import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import UPowerGlib from 'gi://UPowerGlib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    HOVER_LEAVE_DELAY_MS,
    HIT_PAD_X,
    HIT_PAD_BOTTOM,
    TAB_COUNT,
    EXPANDED_HEIGHT,
    MEDIA_COMPACT_WIDTH,
    MEDIA_HOVER_WIDTH,
    BATTERY_BANNER_MS,
    BATTERY_BANNER_WIDTH,
    BATTERY_BANNER_HEIGHT,
    LOW_BATTERY_PCT,
    EXPERIMENTAL_FINGERPRINT,
    AUTH_SQUARE_SIZE,
    AUTH_SUCCESS_HOLD_MS,
    AUTH_SHAKE_MS,
} from './lib/constants.js';
import { createHttpGet, startWeatherPolling, formatTemperature } from './lib/weather.js';
import { MediaController } from './lib/media.js';
import { buildSettingsTab, syncSettingsUi, clampMargin } from './lib/settingsUi.js';
import { buildBatteryBanner } from './lib/batteryBannerUi.js';
import { FingerprintAuthMonitor } from './lib/fingerprintAuth.js';
import { buildFingerprintUi } from './lib/fingerprintUi.js';

export default class IsletExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._monitor = Main.layoutManager.primaryMonitor;
        this._centerX = this._monitor.x + (this._monitor.width / 2);

        const initialWidth = 170;
        const initialHeight = 40;
        const topMargin = clampMargin(this._settings.get_int('top-margin'));

        this._isPlaying = false;
        this._isExpanded = false;
        this._hoverActive = false;
        this._currentTab = 0;
        this._scrollAccumulator = 0;
        this._hoverLeaveTimeout = null;
        this._animTarget = null;
        this._tempC = null;
        this._settingsSignals = [];
        this._focusWindowId = null;
        this._stageCaptureId = null;
        this._dismissShade = null;
        this._soup = new Soup.Session();
        this._media = new MediaController(this);
        this._isBatteryBanner = false;
        this._bannerTimeout = null;
        this._prevUpState = null;
        this._prevPct = null;
        this._lowBatteryArmed = true;
        this._batteryStateSignalId = null;
        this._isFingerprintAuth = false;
        this._fingerprintSuccessPending = false;
        this._fingerprintHoldTimeout = null;
        this._fingerprintMonitor = null;
        this._fingerprintUi = null;
        this._shieldSignalId = null;

        // Hit area: side + bottom pad only (no top pad — peninsula flush to screen edge)
        this._hitArea = new St.Widget({
            reactive: true,
            can_focus: true,
            track_hover: true,
            width: initialWidth + HIT_PAD_X * 2,
            height: initialHeight + HIT_PAD_BOTTOM,
        });
        this._hitArea.set_position(
            this._centerX - (initialWidth / 2) - HIT_PAD_X,
            topMargin
        );

        this._island = new St.Bin({
            style_class: 'islet-container',
            reactive: true,
            can_focus: true,
            width: initialWidth,
            height: initialHeight,
            x: HIT_PAD_X,
            y: 0,
        });

        this._stack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._island.set_child(this._stack);
        this._hitArea.add_child(this._island);

        // Quick view: time + battery
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

        // Quick view: now playing — album art + spectrum
        this._mediaQuickContainer = this._media.buildQuickStrip();

        // Large expanded panel
        this._largeContainer = new St.BoxLayout({
            style_class: 'islet-large-box',
            vertical: true,
            x_expand: true,
            y_expand: true,
            opacity: 0,
        });

        const topRow = new St.BoxLayout({ x_expand: true, y_align: Clutter.ActorAlign.START });
        this._largeWeather = new St.Label({ text: '--°C', style_class: 'islet-weather' });
        const spacer = new St.Widget({ x_expand: true });
        this._largeBattery = new St.Label({ text: '--%', style_class: 'islet-battery-pill' });
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

        // Tab 1: Media card
        this._mediaTab = this._media.buildTab();

        // Tab 2: Shortcuts
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
            const btn = new St.Button({
                label: app.name,
                style_class: 'islet-qa-button',
                reactive: false,
                can_focus: false,
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

        // Tab 3: Settings
        this._settingsTab = buildSettingsTab(this);

        this._largeContentStack.add_child(this._overviewTab);
        this._largeContentStack.add_child(this._mediaTab);
        this._largeContentStack.add_child(this._shortcutsTab);
        this._largeContentStack.add_child(this._settingsTab);
        this._largeContainer.add_child(topRow);
        this._largeContainer.add_child(this._largeContentStack);

        this._batteryBanner = buildBatteryBanner();
        this._batteryBannerContainer = this._batteryBanner.box;

        this._fingerprintUi = buildFingerprintUi();
        this._fingerprintContainer = this._fingerprintUi.root;

        this._stack.add_child(this._quickContainer);
        this._stack.add_child(this._mediaQuickContainer);
        this._stack.add_child(this._largeContainer);
        this._stack.add_child(this._batteryBannerContainer);
        this._stack.add_child(this._fingerprintContainer);

        Main.layoutManager.uiGroup.add_child(this._hitArea);

        this._setupClock();
        this._setupBattery();
        this._media.startMetaPolling();
        this._setupWeather();
        this._setupAnimations(initialWidth, initialHeight, topMargin);
        this._setupGestures();
        this._setupSettingsBindings();
        this._setupAutoCollapse();
        this._setupFingerprintAuth();
        this._updateWeatherLabel();
        syncSettingsUi(this);
        this._setExpandedTabPickable(false);
        this._media.showPlaceholder();
    }

    _setupWeather() {
        const httpGet = createHttpGet(this._soup);
        this._weatherTimeout = startWeatherPolling({
            httpGet,
            isAlive: () => !!this._island,
            onTemp: temp => {
                if (temp != null)
                    this._tempC = temp;
                this._updateWeatherLabel();
            },
        });
    }

    _updateWeatherLabel() {
        if (!this._largeWeather)
            return;
        const unit = this._settings.get_string('temperature-unit');
        this._largeWeather.set_text(formatTemperature(this._tempC, unit));
    }

    _setupSettingsBindings() {
        const bind = (key, cb) => {
            this._settingsSignals.push(this._settings.connect(`changed::${key}`, cb));
        };

        bind('temperature-unit', () => {
            this._updateWeatherLabel();
            syncSettingsUi(this);
        });
        bind('clock-format', () => {
            this._updateTime();
            syncSettingsUi(this);
        });
        bind('auto-collapse', () => {
            syncSettingsUi(this);
            if (this._isExpanded && this._autoCollapseEnabled())
                this._showDismissShade();
            else
                this._hideDismissShade();
        });
        bind('top-margin', () => {
            this._applyTopMargin(this._settings.get_int('top-margin'));
            syncSettingsUi(this);
        });
    }

    _applyTopMargin(value) {
        this._topMargin = clampMargin(value);
        this._animTarget = null;
        this._updateIslandView();
    }

    _collapseExpanded() {
        if (!this._island || !this._isExpanded)
            return;
        this._isExpanded = false;
        this._currentTab = 0;
        this._hoverActive = false;
        this._setExpandedTabPickable(false);
        this._hideDismissShade();
        this._updateIslandView();
    }

    _autoCollapseEnabled() {
        return !!this._settings?.get_boolean('auto-collapse');
    }

    _isPointerOnIsland(event) {
        if (!this._hitArea)
            return false;

        const source = event.get_source?.() ?? null;
        if (source && this._hitArea.contains(source))
            return true;

        const [x, y] = event.get_coords();
        const [ax, ay] = this._hitArea.get_transformed_position();
        const [aw, ah] = this._hitArea.get_transformed_size();
        return x >= ax && x <= ax + aw && y >= ay && y <= ay + ah;
    }

    _showDismissShade() {
        if (!this._autoCollapseEnabled() || !this._hitArea)
            return;

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        if (!this._dismissShade) {
            this._dismissShade = new St.Widget({
                name: 'islet-dismiss-shade',
                reactive: true,
                can_focus: false,
                opacity: 0,
            });
            this._dismissShade.connect('button-press-event', () => {
                this._collapseExpanded();
                return Clutter.EVENT_STOP;
            });
            this._dismissShade.connect('touch-event', (_a, event) => {
                if (event.type() === Clutter.EventType.TOUCH_BEGIN) {
                    this._collapseExpanded();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
        }

        this._dismissShade.set_position(monitor.x, monitor.y);
        this._dismissShade.set_size(monitor.width, monitor.height);

        const parent = this._hitArea.get_parent();
        if (parent) {
            if (this._dismissShade.get_parent() !== parent)
                parent.insert_child_below(this._dismissShade, this._hitArea);
            else
                parent.set_child_below_sibling(this._dismissShade, this._hitArea);
        }
        this._dismissShade.show();
    }

    _hideDismissShade() {
        if (this._dismissShade)
            this._dismissShade.hide();
    }

    _destroyDismissShade() {
        if (!this._dismissShade)
            return;
        this._dismissShade.destroy();
        this._dismissShade = null;
    }

    _setupAutoCollapse() {
        // Shell chrome (panel, etc.)
        this._stageCaptureId = global.stage.connect('captured-event', (_actor, event) => {
            if (!this._island || !this._isExpanded || !this._autoCollapseEnabled())
                return Clutter.EVENT_PROPAGATE;
            if (this._isFingerprintAuth || this._isBatteryBanner)
                return Clutter.EVENT_PROPAGATE;

            const type = event.type();
            if (type !== Clutter.EventType.BUTTON_PRESS &&
                type !== Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;

            if (!this._isPointerOnIsland(event))
                this._collapseExpanded();

            return Clutter.EVENT_PROPAGATE;
        });

        // Focus change between windows
        this._focusWindowId = global.display.connect('notify::focus-window', () => {
            if (!this._island || !this._isExpanded || !this._autoCollapseEnabled())
                return;

            const focus = global.display.focus_window;
            if (focus && focus.get_window_type && focus.get_window_type() === Meta.WindowType.NORMAL)
                this._collapseExpanded();
        });
    }

    _clearHoverLeaveTimeout() {
        if (this._hoverLeaveTimeout) {
            GLib.source_remove(this._hoverLeaveTimeout);
            this._hoverLeaveTimeout = null;
        }
    }

    _setupGestures() {
        const onScroll = (_actor, event) => {
            if (!this._island || !this._isExpanded)
                return Clutter.EVENT_PROPAGATE;

            const direction = event.get_scroll_direction();
            let dx = 0;
            let deltaX = 0;
            let deltaY = 0;
            const now = GLib.get_monotonic_time() / 1000;

            if (direction === Clutter.ScrollDirection.SMOOTH) {
                [deltaX, deltaY] = event.get_scroll_delta();
                dx = Math.abs(deltaX) >= Math.abs(deltaY) ? deltaX : deltaY;
                this._lastSmoothScrollMs = now;
            } else if (direction === Clutter.ScrollDirection.UP ||
                       direction === Clutter.ScrollDirection.LEFT) {
                if (now - (this._lastSmoothScrollMs || 0) < 80)
                    return Clutter.EVENT_STOP;
                dx = -1;
            } else if (direction === Clutter.ScrollDirection.DOWN ||
                       direction === Clutter.ScrollDirection.RIGHT) {
                if (now - (this._lastSmoothScrollMs || 0) < 80)
                    return Clutter.EVENT_STOP;
                dx = 1;
            }

            if (now - (this._lastTabSwitchMs || 0) < 400) {
                this._scrollAccumulator = 0;
                return Clutter.EVENT_STOP;
            }

            this._scrollAccumulator += dx;

            if (this._scrollAccumulator > 1.2) {
                this._switchTab((this._currentTab + 1) % TAB_COUNT);
                this._scrollAccumulator = 0;
            } else if (this._scrollAccumulator < -1.2) {
                this._switchTab((this._currentTab - 1 + TAB_COUNT) % TAB_COUNT);
                this._scrollAccumulator = 0;
            }

            return Clutter.EVENT_STOP;
        };

        this._island.connect('scroll-event', onScroll);
        this._hitArea.connect('scroll-event', onScroll);
    }

    _allTabs() {
        return [this._overviewTab, this._mediaTab, this._shortcutsTab, this._settingsTab];
    }

    _switchTab(index) {
        if (!this._island || this._currentTab === index)
            return;
        if (index < 0 || index >= TAB_COUNT)
            return;

        const from = this._currentTab;
        const stepsFwd = (index - from + TAB_COUNT) % TAB_COUNT;
        const goingForward = stepsFwd > 0 && stepsFwd <= TAB_COUNT / 2;

        this._currentTab = index;
        this._lastTabSwitchMs = GLib.get_monotonic_time() / 1000;

        const duration = 250;
        const mode = Clutter.AnimationMode.EASE_OUT_QUINT;
        const tabs = this._allTabs();

        tabs.forEach((tab, i) => {
            if (!tab)
                return;
            tab.reactive = i === index;
            if (i === index) {
                tab.translation_x = goingForward ? 50 : -50;
                tab.ease({ opacity: 255, translation_x: 0, duration, mode });
            } else if (i === from) {
                tab.ease({
                    opacity: 0,
                    translation_x: goingForward ? -50 : 50,
                    duration,
                    mode,
                });
            } else {
                tab.remove_all_transitions();
                tab.opacity = 0;
                tab.translation_x = goingForward ? 50 : -50;
            }
        });

        this._setExpandedTabPickable(this._isExpanded);
        this._animTarget = null;
        this._updateIslandView();
    }

    _setExpandedTabPickable(expanded) {
        const tabs = this._allTabs();
        tabs.forEach((tab, i) => {
            if (!tab)
                return;
            tab.reactive = expanded && i === this._currentTab;
        });
        if (this._largeContainer)
            this._largeContainer.reactive = expanded;

        this._media?.setControlsReactive(expanded && this._currentTab === 1);

        const shortcutsOn = expanded && this._currentTab === 2;
        if (this._shortcutsTab) {
            this._shortcutsTab.get_children().forEach(child => {
                child.reactive = shortcutsOn;
                child.can_focus = shortcutsOn;
            });
        }

        const settingsOn = expanded && this._currentTab === 3;
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

    _setupAnimations(initialWidth, initialHeight, topMargin) {
        this._initialWidth = initialWidth;
        this._initialHeight = initialHeight;
        this._topMargin = topMargin;

        this._hitArea.connect('notify::hover', () => {
            if (!this._island || this._isBatteryBanner || this._isFingerprintAuth)
                return;

            if (this._hitArea.hover) {
                this._clearHoverLeaveTimeout();
                this._hoverActive = true;
                if (!this._isExpanded)
                    this._updateIslandView();
            } else {
                this._scrollAccumulator = 0;
                this._clearHoverLeaveTimeout();
                // Expanded: leave immediately so moving back to a window collapses
                // before the click, and the app receives the interaction.
                if (this._isExpanded && this._autoCollapseEnabled()) {
                    this._collapseExpanded();
                    return;
                }

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
            if (this._isBatteryBanner || this._isFingerprintAuth)
                return Clutter.EVENT_STOP;
            this._isExpanded = !this._isExpanded;
            if (this._isExpanded) {
                // Playing → open media tab first; otherwise overview
                const startTab = this._isPlaying ? 1 : 0;
                this._showExpandedAtTab(startTab);
                this._showDismissShade();
            } else {
                this._hideDismissShade();
            }
            this._setExpandedTabPickable(this._isExpanded);
            this._updateIslandView();
            return Clutter.EVENT_STOP;
        });
    }

    _showExpandedAtTab(startTab) {
        this._currentTab = startTab;
        const tabs = this._allTabs();
        tabs.forEach((tab, i) => {
            if (!tab)
                return;
            if (i === startTab) {
                tab.opacity = 255;
                tab.translation_x = 0;
            } else {
                tab.opacity = 0;
                tab.translation_x = i < startTab ? -50 : 50;
            }
        });
    }

    _updateIslandView() {
        if (!this._island)
            return;

        let targetWidth, targetHeight, quickOp, mediaOp, largeOp, bannerOp, authOp;

        if (this._isFingerprintAuth) {
            targetWidth = AUTH_SQUARE_SIZE;
            targetHeight = AUTH_SQUARE_SIZE;
            quickOp = 0;
            mediaOp = 0;
            largeOp = 0;
            bannerOp = 0;
            authOp = 255;
            this._animateTo(targetWidth, targetHeight, quickOp, mediaOp, largeOp, bannerOp, authOp);
            return;
        }

        authOp = 0;

        if (this._isBatteryBanner) {
            targetWidth = BATTERY_BANNER_WIDTH;
            targetHeight = BATTERY_BANNER_HEIGHT;
            quickOp = 0;
            mediaOp = 0;
            largeOp = 0;
            bannerOp = 255;
            this._animateTo(targetWidth, targetHeight, quickOp, mediaOp, largeOp, bannerOp, authOp);
            return;
        }

        bannerOp = 0;

        if (this._isExpanded) {
            targetWidth = 380;
            targetHeight = EXPANDED_HEIGHT;
            quickOp = 0;
            mediaOp = 0;
            largeOp = 255;
        } else if (this._hoverActive) {
            targetHeight = this._initialHeight;
            largeOp = 0;
            if (this._isPlaying) {
                targetWidth = MEDIA_HOVER_WIDTH;
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
                targetWidth = MEDIA_COMPACT_WIDTH;
                quickOp = 0;
                mediaOp = 255;
            } else {
                targetWidth = this._initialWidth;
                quickOp = 0;
                mediaOp = 0;
            }
        }

        this._animateTo(targetWidth, targetHeight, quickOp, mediaOp, largeOp, bannerOp, authOp);
    }

    _animateTo(targetWidth, targetHeight, quickOpacity, mediaOpacity, largeOpacity, bannerOpacity = 0, authOpacity = 0) {
        if (!this._island || !this._hitArea)
            return;

        const next = {
            targetWidth,
            targetHeight,
            quickOpacity,
            mediaOpacity,
            largeOpacity,
            bannerOpacity,
            authOpacity,
            topMargin: this._topMargin,
        };
        if (this._animTarget &&
            this._animTarget.targetWidth === next.targetWidth &&
            this._animTarget.targetHeight === next.targetHeight &&
            this._animTarget.quickOpacity === next.quickOpacity &&
            this._animTarget.mediaOpacity === next.mediaOpacity &&
            this._animTarget.largeOpacity === next.largeOpacity &&
            this._animTarget.bannerOpacity === next.bannerOpacity &&
            this._animTarget.authOpacity === next.authOpacity &&
            this._animTarget.topMargin === next.topMargin) {
            return;
        }
        this._animTarget = next;

        const hitW = targetWidth + HIT_PAD_X * 2;
        const hitH = targetHeight + HIT_PAD_BOTTOM;
        const hitX = this._centerX - (targetWidth / 2) - HIT_PAD_X;
        const hitY = this._topMargin;

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
            y: 0,
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

        if (this._batteryBannerContainer) {
            if (bannerOpacity === 0) {
                this._batteryBannerContainer.remove_all_transitions();
                this._batteryBannerContainer.opacity = 0;
            } else {
                this._batteryBannerContainer.ease({
                    opacity: bannerOpacity,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
        }

        if (this._fingerprintContainer) {
            if (authOpacity === 0) {
                this._fingerprintContainer.remove_all_transitions();
                this._fingerprintContainer.opacity = 0;
            } else {
                this._fingerprintContainer.ease({
                    opacity: authOpacity,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
        }
    }

    _clearBannerTimeout() {
        if (this._bannerTimeout) {
            GLib.source_remove(this._bannerTimeout);
            this._bannerTimeout = null;
        }
    }

    _isOnAc(state) {
        return state === UPowerGlib.DeviceState.CHARGING ||
            state === UPowerGlib.DeviceState.PENDING_CHARGE ||
            state === UPowerGlib.DeviceState.FULLY_CHARGED;
    }

    _showBatteryBanner(kind) {
        if (!this._island || !this._displayDevice)
            return;
        if (this._isFingerprintAuth)
            return;

        this._isExpanded = false;
        this._currentTab = 0;
        this._hoverActive = false;
        this._hideDismissShade();
        this._setExpandedTabPickable(false);

        const pct = Math.round(this._displayDevice.percentage);
        if (kind === 'charging') {
            this._batteryBanner.update({
                title: 'Charging',
                pct,
                theme: 'charging',
            });
        } else {
            this._batteryBanner.update({
                title: 'Low Battery',
                pct,
                theme: 'low',
            });
        }

        this._isBatteryBanner = true;
        this._animTarget = null;
        this._clearBannerTimeout();
        this._bannerTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BATTERY_BANNER_MS, () => {
            this._bannerTimeout = null;
            this._hideBatteryBanner();
            return GLib.SOURCE_REMOVE;
        });
        this._updateIslandView();
    }

    _hideBatteryBanner() {
        if (!this._isBatteryBanner)
            return;
        this._isBatteryBanner = false;
        this._animTarget = null;
        this._clearBannerTimeout();
        this._updateIslandView();
    }

    _onBatteryChanged() {
        if (!this._island || !this._displayDevice)
            return;

        this._updateBattery();

        const state = this._displayDevice.state;
        const pct = this._displayDevice.percentage;

        if (pct > LOW_BATTERY_PCT)
            this._lowBatteryArmed = true;

        const prevState = this._prevUpState;
        const prevPct = this._prevPct;
        const onAc = this._isOnAc(state);
        const wasOnAc = prevState != null && this._isOnAc(prevState);

        if (prevState != null && !wasOnAc && onAc)
            this._showBatteryBanner('charging');
        else if (prevPct != null &&
                 prevPct > LOW_BATTERY_PCT &&
                 pct <= LOW_BATTERY_PCT &&
                 !onAc &&
                 this._lowBatteryArmed) {
            this._lowBatteryArmed = false;
            this._showBatteryBanner('low');
        }

        this._prevUpState = state;
        this._prevPct = pct;
    }

    _clearFingerprintHoldTimeout() {
        if (this._fingerprintHoldTimeout) {
            GLib.source_remove(this._fingerprintHoldTimeout);
            this._fingerprintHoldTimeout = null;
        }
    }

    _setupFingerprintAuth() {
        if (!EXPERIMENTAL_FINGERPRINT)
            return;

        this._fingerprintMonitor = new FingerprintAuthMonitor({
            onStart: () => this._beginFingerprintAuth(),
            onRetry: () => {
                if (this._isFingerprintAuth)
                    this._fingerprintUi?.showScanning();
            },
            onSuccess: () => this._onFingerprintSuccess(),
            onFail: () => this._onFingerprintFail(),
            onEnd: () => {
                if (this._isFingerprintAuth && !this._fingerprintSuccessPending)
                    this._endFingerprintAuth();
            },
        });
        this._fingerprintMonitor.start();

        try {
            if (Main.screenShield) {
                this._shieldSignalId = Main.screenShield.connect('active-changed', () => {
                    if (!Main.screenShield.active &&
                        this._isFingerprintAuth &&
                        !this._fingerprintSuccessPending)
                        this._endFingerprintAuth();
                });
            }
        } catch (e) {
            // ScreenShield may be unavailable
        }
    }

    _beginFingerprintAuth() {
        if (!this._island)
            return;

        // Priority over battery banner
        this._hideBatteryBanner();

        this._isExpanded = false;
        this._currentTab = 0;
        this._hoverActive = false;
        this._hideDismissShade();
        this._setExpandedTabPickable(false);

        this._fingerprintSuccessPending = false;
        this._clearFingerprintHoldTimeout();
        this._isFingerprintAuth = true;
        this._animTarget = null;
        this._fingerprintUi?.showScanning();
        this._updateIslandView();
    }

    _onFingerprintSuccess() {
        if (!this._isFingerprintAuth)
            return;
        this._fingerprintSuccessPending = true;
        this._fingerprintUi?.playSuccess(() => {
            this._clearFingerprintHoldTimeout();
            this._fingerprintHoldTimeout = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                AUTH_SUCCESS_HOLD_MS,
                () => {
                    this._fingerprintHoldTimeout = null;
                    this._fingerprintSuccessPending = false;
                    this._endFingerprintAuth();
                    return GLib.SOURCE_REMOVE;
                }
            );
        });
    }

    _onFingerprintFail() {
        if (!this._isFingerprintAuth)
            return;
        this._fingerprintUi?.shake();
        this._clearFingerprintHoldTimeout();
        this._fingerprintHoldTimeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            AUTH_SHAKE_MS + 250,
            () => {
                this._fingerprintHoldTimeout = null;
                if (!this._fingerprintSuccessPending)
                    this._endFingerprintAuth();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _endFingerprintAuth() {
        if (!this._isFingerprintAuth && !this._fingerprintSuccessPending)
            return;
        this._clearFingerprintHoldTimeout();
        this._fingerprintSuccessPending = false;
        this._isFingerprintAuth = false;
        this._fingerprintUi?.hide();
        this._animTarget = null;
        this._updateIslandView();
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
        const now = GLib.DateTime.new_now_local();
        const fmt = this._settings.get_string('clock-format') === '12h' ? '%I:%M %p' : '%H:%M';
        let timeStr = now.format(fmt);
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
            this._prevUpState = this._displayDevice.state;
            this._prevPct = this._displayDevice.percentage;
            if (this._prevPct > LOW_BATTERY_PCT)
                this._lowBatteryArmed = true;
            this._updateBattery();
            this._batterySignalId = this._displayDevice.connect('notify::percentage', () => this._onBatteryChanged());
            this._batteryStateSignalId = this._displayDevice.connect('notify::state', () => this._onBatteryChanged());
        } catch (e) {
            this._quickBattery.set_text('AC');
            this._largeBattery.set_text('AC');
        }
    }

    _updateBattery() {
        if (!this._island || !this._displayDevice)
            return;
        const pctStr = `${Math.round(this._displayDevice.percentage)}%`;
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
            this._batteryBannerContainer,
            this._fingerprintContainer,
            ...this._allTabs(),
        ];
        for (const actor of actors) {
            if (actor)
                actor.remove_all_transitions();
        }
    }

    disable() {
        this._clearHoverLeaveTimeout();

        if (this._stageCaptureId) {
            global.stage.disconnect(this._stageCaptureId);
            this._stageCaptureId = null;
        }
        if (this._focusWindowId) {
            global.display.disconnect(this._focusWindowId);
            this._focusWindowId = null;
        }

        if (this._settings && this._settingsSignals) {
            for (const id of this._settingsSignals)
                this._settings.disconnect(id);
            this._settingsSignals = [];
        }

        this._media?.destroy();
        this._media = null;

        if (this._weatherTimeout) {
            GLib.source_remove(this._weatherTimeout);
            this._weatherTimeout = null;
        }
        if (this._timeTimeout) {
            GLib.source_remove(this._timeTimeout);
            this._timeTimeout = null;
        }
        this._clearBannerTimeout();
        this._hideBatteryBanner();
        this._clearFingerprintHoldTimeout();
        this._endFingerprintAuth();

        if (this._fingerprintMonitor) {
            this._fingerprintMonitor.stop();
            this._fingerprintMonitor = null;
        }
        this._fingerprintUi?.destroy();
        this._fingerprintUi = null;

        if (this._shieldSignalId && Main.screenShield) {
            try {
                Main.screenShield.disconnect(this._shieldSignalId);
            } catch (e) {
                // ignore
            }
            this._shieldSignalId = null;
        }

        if (this._displayDevice) {
            if (this._batterySignalId) {
                this._displayDevice.disconnect(this._batterySignalId);
                this._batterySignalId = null;
            }
            if (this._batteryStateSignalId) {
                this._displayDevice.disconnect(this._batteryStateSignalId);
                this._batteryStateSignalId = null;
            }
        }

        this._removeTransitions();
        this._destroyDismissShade();

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
        this._soup = null;
    }
}
