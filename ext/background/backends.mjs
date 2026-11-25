// Optional backends: separate programs that the user starts, that log in to the pipe with the user's key, and that do nothing
// until the user turns them on here. Each is on for one connection only. A backend holds no rule: it gets single commands,
// after the router has checked session, tab, origin, frame, switch and approval, and it never replaces another way to act.
import { LIMITS, ToolError, VIRTUAL, oneLine, originOf } from '../shared/protocol.mjs';

/** What exists, whether or not it runs: for the user and for connection_status. */
export const KNOWN = {
  isolated: { title: 'Isolated Firefox (WebDriver BiDi)', setup: 'Build, then run: node dist/backends/isolated.mjs  (add --headless for tests without a window). It starts a second Firefox with an empty profile and deletes that profile at the end.', permissions: 'No permission of this add-on. A debugging port on 127.0.0.1 of the second Firefox only, taken by the backend at once.' },
  input: { title: 'Windows input', setup: 'Build, then run: node dist/backends/input.mjs  on the same desktop. Works while a Firefox window shows the attached tab.', permissions: 'No permission of this add-on. It posts mouse messages to one window of this Firefox.' },
  remote: { title: 'Remote link', setup: 'Build, then run: node dist/remote/gateway.mjs --listen 127.0.0.1:8475  and pair a client here. Nothing listens unless you start it.', permissions: 'No permission of this add-on. A TLS port at the address that you give.' },
};

export class Backends {
  #next = 1;
  #nextTab = VIRTUAL;

