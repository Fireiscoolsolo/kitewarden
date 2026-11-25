// The remote link with the real gateway, the real client, real TLS and the real helper. Firefox is played by the test.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { after, before, test } from 'node:test';
import { frame, frameReader } from '../../dist/mcp/link.mjs';
import { TLS } from '../../dist/remote/wire.mjs';
import { FakeFirefox, McpClient, installHome, root, sleep, until } from '../helpers.mjs';

const PORT = 18_475;
const RELAY = 18_476;
let home, firefox, gateway, base, relay;
let recorded = Buffer.alloc(0);
const open = [];

/** The add-on's side of a backend: one command, and its answer. */
let next = 1;
const answers = new Map();
async function command(method, params = {}) {
  const id = `t${next++}`;
  const reply = new Promise((r) => answers.set(id, r));
  firefox.send({ type: 'to_client', session: gateway.session, body: JSON.stringify({ type: 'command', id, method, params }) });
  const m = await reply;
  if (m.error) throw Object.assign(new Error(m.error.message), { code: m.error.code });
  return JSON.parse(Buffer.from(m.data, 'base64').toString('utf8'));
}
const events = [];
const hellos = [];
const calls = [];
let answer = async (b) => ({ result: { echo: b.tool, args: b.args } });

function play(m) {
  if (m.type !== 'from_client') return;
  const b = JSON.parse(m.body);
  if (b.type === 'hello') hellos.push({ session: m.session, ...b });
  if (b.backend) gateway.session = m.session;
  if (b.type === 'reply') answers.get(b.id)?.(b);
  if (b.type === 'event') events.push(b);
  if (b.type !== 'call') return;
  calls.push({ session: m.session, ...b });
  answer(b, m.session).then((r) => r && firefox.send({ type: 'to_client', session: m.session, body: JSON.stringify({ type: 'result', id: b.id, ...r }) }));
}

async function startGateway() {
  const p = spawn(process.execPath, [path.join(root, 'dist/remote/gateway.mjs'), '--home', home.dir, '--listen', `127.0.0.1:${PORT}`], { stdio: 'pipe', env: { ...process.env, FC_BACKEND_STDIN: '1' } });
  gateway = { p, text: '', session: null, exit: new Promise((r) => p.on('exit', r)) };
  p.stdout.on('data', (d) => (gateway.text += d));
  p.stderr.on('data', (d) => (gateway.text += d));
  await until('gateway connected', () => gateway.session, 15_000);
}
const listening = () => new Promise((r) => {
  const s = net.connect(PORT, '127.0.0.1', () => (s.destroy(), r(true)));
  s.on('error', () => r(false));
});
/** Runs the pairing on "the other computer". */
async function pair(code, dir, port = PORT) {
  const p = spawn(process.execPath, [path.join(root, 'dist/remote/client.mjs'), 'pair', '--host', `127.0.0.1:${port}`], { stdio: 'pipe', env: { ...process.env, FC_REMOTE_HOME: dir } });
  let text = '';
  p.stdout.on('data', (d) => (text += d));
  p.stderr.on('data', (d) => (text += d));
  p.stdin.end(`${code}\n`);
  const status = await new Promise((r) => p.on('exit', r));
  return { status, text };
}
const other = () => mkdtempSync(path.join(base, 'pc-'));
const remote = (dir, name = 'far client') => {
  process.env.FC_REMOTE_HOME = dir;
  const c = new McpClient({ server: path.join(root, 'dist/remote/client.mjs') }, { name });
  delete process.env.FC_REMOTE_HOME;
  open.push(c);
  return c;
};
async function paired({ allow = 60_000, port = PORT } = {}) {
  const dir = other();
  const { id, code } = await command('offer', { until: Date.now() + 60_000 });
  const r = await pair(code, dir, port);
  assert.equal(r.status, 0, r.text);
  if (allow) await command('allow', { id, expires: Date.now() + allow });
  return { id, dir, code, link: JSON.parse(readFileSync(path.join(dir, 'link.json'), 'utf8')) };
}
/** A raw connection with an identity and a key. Resolves to what happened. */
const raw = (identity, psk, messages = []) => new Promise((ok) => {
  const got = [];
  const s = tls.connect({ ...TLS, host: '127.0.0.1', port: PORT, checkServerIdentity: () => undefined, pskCallback: () => ({ identity, psk }) }, () => {
    got.push('up');
    s.on('data', frameReader(1e6, (m) => got.push(m)));
    for (const m of messages) s.write(frame(m));
    setTimeout(() => s.destroy(), 1200);
  });
  s.on('error', (e) => got.push(e.code));
  s.on('close', () => ok(got));
});

