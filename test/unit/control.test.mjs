// Mocked browser with frames, windows and a helper. Real: Router, tools, Grants, Approvals. Simulated evidence only.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { Router, frameOfRef } from '../../dist/extension/background/router.mjs';
import { Approvals } from '../../dist/extension/grants/approvals.mjs';
import { Grants } from '../../dist/extension/grants/grants.mjs';
import { addRule, noRules, ruleFor } from '../../dist/extension/grants/rules.mjs';

const A = 'https://a.example';
const B = 'https://b.example';
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
let tabs, frames, pages, sent, router, grants, approvals, hosts, files, n, browser, docs, calls, made;

beforeEach(async () => {
  tabs = [
    { id: 1, windowId: 1, active: true, url: `${A}/x`, title: 'A', status: 'complete' },
    { id: 2, windowId: 1, active: false, url: `${B}/`, title: 'B', status: 'complete' },
    { id: 3, windowId: 2, active: true, url: `${A}/secret`, title: 'Private', status: 'complete', incognito: true },
  ];
  frames = { 0: { origin: A, children: [5, 6] }, 5: { origin: A, children: [] }, 6: { origin: B, children: [] } };
  docs = 'doc1';
  [pages, sent, calls] = [[], [], []];
  n = 0;
  made = 20;
  hosts = new Set([A, B]);
  files = [{ path: 'C:\\ok\\a.txt', name: 'a.txt', size: 3, stamp: 's' }];
  grants = new Grants();
  approvals = new Approvals();
  const inWindow = (id) => tabs.filter((t) => t.windowId === id);
  browser = {
    permissions: { contains: async () => true },
    windows: { getLastFocused: async () => ({ id: 1, focused: true }), get: async (id) => ({ id, focused: true, tabs: inWindow(id) }), getAll: async () => [1, 2].map((id) => ({ id, incognito: id === 2, state: 'normal', tabs: inWindow(id) })), update: async (...a) => calls.push(['window', ...a]), create: async () => (tabs.push({ id: 30, windowId: 9, url: 'about:blank', status: 'complete' }), { id: 9, tabs: [tabs.at(-1)] }), remove: async (id) => calls.push(['close window', id]) },
    tabs: { create: async (o) => (tabs.push({ id: made++, windowId: 1, title: 'new', status: 'complete', ...o }), calls.push(['create', o.url, o.active]), tabs.at(-1)), remove: async (id) => (tabs = tabs.filter((t) => t.id !== id)), group: async () => 7, ungroup: async () => {} },
    bookmarks: { search: async () => [{ id: 'b', title: 'T', url: `${A}/p?token=1` }, { id: 'c', title: 'J', url: 'javascript:1' }] },
    history: { search: async () => [{ title: 'H', url: `${A}/h?q=secret`, lastVisitTime: 0 }] },
  };
  router = new Router({
    grants,
    approvals,
    log: () => {},
    api: {
      browser,
      getTab: async (id) => tabs.find((t) => t.id === id) ?? Promise.reject(new Error('gone')),
      queryTabs: async () => tabs,
      createTab: async () => browser.tabs.create({ active: false, url: 'about:blank' }),
      hasHost: async (o) => hosts.has(o),
      hasAllUrls: async () => true,
      forget: () => {},
      abort: (tabId, frame) => calls.push(['abort', tabId, frame]),
      windowState: async () => tabs[0].windowState ?? 'normal',
      captureTab: async () => 'data:image/jpeg;base64,AAAA',
      annotate: async (dataUrl) => ({ dataUrl, width: 50, height: 50 }),
      host: async (type, data) => (calls.push([type, data]), type === 'file_stat' ? (files.code ? files : { files }) : { data: btoa('abc') }),
      page: async (id, m, wanted, frame) => {
        const f = frames[frame];
        if (!f) return { error: 'restricted_page', message: 'no' };
        if (m.cmd === 'where') return { origin: f.origin, id: `${docs}/${frame}` };
        if (m.origin !== f.origin) return { error: 'origin_changed', message: 'other' };
        pages.push([m.cmd, frame]);
        if (['pointer', 'fill', 'upload', 'type', 'key', 'hover'].includes(m.cmd)) sent.push([m.cmd, frame, m.ref]);
        if (m.cmd === 'describe' && m.ref === 'ref_old') return { error: 'stale_ref', message: 'gone.' };
        return { id: `${docs}/${frame}`, ...{
          snapshot: { lines: frame ? [`- button "In frame ${frame}" [ref_f${frame}_d_1]`] : ['- button "Go" [ref_d_1]', '- frame'], frames: frame ? [] : [{ line: 2, frame: 5, depth: 1 }, { line: 2, frame: 6, depth: 1 }], truncated: false, fullChars: 10, ready: 'complete' },
          children: { children: f.children.map((c) => ({ frame: c, src: frames[c].origin, name: '', left: 10, top: 20 })) },
          search: { total: 1, hits: [{ ref: `ref_${frame ? `f${frame}_` : ''}d_1`, role: 'button', name: 'Go', score: frame }] },
          find_text: { count: 2, snippets: ['s'] },
          marks: { marks: [{ ref: `ref_${frame}`, role: 'button', name: 'x', left: 1, top: 1, width: 5, height: 5 }] },
          place: { width: 100, height: 100, scroll: [0, 0, 1] },
          hit: frame ? { ref: 'ref_f5_d_1' } : m.x > 50 ? { frame: 6, x: 1, y: 1 } : { frame: 5, x: 1, y: 1 },
          describe: { description: 'button "Go"', fingerprint: 'f' },
          upload_target: { description: 'button "File"', fingerprint: 'f', input: true, multiple: false, folder: false },
          type: { arrived: 2 }, key: { defaults: 0 }, upload: { set: 1, how: 'input' },
          after: { changed: false, dialogs: [{ kind: 'confirm', text: 'Sure?', answer: 'cancelled' }] },
        }[m.cmd] };
      },
    },
  });
  for (const [id, kind, name] of [['s1', 'mcp', 'one'], ['s2', 'mcp', 'two'], ['sidebar', 'sidebar', 'This sidebar']]) router.openSession(id, kind, name);
  await router.grant({ sessionId: 's1', tabId: 1, origin: A, level: 'act' });
});