  /** `post(pipe, body)` reaches the program. `router` is told about tabs. */
  constructor({ post, router, onEvent = () => {}, onChange = () => {}, setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t) }) {
    Object.assign(this, { post, router, onEvent, onChange, setTimer, clearTimer });
    this.list = new Map(); // name -> { pipe, info, on }
    this.tabs = new Map(); // our tab ID -> { name, key, url, title, status }
    this.waiting = new Map();
  }

  // Connection

  attach(pipe, info) {
    const name = info?.id;
    if (!Object.hasOwn(KNOWN, name)) throw new ToolError('invalid_argument', 'No such backend.');
    // A second one never replaces the first.
    if (this.list.has(name)) throw new ToolError('conflict', 'A backend of that kind is connected already.');
    const line = (v) => oneLine(v, 160);
    this.list.set(name, { pipe, on: false, info: { version: line(info.version), channel: line(info.channel), detail: line(info.detail) } });
    this.onChange();
  }

  nameOf(pipe) {
    return [...this.list].find(([, b]) => b.pipe === pipe)?.[0] ?? null;
  }

  /** The program left, or the link is lost. Commands under way end, and its tabs are gone. */
  detach(pipe) {
    const name = this.nameOf(pipe);
    if (!name) return;
    this.router.stopGroup(name);
    this.list.delete(name);
    this.#drop(name, 'The backend stopped. What it was doing may have taken effect.', 'outcome_unknown');
    this.onEvent(name, { type: 'gone' });
    this.onChange();
  }

  detachAll() {
    for (const b of [...this.list.values()]) this.detach(b.pipe);
  }

  #drop(name, message, code) {
    for (const [id, w] of [...this.waiting]) if (w.name === name) w.done(new ToolError(code, message)), this.waiting.delete(id);
    for (const [id, t] of [...this.tabs]) if (t.name === name) this.#gone(id);
  }

  #gone(id) {
    this.tabs.delete(id);
    this.router.tabClosed(id);
  }

  /** The user's own choice in the sidebar. It ends with the connection. */
  set(name, on) {
    const b = this.list.get(name);
    if (!b) throw new ToolError('not_connected', 'That backend is not running. Start it first.');
    b.on = on;
    if (!on) {
      this.router.stopGroup(name);
      this.#drop(name, 'The user turned this backend off.', 'tool_off');
      this.post(b.pipe, { type: 'reset' });
    }
    this.onEvent(name, { type: on ? 'on' : 'off' });
    this.onChange();
  }

  require(name) {
    const b = this.list.get(name);
    if (!b) throw new ToolError('not_connected', `The optional backend ${name} is not running. The user starts it: ${KNOWN[name].setup}`);
    if (!b.on) throw new ToolError('tool_off', `The user has not turned the backend ${name} on in the sidebar.`);
    return b;
  }

  status() {
    return Object.entries(KNOWN).map(([id, k]) => {
      const b = this.list.get(id);
      const on = b?.on === true && this.router.switches[id] === true;
      return { id, title: k.title, state: !b ? 'not running' : on ? 'on' : 'off', ...(b && { version: b.info.version, channel: b.info.channel, ...(b.info.detail && { detail: b.info.detail }) }), permissions: k.permissions, ...(!on && { setup: k.setup }) };
    });
  }

  // Commands

  /** One command, as part of a call. It is not sent when the call has ended, and is cancelled when it ends. */
  async command(name, method, params, call = null) {
    const b = this.require(name);
    if (call?.aborted) throw call.aborted;
    const id = `b${this.#next++}`;
    const { tabId, ...rest } = params;
    const key = tabId === undefined ? undefined : this.tabs.get(tabId)?.key;
    if (tabId !== undefined && !key) throw new ToolError('no_grant', 'The tab is closed.');
    const answer = new Promise((resolve, reject) => {
      const timer = this.setTimer(() => {
        this.waiting.delete(id);
        this.post(b.pipe, { type: 'cancel', id });
        reject(new ToolError('timeout', 'The backend did not answer.'));
      }, LIMITS.backendMs);
      this.waiting.set(id, {
        name,
        parts: [],
        done: (error, result) => {
          this.clearTimer(timer);
          this.waiting.delete(id);
          if (error) reject(error);
          else resolve(result);
        },
      });
    });
    answer.catch(() => {});
    this.post(b.pipe, { type: 'command', id, method, params: { ...rest, ...(key && { key }) } });
    if (!call) return answer;
    try {
      return await Promise.race([answer, call.gone]);
    } catch (e) {
      if (call.aborted && this.waiting.delete(id)) this.post(b.pipe, { type: 'cancel', id });
      throw e;
    }
  }

  /** A message of a backend. */
  onMessage(pipe, m) {
    const name = this.nameOf(pipe);
    if (!name) return;
    if (m.type === 'reply') {
      const w = this.waiting.get(m.id);
      if (!w || w.name !== name) return;
      if (m.error) return w.done(Object.assign(new ToolError(oneLine(m.error.code, 40) || 'internal_error', oneLine(m.error.message, 300)), { fromPage: m.error.before === true }));
      w.parts.push(String(m.data ?? ''));
      if (m.more) return;
      let result;
      try {
        result = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(w.parts.join('')), (c) => c.charCodeAt(0))));
      } catch {
        return w.done(new ToolError('internal_error', 'The backend sent something else than an answer.'));
      }
      return w.done(null, result?.key && result.url !== undefined ? this.#tabFor(name, result) : result);
    }
    if (m.type !== 'event') return console.error('refused backend message', oneLine(m.type, 40));
    const id = [...this.tabs].find(([, t]) => t.name === name && t.key === m.key)?.[0];
    if (m.event === 'tab') {
      const tab = id === undefined ? null : Object.assign(this.tabs.get(id), { url: String(m.url ?? ''), title: oneLine(m.title), status: m.status === 'loading' ? 'loading' : 'complete' });
      if (tab && tab.url) this.router.tabMoved(id, tab.url);
    } else if (m.event === 'tab_closed' && id !== undefined) this.#gone(id);
    else if (m.event === 'tab_opened') {
      const opener = [...this.tabs].find(([, t]) => t.name === name && t.key === m.opener)?.[0];
      if (opener !== undefined) this.router.tabOpened({ ...this.#tabFor(name, m), openerTabId: opener });
    } else this.onEvent(name, m);
  }

  // Tabs of a backend, in the form that the router knows

  #tabFor(name, { key, url, title, status }) {
    const has = [...this.tabs].find(([, t]) => t.name === name && t.key === key)?.[0];
    const id = has ?? this.#nextTab++;
    if (has === undefined) this.tabs.set(id, { name, key, url: '', title: '', status: 'loading' });
    Object.assign(this.tabs.get(id), { url: String(url ?? ''), title: oneLine(title), status: status === 'complete' ? 'complete' : 'loading' });
    return this.tab(id);
  }

  tab(id) {
    const t = this.tabs.get(id);
    return t ? { id, backend: t.name, url: t.url, title: t.title, status: t.status, windowId: null, active: true, incognito: false, openerTabId: undefined } : null;
  }

  /** The browser as the router sees it, with the tabs of the backends in it. */
  extend(api) {
    const far = (id) => id >= VIRTUAL;
    const send = (tabId, method, params = {}) => this.command(this.tabs.get(tabId)?.name ?? 'isolated', method, { tabId, ...params });
    return {
      ...api,
      getTab: async (id) => (far(id) ? this.tab(id) ?? Promise.reject(new Error('gone')) : api.getTab(id)),
      queryTabs: async () => [...(await api.queryTabs()), ...[...this.tabs.keys()].map((id) => this.tab(id))],
      openUrl: (id, url) => (far(id) ? send(id, 'navigate', { url }) : api.openUrl(id, url)),
      history: (id, kind) => send(id, 'history', { kind }),
      // The isolated profile has no permissions of this Firefox, and needs none: the grant alone decides there.
      hasHost: async (origin, tabId) => (far(tabId) ? Boolean(originOf(origin)) && this.tabs.has(tabId) : api.hasHost(origin)),
      page: async (tabId, message, wanted, frame = 0) => {
        if (!far(tabId)) return api.page(tabId, message, wanted, frame);
        if (message.cmd === 'work' || message.cmd === 'pill') return null; // no marks in the isolated Firefox: it is all ours
        if (!wanted()) return null;
        return send(tabId, 'page', { frame, message }).catch((e) => (e.fromPage ? { error: e.code, message: e.message } : Promise.reject(e)));
      },
      forget: (tabId) => (far(tabId) ? this.tabs.has(tabId) && send(tabId, 'forget').catch(() => {}) : api.forget(tabId)),
      abort: (tabId, frame) => (far(tabId) ? this.tabs.has(tabId) && send(tabId, 'abort').catch(() => {}) : api.abort(tabId, frame)),
      quiet: (tabId) => (far(tabId) ? undefined : api.quiet?.(tabId)),
      windowState: async (id) => (id === null ? 'normal' : api.windowState?.(id)),
      captureTab: async (tabId) => (far(tabId) ? `data:image/jpeg;base64,${(await send(tabId, 'screenshot')).data}` : api.captureTab(tabId)),
    };
  }
}
