// The developer build in the installed Firefox, as a temporary add-on in a disposable profile: page script is off at first, shows
// its code each time, and has the rights of the page only. Afterwards the build is deleted again.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { McpClient, installHome, root, sleep, until } from '../helpers.mjs';
import { Firefox, Sidebar } from './firefox.mjs';
import { fixture } from './fixtures.mjs';

execFileSync(process.execPath, [path.join(root, 'build/build.mjs'), '--developer'], { stdio: 'pipe' });
const home = installHome();
const A = await fixture(3000);
const B = await fixture(4000);
const strict = http.createServer((q, r) => r.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "script-src 'self'" }).end('<title>Strict</title><h1>Strict page</h1>'));
await new Promise((r) => strict.listen(0, 'localhost', r));
const f = await Firefox.start({});
const sb = new Sidebar(f, await f.install(path.join(root, 'dist/developer/extension')));
const results = [];
let c, tab;

async function check(name, fn) {
  let error = null;
  const notes = [];
  try {
    await fn((n) => notes.push(n));
  } catch (e) {
    error = e;
    for (let i = await sb.eval('return document.querySelectorAll("#cards .card").length').catch(() => 0); i > 0; i--) await sb.answerCard(false).catch(() => {});
  }
  results.push({ row: 'FC-DBG-11', name, ok: !error, notes, error: error?.message });
  console.log(`${error ? 'FAIL' : 'ok  '} ${name}${notes.map((n) => `\n         ${n}`).join('')}${error ? `\n         ${error.stack.split('\n').slice(0, 7).join('\n         ')}` : ''}`);
}
const run = (code, more = {}) => c.call('javascript_tool', { tabId: tab, code, ...more });
async function approved(code, yes = true, more = {}) {
  const p = run(code, more);
  run.card = await sb.waitCard();
  await sb.answerCard(yes);
  return p;
}

try {
  await f.navigate(`${A.origin}/dev`);
  await sb.open();
  await sb.click('#connect');
  await until('connected', async () => (await sb.text('#link-title')) === 'Connected');
  c = new McpClient({ server: path.join(root, 'dist/developer/mcp/server.mjs') }, { name: 'driver', args: ['--home', home.dir] });
  await c.init();
  await until('client', async () => /driver/.test(await sb.text('#sessions')));
  await sb.attach('driver', 'act', true);
  tab = Number((await c.call('tabs_context')).data.tabs[0].tabId);

  await check('the developer build is named as such, lists the tool, and the tool is off; the everyday server does not know it', async (n) => {
    n(await f.chrome('return WebExtensionPolicy.getByID(arguments[0]).name', sb.id));
    assert.match(await f.chrome('return WebExtensionPolicy.getByID(arguments[0]).name', sb.id), /developer build/);
    assert.ok((await c.request('tools/list')).result.tools.some((t) => t.name === 'javascript_tool'));
    assert.equal((await run('return 1')).code, 'tool_off');
    const plain = new McpClient(home, { name: 'plain' });
    await plain.init();
    assert.equal((await plain.call('javascript_tool', { tabId: tab, code: 'return 1' })).code, 'unknown_tool');
    await plain.close();
    await sb.eval('document.querySelector("#d-data").open = true');
    await sb.click('#switch-script');
    await until('on', async () => /On/.test(await sb.text('#message')));
  });

  await check('each run asks with the whole code; denied nothing runs; approved a JSON value comes back with tokens masked', async (n) => {
    assert.equal((await approved('document.title = "changed"', false)).code, 'approval_denied');
    assert.equal(await f.page('return document.title'), 'Dev');
    const r = await approved('return { title: document.title, sum: 1 + 1, access_token: localStorage.access_token }');
    n(run.card.slice(0, 200));
    n(r.text.replace(/\s+/g, ' '));
    assert.ok(run.card.includes('return { title: document.title'));
    assert.deepEqual(JSON.parse(r.data.result), { title: 'Dev', sum: 2, access_token: '[redacted]' });
    assert.equal((await approved('throw new Error("mine")')).code, 'page_error');
  });

  await check('the code has the rights of the page and no more: no add-on interface, no HttpOnly cookie, and its policy counts', async (n) => {
    const r = JSON.parse((await approved('return [typeof browser, typeof chrome, typeof exportFunction, /httponly/.test(document.cookie)]')).data.result);
    n(JSON.stringify(r));
    assert.deepEqual(r, ['undefined', 'undefined', 'undefined', false]);
    const origin = `http://localhost:${strict.address().port}`;
    await f.navigate(origin);
    await until('suspended', async () => (await c.call('read_page', { tabId: tab })).code === 'grant_suspended');
    await sb.click('#grants .approve');
    await until('approved', async () => (await c.call('read_page', { tabId: tab })).code === null, 5000, 100);
    const blocked = await approved('return 1');
    n(blocked.text);
    assert.equal(blocked.code, 'page_error');
    await f.navigate(`${A.origin}/dev`);
    await sleep(300);
  });

  await check('a wait that is over says that the code may run on; level read and a page that moved under the card are refused', async (n) => {
    const t = await approved('await new Promise((r) => setTimeout(r, 4000)); return 1', true, { timeout_s: 1 });
    n(t.text.replace(/\s+/g, ' '));
    assert.equal(t.data.timed_out, true);
    const p = run('document.title = "moved"');
    await sb.waitCard();
    await f.navigate(`${B.origin}/second`);
    assert.equal((await p).code, 'grant_suspended');
    assert.equal(await f.page('return document.title'), 'Second');
    await f.navigate(`${A.origin}/dev`);
    await sb.attach('driver', 'read', null);
    assert.equal((await run('return 1')).code, 'read_only_grant');
  });
} finally {
  c?.child.kill();
  await f.quit().catch((e) => console.error('quit', e.message));
  await A.close();
  await B.close();
  strict.close();
  await home.close();
  rmSync(path.join(root, 'dist/developer'), { recursive: true, force: true });
  mkdirSync(path.join(root, 'test-results'), { recursive: true });
  writeFileSync(path.join(root, 'test-results/developer.json'), JSON.stringify({ firefox: f.version, at: new Date().toISOString(), results }, null, 1));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