const call = (tool, args = {}, s = 's1') => router.call(s, ++n, tool, args);
const code = async (p) => (await p).error?.code ?? 'ok';
const card = async () => {
  for (let i = 0; i < 200 && !approvals.cards.length; i++) await tick();
  assert.ok(approvals.cards[0], 'a card is open');
  return approvals.cards[0];
};
const answer = async (yes) => {
  const c = await card();
  approvals.shown(c.id);
  await tick(510);
  approvals.answer(c.id, yes);
  return c;
};
const click = (ref = 'ref_d_1') => call('computer', { action: 'left_click', tabId: 1, ref });
const dispatched = async () => {
  while (!sent.length) await tick(1);
};

test('frames: same origin is read, another origin only after the user allowed its frames, and a ref stays in its frame', async () => {
  let r = (await call('read_page', { tabId: 1 })).result;
  assert.match(r.outline, /frame 5 of https:\/\/a\.example\n.*In frame 5/);
  assert.match(r.outline, /frame 6 not read: The frame belongs to https:\/\/b\.example/);
  assert.ok(!pages.some(([, f]) => f === 6), 'no command reached the other frame');
  assert.deepEqual((await call('list_frames', { tabId: 1 })).result.frames.map((f) => [f.frame, f.origin, f.granted]), [[0, A, true], [5, A, true], [6, B, false]]);
  assert.equal(await code(click('ref_f6_d_1')), 'no_grant');
  assert.deepEqual((await call('find', { tabId: 1, query: 'go' })).result.elements.map((e) => e.frame ?? 0), [5, 0]);
  hosts.delete(B);
  await assert.rejects(router.approveFrames(grants.all[0].id, B), { code: 'permission_required' });
  hosts.add(B);
  await router.approveFrames(grants.all[0].id, B);
  r = (await call('read_page', { tabId: 1 })).result;
  assert.match(r.outline, /In frame 6/);
  const p = click('ref_f6_d_1');
  assert.equal((await answer(true)).frame, B);
  assert.equal(await code(p), 'ok');
  assert.deepEqual(sent, [['pointer', 6, 'ref_f6_d_1']]);
  tabs[0].url = `${B}/`;
  assert.equal(await code(call('read_page', { tabId: 1 })), 'grant_suspended', 'allowed frames say nothing about the tab itself');
});

test('a frame that moved to another origin after the approval gets nothing', async () => {
  await router.approveFrames(grants.all[0].id, B);
  const p = click('ref_f6_d_1');
  await card();
  frames[6].origin = 'https://c.example';
  await answer(true);
  assert.equal(await code(p), 'no_grant');
  assert.deepEqual(sent, []);
});

test('a stale ref names what is there now, and nothing is sent', async () => {
  router.sessions.get('s1').seen.set(1, new Map([['ref_old', { role: 'button', name: 'Go' }]]));
  const e = (await click('ref_old')).error;
  assert.equal(e.code, 'stale_ref');
  assert.match(e.message, /Now there .*button "Go" \[ref_d_1\]/);
  assert.deepEqual(e.candidates, [{ role: 'button', name: 'Go', ref: 'ref_d_1' }]);
  assert.deepEqual(sent, []);
});

test('pictures: marks, points down into a granted frame, refused over another, too old, and a minimized window', async () => {
  const shot = (await call('computer', { action: 'screenshot', tabId: 1, annotate: true })).result;
  assert.deepEqual(shot.marks.map((m) => [m.number, m.ref]), [[1, 'ref_0'], [2, 'ref_5']]);
  const at = (x, y, o = {}) => call('computer', { action: 'left_click', tabId: 1, x, y, image_id: shot.image_id, ...o });
  const p = at(10, 10);
  await answer(true);
  assert.equal(await code(p), 'ok');
  assert.deepEqual(sent, [['pointer', 5, 'ref_f5_d_1']]);
  assert.equal(await code(at(40, 10)), 'no_grant', 'a point over a frame that is not granted');
  assert.equal(await code(at(60, 10)), 'invalid_argument', 'outside the picture');
  assert.equal(await code(at(10, 10, { image_id: 'img_x' })), 'not_found');
  docs = 'doc2';
  assert.equal(await code(at(10, 10)), 'expired');
  tabs[0].windowState = 'minimized';
  assert.equal(await code(call('computer', { action: 'screenshot', tabId: 1 })), 'not_allowed');
});

