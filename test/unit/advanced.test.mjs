// Observation, site data, optional backends, schedules and pairings with a mocked browser. Real: Router, tools, Grants,
// Approvals, Observer, Backends, Schedules, Remote. Simulated evidence only.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { Backends } from '../../dist/extension/background/backends.mjs';
import { Observer } from '../../dist/extension/background/observe.mjs';
import { Router } from '../../dist/extension/background/router.mjs';
import { Approvals } from '../../dist/extension/grants/approvals.mjs';
import { Grants } from '../../dist/extension/grants/grants.mjs';
import { Remote } from '../../dist/extension/remote/remote.mjs';
import { Schedules, cleanSchedule, nextTime } from '../../dist/extension/schedule/schedule.mjs';
import { GROUPS, LIMITS, TOOLS, VIRTUAL } from '../../dist/extension/shared/protocol.mjs';
import { Replay } from '../../dist/extension/workflow/replay.mjs';

const A = 'https://a.example';
const B = 'https://b.example';
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
let tabs, pages, router, grants, approvals, backends, observer, n, posted, granted, cookies, events, hooks, log;

const event = () => {
  const list = new Map();
  return { list, addListener: (f, filter, extra) => list.set(f, { filter, extra }), removeListener: (f) => list.delete(f), fire: (d) => [...list].filter(([, x]) => x.filter.tabId === d.tabId).map(([f]) => f(d)) };
};
let webRequest;

beforeEach(async () => {
  tabs = [{ id: 1, windowId: 1, active: true, url: `${A}/x`, title: 'A', status: 'complete', cookieStoreId: 'firefox-default' }, { id: 2, windowId: 1, url: `${B}/`, title: 'B', status: 'complete' }];
  [pages, posted, events, hooks, log] = [[], [], [], [], []];
  n = 0;
  granted = new Set();
  cookies = [{ name: 'shade', value: 'green', domain: 'a.example', path: '/', httpOnly: false, session: true }, { name: 'sid', value: 'httponlyvalue42', domain: 'a.example', path: '/', httpOnly: true, session: true }, { name: 'auth_token', value: 'plain', domain: 'a.example', path: '/', httpOnly: false, session: true }, { name: 'flavor', value: 'mint', domain: 'a.example', path: '/', httpOnly: true, session: true }];
  webRequest = Object.fromEntries(['onBeforeRequest', 'onSendHeaders', 'onBeforeRedirect', 'onResponseStarted', 'onCompleted', 'onErrorOccurred', 'onHeadersReceived'].map((k) => [k, event()]));
  grants = new Grants();
  approvals = new Approvals();
  const browser = {
    permissions: { contains: async ({ permissions }) => permissions.every((p) => granted.has(p)) },
    windows: { get: async () => ({ id: 1, state: 'normal', title: 'A', focused: true }) },
    cookies: { getAll: async (d) => cookies.filter((c) => !d.name || c.name === d.name), set: async (d) => (cookies.push({ ...d, domain: 'a.example', session: true }), d), remove: async (d) => (cookies = cookies.filter((c) => c.name !== d.name)) },
    downloads: { search: async () => [{ id: 7, filename: 'C:\\Users\\me\\Downloads\\a.txt', url: `${A}/f?token=abc`, state: 'complete', mime: 'text/plain', exists: true, danger: 'safe' }] },
  };
  const firefox = {
    browser,
    getTab: async (id) => tabs.find((t) => t.id === id) ?? Promise.reject(new Error('gone')),
    queryTabs: async () => tabs,
    hasHost: async () => true,
    hasAllUrls: async () => true,
    openUrl: async () => {},
    forget: () => {},
    abort: () => {},
    page: async (id, m) => {
      pages.push(m);
      return { id: 'doc', ...{ where: { origin: tabs.find((t) => t.id === id).url.startsWith(A) ? A : B }, children: { children: [] }, describe: { description: 'button "Go"', fingerprint: 'f' }, aim: { x: 5, y: 6, at: null, screen: { x: 100, y: 50, ratio: 2 } }, after: { changed: true, dialogs: [] }, storage: m.action === 'list' ? { total: 2, entries: [{ key: 'theme', length: 4, value: 'dark' }, { key: 'access_token', length: 3, value: 'abc' }] } : { set: true }, pointer: { at: null } }[m.cmd] };
    },
    annotate: async (dataUrl) => ({ dataUrl, width: 1, height: 1 }),
  };
  backends = new Backends({ post: (pipe, m) => posted.push({ pipe, ...m }), router: null, onEvent: (name, m) => events.push([name, m.event ?? m.type]) });
  router = new Router({ grants, approvals, api: backends.extend(firefox), log: (l) => log.push(l), onGrantEnd: (g) => observer.grantEnded(g), onChange: () => observer?.sync() });
  observer = null;
  backends.router = router;
  router.backends = backends;
  observer = router.observer = new Observer({ api: router.api, grants, router, webRequest: () => (granted.has('webRequest') ? webRequest : null), walk: async (g, fn) => fn(0, A), send: async (tab, frame, m) => (hooks.push([tab, frame, m.action, m.console]), { id: 'doc1', late: false }) });
  for (const [id, kind] of [['s1', 'mcp'], ['s2', 'mcp'], ['sidebar', 'sidebar']]) router.openSession(id, kind, id);
  await router.grant({ sessionId: 's1', tabId: 1, origin: A, level: 'act' });
});

