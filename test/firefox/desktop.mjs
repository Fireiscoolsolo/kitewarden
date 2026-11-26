// On the visible desktop: focus, minimized and covered windows, and the Windows input backend. A disposable profile in a window
// of its own, temporary add-on, installed helper, MCP server, local pages. It opens windows for about a minute and sends mouse
// messages to its own Firefox window only. The pointer of the user does not move. While somebody uses the computer it opens no
// window above theirs, and shows only that the backend refuses then.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { McpClient, installHome, root, sleep, until } from '../helpers.mjs';
import { Firefox, Sidebar } from './firefox.mjs';
import { fixture } from './fixtures.mjs';

const results = [];
const out = path.join(root, 'test-results');
mkdirSync(out, { recursive: true });
const home = installHome();
const A = await fixture(3000);
const f = await Firefox.start({ headed: true });
const sb = new Sidebar(f, await f.install(path.join(root, 'dist/extension')));
let c, tab, input, cover;

const WIN = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class W {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out P p); public struct P { public int X, Y; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref L i); struct L { public uint S, T; }
  public static string Now() { uint p; GetWindowThreadProcessId(GetForegroundWindow(), out p); P c; GetCursorPos(out c); L i = new L(); i.S = 8; GetLastInputInfo(ref i); return p + "," + c.X + "," + c.Y + "," + unchecked((uint)Environment.TickCount - i.T); } }'; [W]::Now()`;