test('the reply tells dispatch from effect, reports dialogs, and names the optional backends that it does not use', async () => {
  const p = click();
  await answer(true);
  const r = (await p).result;
  assert.deepEqual([r.dispatched, r.trusted_event, r.observed], [true, false, false]);
  assert.match(r.hint, /optional backends.*none is used by itself/);
  assert.deepEqual(r.dialogs, [{ kind: 'confirm', text: 'Sure?', answer: 'cancelled' }]);
  const t = call('computer', { action: 'type', tabId: 1, ref: 'ref_d_1', text: 'héllo' });
  await answer(true);
  const { characters_sent, characters_arrived } = (await t).result;
  assert.deepEqual([characters_sent, characters_arrived], [5, 2]);
  assert.equal(await code(call('computer', { action: 'key', tabId: 1, keys: 'ctrl+w' })), 'not_allowed');
  assert.equal(await code(call('computer', { action: 'key', tabId: 1, keys: 'hyper+x' })), 'invalid_argument');
});

const step = (tool, args, more = {}) => ({ tool, args, ...more });
const clickStep = () => step('computer', { action: 'left_click', tabId: 1, ref: 'ref_d_1' });
const readStep = () => step('find_text', { tabId: 1, text: 'x' });

test('batch: all steps are checked before the first runs, and the first error stops the rest', async () => {
  for (const bad of [step('computer', { action: 'nope', tabId: 1 }), step('browser_batch', { steps: [] }), step('get_selection', { tabId: 1 }), step('select_browser', { profile: 'x' }), step('nope', {})]) {
    assert.equal(await code(call('browser_batch', { steps: [clickStep(), bad] })), 'invalid_argument');
  }
  assert.deepEqual(sent, []);
  const p = call('browser_batch', { steps: [readStep(), clickStep(), step('read_page', { tabId: 2 }), clickStep()] });
  await answer(true);
  const r = (await p).result;
  assert.deepEqual(r.steps.map((s) => s.state), ['done', 'done', 'failed', 'not_run']);
  assert.deepEqual([r.completed, r.stopped_by, r.done], [false, 'no_grant', 2]);
  const q = call('browser_batch', { steps: [clickStep(), clickStep()] });
  await answer(false);
  assert.deepEqual((await q).result.steps.map((s) => s.state), ['failed', 'not_run']);
  assert.equal(sent.length, 1);
});

test('batch: a step that moves the page stops it unless the step said so, and the limit leaves out the time of cards', async () => {
  const orig = router.api.page;
  let count = 0;
  router.api.page = async (...a) => (a[1].cmd === 'where' ? { origin: A, id: `d${count++}` } : orig(...a));
  const nav = (more) => call('browser_batch', { steps: [step('computer', { action: 'wait', tabId: 1, seconds: 0 }, more), step('tabs_context', {})] });
  const r = (await nav()).result;
  assert.deepEqual([r.stopped_by, r.done], ['navigated', 1]);
  assert.equal((await nav({ navigates: true })).result.completed, true);
  router.api.page = orig;
  const t = (await call('browser_batch', { steps: [step('computer', { action: 'wait', tabId: 1, seconds: 3 }), readStep()], timeout_s: 1 })).result;
  assert.deepEqual([t.stopped_by, ...t.steps.map((s) => s.state)], ['timeout', 'failed', 'not_run']);
  const p = call('browser_batch', { steps: [clickStep(), readStep()], timeout_s: 1 });
  await card();
  await tick(1300);
  await answer(true);
  assert.equal((await p).result.completed, true);
});

test('batch: a cancel ends the running step, runs no further one, and reports each', async () => {
  const p = router.call('s1', 'b1', 'browser_batch', { steps: [readStep(), clickStep(), clickStep()] });
  await card();
  router.cancel('s1', 'b1');
  const e = (await p).error;
  assert.equal(e.code, 'cancelled');
  assert.deepEqual(e.steps.map((s) => s.state), ['done', 'cancelled', 'not_run']);
  await tick(50);
  assert.equal(approvals.cards.length, 0);
  assert.deepEqual(sent, []);
  const q = router.call('s1', 'b2', 'browser_batch', { steps: [clickStep(), clickStep()] });
  await answer(true);
  await dispatched();
  router.cancel('s1', 'b2');
  assert.equal((await q).error.steps[0].may_have_taken_effect, 'click on button "Go"');
  await tick(400);
  assert.equal(sent.length, 1);
});