const call = (tool, args = {}, s = 's1') => router.call(s, ++n, tool, args);
const code = async (p) => (await p).error?.code ?? 'ok';
const card = async () => {
  for (let i = 0; i < 200 && !approvals.cards.length; i++) await tick();
  assert.ok(approvals.cards[0], 'a card is open');
  return approvals.cards[0];
};
const answer = async (yes = true) => {
  const c = await card();
  approvals.shown(c.id);
  await tick(510);
  approvals.answer(c.id, yes);
  return c;
};
const sender = (over = {}) => ({ tab: tabs[0], frameId: 0, origin: A, ...over });
const say = (text, level = 'log') => [{ at: 1, level, kind: 'console', text }];
/** Plays a backend: answers each command that `fn` knows. */
const serve = (name, fn) => {
  const seen = [];
  const pipe = `p-${name}`;
  backends.attach(pipe, { id: name, version: '1', channel: 'test' });
  backends.post = (to, m) => {
    posted.push({ pipe: to, ...m });
    if (to !== pipe || m.type !== 'command') return;
    seen.push(m);
    const r = fn?.(m);
    if (r !== undefined) queueMicrotask(() => backends.onMessage(pipe, r.error ? { type: 'reply', id: m.id, ...r } : { type: 'reply', id: m.id, data: btoa(JSON.stringify(r)) }));
  };
  return { pipe, seen, on: () => (backends.set(name, true), (router.switches[name] = true)) };
};
const isolated = () => serve('isolated', (m) => ({ open: { key: 'c1', url: 'about:blank', title: '', status: 'loading' }, close: {}, navigate: {}, log: { since: 1, console: [], requests: [] }, page: m.method === 'page' ? { id: 'd', ...{ where: { origin: A }, children: { children: [] }, snapshot: { lines: ['- button "Go" [ref_d_1]'], frames: [], truncated: false, fullChars: 9, ready: 'complete' }, describe: { description: 'button "Go"', fingerprint: 'f' }, pointer: { at: null, trusted: true }, after: { changed: true, dialogs: [] }, leave: { asks: false }, place: {} }[m.params.message?.cmd] } : undefined }[m.method]));
/** A tab of the isolated backend that session s1 opened on A. */
async function far(b) {
  const p = call('isolated_browser', { action: 'open', url: `${A}/iso` });
  await answer(true);
  for (let i = 0; i < 100 && !b.seen.some((m) => m.method === 'open'); i++) await tick();
  await tick(20);
  backends.onMessage(b.pipe, { type: 'event', event: 'tab', key: 'c1', url: `${A}/iso`, title: 'Iso', status: 'complete' });
  const r = await p;
  assert.equal(r.error, undefined, JSON.stringify(r));
  return r.result.tabId;
}

// Switches

test('every switch is off at first, asks for nothing, and a switch that goes off ends what runs and what waits', async () => {
  const need = { read_console_messages: {}, read_network_requests: {}, page_storage: { action: 'list', area: 'local' }, get_cookies: {}, set_cookie: { name: 'a', value: 'b' }, remove_cookie: { name: 'a' }, webmcp_list: {}, webmcp_call: { tool: '0.a.b', input: {} }, windows_input: { action: 'click', ref: 'r' }, isolated_browser: { action: 'open', url: A }, isolated_debug: { action: 'scripts' } };
  for (const [t, a] of Object.entries(need)) assert.equal(await code(call(t, t === 'isolated_browser' ? a : { tabId: 1, ...a })), 'tool_off', t);
  assert.deepEqual([approvals.cards.length, pages.length], [0, 0]);
  router.switches.storage = true;
  const p = call('page_storage', { tabId: 1, action: 'list', area: 'local' });
  await card();
  router.switches.storage = false;
  router.stopGroup('storage');
  assert.equal(await code(p), 'tool_off');
  assert.equal(approvals.cards.length, 0);
  router.switches.storage = true;
  const q = call('page_storage', { tabId: 1, action: 'list', area: 'local' });
  await card();
  router.switches.storage = false; // only the switch, right before the answer
  await answer(true);
  assert.equal(await code(q), 'tool_off', 'it counts again after the card');
  assert.ok(!pages.some((m) => m.cmd === 'storage'));
});

test('a switch without its Firefox permission does not count', async () => {
  for (const [name, perms] of Object.entries(GROUPS).filter(([, p]) => p.length)) {
    router.switches[name] = true;
    await assert.rejects(router.group(name), { code: 'permission_required' }, name);
    perms.forEach((p) => granted.add(p));
    await router.group(name);
    granted.clear();
  }
});

// Console

test('console: only entries that Firefox says come from a granted tab, frame and origin; masked; errors are told once', async () => {
  router.switches.console = true;
  observer.sync();
  await tick();
  observer.onConsole(say('hello token=abcd1234'), sender());
  observer.onConsole(say('other tab'), sender({ tab: tabs[1], origin: B }));
  observer.onConsole(say('another tab of the same site'), sender({ tab: { ...tabs[0], id: 9 } }));
  observer.onConsole(say('other frame'), sender({ frameId: 5, origin: B }));
  observer.onConsole(say('moved'), sender({ tab: { ...tabs[0], url: `${B}/` }, origin: B }));
  observer.onConsole('junk', sender());
  let r = (await call('read_console_messages', { tabId: 1 })).result;
  assert.deepEqual(r.entries.map((e) => e.text), ['hello token=[redacted]']);
  grants.all[0].frames.push(B);
  observer.onConsole(say('allowed frame'), sender({ frameId: 5, origin: B }));
  observer.onConsole(say('boom\nsecond line', 'error'), sender());
  assert.deepEqual(observer.takeErrors('s1', 1), { new: 1, first: 'boom' });
  assert.equal(observer.takeErrors('s1', 1), null);
  r = (await call('read_console_messages', { tabId: 1, level: 'error', clear: true })).result;
  assert.deepEqual([r.total, (await call('read_console_messages', { tabId: 1 })).result.total], [1, 0]);
  assert.equal(await code(call('read_console_messages', { tabId: 1 }, 's2')), 'conflict');
});

