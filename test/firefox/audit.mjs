// Prompt 7 in the installed Firefox: tabs, site rules, lists, clipboard, saved prompts, file and shell tools, sidebar cases.
// Disposable profile, temporary add-on, installed helper, real clicks in the real sidebar. Claude Code is a TEST DOUBLE.
// The clipboard is that of headless Firefox, never the one of Windows.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpClient, fakeClaude, installHome, powershell, root, sleep, until } from '../helpers.mjs';
import { Firefox, Sidebar } from './firefox.mjs';
import { fixture } from './fixtures.mjs';

const stopAfter = process.argv[2];
const results = [];
const out = path.join(root, 'test-results');
mkdirSync(out, { recursive: true });
const start = Date.now();
const home = installHome();
const double = fakeClaude();
const config = mkdtempSync(path.join(os.tmpdir(), 'fc-config-'));
const A = await fixture(3000);
const SUB = `http://b.localhost:${A.port}`; // another host of the same server
const f = await Firefox.start({ headed: false, env: { PATH: `${double.dir};${process.env.PATH}`, CLAUDE_CONFIG_DIR: config } });
const addon = await f.install(path.join(root, 'dist/extension'));
const sb = new Sidebar(f, addon);
let c;
let tab;

async function check(row, name, fn) {
  if (results.stopped) return;
  await c?.pace();
  const t = Date.now();
  const notes = [];
  let error = null;
  try {
    await fn((n) => notes.push(n));
  } catch (e) {
    error = e;
    notes.push(`sidebar: ${(await Promise.race([sb.text('body').catch((x) => x.message), sleep(3000).then(() => 'no answer')])).replace(/\s+/g, ' ').slice(0, 700)}`);
    for (let i = await Promise.race([sb.eval('return document.querySelectorAll("#cards .card").length').catch(() => 0), sleep(3000).then(() => 0)]); i > 0; i--) await sb.answerCard(false).catch(() => {});
  }
  results.push({ row, name, ok: !error, ms: Date.now() - t, notes, error: error?.message });
  console.log(`${error ? 'FAIL' : 'ok  '} ${row.padEnd(8)} ${name} (${Date.now() - t} ms)${notes.map((n) => `\n         ${n}`).join('')}${error ? `\n         ${error.stack.split('\n').filter((l) => !/node:internal/.test(l)).slice(0, 12).join('\n         ')}` : ''}`);
  if (stopAfter && name.includes(stopAfter)) results.stopped = true;
}
const call = (tool, args = {}) => c.call(tool, { tabId: tab, ...args });
const code = async (p) => (await p).code ?? 'ok';
const act = async (tool, args, yes = true) => {
  const p = call(tool, args);
  let over = false;
  p.then(() => (over = true));
  await until('card or answer', async () => over || sb.text('#cards .card').catch(() => null), 8000, 30);
  if (!over) await sb.answerCard(yes);
  return p;
};
const refOf = async (name) => {
  const o = (await call('read_page', {})).text;
  return new RegExp(`"${name}".*\\[(ref_\\w+)\\]`).exec(o)?.[1] ?? assert.fail(`no ${name} in ${o}`);
};
const message = () => sb.text('#message');
const clear = () => sb.eval('document.querySelector("#message").textContent = ""');
const open = (id) => sb.eval('for (let e = document.getElementById(arguments[0]); e; e = e.parentElement) if (e.tagName === "DETAILS") e.open = true', id);
const reported = (what) => until(`report ${what}`, () => A.reports.includes(what), 4000);
const badge = () => f.chrome('return document.getElementById("bridge_firefox-companion_invalid-BAP").getAttribute("badge")');
const set = (sel, v) => sb.eval('const i = document.querySelector(arguments[0]); i.value = arguments[1]; i.dispatchEvent(new Event("input"))', sel, v);
const rule = async (kind, host) => {
  await open('rule-add');
  await set('#rule-host', host);
  await sb.choose('#rule-kind', kind);
  await clear();
  await sb.click('#rule-add');
  await until('added', async () => /Added/.test(await message()));
};
const noRules = async () => {
  await open('rule-add');
  while (await sb.eval('return document.querySelectorAll("#rules .rule-remove").length')) {
    await clear();
    await sb.click('#rules .rule-remove');
    await until('removed', async () => /Removed/.test(await message()));
  }
};
/** Approves the site again, if the grant is suspended. */
const approve = async () => {
  if (!(await sb.eval('return document.querySelectorAll("#grants .approve").length'))) return;
  await clear();
  await sb.click('#grants .approve');
  await until('approved', async () => /Approved/.test(await message()));
};
const go = async (url) => {
  await f.navigate(url);
  await sleep(300);
};
const tabsOf = () => f.chrome('return gBrowser.tabs.map((t) => [t.linkedBrowser.currentURI.spec, t.pinned, t.muted === true])');
const windows = () => f.chrome('return [...Services.wm.getEnumerator("navigator:browser")].length');
const clipboard = () => f.chrome(`
  const t = Cc['@mozilla.org/widget/transferable;1'].createInstance(Ci.nsITransferable);
  t.init(null);
  t.addDataFlavor('text/plain');
  Services.clipboard.getData(t, Services.clipboard.kGlobalClipboard);
  const data = {};
  try { t.getTransferData('text/plain', data); } catch { return null; }
  return data.value?.QueryInterface(Ci.nsISupportsString).data ?? null;`);