test('emergency stop: refuses new work, ends queued work before it begins, and reports what may have happened', async () => {
  const first = click();
  await answer(true);
  await dispatched();
  const queued = click();
  await tick(20);
  assert.deepEqual(router.activity.map((a) => a.state), ['running', 'queued']);
  const report = router.halt();
  assert.deepEqual(report.calls.map((c) => [c.state, c.may_have_taken_effect]), [['running', 'click on button "Go"'], ['queued', null]]);
  assert.equal(await code(queued), 'stopped');
  assert.match((await first).error.message, /may have reached the page/);
  assert.ok(calls.some((c) => c[0] === 'abort'));
  for (const [t, a] of [['tabs_context', {}], ['read_page', { tabId: 1 }], ['tabs_create', {}], ['browser_batch', { steps: [step('tabs_context', {})] }]]) assert.equal(await code(call(t, a)), 'stopped', t);
  assert.equal((await call('connection_status')).result.state, 'stopped');
  await tick(400);
  assert.equal(sent.length, 1);
  router.resume();
  assert.equal(await code(call('read_page', { tabId: 1 })), 'ok');
});

test('take over: the calls of that tab end and new ones are refused until the user gives it back', async () => {
  const p = click();
  await card();
  assert.deepEqual(router.stopTab(1).map((c) => c.may_have_taken_effect), [null]);
  assert.equal(await code(p), 'stopped');
  for (const [t, a] of [['read_page', { tabId: 1 }], ['tabs_close', { tabId: 1 }]]) assert.equal(await code(call(t, a)), 'stopped', t);
  assert.equal((await call('tabs_context')).result.tabs[0].state, 'stopped');
  router.resumeTab(1);
  assert.equal(await code(call('read_page', { tabId: 1 })), 'ok');
});

test('request_user: actions on the tab wait, reading goes on, Done is no approval', async () => {
  const p = call('request_user', { tabId: 1, message: 'Sign in' });
  await card();
  assert.equal(await code(click()), 'paused');
  assert.equal(await code(call('read_page', { tabId: 1 })), 'ok');
  await answer(true);
  assert.equal((await p).result.answer, 'done');
  const q = click();
  await answer(false);
  assert.equal(await code(q), 'approval_denied');
  const x = call('request_user', { tabId: 1, message: 'x' });
  await answer(false);
  assert.equal((await x).result.answer, 'cancelled');
});

test('one agent session per tab: the other gets conflict, the user may move it, the sidebar itself is no agent', async () => {
  assert.equal(await code(call('read_page', { tabId: 1 }, 's2')), 'conflict');
  assert.equal(await code(call('tabs_close', { tabId: 1 }, 's2')), 'conflict');
  await assert.rejects(router.grant({ sessionId: 's2', tabId: 1, origin: A, level: 'read' }), { code: 'conflict' });
  await router.grant({ sessionId: 'sidebar', tabId: 1, origin: A, level: 'read' });
  const p = click();
  await card();
  await router.grant({ sessionId: 's2', tabId: 1, origin: A, level: 'read', move: true });
  assert.equal(await code(p), 'no_grant');
  assert.equal(await code(call('read_page', { tabId: 1 }, 's2')), 'ok');
  assert.equal(await code(call('read_page', { tabId: 1 })), 'conflict');
});

test('a private tab needs a grant of its own, for a client only, and is in no list, count or log without it', async () => {
  const lines = [];
  router.log = (l) => lines.push(l);
  assert.equal((await call('tabs_context')).result.otherTabs, 1);
  assert.equal(await code(call('read_page', { tabId: 3 })), 'no_grant');
  await assert.rejects(router.grant({ sessionId: 's1', tabId: 3, origin: A, level: 'read' }), { code: 'not_allowed' });
  router.openSession('c1', 'chat', 'Chat: x');
  for (const s of ['c1', 'sidebar']) await assert.rejects(router.grant({ sessionId: s, tabId: 3, origin: A, level: 'read', private: true }), { code: 'not_allowed' });
  assert.deepEqual((await call('windows_list')).result.windows.map((w) => w.windowId), [1]);
  assert.equal((await call('windows_list')).result.otherWindows, 0);
  lines.length = 0;
  await router.grant({ sessionId: 's1', tabId: 3, origin: A, level: 'read', private: true });
  assert.equal(await code(call('read_page', { tabId: 3 })), 'ok');
  const listed = (await call('tabs_context')).result;
  assert.deepEqual([listed.tabs.find((t) => t.tabId === 3).private, listed.otherTabs], [true, 1]);
  assert.equal(await code(call('gif_creator', { action: 'start', tabId: 3 })), 'not_allowed');
  assert.ok(lines.length >= 3 && lines.every((l) => l.origin === null), 'no origin of a private tab in the log');
  router.rememberLost();
  assert.deepEqual(router.lost[0].grants.map((g) => g.tabId), [1]);
  router.tabClosed(3);
  assert.deepEqual((await call('closed_tabs', { action: 'list' })).result.tabs, []);
});

test('a tab request is answered by the user only, once, and to the session that asked', async () => {
  const { request_id } = (await call('tab_request', { reason: 'need it', level: 'read' }, 's2')).result;
  assert.equal(await code(call('tab_request', { reason: 'again', level: 'read' }, 's2')), 'rate_limited');
  assert.equal((await call('tab_request_result', { request_id }, 's2')).result.state, 'pending');
  assert.equal(await code(call('tab_request_result', { request_id }, 's1')), 'unknown_request');
  const wait = call('tab_request_result', { request_id, wait_s: 5 }, 's2');
  await router.answerRequest(request_id, { tabId: 2, origin: B, level: 'read' });
  assert.deepEqual((await wait).result, { state: 'granted', tabId: 2 });
  assert.equal(await code(call('tab_request_result', { request_id }, 's2')), 'unknown_request');
  await assert.rejects(router.answerRequest(request_id, {}), { code: 'not_found' });
});

