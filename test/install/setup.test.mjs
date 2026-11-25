// The packaged artifacts of release/, as a user gets them: FirefoxCompanionSetup on real Windows files, registry, processes and
// pipes. Firefox is played by the test; test/firefox/packaged.mjs has the real one. Claude Code is the installed one with an
// empty configuration folder of its own; no model is called.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { bundleManifest, sha256, tree, zip } from '../../build/release.mjs';
import { VERSION } from '../../shared/protocol.mjs';
import { FakeFirefox, McpClient, buildAt, powershell, root, until } from '../helpers.mjs';

const release = path.join(root, 'release');
const SETUP = path.join(release, `FirefoxCompanionSetup-${VERSION}.exe`);
const BASELINE = 'e46f5c5'; // version 0.4.0, the state before this installer
const REG = 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\firefox_companion';
const APPS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
const PROFILE = '11111111-2222-3333-4444-555555555555';
const PROGRAM = ['NOTICE.txt', 'firefox-companion-host.exe', 'install.json', 'installed.json', 'key.bin', 'mcp/link.mjs', 'mcp/protocol.mjs', 'mcp/serve.mjs', 'mcp/server.mjs', 'native-manifest.json'];

/** The registration. reg.exe prints in the code page of the console, which has not every letter. */
const value = (key, name) => Buffer.from(powershell(`$v = [Microsoft.Win32.Registry]::GetValue('${key.replace('HKCU', 'HKEY_CURRENT_USER')}', '${name}', $null); if ($v) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v)) }`), 'base64').toString('utf8') || null;
const registered = () => value(REG, '');
const base = mkdtempSync(path.join(os.tmpdir(), 'fc-setup-'));
const earlier = registered();
const open = [];
// No setting of the Claude session that runs this test reaches the programs, and Claude Code never uses the user's configuration.
const clean = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/.test(k))), CLAUDE_CONFIG_DIR: path.join(base, 'claude') };
const run = (exe, args, opts = {}) => spawnSync(exe, args, { encoding: 'utf8', env: clean, ...opts });
const setup = (...args) => run(SETUP, args);
const apps = () => (run('reg', ['query', APPS]).stdout ?? '').split(/\r?\n/).filter((l) => /\\FirefoxCompanion(-|$)/.test(l));
const helpers = (dir) => Number(powershell(`@(Get-Process firefox-companion-host -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${dir.replaceAll("'", "''")}\\*' }).Count`));
const names = (dir) => tree(dir).map(([n]) => n).sort();
const bytes = (dir) => Object.fromEntries(tree(dir).map(([n, d]) => [n, sha256(d)]));
let count = 0;
function place(name = 'Jörg Müller & Söhne') {
  const dir = path.join(base, `${++count}`, name, 'home');
  mkdirSync(path.dirname(dir), { recursive: true });
  return { dir, exe: path.join(dir, 'firefox-companion-host.exe'), server: path.join(dir, 'mcp/server.mjs'), file: (n) => path.join(dir, n) };
}
function fresh(...more) {
  const h = place();
  const r = setup('install', '--home', h.dir, ...more);
  assert.equal(r.status, 0, r.stderr);
  return h;
}
async function connected(h) {
  const f = new FakeFirefox(h, { profile: PROFILE, label: 'Test' });
  open.push(f);
  f.answer(() => ({ result: { tabs: [], note: 'played by the test' } }));
  await f.wait('helper answers', (m) => m.type === 'hello');
  return f;
}
async function client(h, args = []) {
  const c = new McpClient(h, { args });
  open.push(c);
  await c.init();
  return c;
}
let old; // dist/ of the version before
before(() => (old = buildAt(BASELINE, path.join(base, 'before'))));
const before040 = (h) => {
  const r = run(path.join(old, 'host/firefox-companion-host.exe'), ['install', '--home', h.dir]);
  assert.equal(r.status, 0, r.stderr);
  return h;
};

