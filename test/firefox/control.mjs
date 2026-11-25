// Browser control in the installed Firefox: disposable profiles, temporary add-on, installed helper, MCP server, local
// pages that report what happened. Real clicks in the real sidebar. No Claude Code.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpClient, installHome, root, sleep, until } from '../helpers.mjs';
import { Firefox, Sidebar } from './firefox.mjs';
import { fixture } from './fixtures.mjs';

const stopAfter = process.argv[2];
const results = [];
const out = path.join(root, 'test-results');
mkdirSync(out, { recursive: true });
const share = mkdtempSync(path.join(os.tmpdir(), 'fc-share-'));
mkdirSync(path.join(share, 'ok', 'sub'), { recursive: true });
writeFileSync(path.join(share, 'ok', 'a.txt'), 'hello a');
writeFileSync(path.join(share, 'ok', 'sub', 'b.txt'), 'hello b');
writeFileSync(path.join(share, 'outside.txt'), 'private');
const home = installHome();
const B = await fixture(4000);
const A = await fixture(3000, B.origin);
const f = await Firefox.start({ prefs: { 'browser.download.dir': path.join(share), 'browser.download.folderList': 2, 'browser.download.useDownloadDir': true } });
let g = null; // a second profile
const sb = new Sidebar(f, await f.install(path.join(root, 'dist/extension')));
const start = Date.now();
let c;
let tab;

async function check(row, name, fn) {
  if (results.stopped) return;
  const t = Date.now();
  const notes = [];
  let error = null;
  try {
    await fn((n) => notes.push(n));
  } catch (e) {
    error = e;
    notes.push(`sidebar: ${(await sb.text('body').catch((x) => x.message)).replace(/\s+/g, ' ').slice(0, 900)}`);
    for (let i = await sb.eval('return document.querySelectorAll("#cards .card").length').catch(() => 0); i > 0; i--) await sb.answerCard(false).catch(() => {});
  }
  results.push({ row, name, ok: !error, ms: Date.now() - t, notes, error: error?.message });
  console.log(`${error ? 'FAIL' : 'ok  '} ${row.padEnd(8)} ${name} (${Date.now() - t} ms)${notes.map((n) => `\n         ${n}`).join('')}${error ? `\n         ${error.stack.split('\n').filter((l) => !/node:internal|helpers/.test(l)).slice(0, 9).join('\n         ')}` : ''}`);
  if (stopAfter && name.includes(stopAfter)) results.stopped = true;
}
const call = (tool, args = {}) => c.call(tool, { tabId: tab, ...args });
const act = async (tool, args, yes = true) => {
  const p = call(tool, args);
  let over = false;
  p.then(() => (over = true));
  await until('card or answer', async () => over || sb.text('#cards .card').catch(() => null), 8000, 30);
  if (!over) await sb.answerCard(yes);
  return p;
};
const refOf = async (name, filter = 'interactive') => {
  const o = (await call('read_page', { filter })).text;
  return new RegExp(`"${name}".*\\[(ref_\\w+)\\]`).exec(o)?.[1] ?? assert.fail(`no ${name} in ${o}`);
};
const computer = async (action, name, more = {}) => act('computer', { action, ...(name && { ref: await refOf(name) }), ...more });
const reported = (what, from = A) => until(`report ${what}`, () => from.reports.includes(what), 4000);
const approve = async () => {
  await sb.eval('document.querySelector("#message").textContent = ""');
  await sb.click('#grants .approve');
  await until('approved', async () => /Approved/.test(await sb.text('#message')));
};
const set = (sel, v) => sb.eval('const i = document.querySelector(arguments[0]); i.value = arguments[1]; i.dispatchEvent(new Event("input"))', sel, v);