test('after a lost link one click of the user gives the same tabs to a new session of the same client', async () => {
  await router.approveFrames(grants.all[0].id, B);
  await router.grant({ sessionId: 's1', tabId: 2, origin: B, level: 'read' });
  router.rememberLost();
  router.endSession('s1');
  assert.deepEqual(grants.all, []);
  router.openSession('s9', 'mcp', 'another');
  await assert.rejects(router.regrant('s1', 's9'), { code: 'not_found' });
  router.openSession('s8', 'mcp', 'one');
  tabs[1].url = 'https://c.example/';
  assert.deepEqual(await router.regrant('s1', 's8'), { given: [1], left_out: 1 });
  assert.deepEqual(grants.all.map((g) => [g.sessionId, g.tabId, g.level, g.frames]), [['s8', 1, 'act', [B]]]);
  await assert.rejects(router.regrant('s1', 's8'), { code: 'not_found' }, 'once');
});

test('tabs: opens in the background, asks for a new origin, closes its own without and the tab of the user with a card', async () => {
  let p = call('tabs_create', { url: `${B}/new` });
  await answer(false);
  assert.equal(await code(p), 'approval_denied');
  assert.ok(!calls.some((c) => c[0] === 'create'));
  p = await call('tabs_create', { url: `${A}/covered` });
  assert.equal(p.result.state, 'loaded');
  assert.deepEqual(calls.find((c) => c[0] === 'create'), ['create', `${A}/covered`, false]);
  const own = p.result.tabId;
  assert.equal(grants.find('s1', own).level, 'act');
  for (const url of ['file:///C:/x', 'javascript:1', 'about:config', 'https://u:p@a.example']) assert.equal(await code(call('tabs_create', { url })), 'invalid_argument', url);
  assert.equal(await code(call('tabs_close', { tabId: own })), 'ok');
  assert.equal(await code(call('tabs_close', { tabId: 2 })), 'no_grant');
  p = call('tabs_close', { tabId: 1 });
  await answer(false);
  assert.equal(await code(p), 'approval_denied');
  for (const [t, a] of [['tabs_group', { tabIds: [1, 2] }], ['tabs_ungroup', { tabIds: [2] }], ['windows_close', { windowId: 2 }]]) assert.equal(await code(call(t, a)), 'no_grant', t);
  assert.equal(await code(call('windows_close', { windowId: 1 })), 'not_allowed', 'a window with other tabs');
  assert.equal((await call('windows_create', {})).result.windowId, 9);
  assert.deepEqual(calls.filter((c) => c[0] === 'window'), [['window', 1, { focused: true }]], 'the focus goes back');
  for (let i = 0; i < 20; i++) router.sessions.get('s1').owned.add(100 + i);
  assert.equal(await code(call('tabs_create', {})), 'limit_reached');
});

test('browser data: off until the user turns it on, asks every time, and comes without queries', async () => {
  assert.equal(await code(call('search_history', { query: 'x' })), 'tool_off');
  router.switches = { history: true, bookmarks: true };
  browser.permissions.contains = async () => false;
  assert.equal(await code(call('search_history', { query: 'x' })), 'permission_required');
  browser.permissions.contains = async () => true;
  let p = call('search_history', { query: 'x' });
  await answer(false);
  assert.equal(await code(p), 'approval_denied');
  p = call('search_history', { query: 'x' });
  await answer(true);
  assert.deepEqual((await p).result.entries.map((e) => e.url), [`${A}/h?…`]);
  p = call('search_bookmarks', { query: 'x' });
  await answer(true);
  assert.deepEqual((await p).result.bookmarks.map((b) => b.url), [`${A}/p?…`]);
  assert.equal(await code(call('add_bookmark', { title: 't', url: 'javascript:1' })), 'invalid_argument');
  assert.equal(await code(call('list_downloads')), 'tool_off');
});

test('upload: only inside the folders of the user, approved with the full paths, and checked again before the bytes go', async () => {
  const up = (paths = ['C:\\ok\\a.txt']) => call('file_upload', { tabId: 1, ref: 'ref_d_1', paths });
  assert.equal(await code(up()), 'path_not_allowed', 'no folder is listed');
  assert.ok(!calls.some((c) => c[0] === 'file_stat'));
  router.folders = ['C:\\ok'];
  assert.equal(await code(up(['C:\\ok\\a.txt', 'C:\\ok\\b.txt'])), 'invalid_argument', 'the field takes one');
  files = { code: 'path_not_allowed', message: 'outside' };
  assert.equal(await code(up(['C:\\other\\x'])), 'path_not_allowed');
  assert.equal(approvals.cards.length, 0);
  files = [{ path: 'C:\\ok\\big', name: 'big', size: 11 * 1024 * 1024, stamp: 's' }];
  assert.equal(await code(up()), 'too_large');
  files = [{ path: 'C:\\ok\\a.txt', name: 'a.txt', size: 3, stamp: 's' }];
  let p = up();
  assert.equal((await answer(false)).value, 'C:\\ok\\a.txt (3 bytes)');
  assert.equal(await code(p), 'approval_denied');
  p = up();
  await card();
  grants.find('s1', 1).level = 'read';
  await answer(true);
  assert.equal(await code(p), 'read_only_grant');
  assert.ok(!calls.some((x) => x[0] === 'file_read'), 'no byte was read');
  grants.find('s1', 1).level = 'act';
  p = up();
  await answer(true);
  assert.deepEqual((await p).result.files, [{ name: 'a.txt', size: 3 }]);
  assert.deepEqual(calls.filter((x) => x[0] === 'file_read').map((x) => x[1].folders), [['C:\\ok']]);
});