test('console: pause, stop, take over, revoke and a move to another origin end it and forget it', async () => {
  router.switches.console = true;
  const texts = async () => (await call('read_console_messages', { tabId: 1 })).result?.entries.map((e) => e.text);
  const ends = { pause: [() => router.setPaused(true), () => router.setPaused(false)], halt: [() => router.halt(), () => router.resume()], take: [() => router.stopTab(1), () => router.resumeTab(1)] };
  for (const [what, [end, back]] of Object.entries(ends)) {
    observer.sync();
    observer.onConsole(say('before'), sender());
    hooks.length = 0;
    end();
    assert.ok(hooks.some(([, , a]) => a === 'off'), `${what} takes the hooks away`);
    observer.onConsole(say('while'), sender());
    back();
    observer.sync();
    observer.onConsole(say('after'), sender());
    assert.deepEqual(await texts(), ['after'], what);
  }
  router.revoke(() => true);
  observer.onConsole(say('revoked'), sender());
  assert.equal(observer.captures.size, 0);
  await router.grant({ sessionId: 's1', tabId: 1, origin: A, level: 'read' });
  observer.sync();
  tabs[0].url = `${B}/`;
  router.tabMoved(1, `${B}/`);
  assert.equal(observer.captures.size, 0);
});

// Network

const req = (id, over = {}) => ({ requestId: id, tabId: 1, frameId: 0, type: 'xmlhttprequest', method: 'GET', url: `${A}/api?session_token=s3`, documentUrl: `${A}/x`, timeStamp: 1, ...over });

