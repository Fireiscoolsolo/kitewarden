// The pipe side of the MCP server: mutual login, one session per connection, no repeated calls.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { LIMITS, PROTOCOL, ToolError, VERSION } from './protocol.mjs';

const AUTH_MS = 5000;
const CONNECT_MS = 3000;

let TICKET = process.env.FC_CHAT_TICKET;
delete process.env.FC_CHAT_TICKET;
const PINNED = process.env.FC_PROFILE || null; // a chat run belongs to the profile that started it

const NEXT = {
  not_installed: 'Run the installer: firefox-companion-host.exe install',
  mail_not_running: 'Start Thunderbird, open Firefox Companion there and press Connect.',
  never_connected: 'Open Firefox, open the Firefox Companion sidebar and press Connect.',
  firefox_closed: 'Start Firefox, open the Firefox Companion sidebar and press Connect.',
  disconnected_by_user: 'The user disconnected. Press Connect in the Firefox Companion sidebar.',
  helper_stopped: 'The helper stopped. Firefox starts it again within 30 s; otherwise press Retry now in the sidebar.',
  wrong_key: 'The helper and this server do not share a key. Run: firefox-companion-host.exe doctor',
  version_mismatch: 'Update the older part, then press Retry now in the sidebar.',
};

export const mac = (key, role, protocol, hostNonce, clientNonce) =>
  createHmac('sha256', key).update(`firefox-companion|${role}|${protocol}|${hostNonce}|${clientNonce}`).digest('hex');

const same = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const frame = (obj) => {
  const body = Buffer.from(JSON.stringify(obj));
  const head = Buffer.alloc(4);
  head.writeInt32LE(body.length);
  return Buffer.concat([head, body]);
};

/** Calls `onMessage` for each whole frame. Throws on a frame over the limit. */
export function frameReader(limit, onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const n = buf.readInt32LE(0);
      if (n < 2 || n > limit) throw new Error(`frame of ${n} bytes`);
      if (buf.length < 4 + n) return;
      const body = buf.subarray(4, 4 + n);
      buf = buf.subarray(4 + n);
      onMessage(JSON.parse(body.toString('utf8')));
    }
  };
}

export class Link {
  /** `kind` is the program on the other side, 'firefox' or 'mail'. `hello` is added to the first message, for a backend. */
  constructor(home, protocol = PROTOCOL, { kind = 'firefox', hello = {}, onMessage = null, onLost = null } = {}) {
    Object.assign(this, { kind, hello, onMessage, onLost });
    this.home = home;
    this.protocol = protocol;
    this.profile = PINNED;
    this.client = { name: 'unknown client', version: '' };
    this.socket = null;
    this.pending = new Map();
    this.nextId = 1;
    this.hadSession = false;
    this.announceEnd = false; // the earlier session ended and the next call has to say so
    this.state = 'never_connected';
    this.lastLoss = null;
    this.connecting = null;
  }

  connect() {
    if (this.socket) return Promise.resolve();
    this.connecting ??= this.#login().finally(() => (this.connecting = null));
    return this.connecting;
  }

