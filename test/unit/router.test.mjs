// Mocked browser: the rules of the command path, and races that a real browser does not produce on demand.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { Approvals } from '../../dist/extension/grants/approvals.mjs';
import { Grants } from '../../dist/extension/grants/grants.mjs';
import { Router } from '../../dist/extension/background/router.mjs';
import { TOOLS } from '../../dist/extension/shared/protocol.mjs';

const A = 'https://a.example';
const B = 'https://b.example';
const tick = () => new Promise((r) => setTimeout(r, 5));
let tabs, pages, hosts, allUrls, capture, grants, approvals, log, router, n, fillReply, opened, ended;

beforeEach(async () => {
  fillReply = { changed: true };
  opened = [];
  ended = [];
  tabs = [{ id: 1, windowId: 1, active: true, url: `${A}/x?token=1`, title: 'A\npage', status: 'complete' }, { id: 2, windowId: 1, active: false, url: `${B}/`, title: 'B', status: 'complete' }];
  pages = [];
  hosts = new Set([A, B]);
  allUrls = false;
  capture = async () => 'data:image/jpeg;base64,AAAA';
  grants = new Grants();
  approvals = new Approvals();
  log = [];
  n = 0;
  const reply = {
    snapshot: { outline: '- button "SECRET-PAGE-TEXT"', truncated: false, fullChars: 10 },
    find: { found: false },
    describe: { description: 'button "Go"', link: null, download: false, fingerprint: 'f' },
    click: {},
    after_click: { changed: true },
    cover: {},
    uncover: {},
  };
  router = new Router({
    grants,
    approvals,
    log: (l) => log.push(l),
    onGrantEnd: (g) => ended.push(g.tabId),
    api: {
      getTab: async (id) => tabs.find((t) => t.id === id) ?? Promise.reject(new Error('no tab')),
      queryTabs: async () => tabs,
      createTab: async () => (tabs.push({ id: 9, windowId: 1, active: false, url: 'about:blank', title: '' }), tabs.at(-1)),
      hasHost: async (o) => hosts.has(o),
      hasAllUrls: async () => allUrls,
      page: async (id, m) => (pages.push(m), { id: 'doc', ...reply[m.cmd], ...(m.cmd === 'fill' && fillReply) }),
      openUrl: async (id, url) => opened.push(url),
      forget: () => {},
      captureTab: () => capture(),
      captureVisible: () => capture(),
    },
  });
  router.openSession('s1', 'mcp', 'one');
  router.openSession('s2', 'mcp', 'two');
  await router.grant({ sessionId: 's1', tabId: 1, origin: A, level: 'act' });
});

const call = (tool, args = {}, session = 's1') => router.call(session, ++n, tool, args);
const code = async (p) => (await p).error?.code ?? 'ok';
const sample = { read_page: {}, wait_for: { text: 'x', timeout_s: 0.1 }, computer: { action: 'screenshot' }, form_input: { ref: 'r', value: 'v' }, navigate: { url: `${A}/y` }, gif_creator: { action: 'start' } };
const click = (session) => call('computer', { action: 'left_click', tabId: 1, ref: 'r' }, session);
const card = async () => {
  for (let i = 0; i < 50 && !approvals.cards.length; i++) await tick();
  const c = approvals.cards[0];
  assert.ok(c, 'a card is open');
  return c;
};
const allow = async (yes = true) => {
  const c = await card();
  approvals.shown(c.id);
  await new Promise((r) => setTimeout(r, 520));
  assert.equal(approvals.answer(c.id, yes), true);
};

test('every tool that takes a tab is refused without a grant, and no page gets a message', async () => {
  const withTab = Object.keys(TOOLS).filter((t) => TOOLS[t].input.properties.tabId && !TOOLS[t].user);
  assert.deepEqual(withTab.sort(), Object.keys(sample).sort(), 'a new tool needs a sample here');
  for (const t of withTab) {
    assert.equal(await code(call(t, { tabId: 2, ...sample[t] })), 'no_grant', t);
    assert.equal(await code(call(t, { tabId: 1, ...sample[t] }, 's2')), 'no_grant', `${t} with the grant of another session`);
    assert.equal(await code(call(t, { tabId: 77, ...sample[t] })), 'no_grant', `${t} on a tab that does not exist`);
  }
  assert.deepEqual(pages, []);
});

