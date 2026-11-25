// Observation, site data, page tools, dialogs and the optional backends in the installed Firefox: disposable profiles,
// temporary add-on, installed helper, MCP server, local pages. Real clicks in the real sidebar. No Claude Code.
// node test/firefox/advanced.mjs "<part>" runs the setup and the checks whose name holds that part.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpClient, installHome, root, sleep, until } from '../helpers.mjs';
import { Firefox, Sidebar } from './firefox.mjs';
import { fixture } from './fixtures.mjs';

const only = process.argv[2];
const results = [];
const out = path.join(root, 'test-results');
mkdirSync(out, { recursive: true });
const work = mkdtempSync(path.join(os.tmpdir(), 'fc-adv-'));
const home = installHome();
const B = await fixture(4000);
const A = await fixture(3000, B.origin);
const f = await Firefox.start({ prefs: { 'browser.download.dir': work, 'browser.download.folderList': 2, 'browser.download.useDownloadDir': true } });
const sb = new Sidebar(f, await f.install(path.join(root, 'dist/extension')));
const started = Date.now();
const children = [];
let c;
let tab;

async function check(row, name, fn, { always = false } = {}) {
  if (only && !always && !new RegExp(only).test(name)) return;
  const t = Date.now();
  const notes = [];
  let error = null;
  try {
    await fn((n) => notes.push(n));
  } catch (e) {
    error = e;
    notes.push(`console: ${JSON.stringify(await f.chrome('return Services.console.getMessageArray().map((m) => m.message ?? String(m)).filter((m) => /moz-extension|firefox-companion|hooks.js|content.js/.test(m)).slice(-6)').catch((x) => x.message))}`);
    notes.push(`server: ${A.requests.slice(-8).map((x) => x.path)}; page: ${await f.page('return [location.href, document.readyState, performance.getEntriesByType("resource").map((x) => x.name.split("/").pop() + ":" + Math.round(x.duration)).join()].join(" ")').catch((x) => x.message.slice(0, 100))}`);
    notes.push(`sidebar: ${(await sb.text('body').catch((x) => x.message)).replace(/\s+/g, ' ').slice(0, 1200)}`);
    for (let i = await sb.eval('return document.querySelectorAll("#cards .card").length').catch(() => 0); i > 0; i--) await sb.answerCard(false).catch(() => {});
  }
  results.push({ row, name, ok: !error, ms: Date.now() - t, notes, error: error?.message });
  console.log(`${error ? 'FAIL' : 'ok  '} ${row.padEnd(8)} ${name} (${Date.now() - t} ms)${notes.map((n) => `\n         ${n}`).join('')}${error ? `\n         ${error.stack.split('\n').filter((l) => !/node:internal|helpers/.test(l)).slice(0, 9).join('\n         ')}` : ''}`);
}
const call = (tool, args = {}) => c.call(tool, { tabId: tab, ...args });
const act = async (tool, args) => answer(tool, args, true);
const deny = async (tool, args) => answer(tool, args, false);
async function answer(tool, args, yes) {
  const p = c.call(tool, args.action === 'open' ? args : { tabId: tab, ...args });
  let over = false;
  p.then(() => (over = true));
  await until('card or answer', async () => over || sb.text('#cards .card').catch(() => null), 8000, 30);
  if (!over) {
    act.card = await sb.text('#cards .card');
    await sb.answerCard(yes);
  }
  return p;
}
const refOf = async (name, id = tab) => {
  const o = (await c.call('read_page', { tabId: id, filter: 'interactive' })).text;
  return new RegExp(`"${name}".*\\[(ref_\\w+)\\]`).exec(o)?.[1] ?? assert.fail(`no ${name} in ${o}`);
};
const click = async (name, more = {}) => act('computer', { action: 'left_click', ref: await refOf(name, more.tabId), ...more });
const reported = (what, from = A) => until(`report ${what}`, () => from.reports.includes(what), 6000);
const say = () => sb.eval('document.querySelector("#message").textContent = ""');
/** Turns a switch on or off. `prompt` is Firefox's own question for a permission. */
async function turn(name, on, prompt = false) {
  if ((await sb.eval('return document.querySelector(arguments[0]).checked', `#switch-${name}`)) === on) return 'already so';
  await say();
  await sb.eval('document.querySelector("#d-data").open = true');
  await sb.click(`#switch-${name}`);
  // Firefox has a question for some permissions only.
  // Firefox has a question for some permissions only. Marionette does one thing at a time, so this looks for both in turn.
  let text = null;
  await until(`switch ${name}`, async () => {
    if ((await sb.text('#message')) !== '') return true;
    if (!prompt || !(await f.chrome('return PopupNotifications.panel.state === "open"'))) return false;
    return (text = await f.prompt(true));
  });
  await until(`switch ${name}`, async () => (await sb.text('#message')) !== '');
  return text ?? 'no question of Firefox';
}
/** Attaches the current tab to the client. */
async function attach(level = 'act', answerPrompt = null) {
  await sb.attach('driver', level, answerPrompt);
  tab = Number((await c.call('tabs_context')).data.tabs.find((t) => t.state === 'active')?.tabId);
}
const open = async (url) => {
  await f.navigate(url);
  await sleep(300);
};
/** An optional backend as a process that the user started. Closing its input ends it. */
function backend(file, args = []) {
  const p = spawn(process.execPath, [path.join(root, 'dist', file), ...args], { stdio: 'pipe', env: { ...process.env, FC_BACKEND_STDIN: '1' } });
  const x = { p, text: '', exit: new Promise((r) => p.on('exit', r)) };
  p.stdout.on('data', (d) => (x.text += d));
  p.stderr.on('data', (d) => (x.text += d));
  x.stop = async () => {
    p.stdin.end();
    await Promise.race([x.exit, sleep(25_000)]);
  };
  children.push(x);
  return x;
}
const backendState = async (id) => (await c.call('connection_status')).data.optional_backends.find((b) => b.id === id);
const backendIs = (id, state, ms = 60_000) => until(`backend ${id} ${state}`, async () => (await backendState(id)).state === state, ms, 300);
const turnOn = async (id) => {
  await sb.click(`#backend-${id} .backend-on`);
  await backendIs(id, 'on', 8000);
};

