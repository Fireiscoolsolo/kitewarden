// Real Windows: the built helper, pipes, files, links and the real MCP server. Firefox is played by the test.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { FakeFirefox, McpClient, host, installHome, sleep, until } from '../helpers.mjs';

let home, base;
const open = [];
const ids = [randomUUID(), randomUUID()];
const firefox = async (i, label) => {
  const f = new FakeFirefox(home, { profile: ids[i], label });
  open.push(f);
  f.answer(async (b) => ({ result: { from: label, tool: b.tool } }));
  await f.wait('hello', (m) => m.type === 'hello');
  return f;
};
const ask = async (f, type, data) => {
  const id = randomUUID();
  f.send({ ...data, type, id });
  return (await f.wait(type, (m) => m.type === 'reply' && m.id === id)).result;
};

before(() => {
  home = installHome();
  base = mkdtempSync(path.join(os.tmpdir(), 'fc-up-'));
});
after(async () => {
  for (const f of open) f.child.kill();
  rmSync(base, { recursive: true, force: true });
  await home.close();
});

test('profiles: two run side by side, one ID never twice, and a client has to pick and then stays', async () => {
  const a = await firefox(0, 'Work');
  const c = new McpClient(home);
  open.push(c);
  await c.init();
  assert.equal((await c.call('tabs_context')).data.from, 'Work', 'the only one is used');
  const b = await firefox(1, 'Home');
  assert.equal((await c.call('tabs_context')).data.from, 'Work', 'the client stays');
  const twin = new FakeFirefox(home, { profile: ids[0], label: 'Twin' });
  open.push(twin);
  assert.equal(await twin.exit, 4);
  assert.equal(twin.messages[0].code, 'pipe_in_use');

  const d = new McpClient(home, { name: 'second' });
  open.push(d);
  await d.init();
  const list = (await d.call('list_connected_browsers')).data.browsers;
  assert.deepEqual(list.map((x) => [x.label, x.in_use]).sort(), [['Home', false], ['Work', false]]);
  const refused = await d.call('tabs_context');
  assert.equal(refused.code, 'ambiguous');
  assert.match(refused.text, /"Work".*"Home"|"Home".*"Work"/);
  assert.equal((await d.call('select_browser', { profile: 'Nowhere' })).code, 'not_found');
  assert.equal((await d.call('select_browser', { profile: 'home' })).data.using, ids[1]);
  assert.equal((await d.call('tabs_context')).data.from, 'Home');
  // another profile: a new session there, the old one ends
  await d.call('select_browser', { profile: ids[0] });
  assert.equal((await d.call('tabs_context')).data.from, 'Work');
  await until('the session in Home ended', () => b.messages.some((m) => m.type === 'session_close'));

  a.send({ type: 'label', label: 'Job\nline' });
  await until('renamed', async () => (await d.call('list_connected_browsers')).data.browsers.some((x) => x.label === 'Jobline'));
  await a.quit();
  await until('the pipe is gone', async () => (await d.call('connection_status')).data.state !== 'connected');
  const gone = await d.call('tabs_context');
  assert.equal(gone.code, 'not_connected', 'it does not fall back to the other profile');
  assert.equal(b.calls.filter((x) => x.tool === 'tabs_context').length, 1);
  assert.match(host('doctor', '--home', home.dir).stdout, /ok {4}pipe/);
  await b.quit();
});

test('a profile ID that is no ID starts nothing', async () => {
  for (const profile of ['..\\x', 'a', 'x'.repeat(36)]) {
    const f = new FakeFirefox(home, { profile });
    open.push(f);
    assert.equal(await f.exit, 2);
  }
});