test('every tool has a level for every action', () => {
  for (const [name, t] of Object.entries(TOOLS)) {
    if (t.actions) assert.deepEqual(Object.keys(t.actions), t.input.properties.action.enum, name);
    for (const s of t.actions ? Object.values(t.actions) : [t]) assert.ok(['none', 'read', 'act'].includes(s.level), name);
  }
});

test('the first code wins: unknown tool, arguments, session, pause, grant, suspended, level, permission', async () => {
  assert.equal(await code(call('nope')), 'unknown_tool');
  assert.equal(await code(call('read_page', { tabId: 1, confirm: true })), 'invalid_argument');
  assert.equal(await code(call('read_page', { tabId: 1 }, 'gone')), 'session_ended');
  await router.grant({ sessionId: 's1', tabId: 1, origin: A, level: 'read' });
  hosts.clear();
  assert.equal(await code(click()), 'read_only_grant');
  assert.equal(await code(call('read_page', { tabId: 1 })), 'permission_required');
  hosts.add(A).add(B);
  assert.equal(await code(call('read_page', { tabId: 1 })), 'permission_required', 'the user has to approve again');
  tabs[0].url = `${B}/`;
  await router.approveOrigin(grants.all[0].id, B);
  tabs[0].url = 'https://c.example/';
  assert.equal(await code(click()), 'grant_suspended', 'the origin goes before the level');
  router.setPaused(true);
  assert.equal(await code(call('read_page', { tabId: 1 })), 'paused');
  assert.equal(await code(call('tabs_context')), 'paused');
  assert.equal((await call('connection_status')).result.state, 'paused');
});

test('a grant needs the tab, the exact origin and the Firefox permission', async () => {
  for (const [g, c] of [[{ tabId: 5, origin: A }, 'origin_changed'], [{ tabId: 1, origin: B }, 'origin_changed'], [{ tabId: 1, origin: null }, 'origin_changed'], [{ tabId: 1, origin: A, level: 'admin' }, 'invalid_argument'], [{ tabId: 1, origin: A, sessionId: 'x' }, 'invalid_argument']]) {
    await assert.rejects(router.grant({ sessionId: 's2', level: 'read', ...g }), { code: c });
  }
  hosts.clear();
  await assert.rejects(router.grant({ sessionId: 's2', tabId: 1, origin: A, level: 'read' }), { code: 'permission_required' });
  assert.equal(grants.of('s2').length, 0);
});

test('tabs_context: title and address only of granted tabs on the approved origin, no query', async () => {
  let r = (await call('tabs_context')).result;
  assert.deepEqual(r.tabs.map((t) => [t.tabId, t.title, t.url]), [[1, 'A page', `${A}/x?…`]]);
  assert.equal(r.otherTabs, 1);
  tabs[0].url = `${B}/private`;
  r = (await call('tabs_context')).result;
  assert.ok(!JSON.stringify(r).includes('private') && !JSON.stringify(r).includes(B));
  r = (await call('tabs_context', { createIfEmpty: true }, 's2')).result;
  assert.deepEqual(r.tabs.map((t) => [t.tabId, t.owned, t.state]), [[9, true, 'no_grant']]);
  assert.deepEqual((await call('tabs_context')).result.tabs.map((t) => t.tabId), [1]);
});

test('the answer of a page that arrives after a revoke is not returned', async () => {
  const gate = Promise.withResolvers();
  router.api.page = () => gate.promise;
  const p = call('read_page', { tabId: 1 });
  await tick();
  router.revoke(() => true);
  gate.resolve({ id: 'doc', outline: 'SECRET' });
  const r = await p;
  assert.equal(r.error.code, 'no_grant');
  assert.ok(!JSON.stringify(r).includes('SECRET'));
});

