// The remote link on the computer with Firefox. The user starts it, and it listens only while the user has it turned on in the
// sidebar. TLS with a key for each client, so both sides prove it and nothing is readable on the way; a recorded connection
// stays unreadable when a key is lost later. Who may come in, and until when, is decided in the add-on. This keeps the keys.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { Backend, before, homeOf, options } from '../backends/link.mjs';
import { Link, frame, frameReader } from '../mcp/link.mjs';
import { LIMITS, PROTOCOL, ToolError, oneLine } from '../mcp/protocol.mjs';
import { TLS, fingerprint } from './wire.mjs';

const HANDSHAKE_MS = 8000;
const PING_MS = 15_000;
const SILENT_MS = 45_000;
const SOCKETS = 32;
const PER_CLIENT = 4;

const o = options(process.argv.slice(2), { home: 'folder', listen: 'address:port' });
const home = homeOf(o);
const [, host, port] = /^(.+):(\d+)$/.exec(o.listen ?? '127.0.0.1:8475') ?? [];
if (!host) {
  console.error('--listen takes address:port');
  process.exit(2);
}

// Keys. The folder has the access list of Kitewarden folder: the current user only.
const file = path.join(home, 'remote', 'clients.json');
let clients = {};
try {
  clients = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
function save() {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.new`, JSON.stringify(clients), { mode: 0o600 });
  renameSync(`${file}.new`, file);
}

const offers = new Map(); // id -> { secret, until }
const sockets = new Set(); // every connection, also before its handshake
const sessions = new Set();

const valid = (id) => Object.hasOwn(clients, id) && clients[id].allowed === true && Date.now() < clients[id].expires;

/** The key of an identity. An unknown one gets a random key, so that it looks like a wrong key and tells nothing. */
function keyOf(socket, identity) {
  const [, kind, id] = /^(pair|id):([0-9a-f]{8})$/.exec(identity) ?? [];
  socket.fc = { kind, id };
  if (kind === 'pair' && offers.has(id) && Date.now() < offers.get(id).until) return offers.get(id).secret;
  if (kind === 'id' && valid(id)) return Buffer.from(clients[id].key, 'hex');
  return randomBytes(32);
}

const server = tls.createServer({ ...TLS, handshakeTimeout: HANDSHAKE_MS, pskCallback: keyOf }, (s) => {
  s.address = `${s.remoteAddress}:${s.remotePort}`;
  if (s.fc.kind === 'pair') pair(s);
  else session(s);
});
server.maxConnections = SOCKETS;
server.on('tlsClientError', (e, s) => {
  console.log(`refused ${s?.remoteAddress ?? 'a connection'}: ${e.code ?? 'no valid key'}`);
  s?.destroy();
});
server.on('connection', (s) => {
  sockets.add(s);
  s.on('close', () => sockets.delete(s));
});
server.on('error', (e) => console.error(`listen: ${e.message}`));

/** One message with the key of the client, and the offer is used up. */
function pair(s) {
  const { id } = s.fc;
  const timer = setTimeout(() => s.destroy(), HANDSHAKE_MS);
  const read = frameReader(4096, (m) => {
    clearTimeout(timer);
    const offer = offers.get(id);
    offers.delete(id);
    if (!offer || Date.now() >= offer.until || m.type !== 'pair' || !/^[0-9a-f]{64}$/.test(m.key)) return s.destroy();
    clients[id] = { key: m.key, allowed: false, expires: 0 };
    save();
    const print = fingerprint(m.key);
    backend.event('paired', { id, fingerprint: print, device: oneLine(m.device, 60), address: s.address });
    console.log(`paired ${id}, fingerprint ${print}; it waits for you in the sidebar`);
    s.end(frame({ type: 'paired', id, fingerprint: print }));
  });
  guard(s, read);
}

function guard(s, read) {
  s.on('error', () => {});
  s.on('data', (chunk) => {
    try {
      read(chunk);
    } catch {
      s.destroy();
    }
  });
}

/** One client. It can call tools and cancel them, and say its name; nothing else of what it sends goes on. */
function session(s) {
  const { id } = s.fc;
  if ([...sessions].filter((x) => x.fc.id === id).length >= PER_CLIENT) return s.destroy();
  sessions.add(s);
  const running = new Map();
  let heard = Date.now();
  let link = null;
  const send = (m) => !s.destroyed && s.write(frame(m));
  const bye = (code, message) => {
    send({ type: 'bye', code, message });
    s.end();
  };
  const beat = setInterval(() => {
    if (!valid(id)) return bye('pairing_ended', 'This pairing is over.');
    if (Date.now() - heard > SILENT_MS) return s.destroy();
    send({ type: 'ping' });
  }, PING_MS);
  s.on('close', () => {
    sessions.delete(s);
    clearInterval(beat);
    for (const a of running.values()) a.abort();
    link?.close();
  });
  const open = (client) => {
    link = new Link(home, PROTOCOL, {
      hello: { remote: { id, address: s.address } },
      onMessage: (m) => m.type === 'bye' && m.code === 'pairing_ended' && (bye(m.code, m.message), true),
    });
    link.profile = backend.link.profile; // the profile in which the user paired it
    link.client = { name: oneLine(client?.name, 40) || 'unknown client', version: oneLine(client?.version, 20) };
    link.connect().then(() => send({ type: 'ready' }), (e) => send({ type: 'ready', problem: { code: e.code, message: e.message } }));
  };
  const call = async (m) => {
    const abort = new AbortController();
    running.set(m.id, abort);
    try {
      if (!valid(id)) throw new ToolError('pairing_ended', 'This pairing is over.');
      send({ type: 'result', id: m.id, result: await link.call(String(m.tool), m.args ?? {}, abort.signal) });
    } catch (e) {
      send({ type: 'result', id: m.id, error: e instanceof ToolError ? { ...e.data, code: e.code, message: e.message } : { code: 'internal_error', message: 'The gateway failed.' } });
    } finally {
      running.delete(m.id);
    }
  };
  const read = frameReader(LIMITS.toBrowser, (m) => {
    heard = Date.now();
    if (m.type === 'hello' && !link) open(m.client);
    else if (m.type === 'call' && link && Number.isSafeInteger(m.id) && running.size < 50) call(m);
    else if (m.type === 'cancel') running.get(m.id)?.abort();
    else if (m.type !== 'pong') s.destroy();
  });
  guard(s, read);
}

function drop(id) {
  offers.delete(id);
  if (Object.hasOwn(clients, id)) {
    delete clients[id];
    save();
  }
  for (const s of sessions) {
    if (s.fc.id !== id) continue;
    s.write(frame({ type: 'bye', code: 'pairing_ended', message: 'The user ended this pairing.' }));
    s.end();
    setTimeout(() => s.destroy(), 500);
  }
}

function listen() {
  if (server.listening) return Promise.resolve();
  return new Promise((ok, no) => {
    server.once('error', no);
    server.listen(Number(port), host, () => {
      server.removeListener('error', no);
      const loopback = host === 'localhost' || host === '::1' || /^127\./.test(host);
      console.log(`Listening on ${host}:${server.address().port}${loopback ? '' : '. Other computers can reach this address'}`);
      ok();
    });
  }).catch((e) => Promise.reject(before('not_connected', `The gateway cannot listen on ${host}:${port}: ${e.code}`)));
}

/** Turned off, or the link to the add-on is lost: nothing listens, and nobody is connected. */
function close() {
  offers.clear();
  for (const s of [...sessions, ...sockets]) s.destroy();
  if (server.listening) {
    server.close();
    console.log('Not listening any more.');
  }
}

const handlers = {
  /** Sent when the user turns the link on, with the pairings that are valid. Every other key is deleted. */
  sync: async ({ clients: list }) => {
    const keep = new Map(list.map((c) => [c.id, c.expires]));
    for (const id of Object.keys(clients)) if (!keep.has(id)) delete clients[id];
    for (const [id, expires] of keep) if (Object.hasOwn(clients, id)) Object.assign(clients[id], { allowed: true, expires });
    save();
    await listen();
    return { port: server.address().port };
  },
  offer: async ({ until }) => {
    await listen();
    const id = randomBytes(4).toString('hex');
    const secret = randomBytes(32);
    offers.set(id, { secret, until });
    return { id, code: `fcr1.${id}.${secret.toString('base64url')}` };
  },
  allow: async ({ id, expires }) => {
    if (!Object.hasOwn(clients, id)) throw before('not_found', 'There is no such client.');
    Object.assign(clients[id], { allowed: true, expires });
    save();
  },
  revoke: async ({ id }) => drop(id),
};

const backend = new Backend({ home, id: 'remote', info: { channel: 'TLS 1.2, ECDHE with a key for each client', detail: `listens on ${host}:${port} while it is on` }, handlers, onReset: close });
const end = () => {
  backend.stop();
  close();
  process.exit(0);
};
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(s, end);
if (process.env.FC_BACKEND_STDIN === '1') process.stdin.on('end', end).resume();
backend.run();
