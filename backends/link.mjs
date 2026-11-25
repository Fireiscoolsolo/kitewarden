// What every optional backend shares: the login to the pipe with the user's key, the reconnect, and the order of commands.
// A backend never decides anything. It gets single commands from the add-on, which has checked and asked before.
import path from 'node:path';
import { Link } from '../mcp/link.mjs';
import { LIMITS, PROTOCOL, VERSION } from '../mcp/protocol.mjs';

const RETRY_MS = 3000;

/** Options of the command line: { name: value }, with true for a flag. */
export function options(argv, known) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !Object.hasOwn(known, name)) throw new Error(`Unknown option ${argv[i]}. Known: ${Object.entries(known).map(([k, v]) => `--${k}${v ? ` <${v}>` : ''}`).join(' ')}`);
    out[name] = known[name] ? argv[++i] : true;
    if (out[name] === undefined) throw new Error(`--${name} needs a value.`);
  }
  return out;
}

export const homeOf = (o) => o.home ?? path.join(process.env.LOCALAPPDATA, 'FirefoxCompanion');

/** An error before anything was done. Anything else leaves the outcome open. */
export const before = (code, message) => Object.assign(new Error(message), { code, before: true });

export class Backend {
  /** `info` says what this is. `handlers` run one command each, with a way to see whether it was cancelled. */
  constructor({ home, id, info, handlers, onReset = () => {} }) {
    Object.assign(this, { handlers, onReset });
    this.open = new Map(); // command -> { cancelled }
    this.turns = new Map(); // key -> the command before
    this.link = new Link(home, PROTOCOL, {
      hello: { backend: { id, version: VERSION, ...info } },
      onMessage: (m) => this.#message(m),
      onLost: () => this.#lost(),
    });
    this.link.client = { name: `backend ${id}`, version: VERSION };
  }

  /** Connects, and again after a loss, without end. After each one the user has to turn the backend on again. */
  async run() {
    try {
      await this.link.connect();
      console.log('Connected. Turn it on in the Firefox Companion sidebar under Advanced.');
    } catch (e) {
      if (this.said !== e.message) console.log((this.said = e.message));
      this.retry = setTimeout(() => this.run(), RETRY_MS);
    }
  }

  #lost() {
    for (const c of this.open.values()) c.cancelled = true;
    this.onReset();
    console.log('The link to Firefox broke. Trying again.');
    this.retry = setTimeout(() => this.run(), RETRY_MS);
  }

  #message(m) {
    if (m.type === 'bye') {
      console.log(String(m.message ?? 'Refused.'));
      return true;
    }
    if (m.type === 'cancel') {
      const c = this.open.get(m.id);
      if (c) c.cancelled = true;
      return true;
    }
    if (m.type === 'reset') {
      for (const c of this.open.values()) c.cancelled = true;
      this.onReset();
      return true;
    }
    if (m.type !== 'command') return false;
    this.#command(m);
    return true;
  }

  /** Commands for one tab run one after the other. A cancelled one that waits never begins. */
  async #command({ id, method, params }) {
    const c = { cancelled: false };
    this.open.set(id, c);
    const urgent = ['abort', 'forget', 'dialog', 'dialog_state'].includes(method);
    const key = params.key ?? '';
    const turn = urgent ? Promise.resolve() : this.turns.get(key) ?? Promise.resolve();
    const run = turn.then(async () => {
      if (c.cancelled) throw before('cancelled', 'The command was cancelled before it began.');
      if (!Object.hasOwn(this.handlers, method)) throw before('not_supported', 'The backend has no such command.');
      return this.handlers[method](params, c);
    });
    if (!urgent) this.turns.set(key, run.catch(() => {}));
    if (method === 'abort') for (const [other, x] of this.open) if (other !== id && x.key === key) x.cancelled = true;
    c.key = key;
    try {
      // Base64, so that each part has a known size in bytes on the way.
      const text = Buffer.from(JSON.stringify((await run) ?? {})).toString('base64');
      for (let at = 0; at === 0 || at < text.length; at += LIMITS.backendPart) this.link.post({ type: 'reply', id, data: text.slice(at, at + LIMITS.backendPart), more: at + LIMITS.backendPart < text.length });
    } catch (e) {
      if (!e.code) console.error(method, e);
      this.link.post({ type: 'reply', id, error: { code: typeof e.code === 'string' ? e.code : 'internal_error', message: String(e.message).slice(0, 300), before: e.before === true } });
    } finally {
      this.open.delete(id);
    }
  }

  event(event, data) {
    this.link.post({ type: 'event', event, ...data });
  }

  stop() {
    clearTimeout(this.retry);
    this.link.onLost = null;
    this.link.close();
  }
}

/** The record of the running profile that this backend is on, with the process ID of its helper. */
export const profileOf = (link) => link.profiles().find((p) => p.id === link.profile && p.running) ?? null;