  async #login() {
    let key, pipe;
    try {
      key = readFileSync(path.join(this.home, 'key.bin'));
      pipe = JSON.parse(readFileSync(path.join(this.home, 'install.json'), 'utf8')).pipe;
      const p = this.#choose();
      if (p) pipe = p.pipe;
    } catch (e) {
      if (e instanceof ToolError) throw e;
      throw this.#down(e.code === 'ENOENT' ? 'not_installed' : 'wrong_key');
    }
    const socket = net.connect(`\\\\.\\pipe\\${pipe}`);
    const nonce = randomBytes(32).toString('hex');
    await new Promise((resolve, reject) => {
      let hostNonce = null;
      let opened = false;
      const fail = (state, detail) => {
        clearTimeout(timer);
        socket.removeAllListeners();
        socket.on('error', () => {});
        socket.destroy();
        reject(this.#down(state, detail));
      };
      let timer = setTimeout(() => fail('helper_stopped'), CONNECT_MS);
      socket.on('connect', () => {
        opened = true;
        clearTimeout(timer);
        timer = setTimeout(() => fail('wrong_key'), AUTH_MS);
      });
      socket.on('error', (e) => fail(opened ? 'wrong_key' : e.code === 'ENOENT' ? this.#whyNoPipe() : 'helper_stopped'));
      socket.on('close', () => fail(opened ? 'wrong_key' : this.#whyNoPipe()));
      const read = frameReader(LIMITS.toClient, (m) => {
        if (!hostNonce) {
          if (m.type !== 'challenge' || !/^[0-9a-f]{64}$/.test(m.nonce)) return fail('wrong_key');
          hostNonce = m.nonce;
          socket.write(frame({ type: 'auth', nonce, protocol: this.protocol, mac: mac(key, 'client', this.protocol, hostNonce, nonce) }));
          return;
        }
        // A server without the key never gets past this line, so it gets no command.
        if (m.type !== 'auth_ok' || !same(m.mac, mac(key, 'host', m.protocol, hostNonce, nonce))) return fail('wrong_key');
        if (m.protocol !== this.protocol) {
          return fail('version_mismatch', m.protocol < this.protocol ? 'The helper is older than this MCP server.' : 'This MCP server is older than the helper.');
        }
        clearTimeout(timer);
        socket.removeAllListeners();
        resolve();
      });
      socket.on('data', (chunk) => {
        try {
          read(chunk);
        } catch {
          fail('wrong_key');
        }
      });
    });
    this.#attach(socket);
  }

  #attach(socket) {
    this.socket = socket;
    this.state = 'connected';
    this.profile ??= this.#choose()?.id ?? null; // the client stays with it, also after a lost link
    this.announceEnd = this.hadSession;
    this.hadSession = true;
    const read = frameReader(LIMITS.toClient, (m) => this.#onMessage(m));
    socket.on('data', (chunk) => {
      try {
        read(chunk);
      } catch (e) {
        console.error(`link: ${e.message}`);
        socket.destroy();
      }
    });
    socket.on('error', (e) => (this.lastLoss = e.code ?? e.message));
    socket.on('close', () => this.#lost(socket));
    // The ticket of a chat run works once, so only the first link of this process carries it.
    socket.write(frame({ ...this.hello, type: 'hello', client: this.client, ticket: TICKET }));
    TICKET = undefined;
  }

  #onMessage(m) {
    const call = m.type === 'result' && this.pending.get(m.id);
    if (!call) {
      if (this.onMessage?.(m)) return;
      if (m.type === 'bye') this.lastLoss = String(m.message);
      else console.error(`link: refused message of type ${m.type}`);
      return;
    }
    this.pending.delete(m.id);
    if (m.error) call.reject(Object.assign(new ToolError(m.error.code, m.error.message), { data: m.error }));
    else call.resolve(m.result);
  }

  #lost(socket) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.state = 'helper_stopped';
    this.lastLoss ??= 'the pipe closed';
    const calls = [...this.pending.values()];
    this.pending.clear();
    for (const c of calls) {
      c.reject(new ToolError('outcome_unknown', 'The link to Firefox broke after the call was sent. It is not repeated. Read the page again.'));
    }
    this.onLost?.();
  }

  /** Firefox profiles that this installation knows, the running ones first. */
  profiles() {
    let names = [];
    try {
      names = readdirSync(path.join(this.home, 'profiles')).filter((f) => f.endsWith('.json'));
    } catch {
      // no profile has connected yet
    }
    const list = [];
    for (const f of names) {
      try {
        const p = JSON.parse(readFileSync(path.join(this.home, 'profiles', f), 'utf8'));
        if ((p.kind ?? 'firefox') === this.kind) list.push({ ...p, running: p.state === 'running' && alive(p.pid) });
      } catch {
        // written at this moment
      }
    }
    return list.sort((a, b) => b.running - a.running || String(b.at).localeCompare(String(a.at)));
  }

  /** The profile to use. With several running ones the client has to pick. */
  #choose() {
    const list = this.profiles();
    if (this.profile) return list.find((p) => p.id === this.profile) ?? null;
    const running = list.filter((p) => p.running);
    if (running.length > 1) throw new ToolError('ambiguous', `Several Firefox profiles are connected: ${running.map((p) => `${JSON.stringify(p.label)} (${p.id.slice(0, 8)})`).join(', ')}. Ask the user which one, then call select_browser.`);
    return running[0] ?? list[0] ?? null;
  }

  listBrowsers() {
    return { browsers: this.profiles().filter((p) => p.running).map((p) => ({ id: p.id, label: p.label, version: p.host, in_use: p.id === this.profile })), ...(this.profiles().some((p) => p.running) ? {} : { next_step: NEXT.firefox_closed }) };
  }

  selectBrowser(wanted) {
    if (PINNED) throw new ToolError('not_allowed', 'A chat stays in the profile that started it.');
    const running = this.profiles().filter((p) => p.running);
    const hits = running.filter((p) => p.id === wanted || p.id.startsWith(wanted.toLowerCase()) || p.label.toLowerCase() === wanted.toLowerCase());
    if (hits.length !== 1) throw new ToolError(hits.length ? 'ambiguous' : 'not_found', `Connected: ${running.map((p) => `${JSON.stringify(p.label)} (${p.id})`).join(', ') || 'none'}.`);
    if (hits[0].id !== this.profile) {
      // The session in the other profile ends, and the new one begins without grants.
      this.close();
      this.socket = null;
      this.hadSession = false;
      this.profile = hits[0].id;
    }
    return { using: hits[0].id, label: hits[0].label };
  }

  #whyNoPipe() {
    if (this.kind === 'mail') return 'mail_not_running';
    try {
      const s = (this.profiles().find((p) => !this.profile || p.id === this.profile) ?? JSON.parse(readFileSync(path.join(this.home, 'state.json'), 'utf8'))).state;
      return s === 'running' ? 'helper_stopped' : s in NEXT ? s : 'never_connected';
    } catch {
      return 'never_connected';
    }
  }

  #down(state, detail = '') {
    this.state = state;
    return new ToolError(state === 'version_mismatch' ? state : 'not_connected', `${detail} ${NEXT[state]}`.trim());
  }