before(async () => {
  home = installHome();
  base = mkdtempSync(path.join(os.tmpdir(), 'fc-remote-'));
  firefox = new FakeFirefox(home, { profile: randomUUID(), label: 'Work' });
  firefox.onMessage = play;
  await firefox.wait('hello', (m) => m.type === 'hello');
  // Everything through here is recorded, as somebody on the network would.
  relay = net.createServer((a) => {
    const b = net.connect(PORT, '127.0.0.1');
    for (const [x, y] of [[a, b], [b, a]]) {
      x.on('data', (d) => ((recorded = Buffer.concat([recorded, d])), y.write(d)));
      x.on('close', () => y.destroy());
      x.on('error', () => {});
    }
  });
  await new Promise((r) => relay.listen(RELAY, '127.0.0.1', r));
  await startGateway();
});
after(async () => {
  for (const c of open) c.child.kill();
  gateway.p.stdin.end();
  await gateway.exit;
  relay.close();
  firefox.child.kill();
  await sleep(300);
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await home.close();
});

test('nothing listens before the user turns it on, and nothing after it is turned off; the gateway is a backend and no client', async () => {
  assert.equal(await listening(), false);
  const hello = hellos.find((h) => h.backend);
  assert.deepEqual([hello.backend.id, hello.remote], ['remote', undefined]);
  await command('sync', { clients: [] });
  assert.equal(await listening(), true);
  firefox.send({ type: 'to_client', session: gateway.session, body: JSON.stringify({ type: 'reset' }) });
  await until('closed', async () => !(await listening()), 3000);
  await command('sync', { clients: [] });
  assert.equal(await listening(), true);
});

test('a code works once, for one client, until its time; a wrong or late one gives nothing', async () => {
  assert.equal((await pair(`fcr1.00000000.${randomBytes(32).toString('base64url')}`, other())).status, 1, 'an unknown code');
  assert.equal((await pair('nonsense', other())).status, 1);
  const { id, code } = await command('offer', { until: Date.now() + 60_000 });
  const wrong = `fcr1.${id}.${randomBytes(32).toString('base64url')}`;
  assert.equal((await pair(wrong, other())).status, 1, 'the ID with another secret');
  const dir = other();
  const ok = await pair(code, dir);
  assert.equal(ok.status, 0, ok.text);
  const e = events.find((x) => x.event === 'paired' && x.id === id);
  assert.ok(ok.text.includes(e.fingerprint) && /^([0-9a-f]{4}-){5}[0-9a-f]{4}$/.test(e.fingerprint));
  assert.equal(e.device, os.hostname());
  assert.ok(!ok.text.includes(code) && !gateway.text.includes(code.split('.')[2]));
  assert.equal((await pair(code, other())).status, 1, 'a second use');
  const late = await command('offer', { until: Date.now() + 200 });
  await sleep(400);
  assert.equal((await pair(late.code, other())).status, 1, 'after its time');
});