const chatText = () => sb.text('#chat-items');
const type = (text) => sb.eval('document.getElementById("prompt").value = arguments[0]', text);
const idle = () => until('the run ended', () => sb.eval('return document.getElementById("stop").hidden'), 15_000);

try {
  // Every request that Firefox makes for the add-on itself, from here on. Pages that a tool opens are requests of the tab.
  await f.chrome(`
    globalThis.fcSeen = [];
    Services.obs.addObserver((ch) => {
      ch.QueryInterface(Ci.nsIHttpChannel);
      if (ch.loadInfo.externalContentPolicyType !== Ci.nsIContentPolicy.TYPE_DOCUMENT && (ch.loadInfo.triggeringPrincipal?.addonId === arguments[0] || ch.loadInfo.loadingPrincipal?.addonId === arguments[0])) globalThis.fcSeen.push(ch.URI.spec);
    }, 'http-on-modify-request');`, addon);
  await f.navigate(`${A.origin}/lists`);
  await sb.open();
  await sb.click('#connect');
  await until('connected', async () => (await sb.text('#link-title')) === 'Connected');
  c = new McpClient(home, { name: 'auditor' });
  await c.init();
  await until('client', async () => /auditor/.test(await sb.text('#sessions')));
  const first = await f.handle();
  await sb.attach('auditor', 'act', true);
  await until('granted', async () => (tab = (await c.call('tabs_context')).data.tabs[0]?.tabId) !== undefined);

  await check('FC-TAB', 'tab_info, pin and mute: as Firefox shows them; a tab without a grant stays as it is', async (n) => {
    const i = (await call('tab_info')).data;
    n(JSON.stringify(i).slice(0, 260));
    assert.deepEqual([i.url, i.pinned, i.muted, i.active], [`${A.origin}/lists`, false, false, true]);
    assert.deepEqual((await call('tab_update', { pinned: true, muted: true })).data, { tabId: tab, pinned: true, muted: true });
    assert.deepEqual((await tabsOf())[0].slice(1), [true, true]);
    assert.deepEqual((({ pinned, muted }) => [pinned, muted])((await call('tab_info')).data), [true, true]);
    assert.deepEqual((await call('tab_update', { pinned: false, muted: false })).data, { tabId: tab, pinned: false, muted: false });
    await f.tab(`${A.origin}/second`);
    await f.chrome('gBrowser.pinTab(gBrowser.selectedTab)');
    const other = await sb.eval('return (await browser.tabs.query({ active: true, currentWindow: true }))[0].id');
    assert.equal(await code(c.call('tab_update', { tabId: other, pinned: false })), 'no_grant');
    assert.equal(await code(c.call('tab_info', { tabId: other })), 'no_grant');
    assert.ok((await tabsOf()).some(([u, p]) => u.endsWith('/second') && p));
  });

  await check('FC-TAB', 'tabs_move: Firefox declines a place before a pinned tab, and the reply says moved 0 of 1', async (n) => {
    const before = JSON.stringify(await tabsOf());
    const r = (await c.call('tabs_move', { tabIds: [tab], index: 0 })).data;
    n(JSON.stringify(r));
    assert.deepEqual([r.requested, r.moved], [1, 0]);
    assert.equal(JSON.stringify(await tabsOf()), before);
    const own = (await c.call('tabs_create', {})).data.tabId;
    const m = (await c.call('tabs_move', { tabIds: [own], index: 1 })).data;
    assert.deepEqual([m.moved, m.tabs[0].index], [1, 1]);
    assert.equal(await code(c.call('tabs_move', { tabIds: [own, 999999], index: 0 })), 'no_grant');
    await c.call('tabs_close', { tabId: own });
    await f.chrome('gBrowser.removeTab(gBrowser.selectedTab)');
    await f.select(first);
  });

  await check('FC-ACT-14', 'a list with a search box and late options: Berlin is taken, Atlantis is refused and the list is closed', async (n) => {
    const r = await act('form_input', { ref: await refOf('City'), value: 'Berlin' });
    n(r.text.replace(/\s+/g, ' '));
    assert.equal(r.data.shown, 'Berlin');
    await reported('city Berlin');
    const x = await act('form_input', { ref: await refOf('City'), value: 'Atlantis' });
    n(x.text.slice(0, 120));
    assert.equal(x.code, 'no_match');
    assert.deepEqual(await f.page('return [document.getElementById("city").textContent, document.getElementById("city").getAttribute("aria-expanded"), document.getElementById("pop").hidden]'), ['Berlin', 'false', true]);
  });

  await check('FC-ACT-14', 'an input, an open listbox, a disabled and a double option, a list that is open, a secret field', async (n) => {
    assert.equal((await act('form_input', { ref: await refOf('Fruit'), value: 'apricot' })).data.shown, 'Apricot');
    await reported('fruit Apricot');
    assert.equal((await act('form_input', { ref: await refOf('Size'), value: 'Large' })).data.shown, 'Large');
    await reported('size Large');
    assert.equal(await code(act('form_input', { ref: await refOf('Size'), value: 'Huge' })), 'not_actionable');
    const twice = await act('form_input', { ref: await refOf('Twice'), value: 'Same' });
    n(twice.text);
    assert.equal(twice.code, 'ambiguous');
    await f.page('document.getElementById("twice").setAttribute("aria-expanded", "true")');
    assert.equal(await code(act('form_input', { ref: await refOf('Twice'), value: 'Same' })), 'not_actionable');
    assert.equal(await code(act('form_input', { ref: await refOf('Card number'), value: '4111' })), 'secret_field');
    assert.equal(await code(act('form_fill', { fields: [{ ref: await refOf('Fruit'), value: 'Apple' }] })), 'not_supported');
  });

  await check('FC-DATA-16', 'clipboard: off and without a card at first, denied changes nothing, approved text arrives, nothing reads it', async (n) => {
    const m = await sb.eval('return browser.runtime.getManifest()');
    assert.ok(!JSON.stringify(m).includes('clipboardRead'));
    const before = await clipboard();
    assert.equal(await code(c.call('copy_to_clipboard', { action: 'text', text: 'x' })), 'tool_off');
    assert.equal(await sb.text('#cards .card'), null);
    await open('switch-clipboard');
    await clear();
    await sb.click('#switch-clipboard');
    n((await f.prompt(true).catch((e) => `no question of Firefox: ${e.message}`)).slice(0, 160));
    await until('on', async () => /On\./.test(await message()));
    assert.equal(await code(act('copy_to_clipboard', { tabId: undefined, action: 'text', text: 'denied text' }, false)), 'approval_denied');
    assert.equal(await clipboard(), before);
    const p = c.call('copy_to_clipboard', { action: 'text', text: 'ALPHA from Claude' });
    assert.match(await sb.waitCard(), /ALPHA from Claude/);
    await sb.answerCard(true);
    assert.equal(await code(p), 'ok');
    assert.equal(await clipboard(), 'ALPHA from Claude');
    assert.ok(!(await c.request('tools/list', {})).result.tools.some((t) => /clipboard/.test(t.name) && t.name !== 'copy_to_clipboard'));
  });

  await check('FC-DATA-17', 'ctrl+v inserts what this session copied, not what others put on the clipboard; never into a password field', async (n) => {
    await f.chrome('Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString("BRAVO of another program")');
    const r = await act('computer', { action: 'key', ref: await refOf('Paste here'), keys: 'ctrl+v' });
    n(r.text.replace(/\s+/g, ' '));
    assert.equal(await f.page('return document.getElementById("paste").value'), 'ALPHA from Claude');
    assert.ok(!r.text.includes('BRAVO'));
    assert.equal(await code(act('computer', { action: 'key', ref: await refOf('Password'), keys: 'ctrl+v' })), 'secret_field');
    assert.equal(await f.page('return document.getElementById("pw").value'), '');
  });

  await check('FC-UI-06', 'Go to shows the tab, Only read ends acting, Read and act gives it back', async () => {
    const h = await f.tab(`${A.origin}/second`);
    await sb.click('#grants .go-to');
    await until('in front', async () => (await f.chrome('return gBrowser.selectedBrowser.currentURI.spec')).endsWith('/lists'));
    await clear();
    await sb.click('#grants .level');
    await until('changed', async () => /Changed/.test(await message()));
    assert.equal(await code(call('computer', { action: 'left_click', ref: await refOf('City') })), 'read_only_grant');
    assert.equal(await code(call('tab_update', { pinned: true })), 'read_only_grant');
    await clear();
    await sb.click('#grants .level');
    await until('changed', async () => /Changed/.test(await message()));
    const p = call('computer', { action: 'left_click', ref: await refOf('Fruit') });
    await sb.waitCard();
    await sb.click('#grants .level'); // while the card is open
    assert.equal(await code(p), 'read_only_grant');
    await until('the card closed', async () => (await sb.text('#cards .card')) === null);
    await clear();
    await sb.click('#grants .level');
    await until('changed', async () => /Changed/.test(await message()));
    await f.select(h);
    await f.chrome('gBrowser.removeTab(gBrowser.selectedTab)');
    await f.select(first);
  });

  await check('FC-GRANT-01', 'site rules: never, also for a site below it, in every tool and in the sidebar', async (n) => {
    await rule('block', 'localhost');
    assert.equal(await code(call('read_page')), 'site_blocked');
    const t = (await c.call('tabs_context')).data.tabs.find((x) => x.tabId === tab);
    n(JSON.stringify(t));
    assert.deepEqual([t.state, t.url, t.title], ['site_blocked', undefined, undefined]);
    assert.equal(await code(c.call('tabs_create', { url: SUB })), 'site_blocked');
    await clear();
    await sb.click('#attach');
    await until('refused in the sidebar', async () => /site_blocked/.test(await message()));
    await noRules();
    assert.equal(await code(call('read_page')), 'grant_suspended');
    await approve();
    assert.equal(await code(call('read_page')), 'ok');
  });

  await check('FC-GRANT-01', 'site rules: a frame of a blocked site is not read, and a tab that moves there is refused by every tool', async (n) => {
    // Firefox is asked for the second site once, so that only the rule keeps the add-on out of it.
    const h = await f.tab(`${SUB}/lists`);
    await sb.attach('auditor', 'read', true);
    await until('two grants', async () => (await sb.eval('return document.querySelectorAll("#grants .revoke").length')) === 2);
    await sb.click('#grants .revoke', 1);
    await f.select(h);
    await f.chrome('gBrowser.removeTab(gBrowser.selectedTab)');
    await f.select(first);
    await rule('block', 'b.localhost');
    await go(`${A.origin}/control?other=${encodeURIComponent(SUB)}`);
    const o = (await call('read_page')).text;
    n(/frame \d+ not read[^\n]*/.exec(o)?.[0] ?? 'no frame line');
    assert.match(o, /forbids this site/);
    assert.ok((await call('list_frames')).data.frames.some((x) => x.origin === SUB && x.blocked === true));
    await go(`${SUB}/lists`);
    for (const [t2, a] of [['read_page', {}], ['computer', { action: 'screenshot' }], ['navigate', { url: A.origin }], ['tab_info', {}], ['get_page_text', {}], ['page_timing', {}]]) assert.equal(await code(call(t2, a)), 'site_blocked', t2);
    assert.equal((await c.call('tabs_context')).data.tabs.find((x) => x.tabId === tab).url, undefined);
    await noRules();
    await go(`${A.origin}/lists`);
    await approve();
    assert.equal(await code(call('read_page')), 'ok');
  });

  await check('FC-GRANT-01', 'site rules: a site that asks before each read, and only these sites', async (n) => {
    await rule('ask', 'localhost');
    let p = call('read_page');
    n((await sb.waitCard()).replace(/\s+/g, ' ').slice(0, 150));
    await sb.answerCard(false);
    assert.equal(await code(p), 'approval_denied');
    p = call('get_page_text');
    await sb.answerCard(true);
    assert.match((await p).text, /Lists/);
    await noRules();
    await rule('allow', 'example.com');
    assert.equal(await code(call('read_page')), 'site_blocked');
    await noRules();
    await approve();
    assert.equal(await code(call('read_page')), 'ok');
  });

  await check('FC-TAB-13', 'pages of Firefox: not attachable, and refused in an attached tab, which stays', async (n) => {
    await f.chrome('gBrowser.selectedBrowser.fixupAndLoadURIString("about:config", { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() })');
    await until('the sidebar says so', async () => /cannot be attached/.test(await sb.text('#tab')));
    assert.equal(await sb.eval('return document.getElementById("attach").disabled'), true);
    const codes = [];
    for (const [t, a] of [['navigate', { url: A.origin }], ['tabs_select', {}], ['tabs_close', {}], ['read_page', {}], ['tab_info', {}]]) codes.push(`${t} ${await code(call(t, a))}`);
    n(codes.join(', '));
    assert.ok(codes.every((x) => x.endsWith('restricted_page')));
    assert.ok((await tabsOf()).some(([u]) => u === 'about:config'));
    await go(`${A.origin}/lists`);
    await approve();
    assert.equal(await code(call('read_page')), 'ok');
  });

  await check('FC-TAB-29', 'a window with a tab that the user took over stays open, and after the user closed a window the next tab opens elsewhere', async (n) => {
    const w = (await c.call('windows_create', { url: `${A.origin}/second` })).data;
    await until('the other window', async () => (await windows()) === 2);
    await until('its grant', async () => (await sb.eval('return document.querySelectorAll("#grants .take-over").length')) === 2);
    await sb.click('#grants .take-over', 1);
    await until('taken over', () => sb.eval('return document.querySelectorAll("#grants .give-back").length === 1'));
    const codes = [await code(c.call('windows_close', { windowId: w.windowId })), await code(c.call('tabs_close', { tabId: w.tabId }))];
    n(`taken over: ${codes}`);
    assert.deepEqual(codes, ['stopped', 'stopped']);
    assert.equal(await windows(), 2);
    await f.chrome('for (const x of Services.wm.getEnumerator("navigator:browser")) if (x !== window) x.close()');
    await until('closed by the user', async () => (await windows()) === 1);
    const own = (await c.call('tabs_create', {})).data;
    assert.equal(own.state, 'blank');
    await c.call('tabs_close', { tabId: own.tabId });
  });

  await check('FC-TAB-10', 'a container has its own cookies: the page sees none of the others, and get_cookies neither', async (n) => {
    await f.select(first);
    await f.page('document.cookie = "where=default; path=/"');
    await open('containers-ok');
    await sb.click('#containers-ok');
    await f.prompt(true).catch(() => {});
    await until('allowed', () => sb.eval('return browser.permissions.contains({ permissions: ["cookies"] })'), 8000);
    await sb.eval('await browser.contextualIdentities.create({ name: "AuditWork", color: "blue", icon: "briefcase" })');
    const p = c.call('tabs_create', { url: `${A.origin}/lists`, container: 'AuditWork' });
    assert.match(await sb.waitCard(), /AuditWork/);
    await sb.answerCard(true);
    const own = (await p).data;
    const text = (await c.call('get_page_text', { tabId: own.tabId })).text;
    assert.ok(text.includes('Lists') && !text.includes('where=default'), 'the page in the container sees no cookie of the default one');
    assert.equal((await c.call('tab_info', { tabId: own.tabId })).data.container, 'AuditWork');
    await open('switch-cookies');
    await clear();
    await sb.click('#switch-cookies');
    await until('on', async () => /On\./.test(await message()), 8000);
    const inside = c.call('get_cookies', { tabId: own.tabId, values: true });
    await sb.answerCard(true);
    const insideText = (await inside).text;
    const here = call('get_cookies', { values: true });
    await sb.answerCard(true);
    const hereText = (await here).text;
    n(`container: ${insideText.includes('where') ? 'sees it' : 'no such cookie'}; default: ${/"value": "(\w+)"/.exec(hereText)?.[1]}`);
    assert.ok(!insideText.includes('where') && /"cookies"/.test(insideText));
    assert.match(hereText, /"name": "where"[\s\S]*"value": "default"/);
    await c.call('tabs_close', { tabId: own.tabId });
  });

  await check('FC-UI-08', 'badges: paused and connected', async (n) => {
    await sb.click('#pause');
    const paused = await until('paused', async () => ((await badge()) === 'II' ? 'II' : null));
    assert.equal(await code(call('read_page')), 'paused');
    await sb.click('#pause');
    await until('connected', async () => !(await badge()));
    n(`paused ${paused}, connected none`);
  });

  await check('FC-UI-01', 'two windows with the sidebar: both show the same card, and one answer closes it in both', async () => {
    await f.m.send('Marionette:SetContext', { value: 'content' });
    const { handle } = await f.m.send('WebDriver:NewWindow', { type: 'window', focus: true });
    await f.select(handle);
    await sb.open();
    await until('state in the second', async () => (await sb.text('#link-title')) === 'Connected');
    const p = call('computer', { action: 'left_click', ref: await refOf('Fruit') });
    const here = await sb.waitCard();
    await f.select(first);
    assert.equal(await sb.waitCard(), here);
    await f.select(handle);
    await sb.answerCard(false);
    assert.equal(await code(p), 'approval_denied');
    await f.select(first);
    await until('closed here too', async () => (await sb.text('#cards .card')) === null);
    await f.select(handle);
    await f.m.send('WebDriver:CloseWindow');
    await f.select(first);
  });

  await check('FC-UI-05', 'files: a drop that Firefox trusts becomes a draft, a drop and a paste that script made do not', async (n) => {
    await sb.click('[data-show="chat"]');
    const files = () => sb.eval('return [...document.querySelectorAll("#draft summary")].map((e) => e.textContent)');
    await sb.eval(`
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'scripted.txt', { type: 'text/plain' }));
      document.getElementById('composer').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      document.getElementById('prompt').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: dt }));`);
    await sleep(500);
    assert.deepEqual(await files(), [], 'an event of script adds nothing');
    // Privileged test script in the process of the sidebar makes the drop, so that Firefox marks it as trusted. No mouse took part.
    const drop = () => f.chrome(`
      const inner = document.getElementById('sidebar').contentDocument.getElementById('webext-panels-browser');
      const actor = inner.browsingContext.currentWindowGlobal.getActor('MarionetteCommands');
      return await actor.executeScript('return (async () => { ' + arguments[0] + ' })();', [], { sandboxName: 'system', timeout: 20000 });`, `
      const win = window.wrappedJSObject;
      const dt = new win.DataTransfer();
      dt.items.add(new win.File(Cu.cloneInto(['text of a file'], win), 'dropped.txt', Cu.cloneInto({ type: 'text/plain' }, win)));
      document.getElementById('composer').dispatchEvent(new win.DragEvent('drop', Cu.cloneInto({ bubbles: true, cancelable: true, dataTransfer: dt }, win, { wrapReflectors: true })));
      return true;`);
    await drop();
    await until('dropped', async () => (await files()).some((x) => x.startsWith('dropped.txt')), 5000);
    n((await files()).join(', '));
    await sb.click('#draft .detach');
    await until('removed', async () => (await files()).length === 0);
  });

  await check('FC-AGT-10', 'saved prompts: saved from the message, kept over a restart of the add-on, a blank is asked for, and it gives no grant', async (n) => {
    await sb.click('#chat-new');
    await type('Status of {{place}} please');
    await open('prompt-save');
    await set('#prompt-name', 'status');
    await clear();
    await sb.click('#prompt-save');
    await until('saved', async () => /Saved/.test(await message()));
    await f.install(path.join(root, 'dist/extension'));
    await sleep(1200);
    await sb.open();
    await until('connected', async () => (await sb.text('#link-title')) === 'Connected', 15_000);
    await sb.click('#chat-new');
    await type('/status');
    await sb.click('#send');
    await until('blank', () => sb.eval('return document.querySelectorAll("#prompt-blanks input").length === 1'));
    await set('#prompt-blanks input', 'Berlin');
    await sb.click('#prompt-blanks .send-filled');
    await until('sent', async () => /Status of Berlin please/.test(await chatText()), 15_000);
    await idle();
    n((await chatText()).replace(/\s+/g, ' ').slice(0, 120));
    assert.equal(await sb.text('#grants'), 'None');
  });

  await check('FC-AGT-02', 'file and shell tools: off, the run has none; on, a card shows the whole command, Deny and Allow reach Claude Code, a pause ends the run', async (n) => {
    const say = async (text) => {
      await type(text);
      await sb.click('#send');
    };
    await say('shell echo off');
    await until('refused', async () => /unknown_tool/.test(await chatText()), 15_000);
    await idle();
    await open('tools');
    await sb.click('#tools');
    await until('kept', () => sb.eval('const { chats } = await browser.storage.local.get("chats"); return (chats ?? []).some((x) => x.tools === true)'), 4000);
    const command = `echo one && echo ${'x'.repeat(300)} && del important`;
    await say(`shell ${command}`);
    const card = await sb.waitCard();
    n(card.replace(/\s+/g, ' ').slice(0, 110));
    assert.ok(card.includes(command), 'the whole command');
    assert.deepEqual(await sb.eval('return [...document.querySelectorAll("#cards .card dd")].map((e) => getComputedStyle(e).whiteSpace + " " + getComputedStyle(e).overflowY)'), ['pre-wrap auto', 'pre-wrap auto'], 'line breaks count, and a long value scrolls in its place');
    await sb.answerCard(false);
    await until('denied', async () => /approval_denied/.test(await chatText()), 15_000);
    await idle();
    await say('shell echo yes');
    await sb.answerCard(true);
    await until('allowed', async () => /behavior\\*":\\*"allow/.test(await chatText()), 15_000);
    await idle();
    await say('shell echo waiting');
    await sb.waitCard();
    await sb.click('#pause');
    await until('ended', async () => /Stopped\./.test(await chatText()), 8000);
    await until('no card', async () => (await sb.text('#cards .card')) === null);
    await sb.click('#pause');
    await sb.click('#chat-new');
    await until('a new chat', async () => (await chatText()) === '');
    assert.equal(await sb.eval('return document.getElementById("tools").checked'), false, 'a new chat begins without');
  });

  await check('FC-UI-02', 'a waiting message goes back into the input', async () => {
    await type('slow');
    await sb.click('#send');
    await until('running', () => sb.eval('return !document.getElementById("stop").hidden'), 8000);
    await type('second message');
    await sb.click('#send');
    await until('waits', async () => /second message/.test(await sb.text('#queue')));
    await sb.click('#queue .edit-waiting');
    await until('back', () => sb.eval('return document.getElementById("prompt").value === "second message"'));
    await until('no longer waiting', async () => (await sb.text('#queue')) === '');
    await sb.click('#stop');
    await idle();
  });

  await check('FC-GRANT-25', 'the orders of a hostile page: each ends in a refusal or a card, and nothing happened', async (n) => {
    await sb.click('[data-show="tabs"]');
    await f.select(first);
    await go(`${A.origin}/lists`);
    c.child.kill(); // the add-on was restarted above, so that session has ended
    c = new McpClient(home, { name: 'second' });
    await c.init();
    await until('client', async () => /second/.test(await sb.text('#sessions')));
    await sb.attach('second', 'act', null);
    await until('granted', async () => (tab = (await c.call('tabs_context')).data.tabs[0]?.tabId) !== undefined);
    await f.tab(`${A.origin}/second`);
    const other = await sb.eval('return (await browser.tabs.query({ active: true, currentWindow: true }))[0].id');
    await f.select(first);
    const orders = {
      'read another tab': c.call('read_page', { tabId: other }),
      'read its storage': call('page_storage', { action: 'list', area: 'local' }),
      'read history': c.call('search_history', { query: 'x' }),
      'watch the network': call('read_network_requests'),
      'upload a key': call('file_upload', { ref: await refOf('Paste here'), paths: ['C:\\Users\\x\\.ssh\\id_rsa'] }),
      'run script': call('javascript_tool', { code: '1' }),
      'switch approvals off': c.call('set_switch', { name: 'cookies', on: true }),
      'grant itself a tab': c.call('grant', { tabId: other }),
      'an unknown argument': call('computer', { action: 'left_click', ref: 'ref_x', approved: true }),
      'a browser page': c.call('tabs_create', { url: 'about:config' }),
      'a local file': call('navigate', { url: 'file:///C:/Windows/win.ini' }),
    };
    const codes = {};
    for (const [k, p] of Object.entries(orders)) codes[k] = await code(p);
    n(JSON.stringify(codes));
    assert.ok(Object.values(codes).every((x) => ['no_grant', 'tool_off', 'path_not_allowed', 'unknown_tool', 'invalid_argument', 'not_actionable', 'restricted_page'].includes(x)), JSON.stringify(codes));
    const p = call('computer', { action: 'left_click', ref: await refOf('City') });
    assert.match(await sb.waitCard(), /click/);
    await sb.answerCard(false);
    assert.equal(await code(p), 'approval_denied');
    assert.equal(await f.page('return document.getElementById("city").getAttribute("aria-expanded")'), 'false');
    await f.select((await f.m.send('WebDriver:GetWindowHandles')).find((h) => h !== first) ?? first);
    if ((await f.handle()) !== first) await f.m.send('WebDriver:CloseWindow');
    await f.select(first);
  });

  await check('FC-GRANT-19', 'the log cannot be forged by a title or a client name, and holds no page text', async (n) => {
    const forged = '2026-11-25 grant FORGED-LINE ok';
    await f.page('document.title = arguments[0]', `x\r\n\u2028${forged}`);
    const d = new McpClient(home, { name: `liar\r\n\u2028${forged}` });
    await d.init();
    await until('the client', async () => /liar/.test(await sb.text('#sessions')));
    const lines = () => sleep(1400).then(() => sb.eval('return (await browser.storage.local.get("log")).log'));
    const before = await lines();
    await call('read_page');
    await call('tab_info');
    await d.call('read_page', { tabId: tab });
    const after = await lines();
    const added = after.slice(before.length);
    n(JSON.stringify(added.map((l) => [l.tool, l.decision])));
    assert.deepEqual(added.map((l) => l.tool), ['read_page', 'tab_info', 'read_page'], 'one line for each call');
    assert.ok(!JSON.stringify(added).includes('FORGED') && !JSON.stringify(added).includes('Lists'), 'no title, no name, no page text');
    const shown = await sb.eval('return [...document.querySelectorAll("#log li, #sessions li")].map((e) => e.textContent)');
    assert.ok(shown.every((l) => !/[\r\n\u2028]/.test(l)), 'no line of its own');
    await d.close();
  });

  await check('FC-CONN-22', 'unknown actions over an authenticated pipe are refused, and nothing opens', async (n) => {
    const { Link } = await import('../../dist/mcp/link.mjs');
    const link = new Link(home.dir);
    const before = (await tabsOf()).length;
    const codes = new Set();
    for (const t of ['test.clear_test_history', 'test.visit_url', 'debug.reset', 'constructor', '__proto__', ...Array.from({ length: 200 }, () => `x.${Math.random().toString(36).slice(2)}`)]) codes.add(await link.call(t, {}).then(() => 'ok', (e) => e.code));
    link.close();
    n([...codes].join());
    assert.deepEqual([...codes], ['unknown_tool']);
    assert.equal((await tabsOf()).length, before);
  });

  await check('FC-GRANT-23', 'damaged site rules: every call is refused and the sidebar says so; a reset keeps the rest; a tool cannot change a setting', async (n) => {
    const kept = await sb.eval('return (await browser.storage.local.get(["profile", "chats", "switches"]))');
    await sb.eval('await browser.storage.local.set({ siteRules: { block: "everything" } })');
    await f.install(path.join(root, 'dist/extension'));
    await sleep(1200);
    await sb.open();
    await until('it says so', async () => /Settings cannot be read/.test(await sb.text('#link-title')));
    await sb.click('#connect').catch(() => {});
    await until('the helper runs', async () => /Helper 0/.test(await sb.text('#link-detail')), 8000).catch(() => {});
    const d = new McpClient(home, { name: 'reader' });
    await d.init();
    const codes = [await code(d.call('tabs_context')), await code(d.call('tabs_create', {})), (await d.call('connection_status')).data?.state];
    n(codes.join(', '));
    assert.deepEqual(codes, ['settings_unreadable', 'settings_unreadable', 'settings_unreadable']);
    await d.close();
    await sb.click('#reset-rules');
    await sleep(1500);
    await sb.open();
    await until('it works again', async () => (await sb.text('#link-title')) === 'Connected', 15_000);
    assert.deepEqual(await sb.eval('return (await browser.storage.local.get(["profile", "chats", "switches"]))'), kept);
  });

  await check('FC-CONN-32', 'in this whole run the add-on made no request, and helper and MCP server have no network connection', async (n) => {
    const seen = await f.chrome('return (globalThis.fcSeen ?? ["no observer"])');
    n(`requests of the add-on: ${seen.length ? seen.join(' ') : 'none'}`);
    assert.deepEqual(seen, []);
    assert.match(await sb.eval('return browser.runtime.getManifest().content_security_policy'), /default-src 'none'.*connect-src data: blob:/);
    assert.equal(await sb.eval(`return fetch(arguments[0]).then(() => 'reached', () => 'refused')`, `${A.origin}/report?from-the-add-on`), 'refused');
    assert.ok(!A.reports.includes('from-the-add-on'), 'the content policy of the add-on allows no server');
    const rows = powershell(`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${home.dir}*' -and $_.Name -ne 'powershell.exe' } | ForEach-Object { $p = $_; "$($p.Name) $(@(Get-NetTCPConnection -OwningProcess $p.ProcessId -ErrorAction SilentlyContinue).Count) $(@(Get-NetUDPEndpoint -OwningProcess $p.ProcessId -ErrorAction SilentlyContinue).Count)" }`).split(/\r?\n/).filter(Boolean);
    n(rows.join(', '));
    assert.ok(rows.length >= 2 && rows.every((r) => / 0 0$/.test(r)));
  });

  await check('FC-UI-08', 'not connected: the badge says so, and a client is refused', async () => {
    await sb.click('#disconnect');
    await until('badge', async () => (await badge()) === '!');
    assert.equal(await code(c.call('tabs_context')), 'not_connected');
    await sb.click('#connect');
    await until('connected', async () => (await sb.text('#link-title')) === 'Connected');
  });

  await check('FC-CONN-23', 'processes end with their parents', async (n) => {
    const of = () => powershell(`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${home.dir}*' -and $_.Name -ne 'powershell.exe' } | ForEach-Object { $_.Name }`).split(/\s+/).filter(Boolean).sort();
    const before = of();
    const d = new McpClient(home, { name: 'short' });
    await d.init();
    await d.close();
    const t = Date.now();
    await f.quit();
    await until('no helper', () => !of().includes('firefox-companion-host.exe'), 5000, 200);
    n(`before ${before.join()}; helper gone after ${Date.now() - t} ms (with the end of Firefox); ${of().join()} left`);
    assert.equal(await code(c.call('tabs_context')), 'not_connected');
    await c.close();
    await until('no server', () => of().length === 0, 5000, 200);
  });
} catch (e) {
  results.push({ row: 'setup', name: 'the steps between the checks', ok: false, error: e.stack });
  console.log(e.stack);
} finally {
  c?.child.kill();
  if (!results.some((r) => r.row === 'FC-CONN-23')) await f.quit().catch((e) => console.error('quit', e.message));
  await A.close();
  await home.close();
  double.close();
  rmSync(config, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  writeFileSync(path.join(out, 'audit.json'), JSON.stringify({ firefox: f.version, claude: 'test double', headless: f.capabilities['moz:headless'], at: new Date().toISOString(), seconds: Math.round((Date.now() - start) / 1000), results }, null, 1));
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
}
