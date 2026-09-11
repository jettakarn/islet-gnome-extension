import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import { WEATHER_INTERVAL_SEC } from './constants.js';

export function createHttpGet(soup) {
    return (url, callback) => {
        try {
            const msg = Soup.Message.new('GET', url);
            if (!msg) {
                callback(new Error('bad url'), null);
                return;
            }
            soup.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                try {
                    if (msg.get_status() !== Soup.Status.OK) {
                        callback(new Error(`HTTP ${msg.get_status()}`), null);
                        return;
                    }
                    const bytes = session.send_and_read_finish(res);
                    const text = new TextDecoder('utf-8').decode(bytes.get_data());
                    callback(null, text);
                } catch (e) {
                    callback(e, null);
                }
            });
        } catch (e) {
            callback(e, null);
        }
    };
}

/**
 * @param {object} opts
 * @param {function} opts.httpGet
 * @param {function} opts.isAlive - () => boolean
 * @param {function} opts.onTemp - (celsius: number|null) => void
 */
export function startWeatherPolling({ httpGet, isAlive, onTemp }) {
    const fetchOnce = () => {
        httpGet('https://ipapi.co/json/', (err, body) => {
            if (!isAlive())
                return;
            let lat = null;
            let lon = null;
            if (!err && body) {
                try {
                    const j = JSON.parse(body);
                    lat = j.latitude;
                    lon = j.longitude;
                } catch (e) {
                    // fall through
                }
            }
            if (lat == null || lon == null) {
                lat = 25.033;
                lon = 121.565;
            }
            const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m`;
            httpGet(url, (werr, wbody) => {
                if (!isAlive())
                    return;
                if (werr || !wbody) {
                    onTemp(null);
                    return;
                }
                try {
                    const j = JSON.parse(wbody);
                    const t = j.current?.temperature_2m;
                    onTemp(typeof t === 'number' ? t : null);
                } catch (e) {
                    onTemp(null);
                }
            });
        });
    };

    fetchOnce();
    const sourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, WEATHER_INTERVAL_SEC, () => {
        fetchOnce();
        return GLib.SOURCE_CONTINUE;
    });
    return sourceId;
}

export function formatTemperature(tempC, unit) {
    if (tempC == null)
        return unit === 'fahrenheit' ? '--°F' : '--°C';
    if (unit === 'fahrenheit')
        return `${Math.round(tempC * 9 / 5 + 32)}°F`;
    return `${Math.round(tempC)}°C`;
}