test('a picture is thrown away when the tab, the document or the origin changed during the capture', async () => {
  const shot = () => call('computer', { action: 'screenshot', tabId: 1 });
  assert.equal((await shot()).result.image, 'AAAA');
  capture = async () => ((tabs[0].active = false), 'data:image/jpeg;base64,AAAA');
  assert.equal(await code(shot()), 'origin_changed');
  tabs[0].active = true;
  let i = 0;
  const page = router.api.page;
  capture = async () => 'data:image/jpeg;base64,AAAA';
  router.api.page = async (...a) => ({ ...(await page(...a)), id: `doc${i++}` });
  assert.equal(await code(shot()), 'origin_changed');
  router.api.page = page;
  capture = async () => ((tabs[0].url = `${B}/`), 'data:image/jpeg;base64,AAAA');
  assert.equal(await code(shot()), 'grant_suspended');
});

test('a message to the page is dropped when the call ended while the script went in', async () => {
  let wanted;
  router.api.page = async (id, m, w) => {
    wanted = w;
    await tick();
    return { id: 'doc', outline: '' };
  };
  const p = call('read_page', { tabId: 1 });
  await Promise.resolve();
  await tick();
  router.revoke(() => true);
  assert.equal(await code(p), 'no_grant');
  assert.equal(wanted(), false);
});

test('covers are removed when the capture fails', async () => {
  capture = async () => Promise.reject(new Error('Missing activeTab permission'));
  assert.equal(await code(call('computer', { action: 'screenshot', tabId: 1 })), 'permission_required');
  assert.deepEqual(pages.map((m) => m.cmd), ['cover', 'uncover']);
  tabs[0].active = false;
  assert.equal(await code(call('computer', { action: 'screenshot', tabId: 1 })), 'permission_required', 'a background tab without <all_urls>');
});

test('a click runs only after the answer, and everything is checked again in between', async () => {
  const sent = () => pages.filter((m) => m.cmd === 'click').length;
  let p = click();
  assert.equal((await card()).sessionLabel, 'Client one (s1)');
  assert.equal(sent(), 0);
  await allow();
  assert.equal((await p).result.clicked, 'button "Go"');
  assert.equal(sent(), 1);

  const between = {
    approval_denied: () => allow(false),
    no_grant: async () => router.revoke(() => true),
    paused: async () => router.setPaused(true),
    cancelled: async () => router.cancel('s1', n),
    session_ended: async () => router.endSession('s1'),
    grant_suspended: async () => router.tabMoved(1, `${B}/`),
  };
  for (const [want, act] of Object.entries(between)) {
    router.setPaused(false);
    if (!router.sessions.has('s1')) router.openSession('s1', 'mcp', 'one');
    await router.grant({ sessionId: 's1', tabId: 1, origin: A, level: 'act' });
    p = click();
    await card();
    await act();
    assert.equal(await code(p), want);
    assert.equal(approvals.cards.length, 0, `${want} closes the card`);
  }
  assert.equal(sent(), 1);
});

test('after the answer a lowered level, a moved tab or a lost permission still stops the click', async () => {
  for (const [want, act] of [
    ['read_only_grant', () => (grants.find('s1', 1).level = 'read')],
    ['grant_suspended', () => (tabs[0].url = `${B}/`)],
    ['permission_required', () => hosts.delete(A)],
  ]) {
    tabs[0].url = `${A}/`;
    hosts.add(A);
    await router.grant({ sessionId: 's1', tabId: 1, origin: A, level: 'act' });
    const p = click();
    const c = await card();
    approvals.shown(c.id);
    await new Promise((r) => setTimeout(r, 520));
    act();
    approvals.answer(c.id, true);
    assert.equal(await code(p), want);
  }
  assert.equal(pages.filter((m) => m.cmd === 'click').length, 0);
});

test('a click that the page refused is not reported as sent, one that got lost is', async () => {
  const page = router.api.page;
  router.api.page = async (id, m) => (m.cmd === 'click' ? { error: 'covered', message: 'Covered.' } : page(id, m));
  let p = click();
  await allow();
  assert.equal((await p).error.message, 'Covered.');
  router.api.page = async (id, m) => (m.cmd === 'click' ? null : page(id, m));
  p = click();
  await allow();
  assert.match((await p).error.message, /may have reached the page/);
});

