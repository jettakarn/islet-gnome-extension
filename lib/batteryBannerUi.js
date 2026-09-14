import St from 'gi://St';
import Clutter from 'gi://Clutter';

const BATT_BODY_W = 26;
const BATT_BODY_H = 12;
const BATT_NUB_W = 3;
const BATT_NUB_H = 6;

export function buildBatteryBanner() {
    const box = new St.BoxLayout({
        style_class: 'islet-battery-banner',
        vertical: false,
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.FILL,
        y_align: Clutter.ActorAlign.CENTER,
        opacity: 0,
    });

    const title = new St.Label({
        text: 'Charging',
        style_class: 'islet-battery-banner-title',
        y_align: Clutter.ActorAlign.CENTER,
    });

    const spacer = new St.Widget({ x_expand: true });

    const right = new St.BoxLayout({
        style_class: 'islet-battery-banner-right',
        vertical: false,
        y_align: Clutter.ActorAlign.CENTER,
    });

    const pct = new St.Label({
        text: '100%',
        style_class: 'islet-battery-banner-pct',
        y_align: Clutter.ActorAlign.CENTER,
    });

    const glyph = new St.BoxLayout({
        style_class: 'islet-batt-glyph',
        vertical: false,
        y_align: Clutter.ActorAlign.CENTER,
    });

    const body = new St.Widget({
        style_class: 'islet-batt-body',
        width: BATT_BODY_W,
        height: BATT_BODY_H,
    });

    const fill = new St.Widget({
        style_class: 'islet-batt-fill',
        height: BATT_BODY_H - 4,
        width: 0,
        x_align: Clutter.ActorAlign.START,
        y_align: Clutter.ActorAlign.CENTER,
    });

    const fillRow = new St.BoxLayout({
        vertical: false,
        width: BATT_BODY_W,
        height: BATT_BODY_H,
        x_align: Clutter.ActorAlign.FILL,
        y_align: Clutter.ActorAlign.CENTER,
    });
    fillRow.add_child(fill);

    const bodyStack = new St.Widget({
        layout_manager: new Clutter.BinLayout(),
        width: BATT_BODY_W,
        height: BATT_BODY_H,
    });
    bodyStack.add_child(body);
    bodyStack.add_child(fillRow);

    const nub = new St.Widget({
        style_class: 'islet-batt-nub',
        width: BATT_NUB_W,
        height: BATT_NUB_H,
        y_align: Clutter.ActorAlign.CENTER,
    });

    glyph.add_child(bodyStack);
    glyph.add_child(nub);

    right.add_child(pct);
    right.add_child(glyph);

    box.add_child(title);
    box.add_child(spacer);
    box.add_child(right);

    return {
        box,
        title,
        pct,
        glyph,
        body,
        fill,
        update({ title: titleText, pct: pctVal, theme }) {
            title.set_text(titleText);
            pct.set_text(`${Math.round(pctVal)}%`);

            glyph.remove_style_class_name('islet-batt-theme-charging');
            glyph.remove_style_class_name('islet-batt-theme-low');
            pct.remove_style_class_name('islet-batt-pct-charging');
            pct.remove_style_class_name('islet-batt-pct-low');

            if (theme === 'charging') {
                glyph.add_style_class_name('islet-batt-theme-charging');
                pct.add_style_class_name('islet-batt-pct-charging');
            } else {
                glyph.add_style_class_name('islet-batt-theme-low');
                pct.add_style_class_name('islet-batt-pct-low');
            }

            const innerW = BATT_BODY_W - 4;
            const fillW = Math.max(0, Math.min(innerW, Math.round(innerW * (pctVal / 100))));
            fill.width = fillW;
        },
    };
}
