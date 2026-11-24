// The native port: opened only after the user pressed Connect, reopened after a drop with a growing delay, without end.
import { PROTOCOL, VERSION } from '../shared/protocol.mjs';

const FIRST_MS = 1000;
const MAX_MS = 30_000;

export class NativeLink {
  constructor({ hello = () => ({}), open, onMessage, onLost, onChange, now = Date.now, setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t), protocol = PROTOCOL }) {
    Object.assign(this, { hello, open, onMessage, onLost, onChange, now, setTimer, clearTimer, protocol });
    this.port = null;
    this.timer = null;
    this.delay = FIRST_MS;
    this.status = { state: 'off', code: null, detail: null, host: null, retryAt: null };
  }

  #set(patch) {
    Object.assign(this.status, patch);
    this.onChange();
  }

  get connected() {
    return this.status.state === 'connected';
  }

  start() {
    if (this.port) return;
    this.clearTimer(this.timer);
    this.#set({ state: 'connecting', retryAt: null });
    const port = this.open();
    this.port = port;
    let problem = null; // why this port is about to close, if the host said so
    port.onMessage.addListener((m) => {
      if (this.port !== port) return;
      if (m?.type === 'hello') {
        if (m.protocol !== this.protocol) {
          problem = { state: 'version_mismatch', code: 'version_mismatch', detail: m.protocol < this.protocol ? 'The helper is older than the add-on.' : 'The add-on is older than the helper.' };
          return this.#drop(port, problem);
        }
        this.delay = FIRST_MS;
        return this.#set({ state: 'connected', code: null, detail: null, host: String(m.host) });
      }
      if (m?.type === 'fatal') {
        problem = { state: 'refused', code: String(m.code), detail: String(m.message) };
        return;
      }
      if (this.connected) this.onMessage(m);
    });
    port.onDisconnect.addListener((p) => {
      const error = p?.error?.message ?? null;
      const missing = /no such native application/i.test(error ?? '');
      this.#drop(port, problem ?? (missing ? { state: 'waiting', code: 'helper_missing', detail: error } : { state: 'waiting', code: 'helper_stopped', detail: error }));
    });
    this.post({ type: 'hello', protocol: this.protocol, extension: VERSION, ...this.hello() });
  }

  #drop(port, why) {
    if (this.port !== port) return;
    this.port = null;
    port.disconnect();
    this.onLost();
    const wait = this.delay;
    this.delay = Math.min(this.delay * 2, MAX_MS);
    this.timer = this.setTimer(() => this.start(), wait);
    this.#set({ ...why, host: null, retryAt: this.now() + wait });
  }

  retryNow() {
    if (this.port || this.status.state === 'off') return;
    this.delay = FIRST_MS;
    this.start();
  }

  /** The user disconnected. Nothing reopens the port until `start`. */
  stop() {
    this.clearTimer(this.timer);
    const port = this.port;
    this.port = null;
    if (port) {
      try {
        port.postMessage({ type: 'bye' });
      } catch {
        // the port is already closed
      }
      port.disconnect();
      this.onLost();
    }
    this.delay = FIRST_MS;
    this.#set({ state: 'off', code: null, detail: null, host: null, retryAt: null });
  }

  post(m) {
    try {
      this.port?.postMessage(m);
    } catch (e) {
      console.error('native port', e);
    }
  }
}