test('a paired client gets nothing before the user allows it; then its calls come in under its own identity', async () => {
  const n = hellos.length;
  const p = await paired({ allow: 0 });
  const early = remote(p.dir);
  await early.init();
  const no = await early.call('tabs_context');
  assert.equal(no.code, 'not_connected');
  assert.match(no.text, /did not accept this key/);
  assert.equal(hellos.length, n, 'no session in Firefox');
  await command('allow', { id: p.id, expires: Date.now() + 60_000 });
  const c = remote(p.dir, 'laptop client');
  await c.init();
  assert.equal((await c.call('tabs_context')).data.echo, 'tabs_context');
  const h = hellos.at(-1);
  assert.deepEqual([h.remote.id, h.client.name, h.backend, h.ticket], [p.id, 'laptop client', undefined, undefined]);
  assert.match(h.remote.address, /127\.0\.0\.1:\d+$/);
  assert.equal((await c.call('select_browser', { profile: 'x' })).code, 'not_supported');
  assert.equal((await c.call('nope')).code, 'unknown_tool');
});

test('wrong keys, unknown and swapped identities, no TLS, and TLS without a key get no session and no hint', async () => {
  const p = await paired();
  const q = await paired();
  const n = hellos.length;
  const key = Buffer.from(p.link.key, 'hex');
  const results = [await raw(`id:${p.id}`, randomBytes(32)), await raw(`id:${'0'.repeat(8)}`, key), await raw(`id:${q.id}`, key), await raw(`pair:${p.id}`, key), await raw('x', key), await raw('id:../../x', key)];
  for (const r of results) assert.deepEqual(r, results[0], 'an unknown identity looks like a wrong key');
  assert.ok(!results[0].includes('up'));
  const plain = await new Promise((ok) => {
    const s = net.connect(PORT, '127.0.0.1', () => s.write(frame({ type: 'hello', client: { name: 'x' } })));
    let got = '';
    s.on('data', (d) => (got += d));
    s.on('close', () => ok(got));
    s.on('error', () => {});
    setTimeout(() => s.destroy(), 2000);
  });
  assert.ok(!plain.includes('Firefox') && !plain.includes('hello'));
  const cert = await new Promise((ok) => {
    const s = tls.connect({ host: '127.0.0.1', port: PORT, rejectUnauthorized: false }, () => ok('up'));
    s.on('error', (e) => ok(e.code));
  });
  assert.notEqual(cert, 'up');
  assert.equal(hellos.length, n);
});

test('a client that writes its own messages cannot become a backend, a chat or another client', async () => {
  const p = await paired();
  const n = hellos.length;
  const got = await raw(`id:${p.id}`, Buffer.from(p.link.key, 'hex'), [{ type: 'hello', client: { name: 'evil' }, backend: { id: 'isolated' }, ticket: 'x', remote: { id: 'ffffffff' } }, { type: 'call', id: 1, tool: 'tabs_context', args: {} }]);
  assert.ok(got.some((m) => m.type === 'result'), JSON.stringify(got));
  const h = hellos.at(-1);
  assert.equal(hellos.length, n + 1);
  assert.deepEqual([h.backend, h.ticket, h.remote.id], [undefined, undefined, p.id]);
  const odd = await raw(`id:${p.id}`, Buffer.from(p.link.key, 'hex'), [{ type: 'hello', client: { name: 'x' } }, { type: 'reply', id: 't1', data: '' }]);
  assert.ok(!odd.some((m) => m.type === 'result'), 'an unknown message ends the connection');
});

test('revoked in the middle of a call: it ends, the key is deleted, and neither a new connection nor a new pairing with it works', async () => {
  const p = await paired();
  const c = remote(p.dir);
  await c.init();
  assert.equal((await c.call('tabs_context')).code, null);
  answer = async () => null; // never answers
  const waits = c.call('read_page', { tabId: 1 });
  await until('call', () => calls.some((x) => x.tool === 'read_page'));
  answer = async (b) => ({ result: { echo: b.tool } });
  await command('revoke', { id: p.id });
  assert.equal((await waits).code, 'pairing_ended');
  assert.equal((await c.call('tabs_context')).code, 'not_connected');
  assert.ok(!readFileSync(path.join(home.dir, 'remote/clients.json'), 'utf8').includes(p.link.key));
  assert.equal((await pair(p.code, other())).status, 1);
});

