// The packaged artifacts of release/ in the installed Firefox: the .xpi as a temporary add-on (Firefox release takes an unsigned
// one in no other way), KitewardenSetup, and the server of the .mcpb file. Disposable profiles, local pages, real clicks.
// node test/firefox/packaged.mjs "<part>" runs the setup and the checks whose name holds that part.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tree, zip } from '../../build/release.mjs';
import { VERSION } from '../../shared/protocol.mjs';
import { McpClient, EARLIER, buildEarlier, fakeClaude, powershell, registered, root, sleep, until } from '../helpers.mjs';
import { Firefox, Sidebar } from './firefox.mjs';
import { fixture } from './fixtures.mjs';

const only = process.argv[2];
const results = [];
const REG = 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\kitewarden';
const release = path.join(root, 'release');
const XPI = path.join(release, `kitewarden-${VERSION}-unsigned.xpi`);
const SETUP = path.join(release, `KitewardenSetup-${VERSION}.exe`);
if (registered()) throw new Error('this user has an installation; this test needs the registration for itself');
const work = mkdtempSync(path.join(os.tmpdir(), 'fc-packaged-'));
const clean = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/.test(k))), CLAUDE_CONFIG_DIR: path.join(work, 'claude') };
const setup = (...args) => spawnSync(SETUP, args, { encoding: 'utf8', env: clean });
// The account check of the sidebar asks a test double, never the user's Claude Code.
const double = fakeClaude();
const config = mkdtempSync(path.join(work, 'config-'));
const A = await fixture(3000);
const clients = [];
const homes = [];
let f, sb, h, c, version;

async function check(row, name, fn) {
  if (only && !name.includes(only)) return;
  const t = Date.now();
  const notes = [];
  let error = null;
  try {
    await fn((n) => notes.push(n));
  } catch (e) {
    error = e;
    notes.push(`sidebar: ${((await sb?.text('body').catch((x) => x.message)) ?? '').replace(/\s+/g, ' ').slice(0, 800)}`);
  }
  results.push({ row, name, ok: !error, ms: Date.now() - t, notes, error: error?.message });
  console.log(`${error ? 'FAIL' : 'ok  '} ${row.padEnd(11)} ${name} (${Date.now() - t} ms)${notes.map((n) => `\n         ${n}`).join('')}${error ? `\n         ${error.stack.split('\n').slice(0, 10).join('\n         ')}` : ''}`);
}
const place = (name) => {
  const dir = path.join(work, name, 'Jörg Müller & Söhne', 'home');
  mkdirSync(path.dirname(dir), { recursive: true });
  homes.push(dir);
  return { dir, exe: path.join(dir, 'kitewarden-host.exe'), server: path.join(dir, 'mcp/server.mjs') };
};
const link = () => sb.text('#link-title');
const is = (title, ms = 10_000) => until(title, async () => (await link()) === title, ms, 100);
const pids = () => powershell(`Get-CimInstance Win32_Process -Filter "Name='kitewarden-host.exe'" | Where-Object { $_.ExecutablePath -eq '${h.exe}' } | ForEach-Object ProcessId`).split(/\s+/).filter(Boolean).map(Number);
const storage = () => sb.eval('const s = await browser.storage.local.get(null); delete s.log; return s');
const permissions = () => sb.eval('const p = await browser.permissions.getAll(); return { permissions: p.permissions.filter((x) => !x.startsWith("internal:")).sort(), origins: p.origins.sort() }');
async function client(name, home = h, args = []) {
  const x = new McpClient(home, { name, args });
  clients.push(x);
  await x.init();
  await until(`${name} in the sidebar`, async () => (await sb.text('#sessions'))?.includes(name));
  return x;
}
const refOf = (outline, name) => new RegExp(`"${name}".*\\[(ref_\\w+)\\]`).exec(outline)?.[1];
const mine = async () => (await c.call('tabs_context')).data.tabs.find((t) => t.state === 'active')?.tabId;
async function clicked() {
  const tabId = await mine();
  const ref = refOf((await c.call('read_page', { tabId })).text, 'Count up');
  const before = A.reports.length;
  const p = c.call('computer', { action: 'left_click', tabId, ref });
  await sb.answerCard(true);
  const r = await p;
  assert.equal(r.code, null, r.text);
  await until('report of the page', () => A.reports.length > before);
  assert.equal(A.reports.length, before + 1);
}
async function begin(profile = null) {
  f = await Firefox.start({ profile, env: { PATH: `${double.dir};${process.env.PATH}`, CLAUDE_CONFIG_DIR: config } });
  version = f.version;
  await f.navigate(`${A.origin}/`);
}
async function load(xpi) {
  sb = new Sidebar(f, await f.install(xpi));
  await sb.open();
}
async function end() {
  for (const x of clients.splice(0)) await x.close();
  const was = f;
  f = null;
  await was?.quit();
}
/** An .xpi and a helper of the previous version: this code with the version number EARLIER. */
function earlier() {
  const dist = buildEarlier(path.join(work, 'earlier'));
  const xpi = path.join(work, 'earlier.xpi');
  writeFileSync(xpi, zip(tree(path.join(dist, 'extension'))));
  return { xpi, host: path.join(dist, 'host/kitewarden-host.exe') };
}
const absent = () => f.chrome('return WebExtensionPolicy.getByID("firefox@kitewarden.com") === null');

