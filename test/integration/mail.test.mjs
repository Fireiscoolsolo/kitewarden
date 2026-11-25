// The helper and the MCP server with the Thunderbird add-on. Thunderbird and Firefox are played by the test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { FakeFirefox, HOST, McpClient, host, installHome } from '../helpers.mjs';

const MAIL_ID = 'mail@firefox-companion.invalid';
const REG = 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\firefox_companion_mail';
const key = () => spawnSync('reg', ['query', REG, '/ve'], { encoding: 'utf8' }).status === 0;
let home;
let had;
const open = [];
const program = async (id, label) => {
  const f = new FakeFirefox(home, { profile: randomUUID(), label, id });
  open.push(f);
  f.answer(async (b) => ({ result: { from: label, tool: b.tool } }));
  await f.wait('hello', (m) => m.type === 'hello');
  return f;
};

before(() => {
  had = key();
  home = installHome();
});
after(async () => {
  for (const f of open) f.child.kill();
  if (!had) spawnSync('reg', ['delete', REG, '/f']);
  await home.close();
});

test('an installation without the option registers nothing for Thunderbird; with it exactly one other add-on may start the helper; uninstall removes it', () => {
  if (had) return; // the user has it
  assert.equal(key(), false);
  assert.equal(existsSync(path.join(home.dir, 'native-manifest-mail.json')), false);
  const dry = host('install', '--home', home.dir, '--thunderbird', '--dry-run');
  assert.match(dry.stdout, /would: set HKCU.*firefox_companion_mail/);
  assert.equal(key(), false);
  assert.equal(host('install', '--home', home.dir, '--thunderbird').status, 0);
  const m = JSON.parse(readFileSync(path.join(home.dir, 'native-manifest-mail.json'), 'utf8'));
  assert.deepEqual([m.name, m.allowed_extensions], ['firefox_companion_mail', [MAIL_ID]]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(home.dir, 'native-manifest.json'), 'utf8')).allowed_extensions, ['bridge@firefox-companion.invalid']);
  assert.match(host('doctor', '--home', home.dir).stdout, /ok {4}thunderbird/);
  const r = host('uninstall', '--home', home.dir, '--dry-run');
  assert.match(r.stdout, /delete HKCU.*firefox_companion_mail/);
  spawnSync('reg', ['delete', REG, '/f']);
});

test('the helper starts for the two add-ons and for no other', () => {
  for (const id of ['other@x.invalid', '']) assert.equal(spawnSync(HOST, [path.join(home.dir, 'native-manifest.json'), id], { encoding: 'utf8' }).status, 2, id);
});

test('Thunderbird beside Firefox: the everyday server never picks it, the mail server picks nothing else, and each has its tools only', async () => {
  const t = await program(MAIL_ID, 'Thunderbird');
  const alone = new McpClient(home);
  open.push(alone);
  await alone.init();
  assert.equal((await alone.call('tabs_context')).code, 'not_connected', 'mail is no Firefox');
  await program(undefined, 'Work');
  const c = new McpClient(home);
  const m = new McpClient(home, { args: ['--mail'] });
  open.push(c, m);
  for (const x of [c, m]) await x.init();
  assert.equal((await c.call('tabs_context')).data.from, 'Work', 'no choice between a browser and a mail program');
  assert.deepEqual((await c.call('list_connected_browsers')).data.browsers.map((b) => b.label), ['Work']);
  assert.equal((await m.call('mail_accounts')).data.from, 'Thunderbird');
  assert.deepEqual((await m.call('list_connected_browsers')).data.browsers.map((b) => b.label), ['Thunderbird']);
  assert.equal((await m.call('tabs_context')).code, 'unknown_tool');
  assert.equal((await c.call('mail_accounts')).code, 'unknown_tool');
  assert.equal((await c.call('select_browser', { profile: 'Thunderbird' })).code, 'not_found');
  assert.equal(JSON.parse(readFileSync(path.join(home.dir, 'state.json'), 'utf8')).label, 'Work', 'the state of Firefox is its own');

  // The helper of Thunderbird reads no file, starts no chat and writes no skill.
  for (const type of ['file_stat', 'claude_info', 'skill_write', 'chat_run']) t.send({ type, id: 'x', paths: [], folders: [], name: 'x', text: 'x' });
  t.send({ type: 'label', label: 'Post' });
  await new Promise((r) => setTimeout(r, 600));
  assert.ok(!t.messages.some((x) => x.type === 'reply'));
  assert.deepEqual((await m.call('list_connected_browsers')).data.browsers.map((b) => b.label), ['Post']);
});

test('without Thunderbird the mail server says what to do', async () => {
  for (const f of open.filter((x) => x instanceof FakeFirefox)) f.child.kill();
  await new Promise((r) => setTimeout(r, 500));
  const m = new McpClient(home, { args: ['--mail'] });
  open.push(m);
  await m.init();
  const r = await m.call('mail_accounts');
  assert.deepEqual([r.code, /Start Thunderbird/.test(r.text)], ['not_connected', true]);
  const bad = new McpClient(home, { args: ['--with', 'everything'] });
  assert.equal(await bad.exit, 2);
});