test('a stop, a cancel or a revocation during the last question to the browser still keeps the action from happening', async () => {
  // The browser answers only when the test lets it.
  const hold = (o, name) => {
    const real = o[name];
    let go, asked;
    const began = new Promise((r) => (asked = r));
    o[name] = (...a) => (asked(), new Promise((r) => (go = () => r(real(...a)))));
    return { began, go: () => ((o[name] = real), go()) };
  };
  for (const tool of ['tabs_create', 'windows_create']) {
    const h = hold(browser.windows, 'getLastFocused');
    const p = call(tool, { url: `${A}/z` });
    await h.began;
    assert.equal(router.halt().calls[0].may_have_taken_effect, null);
    h.go();
    assert.equal(await code(p), 'stopped');
    await tick(20);
    assert.deepEqual(calls.filter((c) => c[0] === 'create'), [], tool);
    assert.ok(!tabs.some((t) => t.id === 30), tool);
    router.resume();
    const h2 = hold(browser.windows, 'getLastFocused');
    const q = call(tool, { url: `${A}/z` });
    await h2.began;
    router.revoke((g) => g.tabId === 1);
    h2.go();
    assert.equal(await code(q), 'no_grant', tool);
    assert.deepEqual(calls.filter((c) => c[0] === 'create'), [], tool);
    await router.grant({ sessionId: 's1', tabId: 1, origin: A, level: 'act' });
  }
  const api = router.api;
  let where = 0;
  const real = api.page;
  let free;
  api.page = (id, m, ...rest) => (m.cmd === 'where' && ++where === 1 ? new Promise((r) => (free = () => r(real(id, m, ...rest)))) : real(id, m, ...rest));
  const b = router.call('s1', 'late', 'browser_batch', { steps: [step('tabs_select', { tabId: 1 }), step('tabs_create', {})] });
  browser.tabs.update = async () => calls.push(['update']);
  while (!free) await tick(1);
  router.cancel('s1', 'late');
  free();
  assert.equal(await code(b), 'cancelled');
  await tick(30);
  assert.ok(!calls.some((c) => c[0] === 'update'), 'the step did not begin');
});

test('a ref of the tab itself is never read as one of a frame, whatever the random part of its document is', () => {
  const src = readFileSync(new URL('../../dist/extension/page/content.js', import.meta.url), 'utf8');
  const id = new Function('crypto', `return ${/const id = (.+?);/.exec(src)[1]}`)({ randomUUID: () => 'f1234567-0000-4000-8000-000000000000' });
  assert.equal(frameOfRef(`ref_${id}_1`), 0);
  assert.equal(frameOfRef(`ref_f12_${id}_1`), 12);
});

test('a copy of a tab that has just moved to another origin is not made', async () => {
  tabs[0].url = `${B}/moved`; // Firefox knows it, the event has not arrived yet
  browser.tabs.duplicate = async (id) => (calls.push(['duplicate', id]), tabs.push({ ...tabs[0], id: 60 }), tabs.at(-1));
  assert.equal(await code(call('tabs_create', { duplicateOf: 1 })), 'no_grant');
  assert.deepEqual([calls.filter(([c]) => c === 'duplicate').length, grants.all.filter((x) => x.tabId === 60).length], [0, 0]);
});

test('a window that holds a tab which the user took over or is busy with stays open', async () => {
  const { result } = await call('windows_create', {});
  router.stopTab(result.tabId);
  assert.equal(await code(call('windows_close', { windowId: result.windowId })), 'stopped');
  router.resumeTab(result.tabId);
  router.sessions.get('s1').handover.add(result.tabId);
  assert.equal(await code(call('windows_close', { windowId: result.windowId })), 'paused');
  assert.equal(await code(call('tabs_close', { tabId: result.tabId })), 'paused');
  assert.equal(calls.filter(([c]) => c === 'close window').length, 0);
  router.sessions.get('s1').handover.clear();
  assert.equal(await code(call('windows_close', { windowId: result.windowId })), 'ok');
});

test('after the user closed the window of a session, its next tab opens in another one', async () => {
  const { result } = await call('windows_create', {});
  const get = browser.windows.get;
  browser.windows.get = async (id, ...a) => (id === result.windowId ? Promise.reject(new Error('Invalid window ID')) : get(id, ...a));
  const create = browser.tabs.create;
  browser.tabs.create = async (o) => (o.windowId === result.windowId ? Promise.reject(new Error('Invalid window ID')) : create(o));
  assert.equal(await code(call('tabs_create', {})), 'ok');
});

