import St from 'gi://St';
import Clutter from 'gi://Clutter';

const TRACK_H = 4;
const TRACK_W = 110;

/**
 * Apple-style volume HUD: icon + "Volume" left, thin fill track right.
 */
export function buildVolumeHud({ onSeek } = {}) {
    const box = new St.BoxLayout({
        style_class: 'islet-volume-hud',
        vertical: false,
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.FILL,
        y_align: Clutter.ActorAlign.CENTER,
        opacity: 0,
    });

    const left = new St.BoxLayout({
        style_class: 'islet-volume-hud-left',
        vertical: false,
        y_align: Clutter.ActorAlign.CENTER,
    });

    const icon = new St.Icon({
        icon_name: 'audio-volume-high-symbolic',
        style_class: 'islet-volume-hud-icon',
        icon_size: 18,
        y_align: Clutter.ActorAlign.CENTER,
    });

    const title = new St.Label({
        text: 'Volume',
        style_class: 'islet-volume-hud-title',
        y_align: Clutter.ActorAlign.CENTER,
    });

    left.add_child(icon);
    left.add_child(title);

    const spacer = new St.Widget({ x_expand: true });

    const fill = new St.Widget({
        style_class: 'islet-volume-hud-fill',
        height: TRACK_H,
        width: 0,
        y_align: Clutter.ActorAlign.CENTER,
    });

    const fillRow = new St.BoxLayout({
        vertical: false,
        x_expand: true,
        x_align: Clutter.ActorAlign.FILL,
        y_align: Clutter.ActorAlign.CENTER,
        height: TRACK_H,
    });
    fillRow.add_child(fill);

    const trackBg = new St.Widget({
        style_class: 'islet-volume-hud-track',
        x_expand: true,
        x_align: Clutter.ActorAlign.FILL,
        y_align: Clutter.ActorAlign.CENTER,
        height: TRACK_H,
    });

    const hitH = 20;
    const trackHit = new St.Widget({
        style_class: 'islet-volume-hud-hit',
        layout_manager: new Clutter.BinLayout(),
        width: TRACK_W,
        height: hitH,
        y_align: Clutter.ActorAlign.CENTER,
        reactive: false,
        track_hover: true,
    });
    trackHit.add_child(trackBg);
    trackHit.add_child(fillRow);

    let scrubbing = false;
    let stageId = 0;
    let level = 0;
    let muted = false;

    const clearStage = () => {
        if (stageId) {
            try {
                global.stage.disconnect(stageId);
            } catch (e) {
                // ignore
            }
            stageId = 0;
        }
    };

    const ratioFromEvent = (actor, event) => {
        try {
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
    };

    const seekFromEvent = (actor, event) => {
        const ratio = ratioFromEvent(actor, event);
        onSeek?.(ratio);
    };

    trackHit.connect('button-press-event', (_a, event) => {
        scrubbing = true;
        seekFromEvent(trackHit, event);
        clearStage();
        stageId = global.stage.connect('captured-event', (_s, ev) => {
            const type = ev.type();
            if (type === Clutter.EventType.MOTION && scrubbing)
                seekFromEvent(trackHit, ev);
            else if (type === Clutter.EventType.BUTTON_RELEASE) {
                scrubbing = false;
                clearStage();
            }
            return Clutter.EVENT_PROPAGATE;
        });
        return Clutter.EVENT_STOP;
    });

    trackHit.connect('button-release-event', () => {
        scrubbing = false;
        clearStage();
        return Clutter.EVENT_STOP;
    });

    box.add_child(left);
    box.add_child(spacer);
    box.add_child(trackHit);

    const iconFor = (lvl, isMuted) => {
        if (isMuted || lvl <= 0.001)
            return 'audio-volume-muted-symbolic';
        if (lvl < 0.34)
            return 'audio-volume-low-symbolic';
        if (lvl < 0.67)
            return 'audio-volume-medium-symbolic';
        return 'audio-volume-high-symbolic';
    };

    const syncFill = () => {
        const trackW = trackHit.width > 0 ? trackHit.width : TRACK_W;
        const shown = muted ? 0 : Math.max(0, Math.min(1, level));
        fill.width = Math.max(0, Math.floor(trackW * shown));
        icon.icon_name = iconFor(level, muted);
    };

    return {
        box,
        setLevel(nextLevel, nextMuted) {
            level = Math.max(0, Math.min(1, nextLevel));
            muted = !!nextMuted;
            syncFill();
        },
        setReactive(on) {
            trackHit.reactive = !!on;
            if (!on) {
                scrubbing = false;
                clearStage();
            }
        },
        destroy() {
            scrubbing = false;
            clearStage();
        },
    };
}
