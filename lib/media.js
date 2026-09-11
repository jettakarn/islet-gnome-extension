import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import {
    ALBUM_SIZE,
    QUICK_ART_SIZE,
    PROGRESS_POLL_MS,
    WAVE_TICK_MS,
    WAVE_GOAL_EVERY,
    WAVE_LERP,
    WAVE_H_MIN,
    WAVE_H_MAX,
} from './constants.js';

function findPlayerctl() {
    let path = GLib.find_program_in_path('playerctl');
    if (path)
        return path;
    const localBin = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'playerctl']);
    if (GLib.file_test(localBin, GLib.FileTest.IS_EXECUTABLE))
        return localBin;
    return null;
}

function formatClock(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0)
        return '0:00';
    const s = Math.floor(seconds);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, '0')}`;
}

function makeCtrlButton(iconName, onClick, iconSize = 28) {
    const icon = new St.Icon({
        icon_name: iconName,
        style_class: 'islet-media-ctrl-icon',
        icon_size: iconSize,
    });
    const btn = new St.Button({
        style_class: 'islet-media-ctrl-btn',
        child: icon,
        reactive: false,
        can_focus: false,
    });
    btn._isletIcon = icon;
    btn.connect('clicked', () => onClick());
    return btn;
}

function fileToCssUrl(file) {
    const uri = file.get_uri();
    return `url("${uri.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`;
}

/** St.Icon ignores border-radius; CSS background-image clips to radius. */
function makeAlbumStack(size, noteSize) {
    const placeholder = new St.Bin({
        style_class: 'islet-album-placeholder',
        width: size,
        height: size,
    });
    placeholder.set_child(new St.Icon({
        icon_name: 'audio-x-generic-symbolic',
        style_class: 'islet-album-note',
        icon_size: noteSize,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    }));

    const cover = new St.Widget({
        style_class: 'islet-album-cover',
        width: size,
        height: size,
        visible: false,
    });

    const stack = new St.Widget({
        layout_manager: new Clutter.BinLayout(),
        width: size,
        height: size,
        style_class: 'islet-album-art',
    });
    stack.add_child(placeholder);
    stack.add_child(cover);
    return { stack, placeholder, cover };
}

function makeWaveform(count, className = 'islet-waveform') {
    const wave = new St.BoxLayout({
        style_class: className,
        vertical: false,
        y_align: Clutter.ActorAlign.CENTER,
        x_align: Clutter.ActorAlign.CENTER,
    });
    const bars = [];
    for (let i = 0; i < count; i++) {
        const bar = new St.Widget({
            style_class: 'islet-wave-bar',
            width: 3,
            height: WAVE_H_MIN,
            y_align: Clutter.ActorAlign.CENTER,
        });
        wave.add_child(bar);
        bars.push(bar);
    }
    return { wave, bars };
}

/**
 * Media tab + playerctl state. Binds onto an extension-like host for shared fields.
 */
export class MediaController {
    constructor(host) {
        this._host = host;
        this._playerctlPath = findPlayerctl();
        this._soup = host._soup;
        this._busy = false;
        this._artUrl = null;
        this._artTmpPath = null;
        this._trackLengthSec = 0;
        this._positionSec = 0;
        this._progressSource = null;
        this._metaSource = null;
        this._waveSource = null;
        this._waveBars = [];
        this._waveValues = [];
        this._waveTargets = [];
        this._waveGoalTick = 0;
        this._artCovers = [];
    }

    get playerctlPath() {
        return this._playerctlPath;
    }

    buildQuickStrip() {
        const box = new St.BoxLayout({
            style_class: 'islet-media-box',
            vertical: false,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 0,
        });

        const album = makeAlbumStack(QUICK_ART_SIZE, 14);
        this._quickPlaceholder = album.placeholder;
        this._quickCover = album.cover;
        this._artCovers.push(album.cover);

        const spacer = new St.Widget({ x_expand: true });

        const { wave, bars } = makeWaveform(3, 'islet-waveform islet-waveform-quick');
        this._addWaveBars(bars);

        box.add_child(album.stack);
        box.add_child(spacer);
        box.add_child(wave);
        return box;
    }