test('browser data: the switch counts again after the approval, and a download from a private tab stays private', async () => {
  router.switches = { history: true, downloads: true };
  let p = call('search_history', { query: 'x' });
  await card();
  router.switches.history = false;
  await answer(true);
  assert.equal(await code(p), 'tool_off');
  await router.grant({ sessionId: 's1', tabId: 3, origin: A, level: 'read', private: true });
  browser.downloads = { download: async (o) => (calls.push(['download', o.incognito]), 1), search: async () => [{ id: 1, filename: 'C:\d\f', url: `${A}/f`, state: 'complete' }] };
  for (const tabId of [1, 3]) {
    p = call('download_start', { tabId, url: `${A}/f` });
    await answer(true);
    assert.equal(await code(p), 'ok');
  }
  assert.deepEqual(calls.filter((c) => c[0] === 'download'), [['download', false], ['download', true]]);
});

test('site rules: block, only, and ask cover subdomains, stand above grants, and hold in every listing', async () => {
  const host = (s) => ruleFor({ ...noRules(), block: ['b.example'] }, s);
  assert.deepEqual(['https://b.example', 'https://x.b.example:8443', 'https://B.EXAMPLE', 'https://b.example.'].map(host), ['block', 'block', 'block', 'block']);
  assert.deepEqual(['https://ab.example', 'https://b.example.org', null, 'about:config'].map(host), [null, null, 'block', 'block']);
  assert.equal(ruleFor({ block: ['x.a.example'], ask: ['a.example'], allow: ['a.example'] }, 'https://x.a.example'), 'block', 'never wins');
  assert.equal(ruleFor({ ...noRules(), allow: ['a.example'] }, B), 'block', 'a list of allowed sites blocks the others');
  for (const bad of ['', 'a b', 'https://u:p@a.example', '*.*']) assert.throws(() => addRule(noRules(), 'block', bad), { code: 'invalid_argument' }, bad);
  assert.deepEqual(addRule(noRules(), 'ask', ' *.Example.COM. ').ask, ['example.com']);

  const p = click();
  await card();
  await router.setRules(addRule(noRules(), 'block', 'a.example'));
  assert.equal(await code(p), 'site_blocked', 'what waits ends');
  assert.deepEqual([approvals.cards.length, sent.length], [0, 0]);
  for (const [t, a] of [['read_page', { tabId: 1 }], ['computer', { action: 'left_click', tabId: 1, ref: 'ref_d_1' }], ['tab_info', { tabId: 1 }], ['tabs_create', { url: `${A}/new` }], ['windows_create', { url: `${A}/` }]]) assert.equal(await code(call(t, a)), 'site_blocked', t);
  const [entry] = (await call('tabs_context')).result.tabs;
  assert.deepEqual([entry.state, entry.url, entry.title], ['site_blocked', undefined, undefined]);
  await assert.rejects(router.grant({ sessionId: 's2', tabId: 1, origin: A, level: 'read', move: true }), { code: 'site_blocked' });
  await assert.rejects(router.approveOrigin(grants.all[0].id, A), { code: 'site_blocked' });

  await router.setRules(noRules());
  assert.equal(await code(call('read_page', { tabId: 1 })), 'grant_suspended', 'the user approves the site again');
  await router.approveOrigin(grants.all[0].id, A);
  await router.approveFrames(grants.all[0].id, B);
  assert.match((await call('read_page', { tabId: 1 })).result.outline, /In frame 6/);
  await router.setRules(addRule(noRules(), 'block', 'b.example'));
  const o = (await call('read_page', { tabId: 1 })).result.outline;
  assert.ok(/forbids this site/.test(o) && !o.includes('In frame 6'));
  assert.equal((await call('list_frames', { tabId: 1 })).result.frames.find((f) => f.frame === 6).blocked, true);
  await assert.rejects(router.approveFrames(grants.all[0].id, B), { code: 'site_blocked' });
  assert.equal(await code(call('navigate', { tabId: 1, url: `${B}/x` })), 'site_blocked');
  browser.history.search = async () => [{ title: 'H', url: `${A}/h`, lastVisitTime: 0 }, { title: 'S', url: `${B}/s`, lastVisitTime: 0 }];
  router.switches.history = true;
  const h = call('search_history', { query: 'x' });
  await answer(true);
  assert.deepEqual((await h).result.entries.map((e) => e.title), ['H']);
  await router.setRules(noRules());
  assert.ok(!(await call('read_page', { tabId: 1 })).result.outline.includes('In frame 6'), 'a frame does not come back with the rule');

  await router.setRules(addRule(noRules(), 'ask', 'a.example'));
  let r = call('read_page', { tabId: 1 });
  assert.equal((await answer(false)).tool, 'site_rule');
  assert.equal(await code(r), 'approval_denied');
  r = call('read_page', { tabId: 1 });
  await answer(true);
  assert.equal(await code(r), 'ok');
  r = click();
  assert.equal((await answer(false)).tool, 'left_click', 'an action asks once, with its own card');
  await r;
});