try {
  // ---- fresh installation, the add-on first

  h = place('fresh');
  await begin();

  await check('FC-INST-11', 'Firefox release refuses the unsigned package as an ordinary add-on', async (n) => {
    const e = await f.install(XPI, false).then(() => null, (x) => x);
    assert.ok(e, 'it was installed');
    n(`Firefox ${f.version}: ${e.message.split('\n')[0]}`);
    assert.equal(await absent(), true);
  });

  await load(XPI);

  await check('FC-INST-19', 'the package as Firefox sees it: cookies and the others are optional, and none is given', async (n) => {
    const p = await permissions();
    n(`given: ${p.permissions.join(', ')}; sites: ${p.origins.join(', ') || 'none'}`);
    assert.deepEqual(p.permissions, ['activeTab', 'contextualIdentities', 'nativeMessaging', 'storage', 'tabs']);
    assert.deepEqual(p.origins, []);
    const m = await sb.eval('return browser.runtime.getManifest()');
    assert.ok(m.optional_permissions.includes('cookies') && !m.permissions.includes('cookies'));
    assert.equal(m.version, VERSION);
  });

  await check('FC-INST-05', 'no helper yet: the sidebar says so and names the installer', async (n) => {
    await sb.click('#connect');
    await is('Helper not installed');
    n(await sb.text('#link-detail'));
    assert.match(await sb.text('#link-detail'), /KitewardenSetup/);
  });

  await check('FC-INST-03', 'the installer runs while Firefox is open: the add-on finds the helper by itself', async (n) => {
    const r = setup('install', '--home', h.dir);
    assert.equal(r.status, 0, r.stderr);
    const t = Date.now();
    await is('Connected', 45_000);
    n(`connected ${Date.now() - t} ms after the installer ended; program in ${path.dirname(h.exe).replace(work, '<temp>')}`);
    assert.ok((await sb.text('#link-detail')).includes(`Helper ${VERSION}`));
    const d = setup('doctor', '--home', h.dir);
    assert.equal(d.status, 0, d.stdout);
    assert.match(d.stdout, /ok {4}pipe/);
  });

  await check('FC-CONN-08', 'pairing: the installed server proves the key, and every hop has the version of the release', async (n) => {
    c = await client('driver');
    const s = (await c.call('connection_status')).data;
    assert.deepEqual([s.state, s.mcp_server.version, s.extension.version, s.helper.version], ['connected', VERSION, VERSION, VERSION]);
    n(`optional backends: ${JSON.stringify(s.optional_backends)}`);
    assert.ok(s.optional_backends.every((b) => !['on', 'off'].includes(b.state)), 'none of them runs');
  });

  await check('FC-GRANT-14', 'permission setup: declined makes no grant, accepted makes one, and an approved click arrives once', async (n) => {
    n(`prompt: ${await sb.attach('driver', 'act', false)}`);
    assert.equal(await sb.text('#grants'), 'None');
    await sb.attach('driver', 'act', true);
    assert.equal(await sb.text('#message'), 'Attached.');
    await clicked();
  });

  await check('FC-INST-14', 'Claude Desktop bundle: its server, started as the manifest says, reaches the same helper', async () => {
    const dir = path.join(work, 'mcpb');
    mkdirSync(dir);
    execFileSync(path.join(process.env.SystemRoot, 'System32/tar.exe'), ['-xf', path.join(release, `kitewarden-${VERSION}.mcpb`), '-C', dir]);
    const m = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const [server, ...args] = m.server.mcp_config.args.map((a) => a.replace('${__dirname}', dir).replace('${user_config.home}', h.dir.replaceAll('\\', '/')));
    const x = await client('desktop-bundle', { server }, args);
    assert.equal((await x.call('connection_status')).data.state, 'connected');
    assert.deepEqual((await x.call('tabs_context')).data.tabs, [], 'another client has no grant of this one');
    clients.splice(clients.indexOf(x), 1);
    await x.close();
  });

  await check('FC-INST-19', 'containers without cookies are only listed; the button asks for cookies, and then a tab opens in one', async (n) => {
    assert.equal((await c.call('containers_list')).code, null);
    const no = await c.call('tabs_create', { container: 'Work' });
    assert.equal(no.code, 'permission_required');
    n(no.text.split('\n')[0]);
    await sb.eval('document.querySelector("#d-data").open = true; document.querySelector("#message").textContent = ""');
    await sb.click('#containers-ok');
    n(await until('answer', () => sb.text('#message'), 5000));
    assert.ok((await permissions()).permissions.includes('cookies'));
    const p = c.call('tabs_create', { url: `${A.origin}/second`, container: 'Work' });
    await sb.answerCard(true);
    const t = (await p).data;
    assert.match(await sb.eval('return (await browser.tabs.get(arguments[0])).cookieStoreId', t.tabId), /^firefox-container-/);
    await c.call('tabs_close', { tabId: t.tabId });
    assert.equal((await c.call('get_cookies', { tabId: await mine() })).code, 'tool_off', 'reading cookies has a switch of its own');
  });

  await check('FC-CONN-10', 'the helper is killed: another one runs, the client is told, and the grant is gone until the user gives it back', async (n) => {
    const [pid] = pids();
    const t = Date.now();
    process.kill(pid);
    await until('another helper', () => pids().some((x) => x !== pid), 8000, 200);
    await is('Connected');
    n(`new helper after ${Date.now() - t} ms`);
    assert.equal((await c.call('tabs_context')).code, 'session_ended');
    assert.deepEqual((await c.call('tabs_context')).data.tabs, []);
    await until('driver again', async () => (await sb.text('#sessions'))?.includes('driver'));
    await sb.attach('driver', 'act', null);
    await clicked();
  });

  await check('FC-INST-04', 'uninstall while connected: no process within 5 s, the sidebar says that the helper is missing; after a new install it connects', async (n) => {
    const t = Date.now();
    const r = spawnSync(h.exe, ['uninstall', '--home', h.dir], { encoding: 'utf8', env: clean });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(pids(), []);
    assert.ok(Date.now() - t < 5000);
    assert.ok(!existsSync(h.dir));
    assert.equal(registered(), null);
    await is('Helper not installed');
    const s = (await c.call('connection_status')).data;
    n(`client: ${s.state}; ${s.next_step}`);
    assert.equal(setup('install', '--home', h.dir).status, 0);
    const m = Date.now();
    await sb.click('#retry');
    await is('Connected');
    n(`Retry now: connected after ${Date.now() - m} ms, with a new key`);
    assert.equal((await c.call('connection_status')).data.state, 'connected');
  });
  await end();

  // ---- upgrade from the previous version with what a user set up

  h = place('upgrade');
  const v4 = earlier();
  let kept, allowed;
  await begin();
  await load(v4.xpi);

  await check('FC-INST-12', `version ${EARLIER} with deliberate settings`, async (n) => {
    assert.equal(spawnSync(v4.host, ['install', '--home', h.dir], { env: clean }).status, 0);
    await sb.click('#connect');
    await is('Connected');
    await sb.eval('document.querySelector("#d-data").open = true');
    for (const [name, prompt] of [['console', false], ['bookmarks', true]]) {
      await sb.click(`#switch-${name}`);
      if (prompt) await f.prompt(true);
      await until(`switch ${name}`, () => sb.eval('return document.querySelector(arguments[0]).checked', `#switch-${name}`));
    }
    const share = path.join(work, 'share');
    mkdirSync(share);
    await sb.choose('#folder-path', share);
    await sb.click('#folder-add');
    await until('folder', async () => (await sb.text('#folders')).includes('share'));
    await sb.choose('#profile-label', 'Everyday');
    await sb.click('#profile-save');
    await until('label', async () => (await storage()).profile.label === 'Everyday');
    // What takes long to make by hand, in the form that this version stores it.
    const now = Date.now();
    await sb.eval('await browser.storage.local.set(arguments[0])', {
      workflows: [{ id: 'w1', title: 'Kept workflow', origin: A.origin, tabs: 1, created: now, steps: [{ kind: 'page', origin: A.origin, path: '/' }] }],
      schedules: [{ id: 's1', workflow: 'w1', title: 'Kept workflow', digest: 'x', kind: 'daily', time: '08:30', on: false, next: null, created: now, runs: [] }],
      pairings: [{ id: 'p1', name: 'Laptop', state: 'allowed', created: now, expires: now + 5 * 86_400_000, fingerprint: 'ab', device: 'x', seen: null, address: null }],
      chats: [{ id: 'c1', title: 'Kept chat', created: now, updated: now, claude: '11111111-2222-3333-4444-555555555555', started: true, model: null, extras: false, running: false }],
      'chat:c1': [],
    });
    await load(v4.xpi); // it reads them when it starts
    await is('Connected', 15_000);
    mkdirSync(path.join(h.dir, 'remote'));
    writeFileSync(path.join(h.dir, 'remote/clients.json'), '{"p1":{"key":"kept"}}');
    c = await client('driver');
    await sb.attach('driver', 'act', true);
    await clicked();
    kept = await storage();
    allowed = await permissions();
    n(`stored: ${Object.keys(kept).sort().join(', ')}; permissions: ${allowed.permissions.join(', ')}`);
  });

  await check('FC-INST-12', 'the installer upgrades the helper under the older add-on, which goes on with it', async (n) => {
    const key = readFileSync(path.join(h.dir, 'key.bin'));
    const t = Date.now();
    const r = setup('install', '--home', h.dir);
    assert.equal(r.status, 0, r.stderr);
    await until('helper of the release', async () => (await sb.text('#link-detail')).includes(`Helper ${VERSION}`), 15_000, 100);
    n(`${EARLIER} add-on with ${VERSION} helper after ${Date.now() - t} ms`);
    assert.ok(readFileSync(path.join(h.dir, 'key.bin')).equals(key));
    assert.equal(readFileSync(path.join(h.dir, 'remote/clients.json'), 'utf8'), '{"p1":{"key":"kept"}}');
    assert.equal((await c.call('tabs_context')).code, 'session_ended');
    const s = (await c.call('connection_status')).data;
    assert.deepEqual([s.mcp_server.version, s.extension.version, s.helper.version], [EARLIER, EARLIER, VERSION]);
    assert.deepEqual(await storage(), kept);
  });

  await check('FC-INST-12', 'the add-on is updated: settings, chats, workflows, schedules, pairings and permissions are the same, nothing is turned on', async (n) => {
    await load(XPI);
    assert.equal(await sb.eval('return browser.runtime.getManifest().version'), VERSION);
    await is('Connected', 15_000);
    assert.deepEqual(await storage(), kept);
    assert.deepEqual(await permissions(), allowed);
    assert.equal(await sb.eval('return document.querySelector("#switch-console").checked && document.querySelector("#switch-bookmarks").checked'), true);
    for (const off of ['network', 'bodies', 'cookies', 'storage', 'webmcp', 'history', 'downloads']) assert.equal(await sb.eval('return document.querySelector(arguments[0]).checked', `#switch-${off}`), false, off);
    c = await client('driver-2');
    const s = (await c.call('connection_status')).data;
    n(`backends: ${JSON.stringify(s.optional_backends)}`);
    assert.ok(s.optional_backends.every((b) => !['on', 'off'].includes(b.state)));
    assert.equal(await sb.text('#grants'), 'None');
    assert.match(await sb.eval('return document.body.textContent'), /Kept workflow/);
    await sb.attach('driver-2', 'act', null); // Firefox kept its permission for the site
    await clicked();
  });

  await check('AC-06', 'Firefox restarts: the unsigned add-on is gone, as Firefox release does it; loaded again there is no grant', async (n) => {
    for (const x of clients.splice(0)) await x.close();
    const { profile } = f;
    await f.quit({ keep: true });
    f = null;
    await until('the helper ended with Firefox', () => pids().length === 0, 10_000, 200);
    await begin(profile);
    assert.equal(await absent(), true);
    await load(XPI);
    n(`stored after the restart: ${Object.keys(await storage()).sort().join(', ')}`);
    assert.equal(await sb.text('#grants'), 'None');
    if ((await link()) === 'Not connected') await sb.click('#connect');
    await is('Connected', 15_000);
    n('connected to the installed helper again');
    c = await client('after-restart');
    assert.deepEqual((await c.call('tabs_context')).data.tabs, []);
  });
  await end();
} finally {
  await end().catch((e) => console.error(e.message));
  for (const dir of homes) setup('uninstall', '--home', dir);
  spawnSync('reg', ['delete', REG, '/f']);
  await sleep(500);
  double.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  const out = path.join(root, 'test-results');
  mkdirSync(out, { recursive: true });
  const bad = results.filter((r) => !r.ok);
  writeFileSync(path.join(out, 'packaged.json'), JSON.stringify({ at: new Date().toISOString(), firefox: version, version: VERSION, passed: results.length - bad.length, failed: bad.length, results }, null, 1));
  console.log(`\n${results.length - bad.length} of ${results.length} passed`);
  process.exit(bad.length || !results.length ? 1 : 0);
}
