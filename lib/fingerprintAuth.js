import Gio from 'gi://Gio';

const FPRINT_BUS = 'net.reactivated.Fprint';
const FPRINT_MANAGER_PATH = '/net/reactivated/Fprint/Manager';

const ManagerIface = `
<node>
  <interface name="net.reactivated.Fprint.Manager">
    <method name="GetDefaultDevice">
      <arg type="o" name="device" direction="out"/>
    </method>
    <method name="GetDevices">
      <arg type="ao" name="devices" direction="out"/>
    </method>
  </interface>
</node>`;

const DeviceIface = `
<node>
  <interface name="net.reactivated.Fprint.Device">
    <signal name="VerifyFingerSelected">
      <arg type="s" name="finger"/>
    </signal>
    <signal name="VerifyStatus">
      <arg type="s" name="result"/>
      <arg type="b" name="done"/>
    </signal>
  </interface>
</node>`;

const ManagerProxy = Gio.DBusProxy.makeProxyWrapper(ManagerIface);
const DeviceProxy = Gio.DBusProxy.makeProxyWrapper(DeviceIface);

const RETRY_RESULTS = new Set([
    'verify-retry-scan',
    'verify-swipe-too-short',
    'verify-finger-not-centered',
    'verify-remove-and-retry',
    'verify-too-fast',
]);

const FAIL_DONE_RESULTS = new Set([
    'verify-no-match',
    'verify-unknown-error',
    'verify-disconnected',
]);

/**
 * Passive fprintd listener — never Claim / VerifyStart.
 * @param {{ onStart?: Function, onRetry?: Function, onSuccess?: Function, onFail?: Function, onEnd?: Function }} callbacks
 */
export class FingerprintAuthMonitor {
    constructor(callbacks = {}) {
        this._cb = callbacks;
        this._manager = null;
        this._device = null;
        this._signalIds = [];
        this._nameWatchId = 0;
        this._active = false;
    }

    start() {
        this._nameWatchId = Gio.bus_watch_name(
            Gio.BusType.SYSTEM,
            FPRINT_BUS,
            Gio.BusNameWatcherFlags.NONE,
            () => this._connect(),
            () => this._disconnectDevice()
        );
    }

    stop() {
        if (this._nameWatchId) {
            Gio.bus_unwatch_name(this._nameWatchId);
            this._nameWatchId = 0;
        }
        this._disconnectDevice();
        this._manager = null;
        this._active = false;
    }

    get active() {
        return this._active;
    }

    _connect() {
        try {
            this._manager = ManagerProxy(
                Gio.DBus.system,
                FPRINT_BUS,
                FPRINT_MANAGER_PATH,
                (proxy, error) => {
                    if (error) {
                        console.error('Islet: fprintd manager proxy failed:', error.message);
                        return;
                    }
                    this._manager = proxy;
                    this._bindDefaultDevice();
                }
            );
        } catch (e) {
            console.error('Islet: fprintd unavailable:', e);
        }
    }

    _bindDefaultDevice() {
        this._disconnectDevice();
        if (!this._manager)
            return;

        try {
            const [path] = this._manager.GetDefaultDeviceSync();
            if (!path || path === '/')
                return;

            this._device = DeviceProxy(
                Gio.DBus.system,
                FPRINT_BUS,
                path,
                (proxy, error) => {
                    if (error) {
                        console.error('Islet: fprintd device proxy failed:', error.message);
                        return;
                    }
                    this._device = proxy;
                    this._signalIds.push(
                        proxy.connectSignal('VerifyFingerSelected', (_p, _sender, [_finger]) => {
                            this._active = true;
                            this._cb.onStart?.();
                        })
                    );
                    this._signalIds.push(
                        proxy.connectSignal('VerifyStatus', (_p, _sender, [result, done]) => {
                            this._onVerifyStatus(result, done);
                        })
                    );
                }
            );
        } catch (e) {
            // No default device
            console.debug?.('Islet: no fprintd default device', e);
        }
    }

    _onVerifyStatus(result, done) {
        if (result === 'verify-match' && done) {
            this._active = false;
            this._cb.onSuccess?.();
            return;
        }

        if (RETRY_RESULTS.has(result)) {
            this._cb.onRetry?.(result);
            return;
        }

        if (FAIL_DONE_RESULTS.has(result) && done) {
            this._active = false;
            this._cb.onFail?.(result);
            return;
        }

        if (done) {
            this._active = false;
            this._cb.onEnd?.('done');
        }
    }

    _disconnectDevice() {
        if (this._device && this._signalIds.length) {
            for (const id of this._signalIds) {
                try {
                    this._device.disconnectSignal(id);
                } catch (e) {
                    // ignore
                }
            }
        }
        this._signalIds = [];
        this._device = null;
    }
}