test('an entry and a navigation ask with their value, and run only after the answer', async () => {
  let p = call('form_input', { tabId: 1, ref: 'r', value: 'typed text' });
  assert.deepEqual([(await card()).tool, (await card()).value], ['form_input', 'typed text']);
  assert.ok(!pages.some((m) => m.cmd === 'fill'));
  await allow(false);
  assert.equal(await code(p), 'approval_denied');
  assert.ok(!pages.some((m) => m.cmd === 'fill'));
  p = call('form_input', { tabId: 1, ref: 'r', value: 'typed text' });
  await allow();
  assert.deepEqual((await p).result, { field: 'button "Go"', set: true, changed: true });
  assert.ok(!JSON.stringify(log).includes('typed text'));

  p = call('navigate', { tabId: 1, url: `${B}/p?q=1` });
  assert.deepEqual([(await card()).target, (await card()).value], [`${B}/p?q=1`, `Leaves ${A} for ${B}`]);
  assert.deepEqual(opened, []);
  await allow(false);
  assert.equal(await code(p), 'approval_denied');
  for (const url of ['javascript:alert(1)', 'file:///c:/x', 'https://u:p@a.example/', 'about:config', 'x']) assert.equal(await code(call('navigate', { tabId: 1, url })), 'invalid_argument', url);
  assert.deepEqual(opened, []);
});

test('a navigation to another origin suspends the grant, also when it was approved', async () => {
  const p = call('navigate', { tabId: 1, url: `${B}/` });
  await allow();
  for (let i = 0; i < 100 && !opened.length; i++) await tick();
  tabs[0].url = `${B}/`;
  router.tabMoved(1, `${B}/`);
  assert.equal(await code(p), 'grant_suspended');
  assert.equal(await code(call('read_page', { tabId: 1 })), 'grant_suspended');
  assert.deepEqual(ended, [1]);
});

test('a stop ends the calls of one session and says what the page may have', async () => {
  // a card that waits: nothing was sent
  let p = click();
  await card();
  assert.deepEqual(router.stopCalls('s1'), [{ tool: 'computer', sent: null }]);
  assert.equal(await code(p), 'stopped');
  assert.equal(approvals.cards.length, 0);
  assert.deepEqual(router.sessions.get('s1').acted, []);
  // a click that the page has
  p = click();
  await allow();
  for (let i = 0; i < 100 && !pages.some((m) => m.cmd === 'click'); i++) await tick();
  assert.deepEqual(router.stopCalls('s1'), [{ tool: 'computer', sent: 'click on button "Go"' }]);
  assert.match((await p).error.message, /may have reached/);
  assert.deepEqual(router.sessions.get('s1').acted.map((a) => a.outcome), ['unknown']);
  // a click that ended, and one that the page refused
  p = click();
  await allow();
  await p;
  assert.deepEqual(router.sessions.get('s1').acted.map((a) => a.outcome), ['unknown', 'done']);
  fillReply = { error: 'secret_field', message: 'no' };
  p = call('form_input', { tabId: 1, ref: 'r', value: 'x' });
  await allow();
  assert.equal(await code(p), 'secret_field');
  assert.equal(router.sessions.get('s1').acted.length, 2);
  assert.deepEqual(router.stopCalls('s2'), []);
});

test('a tool for the user is unknown to clients and waives no check for the user', async () => {
  assert.equal(await code(call('get_selection', { tabId: 1 })), 'unknown_tool');
  assert.equal(await code(router.call('s1', 'u1', 'get_selection', { tabId: 2 }, { user: true })), 'no_grant');
  assert.equal(await code(router.call('s1', 'u2', 'get_selection', { tabId: 1 }, { user: true })), 'ok');
  router.setPaused(true);
  assert.equal(await code(router.call('s1', 'u3', 'get_selection', { tabId: 1 }, { user: true })), 'paused');
  assert.deepEqual(ended, [1], 'a pause ends recordings');
});

