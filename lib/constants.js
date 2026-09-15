export const HOVER_LEAVE_DELAY_MS = 200;
export const HIT_PAD_X = 24;
export const HIT_PAD_BOTTOM = 14;
export const TOP_MARGIN_MIN = 0;
export const TOP_MARGIN_MAX = 40;
export const TAB_COUNT = 4;
export const WEATHER_INTERVAL_SEC = 30 * 60;
export const ALBUM_SIZE = 48;
export const QUICK_ART_SIZE = 28;
export const PROGRESS_POLL_MS = 1000;
export const WAVE_TICK_MS = 33;
export const WAVE_LERP = 0.28;
/** Compact square spectrum box. */
export const WAVE_BOX_SIZE = 32;
export const WAVE_BAR_COUNT = 6;
export const WAVE_BAR_WIDTH = 3;
/** Floor = one dot (single circle). */
export const WAVE_H_MIN = 3;
export const WAVE_H_MAX = 28;
export const WAVE_H_MAX_CARD = 28;
/**
 * Band roles (0..5): edges = hats/air, near = body, center = kick only.
 * Center weight is for kick flashes — idle residual stays low in code.
 */
export const WAVE_BAND_WEIGHTS = [0.55, 0.7, 1.0, 1.0, 0.7, 0.55];
/** Left = lighter cover color, right = full cover color. */
export const WAVE_COLOR_LIGHTEN = 0.55;
export const WAVE_PHASE_STEP = 0.1;
/** Shared expanded peninsula height (all tabs). */
export const EXPANDED_HEIGHT = 220;
export const MEDIA_COMPACT_WIDTH = 265;
export const MEDIA_HOVER_WIDTH = 300;
export const BATTERY_BANNER_MS = 3000;
export const BATTERY_BANNER_WIDTH = 300;
export const BATTERY_BANNER_HEIGHT = 40;
export const LOW_BATTERY_PCT = 20;

/** Experimental fingerprint auth island (Face ID–style morph). */
export const EXPERIMENTAL_FINGERPRINT = true;
export const AUTH_SQUARE_SIZE = 110;
/** Inset so the green rim sits inside the square (scan + success share this). */
export const AUTH_RING_INSET = 18;
export const AUTH_RING_SIZE = AUTH_SQUARE_SIZE - 2 * AUTH_RING_INSET;
export const AUTH_BREATH_MS = 1200;
export const AUTH_BREATH_OP_MIN = 90;
export const AUTH_BREATH_OP_MAX = 255;
export const AUTH_SPIN_MS = 900;
export const AUTH_SUCCESS_HOLD_MS = 900;
export const AUTH_SHAKE_MS = 420;
export const AUTH_GREEN = '#7CFF6B';
export const AUTH_FRAME_SIZE = 72;
export const AUTH_CORNER_SIZE = 16;
