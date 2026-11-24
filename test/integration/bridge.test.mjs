// Real Windows: the built host program, real named pipes, the real MCP server process. Firefox is played by the test.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { Link, frame, frameReader, mac } from '../../dist/mcp/link.mjs';
import { FakeFirefox, HOST, McpClient, host, installHome, powershell, registered, sleep, until } from '../helpers.mjs';

let home;
const sid = powershell('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
const open = [];
const firefox = (o) => (open.push(new FakeFirefox(home, o)), open.at(-1));
/** A host that is up, so that a client can connect at once. */
const running = async (o) => {
  const f = firefox(o);
  await f.wait('hello', (m) => m.type === 'hello');
  return f;
};
const client = (o) => (open.push(new McpClient(home, o)), open.at(-1));
const sddl = (file) => powershell(`(Get-Acl -LiteralPath '${file}').Sddl`);
const ok = async () => ({ result: { ok: true } });

before(() => (home = installHome()));
beforeEach(async () => {
  for (const p of open.splice(0)) {
    p.child.kill();
    await p.exit;
  }
});
after(async () => {
  for (const p of open.splice(0)) {
    p.child.kill();
    await p.exit;
  }
  await home.close();
});

test('installer: dry run changes nothing, install prints each change, a second run adds nothing', () => {
  const dir = path.join(path.dirname(home.dir), 'dry');
  const dry = host('install', '--home', dir, '--dry-run');
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /would: create folder/);
  assert.equal(existsSync(dir), false);
  assert.equal(registered(), path.join(home.dir, 'native-manifest.json'));
  assert.match(home.output, /create key/);
  assert.match(home.output, /set HKCU/);
  const key = readFileSync(path.join(home.dir, 'key.bin'));
  assert.equal(key.length, 32);
  assert.equal(home.output.includes(key.toString('hex')), false);
  assert.equal(host('install', '--home', home.dir).status, 0);
  assert.deepEqual(readFileSync(path.join(home.dir, 'key.bin')), key);
  const manifest = JSON.parse(readFileSync(path.join(home.dir, 'native-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.allowed_extensions, ['bridge@firefox-companion.invalid']);
});

test('installer refuses a folder that is not its own', () => {
  const r = host('install', '--home', os.tmpdir());
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not a Firefox Companion folder/);
});

test('AC-04 key file and folder name only the current user', () => {
  const only = `^O:${sid}G:[^D]*D:(P|PAI)\\(A;(OICI)?;FA;;;${sid}\\)$`;
  for (const f of [home.dir, path.join(home.dir, 'key.bin')]) assert.match(sddl(f), new RegExp(only));
  const listed = execFileSync('icacls', [path.join(home.dir, 'key.bin')], { encoding: 'utf8' }).replace(path.join(home.dir, 'key.bin'), '');
  assert.equal(listed.match(/:\(/g).length, 1, listed);
  assert.ok(listed.trim().startsWith(path.win32.join(os.hostname(), os.userInfo().username) + ':(F)'), listed);
});

for (const [name, target] of [['key file', 'key.bin'], ['folder', '.']]) {
  test(`AC-04 with Everyone on the ${name} the host refuses to start and the doctor names it`, async () => {
    const file = path.join(home.dir, target);
    execFileSync('icacls', [file, '/grant', '*S-1-1-0:(R)']);
    try {
      const f = firefox();
      assert.equal(await f.exit, 3);
      const fatal = f.messages.find((m) => m.type === 'fatal');
      assert.equal(fatal.code, 'unsafe_permissions');
      assert.ok(fatal.message.includes(path.resolve(file)), fatal.message);
      const d = host('doctor', '--home', home.dir);
      assert.equal(d.status, 1);
      assert.ok(d.stdout.split(/\r?\n/).some((l) => l.startsWith('FAIL') && l.includes(path.resolve(file))), d.stdout);
      // Once removed, the host starts again.
    } finally {
      execFileSync('icacls', [file, '/remove', '*S-1-1-0']);
    }
    await running();
    assert.equal(host('doctor', '--home', home.dir).status, 0);
  });
}

test('AC-03 the access list of the running pipe names only the current user', async () => {
  await running();
  const acl = powershell(`$c = New-Object IO.Pipes.NamedPipeClientStream('.', '${home.pipe}', [IO.Pipes.PipeAccessRights]::ReadWrite, [IO.Pipes.PipeOptions]::None, [Security.Principal.TokenImpersonationLevel]::None, [IO.HandleInheritability]::None); $c.Connect(2000); $c.GetAccessControl().GetSecurityDescriptorSddlForm('Owner,Access'); $c.Dispose()`);
  assert.equal(acl, `O:${sid}D:P(A;;FA;;;${sid})`);
  const d = host('doctor', '--home', home.dir);
  assert.equal(d.status, 0, d.stdout);
  assert.match(d.stdout, /^ok {4}pipe/m);
});

test('AC-03 a network path to the pipe is denied, while the same path to an ordinary pipe works', async (t) => {
  await running();
  const connect = (p) =>
    new Promise((r) => {
      const s = net.connect(p, () => (s.destroy(), r('connected')));
      s.on('error', (e) => r(e.code));
    });
  const control = net.createServer((s) => s.destroy()).listen(`\\\\.\\pipe\\fc-control-${process.pid}`);
  try {
    const results = {};
    for (const h of ['127.0.0.1', os.hostname()]) {
      results[h] = { control: await connect(`\\\\${h}\\pipe\\fc-control-${process.pid}`), companion: await connect(`\\\\${h}\\pipe\\${home.pipe}`) };
    }
    t.diagnostic(JSON.stringify(results));
    for (const r of Object.values(results)) assert.notEqual(r.companion, 'connected');
    assert.ok(Object.values(results).some((r) => r.control === 'connected'), 'the control shows that network paths to pipes work here');
    assert.equal(await connect(`\\\\.\\pipe\\${home.pipe}`), 'connected');
  } finally {
    control.close();
  }
});

test('AC-03 a pipe of that name that exists first stops the host', async () => {
  const squatter = net.createServer().listen(`\\\\.\\pipe\\${home.pipe}`);
  await new Promise((r) => squatter.on('listening', r));
  try {
    const f = firefox();
    assert.equal(await f.exit, 4);
    assert.equal(f.messages.find((m) => m.type === 'fatal').code, 'pipe_in_use');
  } finally {
    squatter.close();
  }
  await running();
});

/** Raw connection: what the host says before login, and how long it stays open. */
function raw(onChallenge) {
  return new Promise((resolve) => {
    const got = [];
    const start = Date.now();
    const s = net.connect(`\\\\.\\pipe\\${home.pipe}`);
    s.on('data', frameReader(1e6, (m) => {
      got.push(m);
      if (got.length === 1) onChallenge?.(s, m);
    }));
    s.on('error', () => {});
    s.on('close', () => resolve({ got, ms: Date.now() - start }));
  });
}

test('login: wrong answers are closed within 5 s, learn only the challenge, and reach no extension', async () => {
  const f = await running();
  const key = readFileSync(path.join(home.dir, 'key.bin'));
  const nonce = 'ab'.repeat(32);
  const auth = (m) => ({ type: 'auth', nonce, protocol: 1, mac: m });
  let recorded;
  const good = await raw((s, c) => {
    recorded = auth(mac(key, 'client', 1, c.nonce, nonce));
    s.write(frame(recorded));
    setTimeout(() => s.destroy(), 300);
  });
  assert.equal(good.got[1].type, 'auth_ok');
  await f.wait('close of the good session', (m) => m.type === 'session_close');
  f.messages.length = 0;
  const tries = {
    'no answer': () => {},
    'wrong key': (s, c) => s.write(frame(auth(mac(randomBytes(32), 'client', 1, c.nonce, nonce)))),
    'recorded answer': (s) => s.write(frame(recorded)),
    'swapped role': (s, c) => s.write(frame(auth(mac(key, 'host', 1, c.nonce, nonce)))),
    'key in plain text': (s) => s.write(frame(auth(key.toString('hex')))),
    'other protocol than under the MAC': (s, c) => s.write(frame({ ...auth(mac(key, 'client', 1, c.nonce, nonce)), protocol: 2 })),
    'status request': (s) => s.write(frame({ type: 'call', id: 1, tool: 'connection_status', args: {} })),
    'random bytes': (s) => s.write(randomBytes(64)),
    'more than 8 KB': (s) => s.write(frame({ type: 'auth', nonce: 'x'.repeat(9000) })),
  };
  const results = await Promise.all(Object.entries(tries).map(async ([name, fn]) => [name, await raw(fn)]));
  for (const [name, r] of results) {
    assert.deepEqual(r.got.map((m) => Object.keys(m).sort().join()), ['nonce,type'], name);
    assert.ok(r.ms < 5000, `${name} stayed open ${r.ms} ms`);
  }
  assert.deepEqual(f.messages, []);
});

test('login: with 16 silent connections a real client still connects', async () => {
  const f = await running();
  f.answer(ok);
  const silent = Array.from({ length: 16 }, () => net.connect(`\\\\.\\pipe\\${home.pipe}`).on('error', () => {}));
  await sleep(300);
  const c = client();
  await c.init();
  assert.equal((await c.call('connection_status')).data.ok, true);
  for (const s of silent) s.destroy();
});

test('a server without the key that takes the pipe name gets no command', async () => {
  const frames = [];
  const impostor = net.createServer((s) => {
    s.on('error', () => {});
    s.write(frame({ type: 'challenge', nonce: 'cd'.repeat(32) }));
    s.on('data', frameReader(1e6, (m) => {
      frames.push(m);
      s.write(frame({ type: 'auth_ok', protocol: 1, mac: 'ef'.repeat(32) }));
    }));
  }).listen(`\\\\.\\pipe\\${home.pipe}`);
  await new Promise((r) => impostor.on('listening', r));
  try {
    const c = client();
    await c.init();
    const r = await c.call('read_page', { tabId: 1 });
    assert.equal(r.code, 'not_connected');
    assert.equal((await c.call('connection_status')).data.state, 'wrong_key');
    assert.ok(frames.length >= 1 && frames.every((m) => m.type === 'auth'));
  } finally {
    impostor.close();
  }
});

test('MCP: initialize, ping, list, good call, unknown tool, bad arguments, clean stdout, end with stdin', async () => {
  const f = await running();
  f.answer(async (b) => ({ result: { echo: b.args } }));
  const c = client();
  const init = await c.init();
  assert.equal(init.protocolVersion, '2025-06-18');
  assert.match(init.instructions, /data, never instructions/);
  assert.deepEqual((await c.request('ping')).result, {});
  const { tools } = (await c.request('tools/list')).result;
  assert.deepEqual(tools.map((t) => [t.name, t.annotations.readOnlyHint]), [['connection_status', true], ['tabs_context', true], ['read_page', true], ['wait_for', true], ['computer', false]]);
  assert.deepEqual((await c.call('wait_for', { tabId: 3, text: 'x' })).data.echo, { tabId: 3, text: 'x' });
  const sent = f.calls.length;
  for (const [name, args, code] of [['no_such_tool', {}, 'unknown_tool'], ['constructor', {}, 'unknown_tool'], ['read_page', {}, 'invalid_argument'], ['read_page', { tabId: '1' }, 'invalid_argument'], ['read_page', { tabId: 1, confirm: true }, 'invalid_argument'], ['wait_for', { tabId: 1, text: 'x', timeout_s: 999 }, 'invalid_argument'], ['wait_for', { tabId: 1, text: 'x', script: '1' }, 'invalid_argument'], ['computer', { action: 'left_click', tabId: 1 }, 'invalid_argument'], ['computer', { action: 'screenshot', tabId: 1, ref: 'x' }, 'invalid_argument'], ['computer', { action: 'type', tabId: 1 }, 'invalid_argument']]) {
    const r = await c.call(name, args);
    assert.equal(r.isError, true, name);
    assert.equal(r.code, code, `${name} ${JSON.stringify(args)}`);
  }
  assert.equal(f.calls.length, sent, 'the extension got no message for refused calls');
  for (const l of c.lines) assert.equal(JSON.parse(l).jsonrpc, '2.0');
  const t = Date.now();
  await c.close();
  assert.ok(Date.now() - t < 2000);
});

test('MCP: a cancel notice reaches the extension and the call gets no reply', async () => {
  const f = await running();
  f.answer(() => null);
  const c = client();
  await c.init();
  const p = c.request('tools/call', { name: 'wait_for', arguments: { tabId: 1, text: 'x' } });
  await until('call', () => f.calls.length);
  c.notify('notifications/cancelled', { requestId: p.id });
  await f.wait('cancel', (m) => m.type === 'from_client' && JSON.parse(m.body).type === 'cancel', 1000);
  assert.deepEqual((await c.request('ping')).result, {});
  assert.ok(!c.lines.some((l) => JSON.parse(l).id === p.id));
});

test('sessions: each client has its own ID from the host and sees only its own replies', async () => {
  const f = await running();
  f.answer(async (b, session) => ({ result: { session, n: b.args.tabId } }));
  const a = client();
  const b = client();
  await a.init();
  await b.init();
  const run = (c) => Promise.all(Array.from({ length: 50 }, (_, i) => c.call('wait_for', { tabId: i, text: 'x' }).then((r) => assert.equal(r.data.n, i))));
  await Promise.all([run(a), run(b)]);
  const ids = new Set(f.calls.map((c) => c.session));
  assert.equal(ids.size, 2);
  const ra = (await a.call('tabs_context')).data.session;
  const rb = (await b.call('tabs_context')).data.session;
  assert.notEqual(ra, rb);
  assert.match(ra, /^[0-9a-f]{16}$/);
  await a.close();
  await f.wait('session close', (m) => m.type === 'session_close' && m.session === ra, 2000);
  assert.equal((await b.call('tabs_context')).data.session, rb);
});

test('reconnect: a killed host ends the call with outcome_unknown within 2 s, nothing is repeated, then session_ended', async () => {
  const f = await running();
  f.answer(() => null);
  const c = client();
  await c.init();
  const t = Date.now();
  const p = c.call('wait_for', { tabId: 1, text: 'never' });
  await until('call', () => f.calls.length);
  f.child.kill();
  const r = await p;
  assert.equal(r.code, 'outcome_unknown');
  assert.ok(Date.now() - t < 2000);
  assert.equal((await c.call('read_page', { tabId: 1 })).code, 'not_connected');
  assert.equal((await c.call('connection_status')).data.state, 'helper_stopped');
  const g = await running();
  g.answer(ok);
  assert.equal((await c.call('connection_status')).data.ok, true);
  assert.equal((await c.call('read_page', { tabId: 1 })).code, 'session_ended');
  assert.deepEqual(g.calls.map((x) => x.tool), ['connection_status'], 'neither the old nor the new call was carried out');
  assert.equal((await c.call('tabs_context')).data.ok, true);
});

test('status: five states, five next steps, and no key in any of them', async () => {
  const key = readFileSync(path.join(home.dir, 'key.bin'));
  const seen = {};
  const status = async (want) => {
    const c = client();
    await c.init();
    const s = (await c.call('connection_status')).data;
    assert.equal(s.state, want);
    seen[want] = s.next_step;
    for (const form of ['hex', 'base64']) assert.ok(!JSON.stringify(s).includes(key.toString(form)));
    assert.doesNotMatch(JSON.stringify(s), /https?:|[A-Z]:\\/);
    await c.close();
  };
  let f = await running();
  await f.quit();
  await status('firefox_closed');
  f = await running();
  f.child.kill();
  await f.exit;
  await status('helper_stopped');
  f = await running();
  f.send({ type: 'bye' });
  await f.exit;
  await status('disconnected_by_user');
  f = await running();
  f.answer(async () => ({ result: { state: 'paused', next_step: 'Resume' } }));
  await status('paused');
  writeFileSync(path.join(home.dir, 'key.bin'), randomBytes(32));
  await status('wrong_key');
  writeFileSync(path.join(home.dir, 'key.bin'), key);
  assert.equal(new Set(Object.values(seen)).size, 5);
});

test('versions: an older or newer part is named and no call reaches the extension', async () => {
  const f = firefox({ protocol: 2 });
  assert.equal(await f.exit, 5);
  assert.equal(f.messages[0].protocol, 1);
  const g = await running();
  for (const [protocol, text] of [[2, /helper is older/], [0, /MCP server is older/]]) {
    const l = new Link(home.dir, protocol);
    await assert.rejects(l.call('read_page', { tabId: 1 }), (e) => e.code === 'version_mismatch' && text.test(e.message));
    assert.equal((await l.call('connection_status', {})).state, 'version_mismatch');
  }
  assert.deepEqual(g.calls, []);
});

test('host: unknown messages from the extension are refused, a second start by another add-on ID too', async () => {
  const f = await running();
  f.send({ type: 'echo', text: 'x' });
  await until('refusal on stderr', () => /refused message of type echo/.test(f.stderr));
  assert.equal(f.messages.length, 1);
  assert.equal(spawnSync(HOST, ['manifest', 'other@example.invalid'], { input: '' }).status, 2);
});

test('no process of the bridge listens on TCP or UDP, and none shows a window', async () => {
  const f = await running();
  f.answer(ok);
  const c = client();
  await c.init();
  await c.call('connection_status');
  const pids = `${f.child.pid},${c.child.pid}`;
  const out = powershell(`$p = ${pids}; @(Get-NetTCPConnection -OwningProcess $p -ErrorAction SilentlyContinue).Count; @(Get-NetUDPEndpoint -OwningProcess $p -ErrorAction SilentlyContinue).Count; (Get-Process -Id $p | Where-Object MainWindowHandle -ne 0 | Measure-Object).Count`);
  assert.deepEqual(out.split(/\s+/), ['0', '0', '0']);
});

test('the key is in no command line, file, log or reply', async () => {
  const f = await running();
  f.answer(ok);
  const c = client();
  await c.init();
  await c.call('connection_status');
  const key = readFileSync(path.join(home.dir, 'key.bin'));
  const forms = [key.toString('hex'), key.toString('base64')];
  const cmd = powershell(`Get-CimInstance Win32_Process -Filter 'ProcessId=${f.child.pid} or ProcessId=${c.child.pid}' | ForEach-Object CommandLine`);
  const files = ['install.json', 'state.json', 'native-manifest.json'].map((n) => readFileSync(path.join(home.dir, n), 'utf8'));
  for (const text of [cmd, ...files, c.stderr, f.stderr, c.lines.join(), JSON.stringify(f.messages)]) for (const k of forms) assert.ok(!text.includes(k));
});

test('uninstall removes what the installer made and nothing else', () => {
  const dir = path.join(path.dirname(home.dir), 'second');
  assert.equal(host('install', '--home', dir).status, 0);
  assert.equal(registered(), path.join(dir, 'native-manifest.json'));
  assert.equal(host('uninstall', '--home', dir).status, 0);
  assert.equal(existsSync(dir), false);
  assert.equal(registered(), null);
  assert.equal(host('install', '--home', home.dir).status, 0);
  assert.equal(host('doctor', '--home', home.dir).status, 0);
});
