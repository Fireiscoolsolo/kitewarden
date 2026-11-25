// A second Firefox with a disposable profile, driven through WebDriver BiDi. The user starts it, never the add-on. It has no
// login, cookie or setting of the everyday profile. Reading uses the page script of the add-on in a sandbox of its own, with
// the same refs, masks and origin checks; input is sent by Firefox itself, so pages see real events.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS, VERSION, originOf } from '../mcp/protocol.mjs';
import { Backend, before, homeOf, options } from './link.mjs';

const HELP = { home: 'folder', firefox: 'path of firefox.exe', out: 'folder for profiles and videos', headless: '' };
const PREFIX = 'fc-isolated-';
const START_MS = 40_000;
const PREFS = { 'browser.shell.checkDefaultBrowser': false, 'browser.aboutwelcome.enabled': false, 'browser.startup.page': 0, 'browser.newtabpage.enabled': false, 'termsofuse.bypassNotification': true, 'datareporting.policy.dataSubmissionEnabled': false, 'datareporting.healthreport.uploadEnabled': false, 'app.update.auto': false, 'signon.rememberSignons': false };
const CONTENT = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'content.js'), 'utf8');

/** What the page script expects of Firefox. Frames have numbers of ours. Two commands may load it at the same time. */
const shim = (me) => `if (!globalThis.companion) globalThis.fcPage = { me: ${me}, kids: [], handler: null };
globalThis.browser ??= { runtime: {
  getFrameId: (t) => { if (t === window) return fcPage.me; for (let i = 0; i < window.length; i++) if (window[i] === t.contentWindow) return fcPage.kids[i] ?? -1; return -1; },
  onMessage: { addListener: (f) => { fcPage.handler = f; } }, sendMessage: async () => {} } };
`;
const ASK = `async (text) => { const { m, kids } = JSON.parse(text); if (!globalThis.fcPage?.handler) return 'load'; fcPage.kids = kids;
  try { return JSON.stringify((await fcPage.handler(m)) ?? null); } catch (e) { return JSON.stringify({ error: 'page_error', message: String(e?.message ?? e) }); } }`;

const KEYS = { Enter: '\uE007', Tab: '\uE004', Backspace: '\uE003', Delete: '\uE017', Escape: '\uE00C', ArrowUp: '\uE013', ArrowDown: '\uE015', ArrowLeft: '\uE012', ArrowRight: '\uE014', Home: '\uE011', End: '\uE010', PageUp: '\uE00E', PageDown: '\uE00F', ctrl: '\uE009', shift: '\uE008', alt: '\uE00A', meta: '\uE03D' };
const BUTTON = { left: 0, middle: 1, right: 2 };

class Bidi {
  #next = 1;
  #waiting = new Map();