afterEach(async () => {
  for (const p of open.splice(0)) {
    p.child.kill();
    await p.exit;
  }
  for (const d of readdirSync(base).filter((n) => /^\d+$/.test(n))) for (const n of readdirSync(path.join(base, d))) setup('uninstall', '--home', path.join(base, d, n, 'home'));
  assert.deepEqual(apps(), [], 'nothing of the tests is left in Settings, Apps');
});
after(async () => {
  if (earlier) execFileSync('reg', ['add', REG, '/ve', '/d', earlier, '/f']);
  else run('reg', ['delete', REG, '/f']);
  await until('folder removed', () => {
    try {
      rmSync(base, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }, 8000, 300);
});

// ---- what is in the packages

test('checksums name every file of the release, and a second packing of the same files gives the same bytes', () => {
  const sums = readFileSync(path.join(release, 'SHA256SUMS.txt'), 'utf8').trim().split('\n').map((l) => l.split('  '));
  assert.deepEqual(sums.map(([, n]) => n).sort(), names(release).filter((n) => n !== 'SHA256SUMS.txt'));
  for (const [hash, n] of sums) assert.equal(sha256(readFileSync(path.join(release, n))), hash, n);
  const again = zip([...tree(path.join(root, 'dist/extension')), ['NOTICE.txt', readFileSync(path.join(root, 'NOTICE.txt'))]].reverse());
  assert.ok(again.equals(readFileSync(path.join(release, `firefox-companion-${VERSION}-unsigned.xpi`))));
});

const unpack = (file) => {
  const dir = mkdtempSync(path.join(base, 'unpacked-'));
  execFileSync(path.join(process.env.SystemRoot, 'System32/tar.exe'), ['-xf', path.join(release, file), '-C', dir]); // another reader than ours
  return dir;
};

test('Firefox package: exactly the everyday add-on, cookies optional, nothing of the developer build, Thunderbird or the optional programs', () => {
  const dir = unpack(`firefox-companion-${VERSION}-unsigned.xpi`);
  assert.deepEqual(names(dir), [...names(path.join(root, 'dist/extension')), 'NOTICE.txt'].sort());
  const m = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.ok(!m.permissions.includes('cookies') && m.optional_permissions.includes('cookies'));
  assert.deepEqual([m.version, m.name, m.browser_specific_settings.gecko.id, m.browser_specific_settings.gecko.strict_min_version, m.browser_specific_settings.gecko.update_url], [VERSION, 'Firefox Companion (working name)', 'bridge@firefox-companion.invalid', '160.0', undefined]);
  for (const [n, d] of tree(dir)) assert.ok(!/javascript_tool|pagescript|messagesRead|remote-debugging/.test(d) && !/thunderbird|isolated|gateway|input\.exe|pagescript/i.test(n), n);
  const mail = JSON.parse(readFileSync(path.join(unpack(`optional/firefox-companion-mail-${VERSION}-unsigned.xpi`), 'manifest.json'), 'utf8'));
  assert.equal(mail.browser_specific_settings.gecko.id, 'mail@firefox-companion.invalid');
});

test('Claude Desktop bundle: fields of MCPB 0.3, the tools that the server has, and it starts as its manifest says', async () => {
  const dir = unpack(`firefox-companion-${VERSION}.mcpb`);
  const m = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.deepEqual(m, bundleManifest());
  // The schema of 0.3 is strict: an unknown field is an error.
  const allowed = ['manifest_version', 'name', 'display_name', 'version', 'description', 'long_description', 'author', 'license', 'server', 'tools', 'compatibility', 'user_config'];
  assert.deepEqual(Object.keys(m).filter((k) => !allowed.includes(k)), []);
  assert.ok(existsSync(path.join(dir, m.server.entry_point)));
  const h = fresh();
  const f = await connected(h);
  const fill = (s) => s.replace('${__dirname}', dir).replace('${user_config.home}', h.dir.replaceAll('\\', '/'));
  const [server, ...args] = m.server.mcp_config.args.map(fill);
  const c = await client({ server }, args);
  const { result } = await c.request('tools/list');
  assert.deepEqual(result.tools.map((t) => t.name), m.tools.map((t) => t.name));
  assert.ok(!result.tools.some((t) => /javascript|isolated|windows_input/.test(t.name)), 'no tool of an optional part');
  assert.equal((await c.call('connection_status')).data.state, 'connected');
  assert.ok(!(await c.call('tabs_context')).isError);
  assert.equal(f.calls.at(-1).tool, 'tabs_context');
  assert.equal(m.user_config.home.default.replace('${HOME}', os.homedir()).replaceAll('/', '\\'), path.join(process.env.LOCALAPPDATA, 'FirefoxCompanion'));
});

test('optional package: each program reaches the installed helper, waits to be turned on, and nothing listens', async () => {
  const dir = unpack(`optional/firefox-companion-optional-${VERSION}.zip`);
  const h = fresh();
  const f = await connected(h);
  for (const [id, file] of [['input', 'backends/input.mjs'], ['remote', 'remote/gateway.mjs']]) {
    const p = spawn(process.execPath, [path.join(dir, file), '--home', h.dir], { stdio: 'pipe', env: { ...clean, FC_BACKEND_STDIN: '1' } });
    open.push({ child: p, exit: new Promise((r) => p.on('exit', r)) });
    await f.wait(`${id} says hello`, (m) => m.type === 'from_client' && JSON.parse(m.body).backend?.id === id);
  }
  const listens = await new Promise((r) => net.connect(8475, '127.0.0.1').once('connect', () => r(true)).once('error', () => r(false)));
  assert.equal(listens, false);
  assert.ok(!existsSync(h.file('remote')) && !existsSync(h.file('backends')), 'they put nothing into the installation by themselves');
});

test('a damaged installer names the file and changes nothing', () => {
  const exe = path.join(base, 'damaged.exe');
  const b = readFileSync(SETUP);
  const at = b.indexOf(readFileSync(path.join(root, 'dist/mcp/serve.mjs')));
  assert.ok(at > 0);
  b[at + 100] ^= 1;
  writeFileSync(exe, b);
  const h = place();
  const was = registered();
  const r = run(exe, ['install', '--home', h.dir]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /damaged: mcp\\serve\.mjs/);
  assert.ok(!existsSync(h.dir));
  assert.equal(registered(), was);
});

// ---- fresh install

test('fresh install: dry run changes nothing; then only its own files, one registration, one entry in Settings; a second run changes nothing', () => {
  const h = place();
  const was = registered();
  const dry = setup('install', '--home', h.dir, '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /would: create folder[\s\S]*would: set HKCU[\s\S]*would: list it in Settings/);
  assert.ok(!existsSync(h.dir));
  assert.equal(registered(), was);
  assert.equal(setup('install', '--home', h.dir).status, 0);
  assert.deepEqual(names(h.dir), PROGRAM, 'no remote, Windows input, isolated Firefox, Thunderbird or chat file');
  assert.equal(registered(), h.file('native-manifest.json'));
  assert.equal(JSON.parse(readFileSync(h.file('native-manifest.json'), 'utf8')).path, h.exe);
  assert.equal(apps().length, 1);
  const entry = apps()[0].trim().replace('HKEY_CURRENT_USER', 'HKCU');
  assert.equal(value(entry, 'DisplayVersion'), VERSION);
  assert.equal(value(entry, 'InstallLocation'), h.dir);
  const d = setup('doctor', '--home', h.dir);
  assert.equal(d.status, 0, d.stdout);
  const all = bytes(h.dir);
  assert.equal(setup('install', '--home', h.dir).status, 0);
  assert.deepEqual(bytes(h.dir), all);
  assert.equal(apps().length, 1);
  assert.equal(helpers(h.dir), 0, 'nothing runs until Firefox starts it');
  assert.ok(!/fc-setup|FirefoxCompanion/.test(run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run']).stdout), 'nothing starts at logon');
});

test('helper and server of the installation find each other by the shared key, and the doctor proves the key without a session', async () => {
  const h = fresh();
  const f = await connected(h);
  const c = await client(h);
  assert.equal((await c.call('connection_status')).data.state, 'connected');
  const sessions = f.messages.filter((m) => m.type === 'session_open').length;
  const d = setup('doctor', '--home', h.dir);
  assert.equal(d.status, 0, d.stdout);
  assert.match(d.stdout, /ok {4}pipe/);
  assert.match(d.stdout, new RegExp(`info {2}profile Test .firefox.: last state running, helper ${VERSION.replaceAll('.', '[.]')}`));
  assert.equal(f.messages.filter((m) => m.type === 'session_open').length, sessions);
  writeFileSync(h.file('key.bin'), Buffer.alloc(32, 7));
  const wrong = setup('doctor', '--home', h.dir);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stdout, /FAIL {2}pipe: the helper has another key\. Fix/);
  assert.ok(!wrong.stdout.includes('07070707'));
});

test('a person who starts it can look, refuse and diagnose without any change', () => {
  const was = [registered(), apps()];
  const config = mkdtempSync(path.join(base, 'config-'));
  for (const [input, says] of [['q\n', /Not installed yet|Installed here/], ['i\nn\n', /Do this\? \[y\/N\]/], ['d\n\n', /windows/], ['', /quit/]]) assert.match(run(SETUP, [], { input, env: { ...clean, CLAUDE_CONFIG_DIR: config } }).stdout, says);
  assert.deepEqual([registered(), apps()], was);
});

const standard = path.join(process.env.LOCALAPPDATA, 'FirefoxCompanion');
test('a person installs into the standard folder, and removes it from there', { skip: existsSync(standard) || earlier ? 'this user has an installation' : false }, () => {
  const config = mkdtempSync(path.join(base, 'config-'));
  const env = { ...clean, CLAUDE_CONFIG_DIR: config };
  try {
    const r = run(SETUP, [], { input: 'i\ny\nn\n\n', env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(names(standard), PROGRAM);
    assert.deepEqual(readdirSync(config), [], 'No to Claude Code leaves its settings alone');
    assert.equal(value(`${APPS}\\FirefoxCompanion`, 'UninstallString'),`"${path.join(standard, 'firefox-companion-host.exe')}" uninstall --home "${standard}" --ask`);
    assert.equal(run(path.join(standard, 'firefox-companion-host.exe'), ['uninstall', '--home', standard, '--ask'], { input: 'n\n' }).status, 1);
    assert.ok(existsSync(standard));
  } finally {
    run(path.join(standard, 'firefox-companion-host.exe'), ['uninstall', '--home', standard, '--ask'], { input: 'y\n\n' });
  }
  assert.ok(!existsSync(standard));
  assert.deepEqual(apps(), []);
  assert.equal(registered(), null);
});

// ---- Claude Code

test('Claude Code: one entry by its own command, only when asked; another entry of that name and other servers stay', { timeout: 180_000 }, () => {
  const config = mkdtempSync(path.join(base, 'config-'));
  const env = { ...clean, CLAUDE_CONFIG_DIR: config };
  const file = path.join(config, '.claude.json');
  const servers = () => JSON.parse(readFileSync(file, 'utf8')).mcpServers ?? {};
  assert.equal(run('claude', ['mcp', 'add', '-s', 'user', 'other', '--', 'node', 'other.mjs'], { env }).status, 0);
  const h = place();
  const untouched = readFileSync(file);
  assert.equal(run(SETUP, ['install', '--home', h.dir], { env }).status, 0);
  assert.ok(readFileSync(file).equals(untouched), 'not asked: byte for byte the same');
  for (let i = 0; i < 2; i++) {
    const r = run(SETUP, ['install', '--home', h.dir, '--claude-code'], { env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(Object.keys(servers()).sort(), ['firefox-companion', 'other']);
    assert.deepEqual(servers()['firefox-companion'].args, [h.server.replaceAll('/', '\\')]);
  }
  const d = run(SETUP, ['doctor', '--home', h.dir, '--claude-code'], { env });
  assert.match(d.stdout, /ok {4}claude code entry/, 'Claude Code itself starts the installed server and connects');
  assert.ok(!existsSync(path.join(config, 'settings.json')), 'no allow rule, hook or instruction file');
  // A second installation must not take over the entry, and must not remove it later.
  const h2 = place();
  const r2 = run(SETUP, ['install', '--home', h2.dir, '--claude-code'], { env });
  assert.equal(r2.status, 3);
  assert.match(r2.stderr, /left as it is/);
  assert.equal(run(SETUP, ['uninstall', '--home', h2.dir], { env }).status, 0);
  assert.deepEqual(Object.keys(servers()).sort(), ['firefox-companion', 'other']);
  // An entry that the user changed since then is not ours any more.
  const h3 = place();
  run('claude', ['mcp', 'remove', '-s', 'user', 'firefox-companion'], { env });
  assert.equal(run(SETUP, ['install', '--home', h3.dir, '--claude-code'], { env }).status, 0);
  run('claude', ['mcp', 'remove', '-s', 'user', 'firefox-companion'], { env });
  run('claude', ['mcp', 'add', '-s', 'user', 'firefox-companion', '--', 'node', 'mine.mjs'], { env });
  assert.equal(run(SETUP, ['uninstall', '--home', h3.dir], { env }).status, 0);
  assert.deepEqual(servers()['firefox-companion'].args, ['mine.mjs']);
  run('claude', ['mcp', 'remove', '-s', 'user', 'firefox-companion'], { env });
  assert.equal(run(SETUP, ['install', '--home', h.dir, '--claude-code'], { env }).status, 0);
  // The folder of the configuration is remembered, so removing works with another one.
  assert.equal(setup('uninstall', '--home', h.dir).status, 0);
  assert.deepEqual(Object.keys(servers()), ['other']);
});

// ---- upgrade

test('upgrade from 0.4.0 while the helper runs: key, pipe, pairings, profiles and Thunderbird stay, nothing is turned on, and it reconnects', async () => {
  const h = before040(place());
  assert.equal(run(path.join(old, 'host/firefox-companion-host.exe'), ['install', '--home', h.dir, '--thunderbird']).status, 0);
  mkdirSync(h.file('remote'));
  writeFileSync(h.file('remote/clients.json'), '{"a-client":{"key":"kept"}}');
  const f = await connected(h);
  const c = await client(h); // a 0.4.0 server that its client keeps running
  assert.equal((await c.call('connection_status')).data.mcp_server.version, '0.4.0');
  await c.call('tabs_context');
  const keep = ['key.bin', 'install.json', 'remote/clients.json', 'native-manifest-mail.json', `profiles/${PROFILE}.json`];
  const was = keep.slice(0, -1).map((n) => readFileSync(h.file(n)));
  assert.equal(setup('doctor', '--home', h.dir).status, 1, 'the new doctor sees that this is not its own version');
  const r = setup('install', '--home', h.dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /stop the running helper, process \d+/);
  await f.exit; // Firefox sees the helper go and starts it again
  for (const n of keep) assert.ok(existsSync(h.file(n)), n);
  assert.deepEqual(keep.slice(0, -1).map((n) => readFileSync(h.file(n))), was);
  assert.deepEqual(names(h.dir).filter((n) => !PROGRAM.includes(n)).sort(), ['native-manifest-mail.json', `profiles/${PROFILE}.json`, 'remote/clients.json', 'state.json'].sort());
  assert.equal(JSON.parse(readFileSync(h.file('installed.json'))).version, VERSION);
  assert.equal(helpers(h.dir), 0, 'no helper by itself');
  const f2 = await connected(h);
  assert.equal(f2.messages.find((m) => m.type === 'hello').host, VERSION);
  assert.equal((await c.call('tabs_context')).code, 'session_ended', 'the running client is told that its session ended');
  assert.ok(!(await c.call('tabs_context')).isError, 'and goes on with the same key');
  const d = setup('doctor', '--home', h.dir);
  assert.equal(d.status, 0, d.stdout);
  assert.match(d.stdout, /ok {4}thunderbird/);
});

test('an older installer is refused when a newer version is there', () => {
  const h = fresh();
  const was = readFileSync(h.file('installed.json'), 'utf8');
  writeFileSync(h.file('installed.json'), was.replace(`"${VERSION}"`, '"9.0.0"'));
  const r = setup('install', '--home', h.dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /9\.0\.0 is installed, which is newer/);
});

// ---- interrupted

/** Kills the installer `ms` after its own journal appears, so in the middle of the exchange of files, or `ms` after its start. Returns whether a journal is left. */
async function cut(h, ms, from = 'journal') {
  const journal = () => {
    try {
      return readFileSync(h.file('setup/journal.txt'), 'utf8');
    } catch {
      return null;
    }
  };
  const earlierOne = journal();
  const p = spawn(SETUP, ['install', '--home', h.dir], { stdio: 'ignore', env: clean });
  const end = new Promise((r) => p.on('exit', r));
  while (from === 'journal' && p.exitCode === null && [null, earlierOne].includes(journal())) await new Promise((r) => setImmediate(r));
  const t = performance.now() + ms;
  while (performance.now() < t);
  p.kill('SIGKILL');
  await end;
  return existsSync(h.file('setup/journal.txt'));
}

test('an upgrade that is killed leaves something that the next run repairs, with the same key and pairings', { timeout: 300_000 }, async (t) => {
  const h = before040(place());
  mkdirSync(h.file('remote'));
  writeFileSync(h.file('remote/clients.json'), '{"a-client":{"key":"kept"}}');
  const key = readFileSync(h.file('key.bin'));
  let middle = 0;
  let undoing = 0;
  for (let i = 0; i < 24; i++) {
    const before = existsSync(h.file('setup/journal.txt'));
    if (before && i % 2) undoing++; // killed while it starts or undoes the one before
    if (await (before && i % 2 ? cut(h, 40 + i * 4, 'start') : cut(h, (i % 12) / 2))) {
      if (!(before && i % 2)) middle++;
      const d = setup('doctor', '--home', h.dir);
      assert.equal(d.status, 1);
      assert.match(d.stdout, /FAIL {2}installation: the last one was interrupted/);
    }
    if (i % 4 === 3) {
      const r = setup('install', '--home', h.dir);
      assert.equal(r.status, 0, r.stderr);
      const d = setup('doctor', '--home', h.dir);
      assert.equal(d.status, 0, d.stdout);
      assert.ok(!existsSync(h.file('setup')));
    }
  }
  t.diagnostic(`${middle} kills came while files were exchanged, ${undoing} at the start of the run after such a one`);
  assert.ok(middle > 0 && undoing > 0);
  assert.ok(readFileSync(h.file('key.bin')).equals(key));
  assert.equal(readFileSync(h.file('remote/clients.json'), 'utf8'), '{"a-client":{"key":"kept"}}');
});

/** Runs `fn` while the registration cannot be written. */
function deny(fn) {
  const acl = (on) => powershell(`$k = [Microsoft.Win32.Registry]::CurrentUser.${on ? "CreateSubKey('Software\\Mozilla\\NativeMessagingHosts\\firefox_companion')" : "OpenSubKey('Software\\Mozilla\\NativeMessagingHosts\\firefox_companion', 'ReadWriteSubTree', 'ChangePermissions,ReadKey')"}; $a = $k.GetAccessControl('Access'); $r = New-Object Security.AccessControl.RegistryAccessRule([Security.Principal.WindowsIdentity]::GetCurrent().User, 'SetValue', 'Deny'); $a.${on ? 'AddAccessRule' : 'RemoveAccessRule'}($r) | Out-Null; $k.SetAccessControl($a); $k.Dispose()`);
  acl(true);
  try {
    fn();
  } finally {
    acl(false);
  }
}

test('every point of the exchange: the earlier version comes back exactly, then the new one installs', () => {
  const h = fresh();
  const list = PROGRAM.filter((n) => !['install.json', 'key.bin'].includes(n)).map((n) => n.replaceAll('/', '\\')).sort();
  // What the earlier version looked like. The new one adds NOTICE.txt and installed.json.
  for (const n of list) writeFileSync(h.file(n), `old ${n}`);
  const added = ['NOTICE.txt', 'installed.json'];
  for (const n of added) rmSync(h.file(n));
  const was = bytes(h.dir);
  // The registration cannot be written, so each run stops after the undoing and its result can be seen.
  deny(() => {
    for (let done = 0; done <= list.length; done++)
      for (const half of done === list.length ? [false] : [false, true]) {
        mkdirSync(h.file('setup/old-x/mcp'), { recursive: true });
        writeFileSync(h.file('setup/journal.txt'), ['old-x', ...list.map((n) => (added.includes(n) ? '+' : '=') + n), ''].join('\n'));
        const away = (n) => {
          if (added.includes(n)) return;
          cpSync(h.file(n), h.file(`setup/old-x/${n}`));
          rmSync(h.file(n));
        };
        for (const n of list.slice(0, done)) {
          away(n);
          writeFileSync(h.file(n), `new ${n}`);
        }
        if (half) away(list[done]); // the old file is away and the new one is not there yet
        const r = setup('install', '--home', h.dir);
        assert.equal(r.status, 1, r.stdout);
        assert.match(r.stdout, /undo an installation that was interrupted/);
        assert.deepEqual(bytes(h.dir), was, `after ${done} files${half ? ' and a half' : ''}`);
      }
  });
  assert.equal(setup('install', '--home', h.dir).status, 0);
  assert.equal(setup('doctor', '--home', h.dir).status, 0);
});

test('the registration cannot be written: nothing is left of a fresh install, and an upgrade leaves the old version working', async () => {
  const h = place();
  run('reg', ['delete', REG, '/f']);
  deny(() => {
    const r = setup('install', '--home', h.dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /install failed/);
  });
  assert.ok(!existsSync(h.dir));
  assert.deepEqual(apps(), []);
  before040(h);
  const was = bytes(h.dir);
  deny(() => assert.equal(setup('install', '--home', h.dir).status, 1));
  assert.deepEqual(bytes(h.dir), was);
  assert.equal(registered(), h.file('native-manifest.json'));
  assert.equal((await connected(h)).messages.find((m) => m.type === 'hello').host, '0.4.0');
});

test('a file that another program holds open: the upgrade is undone and says why', async () => {
  const h = before040(place());
  const was = bytes(h.dir);
  const ps = spawn('powershell.exe', ['-NoProfile', '-Command', `$f = [IO.File]::Open('${h.file('mcp/serve.mjs').replaceAll("'", "''")}', 'Open', 'Read', 'Read'); 'held'; Start-Sleep 60`], { stdio: ['ignore', 'pipe', 'ignore'] });
  open.push({ child: ps, exit: new Promise((r) => ps.on('exit', r)) });
  await new Promise((r) => ps.stdout.once('data', r));
  const r = setup('install', '--home', h.dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /install failed: .*being used by another process/);
  assert.deepEqual(bytes(h.dir), was);
});

test('a key or an identity that was cut off while it was written is made again', () => {
  const h = fresh();
  writeFileSync(h.file('key.bin'), '');
  writeFileSync(h.file('install.json'), '{"pi');
  const d = setup('doctor', '--home', h.dir);
  assert.match(d.stdout, /FAIL {2}key file: .*not complete/);
  assert.match(d.stdout, /FAIL {2}pipe name: .*not complete/);
  const r = setup('install', '--home', h.dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(h.file('key.bin')).length, 32);
  assert.match(JSON.parse(readFileSync(h.file('install.json'), 'utf8')).pipe, /^firefox-companion-[0-9a-f]{32}$/);
  assert.equal(setup('doctor', '--home', h.dir).status, 0);
  const h2 = place();
  mkdirSync(h2.dir);
  writeFileSync(h2.file('install.json.new'), '{'); // cut off at its very first file
  assert.equal(setup('install', '--home', h2.dir).status, 0);
  const h3 = place();
  mkdirSync(h3.dir);
  writeFileSync(h3.file('letter.txt'), 'mine');
  assert.equal(setup('install', '--home', h3.dir).status, 1);
  assert.deepEqual(names(h3.dir), ['letter.txt']);
});

// ---- diagnostics

test('doctor names each broken thing with a fix, and install repairs it', () => {
  const h = fresh();
  const manifest = () => JSON.parse(readFileSync(h.file('native-manifest.json'), 'utf8'));
  const broken = [
    ['files', /mcp\\serve\.mjs was changed/, () => writeFileSync(h.file('mcp/serve.mjs'), '// changed')],
    ['files', /NOTICE\.txt is missing/, () => rmSync(h.file('NOTICE.txt'))],
    ['program', /host\.exe is missing/, () => rmSync(h.exe)],
    ['key file', /key\.bin is missing/, () => rmSync(h.file('key.bin'))],
    ['registry', /the key points to nothing/, () => run('reg', ['delete', REG, '/f'])],
    ['registry', /the key points to C:\\elsewhere/, () => execFileSync('reg', ['add', REG, '/ve', '/d', 'C:\\elsewhere', '/f'])],
    ['manifest', /does not allow exactly/, () => writeFileSync(h.file('native-manifest.json'), JSON.stringify({ ...manifest(), allowed_extensions: ['other@example.invalid'] }))],
    ['manifest', /it starts C:/, () => writeFileSync(h.file('native-manifest.json'), JSON.stringify({ ...manifest(), path: 'C:\\x.exe' }))],
    ['folder', /Everyone/, () => execFileSync('icacls', [h.dir, '/grant', '*S-1-1-0:(R)'])],
  ];
  for (const [what, says, damage] of broken) {
    damage();
    const d = setup('doctor', '--home', h.dir);
    assert.equal(d.status, 1, what);
    const line = d.stdout.split(/\r?\n/).find((l) => l.startsWith(`FAIL  ${what}`));
    assert.match(line ?? d.stdout, says);
    assert.match(line, /Fix: /);
    assert.equal(setup('install', '--home', h.dir).status, 0, what);
    const again = setup('doctor', '--home', h.dir);
    assert.equal(again.status, 0, again.stdout);
  }
});

// ---- uninstall

test('uninstall by the installed program while it is connected: helper stopped, nothing left, other registrations kept, and it comes back on install', { timeout: 60_000 }, async () => {
  const h = fresh('--thunderbird');
  const f = await connected(h);
  const leftBefore = readdirSync(os.tmpdir());
  const other = 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\fc_test_other';
  execFileSync('reg', ['add', other, '/ve', '/d', 'C:\\other.json', '/f']);
  try {
    const t = Date.now();
    const r = run(h.exe, ['uninstall', '--home', h.dir]);
    assert.equal(r.status, 0, r.stderr);
    await f.exit;
    assert.ok(Date.now() - t < 5000);
    assert.ok(!existsSync(h.dir));
    assert.equal(registered(), null);
    assert.notEqual(run('reg', ['query', `${REG}_mail`]).status, 0);
    assert.deepEqual(apps(), []);
    assert.equal(run('reg', ['query', other]).status, 0);
    assert.equal(helpers(h.dir), 0);
    await until('the moved program is deleted', () => !readdirSync(os.tmpdir()).some((n) => /^firefox-companion-removed-/.test(n) && !leftBefore.includes(n)), 15_000, 300);
  } finally {
    run('reg', ['delete', other, '/f']);
  }
  const c = await client({ server: path.join(root, 'dist/mcp/server.mjs') }, ['--home', h.dir]);
  const status = (await c.call('connection_status')).data;
  assert.equal(status.state, 'not_installed');
  assert.match(status.next_step, /FirefoxCompanionSetup/);
  assert.equal(setup('install', '--home', h.dir).status, 0);
  await connected(h);
  assert.ok(!(await c.call('tabs_context')).isError, 'the same client goes on after the new install');
});

test('two installations: upgrading or removing one leaves the helper, the registration and the entry in Settings of the other', async () => {
  const h = fresh();
  const h2 = fresh(); // the registration is of the later one
  const f2 = await connected(h2);
  assert.equal(setup('install', '--home', h.dir).status, 0);
  assert.equal(setup('install', '--home', h2.dir).status, 0);
  const f3 = await connected(h2);
  assert.equal(await Promise.race([f2.exit.then(() => 'stopped'), until('later', () => false, 300).catch(() => 'runs')]), 'stopped', 'its own installer stops it');
  assert.equal(setup('uninstall', '--home', h.dir).status, 0);
  assert.equal(registered(), h2.file('native-manifest.json'));
  assert.equal(apps().length, 1);
  assert.equal(helpers(h2.dir), 1);
  assert.equal(f3.child.exitCode, null);
});

test('uninstall keeps files of others, and finishes what an interrupted install or uninstall left', async () => {
  const h = fresh();
  writeFileSync(h.file('letter.txt'), 'mine');
  const r = setup('uninstall', '--home', h.dir);
  assert.match(r.stdout, /left, because it holds other files/);
  assert.deepEqual(names(h.dir), ['letter.txt']);
  const h2 = place();
  for (let i = 0; i < 6; i++) await cut(h2, i / 2);
  assert.equal(setup('uninstall', '--home', h2.dir).status, 0);
  assert.ok(!existsSync(h2.dir));
  const h3 = fresh();
  rmSync(h3.file('key.bin'));
  rmSync(h3.file('mcp'), { recursive: true });
  run('reg', ['delete', REG, '/f']);
  assert.equal(setup('uninstall', '--home', h3.dir).status, 0);
  assert.ok(!existsSync(h3.dir));
  assert.equal(registered(), null);
});