test('uploads: a file inside a listed folder is read in parts, and every way out of it is refused', async () => {
  const f = await firefox(0, 'Work');
  const ok = path.join(base, 'share');
  const out = path.join(base, 'private');
  mkdirSync(path.join(ok, 'sub'), { recursive: true });
  mkdirSync(out);
  const body = Buffer.alloc(700_000, 'ä');
  writeFileSync(path.join(ok, 'a.bin'), body);
  writeFileSync(path.join(ok, 'sub', 'b.txt'), 'b');
  for (const n of ['secret.txt']) writeFileSync(path.join(out, n), 'private');
  for (const n of ['.env', 'id_rsa', 'x.pem', 'credentials', 'logins.json']) writeFileSync(path.join(ok, n), 'key');
  writeFileSync(path.join(ok, 'hidden.txt'), 'h');
  execFileSync('attrib', ['+h', path.join(ok, 'hidden.txt')]);
  linkSync(path.join(out, 'secret.txt'), path.join(ok, 'hard.txt'));
  symlinkSync(out, path.join(ok, 'junction'), 'junction');

  const listed = await ask(f, 'folder_check', { path: ok });
  assert.ok(listed.path.toLowerCase().endsWith('\\share'), JSON.stringify(listed));
  const folders = [listed.path];
  for (const bad of ['C:\\', os.homedir(), process.env.SystemRoot, home.dir, path.dirname(home.dir), path.join(os.homedir(), '.claude'), '\\\\localhost\\c$', 'share', path.join(ok, 'nothing'), path.join(ok, 'a.bin')]) {
    assert.ok((await ask(f, 'folder_check', { path: bad })).code, bad);
  }
  const stat = (paths, o = {}) => ask(f, 'file_stat', { paths, folders, ...o });
  const { files } = await stat([path.join(ok, 'a.bin')]);
  assert.deepEqual(files.map((x) => [x.name, x.size]), [['a.bin', 700_000]]);
  const read = (x, offset, count) => ask(f, 'file_read', { path: x.path, stamp: x.stamp, offset, count, folders });
  const got = Buffer.concat([Buffer.from((await read(files[0], 0, 524_288)).data, 'base64'), Buffer.from((await read(files[0], 524_288, 524_288)).data, 'base64')]);
  assert.ok(got.equals(body));
  assert.equal((await read(files[0], 0, 600_000)).code, 'invalid_argument');

  for (const p of [path.join(out, 'secret.txt'), path.join(ok, '..', 'private', 'secret.txt'), path.join(ok, 'junction', 'secret.txt'), path.join(ok, 'hard.txt'), path.join(ok, 'hidden.txt'), ok, path.join(ok, 'nothing.txt'), path.join(ok, 'a.bin:stream'), 'a.bin', '\\\\localhost\\c$\\x', '\\\\?\\C:\\x', 'C:relative', path.join(home.dir, 'key.bin'), ...['.env', 'id_rsa', 'x.pem', 'credentials', 'logins.json'].map((n) => path.join(ok, n))]) {
    const r = await stat([p]);
    assert.equal(r.code, 'path_not_allowed', `${p}: ${JSON.stringify(r)}`);
    assert.ok(!JSON.stringify(r).includes('private\\\\secret') || p.includes('private'), 'the reply tells nothing new');
  }
  assert.equal((await ask(f, 'file_stat', { paths: [path.join(ok, 'a.bin')], folders: [] })).code, 'path_not_allowed');
  assert.equal((await read({ path: path.join(out, 'secret.txt'), stamp: 'x' }, 0, 10)).code, 'path_not_allowed');

  // changed after the approval
  await sleep(20);
  writeFileSync(path.join(ok, 'a.bin'), 'other');
  assert.match((await read(files[0], 0, 10)).message, /changed after the approval/);

  // folders: all or nothing
  assert.equal((await stat([ok], { folder: true })).code, 'path_not_allowed', 'it holds a key and a link');
  assert.deepEqual((await stat([path.join(ok, 'sub')], { folder: true })).files.map((x) => x.relative), ['sub/b.txt']);
  assert.equal((await stat([out], { folder: true })).code, 'path_not_allowed');
  assert.ok(!readFileSync(path.join(home.dir, 'state.json'), 'utf8').includes('share'), 'no path is stored by the helper');
});