  constructor(ws, onEvent) {
    this.ws = ws;
    ws.onmessage = ({ data }) => {
      const m = JSON.parse(data);
      if (m.type === 'event') return onEvent(m.method, m.params);
      const w = this.#waiting.get(m.id);
      this.#waiting.delete(m.id);
      if (m.type === 'error') w?.reject(Object.assign(new Error(`${m.error}: ${m.message}`), { bidi: m.error }));
      else w?.resolve(m.result);
    };
    ws.onclose = () => {
      for (const w of this.#waiting.values()) w.reject(Object.assign(new Error('The isolated Firefox is gone.'), { code: 'outcome_unknown' }));
      this.#waiting.clear();
    };
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.#next++;
      this.#waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

/** The installed Firefox, with its channel. */
function firefoxAt(given) {
  const exe = given ?? process.env.FC_FIREFOX ?? path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Mozilla Firefox', 'firefox.exe');
  if (!existsSync(exe)) throw new Error(`There is no Firefox at ${exe}. Say --firefox <path>.`);
  let channel = 'unknown channel';
  try {
    channel = /"app\.update\.channel",\s*"([\w-]+)"/.exec(readFileSync(path.join(path.dirname(exe), 'defaults/pref/channel-prefs.js'), 'utf8'))?.[1] ?? channel;
  } catch {
    // another layout
  }
  return { exe, channel };
}

/** Profiles that an earlier run could not remove, because it was killed. */
function clean() {
  for (const name of readdirSync(os.tmpdir()).filter((n) => n.startsWith(PREFIX))) {
    const dir = path.join(os.tmpdir(), name);
    try {
      process.kill(Number(readFileSync(path.join(dir, 'owner.txt'), 'utf8')), 0);
    } catch (e) {
      if (e.code !== 'ESRCH') continue;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // still in use
      }
    }
  }
}

export async function start(o) {
  clean();
  const { exe, channel } = firefoxAt(o.firefox);
  const out = o.out ? path.resolve(o.out) : null;
  if (out) mkdirSync(out, { recursive: true });
  const profile = mkdtempSync(path.join(os.tmpdir(), PREFIX));
  writeFileSync(path.join(profile, 'owner.txt'), String(process.pid));
  const prefs = { ...PREFS, ...(out && { 'browser.download.folderList': 2, 'browser.download.dir': out }) };
  writeFileSync(path.join(profile, 'user.js'), Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n'));
  const own = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|FC_)/.test(k)));
  const child = spawn(exe, [...(o.headless ? ['-headless'] : []), '-no-remote', '-profile', profile, '--remote-debugging-port', '0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], env: own });
  let exited = false;
  const gone = new Promise((r) => child.on('exit', () => ((exited = true), r())));
  const remove = async () => {
    for (let n = 0; n < 40; n++) {
      try {
        return rmSync(profile, { recursive: true, force: true });
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    console.error(`Could not delete ${profile}`);
  };
  let bidi;
  try {
    const url = await new Promise((ok, no) => {
      let err = '';
      child.stderr.on('data', (d) => {
        err += d;
        const m = /WebDriver BiDi listening on (ws:\/\/(\S+))/.exec(err);
        if (m && /^127\.0\.0\.1:\d+$/.test(m[2])) ok(m[1]);
        else if (m) no(new Error(`Firefox listens on ${m[2]}, not on this computer only.`));
      });
      gone.then(() => no(new Error('Firefox ended before it was ready.')));
      setTimeout(() => no(new Error('Firefox was not ready in time.')), START_MS).unref();
    });
    const ws = new WebSocket(`${url}/session`);
    await new Promise((ok, no) => {
      ws.onopen = ok;
      ws.onerror = () => no(new Error('The connection to the isolated Firefox failed.'));
    });
    const handle = { on: () => {} };
    bidi = new Bidi(ws, (method, params) => handle.on(method, params));
    // Firefox has one session only. Whoever else connects from now on is refused; if somebody was first, this ends here.
    const { capabilities } = await bidi.send('session.new', { capabilities: { alwaysMatch: { unhandledPromptBehavior: { default: 'ignore' } } } });
    await bidi.send('session.subscribe', { events: ['browsingContext', 'log.entryAdded', 'network.beforeRequestSent', 'network.responseCompleted', 'network.fetchError', 'moz:debugging'] });
    const stop = async () => {
      if (!exited) await Promise.race([bidi.send('browser.close').catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
      await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))]);
      if (!exited) child.kill();
      await remove();
    };
    return { bidi, handle, gone, stop, profile, out, pid: capabilities['moz:processID'], port: Number(new URL(url).port), channel: `Firefox ${capabilities.browserVersion} ${channel}${o.headless ? ', headless' : ''}` };
  } catch (e) {
    child.kill();
    await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))]);
    await remove();
    throw e;
  }
}