test('tab_info, tab_update and tabs_move: the tab record alone, what Firefox says afterwards, and only tabs of the session', async () => {
  Object.assign(tabs[0], { index: 0, pinned: false, mutedInfo: { muted: false }, audible: true });
  browser.contextualIdentities = { get: async () => ({ name: 'Work' }) };
  browser.tabs.update = async (id, o) => Object.assign(tabs.find((t) => t.id === id), o.pinned === undefined ? {} : { pinned: o.pinned }, o.muted === undefined ? {} : { mutedInfo: { muted: o.muted } });
  pages.length = 0;
  const i = (await call('tab_info', { tabId: 1 })).result;
  assert.deepEqual([i.url, i.pinned, i.muted, i.audible, pages.length], [`${A}/x`, false, false, true, 0]);
  assert.deepEqual((await call('tab_update', { tabId: 1, pinned: true, muted: true })).result, { tabId: 1, pinned: true, muted: true });
  assert.equal(await code(call('tab_update', { tabId: 1 })), 'invalid_argument');
  assert.equal(await code(call('tab_update', { tabId: 2, pinned: false })), 'no_grant');
  router.setLevel(grants.all[0].id, 'read');
  assert.equal(await code(call('tab_update', { tabId: 1, muted: false })), 'read_only_grant');
  browser.tabs.move = async (ids, { index }) => calls.push(['move', ids, index]); // Firefox declines without an error
  assert.deepEqual((({ requested, moved }) => [requested, moved])((await call('tabs_move', { tabIds: [1], index: 5 })).result), [1, 0]);
  assert.equal(await code(call('tabs_move', { tabIds: [1, 2], index: 0 })), 'no_grant');
  assert.equal(await code(call('tabs_move', { tabIds: [1], index: 0, windowId: 2 })), 'no_grant', 'a window without a tab of the session');
  assert.equal(calls.filter(([c]) => c === 'move').length, 1);
});

test('a lower level ends acting calls that wait, and reading goes on', async () => {
  const p = click();
  await card();
  router.setLevel(grants.all[0].id, 'read');
  assert.deepEqual([await code(p), approvals.cards.length], ['read_only_grant', 0]);
  assert.equal(await code(click()), 'read_only_grant');
  assert.equal(await code(call('read_page', { tabId: 1 })), 'ok');
  assert.throws(() => router.setLevel(grants.all[0].id, 'all'), { code: 'invalid_argument' });
});

test('a page of Firefox itself in an attached tab is refused, and the tab is not closed', async () => {
  tabs[0].url = 'about:config';
  for (const [t, a] of [['navigate', { tabId: 1, url: `${A}/y` }], ['tabs_select', { tabId: 1 }], ['tabs_close', { tabId: 1 }], ['read_page', { tabId: 1 }], ['tab_info', { tabId: 1 }]]) assert.equal(await code(call(t, a)), 'restricted_page', t);
  assert.ok(tabs.some((t) => t.id === 1));
});

test('clipboard: off at first, asks, and ctrl+v inserts only what this session copied', async () => {
  const put = [];
  router.api.clipboard = { text: async (t) => put.push(t), picture: async (b) => put.push(b.byteLength) };
  const paste = (s) => call('computer', { action: 'key', tabId: 1, ref: 'ref_d_1', keys: 'ctrl+v' }, s);
  for (const p of [call('copy_to_clipboard', { action: 'text', text: 'x' }), paste()]) assert.equal(await code(p), 'tool_off');
  router.switches.clipboard = true;
  assert.equal(await code(paste()), 'not_allowed', 'nothing was copied');
  let p = call('copy_to_clipboard', { action: 'text', text: 'from Claude' });
  assert.equal((await answer(false)).value, 'from Claude');
  assert.deepEqual([await code(p), put.length], ['approval_denied', 0]);
  p = call('copy_to_clipboard', { action: 'text', text: 'from Claude' });
  await answer(true);
  assert.deepEqual([await code(p), put], ['ok', ['from Claude']]);
  p = paste();
  assert.match((await answer(true)).value, /inserts: from Claude/);
  assert.deepEqual([await code(p), sent.at(-1)[0]], ['ok', 'type']);
  assert.equal(await code(paste('s2')), 'conflict');
  router.sessions.get('s1').copied = null; // as in a new session
  assert.equal(await code(paste()), 'not_allowed');
  p = call('copy_to_clipboard', { action: 'picture', tabId: 1 });
  await answer(true);
  assert.deepEqual([await code(p), put.at(-1)], ['ok', 3]);
  p = call('copy_to_clipboard', { action: 'text', text: 'late' });
  await card();
  router.switches.clipboard = false;
  router.stopGroup('clipboard');
  assert.deepEqual([await code(p), put.length], ['tool_off', 2]);
});

test('more than 120 calls in a minute are refused with the time to wait, for each session apart', async () => {
  let now = 1_000_000;
  router.now = () => now;
  for (let i = 0; i < 120; i++) assert.equal(await code(call('tabs_context')), 'ok');
  assert.match((await call('tabs_context')).error.message, /Wait \d+ s/);
  assert.equal(await code(call('tabs_context')), 'rate_limited');
  assert.equal(await code(call('connection_status')), 'ok');
  assert.equal(await code(call('tabs_context', {}, 's2')), 'ok');
  now += 60_001;
  assert.equal(await code(call('tabs_context')), 'ok');
});
