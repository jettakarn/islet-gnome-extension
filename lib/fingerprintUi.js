import St from 'gi://St';
import Clutter from 'gi://Clutter';
import {
    AUTH_SQUARE_SIZE,
    AUTH_RING_SIZE,
    AUTH_BREATH_MS,
    AUTH_BREATH_OP_MIN,
    AUTH_BREATH_OP_MAX,
    AUTH_SPIN_MS,
    AUTH_SHAKE_MS,
    AUTH_FRAME_SIZE,
    AUTH_CORNER_SIZE,
} from './constants.js';

function pickFingerIcon() {
    return 'auth-fingerprint-symbolic';
}

/**
 * Face-ID-style fingerprint overlay for the auth square.
 * Scan rim and success rim share AUTH_RING_SIZE so diameters never drift.
 */
export function buildFingerprintUi() {
    const root = new St.Widget({
        style_class: 'islet-auth-root',
        layout_manager: new Clutter.BinLayout(),
        x_expand: true,
        y_expand: true,
        opacity: 0,
    });

    // Outer perimeter stroke on the black square (breathes with scan).
    // Explicit size — BinLayout alone does not reliably expand to fill.
    const islandEdge = new St.Widget({
        style_class: 'islet-auth-island-edge',
        width: AUTH_SQUARE_SIZE,
        height: AUTH_SQUARE_SIZE,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        opacity: 0,
    });

    const outerRim = new St.Widget({
        style_class: 'islet-auth-ring',
        width: AUTH_RING_SIZE,
        height: AUTH_RING_SIZE,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        opacity: 0,
    });

    // Same diameter as outerRim — bright arc spins on top for success
    const spinArc = new St.Widget({
        style_class: 'islet-auth-spin',
        width: AUTH_RING_SIZE,
        height: AUTH_RING_SIZE,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        opacity: 0,
    });
    try {
        spinArc.set_pivot_point(0.5, 0.5);
    } catch (e) {
        // ignore
    }

    const frame = new St.Widget({
        style_class: 'islet-auth-frame',
        width: AUTH_FRAME_SIZE,
        height: AUTH_FRAME_SIZE,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        layout_manager: new Clutter.BinLayout(),
        opacity: 0,
    });

    for (const pos of ['tl', 'tr', 'bl', 'br']) {
        const c = new St.Widget({
            style_class: `islet-auth-corner islet-auth-corner-${pos}`,
            width: AUTH_CORNER_SIZE,
            height: AUTH_CORNER_SIZE,
        });
        if (pos === 'tl') {
            c.x_align = Clutter.ActorAlign.START;
            c.y_align = Clutter.ActorAlign.START;
        } else if (pos === 'tr') {
            c.x_align = Clutter.ActorAlign.END;
            c.y_align = Clutter.ActorAlign.START;
        } else if (pos === 'bl') {
            c.x_align = Clutter.ActorAlign.START;
            c.y_align = Clutter.ActorAlign.END;
        } else {
            c.x_align = Clutter.ActorAlign.END;
            c.y_align = Clutter.ActorAlign.END;
        }
        frame.add_child(c);
    }

    const finger = new St.Icon({
        icon_name: pickFingerIcon(),
        style_class: 'islet-auth-finger',
        icon_size: 34,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        opacity: 0,
    });

    const check = new St.Icon({
        icon_name: 'emblem-ok-symbolic',
        style_class: 'islet-auth-check',
        icon_size: 36,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        opacity: 0,
        visible: false,
    });

    root.add_child(islandEdge);
    root.add_child(outerRim);
    root.add_child(spinArc);
    root.add_child(frame);
    root.add_child(finger);
    root.add_child(check);

    const breathActors = [islandEdge, outerRim, frame, finger];
    let breathing = false;
    let breathGoingUp = true;
    let successCb = null;

    function _breathGroup() {
        return breathActors.filter(a => {
            try {
                return a && !a.destroyed;
            } catch (e) {
                return false;
            }
        });
    }

    function _clearBreath() {
        breathing = false;
        for (const a of _breathGroup()) {
            try {
                a.remove_all_transitions();
            } catch (e) {
                // ignore
            }
        }
    }

    function _breathStep() {
        if (!breathing)
            return;

        const target = breathGoingUp ? AUTH_BREATH_OP_MAX : AUTH_BREATH_OP_MIN;
        breathGoingUp = !breathGoingUp;
        const actors = _breathGroup();
        if (actors.length === 0)
            return;

        let remaining = actors.length;
        const onOneDone = () => {
            remaining--;
            if (remaining <= 0 && breathing)
                _breathStep();
        };

        for (const a of actors) {
            try {
                a.ease({
                    opacity: target,
                    duration: AUTH_BREATH_MS / 2,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                    onComplete: onOneDone,
                });
            } catch (e) {
                onOneDone();
            }
        }
    }

    function _startBreath() {
        _clearBreath();
        breathing = true;
        breathGoingUp = false;
        for (const a of _breathGroup()) {
            try {
                a.opacity = AUTH_BREATH_OP_MAX;
            } catch (e) {
                // ignore
            }
        }
        _breathStep();
    }

    function showScanning() {
        successCb = null;
        check.visible = false;
        check.opacity = 0;
        spinArc.opacity = 0;
        try {
            spinArc.rotation_angle_z = 0;
            spinArc.remove_all_transitions();
        } catch (e) {
            // ignore
        }

        islandEdge.visible = true;
        finger.visible = true;
        frame.visible = true;
        outerRim.visible = true;

        for (const a of [islandEdge, outerRim, frame, finger]) {
            try {
                a.remove_all_transitions();
                a.opacity = AUTH_BREATH_OP_MAX;
            } catch (e) {
                // ignore
            }
        }
        _startBreath();
    }

    function shake() {
        const targets = [finger, frame];
        for (const t of targets) {
            try {
                t.remove_all_transitions();
                t.translation_x = 0;
            } catch (e) {
                // ignore
            }
        }

        // Pause breath opacity fights during shake
        const wasBreathing = breathing;
        if (wasBreathing)
            _clearBreath();

        const step = AUTH_SHAKE_MS / 6;
        const run = (actor, then) => {
            actor.ease({
                translation_x: -8,
                duration: step,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    actor.ease({
                        translation_x: 8,
                        duration: step,
                        mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                        onComplete: () => {
                            actor.ease({
                                translation_x: -6,
                                duration: step,
                                mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                                onComplete: () => {
                                    actor.ease({
                                        translation_x: 0,
                                        duration: step,
                                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                                        onComplete: then,
                                    });
                                },
                            });
                        },
                    });
                },
            });
        };

        try {
            let pending = targets.length;
            const done = () => {
                pending--;
                if (pending <= 0 && wasBreathing)
                    _startBreath();
            };
            for (const t of targets)
                run(t, done);
        } catch (e) {
            if (wasBreathing)
                _startBreath();
        }
    }

    function playSuccess(onDone) {
        _clearBreath();
        successCb = onDone;

        // Keep outerRim at full opacity — same size through success
        try {
            outerRim.remove_all_transitions();
            outerRim.opacity = 255;
        } catch (e) {
            // ignore
        }

        try {
            islandEdge.ease({ opacity: 0, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            frame.ease({ opacity: 0, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            finger.ease({ opacity: 0, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        } catch (e) {
            islandEdge.opacity = 0;
            frame.opacity = 0;
            finger.opacity = 0;
        }

        spinArc.opacity = 255;
        spinArc.rotation_angle_z = 0;
        try {
            spinArc.set_pivot_point(0.5, 0.5);
            spinArc.remove_all_transitions();
        } catch (e2) {
            // ignore
        }

        spinArc.ease({
            rotation_angle_z: 360,
            duration: AUTH_SPIN_MS,
            mode: Clutter.AnimationMode.EASE_IN_OUT_CUBIC,
            onComplete: () => {
                try {
                    spinArc.opacity = 0;
                    spinArc.rotation_angle_z = 0;
                } catch (e) {
                    // ignore
                }
                // Outer rim stays — same diameter as scan
                outerRim.opacity = 255;
                check.visible = true;
                check.opacity = 0;
                check.ease({
                    opacity: 255,
                    duration: 220,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        successCb?.();
                        successCb = null;
                    },
                });
            },
        });
    }

    function hide() {
        _clearBreath();
        successCb = null;
        for (const a of [islandEdge, outerRim, spinArc, frame, finger, check]) {
            try {
                a.remove_all_transitions();
            } catch (e) {
                // ignore
            }
        }
        islandEdge.opacity = 0;
        outerRim.opacity = 0;
        spinArc.opacity = 0;
        frame.opacity = 0;
        finger.opacity = 0;
        check.opacity = 0;
        finger.translation_x = 0;
        frame.translation_x = 0;
        check.visible = false;
        try {
            spinArc.rotation_angle_z = 0;
        } catch (e) {
            // ignore
        }
    }

    function destroy() {
        hide();
    }

    return {
        root,
        showScanning,
        shake,
        playSuccess,
        hide,
        destroy,
    };
}
