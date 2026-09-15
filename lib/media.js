import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import GdkPixbuf from 'gi://GdkPixbuf';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';
import {
    ALBUM_SIZE,
    QUICK_ART_SIZE,
    PROGRESS_POLL_MS,
    WAVE_TICK_MS,
    WAVE_LERP,
    WAVE_H_MIN,
    WAVE_H_MAX,
    WAVE_H_MAX_CARD,
    WAVE_BAR_COUNT,
    WAVE_BAR_WIDTH,
    WAVE_BAND_WEIGHTS,
    WAVE_BOX_SIZE,
    WAVE_COLOR_LIGHTEN,
    WAVE_PHASE_STEP,
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

function boostVisibleColor(r, g, b) {
    const max = Math.max(r, g, b);
    if (max < 150) {
        const scale = 150 / Math.max(max, 1);
        r = Math.min(255, Math.round(r * scale));
        g = Math.min(255, Math.round(g * scale));
        b = Math.min(255, Math.round(b * scale));
    }
    return { r, g, b };
}

/** Pick a vivid color from album art for spectrum tinting. */
function extractArtColor(file) {
    try {
        const path = file.get_path();
        if (!path)
            return { r: 255, g: 255, b: 255 };
        const pb = GdkPixbuf.Pixbuf.new_from_file_at_size(path, 40, 40);
        const pixels = pb.get_pixels();
        const nCh = pb.get_n_channels();
        const stride = pb.get_rowstride();
        const w = pb.get_width();
        const h = pb.get_height();

        let bestScore = -1;
        let best = { r: 255, g: 255, b: 255 };

        for (let y = 0; y < h; y += 2) {
            for (let x = 0; x < w; x += 2) {
                const i = y * stride + x * nCh;
                const r = pixels[i];
                const g = pixels[i + 1];
                const b = pixels[i + 2];
                const mx = Math.max(r, g, b);
                const mn = Math.min(r, g, b);
                const lum = (r + g + b) / 3;
                if (lum < 28 || lum > 245 || mx < 20)
                    continue;
                const sat = mx === 0 ? 0 : (mx - mn) / mx;
                const score = sat * 2.0 + (lum / 255) * 0.35;
                if (score > bestScore) {
                    bestScore = score;
                    best = { r, g, b };
                }
            }
        }
        return boostVisibleColor(best.r, best.g, best.b);
    } catch (e) {
        return { r: 255, g: 255, b: 255 };
    }
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

function lerpColor(a, b, t) {
    const u = Math.max(0, Math.min(1, t));
    return {
        r: Math.round(a.r + (b.r - a.r) * u),
        g: Math.round(a.g + (b.g - a.g) * u),
        b: Math.round(a.b + (b.b - a.b) * u),
    };
}

function paintBarParts(bar, rgb) {
    if (!bar?._parts)
        return;
    const fill = `background-color: rgb(${rgb.r}, ${rgb.g}, ${rgb.b});`;
    for (const part of bar._parts) {
        try {
            if (part.destroyed)
                continue;
            part.set_style(part._isCap ? `${fill} border-radius: 99px;` : fill);
        } catch (e) {
            // ignore
        }
    }
}

/**
 * Capsule bar: circle + rect + circle (or a single dot at minimum).
 */
function makeCapsuleBar() {
    const w = WAVE_BAR_WIDTH;
    const col = new St.BoxLayout({
        style_class: 'islet-wave-bar',
        vertical: true,
        width: w,
        y_align: Clutter.ActorAlign.CENTER,
    });
    const top = new St.Widget({
        style_class: 'islet-wave-cap',
        width: w,
        height: w,
    });
    const mid = new St.Widget({
        style_class: 'islet-wave-mid',
        width: w,
        height: 0,
        visible: false,
    });
    const bot = new St.Widget({
        style_class: 'islet-wave-cap',
        width: w,
        height: w,
        visible: false,
    });
    top._isCap = true;
    bot._isCap = true;
    col.add_child(top);
    col.add_child(mid);
    col.add_child(bot);
    col._top = top;
    col._mid = mid;
    col._bot = bot;
    col._parts = [top, mid, bot];
    return col;
}

function makeWaveform(className = 'islet-waveform') {
    const wave = new St.BoxLayout({
        style_class: className,
        vertical: false,
        width: WAVE_BOX_SIZE,
        height: WAVE_BOX_SIZE,
        y_align: Clutter.ActorAlign.CENTER,
        x_align: Clutter.ActorAlign.CENTER,
        x_expand: false,
        y_expand: false,
    });
    const lead = new St.Widget({ x_expand: true });
    const trail = new St.Widget({ x_expand: true });
    wave.add_child(lead);

    const bars = [];
    for (let i = 0; i < WAVE_BAR_COUNT; i++) {
        const bar = makeCapsuleBar();
        wave.add_child(bar);
        bars.push(bar);
    }
    wave.add_child(trail);
    return { wave, bars };
}

function setCapsuleHeight(bar, height) {
    if (!bar?._top || !bar._mid || !bar._bot)
        return;
    const w = WAVE_BAR_WIDTH;
    const total = Math.max(w, Math.round(height));

    try {
        if (total <= w + 1) {
            // Single point
            bar._top.visible = true;
            bar._mid.visible = false;
            bar._bot.visible = false;
            bar._mid.height = 0;
        } else {
            bar._top.visible = true;
            bar._mid.visible = true;
            bar._bot.visible = true;
            const midH = Math.max(0, total - w * 2);
            if (Math.abs((bar._mid.height || 0) - midH) >= 1)
                bar._mid.height = midH;
        }
    } catch (e) {
        // ignore
    }
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
        this._wavePhase = 0;
        this._waveTimeMs = 0;
        this._audioEnv = 0;
        this._audioPrev = 0;
        this._kickEnv = 0;
        this._hatEnv = 0;
        this._peakUnavailable = false;
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

        const { wave, bars } = makeWaveform('islet-waveform islet-waveform-quick');
        this._addWaveBars(bars, WAVE_H_MAX);

        box.add_child(album.stack);
        box.add_child(spacer);
        box.add_child(wave);
        return box;
    }

    buildTab() {
        const tab = new St.BoxLayout({
            style_class: 'islet-media-tab',
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

        const { wave, bars } = makeWaveform('islet-waveform');
        this._addWaveBars(bars, WAVE_H_MAX_CARD);

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

        const barH = 4;
        const hitH = 20;
        this._progressFill = new St.Widget({
            style_class: 'islet-progress-fill',
            height: barH,
            width: 0,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const trackStack = new St.Widget({
            style_class: 'islet-progress-hit',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            height: hitH,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: false,
            track_hover: true,
        });
        const trackBg = new St.Widget({
            style_class: 'islet-progress-track',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
            height: barH,
        });
        // BoxLayout packs from the start so fill grows left → right
        const fillRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
            height: barH,
        });
        fillRow.add_child(this._progressFill);
        trackStack.add_child(trackBg);
        trackStack.add_child(fillRow);
        this._progressTrackStack = trackStack;
        this._progressScrubbing = false;
        this._progressStageId = 0;

        const clearStageGrab = () => {
            if (this._progressStageId) {
                try {
                    global.stage.disconnect(this._progressStageId);
                } catch (e) {
                    // ignore
                }
                this._progressStageId = 0;
            }
        };

        const endScrub = () => {
            if (!this._progressScrubbing)
                return;
            this._progressScrubbing = false;
            clearStageGrab();
            this._pollPosition();
        };

        trackStack.connect('button-press-event', (_a, event) => {
            this._progressScrubbing = true;
            this._seekFromEvent(trackStack, event);
            clearStageGrab();
            this._progressStageId = global.stage.connect('captured-event', (_s, ev) => {
                const type = ev.type();
                if (type === Clutter.EventType.MOTION && this._progressScrubbing) {
                    this._seekFromEvent(trackStack, ev);
                } else if (type === Clutter.EventType.BUTTON_RELEASE) {
                    endScrub();
                }
                return Clutter.EVENT_PROPAGATE;
            });
            return Clutter.EVENT_STOP;
        });
        trackStack.connect('button-release-event', () => {
            endScrub();
            return Clutter.EVENT_STOP;
        });

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
        if (this._progressTrackStack) {
            this._progressTrackStack.reactive = on;
            if (!on) {
                this._progressScrubbing = false;
                if (this._progressStageId) {
                    try {
                        global.stage.disconnect(this._progressStageId);
                    } catch (e) {
                        // ignore
                    }
                    this._progressStageId = 0;
                }
            }
        }
    }

    _ratioFromEvent(actor, event) {
        try {
            // get_coords() returns [x, y]
            const [x] = event.get_coords();
            const [ax] = actor.get_transformed_position();
            let aw = 0;
            try {
                aw = actor.get_transformed_size()[0];
            } catch (e) {
                aw = actor.width;
            }
            if (!(aw > 0))
                aw = actor.width || 1;
            return Math.max(0, Math.min(1, (x - ax) / aw));
        } catch (e) {
            return 0;
        }
    }

    _seekFromEvent(actor, event) {
        if (!(this._trackLengthSec > 0))
            return;
        this.seekToRatio(this._ratioFromEvent(actor, event));
    }

    seekToRatio(ratio) {
        if (!this._playerctlPath || !(this._trackLengthSec > 0))
            return;
        const sec = Math.max(0, Math.min(this._trackLengthSec, ratio * this._trackLengthSec));
        this._positionSec = sec;
        this._updateProgressUi();
        try {
            Gio.Subprocess.new(
                [this._playerctlPath, 'position', String(sec)],
                Gio.SubprocessFlags.NONE
            );
        } catch (e) {
            console.error('playerctl position seek failed:', e);
        }
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

    _addWaveBars(bars, maxHeight = WAVE_H_MAX) {
        for (const bar of bars) {
            bar._isletWaveMax = maxHeight;
            this._waveBars.push(bar);
            const h0 = WAVE_H_MIN;
            this._waveValues.push(h0);
            this._waveTargets.push(h0);
            setCapsuleHeight(bar, h0);
        }
    }

    _applyWaveColor(r, g, b) {
        const art = { r, g, b };
        const white = { r: 255, g: 255, b: 255 };
        const light = lerpColor(art, white, WAVE_COLOR_LIGHTEN);
        this._waveArtColor = art;

        const denom = Math.max(1, WAVE_BAR_COUNT - 1);
        for (let i = 0; i < this._waveBars.length; i++) {
            const bar = this._waveBars[i];
            const bi = i % WAVE_BAR_COUNT;
            // Left → right: lighter cover → full cover
            paintBarParts(bar, lerpColor(light, art, bi / denom));
        }
    }

    /** 0..1 peak from default sink when available; -1 if unsupported. */
    _readOutputPeak() {
        if (this._peakUnavailable)
            return -1;
        try {
            const control = Volume.getMixerControl();
            const sink = control?.get_default_sink?.();
            if (!sink) {
                this._peakUnavailable = true;
                return -1;
            }
            let peak = null;
            if (typeof sink.get_peak === 'function')
                peak = sink.get_peak();
            else if (sink.peak !== undefined && sink.peak !== null)
                peak = sink.peak;
            if (typeof peak !== 'number' || Number.isNaN(peak)) {
                this._peakUnavailable = true;
                return -1;
            }
            return Math.max(0, Math.min(1, peak));
        } catch (e) {
            this._peakUnavailable = true;
            return -1;
        }
    }

    /**
     * Band drives for one frame.
     * Center (2,3) = kick onsets only; edges = hats/air; avoids constant mid peaks.
     */
    _computeBandDrives(playing) {
        const drives = new Array(WAVE_BAR_COUNT).fill(0.06);
        if (!playing)
            return drives.map(() => 0);

        this._waveTimeMs += WAVE_TICK_MS;
        this._wavePhase += WAVE_PHASE_STEP;

        const peak = this._readOutputPeak();
        let kick = 0;
        let hat = 0;
        let body = 0;

        if (peak >= 0) {
            // Envelope follower + onset = hip-hop kick punch from real output
            if (peak > this._audioEnv)
                this._audioEnv = peak;
            else
                this._audioEnv *= 0.84;

            const onset = peak - this._audioPrev;
            this._audioPrev = peak;

            if (onset > 0.08 && peak > 0.18)
                this._kickEnv = Math.min(1, this._kickEnv + onset * 2.8);
            else
                this._kickEnv *= 0.68;

            if (peak > 0.12)
                this._hatEnv = Math.min(1, peak * 0.9);
            else
                this._hatEnv *= 0.75;

            kick = this._kickEnv;
            hat = this._hatEnv * 0.85;
            body = this._audioEnv * 0.35;
        } else {
            // Fallback: sparse hip-hop-ish kick (narrow pulses), not a continuous sine
            // ~94 BPM, kick on 1 & 3 of a 4/4 bar
            const bpm = 94;
            const msPerBeat = 60000 / bpm;
            const barPos = (this._waveTimeMs % (msPerBeat * 4)) / msPerBeat; // 0..4

            const near = (at, width) => {
                let d = Math.abs(barPos - at);
                d = Math.min(d, 4 - d);
                return Math.max(0, 1 - d / width);
            };

            // Very narrow kick spikes — quiet between hits
            kick = Math.pow(Math.max(near(0, 0.09), near(2, 0.09)), 2.2);
            // Light snare ghost on 2 & 4 for near-center
            const snare = Math.pow(Math.max(near(1, 0.07), near(3, 0.07)), 2) * 0.45;
            // 8th-note hats on edges
            const eighth = (this._waveTimeMs % (msPerBeat / 2)) / (msPerBeat / 2);
            hat = Math.pow(1 - Math.abs(eighth - 0.5) * 2, 2) * 0.55;
            body = snare * 0.5;
            this._kickEnv = kick;
            this._hatEnv = hat;
        }

        // Map bands — center only rides kick; no constant mid elevation
        drives[0] = hat * 0.85 + body * 0.1;
        drives[1] = body * 0.55 + kick * 0.2 + hat * 0.15;
        drives[2] = kick * 0.95 + body * 0.05;
        drives[3] = kick * 0.95 + body * 0.05;
        drives[4] = body * 0.55 + kick * 0.2 + hat * 0.15;
        drives[5] = hat * 0.85 + body * 0.1;

        for (let i = 0; i < WAVE_BAR_COUNT; i++)
            drives[i] = Math.max(0.04, Math.min(1, drives[i] * (WAVE_BAND_WEIGHTS[i] ?? 1)));

        return drives;
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

        const color = extractArtColor(file);
        this._applyWaveColor(color.r, color.g, color.b);
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
        this._applyWaveColor(255, 255, 255);
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
        if (n === 0)
            return;

        const drives = this._computeBandDrives(playing);

        for (let i = 0; i < n; i++) {
            const bi = i % WAVE_BAR_COUNT;
            const bar = this._waveBars[i];
            const maxH = bar?._isletWaveMax || WAVE_H_MAX;
            const minH = WAVE_H_MIN;
            const span = Math.max(1, maxH - minH);
            const drive = playing ? (drives[bi] ?? 0) : 0;
            this._waveTargets[i] = minH + drive * span;
        }

        for (let i = 0; i < n; i++) {
            const bar = this._waveBars[i];
            if (!bar)
                continue;
            try {
                if (bar.destroyed)
                    continue;
            } catch (e) {
                continue;
            }

            const cur = this._waveValues[i];
            const next = cur + (this._waveTargets[i] - cur) * WAVE_LERP;
            this._waveValues[i] = next;
            const h = Math.max(WAVE_H_MIN, next);
            try {
                setCapsuleHeight(bar, h);
            } catch (e) {
                // actor gone mid-tick
            }
        }
    }

    _startWaveAnimation() {
        if (this._waveSource)
            return;
        this._tickWave();
        this._waveSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, WAVE_TICK_MS, () => {
            try {
                if (!this._host._island) {
                    this._waveSource = null;
                    return GLib.SOURCE_REMOVE;
                }
                this._tickWave();
                if (!this._host._isPlaying) {
                    const settled = this._waveValues.every(v => Math.abs(v - WAVE_H_MIN) < 0.35);
                    if (settled) {
                        this._waveSource = null;
                        return GLib.SOURCE_REMOVE;
                    }
                }
                return GLib.SOURCE_CONTINUE;
            } catch (e) {
                console.error('Islet wave tick failed:', e);
                this._waveSource = null;
                return GLib.SOURCE_REMOVE;
            }
        });
    }

    _stopWaveAnimation() {
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
        // Always ensure a live timer while playing (restart if a prior tick aborted)
        if (this._host._isPlaying) {
            if (!this._waveSource)
                this._startWaveAnimation();
        } else {
            this._stopWaveAnimation();
        }
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
                        if (Number.isFinite(v) && !this._progressScrubbing)
                            this._positionSec = v;
                    }
                } catch (e) {
                    // ignore
                }
                if (!this._progressScrubbing)
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
        this._progressScrubbing = false;
        if (this._progressStageId) {
            try {
                global.stage.disconnect(this._progressStageId);
            } catch (e) {
                // ignore
            }
            this._progressStageId = 0;
        }
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