test('network: requests of granted documents only, masked, with redirects; another site of a redirect is told as that site', async () => {
  Object.assign(router.switches, { network: true });
  granted.add('webRequest');
  observer.sync();
  const w = webRequest;
  w.onBeforeRequest.fire(req('1'));
  w.onSendHeaders.fire({ ...req('1'), requestHeaders: [{ name: 'Authorization', value: 'Bearer zzzzzzzz' }, { name: 'X-Plain', value: 'ok' }] });
  w.onBeforeRedirect.fire({ ...req('1'), statusCode: 302, redirectUrl: `${A}/next` });
  w.onResponseStarted.fire({ ...req('1'), statusCode: 200, responseHeaders: [{ name: 'Set-Cookie', value: 'sid=1' }] });
  w.onCompleted.fire({ ...req('1'), statusCode: 200, timeStamp: 9 });
  w.onBeforeRequest.fire(req('2', { documentUrl: `${B}/frame`, frameId: 4 }));
  w.onBeforeRequest.fire(req('3', { type: 'main_frame', url: `${B}/away` }));
  w.onBeforeRequest.fire(req('4', { type: 'main_frame', url: `${A}/go`, documentUrl: undefined }));
  w.onBeforeRedirect.fire({ ...req('4', { type: 'main_frame' }), statusCode: 301, redirectUrl: `${B}/secret/path?x=1` });
  const r = (await call('read_network_requests', { tabId: 1, headers: true })).result;
  assert.deepEqual(r.requests.map((x) => [x.id, x.url, x.status]), [['1', `${A}/next`, 200], ['4', B, null]]);
  assert.deepEqual(r.requests[0].redirects, [{ status: 302, from: `${A}/api?session_token=REDACTED`, to: `${A}/next` }]);
  assert.ok(!/zzzzzzzz|sid=1|secret\/path|s3"/.test(JSON.stringify(r)));
  assert.equal(r.requests[0].request_headers[1].value, 'ok');
  router.revoke(() => true);
  assert.ok(Object.values(w).every((e) => e.list.size === 0), 'no listener is left');
});

test('bodies: a switch of their own, a card each time, and an end by revoke', async () => {
  Object.assign(router.switches, { network: true });
  granted.add('webRequest');
  assert.equal(await code(call('read_network_requests', { tabId: 1, bodies: 'start' })), 'tool_off');
  router.switches.bodies = true;
  granted.add('webRequestBlocking');
  for (const yes of [false, true]) {
    const p = call('read_network_requests', { tabId: 1, bodies: 'start' });
    await answer(yes);
    assert.equal(await code(p), yes ? 'ok' : 'approval_denied');
  }
  assert.deepEqual([...webRequest.onHeadersReceived.list.values()][0].extra, ['blocking', 'responseHeaders']);
  router.setPaused(true);
  assert.equal(webRequest.onHeadersReceived.list.size, 0);
  router.setPaused(false);
  assert.equal((await call('read_network_requests', { tabId: 1 })).result.bodies, 'off', 'it does not begin again by itself');
  assert.equal(await code(call('read_network_requests', { tabId: 1, bodies: 'read', request_id: '1' })), 'not_found');
});

// Site data

test('cookies: values only of script-readable ones that do not look like credentials; HttpOnly is neither shown nor changed', async () => {
  router.switches.cookies = true;
  granted.add('cookies');
  let p = call('get_cookies', { tabId: 1, values: true });
  const c = await answer(true);
  const r = (await p).result;
  assert.deepEqual(r.cookies.map((x) => [x.name, x.value]), [['shade', 'green'], ['sid', '[redacted]'], ['auth_token', '[redacted]'], ['flavor', '[redacted]']]);
  assert.ok(!/httponlyvalue42|plain"|mint/.test(JSON.stringify([r, c, log])));
  assert.match(c.value, /Values of: shade\./);
  for (const t of ['set_cookie', 'remove_cookie']) assert.equal(await code(call(t, { tabId: 1, name: 'sid', ...(t === 'set_cookie' && { value: 'x' }) })), 'not_allowed');
  p = call('set_cookie', { tabId: 1, name: 'late', value: 'x' });
  await card();
  cookies.push({ name: 'late', value: 'y', httpOnly: true, session: true });
  await answer(true);
  assert.equal(await code(p), 'not_allowed', 'one that became HttpOnly while the card was open');
  assert.equal(await code(call('set_cookie', { tabId: 1, name: 'a=b', value: 'x' })), 'invalid_argument');
  assert.equal(await code(call('get_cookies', { tabId: 1, domain: 'b.example' })), 'invalid_argument');
});

test('storage is masked, downloads tell no folder and only those of the session', async () => {
  Object.assign(router.switches, { storage: true, downloads: true });
  granted.add('downloads');
  const p = call('page_storage', { tabId: 1, action: 'list', area: 'local' });
  await answer(true);
  assert.deepEqual((await p).result.entries.map((e) => [e.key, e.value]), [['theme', 'dark'], ['access_token', '[redacted]']]);
  assert.equal(await code(call('download_inspect', { id: 7 })), 'not_found');
  router.sessions.get('s1').downloads.push(7);
  const d = (await call('download_inspect', { id: 7 })).result;
  assert.deepEqual([d.file, d.url, d.type, d.file_exists], ['a.txt', `${A}/f?token=REDACTED`, 'text/plain', true]);
  assert.ok(!JSON.stringify(d).includes('Users'));
});

// Backends

test('backends: unknown ones and a second one are refused; nothing is sent to one that is off; off again after it went', async () => {
  assert.throws(() => backends.attach('p', { id: 'other' }), { code: 'invalid_argument' });
  const b = isolated();
  assert.throws(() => backends.attach('p2', { id: 'isolated' }), { code: 'conflict' });
  router.switches.isolated = true; // the switch alone is not enough
  assert.equal(await code(call('isolated_browser', { action: 'open', url: A })), 'tool_off');
  backends.set('isolated', true);
  router.switches.isolated = false; // nor is the backend alone
  assert.equal(await code(call('isolated_browser', { action: 'open', url: A })), 'tool_off');
  assert.equal(b.seen.length, 0);
  b.on();
  assert.deepEqual((await call('connection_status')).result.optional_backends.map((x) => [x.id, x.state, x.channel]), [['isolated', 'on', 'test'], ['input', 'not running', undefined], ['remote', 'not running', undefined]]);
  backends.detach(b.pipe);
  isolated();
  assert.equal(await code(call('isolated_browser', { action: 'open', url: A })), 'tool_off');
});

test('isolated: a tab of it meets the same session, tab, origin, frame, level, pause and take-over rules', async () => {
  const b = isolated();
  b.on();
  const id = await far(b);
  assert.ok(id >= VIRTUAL);
  assert.match((await call('read_page', { tabId: id })).result.outline, /Go/);
  assert.equal(await code(call('read_page', { tabId: id }, 's2')), 'conflict');
  assert.equal(await code(call('read_page', { tabId: id + 1 })), 'no_grant');
  for (const t of ['tabs_close', 'tabs_select', 'tabs_group', 'resize_window', 'windows_input', 'file_upload']) {
    const a = { tabs_group: { tabIds: [id] }, resize_window: { tabId: id, width: 500 }, windows_input: { tabId: id, action: 'click', ref: 'ref_d_1' }, file_upload: { tabId: id, ref: 'ref_d_1', paths: ['C:\\x'] } }[t] ?? { tabId: id };
    assert.ok(['not_supported', 'tool_off', 'path_not_allowed', 'invalid_argument'].includes(await code(call(t, a))), t);
  }
  router.setPaused(true);
  assert.equal(await code(call('read_page', { tabId: id })), 'paused');
  router.setPaused(false);
  router.stopTab(id);
  assert.equal(await code(call('read_page', { tabId: id })), 'stopped');
  router.resumeTab(id);
  backends.onMessage(b.pipe, { type: 'event', event: 'tab', key: 'c1', url: `${B}/`, title: '', status: 'complete' });
  assert.equal(await code(call('read_page', { tabId: id })), 'grant_suspended');
  backends.onMessage(b.pipe, { type: 'event', event: 'tab', key: 'c1', url: `${A}/iso`, title: '', status: 'complete' });
  assert.equal(await code(call('read_page', { tabId: id })), 'grant_suspended', 'back on the site it still needs the user');
  await router.approveOrigin(grants.find('s1', id).id, A);
  assert.equal(await code(call('read_page', { tabId: id })), 'ok');
  router.switches.isolated = false;
  assert.equal(await code(call('read_page', { tabId: id })), 'tool_off', 'ordinary tools as well');
});

test('isolated: stop, revoke, off and a lost backend end queued actions before they start, and what waits is cancelled there', async () => {
  for (const end of [(id, b) => router.halt(), (id, b) => router.revoke((g) => g.tabId === id), (id, b) => (backends.set('isolated', false), (router.switches.isolated = false)), (id, b) => backends.detach(b.pipe)]) {
    router.resume();
    for (const x of [...backends.list.values()]) backends.detach(x.pipe);
    router.revoke((g) => g.tabId >= VIRTUAL);
    const b = isolated();
    b.on();
    const id = await far(b);
    const act = () => call('computer', { action: 'left_click', tabId: id, ref: 'ref_d_1' });
    const one = act();
    await card();
    const two = act();
    await tick(20);
    end(id, b);
    const codes = [await code(one), await code(two)];
    assert.ok(codes.every((c) => ['stopped', 'no_grant', 'tool_off'].includes(c)), codes.join());
    await tick(30);
    assert.ok(!b.seen.some((m) => m.params.message?.cmd === 'pointer'), 'no action reached the backend');
    assert.equal(approvals.cards.length, 0);
  }
});

test('isolated: an approval is checked again, a stop before the last gate sends nothing, and real input is told as such', async () => {
  const b = isolated();
  b.on();
  const id = await far(b);
  let p = call('computer', { action: 'left_click', tabId: id, ref: 'ref_d_1' });
  await card();
  grants.suspend(grants.find('s1', id), 'origin');
  await answer(true);
  assert.equal(await code(p), 'grant_suspended');
  await router.approveOrigin(grants.find('s1', id).id, A);
  p = call('computer', { action: 'left_click', tabId: id, ref: 'ref_d_1' });
  await answer(true);
  const r = (await p).result;
  assert.deepEqual([r.trusted_event, r.observed], [true, true]);
  assert.equal(b.seen.filter((m) => m.params.message?.cmd === 'pointer').length, 1);
});

test('isolated: a backend that fails in the middle leaves the outcome open, and one that refused before says so', async () => {
  let reply = { error: { code: 'internal_error', message: 'broke' } };
  const b = serve('isolated', (m) => (m.method === 'open' ? { key: 'c1', url: 'about:blank', status: 'loading' } : m.method !== 'page' ? {} : m.params.message.cmd === 'pointer' ? reply : { id: 'd', ...{ where: { origin: A }, describe: { description: 'b', fingerprint: 'f' }, children: { children: [] }, after: { changed: false } }[m.params.message.cmd] }));
  b.on();
  const id = await far(b);
  let p = call('computer', { action: 'left_click', tabId: id, ref: 'ref_d_1' });
  await answer(true);
  let r = await p;
  assert.deepEqual([r.error.code, /may have reached the page/.test(r.error.message)], ['internal_error', true]);
  reply = { error: { code: 'dialog_open', message: 'A confirm is open', before: true } };
  p = call('computer', { action: 'left_click', tabId: id, ref: 'ref_d_1' });
  await answer(true);
  r = await p;
  assert.deepEqual([r.error.code, /may have reached the page/.test(r.error.message)], ['dialog_open', false]);
});

test('nothing falls back: a synthetic click without effect, or one that fails, sends no command to a backend that is on', async () => {
  const b = serve('input', () => ({ sent: true }));
  b.on();
  const iso = isolated();
  iso.on();
  const before = posted.length;
  const p = call('computer', { action: 'left_click', tabId: 1, ref: 'r' });
  await answer(true);
  const r = (await p).result;
  assert.equal(r.trusted_event, false);
  assert.deepEqual(posted.slice(before).filter((m) => m.type === 'command'), []);
});

test('windows input: asked for by name, after a card, top frame and front tab only, with the point in real pixels', async () => {
  let reply = { sent: true };
  const b = serve('input', () => reply);
  b.on();
  assert.equal(await code(call('windows_input', { tabId: 1, action: 'click', ref: 'ref_f3_d_1' })), 'not_supported');
  let p = call('windows_input', { tabId: 1, action: 'click', ref: 'r' });
  await answer(false);
  assert.equal(await code(p), 'approval_denied');
  assert.equal(b.seen.length, 0);
  p = call('windows_input', { tabId: 1, action: 'double_click', ref: 'r' });
  await answer(true);
  assert.equal((await p).result.trusted_event, true);
  assert.deepEqual(b.seen[0].params, { x: 210, y: 112, count: 2, title: 'A', focused: true });
  reply = { sent: false, why: 'another window covers the point' };
  p = call('windows_input', { tabId: 1, action: 'click', ref: 'r' });
  await answer(true);
  const r = await p;
  assert.deepEqual([r.error.code, /may have reached/.test(r.error.message)], ['not_actionable', false]);
  tabs[0].active = false;
  p = call('windows_input', { tabId: 1, action: 'click', ref: 'r' });
  await answer(true);
  assert.equal(await code(p), 'not_actionable');
  assert.equal(b.seen.length, 2);
});

test('a message of a backend counts only for its own commands and tabs', async () => {
  const b = isolated();
  b.on();
  const id = await far(b);
  backends.attach('p-input', { id: 'input' });
  backends.onMessage('p-input', { type: 'event', event: 'tab_closed', key: 'c1' });
  backends.onMessage('nobody', { type: 'event', event: 'tab_closed', key: 'c1' });
  backends.onMessage(b.pipe, { type: 'reply', id: 'b99', data: 'x' });
  assert.ok(backends.tab(id));
  backends.onMessage(b.pipe, { type: 'event', event: 'tab_opened', key: 'c2', opener: 'c1', url: `${A}/pop`, status: 'loading' });
  assert.equal(await code(call('read_page', { tabId: id + 1 })), 'no_grant', 'a tab that no click of the session opened');
  backends.onMessage(b.pipe, { type: 'event', event: 'tab_closed', key: 'c1' });
  assert.equal(await code(call('read_page', { tabId: id })), 'no_grant');
});

// Schedules

const W = { id: 'w1', title: 'Report', origin: A, tabs: [A], steps: [{ kind: 'page', origin: A, path: '/x' }, { kind: 'fill', role: 'textbox', name: 'Q', nth: 0, of: 1, ask: true }] };
let clock, store, replayed;
const schedules = (w = structuredClone(W)) => {
  clock = new Date(2026, 10, 24, 8, 0, 0).getTime();
  store = { data: {}, get: async (d) => ({ ...d, ...structuredClone(store.data) }), set: (x) => Object.assign(store.data, structuredClone(x)) };
  replayed = [];
  const replay = { state: null, start: (x, tabId, values) => (replayed.push({ tabId, values }), (replay.state = { status: 'running', message: '', steps: [] })), cancel: () => Object.assign(replay.state, { status: 'cancelled', message: 'Cancelled after 1 of 2 steps.' }) };
  const workflows = { saved: [w], get: (id) => workflows.saved.find((x) => x.id === id) ?? (() => { throw Object.assign(new Error('gone'), { code: 'not_found' }); })() };
  const s = new Schedules({ store, workflows, replay, router, now: () => clock, setTimer: () => {}, uuid: () => 'sc1' });
  return { s, replay, workflows, last: () => s.list[0].runs.at(-1) };
};
const giveTab = () => router.grant({ sessionId: 'sidebar', tabId: 1, origin: A, level: 'act' });

test('schedule: times are checked, and the next one is right for each kind', () => {
  for (const m of [{}, { kind: 'once' }, { kind: 'every', minutes: 5 }, { kind: 'daily', time: '25:00' }, { kind: 'weekly', time: '08:00', days: [] }, { kind: 'weekly', time: '08:00', days: [9] }]) assert.throws(() => cleanSchedule(m), { code: 'invalid_argument' });
  const at = (...x) => new Date(2026, 10, ...x).getTime(); // 24 November 2026 is a Tuesday
  assert.equal(nextTime({ kind: 'daily', time: '08:30' }, at(24, 8, 0)), at(24, 8, 30));
  assert.equal(nextTime({ kind: 'daily', time: '08:30' }, at(24, 8, 30)), at(25, 8, 30));
  assert.equal(nextTime({ kind: 'weekly', time: '08:30', days: [1, 2] }, at(24, 9, 0)), at(30, 8, 30));
  assert.equal(nextTime({ kind: 'once', at: at(24) }, at(25)), null);
  assert.equal(nextTime({ kind: 'every', minutes: 20 }, at(24)), at(24, 0, 20));
});

test('schedule: only a saved workflow; due without a tab or a text it waits and says why; then it is an ordinary replay', async () => {
  const { s, replay, last } = schedules();
  assert.throws(() => s.add({ workflow: 'nope', kind: 'daily', time: '08:30' }), { code: 'not_found' });
  s.add({ workflow: 'w1', kind: 'daily', time: '08:30' });
  s.check();
  assert.equal(s.list[0].runs.length, 0);
  clock += 30 * 60_000;
  s.check();
  assert.deepEqual([last().state, /Attach a tab/.test(last().message), replayed.length], ['needs you', true, 0]);
  assert.equal(grants.of('sidebar').length, 0, 'a schedule gives no grant');
  await giveTab();
  s.changed();
  assert.match(last().message, /Give the texts/);
  assert.deepEqual(s.view()[0].asks, [{ step: 1, name: 'textbox "Q"', given: false }]);
  s.answer('sc1', { 1: 'hello' });
  assert.deepEqual([last().state, replayed], ['running', [{ tabId: 1, values: { 1: 'hello' } }]]);
  assert.ok(!JSON.stringify(store.data).includes('hello'), 'a text is not stored');
  Object.assign(replay.state, { status: 'done', message: 'All steps are done.' });
  s.changed();
  assert.deepEqual([last().state, s.run, new Date(s.list[0].next).getDate()], ['done', null, 25]);
});

test('schedule: a changed or deleted workflow does not run, nor does one whose time passed, nor one under a pause or stop', async () => {
  let x = schedules();
  x.s.add({ workflow: 'w1', kind: 'every', minutes: 15 });
  await giveTab();
  x.workflows.saved[0].steps.push({ kind: 'manual', text: 'new' });
  clock += 15 * 60_000;
  x.s.check();
  assert.deepEqual([x.last().state, x.s.list[0].on, replayed.length], ['failed', false, 0]);
  x.s.set('sc1', true);
  x.workflows.saved = [];
  clock += 15 * 60_000;
  x.s.check();
  assert.deepEqual([x.last().state, x.s.list[0].on], ['failed', false]);
  x = schedules();
  x.s.add({ workflow: 'w1', kind: 'daily', time: '08:30' });
  clock += 45 * 60_000;
  x.s.check();
  assert.deepEqual([x.last().state, replayed.length], ['missed', 0]);
  for (const [on, off] of [[() => router.setPaused(true), () => router.setPaused(false)], [() => router.halt(), () => router.resume()]]) {
    x = schedules();
    x.s.add({ workflow: 'w1', kind: 'daily', time: '08:30' });
    on();
    clock += 30 * 60_000;
    x.s.check();
    off();
    x.s.changed();
    assert.deepEqual([x.last().state, replayed.length], ['missed', 0]);
  }
});

test('schedule: cancelled before and during a run, two at the same time, off and deleted, and a restart', async () => {
  let x = schedules();
  let id = 0;
  x.s.uuid = () => `sc${++id}`;
  for (const t of ['08:30', '08:30']) x.s.add({ workflow: 'w1', kind: 'daily', time: t });
  clock += 30 * 60_000;
  x.s.check();
  const [first, second] = x.s.list;
  assert.deepEqual([first.runs[0].state, second.runs[0].state], ['needs you', 'waiting']);
  x.s.cancel('sc2');
  assert.deepEqual([second.runs[0].state, first.runs[0].state], ['cancelled', 'needs you']);
  await giveTab();
  x.s.answer('sc1', { 1: 'a' });
  assert.equal(first.runs[0].state, 'running');
  x.s.cancel('sc1');
  assert.deepEqual([first.runs[0].state, x.replay.state.status, x.s.run], ['cancelled', 'cancelled', null]);
  x.s.set('sc1', false);
  assert.deepEqual([first.on, first.next], [false, null]);
  x.s.remove('sc2');
  assert.deepEqual(x.s.list.map((s) => s.id), ['sc1']);

  x = schedules();
  x.s.add({ workflow: 'w1', kind: 'daily', time: '08:30' });
  clock += 30 * 60_000;
  x.s.check();
  const again = new Schedules({ store, workflows: x.workflows, replay: x.replay, router, now: () => clock + 60 * 60_000, setTimer: () => {} });
  await again.load();
  assert.deepEqual([again.list[0].runs[0].state, again.run], ['interrupted', null]);
});

test('schedule: the real replay asks for every action, also when the run was scheduled, and a revoked tab ends it', async () => {
  const replay = new Replay({ router });
  const x = schedules({ ...structuredClone(W), steps: [{ kind: 'click', role: 'button', name: 'Go', nth: 0, of: 1 }] });
  x.s.replay = replay;
  x.s.workflows = x.workflows;
  const page = router.api.page;
  router.api.page = async (id, m, ...rest) => (m.cmd === 'snapshot' ? { id: 'doc', lines: ['- button "Go" [ref_d_1]'], frames: [], truncated: false, fullChars: 5, ready: 'complete' } : page(id, m, ...rest));
  x.s.add({ workflow: 'w1', kind: 'daily', time: '08:30' });
  router.revoke(() => true);
  await giveTab();
  clock += 30 * 60_000;
  x.s.check();
  const c = await card();
  assert.deepEqual([c.session, c.tool, /Replay of "Report"/.test(c.reason)], ['sidebar', 'left_click', true]);
  router.revoke((g) => g.sessionId === 'sidebar');
  for (let i = 0; i < 100 && replay.state.status === 'running'; i++) await tick();
  x.s.changed();
  assert.deepEqual([x.last().state, /no_grant/.test(x.last().message)], ['needs you', true]);
  assert.ok(!pages.some((m) => m.cmd === 'pointer'));
  x.s.cancel('sc1');
  assert.equal(x.last().state, 'cancelled');
});

test('schedule: no tool can make, change or start one', () => {
  for (const [name, t] of Object.entries(TOOLS)) assert.ok(!/schedul|cron|interval/i.test(name + JSON.stringify(Object.keys(t.input.properties))), name);
});

// Remote link

const DAY = 86_400_000;
const remotes = () => {
  clock = 1_000_000;
  const closed = [];
  const b = serve('remote', (m) => (m.method === 'offer' ? { id: 'ab12cd34', code: 'fcr1.ab12cd34.SECRET' } : {}));
  store = { data: {}, get: async (d) => ({ ...d, ...structuredClone(store.data) }), set: (x) => Object.assign(store.data, structuredClone(x)) };
  const r = new Remote({ store, backends, router, close: (pipe, c) => closed.push([pipe, c]), now: () => clock, setTimer: () => {} });
  return { r, b, closed, sent: (m) => b.seen.filter((x) => x.method === m).map((x) => x.params) };
};
const paired = { event: 'paired', id: 'ab12cd34', fingerprint: 'aaaa-bbbb', device: 'LAPTOP\u202e', address: '10.0.0.5:4444' };

test('remote: off at first; an offer needs gateway and switch; a client waits for the fingerprint; only then is it let in', async () => {
  const { r, b, sent } = remotes();
  await assert.rejects(r.offer({ name: 'Laptop', days: 7 }), { code: 'tool_off' });
  assert.throws(() => r.admit('x', { id: 'ab12cd34' }), { code: 'tool_off' });
  b.on();
  for (const bad of [{ name: '', days: 7 }, { name: 'a', days: 0 }, { name: 'a', days: 91 }, { name: 'a', days: 1.5 }]) await assert.rejects(r.offer(bad), { code: 'invalid_argument' });
  await r.offer({ name: 'Laptop', days: 7 });
  assert.equal(r.code.text, 'fcr1.ab12cd34.SECRET');
  assert.ok(!JSON.stringify(store.data).includes('SECRET'), 'the code is not stored');
  assert.throws(() => r.admit('x', { id: 'ab12cd34' }), { code: 'pairing_ended' });
  r.onEvent(paired);
  assert.deepEqual([r.pairings[0].state, r.code, r.pairings[0].device], ['pending', null, 'LAPTOP']);
  assert.throws(() => r.admit('x', { id: 'ab12cd34' }), { code: 'pairing_ended' });
  assert.throws(() => r.allow('ab12cd34', 'other'), { code: 'not_found' });
  r.allow('ab12cd34', 'aaaa-bbbb');
  assert.equal(r.admit('pipe1', { id: 'ab12cd34', address: '10.0.0.5:5' }).name, 'Laptop');
  assert.deepEqual([r.valid('pipe1'), r.valid('pipe2'), r.view().pairings[0].sessions], [true, false, 1]);
  assert.deepEqual(sent('allow').map((x) => x.id), ['ab12cd34']);
});

test('remote: revoked and expired ones are ended and stay out; a late or second pairing event changes nothing', async () => {
  const { r, b, closed, sent } = remotes();
  b.on();
  await r.offer({ name: 'Laptop', days: 1 });
  r.onEvent(paired);
  r.allow('ab12cd34', 'aaaa-bbbb');
  r.admit('pipe1', { id: 'ab12cd34', address: 'x' });
  r.onEvent({ ...paired, fingerprint: 'evil' });
  assert.deepEqual([r.pairings[0].state, r.pairings[0].fingerprint, sent('revoke').length], ['allowed', 'aaaa-bbbb', 1], 'an event for a pairing that waits for nothing has that key deleted');
  clock += DAY;
  assert.equal(r.valid('pipe1'), false, 'also before the clock of the check');
  r.check();
  assert.deepEqual([r.pairings[0].state, closed], ['expired', [['pipe1', 'pairing_ended']]]);
  assert.throws(() => r.admit('pipe2', { id: 'ab12cd34' }), { code: 'pairing_ended' });
  r.forget('ab12cd34');
  await r.offer({ name: 'Again', days: 1 });
  clock += LIMITS.pairMs + 1;
  r.onEvent(paired);
  assert.equal(r.pairings[0].state, 'offered', 'too late');
  r.check();
  assert.deepEqual([r.pairings[0].state, r.code], ['expired', null]);
  r.forget('ab12cd34');
  await r.offer({ name: 'Third', days: 1 });
  r.onEvent(paired);
  r.allow('ab12cd34', 'aaaa-bbbb');
  r.admit('pipe3', { id: 'ab12cd34', address: 'x' });
  assert.throws(() => r.forget('ab12cd34'), { code: 'conflict' });
  r.revoke('ab12cd34');
  assert.deepEqual([r.valid('pipe3'), closed.at(-1)], [false, ['pipe3', 'pairing_ended']]);
});

test('remote: turned off or with the gateway gone every session ends, an open offer and a waiting client are void; on again only valid keys stay', async () => {
  const { r, b, closed, sent } = remotes();
  b.on();
  await r.offer({ name: 'Laptop', days: 7 });
  r.onEvent(paired);
  r.allow('ab12cd34', 'aaaa-bbbb');
  r.admit('pipe1', { id: 'ab12cd34', address: 'x' });
  r.pairings.push({ id: 'ffff0000', name: 'Waits', state: 'pending', expires: clock + DAY });
  backends.set('remote', false);
  router.switches.remote = false;
  r.onEvent({ type: 'off' });
  assert.deepEqual([closed, r.pairings.map((p) => p.state), r.valid('pipe1')], [[['pipe1', 'pairing_ended']], ['allowed', 'revoked'], false]);
  b.on();
  r.onEvent({ type: 'on' });
  await tick();
  assert.deepEqual(sent('sync').at(-1).clients.map((c) => c.id), ['ab12cd34']);
  store.data.pairings[0].state = 'offered';
  const again = new Remote({ store, backends, router, close: () => {}, now: () => clock, setTimer: () => {} });
  await again.load();
  assert.deepEqual(again.pairings.map((p) => p.state), ['revoked'], 'an offer ends with Firefox');
});

test('remote: its session is marked, gets no private tab, and meets every other rule', async () => {
  router.openSession('r1', 'remote', 'Laptop: claude-code');
  assert.match(router.sessions.get('r1').label, /^Remote Laptop: claude-code/);
  assert.equal(await code(call('read_page', { tabId: 2 }, 'r1')), 'no_grant');
  tabs.push({ id: 3, windowId: 2, url: `${A}/p`, title: 'P', incognito: true, status: 'complete' });
  await assert.rejects(router.grant({ sessionId: 'r1', tabId: 3, origin: A, level: 'read', private: true }), { code: 'not_allowed' });
  await router.grant({ sessionId: 'r1', tabId: 2, origin: B, level: 'read' });
  router.rememberLost();
  assert.ok(router.lost.some((l) => l.kind === 'remote'));
  await assert.rejects(router.regrant(router.lost.find((l) => l.kind === 'remote').id, 's1'), { code: 'not_found' }, 'a local client gets no grants of a remote one');
});