try {
  await open(`${A.origin}/dev`);
  await sb.open();
  await sb.click('#connect');
  await until('connected', async () => (await sb.text('#link-title')) === 'Connected');
  c = new McpClient(home, { name: 'driver', args: ['--with', 'isolated,input'] });
  await c.init();
  await until('client', async () => /driver/.test(await sb.text('#sessions')));
  const first = await f.handle();
  await attach('act', true);

  await check('FC-INST', 'at install: no cookies and no webRequest permission; every group, every backend and the remote link is off', async (n) => {
    const perms = await f.chrome('const p = WebExtensionPolicy.getByID(arguments[0]); return [...p.permissions]', sb.id);
    n(perms.join(' '));
    assert.ok(!perms.includes('cookies') && !perms.includes('webRequest') && perms.includes('contextualIdentities'));
    const tools = { read_console_messages: {}, read_network_requests: {}, page_storage: { action: 'list', area: 'local' }, get_cookies: {}, set_cookie: { name: 'a', value: 'b' }, remove_cookie: { name: 'a' }, webmcp_list: {}, webmcp_call: { tool: '0.a.b', input: {} }, windows_input: { action: 'click', ref: 'ref_a_1' }, isolated_debug: { action: 'scripts' } };
    for (const [t, a] of Object.entries(tools)) assert.equal((await call(t, a)).code, 'tool_off', t);
    assert.equal((await c.call('isolated_browser', { action: 'open', url: A.origin })).code, 'tool_off');
    assert.equal(await sb.text('#cards .card'), null);
    const s = (await c.call('connection_status')).data;
    assert.deepEqual([s.switches_on, s.optional_backends.map((b) => [b.id, b.state])], [[], [['isolated', 'not running'], ['input', 'not running'], ['remote', 'not running']]]);
    assert.ok(s.optional_backends.every((b) => b.setup && b.permissions));
    assert.equal(await f.page('return nativeLog()'), true, 'the console of a granted tab is native while the switch is off');
    assert.equal(await f.page('return typeof navigator.modelContext'), 'undefined');
    const plain = new McpClient(home, { name: 'plain' });
    await plain.init();
    const names = (await plain.request('tools/list')).result.tools.map((t) => t.name);
    assert.ok(!names.some((t) => /^(isolated|windows_input|mail|javascript)/.test(t)), 'optional parts are not listed by a server that was not started for them');
    assert.equal((await plain.call('isolated_browser', { action: 'open', url: A.origin })).code, 'unknown_tool');
    assert.equal((await plain.call('javascript_tool', { code: '1' })).code, 'unknown_tool');
    await plain.close();
  });

  await check('FC-DBG', 'console: levels, frames, errors, masks; nothing forged, no getter of the page runs, an ungranted tab stays native', async (n) => {
    n(await turn('console', true));
    await open(`${A.origin}/dev`);
    await sleep(1800);
    let r = (await call('read_console_messages', { limit: 1000 })).data;
    n(`${r.total} entries, late: ${r.note ?? 'no'}, early line seen: ${r.entries.some((e) => e.text === 'early line')}, load lines seen: ${r.entries.filter((e) => /^loaded/.test(e.text)).length}`);
    const kinds = (k) => r.entries.filter((e) => e.kind === k).map((e) => e.text);
    assert.ok(kinds('rejection').some((t) => t.includes('rejected by timer')), JSON.stringify(r.entries));
    assert.ok(kinds('uncaught').some((t) => t.includes('thrown by timer')));
    assert.ok(r.entries.some((e) => e.text === 'from frame 3000' && e.frame > 0), 'the frame of the same origin');
    await click('Log again');
    r = (await call('read_console_messages', { pattern: 'clicked*' })).data;
    assert.deepEqual(r.entries.map((e) => [e.level, e.text]), ['debug', 'log', 'info', 'warn', 'error'].map((m) => [m, `clicked ${m}`]));
    r = (await call('read_console_messages', { level: 'error', pattern: 'clicked*' })).data;
    assert.equal(r.total, 1);
    const all = (await call('read_console_messages', { limit: 1000 })).text;
    n(/"text": "Authorization[^\n]*/.exec(all)?.[0]);
    for (const secret of ['abcdef1234567890', 'hunter2', 'token=abc', 'forged']) assert.ok(!all.includes(secret), secret);
    assert.ok(!A.reports.includes('getter ran'));
    const t = (await click('Throw')).data;
    n(JSON.stringify(t.page_errors));
    assert.deepEqual([t.page_errors.new, /thrown by click/.test(t.page_errors.first)], [1, true]);
    assert.equal((await click('Log again')).data.page_errors.new, 1, 'only the console error of this click');
    await f.tab(`${A.origin}/dev`);
    assert.equal(await f.page('return nativeLog()'), true, 'the same site in a tab without a grant');
    await f.select(first);
    assert.equal(await f.page('return nativeLog()'), false);
  });

  await check('FC-DBG', 'console ends with a pause and with the switch, and starts empty again', async () => {
    await turn('console', true);
    await sb.click('#pause');
    await until('native again', () => f.page('return nativeLog()'), 4000);
    await f.page('console.log("while paused")');
    await sb.click('#pause');
    await until('hooked again', async () => !(await f.page('return nativeLog()')), 4000);
    await f.page('console.log("after the pause")');
    await sleep(200);
    const t = (await call('read_console_messages')).text;
    assert.ok(t.includes('after the pause') && !t.includes('while paused'));
    await turn('console', false);
    await until('native', () => f.page('return nativeLog()'), 4000);
    assert.equal((await call('read_console_messages')).code, 'tool_off');
  });

  await check('FC-DBG', 'network: redirect, 404, masked headers and addresses; another tab is absent', async (n) => {
    n(await turn('network', true, true));
    await open(`${A.origin}/dev`);
    A.reports.length = 0;
    await f.page('document.getElementById("xhr").click()');
    await until('requests done', () => A.reports.some((x) => x.startsWith('body')), 5000);
    await sleep(300);
    const r = (await call('read_network_requests', { headers: true, limit: 1000 })).data;
    n(`${r.total} requests; ${r.requests.filter((x) => x.type === 'xmlhttprequest').map((x) => `${x.method} ${x.status} ${new URL(x.url).pathname}`).join(', ')}`);
    const by = (p, m = 'GET') => r.requests.find((x) => new URL(x.url).pathname + new URL(x.url).search === p && x.method === m);
    assert.equal(r.requests.find((x) => x.redirects.length)?.redirects[0].status, 302);
    assert.equal(by('/nothing-here').status, 404);
    const api = by('/api?session_token=REDACTED') ?? assert.fail(JSON.stringify(r.requests.map((x) => x.url)));
    const h = (list, name) => list.find((x) => x.name.toLowerCase() === name)?.value;
    assert.deepEqual([h(api.request_headers, 'authorization'), h(api.request_headers, 'x-plain'), h(api.request_headers, 'cookie'), h(api.response_headers, 'set-cookie')], ['[redacted]', 'visible', '[redacted]', '[redacted]']);
    const all = JSON.stringify(r);
    for (const s of ['tok123', 'abcdef1234567890', 'httponlyvalue42', 'abc123def456']) assert.ok(!all.includes(s), s);
    assert.equal((await call('read_network_requests', { status: '4xx' })).data.requests.every((x) => x.status >= 400), true);
    await f.tab(`${A.origin}/second`);
    await f.select(first);
    assert.equal((await call('read_network_requests', { url: '/second' })).data.total, 0);
  });

  await check('FC-DBG', 'bodies: off, denied, then kept with masks, unchanged for the page, cut at the limit, and gone at the end', async (n) => {
    await turn('network', true, true);
    assert.equal((await call('read_network_requests', { bodies: 'start' })).code, 'tool_off');
    n(await turn('bodies', true, true));
    await open(`${A.origin}/dev`);
    assert.equal((await deny('read_network_requests', { bodies: 'start' })).code, 'approval_denied');
    assert.equal((await call('read_network_requests')).data.bodies, 'off');
    assert.equal((await act('read_network_requests', { bodies: 'start' })).data.bodies, 'started');
    n(act.card.slice(0, 200));
    A.reports.length = 0;
    await f.page('document.getElementById("xhr").click()');
    const said = await until('page got the body', () => A.reports.find((x) => x.startsWith('body')), 5000);
    assert.equal(said, `body ${JSON.stringify({ password: 'hunter2', color: 'blue', big: '' }).length}`, 'the page got every byte');
    const posted = (await call('read_network_requests', { method: 'POST', url: '/api' })).data.requests.at(-1);
    const b = (await call('read_network_requests', { bodies: 'read', request_id: posted.id })).data;
    n(JSON.stringify(b));
    assert.deepEqual([JSON.parse(b.response).password, JSON.parse(b.response).color, JSON.parse(b.request)], ['[redacted]', 'blue', { password: '[redacted]', color: 'blue' }]);
    assert.ok((await f.page('return fetch("/api?big=1").then((r) => r.text()).then((t) => t.length)')) > 2_000_000);
    const big = (await call('read_network_requests', { url: 'big=1' })).data.requests.at(-1);
    const cut = (await call('read_network_requests', { bodies: 'read', request_id: big.id })).data;
    assert.deepEqual([cut.response_cut, cut.response.length <= 512 * 1024 + 100], [true, true]);
    await call('read_network_requests', { bodies: 'stop' });
    assert.equal((await call('read_network_requests', { bodies: 'read', request_id: big.id })).code, 'not_found');
    await act('read_network_requests', { bodies: 'start' });
    await turn('bodies', false);
    assert.equal((await call('read_network_requests')).data.bodies, 'off');
  });

  await check('FC-DBG', 'watching an element, typed queries, timing', async (n) => {
    await open(`${A.origin}/dev`);
    const refIn = async (selector) => /"ref": "(ref_\w+)"/.exec((await call('page_query', { action: 'elements', selector })).text)[1];
    const { watch } = (await call('observe_element', { ref: await refIn('#list') })).data;
    await f.page('grow()');
    await sleep(200);
    const w = (await call('observe_read', { watch })).data;
    assert.deepEqual(w.changes.map((x) => [x.kind, x.text]), [0, 1, 2].map((i) => ['added', `More ${i}`]));
    assert.equal((await call('observe_stop', { watch })).data.stopped, true);
    await f.page('grow()');
    assert.equal((await call('observe_read', { watch })).code, 'not_found');
    const table = await refIn('table');
    assert.deepEqual((await call('page_query', { action: 'table', ref: table })).data.rows, [['Name', 'Size'], ['One', '1'], ['Two', '2']]);
    const q = (await call('page_query', { action: 'elements', selector: 'input', attributes: ['type', 'data-token', 'value'] })).data;
    n(JSON.stringify(q.elements.map((e) => [e.name, e.value, e.attributes])));
    const pw = q.elements.find((e) => e.attributes.type === 'password');
    assert.deepEqual([pw.value, pw.attributes['data-token'], pw.attributes.value], ['[secret]', '[secret]', '[secret]']);
    assert.ok(!JSON.stringify(q).includes('hunter2'));
    assert.equal((await call('page_query', { action: 'count', query: 'document.cookie=>1' })).data.total, 0);
    assert.equal((await call('page_query', { action: 'count', selector: 'input[value^=h]' })).code, 'invalid_argument');
    assert.equal((await call('page_query', { action: 'style', ref: table })).data.style.display, 'table');
    assert.equal((await call('page_query', { action: 'box', ref: table })).data.visible, true);
    await f.page('return new Promise((r) => { const i = new Image(); i.onload = i.onerror = () => r(1); i.src = "/slow.png?access_token=secret99"; })');
    const t = (await call('page_timing')).data;
    n(`missing: ${t.missing.join(', ')}; slow: ${t.slow_resources.map((x) => `${x.url} ${Math.round(x.duration)}`)}`);
    assert.ok(t.slow_resources.some((x) => x.duration >= 1000) && !JSON.stringify(t).includes('secret99'));
    assert.ok(t.marks.some((m) => m.name === 'my-mark') && t.measures.some((m) => m.name === 'my-measure'));
  });

  await check('FC-DATA', 'storage: off, denied, masked, changed after a card; level read is refused', async (n) => {
    await turn('storage', true);
    await open(`${A.origin}/dev`);
    assert.equal((await deny('page_storage', { action: 'list', area: 'local' })).code, 'approval_denied');
    const l = (await act('page_storage', { action: 'list', area: 'local' })).data;
    n(JSON.stringify(l.entries));
    const v = (k) => l.entries.find((e) => e.key === k)?.value;
    assert.deepEqual([v('theme'), v('access_token')], ['dark', '[redacted]']);
    assert.equal((await act('page_storage', { action: 'get', area: 'local', key: 'access_token' })).data.entry.value, '[redacted]');
    assert.equal((await act('page_storage', { action: 'set', area: 'local', key: 'theme', value: 'light' })).data.set, true);
    assert.equal(await f.page('return localStorage.getItem("theme")'), 'light');
    assert.equal((await deny('page_storage', { action: 'clear', area: 'local' })).code, 'approval_denied');
    assert.equal(await f.page('return localStorage.length'), 2);
    await attach('read');
    assert.equal((await call('page_storage', { action: 'clear', area: 'local' })).code, 'read_only_grant');
    await attach('act');
  });

  await check('FC-DATA', 'cookies: HttpOnly and token values never come back, other sites are out of reach, HttpOnly is not changed', async (n) => {
    n(await turn('cookies', true, true));
    await open(`${A.origin}/dev`);
    assert.equal((await deny('get_cookies', {})).code, 'approval_denied');
    const names = (await act('get_cookies', {})).data;
    assert.deepEqual(names.cookies.map((x) => x.name).sort(), ['session_id', 'shade', 'sid']);
    assert.ok(names.cookies.every((x) => x.value === '[redacted]'));
    const values = await act('get_cookies', { values: true });
    n(act.card.replace(/\s+/g, ' ').slice(0, 260));
    n(JSON.stringify(values.data.cookies.map((x) => [x.name, x.http_only, x.value])));
    const v = (k) => values.data.cookies.find((x) => x.name === k).value;
    assert.deepEqual([v('shade'), v('sid'), v('session_id')], ['green', '[redacted]', '[redacted]']);
    assert.ok(!/httponlyvalue42|abc123def456/.test(values.text + act.card));
    assert.equal((await call('get_cookies', { domain: 'example.com' })).code, 'invalid_argument');
    assert.equal((await act('set_cookie', { name: 'made', value: 'by tool' })).code, null);
    assert.match(await f.page('return document.cookie'), /made=by tool/);
    assert.equal((await call('remove_cookie', { name: 'sid' })).code, 'not_allowed');
    assert.equal((await call('set_cookie', { name: 'sid', value: 'x' })).code, 'not_allowed');
    assert.equal((await act('remove_cookie', { name: 'made' })).data.removed, true);
    assert.ok(!/made/.test(await f.page('return document.cookie')));
    await turn('cookies', false);
    assert.equal((await call('get_cookies')).code, 'tool_off', 'the switch counts although Firefox still has the permission');
  });

  await check('FC-DATA', 'everyday tools expose no cookie value, also with the cookies permission given', async (n) => {
    await open(`${A.origin}/dev`);
    const texts = [];
    for (const [t, a] of Object.entries({ connection_status: {}, tabs_context: {}, windows_list: {}, containers_list: {}, closed_tabs: { action: 'list' } })) texts.push((await c.call(t, a)).text);
    for (const [t, a] of Object.entries({ read_page: {}, get_page_text: { links: true }, find: { query: 'cookie' }, list_frames: {}, page_query: { action: 'elements', selector: '*', attributes: ['value', 'content', 'data-cookie'] }, page_timing: {}, read_network_requests: { headers: true, limit: 1000 } })) texts.push((await call(t, a)).text);
    texts.push(await sb.text('#log'));
    texts.push(JSON.stringify(await sb.eval('return (await browser.storage.local.get("log")).log')));
    n(`${texts.length} replies, the activity list and the stored log searched`);
    for (const s of ['httponlyvalue42', 'abc123def456', 'shade=green', 'hunter2', 'qwertyuiop']) assert.ok(!texts.some((t) => t.includes(s)), s);
  });

  await check('FC-AGT', 'WebMCP: off leaves the page alone; on, its tools are data; each use asks; a reload makes an id stale', async (n) => {
    await turn('webmcp', true);
    A.reports.length = 0;
    await open(`${A.origin}/dev`);
    await sleep(500);
    n(`offered during the load: ${A.reports.includes('webmcp offered')}`);
    if (!A.reports.includes('webmcp offered')) await f.page('offer()');
    const l = await call('webmcp_list');
    assert.match(l.text, /^<page_content/);
    const { tools } = l.data;
    assert.deepEqual([tools.length, tools[0]?.name], [1, 'add'], l.text);
    const listed = (await c.request('tools/list')).result.tools.map((t) => t.name);
    assert.ok(!listed.includes('add'), 'a tool of the page never becomes a tool of the server');
    assert.equal((await deny('webmcp_call', { tool: tools[0].id, input: { a: 2, b: 3 } })).code, 'approval_denied');
    assert.ok(!A.reports.some((x) => x.startsWith('tool')));
    const r = await act('webmcp_call', { tool: tools[0].id, input: { a: 2, b: 3 } });
    n(act.card.replace(/\s+/g, ' ').slice(0, 300));
    n(r.text.replace(/\s+/g, ' ').slice(0, 260));
    await reported('tool 5');
    assert.ok(r.text.includes('sum 5') && !r.text.includes('zzz'));
    await open(`${A.origin}/dev`);
    assert.equal((await call('webmcp_call', { tool: tools[0].id, input: {} })).code, 'stale_ref');
    await turn('webmcp', false);
    await until('withdrawn', async () => (await f.page('return typeof navigator.modelContext')) === 'undefined', 4000);
    assert.equal((await call('webmcp_list')).code, 'tool_off');
  });

  await check('FC-ACT', 'dialogs: an open native dialog is told within 5 s; a page that asks before it is left stays, or is left after a card that says so', async (n) => {
    await open(`${A.origin}/dev`);
    await f.page('ask()');
    await sleep(400);
    const t = Date.now();
    const r = await call('read_page');
    n(`with a native confirm open, read_page gives ${r.code ?? 'the page'} after ${Date.now() - t} ms`);
    assert.ok([null, 'dialog_open'].includes(r.code) && Date.now() - t < 5500);
    await f.m.send('WebDriver:DismissAlert');
    await reported('answer false');
    assert.equal((await call('read_page')).code, null);
    await f.pageClick('#warn');
    const no = await call('navigate', { url: `${A.origin}/second` });
    assert.equal(no.code, 'not_allowed', no.text);
    n(no.text);
    assert.match(await f.page('return location.pathname'), /dev/);
    const yes = await act('navigate', { url: `${A.origin}/second`, dialog: 'accept' });
    n(JSON.stringify(yes.data?.dialogs ?? yes.text));
    assert.deepEqual([yes.data.state, yes.data.dialogs[0].kind], ['loaded', 'beforeunload']);
    assert.match(act.card, /even if the page asks/);
  });

  await check('FC-TAB', 'viewport: the window is sized for it and the reply tells what was reached', async (n) => {
    await open(`${A.origin}/dev`);
    const r = (await act('resize_window', { viewport: true, width: 800, height: 600 })).data;
    n(JSON.stringify(r));
    assert.deepEqual([r.reached, await f.page('return [innerWidth, innerHeight].join()')], [true, '800,600']);
    const small = (await act('resize_window', { viewport: true, width: 120, height: 600 })).data;
    n(JSON.stringify(small));
    assert.equal(small.reached, false);
    await act('resize_window', { width: 1280, height: 900 });
  });

  // The isolated Firefox

  let iso;
  let far;
  await check('FC-CONN', 'isolated: not running, running but off, on; a second one does not replace the first; its profile and port are its own', async (n) => {
    await open(`${A.origin}/dev`);
    assert.equal((await c.call('isolated_browser', { action: 'open', url: A.origin })).code, 'tool_off');
    iso = backend('backends/isolated.mjs', ['--home', home.dir, '--headless', '--out', path.join(work, 'out')]);
    await backendIs('isolated', 'off');
    const s = await backendState('isolated');
    n(JSON.stringify({ channel: s.channel, detail: s.detail, version: s.version }));
    assert.match(s.channel, /^Firefox \d+.*headless$/);
    assert.equal((await c.call('isolated_browser', { action: 'open', url: A.origin })).code, 'tool_off');
    const second = backend('backends/isolated.mjs', ['--home', home.dir, '--headless']);
    await until('second refused', () => /connected already/.test(second.text), 60_000, 300);
    await second.stop();
    assert.equal((await backendState('isolated')).state, 'off');
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(s.detail)[1]);
    const listen = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' }).split('\n').filter((l) => /LISTENING/.test(l) && l.includes(`:${port} `));
    n(listen.map((l) => l.trim().replace(/\s+/g, ' ')).join(' | '));
    assert.ok(listen.length && listen.every((l) => l.includes(`127.0.0.1:${port}`)));
    const refused = await new Promise((r) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'session.new', params: { capabilities: {} } }));
      ws.onmessage = (e) => r(JSON.parse(e.data).error);
      ws.onerror = () => r('refused');
    });
    assert.equal(refused, 'session not created', 'another program of this computer gets no session');
    await turnOn('isolated');
  }, { always: /isolated/i.test(only ?? '') });

  await check('FC-CONN', 'isolated: open after a card, read with refs and masks, real input, console and network under the same switches', async (n) => {
    assert.equal((await deny('isolated_browser', { action: 'open', url: `${A.origin}/dev` })).code, 'approval_denied');
    A.requests.length = 0;
    const o = await act('isolated_browser', { action: 'open', url: `${A.origin}/dev` });
    n(o.text.replace(/\s+/g, ' '));
    far = o.data.tabId;
    assert.ok(far >= 1e9 && o.data.state === 'loaded', o.text);
    const page = (await c.call('read_page', { tabId: far })).text;
    assert.ok(page.includes('Dev 3000') && !page.includes('hunter2') && page.includes('[secret]'), page);
    assert.equal(A.requests.find((x) => x.path === '/dev').cookie, '', 'no cookie of the everyday profile');
    assert.equal((await c.call('tabs_context')).data.tabs.find((t) => t.tabId === far).backend, 'isolated');
    A.reports.length = 0;
    const real = (await click('Real only', { tabId: far })).data;
    n(JSON.stringify(real));
    assert.deepEqual([real.trusted_event, real.observed], [true, true]);
    await reported('real click');
    const typed = (await act('computer', { action: 'type', tabId: far, ref: await refOf('Entry', far), text: 'hi' })).data;
    assert.deepEqual([typed.characters_arrived, typed.trusted_event], [2, true]);
    await reported('key h true');
    assert.equal((await c.call('computer', { action: 'type', tabId: far, ref: await refOf('Hidden word', far), text: 'x' })).code, 'secret_field');
    assert.equal((await act('form_input', { tabId: far, ref: await refOf('Entry', far), value: 'set' })).data.set, true);
    assert.equal((await c.call('computer', { action: 'screenshot', tabId: far })).content[0].type, 'image');
    await turn('console', false);
    assert.equal((await c.call('read_console_messages', { tabId: far })).code, 'tool_off', 'the console switch counts there as well');
    await turn('console', true);
    await turn('network', true, true);
    const entries = await c.call('read_console_messages', { tabId: far, limit: 1000 });
    assert.ok(entries.text.includes('loaded warn') && entries.text.includes('early line') && entries.text.includes('thrown by timer'), entries.text);
    await click('Log again', { tabId: far });
    assert.ok(!/abcdef1234567890|hunter2/.test((await c.call('read_console_messages', { tabId: far, limit: 1000 })).text));
    const req = await c.call('read_network_requests', { tabId: far, headers: true });
    assert.ok(req.data.requests.some((x) => x.status === 404) && !/httponlyvalue42/.test(req.text));
    await turn('console', false);
  }, { always: /isolated/i.test(only ?? '') });

  await check('FC-ACT', 'isolated: native dialogs held, answered after a card, dismissed by default, accepted by a click that says so; real drag and keys', async (n) => {
    await act('isolated_browser', { action: 'dialog_policy', tabId: far, policy: 'hold' });
    assert.match(act.card, /stay open/);
    await act('navigate', { tabId: far, url: `${A.origin}/control` });
    A.reports.length = 0;
    const held = (await click('Ask', { tabId: far })).data;
    n(JSON.stringify(held));
    assert.equal(held.dialogs[0].answer, 'open');
    assert.equal((await c.call('read_page', { tabId: far })).code, 'dialog_open');
    const a = (await act('isolated_browser', { action: 'dialog', tabId: far, answer: 'accept' })).data;
    assert.match(act.card, /Sure\?/);
    assert.equal(a.answer, 'accept');
    await reported('confirm=true');
    await act('isolated_browser', { action: 'dialog_policy', tabId: far, policy: 'dismiss' });
    A.reports.length = 0;
    assert.equal((await click('Ask', { tabId: far })).data.dialogs[0].answer, 'cancelled');
    await reported('confirm=false');
    assert.equal((await click('Ask', { tabId: far, dialog: 'accept' })).data.dialogs[0].answer, 'accepted');
    await reported('confirm=true');
    const d = await act('computer', { action: 'left_click_drag', tabId: far, ref: await refOf('Drag me', far), to_ref: await refOf('Drop here', far) });
    n(d.text.replace(/\s+/g, ' '));
    const key = (await act('computer', { action: 'key', tabId: far, ref: await refOf('Enter here', far), keys: 'Enter' })).data;
    assert.equal(key.trusted_event, true);
    await reported('submit ');
  });

  await check('FC-GRANT', 'isolated: another origin suspends, frames need their own grant, revoke and stop end it before a queued action starts', async (n) => {
    await act('navigate', { tabId: far, url: `${A.origin}/control` });
    const { frames } = (await c.call('list_frames', { tabId: far })).data;
    n(JSON.stringify(frames));
    assert.deepEqual(frames.filter((x) => x.frame).map((x) => [x.origin, x.granted]).sort(), [[A.origin, true], [B.origin, false]]);
    assert.ok(!(await c.call('read_page', { tabId: far })).text.includes('Inner go 4000'));
    await sb.eval('for (const x of document.querySelectorAll("#grants li")) if (x.textContent.startsWith("Control")) x.querySelector(".frames").id = "far-frames"');
    await sb.click('#far-frames');
    await until('frames', async () => (await sb.text('#frames'))?.includes(B.origin));
    await sb.click('#frames .allow-frame');
    await until('allowed', async () => (await c.call('read_page', { tabId: far })).text.includes('Inner go 4000'), 5000, 200);
    B.reports.length = 0;
    assert.equal((await click('Inner go 4000', { tabId: far })).data.trusted_event, true);
    await reported('inner', B);

    // A card is open, a second action is queued behind it; the user stops everything.
    A.reports.length = 0;
    const ref = await refOf('Enter here', far);
    const one = c.call('computer', { action: 'type', tabId: far, ref, text: 'one' });
    await sb.waitCard();
    const two = c.call('computer', { action: 'key', tabId: far, ref, keys: 'Enter' });
    await sleep(300);
    await sb.click('#halt');
    assert.deepEqual([(await one).code, (await two).code], ['stopped', 'stopped']);
    n((await sb.text('#halt-report')).slice(0, 200));
    await sb.click('#resume-work');
    await sleep(500);
    assert.ok(!A.reports.some((x) => x.startsWith('submit')), 'nothing that was stopped began');
    // Typing under way is stopped in the middle.
    const long = c.call('computer', { action: 'type', tabId: far, ref, text: 'abcdefghij'.repeat(60) });
    await sb.answerCard(true);
    await sleep(150);
    await sb.click('#halt');
    assert.equal((await long).code, 'stopped');
    await sb.click('#resume-work');
    const size = async () => JSON.stringify(await c.call('page_query', { tabId: far, action: 'elements', selector: '#q' })).length;
    await sleep(1500);
    const [s1] = [await size()];
    await sleep(700);
    assert.equal(await size(), s1, 'no key arrives after the stop');

    const moved = await act('navigate', { tabId: far, url: `${B.origin}/control` });
    assert.equal(moved.code, 'grant_suspended');
    assert.equal((await c.call('read_page', { tabId: far })).code, 'grant_suspended');
    await sb.eval('for (const x of document.querySelectorAll("#grants .approve")) x.id = "far-approve"');
    await say();
    await sb.click('#far-approve');
    n(await until('answer to approve', () => sb.text('#message'), 4000));
    await until('approved', async () => (await c.call('read_page', { tabId: far })).text.includes('Control'), 5000, 200);
    await sb.eval('for (const x of document.querySelectorAll("#grants li")) if (x.textContent.startsWith("Control")) x.querySelector(".revoke").id = "far-revoke"');
    const waits = c.call('wait_for', { tabId: far, text: 'never there', timeout_s: 20 });
    await sleep(400);
    await sb.click('#far-revoke');
    assert.equal((await waits).code, 'no_grant');
    assert.equal((await c.call('read_page', { tabId: far })).code, 'no_grant');
  });

  await check('FC-DBG', 'isolated: emulation, scripts and sources of granted sites, logpoints that never hold the page, profile and video files', async (n) => {
    far = (await act('isolated_browser', { action: 'open', url: `${A.origin}/dev` })).data.tabId;
    assert.equal((await c.call('isolated_browser', { action: 'emulate', tabId: far, width: 400 })).code, 'invalid_argument');
    const e = (await act('isolated_browser', { action: 'emulate', tabId: far, width: 400, height: 500, timezone: 'Asia/Tokyo', locale: 'de-DE', user_agent: 'FC-Test/1' })).data;
    n(JSON.stringify(e));
    await act('navigate', { tabId: far, history: 'reload' });
    assert.ok(A.requests.some((x) => x.agent === 'FC-Test/1'));
    assert.ok(!(await f.page('return navigator.userAgent')).includes('FC-Test'), 'the everyday Firefox is as it was');
    const back = await act('isolated_browser', { action: 'emulate', tabId: far, reset: true });
    assert.equal(back.code, null, back.text);
    assert.equal((await call('isolated_debug', { action: 'scripts' })).code, 'not_supported', 'a tab of the everyday Firefox has no debugger');
    await c.call('isolated_debug', { action: 'scripts', tabId: far });
    await act('navigate', { tabId: far, history: 'reload' });
    const s = (await c.call('isolated_debug', { action: 'scripts', tabId: far })).data.scripts.map((x) => x.script);
    n(s.join(' '));
    const app = s.find((x) => x.endsWith('/app.js'));
    const src = await c.call('isolated_debug', { action: 'source', tabId: far, script: app });
    assert.ok(/const doubled/.test(src.text) && !/"inner"/.test(src.text), src.text);
    assert.equal((await c.call('isolated_debug', { action: 'source', tabId: far, script: `${B.origin}/app.js` })).code, 'no_grant');
    const hits = async () => (await c.call('isolated_debug', { action: 'logpoint_hits', tabId: far })).data.hits;
    assert.equal((await deny('isolated_debug', { action: 'logpoint', tabId: far, script: app, line: 4 })).code, 'approval_denied');
    const lp = (await act('isolated_debug', { action: 'logpoint', tabId: far, script: app, line: 4 })).data.logpoint;
    A.reports.length = 0;
    await click('Work', { tabId: far });
    await click('Work', { tabId: far });
    await until('the page went on', () => A.reports.filter((x) => x === 'worked 42').length === 2, 4000);
    const seen = await hits();
    n(JSON.stringify(seen.map((h) => [h.function, h.line, h.variables])));
    assert.deepEqual([seen.length, seen[0].variables.n, seen[0].variables.doubled, seen[0].variables.password], [2, '21', '42', '[redacted]']);
    assert.equal((await c.call('isolated_debug', { action: 'logpoint_remove', tabId: far, logpoint: lp })).code, null);
    await click('Work', { tabId: far });
    assert.deepEqual(await hits(), []);
    assert.equal((await act('isolated_debug', { action: 'profile_start', tabId: far })).data.recording, true);
    await sleep(800);
    const prof = (await c.call('isolated_debug', { action: 'profile_stop', tabId: far })).data;
    assert.equal((await act('isolated_debug', { action: 'video_start', tabId: far })).data.recording, true);
    await act('navigate', { tabId: far, history: 'reload' });
    await sleep(800);
    const vid = (await c.call('isolated_debug', { action: 'video_stop', tabId: far })).data;
    n(JSON.stringify([prof, vid]));
    for (const x of [prof, vid]) assert.ok(statSync(path.join(work, 'out', x.saved)).size === x.bytes && x.bytes > 1000);
  });

  await check('FC-CONN', 'isolated: off ends its tabs; a backend that leaves ends calls; it comes back off; its profile is deleted', async (n) => {
    far = (await act('isolated_browser', { action: 'open', url: `${A.origin}/dev` })).data.tabId;
    const waits = c.call('wait_for', { tabId: far, text: 'never there', timeout_s: 20 });
    await sleep(300);
    await sb.click('#backend-isolated .backend-off');
    const ended = (await waits).code;
    n(`a waiting call ended with ${ended}`);
    assert.ok(['tool_off', 'no_grant'].includes(ended));
    assert.equal((await c.call('read_page', { tabId: far })).code, 'no_grant');
    await turnOn('isolated');
    const profile = /profile (\S+),/.exec(iso.text)[1];
    assert.ok(existsSync(profile));
    far = (await act('isolated_browser', { action: 'open', url: `${A.origin}/dev` })).data.tabId;
    const w2 = c.call('wait_for', { tabId: far, text: 'never there', timeout_s: 20 });
    await sleep(300);
    await iso.stop();
    n(`after the backend left: ${(await w2).code}`);
    assert.equal((await backendState('isolated')).state, 'not running');
    assert.equal(existsSync(profile), false, 'the profile is gone');
    assert.equal((await c.call('isolated_browser', { action: 'open', url: A.origin })).code, 'tool_off');
    const again = backend('backends/isolated.mjs', ['--home', home.dir, '--headless']);
    await backendIs('isolated', 'off');
    await turnOn('isolated');
    // The helper is killed: the backend connects again by itself, and is off again.
    const all = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process -Filter "Name=\'firefox-companion-host.exe\'" | Select-Object ProcessId, ExecutablePath | ConvertTo-Json'], { encoding: 'utf8' }));
    process.kill([all].flat().find((x) => x.ExecutablePath.toLowerCase().startsWith(home.dir.toLowerCase())).ProcessId);
    await until('connected again', async () => (await sb.text('#link-title')) === 'Connected', 15_000, 200);
    await until('isolated again', async () => /· version/.test((await sb.text('#backend-isolated')) ?? ''), 20_000, 300);
    await c.call('tabs_context'); // session_ended
    assert.equal((await backendState('isolated')).state, 'off');
    await again.stop();
    assert.equal(readdirSync(os.tmpdir()).some((x) => x.startsWith('fc-isolated-')), false);
  });
} finally {
  c?.child.kill();
  for (const x of children) if (x.p.exitCode === null) await x.stop();
  await f.quit().catch((e) => console.error('quit', e.message));
  await A.close();
  await B.close();
  await home.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  const failed = results.filter((r) => !r.ok);
  if (!only) writeFileSync(path.join(out, 'advanced.json'), JSON.stringify({ firefox: f.version, headless: f.capabilities['moz:headless'], at: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000), results }, null, 1));
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
}