test('expired: a running connection ends, a new one is refused; a valid one goes on', async () => {
  const short = await paired({ allow: 2500 });
  const long = await paired();
  const a = remote(short.dir);
  const b = remote(long.dir);
  for (const c of [a, b]) {
    await c.init();
    assert.equal((await c.call('tabs_context')).code, null);
  }
  await sleep(2700);
  assert.equal((await a.call('tabs_context')).code, 'pairing_ended', 'on the open connection');
  const again = remote(short.dir);
  await again.init();
  assert.equal((await again.call('tabs_context')).code, 'not_connected');
  assert.equal((await b.call('tabs_context')).code, null);
});

test('a lost connection: calls end with outcome_unknown and are not repeated; the next one says that the session ended', async () => {
  const p = await paired();
  const c = remote(p.dir);
  await c.init();
  assert.equal((await c.call('tabs_context')).code, null);
  answer = async () => null;
  const waits = c.call('find_text', { tabId: 1, text: 'once' });
  await until('call', () => calls.some((x) => x.tool === 'find_text'));
  answer = async (b) => ({ result: { echo: b.tool } });
  gateway.p.kill();
  assert.equal((await waits).code, 'outcome_unknown');
  assert.equal((await c.call('tabs_context')).code, 'not_connected');
  await startGateway();
  await command('sync', { clients: [{ id: p.id, expires: Date.now() + 60_000 }] });
  assert.equal((await c.call('tabs_context')).code, 'session_ended');
  assert.equal((await c.call('tabs_context')).code, null);
  await sleep(500);
  assert.equal(calls.filter((x) => x.tool === 'find_text').length, 1);
});

test('a cancelled call is cancelled in Firefox, and turning the link off ends every connection', async () => {
  const p = await paired();
  const c = remote(p.dir);
  await c.init();
  answer = async () => null;
  const r = c.request('tools/call', { name: 'wait_for', arguments: { tabId: 1, text: 'x' } });
  await until('call', () => calls.some((x) => x.tool === 'wait_for'));
  c.notify('notifications/cancelled', { requestId: r.id });
  await until('cancel', () => firefox.messages.some((m) => m.type === 'from_client' && JSON.parse(m.body).type === 'cancel'));
  const waits = c.call('find_text', { tabId: 1, text: 'off' });
  await until('call', () => calls.some((x) => x.args?.text === 'off'));
  answer = async (b) => ({ result: { echo: b.tool } });
  firefox.send({ type: 'to_client', session: gateway.session, body: JSON.stringify({ type: 'reset' }) });
  assert.equal((await waits).code, 'outcome_unknown');
  assert.equal(await listening(), false);
  await command('sync', { clients: [] });
  assert.equal((await c.call('tabs_context')).code, 'not_connected', 'its key was deleted, because it was in no valid pairing');
});

test('on the network nothing is readable: no tool, no argument, no name, no key, no code', async () => {
  recorded = Buffer.alloc(0);
  const p = await paired({ port: RELAY });
  const c = remote(p.dir, 'nosy-name-marker');
  await c.init();
  const r = await c.call('find_text', { tabId: 1, text: 'argument-marker' });
  assert.equal(r.code, null, r.text);
  await sleep(200);
  assert.ok(recorded.length > 500);
  const text = recorded.toString('latin1');
  for (const s of ['argument-marker', 'nosy-name-marker', 'find_text', p.link.key, p.code.split('.')[2], os.hostname()]) assert.ok(!text.includes(s), s);
  assert.ok(text.includes(`id:${p.id}`), 'the number of the pairing is visible, and says nothing more');
  for (const s of [p.link.key, p.code.split('.')[2]]) assert.ok(!gateway.text.includes(s));
  assert.equal(existsSync(path.join(p.dir, 'key.bin')), false, 'the other computer has no key of the pipe');
});