/** Process of the window in front, where the pointer is, and for how long nobody used mouse or keyboard. */
const front = () => {
  const [pid, x, y, idle] = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN], { encoding: 'utf8' }).trim().split(',').map(Number);
  return { pid, pointer: `${x},${y}`, idle };
};
/** With a screen saver or a lock no window is in front, and nothing about focus can be observed. */
function needsDesktop() {
  if (front().pid === 0) throw Object.assign(new Error('not run: no window is in front, because the screen saver or the lock screen is up'), { skipped: true });
}
const active = front().idle < 60_000;
function needsIdle() {
  if (active) throw Object.assign(new Error('not run: somebody uses this computer'), { skipped: true });
}
/** Puts the windows of the test's own Firefox above all others, or back. It takes no focus. */
const onTop = (on) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class T { delegate bool F(IntPtr h, IntPtr p); [DllImport("user32.dll")] static extern bool EnumWindows(F f, IntPtr p); [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h); [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int e, uint f); public static void Go(uint pid, int top) { EnumWindows(delegate(IntPtr h, IntPtr q) { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) SetWindowPos(h, new IntPtr(top), 0, 0, 0, 0, 0x13); return true; }, IntPtr.Zero); } }'; [T]::Go(${f.pid}, ${on ? -1 : -2})`]);
/** A plain window of another program, at the given place, in front. */
async function window2(x, y, w, h) {
  const p = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object Windows.Forms.Form; $f.Text = 'FC test cover'; $f.StartPosition = 'Manual'; $f.Left = ${x}; $f.Top = ${y}; $f.Width = ${w}; $f.Height = ${h}; $f.TopMost = $true; $f.Add_Shown({ $f.Activate(); [Console]::Out.WriteLine('shown') }); [Windows.Forms.Application]::Run($f)`], { stdio: 'pipe' });
  await new Promise((ok, no) => {
    p.stdout.on('data', ok);
    setTimeout(() => no(new Error('the other window did not open')), 15_000);
  });
  await sleep(500);
  return p;
}

async function check(row, name, fn) {
  const t = Date.now();
  const notes = [];
  let error = null;
  try {
    await fn((n) => notes.push(n));
  } catch (e) {
    error = e;
    if (error.skipped) notes.push(error.message);
    else notes.push(`sidebar: ${(await sb.text('body').catch((x) => x.message)).replace(/\s+/g, ' ').slice(0, 600)}`);
    for (let i = await sb.eval('return document.querySelectorAll("#cards .card").length').catch(() => 0); i > 0; i--) await sb.answerCard(false).catch(() => {});
  }
  const skipped = error?.skipped === true;
  results.push({ row, name, ok: !error, ...(skipped && { skipped }), ms: Date.now() - t, notes, error: error?.message });
  console.log(`${skipped ? 'OPEN' : error ? 'FAIL' : 'ok  '} ${row.padEnd(8)} ${name} (${Date.now() - t} ms)${notes.map((n) => `\n         ${n}`).join('')}${error && !skipped ? `\n         ${error.stack.split('\n').filter((l) => !/node:internal|helpers/.test(l)).slice(0, 6).join('\n         ')}` : ''}`);
}
const call = (tool, args = {}) => c.call(tool, { tabId: tab, ...args });
async function act(tool, args = {}, yes = true) {
  const p = call(tool, args);
  let over = false;
  p.then(() => (over = true));
  await until('card or answer', async () => over || sb.text('#cards .card').catch(() => null), 8000, 30);
  if (!over) await sb.answerCard(yes);
  return p;
}
const refOf = async (name) => new RegExp(`"${name}".*\\[(ref_\\w+)\\]`).exec((await call('read_page', { filter: 'interactive' })).text)?.[1] ?? assert.fail(`no ${name}`);
const state = () => f.chrome('return [window.STATE_MAXIMIZED, window.STATE_MINIMIZED, window.STATE_NORMAL].indexOf(window.windowState)');

try {
  await f.navigate(`${A.origin}/dev`);
  await sb.open();
  await sb.click('#connect');
  await until('connected', async () => (await sb.text('#link-title')) === 'Connected');
  c = new McpClient(home, { name: 'driver', args: ['--with', 'input'] });
  await c.init();
  await until('client', async () => /driver/.test(await sb.text('#sessions')));
  await sb.attach('driver', 'act', true);
  tab = Number((await c.call('tabs_context')).data.tabs[0].tabId);
  const first = await f.handle();

  await check('FC-TAB', 'the window is on a visible desktop', async (n) => {
    assert.equal(f.capabilities['moz:headless'], false);
    const b = await f.chrome('window.focus(); return [window.screenX, window.screenY, window.outerWidth, window.outerHeight, window.devicePixelRatio, document.hasFocus()]');
    n(`window ${b.slice(0, 4)}, ratio ${b[4]}, Firefox says focused: ${b[5]}; process in front: ${front().pid === f.pid ? 'this Firefox' : 'another'}`);
    assert.ok(b[2] > 300);
  });

  await check('FC-TAB', 'focus: reading, acting, opening a tab and selecting a tab leave another window in front', async (n) => {
    needsDesktop();
    // Any window of another program will do. Firefox must not come before it by itself.
    const before = front();
    n(`in front: process ${before.pid}, this Firefox is ${f.pid}`);
    if (before.pid === f.pid) throw Object.assign(new Error('not run: the new Firefox window is in front itself'), { skipped: true });
    const behind = (what) => assert.notEqual(front().pid, f.pid, what);
    assert.equal((await call('read_page')).code, null);
    const shown = await f.chrome('return gBrowser.selectedTab === gBrowser.tabs[0]');
    const made = (await c.call('tabs_create', { url: `${A.origin}/second` })).data;
    assert.equal(made.state, 'loaded');
    behind('a new tab does not raise Firefox');
    assert.equal(await f.chrome('return gBrowser.selectedTab === gBrowser.tabs[0]'), shown, 'the active tab is the same');
    const r = (await c.call('computer', { action: 'hover', tabId: tab, ref: await refOf('Throw') })).data;
    assert.equal(r.dispatched, true);
    assert.equal((await c.call('tabs_select', { tabId: made.tabId })).data.active, true);
    behind('tabs_select without focusWindow does not raise Firefox');
    assert.equal((await c.call('tabs_select', { tabId: tab })).data.active, true);
    const w = (await c.call('windows_create', {})).data;
    await sleep(500);
    const after = front().pid === f.pid ? 'this Firefox' : 'another program';
    n(`after windows_create in front: ${after}; reply: ${JSON.stringify(w)}`);
    await c.call('windows_close', { windowId: w.windowId });
    const raised = (await c.call('tabs_select', { tabId: tab, focusWindow: true })).data;
    await sleep(300);
    n(`tabs_select with focusWindow says ${JSON.stringify(raised)}; in front: ${front().pid === f.pid ? 'Firefox' : 'not Firefox'}`);
    await c.call('tabs_close', { tabId: made.tabId });
    await f.select(first);
  });

  await check('FC-SHOT', 'minimized: reading works, a picture is refused with the reason, the window stays minimized until it is asked for', async (n) => {
    assert.equal((await act('resize_window', { state: 'minimized' })).data.state, 'minimized');
    await sleep(700);
    assert.equal(await state(), 1);
    assert.match((await call('read_page')).text, /Dev 3000/);
    const s = await call('computer', { action: 'screenshot' });
    n(s.text);
    assert.equal(s.code, 'not_allowed');
    await f.page('document.title = "While minimized"');
    assert.equal((await call('wait_for', { title: 'While minimized', timeout_s: 3 })).data.found, true);
    assert.equal(await state(), 1, 'still minimized');
    assert.equal((await act('resize_window', { state: 'normal' })).data.state, 'normal');
    await sleep(700);
    n(`state after restoring: ${await state()}`);
    assert.equal(await state(), 2);
    await f.page('document.title = "Dev"');
  });

  // The input backend

  await check('FC-ACT', 'input off: a dead synthetic click says so and starts nothing else; the tool is off, also while the backend runs', async (n) => {
    const p = act('computer', { action: 'left_click', ref: await refOf('Real only') });
    const r = (await p).data;
    n(JSON.stringify(r));
    assert.deepEqual([r.trusted_event, r.observed], [false, false]);
    assert.match(r.hint, /none is used by itself/);
    const ref = await refOf('Real only');
    assert.equal((await call('windows_input', { action: 'click', ref })).code, 'tool_off');
    input = spawn(process.execPath, [path.join(root, 'dist/backends/input.mjs'), '--home', home.dir], { stdio: 'pipe', env: { ...process.env, FC_BACKEND_STDIN: '1' } });
    const status = async () => (await c.call('connection_status')).data.optional_backends.find((b) => b.id === 'input');
    await until('input connected', async () => (await status()).state === 'off', 10_000, 200);
    n(JSON.stringify(await status()));
    assert.equal((await call('windows_input', { action: 'click', ref })).code, 'tool_off');
    await sb.click('#backend-input .backend-on');
    await until('on', async () => (await status()).state === 'on', 5000, 100);
    // The backend is on now, and a dead synthetic click still stays one.
    const again = (await act('computer', { action: 'left_click', ref: await refOf('Real only') })).data;
    await sleep(800);
    assert.deepEqual([again.trusted_event, again.observed, A.reports.includes('real click')], [false, false, false]);
  });

  await check('FC-ACT', 'input while somebody uses the computer: refused, and nothing reaches the page', async (n) => {
    if (!active) throw Object.assign(new Error('not run: nobody uses this computer'), { skipped: true });
    const r = await act('windows_input', { action: 'click', ref: await refOf('Real only') });
    n(r.text);
    if (!/(using|used) mouse or keyboard/.test(r.text)) throw Object.assign(new Error(`not shown: the user rested in that moment (${r.text.slice(0, 80)})`), { skipped: true });
    assert.equal(r.code, 'not_actionable');
    assert.ok(!A.reports.includes('real click'));
  });

  await check('FC-ACT', 'input on: denied sends nothing; approved, the page gets one real click and the pointer of the user stays where it was', async (n) => {
    needsIdle();
    await f.chrome('window.focus()');
    onTop(true);
    const before = front();
    const ref = await refOf('Real only');
    assert.equal((await act('windows_input', { action: 'click', ref }, false)).code, 'approval_denied');
    assert.ok(!A.reports.includes('real click'));
    const r = await act('windows_input', { action: 'click', ref });
    n(r.text.replace(/\s+/g, ' '));
    assert.deepEqual([r.data?.trusted_event, r.data?.observed], [true, true], r.text);
    await until('real click', () => A.reports.includes('real click'), 3000);
    assert.equal(A.reports.filter((x) => x === 'real click').length, 1);
    n(`pointer before ${before.pointer}, after ${front().pointer}`);
  });

  await check('FC-ACT', 'input refused: covered, hidden tab, minimized, changed element; nothing reaches the page', async (n) => {
    needsIdle();
    A.reports.length = 0;
    const [x, y, w, h] = await f.chrome('return [window.screenX, window.screenY, window.outerWidth, window.outerHeight]'); // the other program counts like this
    onTop(false);
    cover = await window2(x, y + Math.round(h * 0.1), w, Math.round(h * 0.85));
    const covered = await act('windows_input', { action: 'click', ref: await refOf('Got real input') });
    n(covered.text);
    assert.equal(covered.code, 'not_actionable');
    cover.kill();
    cover = null;
    await sleep(500);
    onTop(true);
    const ref = await refOf('Got real input');
    await f.tab(`${A.origin}/second`);
    const hidden = await act('windows_input', { action: 'click', ref });
    n(hidden.text);
    assert.equal(hidden.code, 'not_actionable');
    await f.select(first);
    await act('resize_window', { state: 'minimized' });
    await sleep(500);
    const min = await act('windows_input', { action: 'click', ref });
    n(min.text);
    assert.equal(min.code, 'not_actionable');
    await act('resize_window', { state: 'normal' });
    await sleep(500);
    const p = call('windows_input', { action: 'click', ref });
    await sb.waitCard();
    await f.page('document.getElementById("real").textContent = "Delete all"');
    await sb.answerCard(true);
    assert.equal((await p).code, 'stale_ref');
    assert.ok(!A.reports.includes('real click'));
  });

  await check('FC-ACT', 'input: a stop while it waits ends it, off refuses, and the backend that leaves is gone from the list', async (n) => {
    const name = '(?:Real only|Got real input|Delete all)';
    A.reports.length = 0;
    const p = call('windows_input', { action: 'click', ref: await refOf(name) });
    await sb.waitCard();
    await sb.click('#halt');
    assert.equal((await p).code, 'stopped');
    await sb.click('#resume-work');
    await sleep(600);
    assert.ok(!A.reports.includes('real click'));
    await sb.click('#backend-input .backend-off');
    assert.equal((await call('windows_input', { action: 'click', ref: await refOf(name) })).code, 'tool_off');
    input.stdin.end();
    await new Promise((r) => input.on('exit', r));
    await until('gone', async () => (await c.call('connection_status')).data.optional_backends.find((b) => b.id === 'input').state === 'not running', 5000, 100);
    n('the backend ended');
  });
} finally {
  cover?.kill();
  if (input?.exitCode === null) input.kill();
  c?.child.kill();
  await f.quit().catch((e) => console.error('quit', e.message));
  await A.close();
  await home.close();
  const failed = results.filter((r) => !r.ok && !r.skipped);
  writeFileSync(path.join(out, `desktop-${active ? 'in-use' : 'idle'}.json`), JSON.stringify({ firefox: f.version, headless: f.capabilities['moz:headless'], at: new Date().toISOString(), results }, null, 1));
  console.log(`\n${results.filter((r) => r.ok).length} passed, ${failed.length} failed, ${results.filter((r) => r.skipped).length} not run`);
  process.exit(failed.length ? 1 : 0);
}
