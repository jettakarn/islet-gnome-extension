import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import UPowerGlib from 'gi://UPowerGlib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

export default class IsletExtension extends Extension {
    enable() {
        this._monitor = Main.layoutManager.primaryMonitor;
        this._centerX = this._monitor.x + (this._monitor.width / 2);
        
        const initialWidth = 170;
        const initialHeight = 43;
        const topMargin = 10;

        // Global states
        this._isPlaying = false;
        this._isExpanded = false;
        this._currentTab = 0;
        this._scrollAccumulator = 0;

        // Main container
        this._island = new St.Bin({
            style_class: 'islet-container',
            reactive: true, 
            can_focus: true, 
            track_hover: true,
            width: initialWidth, 
            height: initialHeight,
        });
        this._island.set_position(this._centerX - (initialWidth / 2), topMargin);

        // Layer stack manager
        this._stack = new St.Widget({ 
            layout_manager: new Clutter.BinLayout(), 
            x_expand: true, 
            y_expand: true 
        });
        this._island.set_child(this._stack);

        // ==========================================
        // Layer A1: Quick View (Time + Battery)
        // ==========================================
        this._quickContainer = new St.BoxLayout({
            style_class: 'islet-quick-box', 
            vertical: false,
            x_expand: true, 
            y_expand: true, 
            x_align: Clutter.ActorAlign.FILL, 
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 0
        });
        this._quickTime = new St.Label({ text: '--:--', style_class: 'islet-text', y_align: Clutter.ActorAlign.CENTER, x_expand: true });
        this._quickBattery = new St.Label({ text: '--%', style_class: 'islet-text', y_align: Clutter.ActorAlign.CENTER, x_align: Clutter.ActorAlign.END });
        this._quickContainer.add_child(this._quickTime);
        this._quickContainer.add_child(this._quickBattery);

        // ==========================================
        // Layer A2: Quick View (Spotify Playing)
        // ==========================================
        this._mediaQuickContainer = new St.BoxLayout({
            style_class: 'islet-media-box', 
            vertical: false,
            x_expand: true, 
            y_expand: true, 
            x_align: Clutter.ActorAlign.START, 
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 0 
        });
        
        let musicIcon = new St.Icon({ icon_name: 'audio-x-generic-symbolic', style_class: 'islet-media-icon', y_align: Clutter.ActorAlign.CENTER });
        this._mediaTitle = new St.Label({ text: 'Not Playing', style_class: 'islet-media-title', y_align: Clutter.ActorAlign.CENTER });
        this._mediaArtist = new St.Label({ text: ' • Unknown', style_class: 'islet-media-artist', y_align: Clutter.ActorAlign.CENTER });
        
        this._mediaQuickContainer.add_child(musicIcon);
        this._mediaQuickContainer.add_child(this._mediaTitle);
        this._mediaQuickContainer.add_child(this._mediaArtist);

        // ==========================================
        // Layer B: Large View (Expanded Panel)
        // ==========================================
        this._largeContainer = new St.BoxLayout({ 
            style_class: 'islet-large-box', 
            vertical: true, 
            x_expand: true, 
            y_expand: true, 
            opacity: 0 
        });
        
        // Fixed Header (Weather & Battery)
        let topRow = new St.BoxLayout({ x_expand: true, y_align: Clutter.ActorAlign.START });
        this._largeWeather = new St.Label({ text: '81°F', style_class: 'islet-weather' });
        let spacer = new St.Widget({ x_expand: true });
        this._largeBattery = new St.Label({ text: '70%', style_class: 'islet-battery-pill' });
        topRow.add_child(this._largeWeather); 
        topRow.add_child(spacer); 
        topRow.add_child(this._largeBattery);

        // Content Stack (Swipable Tabs)
        this._largeContentStack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true, 
            y_expand: true
        });

        // Tab 0: Overview (Time & Date)
        this._overviewTab = new St.BoxLayout({ 
            vertical: true, 
            y_expand: true, 
            y_align: Clutter.ActorAlign.CENTER, 
            x_align: Clutter.ActorAlign.CENTER 
        });
        this._largeTime = new St.Label({ text: '16:59', style_class: 'islet-large-time' });
        this._largeDate = new St.Label({ text: 'Sat, Dec 27', style_class: 'islet-large-date', x_align: Clutter.ActorAlign.CENTER });
        this._overviewTab.add_child(this._largeTime); 
        this._overviewTab.add_child(this._largeDate);

        // Tab 1: Shortcuts (Quick Apps)
        this._shortcutsTab = new St.BoxLayout({
            style_class: 'islet-qa-box', 
            vertical: false,
            x_expand: true, 
            y_expand: true, 
            x_align: Clutter.ActorAlign.CENTER, 
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 0,         // Initially hidden
            translation_x: 50   // Initially shifted right for slide-in effect
        });

        const quickApps = [
            { name: 'Term', cmd: 'gnome-terminal' },
            { name: 'Files', cmd: 'nautilus' },
            { name: 'Calc', cmd: 'gnome-calculator' },
            { name: 'Spotify', cmd: 'spotify' }
        ];

        quickApps.forEach(app => {
            let btn = new St.Button({
                label: app.name,
                style_class: 'islet-qa-button',
                reactive: true,
                can_focus: true
            });

            btn.connect('clicked', () => {
                try {
                    Gio.Subprocess.new([app.cmd], Gio.SubprocessFlags.NONE).init(null);
                    this._isExpanded = false; // Collapse island after launching app
                    this._updateIslandView();
                } catch (e) {
                    console.error(`Failed to launch ${app.name}:`, e);
                }
            });

            this._shortcutsTab.add_child(btn);
        });

        // Assemble the Large View
        this._largeContentStack.add_child(this._overviewTab);
        this._largeContentStack.add_child(this._shortcutsTab);
        this._largeContainer.add_child(topRow);
        this._largeContainer.add_child(this._largeContentStack); 

        // Add all layers to the main stack
        this._stack.add_child(this._quickContainer);
        this._stack.add_child(this._mediaQuickContainer);
        this._stack.add_child(this._largeContainer);

        Main.layoutManager.uiGroup.add_child(this._island);

        // Initialize features
        this._setupClock();
        this._setupBattery();
        this._setupSpotify(); 
        this._setupAnimations(initialWidth, initialHeight);
        this._setupGestures();
    }

    // --- Gestures & Swiping Logic ---
    _setupGestures() {
        this._island.connect('scroll-event', (actor, event) => {
            if (!this._isExpanded) return Clutter.EVENT_PROPAGATE;

            let direction = event.get_scroll_direction();
            let dx = 0;

            // Support smooth touchpad gestures and traditional mouse scroll
            if (direction === Clutter.ScrollDirection.SMOOTH) {
                let [deltaX, deltaY] = event.get_scroll_delta();
                dx = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
            } else if (direction === Clutter.ScrollDirection.UP) {
                dx = -1;
            } else if (direction === Clutter.ScrollDirection.DOWN) {
                dx = 1;
            }

            this._scrollAccumulator += dx;

            // Threshold to prevent over-sensitivity
            if (this._scrollAccumulator > 1.2) {
                this._switchTab(1); // Swipe left / scroll down -> Tab 1 (Shortcuts)
                this._scrollAccumulator = 0;
            } else if (this._scrollAccumulator < -1.2) {
                this._switchTab(0); // Swipe right / scroll up -> Tab 0 (Overview)
                this._scrollAccumulator = 0;
            }

            return Clutter.EVENT_STOP;
        });

        // Reset accumulator when cursor leaves
        this._island.connect('leave-event', () => {
            this._scrollAccumulator = 0;
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _switchTab(index) {
        if (this._currentTab === index) return;
        this._currentTab = index;

        let duration = 250;
        let mode = Clutter.AnimationMode.EASE_OUT_QUINT;

        if (index === 0) {
            // Switch to Tab 0: Overview slides in from left, Shortcuts slide out to right
            this._overviewTab.ease({ opacity: 255, translation_x: 0, duration, mode });
            this._shortcutsTab.ease({ opacity: 0, translation_x: 50, duration, mode });
        } else {
            // Switch to Tab 1: Shortcuts slide in from right, Overview slides out to left
            this._overviewTab.ease({ opacity: 0, translation_x: -50, duration, mode });
            this._shortcutsTab.ease({ opacity: 255, translation_x: 0, duration, mode });
        }
    }

    // --- Spotify MPRIS D-Bus Logic ---
    _setupSpotify() {
        this._updateSpotifyState();
        this._spotifyTimeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            this._updateSpotifyState();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _updateSpotifyState() {
        try {
            // Async subprocess call to playerctl
            let proc = Gio.Subprocess.new(
                ['/usr/bin/playerctl', 'metadata', '--format', '{{title}}||{{artist}}||{{status}}'],
                Gio.SubprocessFlags.STDOUT_PIPE
            );
            
            proc.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    let [success, stdout, stderr] = proc.communicate_utf8_finish(res);
                    if (success && stdout) {
                        let parts = stdout.trim().split('||');
                        if (parts.length >= 3) {
                            let title = parts[0] || 'Unknown';
                            let artist = parts[1] || 'Unknown';
                            let status = parts[2].toLowerCase();

                            this._isPlaying = (status === 'playing');
                            this._mediaTitle.set_text(title);
                            this._mediaArtist.set_text(` • ${artist}`);
                            this._updateIslandView();
                            return; 
                        }
                    }
                } catch (e) {
                    // Ignored: playerctl errors out if no players are active
                }

                if (this._isPlaying) {
                    this._isPlaying = false;
                    this._updateIslandView();
                }
            });
        } catch (e) {
            console.error("Failed to launch playerctl:", e);
            if (this._isPlaying) {
                this._isPlaying = false;
                this._updateIslandView();
            }
        }
    }

    // --- Animation & View States ---
    _setupAnimations(initialWidth, initialHeight) {
        this._initialWidth = initialWidth;
        this._initialHeight = initialHeight;

        this._island.connect('notify::hover', () => this._updateIslandView());
        this._island.connect('button-release-event', () => {
            this._isExpanded = !this._isExpanded;
            this._updateIslandView();
            return Clutter.EVENT_STOP;
        });
    }

    _updateIslandView() {
        let targetWidth, targetHeight, quickOp, mediaOp, largeOp;

        if (this._isExpanded) {
            targetWidth = 380; 
            targetHeight = 190; // Kept at 190 to maintain sleek proportions
            quickOp = 0; mediaOp = 0; largeOp = 255;
            // Reset to Tab 0 when expanded
            this._switchTab(0);
        } else if (this._island.hover) {
            targetHeight = this._initialHeight;
            largeOp = 0;
            if (this._isPlaying) {
                targetWidth = 300; 
                quickOp = 0; mediaOp = 255;
            } else {
                targetWidth = 265;
                quickOp = 255; mediaOp = 0;
            }
        } else {
            targetHeight = this._initialHeight;
            largeOp = 0;
            if (this._isPlaying) {
                targetWidth = 265;
                quickOp = 0; mediaOp = 255;
            } else {
                targetWidth = this._initialWidth;
                quickOp = 0; mediaOp = 0; 
            }
        }

        this._animateTo(targetWidth, targetHeight, quickOp, mediaOp, largeOp);
    }

    _animateTo(targetWidth, targetHeight, quickOpacity, mediaOpacity, largeOpacity) {
        this._island.ease({ width: targetWidth, height: targetHeight, x: this._centerX - (targetWidth / 2), duration: 350, mode: Clutter.AnimationMode.EASE_OUT_QUINT });
        this._quickContainer.ease({ opacity: quickOpacity, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        this._mediaQuickContainer.ease({ opacity: mediaOpacity, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        this._largeContainer.ease({ opacity: largeOpacity, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
    }

    // --- Clock & Battery ---
    _setupClock() {
        this._updateTime();
        this._timeTimeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._updateTime(); return GLib.SOURCE_CONTINUE;
        });
    }
    
    _updateTime() {
        let now = GLib.DateTime.new_now_local();
        let timeStr = now.format('%H:%M');
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
            this._quickBattery.set_text("AC"); 
            this._largeBattery.set_text("AC");
        }
    }
    
    _updateBattery() {
        if (this._displayDevice) {
            let pctStr = `${Math.round(this._displayDevice.percentage)}%`;
            this._quickBattery.set_text(pctStr); 
            this._largeBattery.set_text(pctStr);
        }
    }

    disable() {
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
        if (this._island) { 
            this._island.destroy(); 
            this._island = null; 
        }
    }
}