try {
  await f.navigate(`${A.origin}/control`);
  await sb.open();
  await sb.click('#connect');
  await until('connected', async () => (await sb.text('#link-title')) === 'Connected');
  c = new McpClient(home, { name: 'driver' });
  await c.init();
  await until('client', async () => /driver/.test(await sb.text('#sessions')));
  const first = await f.handle();

  await check('FC-TAB', 'tab_request: the client asks, the user gives this tab in the sidebar', async (n) => {
    const { request_id } = (await c.call('tab_request', { reason: 'To test it', level: 'act' })).data;
    await until('request', async () => /asks for a tab.*To test it/.test(await sb.text('#requests')));
    const p = c.call('tab_request_result', { request_id, wait_s: 20 });
    await sb.click('#requests .give-act');
    await f.prompt(true);
    const r = (await p).data;
    n(JSON.stringify(r));
    assert.equal(r.state, 'granted');
    tab = r.tabId;
  });

  await check('FC-READ', 'frames: same origin inline, another origin only after the user allows its frames; a closed shadow root is read', async (n) => {
    let o = (await call('read_page', { filter: 'interactive' })).text;
    assert.ok(o.includes('Shadow go') && o.includes('Inner go 3000') && !o.includes('Inner go 4000') && !o.includes('hunter2'));
    n(/frame \d+ not read[^\n]*/.exec(o)[0]);
    await sb.click('#grants .frames');
    await until('frames', async () => (await sb.text('#frames'))?.includes(B.origin));
    await sb.click('#frames .allow-frame');
    await until('allowed', async () => /Frames allowed/.test(await sb.text('#message')));
    o = (await call('read_page', { filter: 'interactive' })).text;
    assert.ok(o.includes('Inner go 4000'));
    n((await call('list_frames')).text.replace(/\s+/g, ' ').slice(0, 300));
    assert.ok((await computer('left_click', 'Inner go 4000')).data.dispatched);
    await reported('inner', B);
    assert.ok((await computer('left_click', 'Shadow go')).data.dispatched);
    await reported('shadow');
    const t = await call('get_page_text');
    assert.ok(t.text.includes('Control') && !t.text.includes('hunter2'));
  });

  await check('FC-READ', 'find by words and selector, text count, and no selector that tests a value', async () => {
    assert.match((await call('find', { query: 'send form' })).text, /"name": "Send form"/);
    assert.match((await call('find', { selector: '#dead' })).text, /"total": 1/);
    for (const selector of ['input[value^="h"]', 'input[VALUE]', 'input[\\76 alue]', ':::']) assert.equal((await call('find', { selector })).code, 'invalid_argument', selector);
    assert.match((await call('find_text', { text: 'hunter2secret' })).text, /"count": 0/);
    assert.equal((await call('wait_for', { url: `${A.origin}/control*`, timeout_s: 1 })).data.found, true);
    assert.equal((await call('wait_for', { text_gone: 'never there', timeout_s: 1 })).data.found, true);
    assert.equal((await call('wait_for', { title: 'Nope*', timeout_s: 0.5 })).data.found, false);
  });

  await check('FC-ACT', 'controlled input: form_input and typing reach the model of the page, key by key as well', async (n) => {
    assert.equal((await act('form_input', { ref: await refOf('Controlled'), value: 'set' })).data.observed, true);
    assert.match(await f.page('return document.getElementById("model").textContent'), /model:set$/);
    const r = (await computer('type', 'Controlled', { text: ' typed' })).data;
    n(JSON.stringify(r));
    assert.equal(r.characters_arrived, 6);
    assert.match(await f.page('return document.getElementById("model").textContent'), /typed/);
    const s = (await computer('type', 'Slow', { text: 'abc', slowly: true })).data;
    assert.equal(s.characters_arrived, 3);
    assert.equal(await f.page('return document.getElementById("slow").value'), 'abc');
    for (const p of [act('form_input', { ref: await refOf('Secret'), value: 'x' })]) assert.equal((await p).code, 'secret_field');
    assert.equal((await computer('type', 'Secret', { text: 'x' })).code, 'secret_field');
    assert.equal((await computer('key', 'Secret', { keys: 'a' })).code, 'secret_field');
    assert.equal(await f.page('return document.getElementById("pw").value'), '');
  });

  await check('FC-ACT', 'keys: Enter sends the form once, Backspace edits, Tab moves, browser shortcuts are refused', async () => {
    await computer('type', 'Enter here', { text: 'abx' });
    await computer('key', 'Enter here', { keys: 'Backspace' });
    assert.equal(await f.page('return document.getElementById("q").value'), 'ab');
    await computer('key', 'Enter here', { keys: 'Enter' });
    await reported('submit ab');
    assert.equal(A.reports.filter((x) => x.startsWith('submit')).length, 1);
    await computer('key', 'Enter here', { keys: 'Tab' });
    assert.equal(await f.page('return document.activeElement.textContent'), 'Send form');
    for (const keys of ['F5', 'ctrl+w', 'ctrl+plus']) assert.equal((await call('computer', { action: 'key', keys })).code, 'not_allowed');
  });

  await check('FC-ACT', 'pointer: hover, right and double click, a dead button, a confirm cancelled and accepted', async (n) => {
    assert.equal((await computer('hover', 'Menu')).data.dispatched, true);
    await reported('hover');
    await computer('right_click', 'Menu');
    await reported('contextmenu');
    await computer('double_click', 'Menu');
    await reported('dblclick');
    const dead = (await computer('left_click', 'Dead')).data;
    assert.deepEqual([dead.dispatched, dead.observed], [true, false]);
    n(dead.hint);
    const no = (await computer('left_click', 'Ask')).data;
    await reported('confirm=false');
    const yes = (await computer('left_click', 'Ask', { dialog: 'accept' })).data;
    await reported('confirm=true');
    n(JSON.stringify([no.dialogs, yes.dialogs]));
    assert.equal(await f.page('return /native code/.test(Function.prototype.toString.call(confirm))'), true, 'the function of the page is back');
  });

  await check('FC-ACT', 'drag and drop, scrolling without untrusted events, a range and a list with several choices', async (n) => {
    const d = (await act('computer', { action: 'left_click_drag', ref: await refOf('Drag me'), to_ref: await refOf('Drop here') })).data;
    n(JSON.stringify({ accepted: d.accepted, handled: d.handled, how: d.how }));
    assert.deepEqual([d.accepted, d.handled], [true, true]);
    await reported('dropped payload');
    const s = (await call('computer', { action: 'scroll', ref: await refOf('Long'), direction: 'down', amount: 100 })).data;
    assert.deepEqual([s.moved, s.area], [true, 'element']);
    assert.equal((await call('computer', { action: 'scroll', to: 'bottom' })).data.at_end, true);
    assert.ok(!A.reports.some((x) => x.startsWith('untrusted')));
    assert.equal((await act('form_input', { ref: await refOf('Pick'), value: 'One\nthree' })).data.changed, true);
    assert.equal((await act('form_input', { ref: await refOf('Volume'), value: '7' })).data.changed, true);
    assert.deepEqual(await f.page('return [[...document.querySelector("select").selectedOptions].map((o) => o.text).join(), document.querySelector("[type=range]").value]'), ['One,Three', '7']);
    const many = await act('form_fill', { fields: [{ ref: await refOf('Slow'), value: 'x' }, { ref: await refOf('Enter here'), value: 'y' }] });
    assert.equal(many.data.set.length, 2);
    assert.equal((await call('form_fill', { fields: [{ ref: await refOf('Slow'), value: 'z' }, { ref: 'ref_gone_1', value: 'y' }] })).code, 'stale_ref');
    assert.equal(await f.page('return document.getElementById("slow").value'), 'x');
  });

  await check('FC-READ', 'SPA: a ref of the view that went is stale and names what is there; the new view works', async (n) => {
    const spa = await refOf('Next view');
    assert.equal((await act('computer', { action: 'left_click', ref: spa })).data.observed, true);
    const second = await refOf('Second view');
    await act('computer', { action: 'left_click', ref: second });
    await reported('second view');
    await f.page('document.getElementById("view").innerHTML = "<button>Second view</button>"');
    const r = await call('computer', { action: 'left_click', ref: second });
    n(r.text.slice(0, 190));
    assert.equal(r.code, 'stale_ref');
    assert.equal(r.structuredContent.candidates.length, 1);
    assert.equal((await act('computer', { action: 'left_click', ref: spa })).code, null, 'a ref that is still there keeps working');
  });

  await check('FC-SHOT', 'an annotated picture lists refs, a point of it clicks, also in a frame, and is too old after a scroll', async (n) => {
    await sb.eval('document.querySelector("#d-screens").open = true');
    await sb.click('#screens');
    await f.prompt(true);
    await until('allowed', async () => /are allowed/.test(await sb.text('#message')));
    await call('computer', { action: 'scroll', to: 'top' });
    const shot = await call('computer', { action: 'screenshot', annotate: true });
    const meta = JSON.parse(/\{.*\}/s.exec(shot.text)[0]);
    writeFileSync(path.join(out, 'annotated.jpg'), Buffer.from(shot.content.find((x) => x.type === 'image').data, 'base64'));
    n(`${meta.marks.length} marks, picture ${meta.width}x${meta.height}`);
    assert.ok(meta.marks.some((m) => m.name === 'Shadow go') && meta.marks.some((m) => /Inner go 4000/.test(m.name)));
    const at = async (sel) => (await f.page('const r = document.querySelector(arguments[0]).getBoundingClientRect(); return [r.left + 60, r.top + 20]', sel)).map((v) => Math.round(v / meta.css_per_pixel));
    const [x, y] = await at('#other');
    const before = B.reports.length;
    await act('computer', { action: 'left_click', x, y, image_id: meta.image_id });
    await until('frame click', () => B.reports.length > before, 4000);
    await call('computer', { action: 'scroll', direction: 'down', amount: 40 });
    assert.equal((await call('computer', { action: 'left_click', x, y, image_id: meta.image_id })).code, 'expired');
  });

  await check('FC-ACT', 'uploads: refused without a folder, outside it and when denied; then a file, a folder and a drop zone', async (n) => {
    const file = path.join(share, 'ok', 'a.txt');
    const one = await refOf('One file');
    assert.equal((await call('file_upload', { ref: one, paths: [file] })).code, 'path_not_allowed');
    await set('#folder-path', path.join(os.homedir()));
    await sb.eval('document.querySelector("#d-data").open = true');
    await sb.click('#folder-add');
    await until('refused', async () => /path_not_allowed/.test(await sb.text('#message')));
    await set('#folder-path', path.join(share, 'ok'));
    await sb.click('#folder-add');
    await until('added', async () => /Added/.test(await sb.text('#message')));
    for (const p of [path.join(share, 'outside.txt'), path.join(share, 'ok', '..', 'outside.txt')]) assert.equal((await call('file_upload', { ref: one, paths: [p] })).code, 'path_not_allowed');
    assert.equal((await act('file_upload', { ref: one, paths: [file] }, false)).code, 'approval_denied');
    assert.ok(!A.reports.some((x) => x.startsWith('files')));
    n(JSON.stringify((await act('file_upload', { ref: one, paths: [file] })).data));
    await reported('files a.txt:7:hello');
    const folder = await act('file_upload', { ref: await refOf('A folder'), paths: [path.join(share, 'ok', 'sub')] });
    assert.equal(folder.code, null, folder.text);
    await reported('files sub/b.txt:7:hello');
    const zone = (await act('file_upload', { ref: await refOf('Zone'), paths: [file] })).data;
    assert.equal(zone.handled, true);
    await reported('zone a.txt');
  });

  await check('FC-AGT-05', 'batch: runs in order, stops where a step moves the page, and a cancel leaves the rest undone', async (n) => {
    const away = await refOf('Away');
    const r = JSON.parse(/\n(\{.*)/.exec((await act('browser_batch', { tabId: undefined, steps: [{ tool: 'find_text', args: { tabId: tab, text: 'Control' } }, { tool: 'computer', args: { action: 'left_click', tabId: tab, ref: away } }, { tool: 'read_page', args: { tabId: tab } }] })).text)[1].split('\n')[0]);
    n(JSON.stringify(r));
    assert.deepEqual([r.stopped_by, r.done], ['navigated', 2]);
    const back = (await act('navigate', { history: 'back' })).data;
    assert.equal(back.state, 'loaded');
    const q = c.request('tools/call', { name: 'browser_batch', arguments: { steps: [{ tool: 'find_text', args: { tabId: tab, text: 'x' } }, { tool: 'computer', args: { action: 'left_click', tabId: tab, ref: await refOf('Ask') } }] } });
    await sb.waitCard();
    const before = A.reports.length;
    c.notify('notifications/cancelled', { requestId: q.id });
    await until('card gone', async () => !(await sb.text('#cards .card').catch(() => null)));
    assert.equal(A.reports.length, before);
  });

  await check('FC-TAB', 'navigate: reload, no page to go forward to, addresses that are refused, an unreachable host', async (n) => {
    assert.equal((await act('navigate', { history: 'reload' })).data.observed, true);
    await act('navigate', { url: `${A.origin}/control?x=1` });
    assert.equal((await act('navigate', { history: 'forward' })).code, 'no_history');
    for (const url of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'https://u:p@example.com', 'about:config']) assert.equal((await call('navigate', { url })).code, 'invalid_argument', url);
    const dead = await act('navigate', { url: 'http://localhost:1/' });
    n(`${dead.code}`);
    assert.ok(['grant_suspended', 'load_failed', 'restricted_page'].includes(dead.code), dead.text);
    await f.navigate(`${A.origin}/control`);
    await approve();
  });

  await check('FC-ACT-31', 'navigation mid-action: an approved click whose page moved to another origin reaches neither page', async () => {
    const p = call('computer', { action: 'left_click', ref: await refOf('Shadow go') });
    await sb.waitCard();
    const counts = [A.reports.length, B.reports.length];
    await f.navigate(`${B.origin}/control`);
    assert.equal((await p).code, 'grant_suspended');
    assert.deepEqual([A.reports.length, B.reports.length], counts);
    await f.navigate(`${A.origin}/control`);
    await approve();
  });

  await check('FC-GRANT-17', 'take over: the pill is in a closed root, a scripted click does nothing, the sidebar stops the tab and gives it back', async (n) => {
    await computer('hover', 'Menu');
    assert.equal(await f.page('const e = document.documentElement.lastElementChild; e.click(); return e.tagName + ":" + (e.shadowRoot === null)'), 'DIV:true');
    assert.equal((await call('find_text', { text: 'Control' })).code, null, 'a scripted click stopped nothing');
    const p = call('wait_for', { text: 'NEVER', timeout_s: 30 });
    await sleep(300);
    await sb.click('#grants .take-over');
    assert.equal((await p).code, 'stopped');
    n((await sb.text('#halt-report')).slice(0, 120));
    assert.equal((await call('read_page')).code, 'stopped');
    await sb.click('#grants .give-back');
    await until('back', async () => (await call('read_page')).code === null);
    await computer('hover', 'Menu');
    const box = await f.page('const r = document.documentElement.lastElementChild.getBoundingClientRect(); return [Math.round(r.right), Math.round(r.top + r.height / 2)]');
    await f.m.send('WebDriver:PerformActions', { actions: [{ type: 'pointer', id: 'm', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', x: box[0] - 30, y: box[1], origin: 'viewport', duration: 0 }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] }] });
    await until('pill took over', async () => (await call('read_page')).code === 'stopped', 4000);
    await sb.click('#grants .give-back');
    await until('back again', async () => (await call('read_page')).code === null);
  });

  await check('FC-ACT', 'an interrupted input: take over while text is typed key by key leaves what was typed and says so', async (n) => {
    const p = call('computer', { action: 'type', ref: await refOf('Slow'), text: 'x'.repeat(200), slowly: true });
    await sb.answerCard(true);
    await until('some keys', async () => (await f.page('return document.getElementById("slow").value.length')) > 3);
    await sb.click('#grants .take-over');
    const r = await p;
    n(`${r.code}: ${r.text.slice(0, 120)}`);
    const typed = await f.page('return document.getElementById("slow").value.length');
    n(`typed ${typed} of 200; report: ${await sb.text('#halt-report')}`);
    assert.ok(['stopped', 'timeout_unknown', 'outcome_unknown'].includes(r.code) && typed < 200);
    assert.match(await sb.text('#halt-report'), /May already have taken effect/);
    await sleep(400);
    assert.equal(await f.page('return document.getElementById("slow").value.length'), typed, 'nothing is typed after the stop');
    await sb.click('#grants .give-back');
    await until('back', async () => (await call('read_page')).code === null);
  });

  await check('FC-GRANT-16', 'emergency stop: a running and a queued call end, new ones are refused, and the report says what may have happened', async (n) => {
    const one = call('computer', { action: 'left_click', ref: await refOf('Shadow go') });
    await sb.waitCard();
    const two = call('computer', { action: 'left_click', ref: await refOf('Dead').catch(() => 'ref_x_1') });
    await sleep(200);
    const before = A.reports.length;
    await sb.click('#halt');
    assert.equal((await one).code, 'stopped');
    assert.equal((await two).code, 'stopped');
    await until('report', async () => /Not carried out/.test(await sb.text('#halt-report')));
    n(await sb.text('#halt-report'));
    assert.equal((await c.call('tabs_context')).code, 'stopped');
    assert.equal(await sb.text('#link-title'), 'Stopped by you');
    await sb.click('#resume-work');
    await until('works', async () => (await c.call('tabs_context')).code === null);
    assert.equal(A.reports.length, before);
  });

  await check('FC-TAB-11', 'tabs: opened in the background in a group, closed, reopened; the active tab does not change', async (n) => {
    const active = () => sb.eval('return (await browser.tabs.query({ active: true })).map((t) => t.id).join()');
    const before = await active();
    const t = (await c.call('tabs_create', { url: `${A.origin}/second` })).data; // an attached tab covers the origin
    n(JSON.stringify(t));
    assert.equal(t.state, 'loaded');
    assert.ok((await sb.eval('return (await browser.tabs.get(arguments[0])).groupId', t.tabId)) > 0);
    assert.match((await c.call('read_page', { tabId: t.tabId })).text, /Second page/);
    await c.call('tabs_close', { tabId: t.tabId });
    const closed = JSON.parse(/\{.*\}/s.exec((await c.call('closed_tabs', { action: 'list' })).text)[0]).tabs;
    const p = c.call('closed_tabs', { action: 'reopen', id: closed[0].id });
    await sb.answerCard(true);
    const again = (await p).data ?? JSON.parse(/\{.*\}/s.exec((await p).text)[0]);
    await until('reopened', async () => (await c.call('read_page', { tabId: again.tabId })).code === null);
    const w = (await c.call('windows_create')).data;
    n(JSON.stringify(w));
    assert.equal((await c.call('windows_close', { windowId: w.windowId })).code, null);
    const own = (await sb.eval('return (await browser.tabs.get(arguments[0])).windowId', tab));
    assert.equal((await c.call('windows_close', { windowId: own })).code, 'not_allowed');
    assert.equal(await active(), before);
    await c.call('tabs_close', { tabId: again.tabId });
    n((await c.call('containers_list')).text.replace(/\s+/g, ' ').slice(0, 160));
    assert.equal((await c.call('tabs_create', { container: 'Work' })).code, 'permission_required', 'the cookies permission of containers is not there at install');
    await sb.eval('document.querySelector("#d-data").open = true; document.querySelector("#message").textContent = ""');
    await sb.click('#containers-ok');
    n(await until('allowed', () => sb.text('#message'), 5000));
    const box = c.call('tabs_create', { url: `${A.origin}/second`, container: 'Work' });
    await sb.answerCard(true);
    const inBox = (await box).data;
    assert.match(await sb.eval('return (await browser.tabs.get(arguments[0])).cookieStoreId', inBox.tabId), /^firefox-container-/);
    await c.call('tabs_close', { tabId: inBox.tabId });
    assert.equal((await c.call('tabs_create', { container: 'Wrok' })).code, 'not_found');
  });

  await check('FC-DATA', 'bookmarks, history and downloads: off, then on by the user, asked each time', async (n) => {
    assert.equal((await c.call('search_history', { query: 'Control' })).code, 'tool_off');
    for (const name of ['bookmarks', 'history', 'downloads']) {
      await sb.eval('document.querySelector("#d-data").open = true');
      await sb.click(`#switch-${name}`);
      await f.prompt(true);
      await until('on', async () => (await sb.eval('return document.querySelector(arguments[0]).checked', `#switch-${name}`)) === true);
    }
    const hist = c.call('search_history', { query: 'Control' });
    await sb.answerCard(true);
    assert.match((await hist).text, /localhost:3000\/control/);
    assert.ok(!(await hist).text.includes('x=1'));
    const add = c.call('add_bookmark', { title: 'Fixture', url: `${A.origin}/control` });
    await sb.answerCard(true);
    assert.equal((await add).data.exists, false);
    const find = c.call('search_bookmarks', { query: 'Fixture' });
    await sb.answerCard(false);
    assert.equal((await find).code, 'approval_denied');
    const d = await act('download_start', { url: `${A.origin}/file.txt`, filename: 'got.txt' });
    n(d.text.replace(/\s+/g, ' ').slice(0, 200));
    assert.equal(d.data.state, 'complete');
    assert.equal((await call('download_start', { url: `${B.origin}/file.txt` })).code, 'not_allowed');
  });

  await check('FC-AGT-07', 'recording and replay across frames and a second tab, with the grants of that moment', async (n) => {
    await sb.attach('This sidebar', 'act', null);
    await sb.click('#grants .frames', await sb.eval('return [...document.querySelectorAll("#grants li")].filter((l) => l.querySelector(".frames")).findIndex((l) => l.textContent.includes("This sidebar"))'));
    await until('frames', async () => (await sb.text('#frames'))?.includes(B.origin));
    await sb.click('#frames .allow-frame');
    await until('allowed', async () => /Frames allowed/.test(await sb.text('#message')));
    const second = await f.tab(`${A.origin}/second`);
    await sb.attach('This sidebar', 'act', null);
    await f.select(first);
    await sb.click('#wf-record');
    await until('recording', async () => /Recording in/.test(await sb.text('#wf-rec')));
    await f.m.send('Marionette:SetContext', { value: 'content' });
    await f.m.send('WebDriver:SwitchToFrame', { id: 1 });
    const before = B.reports.length;
    await f.pageClick('#go');
    await until('frame click', () => B.reports.length > before, 4000);
    await f.m.send('WebDriver:SwitchToFrame', { id: null });
    await f.select(second);
    await until('second tab', async () => /tab 2/.test(await sb.text('#wf-rec')), 5000);
    await f.select(first);
    const i = await sb.eval('return [...document.querySelectorAll("#wf-rec button")].findIndex((b) => b.textContent === "Stop")');
    await sb.click('#wf-rec button', i);
    await until('review', async () => /Review/.test(await sb.text('#wf-edit')));
    const steps = await sb.eval('return [...document.querySelectorAll("#wf-edit .step strong")].map((e) => e.textContent)');
    n(steps.join(' | '));
    assert.match(steps.join('|'), /Click button "Inner go 4000" \(frame of http:\/\/localhost:4000\).*\/second \(tab 2\)/);
    await set('#wf-title', 'Frames and tabs');
    await sb.click('#wf-edit .wf-save');
    await until('listed', async () => /Frames and tabs/.test(await sb.text('#wf-list')));
    await sb.click('#wf-list .wf-open-replay');
    await until('ready', async () => /Every step is checked again/.test(await sb.text('#wf-preview')), 8000);
    await sb.click('#wf-preview .wf-start-replay');
    const count = B.reports.length;
    await sb.answerCard(true);
    await until('done', async () => /\(done\)/.test(await sb.text('#wf-replay h3')), 12_000);
    assert.equal(B.reports.length, count + 1);
    await sb.click('#wf-replay .wf-close-replay');
    // the same without the second tab
    await f.select(second);
    await f.m.send('WebDriver:CloseWindow');
    await f.select(first);
    await sb.click('#wf-list .wf-open-replay');
    await until('ready', async () => /Every step is checked again/.test(await sb.text('#wf-preview')), 8000);
    await sb.click('#wf-preview .wf-start-replay');
    await sb.answerCard(true);
    await until('failed', async () => /\(failed\)/.test(await sb.text('#wf-replay h3')), 12_000);
    n(await sb.text('#replay-message'));
    assert.match(await sb.text('#replay-message'), /no_grant: This step needs a tab on/);
    await sb.click('#wf-replay .wf-stop-replay');
  });

  await check('FC-SHOT', 'a minimized window gives no picture and says so', async (n) => {
    await f.chrome('window.minimize()');
    await sleep(800);
    const state = await sb.eval('return (await browser.windows.getCurrent()).state').catch((e) => e.message);
    n(`Firefox reports the window as ${state}`);
    const r = await call('computer', { action: 'screenshot' });
    n(`${r.code}: ${r.text.slice(0, 90)}`);
    if (state === 'minimized') assert.equal(r.code, 'not_allowed');
    assert.equal((await call('read_page')).code, null, 'reading works');
    await f.chrome('window.restore()');
    await sleep(500);
  });

  await check('FC-TAB-32', 'a private window: allowed in Firefox, yet in no list, count or reach without a grant of its own', async (n) => {
    const others = (await c.call('tabs_context')).data.otherTabs;
    await f.m.send('Marionette:SetContext', { value: 'chrome' });
    await sb.eval('const { workflows } = await browser.storage.local.get("workflows"); workflows.push({ id: "old", title: "Old one", origin: arguments[0], created: 1, steps: [{ kind: "fill", role: "textbox", name: "Slow", nth: 0, of: 1, value: "OLD-TEXT-MARK" }] }); await browser.storage.local.set({ workflows }); return 1', A.origin);
    await f.m.send('Marionette:SetContext', { value: 'chrome' });
    await f.m.send('Addon:Install', { path: path.join(root, 'dist/extension'), temporary: true, allowPrivateBrowsing: true });
    await sleep(1500);
    await f.m.send('Marionette:SetContext', { value: 'content' });
    const { handle } = await f.m.send('WebDriver:NewWindow', { type: 'window', private: true, focus: false });
    await sb.open();
    await until('connected', async () => (await sb.text('#link-title')) === 'Connected', 15_000);
    const all = await sb.eval('return (await browser.tabs.query({})).map((t) => [t.id, t.incognito])');
    const priv = all.find((t) => t[1])?.[0];
    n(`the add-on itself sees ${JSON.stringify(all)}`);
    assert.ok(priv !== undefined, 'Firefox lets the add-on see the private tab');
    await c.call('connection_status');
    await c.call('tabs_context'); // session_ended
    assert.equal((await c.call('tabs_context')).data.otherTabs, all.filter((t) => !t[1]).length);
    n(`otherTabs before ${others}`);
    for (const tool of ['read_page', 'tabs_close', 'list_frames']) assert.equal((await c.call(tool, { tabId: priv })).code, 'no_grant', tool);
    await f.select(handle);
    await f.navigate(`${A.origin}/second`);
    await sb.open();
    await until('private row', () => sb.eval('return !document.querySelector("#private-row").hidden'));
    await sb.attach('driver', 'read', null);
    assert.match(await sb.text('#message'), /not_allowed.*private/);
    await sb.click('#private-ok');
    await sb.attach('driver', 'read', null);
    n(await sb.text('#message'));
    assert.match((await c.call('read_page', { tabId: priv })).text, /Second page/);
    assert.equal((await c.call('computer', { action: 'left_click', tabId: priv, ref: 'ref_x_1' })).code, 'read_only_grant');
    const { log } = await sb.eval('return await browser.storage.local.get("log")');
    assert.ok(!JSON.stringify(log.slice(-4)).includes('localhost'), 'the stored log holds no origin of a private tab');
    await f.m.send('Marionette:SetContext', { value: 'content' });
    await f.m.send('WebDriver:CloseWindow');
    await f.select(first);
    assert.equal((await c.call('read_page', { tabId: priv })).code, 'no_grant');
  });

  await check('FC-AGT-07', 'a text that an earlier version stored: kept, unused and hidden until the user decides', async (n) => {
    await sb.open();
    const stored = () => sb.eval('return JSON.stringify((await browser.storage.local.get("workflows")).workflows.find((w) => w.id === "old"))');
    assert.match(await stored(), /OLD-TEXT-MARK/);
    const shows = () => sb.eval('return document.body.textContent.includes("OLD-TEXT-MARK")');
    const i = await sb.eval('return [...document.querySelectorAll("#wf-list li")].findIndex((l) => l.textContent.includes("Old one"))');
    assert.ok(i >= 0);
    await sb.click('#wf-list li .wf-edit-saved', i);
    await until('asked', async () => /earlier version stored a text/.test(await sb.text('#wf-edit')));
    n(await sb.text('#wf-edit .note.warn'));
    assert.equal(await shows(), false);
    await sb.click('#wf-edit .old-show');
    assert.equal(await shows(), true);
    await sb.click('#wf-edit .old-drop');
    await sb.click('#wf-edit .wf-save');
    await until('deleted', async () => !/OLD-TEXT-MARK/.test(await stored()));
    assert.match(await stored(), /"ask":true/);
  });

  await check('FC-CONN-10', 'after the add-on restarted the same tabs are given again only by the button, which is gone then', async (n) => {
    n(`lost list after a restart of the add-on: ${JSON.stringify(await sb.text('#lost'))}`);
    assert.equal(await sb.text('#lost'), '', 'memory only');
    await sb.attach('driver', 'act', null);
    const { execFileSync } = await import('node:child_process');
    execFileSync('taskkill', ['/F', '/FI', `IMAGENAME eq firefox-companion-host.exe`, '/FI', `PID eq ${JSON.parse((await import('node:fs')).readFileSync(path.join(home.dir, 'state.json'), 'utf8')).pid}`]);
    await until('connected', async () => (await sb.text('#link-title')) === 'Connected', 15_000);
    await c.call('connection_status');
    assert.equal((await call('read_page')).code, 'session_ended');
    assert.equal((await call('read_page')).code, 'no_grant');
    await until('button', async () => /Attach the same 1 tabs again/.test(await sb.text('#lost')));
    await sb.click('#lost .regrant');
    await until('given', async () => /Attached 1, left out 0/.test(await sb.text('#message')));
    assert.equal((await call('read_page')).code, null);
    assert.equal(await sb.text('#lost'), '');
  });

  await check('FC-CONN-01', 'two Firefox profiles side by side: a new client has to pick, and the grants of one mean nothing in the other', async (n) => {
    g = await Firefox.start();
    const sc = new Sidebar(g, await g.install(path.join(root, 'dist/extension')));
    await g.navigate(`${A.origin}/second`);
    await sc.open();
    await sc.click('#connect');
    await until('connected', async () => (await sc.text('#link-title')) === 'Connected');
    const d = new McpClient(home, { name: 'picker' });
    await d.init();
    assert.equal((await d.call('tabs_context')).code, 'ambiguous');
    const list = (await d.call('list_connected_browsers')).data.browsers;
    n(JSON.stringify(list.map((x) => [x.id.slice(0, 8), x.label])));
    assert.equal(list.length, 2);
    assert.equal((await call('read_page')).code, null, 'the first client stays in its profile');
    const mine = await sb.eval('return (await browser.storage.local.get("profile")).profile.id');
    await d.call('select_browser', { profile: list.find((x) => x.id !== mine).id });
    await until('in the second sidebar', async () => (await d.call('tabs_context')).code === null && /picker/.test(await sc.text('#sessions')));
    assert.deepEqual((await d.call('tabs_context')).data.tabs, []);
    d.child.kill();
  });
} finally {
  c?.child.kill();
  for (const x of [g, f]) await x?.quit().catch((e) => console.error('quit', e.message));
  await A.close();
  await B.close();
  await home.close();
  rmSync(share, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  writeFileSync(path.join(out, 'control.json'), JSON.stringify({ firefox: f.version, headless: f.capabilities['moz:headless'], at: new Date().toISOString(), seconds: Math.round((Date.now() - start) / 1000), results }, null, 1));
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
}
