// End-to-end checks in the installed Firefox, with a disposable profile, the temporary add-on, the installed helper, the
// MCP server as its own process and local fixture pages. Gestures are real mouse clicks on the real sidebar.
// Usage: node test/firefox/run.mjs [text]   runs all checks, or stops after the first whose name holds the text
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { VERSION } from '../../shared/protocol.mjs';
import { McpClient, host, installHome, powershell, root, sleep, until } from '../helpers.mjs';
import { Firefox, Sidebar } from './firefox.mjs';
import { fixture } from './fixtures.mjs';

const stopAfter = process.argv[2];
const results = [];
const out = path.join(root, 'test-results');
mkdirSync(out, { recursive: true });

const home = installHome();
const A = await fixture(3000);
const B = await fixture(4000);
const f = await Firefox.start();
const addon = await f.install(path.join(root, 'dist/extension'));
const sb = new Sidebar(f, addon);
const clients = [];
const start = Date.now();

async function check(ac, name, fn) {
  if (results.stopped) return;
  const t = Date.now();
  const notes = [];
  let error = null;
  try {
    await fn((n) => notes.push(n));
  } catch (e) {
    error = e;
  }
  results.push({ ac, name, ok: !error, ms: Date.now() - t, notes, error: error?.message });
  console.log(`${error ? 'FAIL' : 'ok  '} ${ac.padEnd(6)} ${name} (${Date.now() - t} ms)${notes.length ? `\n         ${notes.join('\n         ')}` : ''}${error ? `\n         ${error.stack.split('\n').slice(0, 12).join('\n         ')}` : ''}`);
  if (stopAfter && name.includes(stopAfter)) results.stopped = true;
}

// Helpers

async function newClient(name) {
  const c = new McpClient(home, { name });
  clients.push(c);
  await c.init();
  await until(`${name} in the sidebar`, async () => (await sb.text('#sessions'))?.includes(name));
  return c;
}
const tabs = () => sb.eval('return (await browser.tabs.query({})).map((t) => ({ id: t.id, url: t.url, active: t.active }))');
const tabId = async (url) => (await tabs()).find((t) => t.url.startsWith(url))?.id;
const message = () => sb.text('#message');
const grantsText = () => sb.text('#grants');
const hostPids = () => powershell(`Get-CimInstance Win32_Process -Filter "Name='kitewarden-host.exe'" | Where-Object { $_.ExecutablePath -eq '${home.exe}' } | ForEach-Object ProcessId`).split(/\s+/).filter(Boolean).map(Number);

const prompt = (answer) => f.prompt(answer);
const attach = (label, level, answer) => sb.attach(label, level, answer);
const card = () => sb.text('#cards .card');
const waitCard = () => sb.waitCard();
const answerCard = (allow) => sb.answerCard(allow);
const refOf = (outline, name) => new RegExp(`"${name}".*\\[(ref_\\w+)\\]`).exec(outline)?.[1];
const timed = async (p) => {
  const t = Date.now();
  const r = await p;
  return [r, Date.now() - t];
};
const link = () => sb.text('#link-title');
async function kill(pid) {
  process.kill(pid);
}