    buildTab() {
        const tab = new St.BoxLayout({
            style_class: 'islet-media-card',
            vertical: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 0,
            translation_x: 50,
            reactive: false,
        });

        const header = new St.BoxLayout({
            style_class: 'islet-media-header',
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const album = makeAlbumStack(ALBUM_SIZE, 22);
        this._albumPlaceholder = album.placeholder;
        this._albumCover = album.cover;
        this._artCovers.push(album.cover);

        const metaCol = new St.BoxLayout({
            style_class: 'islet-media-meta',
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._cardTitle = new St.Label({
            text: 'Not Playing',
            style_class: 'islet-card-title',
        });
        this._cardArtist = new St.Label({
            text: '—',
            style_class: 'islet-card-artist',
        });
        metaCol.add_child(this._cardTitle);
        metaCol.add_child(this._cardArtist);

        const { wave, bars } = makeWaveform(3, 'islet-waveform');
        this._addWaveBars(bars);

        header.add_child(album.stack);
        header.add_child(metaCol);
        header.add_child(wave);

        const progressRow = new St.BoxLayout({
            style_class: 'islet-progress-row',
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._elapsedLabel = new St.Label({
            text: '0:00',
            style_class: 'islet-progress-time',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._remainingLabel = new St.Label({
            text: '0:00',
            style_class: 'islet-progress-time',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._progressFill = new St.Widget({
            style_class: 'islet-progress-fill',
            height: 4,
            width: 0,
        });
        const trackStack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            height: 4,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const trackBg = new St.Widget({
            style_class: 'islet-progress-track',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
            height: 4,
        });
        // BoxLayout packs from the start so fill grows left → right
        const fillRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
            height: 4,
        });
        fillRow.add_child(this._progressFill);
        trackStack.add_child(trackBg);
        trackStack.add_child(fillRow);
        this._progressTrackStack = trackStack;

        progressRow.add_child(this._elapsedLabel);
        progressRow.add_child(trackStack);
        progressRow.add_child(this._remainingLabel);

        const controls = new St.BoxLayout({
            style_class: 'islet-media-buttons',
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const centerBtns = new St.BoxLayout({
            style_class: 'islet-media-buttons-center',
            vertical: false,
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._btnPrev = makeCtrlButton('media-skip-backward-symbolic', () => this.cmd('previous'), 28);
        this._btnPlay = makeCtrlButton('media-playback-start-symbolic', () => this.cmd('play-pause'), 32);
        this._btnNext = makeCtrlButton('media-skip-forward-symbolic', () => this.cmd('next'), 28);
        centerBtns.add_child(this._btnPrev);
        centerBtns.add_child(this._btnPlay);
        centerBtns.add_child(this._btnNext);

        this._btnOutput = makeCtrlButton('audio-headphones-symbolic', () => {
            try {
                GLib.spawn_command_line_async('gnome-control-center sound');
            } catch (e) {
                console.error('Failed to open sound settings:', e);
            }
        }, 24);
        this._btnOutput.style_class = 'islet-media-ctrl-btn islet-media-output-btn';

        controls.add_child(centerBtns);
        controls.add_child(this._btnOutput);

        tab.add_child(header);
        tab.add_child(progressRow);
        tab.add_child(controls);

        this._controlButtons = [this._btnPrev, this._btnPlay, this._btnNext, this._btnOutput];
        return tab;
    }

    setControlsReactive(on) {
        (this._controlButtons || []).forEach(btn => {
            if (!btn)
                return;
            btn.reactive = on;
            btn.can_focus = on;
        });
    }

    cmd(cmd) {
        if (!this._playerctlPath)
            return;
        try {
            Gio.Subprocess.new([this._playerctlPath, cmd], Gio.SubprocessFlags.NONE);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                this.updateState();
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {
            console.error(`playerctl ${cmd} failed:`, e);
        }
    }

    _addWaveBars(bars) {
        for (const bar of bars) {
            this._waveBars.push(bar);
            this._waveValues.push(WAVE_H_MIN);
            this._waveTargets.push(WAVE_H_MIN);
        }
    }

    _setArtFromFile(file) {
        const bg = fileToCssUrl(file);
        const style =
            `background-image: ${bg}; ` +
            'background-size: cover; background-repeat: no-repeat; ' +
            'background-position: center;';
        for (const cover of this._artCovers) {
            if (!cover)
                continue;
            cover.set_style(style);
            cover.visible = true;
        }
        if (this._albumPlaceholder)
            this._albumPlaceholder.visible = false;
        if (this._quickPlaceholder)
            this._quickPlaceholder.visible = false;
    }

    showPlaceholder() {
        for (const cover of this._artCovers) {
            if (!cover)
                continue;
            cover.set_style('');
            cover.visible = false;
        }
        if (this._albumPlaceholder)
            this._albumPlaceholder.visible = true;
        if (this._quickPlaceholder)
            this._quickPlaceholder.visible = true;
        this._artUrl = null;
    }

    setAlbumArt(url) {
        if (!url) {
            this.showPlaceholder();
            return;
        }
        if (url === this._artUrl && this._albumCover?.visible)
            return;
        this._artUrl = url;

        try {
            if (url.startsWith('file://') || url.startsWith('/')) {
                const file = url.startsWith('/')
                    ? Gio.File.new_for_path(url)
                    : Gio.File.new_for_uri(url);
                this._setArtFromFile(file);
                return;
            }

            const msg = Soup.Message.new('GET', url);
            if (!msg) {
                this.showPlaceholder();
                return;
            }
            this._soup.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                if (!this._host._island)
                    return;
                try {
                    if (msg.get_status() !== Soup.Status.OK) {
                        this.showPlaceholder();
                        return;
                    }
                    const bytes = session.send_and_read_finish(res);
                    const data = bytes.get_data();
                    const tmp = GLib.build_filenamev([
                        GLib.get_tmp_dir(),
                        `islet-art-${GLib.get_monotonic_time()}.img`,
                    ]);
                    const file = Gio.File.new_for_path(tmp);
                    file.replace_contents(data, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                    if (this._artTmpPath && this._artTmpPath !== tmp) {
                        try {
                            Gio.File.new_for_path(this._artTmpPath).delete(null);
                        } catch (e2) {
                            // ignore
                        }
                    }
                    this._artTmpPath = tmp;
                    this._setArtFromFile(file);
                } catch (e) {
                    this.showPlaceholder();
                }
            });
        } catch (e) {
            this.showPlaceholder();
        }
    }

    _tickWave() {
        const playing = !!this._host._isPlaying;
        const n = this._waveBars.length;

        if (playing) {
            this._waveGoalTick++;
            if (this._waveGoalTick >= WAVE_GOAL_EVERY) {
                this._waveGoalTick = 0;
                for (let i = 0; i < n; i++) {
                    const span = WAVE_H_MAX - WAVE_H_MIN;
                    // Prefer mid-range moves; avoid tiny noise
                    this._waveTargets[i] = WAVE_H_MIN + 2 + Math.random() * (span - 2);
                }
            }
        } else {
            this._waveGoalTick = 0;
            for (let i = 0; i < n; i++)
                this._waveTargets[i] = WAVE_H_MIN;
        }

        for (let i = 0; i < n; i++) {
            const bar = this._waveBars[i];
            if (!bar)
                continue;
            const cur = this._waveValues[i];
            const next = cur + (this._waveTargets[i] - cur) * WAVE_LERP;
            this._waveValues[i] = next;
            bar.height = Math.max(2, Math.round(next));
        }
    }

    _startWaveAnimation() {
        if (this._waveSource)
            return;
        this._tickWave();
        this._waveSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WAVE_TICK_MS, () => {
            if (!this._host._island) {
                this._waveSource = null;
                return GLib.SOURCE_REMOVE;
            }
            this._tickWave();
            if (!this._host._isPlaying) {
                // Finish settling toward idle height
                const settled = this._waveValues.every(v => Math.abs(v - WAVE_H_MIN) < 0.4);
                if (settled) {
                    this._waveSource = null;
                    return GLib.SOURCE_REMOVE;
                }
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopWaveAnimation() {
        // Keep ticking briefly so bars ease down via lerp
        if (!this._host._isPlaying && !this._waveSource)
            this._startWaveAnimation();
    }

    _forceStopWave() {
        if (this._waveSource) {
            GLib.source_remove(this._waveSource);
            this._waveSource = null;
        }
    }

    _syncWaveAnimation() {
        this._startWaveAnimation();
    }

    _updateProgressUi() {
        const len = this._trackLengthSec;
        const pos = Math.min(this._positionSec, len || this._positionSec);
        this._elapsedLabel?.set_text(formatClock(pos));
        if (len > 0) {
            const remain = Math.max(0, len - pos);
            this._remainingLabel?.set_text(`-${formatClock(remain)}`);
            const trackW = this._progressTrackStack?.get_width?.() || 180;
            const fillW = Math.max(0, Math.floor(trackW * (pos / len)));
            if (this._progressFill)
                this._progressFill.width = fillW;
        } else {
            this._remainingLabel?.set_text('0:00');
            if (this._progressFill)
                this._progressFill.width = 0;
        }
    }

    _pollPosition() {
        if (!this._playerctlPath || !this._host._island)
            return;
        try {
            const proc = Gio.Subprocess.new(
                [this._playerctlPath, 'position'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [ok, out] = p.communicate_utf8_finish(res);
                    if (ok && out) {
                        const v = parseFloat(out.trim());
                        if (Number.isFinite(v))
                            this._positionSec = v;
                    }
                } catch (e) {
                    // ignore
                }
                this._updateProgressUi();
            });
        } catch (e) {
            // ignore
        }
    }

    startProgressPolling() {
        this.stopProgressPolling();
        this._pollPosition();
        this._progressSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PROGRESS_POLL_MS, () => {
            if (!this._host._island)
                return GLib.SOURCE_REMOVE;
            if (this._host._isExpanded && this._host._currentTab === 1)
                this._pollPosition();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stopProgressPolling() {
        if (this._progressSource) {
            GLib.source_remove(this._progressSource);
            this._progressSource = null;
        }
    }

    startMetaPolling() {
        this.updateState();
        this._metaSource = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            this.updateState();
            return GLib.SOURCE_CONTINUE;
        });
        this.startProgressPolling();
    }

    stopMetaPolling() {
        if (this._metaSource) {
            GLib.source_remove(this._metaSource);
            this._metaSource = null;
        }
        this.stopProgressPolling();
        this._forceStopWave();
    }

    updateState() {
        const host = this._host;
        if (!host._island || this._busy)
            return;

        if (!this._playerctlPath) {
            this._playerctlPath = findPlayerctl();
            if (!this._playerctlPath)
                return;
        }

        try {
            this._busy = true;
            const proc = Gio.Subprocess.new(
                [
                    this._playerctlPath,
                    'metadata',
                    '--format',
                    '{{mpris:artUrl}}||{{title}}||{{artist}}||{{status}}||{{mpris:length}}',
                ],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );

            proc.communicate_utf8_async(null, null, (p, res) => {
                this._busy = false;
                if (!host._island)
                    return;

                try {
                    const [success, stdout] = p.communicate_utf8_finish(res);
                    if (success && stdout) {
                        const parts = stdout.trim().split('||');
                        if (parts.length >= 4) {
                            const artUrl = parts[0] || '';
                            const title = parts[1] || 'Unknown';
                            const artist = parts[2] || 'Unknown';
                            const status = (parts[3] || '').toLowerCase();
                            const lengthUs = parseInt(parts[4] || '0', 10);

                            host._isPlaying = status === 'playing';
                            this._cardTitle?.set_text(title);
                            this._cardArtist?.set_text(artist);

                            if (Number.isFinite(lengthUs) && lengthUs > 0)
                                this._trackLengthSec = lengthUs / 1e6;
                            else
                                this._trackLengthSec = 0;

                            if (this._btnPlay?._isletIcon) {
                                this._btnPlay._isletIcon.icon_name = host._isPlaying
                                    ? 'media-playback-pause-symbolic'
                                    : 'media-playback-start-symbolic';
                            }
                            this.setAlbumArt(artUrl);
                            this._updateProgressUi();
                            this._syncWaveAnimation();
                            host._updateIslandView();
                            return;
                        }
                    }
                } catch (e) {
                    // no player
                }

                this.showPlaceholder();
                this._cardTitle?.set_text('Not Playing');
                this._cardArtist?.set_text('—');
                this._trackLengthSec = 0;
                this._positionSec = 0;
                this._updateProgressUi();
                if (this._btnPlay?._isletIcon)
                    this._btnPlay._isletIcon.icon_name = 'media-playback-start-symbolic';
                if (host._isPlaying) {
                    host._isPlaying = false;
                    this._syncWaveAnimation();
                    host._updateIslandView();
                } else {
                    this._syncWaveAnimation();
                }
            });
        } catch (e) {
            this._busy = false;
            console.error('Failed to launch playerctl:', e);
            this.showPlaceholder();
            if (host._isPlaying && host._island) {
                host._isPlaying = false;
                this._syncWaveAnimation();
                host._updateIslandView();
            }
        }
    }

    destroy() {
        this.stopMetaPolling();
        if (this._artTmpPath) {
            try {
                Gio.File.new_for_path(this._artTmpPath).delete(null);
            } catch (e) {
                // ignore
            }
            this._artTmpPath = null;
        }
    }
}