/** Tabs, frames, logs and dialogs of the isolated Firefox, and one function for each command. */
export class Isolated {
  constructor(fx) {
    this.fx = fx;
    this.bidi = fx.bidi;
    this.event = () => {};
    this.tabs = new Map(); // top context -> { title, url, status, policy, accept, dialog, dialogs, console, requests, since, last, debug, logpoints, video }
    this.contexts = new Map(); // context -> { top, parent, url }
    this.numbers = new Map(); // child context -> frame number
    fx.handle.on = (method, params) => this.#onEvent(method, params);
  }

  // Events

  #top(context) {
    return this.contexts.get(context)?.top ?? null;
  }

  #tell(key) {
    const t = this.tabs.get(key);
    if (t) this.event('tab', { key, url: t.url, title: t.title, status: t.status });
  }

  #add(key, opener = null) {
    if (this.tabs.has(key)) return;
    this.tabs.set(key, { url: this.contexts.get(key)?.url ?? 'about:blank', title: '', status: 'complete', policy: 'dismiss', accept: null, dialog: null, dialogs: [], console: [], requests: new Map(), since: Date.now(), last: null, debug: false, logpoints: new Map(), video: null });
    if (opener) this.event('tab_opened', { key, opener, url: this.tabs.get(key).url, title: '', status: 'loading' });
  }

  async #title(key) {
    const t = this.tabs.get(key);
    if (!t || t.dialog) return;
    const r = await this.bidi.send('script.evaluate', { expression: 'document.title', target: { context: key, sandbox: 'companion' }, awaitPromise: false }).catch(() => null);
    t.title = String(r?.result?.value ?? t.title).slice(0, 200);
    this.#tell(key);
  }

  #onEvent(method, p) {
    const name = method.replace('browsingContext.', '');
    if (name === 'contextCreated') {
      this.contexts.set(p.context, { top: p.parent ? this.#top(p.parent) : p.context, parent: p.parent ?? null, url: p.url });
      if (!p.parent && p.originalOpener && this.tabs.has(p.originalOpener)) this.#add(p.context, p.originalOpener);
      return;
    }
    if (name === 'contextDestroyed') {
      this.contexts.delete(p.context);
      this.numbers.delete(p.context);
      if (this.tabs.delete(p.context)) this.event('tab_closed', { key: p.context });
      return;
    }
    const c = this.contexts.get(p.context ?? p.source?.context);
    const key = c?.top;
    const t = this.tabs.get(key);
    if (!t) return;
    const isTop = (p.context ?? p.source?.context) === key;
    if (['navigationCommitted', 'domContentLoaded', 'load', 'fragmentNavigated', 'historyUpdated'].includes(name)) {
      c.url = p.url;
      if (!isTop) return;
      t.url = p.url;
      if (name === 'load') t.status = 'complete';
      this.#tell(key);
      if (name === 'load' || name === 'domContentLoaded') this.#title(key);
    } else if (name === 'navigationStarted') {
      if (isTop) (t.status = 'loading'), this.#tell(key);
    } else if (name === 'navigationFailed' || name === 'navigationAborted' || name === 'downloadWillBegin') {
      if (isTop) (t.status = 'complete'), this.#tell(key);
    } else if (name === 'userPromptOpened') this.#prompt(key, t, p);
    else if (name === 'userPromptClosed') t.dialog = null;
    else if (method === 'log.entryAdded') this.#log(t, c, p);
    else if (method.startsWith('network.')) this.#network(method, t, c, p);
    else if (method === 'moz:debugging.paused') this.#paused(t, p);
  }

  #prompt(key, t, p) {
    t.dialog = { context: p.context, type: p.type, message: String(p.message ?? '').slice(0, 300) };
    t.opened?.();
    const accept = t.accept ? true : { accept: true, dismiss: false, hold: null }[t.policy];
    if (accept === null) return void t.dialogs.push({ kind: p.type, text: t.dialog.message, answer: 'open' });
    t.dialogs.push({ kind: p.type, text: t.dialog.message, answer: p.type === 'alert' ? 'closed' : accept ? 'accepted' : 'cancelled' });
    this.bidi.send('browsingContext.handleUserPrompt', { context: p.context, accept, ...(accept && p.type === 'prompt' && { userText: t.accept?.text ?? '' }) }).catch(() => {});
  }

  #log(t, c, p) {
    const frame = this.#number(p.source.context);
    const at = p.stackTrace?.callFrames?.[0];
    t.console.push({ at: p.timestamp, level: p.type === 'console' ? p.method : p.level === 'error' ? 'error' : p.level, kind: p.type === 'console' ? 'console' : 'uncaught', text: String(p.text ?? '').slice(0, LIMITS.entryChars), frame, origin: originOf(c.url), ...(at && { url: at.url, line: at.lineNumber + 1 }) });
    if (t.console.length > LIMITS.logEntries) t.console.shift();
  }

  #network(method, t, c, p) {
    const id = p.request.request;
    const value = (v) => (v.type === 'string' ? v.value : '(binary)');
    const headers = (l) => (l ?? []).map((h) => ({ name: h.name, value: value(h.value) }));
    const e = t.requests.get(id) ?? { id, method: p.request.method, type: p.request.destination || p.request.initiatorType || 'other', frame: this.#number(p.context), started: p.timestamp, state: 'running', status: null };
    Object.assign(e, { url: p.request.url, origin: p.navigation ? originOf(p.request.url) : originOf(c.url), requestHeaders: headers(p.request.headers) });
    if (method === 'network.responseCompleted') Object.assign(e, { state: 'done', status: p.response.status, ended: p.timestamp, bytes: p.response.bytesReceived, responseHeaders: headers(p.response.headers) });
    if (method === 'network.fetchError') Object.assign(e, { state: 'failed', error: String(p.errorText ?? ''), ended: p.timestamp });
    t.requests.set(id, e);
    if (t.requests.size > LIMITS.logEntries) t.requests.delete(t.requests.keys().next().value);
  }

  /** A logpoint: what the innermost function knows, and on. The page never stays held. */
  #paused(t, p) {
    const lp = [...t.logpoints.values()].find((x) => x.script === p.url && x.line === p.line);
    if (lp && lp.hits.length < 200) {
      const variables = {};
      for (const s of p.callFrames?.[0]?.scopeChain ?? []) {
        if (s.type === 'global') break;
        for (const [k, v] of Object.entries(s.variables ?? {})) if (k !== 'arguments' && !(k in variables)) variables[k] = (v.value !== undefined ? JSON.stringify(v.value) : v.type).slice(0, 300);
      }
      lp.hits.push({ at: new Date().toISOString(), function: p.callFrames?.[0]?.functionName ?? '', line: p.line, variables });
    }
    this.bidi.send('moz:debugging.resume', { context: p.context }).catch(() => {});
  }

  // Pages

  #number(context) {
    if (this.tabs.has(context)) return 0;
    if (!this.numbers.has(context)) this.numbers.set(context, (this.nextNumber = (this.nextNumber ?? 0) + 1));
    return this.numbers.get(context);
  }

  #tab(key) {
    const t = this.tabs.get(key);
    if (!t) throw before('no_grant', 'The tab is closed.');
    return t;
  }

  #context(key, frame) {
    this.#tab(key);
    if (!frame) return key;
    const context = [...this.numbers].find(([, n]) => n === frame)?.[0];
    if (!context || this.#top(context) !== key) throw before('no_grant', 'That frame is gone.');
    return context;
  }

  async #ask(context, m) {
    const tree = await this.bidi.send('browsingContext.getTree', { root: context, maxDepth: 1 });
    const kids = (tree.contexts[0]?.children ?? []).map((c) => {
      if (!this.contexts.has(c.context)) this.contexts.set(c.context, { top: this.#top(context), parent: context, url: c.url });
      return this.#number(c.context);
    });
    const target = { context, sandbox: 'companion' };
    const ask = () => this.bidi.send('script.callFunction', { functionDeclaration: ASK, target, awaitPromise: true, arguments: [{ type: 'string', value: JSON.stringify({ m, kids }) }] });
    let r = await ask();
    if (r.result?.value === 'load') {
      await this.bidi.send('script.evaluate', { expression: shim(this.#number(context)) + CONTENT, target, awaitPromise: false });
      r = await ask();
    }
    if (r.type === 'exception') throw before('page_error', String(r.exceptionDetails?.text ?? 'The page script failed.'));
    return JSON.parse(r.result.value);
  }

  /** Real input. A dialog that it opens ends the wait for it. */
  async #perform(t, context, actions) {
    let opened;
    const dialog = new Promise((r) => (opened = t.opened = r));
    try {
      await Promise.race([this.bidi.send('input.performActions', { context, actions }), dialog]);
    } finally {
      if (t.opened === opened) t.opened = null;
    }
  }

  #pointer = (steps) => ({ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: steps });
  #keys = (steps) => ({ type: 'key', id: 'keys', actions: steps });

  async #page({ key, frame = 0, message: m }, c) {
    const t = this.#tab(key);
    if (t.dialog) {
      // The page is held by its own dialog. What it did so far is all there is to say.
      if (m.cmd === 'after') return { id: t.last, changed: true, dialogs: t.dialogs.splice(0) };
      throw before('dialog_open', `A ${t.dialog.type} of the page is open: ${t.dialog.message}. Answer it with isolated_browser dialog.`);
    }
    const context = this.#context(key, frame);
    const ask = (x) => this.#ask(context, { origin: m.origin, ...x });
    const ready = () => {
      if (c.cancelled) throw before('cancelled', 'It was cancelled before it began.');
    };
    const starts = () => Object.assign(t, { dialogs: [], accept: m.accept === true ? { text: m.promptText } : null });
    const real = { trusted: true };
    if (m.cmd === 'upload') throw before('not_supported', 'Files are uploaded from tabs of the everyday Firefox only.');
    if (m.cmd === 'pointer' || m.cmd === 'hover') {
      const aim = await ask({ cmd: 'aim', ref: m.ref, fingerprint: m.fingerprint, loose: m.cmd === 'hover' });
      if (aim.error) return aim;
      ready();
      starts();
      t.last = aim.id;
      const held = m.modifiers.map((x) => KEYS[x]);
      const move = { type: 'pointerMove', x: Math.round(aim.x), y: Math.round(aim.y) };
      const button = BUTTON[m.button] ?? 0;
      const press = m.cmd === 'hover' ? [] : Array.from({ length: m.count }, () => [{ type: 'pointerDown', button }, { type: 'pointerUp', button }]).flat();
      const steps = [move, ...press];
      await this.#perform(t, context, [this.#keys([...held.map((value) => ({ type: 'keyDown', value })), ...steps.map(() => ({ type: 'pause' })), ...held.map((value) => ({ type: 'keyUp', value }))]), this.#pointer([...held.map(() => ({ type: 'pause' })), ...steps])]);
      return { id: aim.id, at: aim.at, ...real };
    }
    if (m.cmd === 'type' || m.cmd === 'key') {
      const f = await ask({ cmd: 'field', ref: m.ref, fingerprint: m.fingerprint, typing: m.cmd === 'type', key: m.key });
      if (f.error) return f;
      ready();
      starts();
      t.last = f.id;
      if (m.cmd === 'key') {
        const held = m.modifiers.map((x) => KEYS[x]);
        const value = KEYS[m.key] ?? m.key;
        for (let n = 0; n < m.repeat && !c.cancelled && !t.dialog; n++) await this.#perform(t, context, [this.#keys([...held.map((v) => ({ type: 'keyDown', value: v })), { type: 'keyDown', value }, { type: 'keyUp', value }, ...held.reverse().map((v) => ({ type: 'keyUp', value: v }))])]);
        return { id: f.id, defaults: 0, ...real };
      }
      const chars = [...m.text];
      for (let at = 0; at < chars.length && !c.cancelled; at += 50) await this.#perform(t, context, [this.#keys(chars.slice(at, at + 50).flatMap((ch) => [{ type: 'keyDown', value: ch === '\n' ? KEYS.Enter : ch }, { type: 'keyUp', value: ch === '\n' ? KEYS.Enter : ch }]))]);
      const after = await ask({ cmd: 'field_size' });
      return { id: f.id, arrived: after.size - f.size, cut: c.cancelled, ...real };
    }
    if (m.cmd === 'drag') {
      const from = await ask({ cmd: 'aim', ref: m.ref, fingerprint: m.fingerprint });
      if (from.error) return from;
      const to = await ask({ cmd: 'query', action: 'box', ref: m.to });
      if (to.error) return to;
      if (!to.on_screen) throw before('not_actionable', 'Both ends must be visible at once.');
      ready();
      starts();
      t.last = from.id;
      const end = { x: Math.round(to.box.left + to.box.width / 2), y: Math.round(to.box.top + to.box.height / 2) };
      const mid = (n) => ({ type: 'pointerMove', x: Math.round(from.x + ((end.x - from.x) * n) / 5), y: Math.round(from.y + ((end.y - from.y) * n) / 5), duration: 30 });
      await this.#perform(t, context, [this.#pointer([{ type: 'pointerMove', x: Math.round(from.x), y: Math.round(from.y) }, { type: 'pointerDown', button: 0 }, mid(1), mid(2), mid(3), mid(4), mid(5), { type: 'pause', duration: 50 }, { type: 'pointerUp', button: 0 }])]);
      return { id: from.id, at: from.at, how: 'real pointer', accepted: null, handled: null, ...real };
    }
    ready();
    const r = await this.#ask(context, m);
    if (m.cmd === 'after' && !r.error) r.dialogs = t.dialogs.splice(0);
    if (m.cmd === 'after') t.accept = null;
    return r;
  }

  // Commands

  async #closeTab(key) {
    await this.bidi.send('browsingContext.close', { context: key, promptUnload: false });
  }

  async #debugged(key) {
    const t = this.#tab(key);
    if (!t.debug) await this.bidi.send('moz:debugging.setDebuggerEnabled', { contexts: [key], enabled: true });
    t.debug = true;
    return t;
  }

  #file(file, what) {
    if (!file) throw Object.assign(new Error(`Firefox saved no ${what}.`), { code: 'not_found' });
    return { saved: path.basename(file), bytes: statSync(file).size, folder: 'the folder that the user gave with --out' };
  }

  #needsOut() {
    if (!this.fx.out) throw before('not_allowed', 'The user started this backend without --out, so it saves no files.');
  }

  handlers = {
    open: async ({ url }, c) => {
      const { context } = await this.bidi.send('browsingContext.create', { type: 'tab', background: true });
      this.contexts.set(context, this.contexts.get(context) ?? { top: context, parent: null, url: 'about:blank' });
      this.#add(context);
      if (c.cancelled) {
        await this.#closeTab(context).catch(() => {});
        throw before('cancelled', 'It was cancelled before it began.');
      }
      this.tabs.get(context).status = 'loading';
      await this.bidi.send('browsingContext.navigate', { context, url, wait: 'none' });
      return { key: context, url: 'about:blank', title: '', status: 'loading' };
    },
    close: async ({ key }) => {
      this.#tab(key);
      await this.#closeTab(key);
    },
    navigate: async ({ key, url }) => {
      this.#tab(key).status = 'loading';
      await this.bidi.send('browsingContext.navigate', { context: key, url, wait: 'none' });
    },
    history: async ({ key, kind }) => {
      this.#tab(key);
      if (kind === 'back' || kind === 'forward') await this.bidi.send('browsingContext.traverseHistory', { context: key, delta: kind === 'back' ? -1 : 1 }).catch((e) => Promise.reject(e.bidi === 'no such history entry' ? before('no_history', 'There is no page to go to.') : e));
      else await this.bidi.send('browsingContext.reload', { context: key, wait: 'none', ...(kind === 'hard_reload' && { ignoreCache: true }) }).catch((e) => (e.bidi === 'unsupported operation' ? this.bidi.send('browsingContext.reload', { context: key, wait: 'none' }) : Promise.reject(e)));
    },
    page: (p, c) => this.#page(p, c),
    forget: async ({ key }) => {
      if (!this.tabs.get(key)?.dialog) await this.#ask(key, { cmd: 'forget' });
    },
    abort: async ({ key }) => {
      if (!this.tabs.get(key)?.dialog) await this.#ask(key, { cmd: 'abort' });
    },
    screenshot: async ({ key }) => {
      this.#tab(key);
      return this.bidi.send('browsingContext.captureScreenshot', { context: key, origin: 'viewport', format: { type: 'image/jpeg', quality: 0.8 } });
    },
    log: async ({ key }) => {
      const t = this.#tab(key);
      return { since: t.since, console: t.console, requests: [...t.requests.values()] };
    },
    dialog_state: async ({ key }) => ({ dialog: this.#tab(key).dialog }),
    dialog: async ({ key, answer, text }) => {
      const t = this.#tab(key);
      if (!t.dialog) throw before('not_found', 'No dialog is open in that tab.');
      const { context, type } = t.dialog;
      await this.bidi.send('browsingContext.handleUserPrompt', { context, accept: answer === 'accept', ...(type === 'prompt' && answer === 'accept' && { userText: text ?? '' }) });
      return { kind: type, answer };
    },
    dialog_policy: async ({ key, policy }) => {
      this.#tab(key).policy = policy;
      return { policy };
    },
    emulate: async ({ key, width, height, pixel_ratio, latitude, longitude, locale, timezone, user_agent, orientation, offline, reset }) => {
      this.#tab(key);
      const contexts = [key];
      const done = [];
      const set = async (name, method, params) => {
        await this.bidi.send(method, params).catch((e) => Promise.reject(Object.assign(new Error(`${name}: ${e.message}`), { code: 'invalid_argument', before: done.length === 0 })));
        done.push(name);
      };
      if (reset) {
        await set('viewport', 'browsingContext.setViewport', { context: key, viewport: null, devicePixelRatio: null });
        await set('location', 'emulation.setGeolocationOverride', { contexts, coordinates: null });
        await set('locale', 'emulation.setLocaleOverride', { contexts, locale: null });
        await set('timezone', 'emulation.setTimezoneOverride', { contexts, timezone: null });
        await set('user_agent', 'emulation.setUserAgentOverride', { contexts, userAgent: null });
        await set('orientation', 'emulation.setScreenOrientationOverride', { contexts, screenOrientation: null });
        await set('offline', 'emulation.setNetworkConditions', { contexts, networkConditions: null });
        return { reset: done };
      }
      if (width !== undefined || pixel_ratio !== undefined) await set('viewport', 'browsingContext.setViewport', { context: key, ...(width !== undefined && { viewport: { width, height } }), ...(pixel_ratio !== undefined && { devicePixelRatio: pixel_ratio }) });
      if (latitude !== undefined) await set('location', 'emulation.setGeolocationOverride', { contexts, coordinates: { latitude, longitude, accuracy: 10 } });
      if (locale !== undefined) await set('locale', 'emulation.setLocaleOverride', { contexts, locale });
      if (timezone !== undefined) await set('timezone', 'emulation.setTimezoneOverride', { contexts, timezone });
      if (user_agent !== undefined) await set('user_agent', 'emulation.setUserAgentOverride', { contexts, userAgent: user_agent });
      if (orientation !== undefined) await set('orientation', 'emulation.setScreenOrientationOverride', { contexts, screenOrientation: { natural: orientation, type: `${orientation}-primary` } });
      if (offline !== undefined) await set('offline', 'emulation.setNetworkConditions', { contexts, networkConditions: offline ? { type: 'offline' } : null });
      return { emulated: done, note: 'A page that is loaded already may need a reload.' };
    },
    scripts: async ({ key }) => {
      await this.#debugged(key);
      return this.bidi.send('moz:debugging.listScripts', { context: key });
    },
    source: async ({ key, script }) => {
      await this.#debugged(key);
      return this.bidi.send('moz:debugging.getScriptSource', { context: key, scriptUrl: script });
    },
    logpoint: async ({ key, script, line }) => {
      const t = await this.#debugged(key);
      if (t.logpoints.size >= 20) throw before('limit_reached', 'A tab has at most 20 logpoints.');
      const { breakpoint } = await this.bidi.send('moz:debugging.setBreakpoint', { location: { url: script, line } });
      t.logpoints.set(breakpoint, { script, line, hits: [] });
      return { logpoint: breakpoint };
    },
    logpoint_hits: async ({ key }) => ({ hits: [...this.#tab(key).logpoints].flatMap(([logpoint, l]) => l.hits.map((h) => ({ logpoint, ...h }))) }),
    logpoint_remove: async ({ key, logpoint }) => {
      const t = this.#tab(key);
      if (!t.logpoints.delete(logpoint)) throw before('not_found', 'There is no such logpoint.');
      await this.bidi.send('moz:debugging.removeBreakpoint', { breakpoint: logpoint });
      return { removed: logpoint };
    },
    profile_start: async ({ key }) => {
      this.#needsOut();
      await this.bidi.send('moz:profiler.start', { preset: 'web-developer', activeContext: key });
      return { recording: true, note: 'It samples the whole isolated Firefox.' };
    },
    profile_stop: async () => {
      this.#needsOut();
      return this.#file((await this.bidi.send('moz:profiler.stop')).path, 'profile');
    },
    video_start: async ({ key }) => {
      this.#needsOut();
      const t = this.#tab(key);
      if (t.video) throw before('conflict', 'A video of this tab is recorded already.');
      t.video = (await this.bidi.send('browsingContext.startScreencast', { context: key, destinationFolder: this.fx.out })).screencast;
      return { recording: true };
    },
    video_stop: async ({ key }) => {
      const t = this.#tab(key);
      if (!t.video) throw before('not_found', 'No video of this tab is recorded.');
      const screencast = t.video;
      t.video = null;
      return this.#file((await this.bidi.send('browsingContext.stopScreencast', { screencast })).path, 'video');
    },
  };

  /** Turned off, or the link is lost: no tab of an earlier session stays. */
  async reset() {
    for (const key of [...this.tabs.keys()]) {
      this.tabs.delete(key);
      await this.#closeTab(key).catch(() => {});
    }
    await this.bidi.send('moz:profiler.stop', { discard: true }).catch(() => {});
  }
}

async function main() {
  const o = options(process.argv.slice(2), HELP);
  const fx = await start(o);
  const isolated = new Isolated(fx);
  const backend = new Backend({ home: homeOf(o), id: 'isolated', info: { channel: fx.channel, detail: `isolated profile, WebDriver BiDi on 127.0.0.1:${fx.port}` }, handlers: isolated.handlers, onReset: () => isolated.reset() });
  isolated.event = (event, data) => backend.event(event, data);
  console.log(`${fx.channel}, profile ${fx.profile}, backend ${VERSION}`);
  let ending = false;
  const end = async (code) => {
    if (ending) return;
    ending = true;
    backend.stop();
    await fx.stop();
    process.exit(code);
  };
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(s, () => end(0));
  // A test or another program that started this ends it by closing its input.
  if (process.env.FC_BACKEND_STDIN === '1') process.stdin.on('end', () => end(0)).resume();
  fx.gone.then(() => {
    console.log('The isolated Firefox was closed.');
    end(0);
  });
  backend.run();
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