let c, d, idA, outline;
try {
  await f.navigate(`${A.origin}/`);
  await sb.open();
  const handleA = await f.handle();

  // Consent and connection

  await check('AC-09', 'before Connect no helper runs, and the sidebar and a client say so', async (note) => {
    assert.equal(await link(), 'Not connected');
    assert.deepEqual(hostPids(), []);
    const x = new McpClient(home, { name: 'early' });
    await x.init();
    const s = (await x.call('connection_status')).data;
    assert.equal(s.state, 'never_connected');
    note(s.next_step);
    assert.equal((await x.call('tabs_context')).code, 'not_connected');
    await x.close();
  });

  await check('AC-09', 'Connect in the sidebar starts the helper over native messaging', async (note) => {
    const t = Date.now();
    await sb.click('#connect');
    await until('connected', async () => (await link()) === 'Connected');
    note(`Firefox ${f.version}, connected after ${Date.now() - t} ms`);
    assert.equal(hostPids().length, 1);
  });

  c = await newClient('client-one');
  d = await newClient('client-two');

  await check('AC-09', 'connection_status reports every hop', async () => {
    const s = (await c.call('connection_status')).data;
    assert.equal(s.state, 'connected');
    assert.equal(s.mcp_server.version, VERSION);
    assert.equal(s.extension.version, VERSION);
    assert.deepEqual(s.helper, { state: 'connected', version: VERSION });
    assert.match(s.next_step, /attach a tab/);
  });

  // Grants

  await check('D3', 'an ungranted tab is only a number, and every tool refuses it', async () => {
    idA = await tabId(A.origin);
    const t = await c.call('tabs_context');
    assert.deepEqual(t.data.tabs, []);
    assert.ok(t.data.otherTabs >= 1);
    assert.ok(!t.text.includes('Fixture') && !t.text.includes('localhost'));
    for (const [tool, args] of [['read_page', {}], ['wait_for', { text: 'x' }], ['computer', { action: 'screenshot' }], ['computer', { action: 'left_click', ref: 'ref_x_1' }]]) {
      assert.equal((await c.call(tool, { tabId: idA, ...args })).code, 'no_grant', tool);
    }
    assert.deepEqual(A.reports, []);
  });

  await check('AC-01', 'declining the Firefox prompt makes no grant', async (note) => {
    note(`prompt: ${await attach('client-one', 'act', false)}`);
    assert.match(await message(), /did not allow/);
    assert.equal(await grantsText(), 'None');
    assert.equal((await c.call('read_page', { tabId: idA })).code, 'no_grant');
  });

  await check('AC-01', 'accepting the Firefox prompt makes the grant, for one session and one tab only', async (note) => {
    await attach('client-one', 'act', true);
    assert.equal(await message(), 'Attached.');
    const t = await c.call('tabs_context');
    assert.deepEqual(t.data.tabs.map((x) => [x.tabId, x.state, x.level, x.title, x.url]), [[idA, 'active', 'act', `Fixture ${A.port}`, `${A.origin}/`]]);
    const perms = await sb.eval('return browser.permissions.getAll()');
    note(`host permissions now: ${perms.origins.join(', ')}`);
    assert.deepEqual((await d.call('tabs_context')).data.tabs, []);
    assert.equal((await d.call('read_page', { tabId: idA })).code, 'conflict');
  });

  // Reading

  await check('AC-07', 'MCP: read_page returns a semantic outline, masks secrets, hides hidden elements, changes nothing', async (note) => {
    const before = await f.page('return document.documentElement.outerHTML');
    const r = await c.call('read_page', { tabId: idA });
    outline = r.text;
    note(outline.split('\n').slice(2, 9).join(' | '));
    assert.match(outline, /heading "Fixture page 3000|heading "Fixture page \d+" \[level 1\]/);
    assert.match(outline, /button "Count up" \[ref_/);
    assert.match(outline, /checkbox "Subscribe" \[checked\]/);
    assert.match(outline, /button "Disabled button" \[disabled\]/);
    assert.match(outline, /textbox "Name" value="Ada"/);
    assert.equal(outline.match(/value="\[secret\]"/g).length, 2);
    assert.match(outline, new RegExp(`ALPHA-${A.port}`));
    for (const bad of ['hunter2secret', '493817', 'Hidden link', 'Transparent text']) assert.ok(!outline.includes(bad), bad);
    assert.ok(outline.includes('FRAME-TEXT'), 'a frame of the same origin is read');
    assert.equal(outline.match(/<\/page_content>/g).length, 1, 'the imitated end marker is escaped');
    assert.equal(await f.page('return document.documentElement.outerHTML'), before);
    const cut = await c.call('read_page', { tabId: idA, max_chars: 200 });
    assert.match(cut.text, /The full outline has \d+ characters/);
    assert.equal(refOf((await c.call('read_page', { tabId: idA })).text, 'Count up'), refOf(outline, 'Count up'), 'refs stay the same');
  });

  await check('AC-07', 'MCP: wait_for finds text that appears later, and not finding it is a normal reply', async () => {
    const p = c.call('wait_for', { tabId: idA, text: 'LATE-TEXT', timeout_s: 8 });
    await sleep(800);
    await f.page('document.getElementById("late").textContent = "LATE-TEXT"');
    const r = await p;
    assert.equal(r.data.found, true);
    assert.ok(r.data.elapsed_ms > 500 && r.data.elapsed_ms < 4000);
    const n = await c.call('wait_for', { tabId: idA, text: 'NEVER', timeout_s: 1 });
    assert.equal(n.data.found, false);
    assert.equal((await c.call('wait_for', { tabId: idA, text: 'hunter2secret', timeout_s: 0.5 })).data.found, false);
  });

  // Approved click, both entry points

  await check('AC-07', 'MCP: an approved click happens once and the page confirms it', async (note) => {
    const p = c.call('computer', { action: 'left_click', tabId: idA, ref: refOf(outline, 'Count up'), reason: 'Test click' });
    const text = await waitCard();
    note(`card: ${text}`);
    assert.match(text, /Client client-one 1 .* wants to click/);
    assert.match(text, /button "Count up"/);
    assert.match(text, new RegExp(A.origin));
    await answerCard(true);
    const r = await p;
    assert.equal(r.code, null, r.text);
    note(`reply: ${JSON.stringify(r.data)}`);
    await until('report of the page', () => A.reports.length);
    assert.deepEqual(A.reports, ['count=1;trusted=false']);
    assert.equal(await f.page('return document.getElementById("n").textContent'), '1');
  });

  await check('D3', 'a denied click does not happen', async () => {
    const p = c.call('computer', { action: 'left_click', tabId: idA, ref: refOf(outline, 'Count up') });
    await answerCard(false);
    assert.equal((await p).code, 'approval_denied');
    await sleep(300);
    assert.equal(A.reports.length, 1);
  });

  await check('AC-09', 'an approval cannot be rushed, typed or forged by the page or by a copy of the sidebar page', async (note) => {
    let p = c.call('computer', { action: 'left_click', tabId: idA, ref: refOf(outline, 'Count up') });
    await waitCard();
    const shown = Date.now();
    await sb.click('.card .allow');
    note(`first click ${Date.now() - shown} ms after the card was seen`);
    await sleep(800);
    assert.ok(await card(), 'a click in the first 500 ms does not count');
    await sb.click('.card .deny');
    assert.equal((await p).code, 'approval_denied');

    p = c.call('computer', { action: 'left_click', tabId: idA, ref: refOf(outline, 'Count up') });
    await waitCard();
    await sleep(700);
    const keys = ['a', 's', 'd', 'y', '', ' '].flatMap((value) => [{ type: 'keyDown', value }, { type: 'keyUp', value }]);
    // Keys with the focus in the page, then with the focus in the sidebar but on no button.
    await f.m.send('Marionette:SetContext', { value: 'content' });
    await f.m.send('WebDriver:PerformActions', { actions: [{ type: 'key', id: 'k', actions: keys }] });
    await sb.click('#tab');
    note(`focus in the sidebar: ${await sb.eval('return document.activeElement.tagName')}`);
    await f.m.send('Marionette:SetContext', { value: 'chrome' });
    await f.m.send('WebDriver:PerformActions', { actions: [{ type: 'key', id: 'k', actions: keys }] });
    await f.page('clickAll(); for (const key of ["a", "s", "d", "y", "Enter", " "]) document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))');
    await sb.eval('for (const b of document.querySelectorAll(".card button")) b.dispatchEvent(new MouseEvent("click", { bubbles: true }))');
    const copy = await f.chrome('return WebExtensionPolicy.getByID(arguments[0]).getURL("sidebar/sidebar.html")', addon);
    const here = await f.handle();
    await f.tab();
    await f.chrome(`gBrowser.selectedBrowser.fixupAndLoadURIString(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() })`, copy);
    const refused = await until('copy refused', () => f.chrome(`
      const b = gBrowser.selectedBrowser;
      if (!b.currentURI.spec.startsWith('moz-extension:')) return null;
      const t = await b.browsingContext.currentWindowGlobal.getActor('MarionetteCommands').executeScript('return document.getElementById("link-title")?.textContent', [], { sandboxName: null, timeout: 5000 });
      return /restarted/.test(t) ? t : null;`).catch(() => null), 8000, 200);
    note(`copy in a tab: ${refused}`);
    await f.m.send('Marionette:SetContext', { value: 'content' });
    await f.m.send('WebDriver:CloseWindow');
    await f.select(here);
    assert.ok(await card(), 'the card is still open');
    const before = A.reports.length;
    await sb.click('.card .deny');
    assert.equal((await p).code, 'approval_denied');
    assert.equal(A.reports.length, before);
  });

  await check('AC-09', 'sidebar: read, then an approved click with its result shown, through the same path', async (note) => {
    await attach('This sidebar', 'act', null);
    await until('Try it', () => sb.eval('return !document.getElementById("try").hidden'));
    await sb.click('#try-read');
    await until('outline', async () => (await sb.text('#try-output'))?.includes('Count up'));
    assert.ok(!(await sb.text('#try-output')).includes('hunter2secret'));
    const value = await sb.eval('return [...document.querySelectorAll("#try-ref option")].find((o) => o.textContent.includes("Count up")).value');
    await sb.choose('#try-ref', value);
    const before = A.reports.length;
    await sb.click('#try-click');
    const text = await waitCard();
    assert.match(text, /This sidebar wants to click/);
    await answerCard(true);
    const done = await until('result', async () => /^Clicked/.test(await sb.text('#try-state')) && sb.text('#try-state'));
    note(done);
    await until('report of the page', () => A.reports.length > before);
    assert.match(A.reports.at(-1), /^count=\d+;trusted=false$/);
  });

  await check('D3', 'level read refuses a click, in both entry points', async () => {
    await attach('This sidebar', 'read', null);
    await sb.click('#try-read');
    await until('read', async () => (await sb.text('#try-state')) === 'Done');
    await sb.click('#try-click');
    await until('refused', async () => /read_only_grant/.test(await sb.text('#try-state')));
    await c.call('tabs_release', { tabId: idA });
    await attach('client-two', 'read', null);
    const o = (await d.call('read_page', { tabId: idA })).text;
    assert.equal((await d.call('computer', { action: 'left_click', tabId: idA, ref: refOf(o, 'Count up') })).code, 'read_only_grant');
    assert.equal(await card(), null);
    await d.call('tabs_release', { tabId: idA });
    await attach('client-one', 'act', null);
    outline = (await c.call('read_page', { tabId: idA })).text;
  });

  await check('D3', 'what may not be clicked: script link, disabled button, covered button, element swapped after approval, stale ref', async (note) => {
    const click = (name) => c.call('computer', { action: 'left_click', tabId: idA, ref: refOf(outline, name) });
    assert.equal((await click('Script link')).code, 'not_allowed');
    assert.equal((await click('Disabled button')).code, 'not_actionable');
    await f.page('const o = document.createElement("div"); o.id = "veil"; o.style.cssText = "position:fixed;inset:0"; document.body.append(o)');
    let p = click('Count up');
    await answerCard(true);
    const covered = await p;
    note(covered.text);
    assert.equal(covered.code, 'covered');
    await f.page('document.getElementById("veil").remove()');
    const before = A.reports.length;
    p = click('Count up');
    await waitCard();
    await f.page('document.getElementById("count").textContent = "Delete everything"');
    await answerCard(true);
    assert.equal((await p).code, 'stale_ref');
    assert.equal(A.reports.length, before);
    await f.navigate(`${A.origin}/`);
    assert.equal((await click('Count up')).code, 'stale_ref');
    assert.equal(await card(), null);
  });

  await check('AC-07', 'an approved click on a link of the same site reports the navigation', async (note) => {
    outline = (await c.call('read_page', { tabId: idA })).text;
    const p = c.call('computer', { action: 'left_click', tabId: idA, ref: refOf(outline, 'Same site link') });
    await answerCard(true);
    const r = await p;
    note(r.text.replace(/\s+/g, ' '));
    assert.equal(r.data?.page, 'navigated', r.text);
    assert.match((await c.call('read_page', { tabId: idA })).text, /Second page/);
    await f.navigate(`${A.origin}/`);
  });

  // Session tabs

  await check('D3', 'session-owned tabs: a blank tab on request, and a tab that an approved click opens', async (note) => {
    const chosen = await sb.eval('return [...document.querySelectorAll("#session option")].find((o) => o.textContent.includes("client-two")).value');
    await sb.choose('#session', chosen);
    const e = await newClient('client-three');
    assert.equal(await sb.eval('return document.getElementById("session").value'), chosen, 'a new client does not change the choice');
    const t = (await e.call('tabs_context', { createIfEmpty: true })).data;
    assert.deepEqual(t.tabs.map((x) => [x.owned, x.state]), [[true, 'no_grant']]);
    assert.equal((await e.call('read_page', { tabId: t.tabs[0].tabId })).code, 'no_grant');
    assert.deepEqual((await c.call('tabs_context')).data.tabs.map((x) => x.tabId), [idA]);
    await e.close();
    await until('session gone', async () => !(await sb.text('#sessions')).includes('client-three'));
    outline = (await c.call('read_page', { tabId: idA })).text;
    const p = c.call('computer', { action: 'left_click', tabId: idA, ref: refOf(outline, 'New tab link') });
    await answerCard(true);
    const r = (await p).data;
    assert.equal(r.page, 'opened a tab');
    const owned = async () => (await c.call('tabs_context')).data.tabs.find((x) => x.tabId === r.opened_tab);
    const o = await until('the new tab is listed', async () => ((await owned())?.state === 'active' ? owned() : null));
    assert.deepEqual([o.owned, o.level, o.url], [true, 'act', `${A.origin}/second`]);
    assert.match((await c.call('read_page', { tabId: r.opened_tab })).text, /Second page/);
    assert.equal((await d.call('read_page', { tabId: r.opened_tab })).code, 'conflict');
    await sb.eval('await browser.tabs.remove(arguments[0])', r.opened_tab);
    await until('its grant is gone', async () => !(await owned()));
    await f.select(handleA);

    // The same click, but the link leaves the origin: the tab belongs to the session and stays closed to it.
    await f.page('document.getElementById("blank").href = arguments[0]', `${B.origin}/`);
    outline = (await c.call('read_page', { tabId: idA })).text;
    const q = c.call('computer', { action: 'left_click', tabId: idA, ref: refOf(outline, 'New tab link') });
    assert.match(await waitCard(), new RegExp(`Link${B.origin}/`));
    await answerCard(true);
    const s = (await q).data;
    await until('suspended', async () => (await c.call('tabs_context')).data.tabs.find((x) => x.tabId === s.opened_tab)?.state === 'suspended');
    const listed = (await c.call('tabs_context')).data.tabs.find((x) => x.tabId === s.opened_tab);
    assert.equal(listed.url, undefined);
    assert.equal((await c.call('read_page', { tabId: s.opened_tab })).code, 'grant_suspended');
    note(`new tab on another origin: ${JSON.stringify(listed)}`);
    await sb.eval('await browser.tabs.remove(arguments[0])', s.opened_tab);
    for (const t of await tabs()) if (t.url === 'about:blank') await sb.eval('await browser.tabs.remove(arguments[0])', t.id);
    await f.select(handleA);
  });

  // Screenshots

  const pixels = (b64, points) =>
    f.page(
      `const i = await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + arguments[0])).blob());
       const k = new OffscreenCanvas(i.width, i.height).getContext('2d'); k.drawImage(i, 0, 0);
       return [i.width, i.height, innerWidth, innerHeight, ...arguments[1].map(([x, y]) => [...k.getImageData(x * i.width / innerWidth, y * i.height / innerHeight, 1, 1).data].slice(0, 3))];`,
      b64,
      points,
    );
  const shoot = (id = idA) => c.call('computer', { action: 'screenshot', tabId: id });
  const image = (r) => r.content.find((x) => x.type === 'image')?.data;
  const toolbar = () =>
    f.chrome(`
      const r = document.getElementById('firefox_fireiscoolsolo_github_io-BAP').getBoundingClientRect();
      for (const t of ['mousemove', 'mousedown', 'mouseup']) window.synthesizeMouseEvent(t, r.left + r.width / 2, r.top + r.height / 2, { button: 0, clickCount: t === 'mousemove' ? 0 : 1 });`);

  await check('FC-SHOT', 'a grant alone gives no picture; the toolbar button on the tab does, until it navigates', async (note) => {
    await f.navigate(`${A.origin}/wide`);
    const refused = await shoot();
    assert.equal(refused.code, 'permission_required');
    await toolbar();
    await sleep(500);
    const r = await shoot();
    assert.equal(r.code, null, r.text);
    note(r.text);
    const [w, h, iw, ih, red, white, secret, frame] = await pixels(image(r), [[50, 50], [150, 50], [275, 20], [450, 90]]);
    note(`picture ${w}x${h} of a ${iw}x${ih} viewport, red square ${red}, background ${white}, password field ${secret}, frame ${frame}`);
    assert.ok(red[0] > 200 && red[1] < 60, 'red square');
    assert.ok(white.every((v) => v > 230), 'background');
    assert.ok(secret.every((v) => v < 40), 'the password field is covered');
    assert.ok(frame.every((v) => v > 200), 'a frame of the granted origin is shown');
    writeFileSync(path.join(out, 'screenshot.jpg'), Buffer.from(image(r), 'base64'));
    assert.ok(!(await f.page('return document.documentElement.outerHTML')).includes('popover'), 'the cover is gone');
    await f.navigate(`${A.origin}/wide?again`);
    assert.equal((await shoot()).code, 'permission_required');
  });

  await check('FC-SHOT', 'with all sites allowed, a background tab is captured without switching to it', async (note) => {
    await sb.eval('document.querySelector("#d-screens").open = true');
    await sb.click('#screens');
    note(`prompt: ${await prompt(true)}`);
    await until('allowed', async () => /are allowed/.test(await message()));
    await f.tab(`${B.origin}/`);
    const active = (await tabs()).find((t) => t.active).id;
    const r = await shoot();
    assert.equal(r.code, null, r.text);
    assert.match(r.text, /captureTab/);
    const [, , , , red] = await pixels(image(r), [[50, 50]]);
    assert.ok(red[0] > 200 && red[1] < 60, `red square ${red}`);
    assert.equal((await tabs()).find((t) => t.active).id, active);
    assert.equal((await shoot(active)).code, 'no_grant', 'all sites allowed is no grant');
    await f.m.send('WebDriver:CloseWindow');
    await f.select(handleA);
    await sb.eval('await browser.permissions.remove({ origins: ["<all_urls>"] })');
    assert.equal((await shoot()).code, 'permission_required');
  });

  // Origin change, revoke, pause

  await check('AC-05', 'another origin suspends the grant and ends a waiting call and a waiting approval', async (note) => {
    await f.navigate(`${A.origin}/`);
    outline = (await c.call('read_page', { tabId: idA })).text;
    const wait = c.call('wait_for', { tabId: idA, text: 'NEVER', timeout_s: 30 });
    const click = c.call('computer', { action: 'left_click', tabId: idA, ref: refOf(outline, 'Count up') });
    await waitCard();
    await f.navigate(`${B.origin}/`);
    const [[r1, t1], [r2]] = await Promise.all([timed(wait), timed(click)]);
    assert.deepEqual([r1.code, r2.code], ['grant_suspended', 'grant_suspended']);
    note(`both ended within ${t1} ms after the new page had loaded`);
    await until('the card is gone', async () => !(await card()));
    const read = await c.call('read_page', { tabId: idA });
    assert.equal(read.code, 'grant_suspended');
    assert.ok(!read.text.includes('ALPHA'));
    const t = (await c.call('tabs_context')).data.tabs[0];
    assert.equal(t.state, 'suspended');
    assert.equal(t.url, undefined);
    assert.equal(t.title, undefined);
    assert.match(await grantsText(), /suspended: other site/);
    assert.deepEqual(B.reports, []);
    const row = await sb.eval('return [...document.querySelectorAll("#grants li")].findIndex((l) => l.textContent.includes("client-one"))');
    const text = await sb.eval('return document.querySelectorAll("#grants li")[arguments[0]].querySelector(".approve").textContent', row);
    assert.equal(text, `Approve ${B.origin}`);
    const nth = await sb.eval('return [...document.querySelectorAll("#grants .approve")].indexOf(document.querySelectorAll("#grants li")[arguments[0]].querySelector(".approve"))', row);
    await sb.click('#grants .approve', nth);
    await until('approved', async () => (await c.call('tabs_context')).data.tabs[0].state === 'active');
    assert.match((await c.call('read_page', { tabId: idA })).text, new RegExp(`ALPHA-${B.port}`));
    assert.equal((await d.call('read_page', { tabId: idA })).code, 'conflict');
    await f.navigate('about:support');
    assert.equal((await c.call('read_page', { tabId: idA })).code, 'restricted_page');
    await f.navigate(`${A.origin}/`);
    assert.equal((await c.call('read_page', { tabId: idA })).code, 'grant_suspended', 'coming back does not resume by itself');
  });

  const revokeOf = (label) => sb.eval('return [...document.querySelectorAll("#grants li")].findIndex((l) => l.textContent.includes(arguments[0]))', label);

  await check('AC-06', 'revoke ends a running call within 1 s, and the page keeps nothing', async (note) => {
    await sb.click('#revoke-all');
    await until('none', async () => (await grantsText()) === 'None');
    await attach('client-one', 'act', null);
    outline = (await c.call('read_page', { tabId: idA })).text;
    const ref = refOf(outline, 'Count up');
    const wait = c.call('wait_for', { tabId: idA, text: 'NEVER', timeout_s: 10 });
    await sleep(700);
    const t = Date.now();
    await sb.click('#grants .revoke', await revokeOf('client-one'));
    assert.equal((await wait).code, 'no_grant');
    note(`ended ${Date.now() - t} ms after the click`);
    assert.ok(Date.now() - t < 1000);
    assert.equal((await c.call('read_page', { tabId: idA })).code, 'no_grant');
    assert.deepEqual((await c.call('tabs_context')).data.tabs, []);
    await attach('client-one', 'act', null);
    assert.equal((await c.call('computer', { action: 'left_click', tabId: idA, ref })).code, 'stale_ref', 'refs of the earlier grant are gone');
    const fresh = refOf((await c.call('read_page', { tabId: idA })).text, 'Count up');
    assert.notEqual(fresh, ref);
    const before = A.reports.length;
    const p = c.call('computer', { action: 'left_click', tabId: idA, ref: fresh });
    await answerCard(true);
    assert.equal((await p).code, null);
    await until('the new grant works for a click', () => A.reports.length > before);
  });

  await check('PM9', 'pause ends running calls within 1 s and refuses all but connection_status, resume only in the sidebar', async (note) => {
    const wait = c.call('wait_for', { tabId: idA, text: 'NEVER', timeout_s: 20 });
    await sleep(500);
    const t = Date.now();
    await sb.click('#pause');
    assert.equal((await wait).code, 'paused');
    note(`ended ${Date.now() - t} ms after the click`);
    assert.ok(Date.now() - t < 1000);
    for (const [tool, args] of [['tabs_context', {}], ['read_page', { tabId: idA }]]) assert.equal((await c.call(tool, args)).code, 'paused');
    const s = (await c.call('connection_status')).data;
    assert.equal(s.state, 'paused');
    note(s.next_step);
    assert.match(await link(), /^Paused/);
    await sb.click('#pause');
    await until('resumed', async () => (await c.call('connection_status')).data.state === 'connected');
    assert.equal((await c.call('read_page', { tabId: idA })).code, null);
  });

  await check('FC-CONN', 'disconnecting one client ends its call and its grants; the other client goes on', async () => {
    await c.call('tabs_release', { tabId: idA });
    await attach('client-two', 'read', null);
    const wait = d.call('wait_for', { tabId: idA, text: 'NEVER', timeout_s: 20 });
    await sleep(400);
    const i = await sb.eval('return [...document.querySelectorAll("#sessions li")].findIndex((l) => l.textContent.includes("client-two"))');
    await sb.click('#sessions .end', i);
    const r = await wait;
    assert.equal(r.code, 'stopped');
    await attach('client-one', 'act', null);
    assert.equal((await c.call('read_page', { tabId: idA })).code, null);
    assert.equal((await d.call('read_page', { tabId: idA })).code, 'session_ended');
    assert.equal((await d.call('read_page', { tabId: idA })).code, 'conflict');
  });

  // Host loss and recovery

  await check('AC-02', 'a killed helper: outcome_unknown within 2 s, a new helper within 5 s, session_ended, then a new grant works', async (note) => {
    const [old] = hostPids();
    const before = A.reports.length;
    const wait = c.call('wait_for', { tabId: idA, text: 'NEVER', timeout_s: 30 });
    await sleep(500);
    const t = Date.now();
    await kill(old);
    assert.equal((await wait).code, 'outcome_unknown');
    const lost = Date.now() - t;
    const shown = await until('the sidebar shows the loss', async () => /Helper stopped|Connecting/.test(await link()) && link(), 2000, 20).catch(() => 'not caught');
    await until('connected again', async () => (await link()) === 'Connected', 5000 - (Date.now() - t));
    const back = Date.now() - t;
    const [pid] = hostPids();
    note(`call ended after ${lost} ms, sidebar showed "${shown}", new helper ${old} -> ${pid} after ${back} ms`);
    assert.ok(lost < 2000 && back < 5000 && pid !== old);
    assert.equal(await grantsText().then((g) => g.includes('client-one')), false);
    assert.equal((await c.call('computer', { action: 'left_click', tabId: idA, ref: refOf(outline, 'Count up') })).code, 'session_ended');
    assert.equal((await c.call('read_page', { tabId: idA })).code, 'no_grant');
    assert.equal(A.reports.length, before, 'no page was touched');
    await until('client-one is listed again', async () => (await sb.text('#sessions')).includes('client-one'));
    await attach('client-one', 'act', null);
    assert.match((await c.call('read_page', { tabId: idA })).text, /Count up/);
  });

  await check('FC-CONN', 'a helper killed right after an approved click: the click is not repeated', async (note) => {
    const before = A.reports.length;
    const [pid] = hostPids();
    const p = c.call('computer', { action: 'left_click', tabId: idA, ref: refOf((await c.call('read_page', { tabId: idA })).text, 'Count up') });
    await answerCard(true);
    await kill(pid);
    const r = await p;
    const counted = A.reports.length - before;
    note(`reply: ${r.code ?? 'ok'}, page counted ${counted}`);
    assert.ok([null, 'outcome_unknown'].includes(r.code) && counted <= 1);
    await until('connected again', async () => (await link()) === 'Connected');
    await c.call('connection_status');
    await sleep(3000);
    assert.equal(A.reports.length - before, counted);
  });

  await check('FC-CONN', 'a client that dies with a card open takes the card and its grant with it', async (note) => {
    const e = await newClient('client-four');
    await attach('client-four', 'act', null);
    e.request('tools/call', { name: 'computer', arguments: { action: 'left_click', tabId: idA, ref: refOf((await e.call('read_page', { tabId: idA })).text, 'Count up') } });
    await waitCard();
    const t = Date.now();
    e.child.kill();
    await until('card gone', async () => !(await card()), 2000, 20);
    note(`card gone ${Date.now() - t} ms after the client was killed`);
    assert.ok(!(await grantsText()).includes('client-four'));
    assert.ok((await tabs()).some((x) => x.id === idA), 'the tab stays open');
  });

  await check('AC-09', 'Disconnect stops the helper, and Connect starts it again', async (note) => {
    await sb.click('#disconnect');
    await until('not connected', async () => (await link()) === 'Not connected');
    await until('helper gone', () => hostPids().length === 0);
    const s = (await c.call('connection_status')).data;
    assert.equal(s.state, 'disconnected_by_user');
    note(s.next_step);
    await sleep(2500);
    assert.equal(hostPids().length, 0, 'it does not come back by itself');
    await sb.click('#connect');
    await until('connected', async () => (await link()) === 'Connected');
  });

  await check('AC-09', 'recovery states: helper missing, Retry now, refused for unsafe permissions, other version', async (note) => {
    const manifest = path.join(home.dir, 'native-manifest.json');
    renameSync(manifest, `${manifest}.off`);
    await kill(hostPids()[0]);
    await until('missing', async () => (await link()) === 'Helper not installed');
    note(`missing: ${await sb.text('#link-detail')}`);
    renameSync(`${manifest}.off`, manifest);
    const t = Date.now();
    await sb.click('#retry');
    await until('connected', async () => (await link()) === 'Connected');
    note(`Retry now: connected after ${Date.now() - t} ms`);

    const key = path.join(home.dir, 'key.bin');
    execFileSync('icacls', [key, '/grant', '*S-1-1-0:(R)']);
    await kill(hostPids()[0]);
    await until('refused', async () => (await link()) === 'The helper refused to start');
    note(`refused: ${(await sb.text('#link-detail')).replaceAll(home.dir, '<home>')}`);
    assert.match(await sb.text('#link-detail'), /Everyone/);
    assert.equal(host('doctor', '--home', home.dir).status, 1);
    execFileSync('icacls', [key, '/remove', '*S-1-1-0']);
    await until('connected', async () => (await link()) === 'Connected', 35_000, 200);

    const other = readFileSync(path.join(root, 'host/native/Host.cs'), 'utf8').replace(/Protocol = (\d+)/, (_, v) => `Protocol = ${Number(v) + 1}`);
    const src = path.join(home.dir, 'other.cs');
    writeFileSync(src, other);
    await kill(hostPids()[0]);
    await sb.click('#disconnect');
    await until('helper gone', () => hostPids().length === 0);
    execFileSync(path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/platform:x64', `/out:${home.exe}`, '/r:System.Web.Extensions.dll', '/r:System.Core.dll', src, path.join(root, 'host/native/Setup.cs'), path.join(root, 'host/native/Chat.cs'), path.join(root, 'host/native/Files.cs')]);
    await sb.click('#connect');
    await until('versions differ', async () => (await link()) === 'Versions differ');
    note(`versions: ${await sb.text('#link-detail')}`);
    assert.match(await sb.text('#link-detail'), /add-on is older/);
    assert.equal((await c.call('read_page', { tabId: idA })).code === null, false);
    await sb.click('#disconnect');
    await until('off', async () => (await link()) === 'Not connected');
    await until('helper gone', () => hostPids().length === 0);
    copyFileSync(path.join(root, 'dist/host/kitewarden-host.exe'), home.exe);
    rmSync(src);
    await sb.click('#connect');
    await until('connected', async () => (await link()) === 'Connected');
  });

  // Permission taken away in about:addons

  await check('AC-01', 'removing the site in about:addons suspends the grant within 1 s', async (note) => {
    await c.call('connection_status');
    assert.equal((await c.call('read_page', { tabId: idA })).code, 'session_ended');
    await attach('client-one', 'act', null);
    assert.equal((await c.call('read_page', { tabId: idA })).code, null);
    const here = await f.handle();
    await f.tab('about:addons');
    await f.chrome(`gBrowser.selectedBrowser.contentWindow.gViewController.loadView('detail/' + arguments[0] + '/permissions')`, addon).catch((e) => note(`loadView: ${e.message.split('\n')[0]}`));
    const toggle = await until('the toggle of the site', () => f.chrome(`
      const doc = gBrowser.selectedBrowser.contentDocument;
      const t = [...doc.querySelectorAll('moz-toggle, moz-checkbox, input')].find((x) => (x.getAttribute('permission-key') ?? '') === 'http://localhost/*');
      return t ? [t.localName, t.pressed ?? t.checked] : null;`), 8000, 200);
    note(`about:addons shows ${JSON.stringify(toggle)} for http://localhost/*`);
    const t = Date.now();
    await f.chrome(`[...gBrowser.selectedBrowser.contentDocument.querySelectorAll('moz-toggle, moz-checkbox, input')].find((x) => x.getAttribute('permission-key') === 'http://localhost/*').click()`);
    await until('suspended', async () => /Firefox took the permission away/.test(await grantsText()), 3000, 20);
    note(`suspended ${Date.now() - t} ms after the click`);
    assert.ok(Date.now() - t < 1000);
    assert.equal((await c.call('read_page', { tabId: idA })).code, 'permission_required');
    assert.deepEqual((await c.call('connection_status')).data.missing_permissions, [A.origin]);
    await f.m.send('Marionette:SetContext', { value: 'content' });
    await f.m.send('WebDriver:CloseWindow');
    await f.select(here);
    await sb.click('#grants .approve');
    note(`approve asks again: ${await prompt(true)}`);
    await until('active again', async () => (await c.call('read_page', { tabId: idA })).code === null);
  });

  // Restart of the add-on, which a temporary add-on can do

  await check('AC-06', 'after the add-on restarts no grant exists, and the helper comes back by itself', async (note) => {
    await f.install(path.join(root, 'dist/extension'));
    await sleep(1000);
    await sb.open();
    const t = Date.now();
    await until('connected', async () => (await link()) === 'Connected', 15_000);
    note(`reconnected without a click, ${Date.now() - t} ms after the sidebar reopened`);
    assert.equal(await grantsText(), 'None');
    assert.equal((await c.call('read_page', { tabId: idA })).code, 'session_ended');
    assert.equal((await c.call('read_page', { tabId: idA })).code, 'no_grant');
  });

  await check('D2', 'no bridge process listens on TCP or UDP during a session, and the helper has no window', async () => {
    const p = [...hostPids(), c.child.pid].join(',');
    assert.equal(powershell(`$p = ${p}; "$(@(Get-NetTCPConnection -OwningProcess $p -ErrorAction SilentlyContinue | Where-Object State -eq Listen).Count) $(@(Get-NetUDPEndpoint -OwningProcess $p -ErrorAction SilentlyContinue).Count) $(@(Get-Process -Id ${hostPids()[0]} | Where-Object MainWindowHandle -ne 0).Count)"`), '0 0 0');
    assert.equal(host('doctor', '--home', home.dir).status, 0);
  });

  await check('AC-01', 'record: which permissions Firefox accepts as optional in Manifest V2', async (note) => {
    const asked = ['<all_urls>', 'activeTab', 'alarms', 'bookmarks', 'browserSettings', 'browsingData', 'captivePortal', 'clipboardRead', 'clipboardWrite', 'contextualIdentities', 'cookies', 'devtools', 'downloads', 'downloads.open', 'find', 'geolocation', 'history', 'idle', 'management', 'menus', 'menus.overrideContext', 'nativeMessaging', 'notifications', 'pageCapture', 'pkcs11', 'privacy', 'proxy', 'scripting', 'search', 'sessions', 'storage', 'tabGroups', 'tabHide', 'tabs', 'theme', 'topSites', 'unlimitedStorage', 'userScripts', 'webNavigation', 'webRequest', 'webRequestBlocking', 'webRequestFilterResponse'];
    const dir = path.join(home.dir, '..', 'optional');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 2, name: 'optional probe', version: '1', browser_specific_settings: { gecko: { id: 'optional@fireiscoolsolo.github.io' } }, optional_permissions: asked }));
    const id = await f.install(dir);
    const got = await f.chrome('return WebExtensionPolicy.getByID(arguments[0]).extension.manifest.optional_permissions', id);
    note(`accepted: ${got.join(', ')}`);
    note(`refused as optional: ${asked.filter((p) => !got.includes(p)).join(', ')}`);
    assert.ok(got.length > 5);
  });

  await check('D2', 'another add-on cannot start the helper', async (note) => {
    const dir = path.join(home.dir, '..', 'other');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 2, name: 'other', version: '1', browser_specific_settings: { gecko: { id: 'other@fireiscoolsolo.github.io' } }, permissions: ['nativeMessaging'], background: { scripts: ['b.js'] } }));
    writeFileSync(path.join(dir, 'b.js'), `browser.runtime.connectNative('kitewarden').onDisconnect.addListener((p) => fetch('${A.origin}/report?other=' + encodeURIComponent(p.error?.message), { mode: 'no-cors' }));`);
    const pids = hostPids().join();
    await f.install(dir);
    const said = await until('refusal', () => A.reports.find((r) => r.startsWith('other=')));
    note(said);
    assert.match(said, /No such native application/);
    assert.equal(hostPids().join(), pids);
  });

  await check('AC-09', 'when Firefox closes, the helper ends and a client says so', async (note) => {
    await f.quit();
    f.closed = true;
    await until('helper gone', () => hostPids().length === 0);
    const s = (await c.call('connection_status')).data;
    assert.equal(s.state, 'firefox_closed');
    note(s.next_step);
    assert.equal((await c.call('tabs_context')).code, 'not_connected');
  });
} finally {
  for (const x of clients) x.child.kill();
  if (!f.closed) await f.quit().catch((e) => console.error('quit', e.message));
  await A.close();
  await B.close();
  await home.close();
  const failed = results.filter((r) => !r.ok);
  writeFileSync(path.join(out, 'firefox.json'), JSON.stringify({ firefox: f.version, headless: f.capabilities['moz:headless'], at: new Date().toISOString(), seconds: Math.round((Date.now() - start) / 1000), results }, null, 1));
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
}