test('at most ten cards of one session wait, and another session still gets one', async () => {
  const many = Array.from({ length: 11 }, () => click());
  assert.equal(await code(Promise.race(many)), 'rate_limited');
  await router.grant({ sessionId: 's2', tabId: 1, origin: A, level: 'act' });
  click('s2');
  await tick();
  assert.equal(approvals.cards.filter((c) => c.session === 's2').length, 1);
  router.revoke(() => true);
});

test('a new tab belongs to a session only during its click, and starts with the approved origin only', async () => {
  const tab = { id: 3, windowId: 1, active: true, url: 'about:blank', title: '', openerTabId: 1 };
  tabs.push(tab);
  router.tabOpened(tab);
  assert.equal(grants.find('s1', 3), null, 'a tab the user opened');
  const page = router.api.page;
  router.api.page = async (id, m) => {
    if (m.cmd === 'click') {
      router.tabOpened({ ...tab, id: 2, openerTabId: 2 });
      router.tabOpened(tab);
    }
    return page(id, m);
  };
  const p = click();
  await allow();
  assert.equal((await p).result.opened_tab, 3);
  assert.equal(grants.find('s1', 2), null, 'a tab with another opener');
  assert.equal(grants.find('s1', 3).state, 'pending');
  assert.equal(await code(call('read_page', { tabId: 3 })), 'grant_suspended');
  assert.equal(grants.find('s1', 3).state, 'pending', 'a blank tab is not suspended for good');
  tab.url = `${A}/new`;
  assert.equal(await code(call('read_page', { tabId: 3 })), 'ok');
  grants.add({ sessionId: 's1', tabId: 3, origin: A, level: 'act', state: 'pending' });
  tab.url = `${B}/`;
  assert.equal(await code(call('read_page', { tabId: 3 })), 'grant_suspended');
  assert.equal(grants.find('s1', 3).state, 'suspended');
});

test('a suspended grant stays suspended until the user approves, and an approved origin is added for that tab only', async () => {
  router.tabMoved(1, `${B}/`);
  router.tabMoved(1, `${A}/`);
  assert.equal(await code(call('read_page', { tabId: 1 })), 'grant_suspended');
  const g = grants.find('s1', 1);
  await assert.rejects(router.approveOrigin(g.id, B), { code: 'origin_changed' });
  await router.approveOrigin(g.id, A);
  assert.equal(await code(call('read_page', { tabId: 1 })), 'ok');
  await assert.rejects(router.approveOrigin('g99', A), { code: 'origin_changed' });
});

test('a tab that closes ends its grants; a session that ends takes only its own', async () => {
  await router.grant({ sessionId: 's2', tabId: 1, origin: A, level: 'read' });
  router.endSession('s1');
  assert.deepEqual(grants.all.map((g) => g.sessionId), ['s2']);
  router.tabClosed(1);
  assert.deepEqual(grants.all, []);
});

test('a client cannot pass for the sidebar, and its name is one plain line', () => {
  router.openSession('abcdef', 'mcp', 'This sidebar\n‮grant');
  assert.equal(router.sessions.get('abcdef').label, 'Client This sidebar grant (abcd)');
});

test('the log has one line per call, refusals too, and no text of pages or arguments', async () => {
  log.length = 0;
  await call('read_page', { tabId: 1 });
  await call('wait_for', { tabId: 1, text: 'MARKER-ARG', timeout_s: 0.1 });
  await call('read_page', { tabId: 2 });
  await call('MARKER\nfake line', {});
  assert.deepEqual(log.map((l) => [l.tool, l.decision, l.origin]), [['read_page', 'ok', A], ['wait_for', 'ok', A], ['read_page', 'no_grant', null], ['MARKER fake line', 'unknown_tool', null]]);
  assert.ok(!JSON.stringify(log).includes('SECRET-PAGE-TEXT') && !JSON.stringify(log).includes('MARKER-ARG') && !JSON.stringify(log).includes('token'));
});