  /** The part of connection_status that this process knows by itself. */
  localStatus() {
    return {
      mcp_server: { version: VERSION, protocol: this.protocol },
      state: this.state,
      last_loss: this.lastLoss,
      next_step: NEXT[this.state] ?? null,
    };
  }

  /** One message outside of a call, for a backend. */
  post(m) {
    this.socket?.write(frame(m));
  }

  async call(tool, args, signal) {
    if (tool === 'connection_status') {
      try {
        await this.connect();
        return { ...this.localStatus(), ...(await this.#send(tool, args, signal)) };
      } catch {
        return this.localStatus();
      }
    }
    await this.connect();
    if (this.announceEnd) {
      this.announceEnd = false;
      throw new ToolError('session_ended', 'The earlier session ended. A new session without grants has begun and this call was not carried out. Ask the user to attach the tab again.');
    }
    return this.#send(tool, args, signal);
  }

  #send(tool, args, signal) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const data = frame({ type: 'call', id, tool, args });
      if (data.length - 4 > LIMITS.toBrowser) return reject(new ToolError('too_large', 'The call is too large.'));
      if (signal?.aborted) return reject(new ToolError('cancelled', 'The client cancelled the call.'));
      this.pending.set(id, { resolve, reject });
      signal?.addEventListener('abort', () => {
        if (!this.pending.delete(id)) return;
        this.socket?.write(frame({ type: 'cancel', id }));
        reject(new ToolError('cancelled', 'The client cancelled the call.'));
      });
      this.socket.write(data);
    });
  }

  close() {
    this.socket?.destroy();
  }
}
