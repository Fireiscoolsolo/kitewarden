// The remote link on the other computer. "node client.mjs pair --host address:port" reads the code from its input, once.
// "node client.mjs" is an MCP server over stdio for a client there. It holds one key of its own, and no key of the computer
// with Firefox.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import tls from 'node:tls';
import { frame, frameReader } from './link.mjs';
import { LIMITS, PROTOCOL, ToolError, VERSION } from './protocol.mjs';
import { serve } from './serve.mjs';
import { TLS, fingerprint } from './wire.mjs';

const CONNECT_MS = 10_000;
const dir = process.env.FC_REMOTE_HOME ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local/share'), 'FirefoxCompanionRemote');
const file = path.join(dir, 'link.json');

/** A connection with a key. Both sides have proved it when this resolves. */
function connect(target, identity, psk) {
  const [, host, port] = /^(.+):(\d+)$/.exec(target) ?? [];
  if (!host) throw new ToolError('invalid_argument', 'The host is address:port.');
  return new Promise((resolve, reject) => {
    const s = tls.connect({ ...TLS, host, port: Number(port), checkServerIdentity: () => undefined, pskCallback: () => ({ identity, psk }) }, () => {
      s.setTimeout(0);
      s.removeAllListeners('error');
      s.on('error', () => {});
      resolve(s);
    });
    s.setTimeout(CONNECT_MS, () => s.destroy(new Error('no answer')));
    s.on('error', (e) => reject(new ToolError('not_connected', /SSL|alert|decrypt/i.test(e.code ?? '') ? 'The gateway did not accept this key. The pairing may have ended or expired.' : `The gateway at ${target} cannot be reached (${e.code ?? e.message}).`)));
  });
}

async function pair(args) {
  const host = args[args.indexOf('--host') + 1];
  if (args[0] !== '--host' || args.length !== 2) throw new Error('Usage: node client.mjs pair --host address:port   and then the code as one line of input');
  process.stderr.write('Code from the Firefox sidebar: ');
  const code = await new Promise((ok) => createInterface({ input: process.stdin }).once('line', ok).once('close', () => ok('')));
  const [, id, secret] = /^\s*fcr1\.([0-9a-f]{8})\.([\w-]{43})\s*$/.exec(code) ?? [];
  if (!id) throw new Error('That is no pairing code.');
  const s = await connect(host, `pair:${id}`, Buffer.from(secret, 'base64url'));
  const key = randomBytes(32).toString('hex');
  const reply = await new Promise((ok, no) => {
    s.on('data', frameReader(4096, ok));
    s.on('close', () => no(new Error('The gateway ended the pairing. The code may be used or too old.')));
    s.write(frame({ type: 'pair', key, device: os.hostname() }));
  });
  s.destroy();
  if (reply.type !== 'paired' || reply.fingerprint !== fingerprint(key)) throw new Error('The gateway gave a wrong answer.');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ host, id, key }), { mode: 0o600 });
  console.log(`Paired. Fingerprint ${reply.fingerprint}. Compare it in the Firefox sidebar and press Allow there.`);
  process.exit(0);
}

/** Like the link over the pipe: one session for each connection, and no call is repeated. */
class RemoteLink {
  constructor() {
    this.client = { name: 'unknown client', version: '' };
    this.socket = null;
    this.pending = new Map();
    this.nextId = 1;
    this.hadSession = false;
    this.announceEnd = false;
    this.ended = null;
    this.connecting = null;
  }

  connect() {
    if (this.socket) return Promise.resolve();
    this.connecting ??= this.#open().finally(() => (this.connecting = null));
    return this.connecting;
  }

  async #open() {
    let link;
    try {
      link = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new ToolError('not_connected', 'This computer is not paired. Run: node client.mjs pair --host address:port');
    }
    const s = await connect(link.host, `id:${link.id}`, Buffer.from(link.key, 'hex'));
    await new Promise((resolve, reject) => {
      const read = frameReader(LIMITS.toClient, (m) => {
        if (m.type === 'ping') return void s.write(frame({ type: 'pong' }));
        if (m.type === 'ready') return m.problem ? reject(new ToolError(m.problem.code, m.problem.message)) : resolve();
        if (m.type === 'bye') return void (this.ended = new ToolError(m.code, String(m.message)));
        const call = m.type === 'result' && this.pending.get(m.id);
        if (!call) return;
        this.pending.delete(m.id);
        if (m.error) call.reject(Object.assign(new ToolError(m.error.code, m.error.message), { data: m.error }));
        else call.resolve(m.result);
      });
      s.on('data', (chunk) => {
        try {
          read(chunk);
        } catch {
          s.destroy();
        }
      });
      s.on('close', () => {
        reject(this.ended ?? new ToolError('not_connected', 'The gateway closed the connection.'));
        this.#lost(s);
      });
      s.write(frame({ type: 'hello', client: this.client }));
    }).catch((e) => {
      s.destroy();
      throw e;
    });
    this.socket = s;
    this.ended = null;
    this.announceEnd = this.hadSession;
    this.hadSession = true;
  }

  #lost(s) {
    if (this.socket !== s) return;
    this.socket = null;
    const calls = [...this.pending.values()];
    this.pending.clear();
    for (const c of calls) c.reject(this.ended ?? new ToolError('outcome_unknown', 'The link to the gateway broke after the call was sent. It is not repeated. Read the page again.'));
  }

  listBrowsers() {
    throw new ToolError('not_supported', 'A remote client works in the Firefox profile that it was paired with.');
  }

  selectBrowser() {
    return this.listBrowsers();
  }

  async call(tool, args, signal) {
    const local = { mcp_server: { version: VERSION, protocol: PROTOCOL, remote: true } };
    if (tool === 'connection_status') {
      try {
        await this.connect();
        return { ...local, ...(await this.#send(tool, args, signal)) };
      } catch (e) {
        return { ...local, state: 'not_connected', next_step: e.message };
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

if (process.argv[2] === 'pair') {
  pair(process.argv.slice(3)).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else serve(new RemoteLink());
