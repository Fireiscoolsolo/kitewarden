// The one command path. The sidebar and every MCP server end up in `call`, with the same sessions, checks and log.
import { LIMITS, PROTOCOL, TOOLS, ToolError, VERSION, checkArgs, oneLine, originOf, plainUrl, toolSpec } from '../shared/protocol.mjs';

const SUSPENDED = {
  origin: ['grant_suspended', 'The tab moved to another origin. Ask the user to approve it in the sidebar.'],
  permission: ['permission_required', 'Firefox no longer allows this site. Ask the user to approve it in the sidebar.'],
};
const WHY = {
  paused: 'The user paused Firefox Companion.',
  no_grant: 'The user revoked this tab.',
  session_ended: 'The session ended.',
  stopped: 'The user disconnected this session.',
  cancelled: 'The client cancelled the call.',
  grant_suspended: SUSPENDED.origin[1],
  permission_required: SUSPENDED.permission[1],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Router {
  /** `api` is the browser: getTab, queryTabs, createTab, hasHost, hasAllUrls, page, capture, windowActive. */
  constructor({ api, grants, approvals, log, onChange = () => {}, now = Date.now, linkStatus = () => ({}) }) {
    Object.assign(this, { api, grants, approvals, log, onChange, now, linkStatus });
    this.sessions = new Map();
    this.calls = new Set();
    this.paused = false;
    this.clicking = null; // the click under way, to tell whose tab a new tab is
  }

  // Sessions

  openSession(id, kind, label) {
    this.sessions.set(id, { id, kind, owned: new Set() });
    this.label(id, label);
  }

  /** A client names itself, so its label always says that it is a client and which one. */
  label(id, name) {
    const s = this.sessions.get(id);
    s.label = s.kind === 'mcp' ? `Client ${oneLine(name, 50)} (${id.slice(0, 4)})` : name;
    this.onChange();
  }

  endSession(id, code = 'session_ended') {
    if (!this.sessions.delete(id)) return;
    this.#abort((c) => c.session.id === id, code);
    this.#forget(this.grants.remove((g) => g.sessionId === id));
    this.onChange();
  }

  // User decisions. Only the sidebar reaches these.

  setPaused(on) {
    this.paused = on;
    if (on) this.#abort((c) => c.tool !== 'connection_status', 'paused');
    this.onChange();
  }

  async grant({ sessionId, tabId, origin, level }) {
    const tab = await this.#tab(tabId);
    const session = this.sessions.get(sessionId);
    if (!session || !['read', 'act'].includes(level)) throw new ToolError('invalid_argument', 'That session is gone.');
    if (!tab || !origin || originOf(tab.url) !== origin) throw new ToolError('origin_changed', 'The tab shows another page now.');
    if (!(await this.api.hasHost(origin))) throw new ToolError('permission_required', 'Firefox did not allow this site.');
    this.#abort((c) => c.session === session && c.tabId === tabId, 'no_grant');
    const g = this.grants.add({ sessionId, tabId, origin, level });
    this.#note(session, 'grant', origin, `granted ${level}`);
    this.onChange();
    return g;
  }

  async approveOrigin(grantId, origin) {
    const g = this.grants.get(grantId);
    const tab = g && (await this.#tab(g.tabId));
    if (!tab || originOf(tab.url) !== origin) throw new ToolError('origin_changed', 'The tab shows another page now.');
    if (!(await this.api.hasHost(origin))) throw new ToolError('permission_required', 'Firefox did not allow this site.');
    this.grants.approveOrigin(g, origin);
    this.#note(this.sessions.get(g.sessionId), 'grant', origin, 'origin approved');
    this.onChange();
  }

  revoke(match) {
    const gone = this.grants.remove(match);
    this.#abort((c) => gone.some((g) => g.sessionId === c.session.id && g.tabId === c.tabId), 'no_grant');
    this.#forget(gone);
    for (const g of gone) this.#note(this.sessions.get(g.sessionId), 'grant', g.origins.at(-1), 'revoked');
    this.onChange();
  }

  // Browser events

  tabMoved(tabId, url) {
    this.#suspended(this.grants.moved(tabId, originOf(url)), 'grant_suspended');
  }

  tabClosed(tabId) {
    for (const s of this.sessions.values()) s.owned.delete(tabId);
    this.revoke((g) => g.tabId === tabId);
  }

  /** A tab that a click of a session opened belongs to it, with a grant for the approved origin only. */
  tabOpened(tab) {
    const c = this.clicking;
    const g = c && tab.openerTabId === c.call.tabId && this.grants.find(c.call.session.id, c.call.tabId);
    if (!g) return;
    c.opened = tab.id;
    c.call.session.owned.add(tab.id);
    this.grants.add({ sessionId: c.call.session.id, tabId: tab.id, origin: c.origin, level: g.level, state: 'pending' });
    this.onChange();
  }

  async permissionsRemoved() {
    const lost = [];
    for (const g of this.grants.all) {
      const tab = g.state === 'active' && (await this.#tab(g.tabId));
      if (tab && !(await this.api.hasHost(originOf(tab.url) ?? g.origins[0]))) lost.push(g);
    }
    for (const g of lost) this.grants.suspend(g, 'permission');
    this.#suspended(lost, 'permission_required');
  }

  // Calls

  async call(sessionId, callId, tool, args) {
    const session = this.sessions.get(sessionId);
    if (!session) return { error: { code: 'session_ended', message: 'The session ended. This call was not carried out.' } };
    const call = { session, id: callId, tool, tabId: Number.isInteger(args?.tabId) ? args.tabId : null, origin: null, aborted: null };
    call.gone = new Promise((_, reject) => (call.reject = reject));
    call.gone.catch(() => {});
    this.calls.add(call);
    const start = this.now();
    let reply;
    try {
      const result = await Promise.race([this.#run(call, tool, args), call.gone]);
      // An abort that arrived while the last answer was on its way wins.
      if (call.aborted) throw call.aborted;
      reply = { result };
    } catch (e) {
      const known = e instanceof ToolError;
      if (!known) console.error(tool, e);
      reply = { error: known ? { code: e.code, message: e.message } : { code: 'internal_error', message: 'The add-on failed.' } };
      if (call.sent) reply.error.message += ' The click may have reached the page. Read the page before you repeat it.';
    } finally {
      this.calls.delete(call);
      call.card?.close();
    }
    this.#note(session, tool, call.origin, reply.error?.code ?? 'ok', this.now() - start, call.approved);
    return reply;
  }

  cancel(sessionId, callId) {
    this.#abort((c) => c.session.id === sessionId && c.id === callId, 'cancelled');
  }

  async #run(call, tool, args) {
    if (!Object.hasOwn(TOOLS, tool)) throw new ToolError('unknown_tool', 'No such tool.');
    const bad = checkArgs(tool, args);
    if (bad) throw new ToolError('invalid_argument', bad);
    if (tool === 'connection_status') return this.#status(call.session);
    if (this.paused) throw new ToolError('paused', WHY.paused);
    if (tool === 'tabs_context') return this.#tabs(call.session, args);
    const spec = toolSpec(tool, args);
    const origin = await this.#authorize(call, spec);
    if (tool === 'read_page') return this.#read(call, origin, args);
    if (tool === 'wait_for') return this.#waitFor(call, spec, origin, args);
    if (args.action === 'screenshot') return this.#screenshot(call, spec, origin);
    return this.#click(call, spec, origin, args);
  }

  /** Every check of one call, in the order of docs/feature-parity.md. Runs again right before an action. Returns the origin. */
  async #authorize(call, spec) {
    if (this.paused) throw new ToolError('paused', WHY.paused);
    const g = this.grants.find(call.session.id, call.tabId);
    if (!g) throw new ToolError('no_grant', 'The user has not attached this tab to this session. Ask the user to attach it in the sidebar.');
    const tab = await this.#tab(call.tabId);
    if (!tab) throw new ToolError('no_grant', 'The tab is closed.');
    const origin = originOf(tab.url);
    call.origin = origin;
    this.tabMoved(call.tabId, tab.url);
    if (g.state === 'suspended' && g.reason === 'origin') throw new ToolError(...SUSPENDED.origin);
    if (g.state === 'pending') throw new ToolError('grant_suspended', 'The new tab has not loaded yet. Try again.');
    if (spec.level === 'act' && g.level !== 'act') throw new ToolError('read_only_grant', 'The user allowed reading only.');
    if (g.state === 'suspended') throw new ToolError(...SUSPENDED[g.reason]);
    if (!(await this.api.hasHost(origin))) {
      this.grants.suspend(g, 'permission');
      this.onChange();
      throw new ToolError(...SUSPENDED.permission);
    }
    // Something may have changed during the two questions to the browser.
    if (call.aborted) throw call.aborted;
    if (this.grants.find(call.session.id, call.tabId) !== g || g.state !== 'active') throw new ToolError('no_grant', WHY.no_grant);
    return origin;
  }

  /** One message to the content script. It compares the document's origin with `origin` before anything else. */
  async #page(call, origin, message) {
    let timer;
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ToolError('timeout', 'The page did not answer. A dialog may be open in the tab.')), LIMITS.pageMs);
    });
    try {
      const r = await Promise.race([this.api.page(call.tabId, { ...message, origin }, () => call.aborted === null), late, call.gone]);
      if (!r) throw new ToolError('origin_changed', 'The page went away. Read it again.');
      if (r.error) throw Object.assign(new ToolError(r.error, r.message), { fromPage: true });
      return r;
    } finally {
      clearTimeout(timer);
    }
  }

  #status(session) {
    const mine = this.grants.of(session.id);
    return {
      state: this.paused ? 'paused' : 'connected',
      session: { id: session.id, label: session.label },
      extension: { version: VERSION, protocol: PROTOCOL },
      helper: this.linkStatus(),
      grants: mine.length,
      suspended_grants: mine.filter((g) => g.state !== 'active').length,
      missing_permissions: [...new Set(mine.filter((g) => g.reason === 'permission').flatMap((g) => g.origins))],
      next_step: this.paused
        ? 'The user paused Firefox Companion. Ask the user to press Resume in the sidebar.'
        : mine.length
          ? 'Call tabs_context.'
          : 'Ask the user to attach a tab to this session in the Firefox Companion sidebar.',
    };
  }

  async #tabs(session, args) {
    let tabs = await this.api.queryTabs();
    const mine = () => tabs.filter((t) => session.owned.has(t.id) || this.grants.find(session.id, t.id));
    if (args.createIfEmpty && mine().length === 0) {
      const tab = await this.api.createTab();
      session.owned.add(tab.id);
      tabs = await this.api.queryTabs();
    }
    const list = mine().map((t) => {
      const g = this.grants.find(session.id, t.id);
      const base = { tabId: t.id, windowId: t.windowId, active: t.active, owned: session.owned.has(t.id), level: g?.level ?? null };
      // Title and address only where the grant covers the page that the tab shows now.
      if (!g || g.state !== 'active' || !g.origins.includes(originOf(t.url))) return { ...base, state: g ? 'suspended' : 'no_grant' };
      return { ...base, state: 'active', title: oneLine(t.title), url: plainUrl(t.url), loading: t.status === 'loading' };
    });
    return { session: session.id, tabs: list, otherTabs: tabs.length - list.length };
  }

  async #read(call, origin, args) {
    const r = await this.#page(call, origin, { cmd: 'snapshot', filter: args.filter ?? 'all', maxChars: args.max_chars ?? LIMITS.readChars, maxNodes: LIMITS.snapshotNodes });
    return { origin, outline: r.outline, truncated: r.truncated, fullChars: r.fullChars };
  }

  async #waitFor(call, spec, origin, args) {
    const start = this.now();
    const limit = (args.timeout_s ?? 10) * 1000;
    for (;;) {
      const { found } = await this.#page(call, origin, { cmd: 'find', text: args.text });
      const elapsed_ms = this.now() - start;
      if (found || elapsed_ms >= limit) return { found, elapsed_ms };
      await Promise.race([sleep(Math.min(250, limit - elapsed_ms)), call.gone]);
      if ((await this.#authorize(call, spec)) !== origin) throw new ToolError('origin_changed', 'The page changed its origin.');
    }
  }

  async #screenshot(call, spec, origin) {
    const { id } = await this.#page(call, origin, { cmd: 'cover' });
    let shot;
    let after;
    try {
      shot = await this.#capture(call);
    } finally {
      after = await this.#page(call, origin, { cmd: 'uncover' }).catch(() => null);
    }
    // The picture counts only if the same document was there before and after it.
    await this.#authorize(call, spec);
    if (after?.id !== id) throw new ToolError('origin_changed', 'The page changed during the capture.');
    const [, mimeType, image] = /^data:([^;]+);base64,(.*)$/s.exec(shot.dataUrl);
    if (image.length > LIMITS.imageBase64) throw new ToolError('too_large', 'The picture is too large.');
    return { image, mimeType, origin, via: shot.via };
  }

  async #capture(call) {
    if (await this.api.hasAllUrls()) return { dataUrl: await this.api.captureTab(call.tabId), via: 'captureTab' };
    const need = new ToolError('permission_required', 'A picture needs the user: ask them to press the Firefox Companion toolbar button on this tab, or to allow screenshots of any granted tab in the sidebar.');
    const tab = await this.#tab(call.tabId);
    if (!tab?.active) throw need;
    let dataUrl;
    try {
      dataUrl = await this.api.captureVisible(tab.windowId);
    } catch {
      throw need;
    }
    // captureVisibleTab takes whatever tab is in front. Make sure that it still is this one.
    if (!(await this.#tab(call.tabId))?.active) throw new ToolError('origin_changed', 'Another tab came to the front during the capture.');
    return { dataUrl, via: 'captureVisibleTab' };
  }

  async #click(call, spec, origin, args) {
    const target = await this.#page(call, origin, { cmd: 'describe', ref: args.ref });
    const tab = await this.#tab(call.tabId);
    if (this.approvals.cards.filter((c) => c.session === call.session.id).length >= LIMITS.cards) throw new ToolError('rate_limited', 'Too many clicks of this session wait for the user.');
    call.card = this.approvals.ask({
      session: call.session.id,
      sessionLabel: call.session.label,
      tool: 'left_click',
      tabId: call.tabId,
      tabTitle: oneLine(tab?.title),
      origin,
      target: target.description,
      link: target.link,
      download: target.download,
      reason: oneLine(args.reason, 200),
    });
    const allowed = await Promise.race([call.card.answer, call.gone]);
    call.approved = allowed;
    if (!allowed) throw new ToolError('approval_denied', 'The user did not allow this click.');
    // Grant, level, pause, origin and permission are checked again, then the page checks origin and element again.
    if ((await this.#authorize(call, spec)) !== origin) throw new ToolError('origin_changed', 'The page changed its origin.');
    const click = (this.clicking = { call, origin, opened: null });
    let sent;
    try {
      call.sent = true;
      sent = await this.#page(call, origin, { cmd: 'click', ref: args.ref, fingerprint: target.fingerprint });
      await Promise.race([sleep(300), call.gone]);
    } catch (e) {
      if (e.fromPage) call.sent = false; // the page refused before it sent any event
      throw e;
    } finally {
      if (this.clicking === click) this.clicking = null;
    }
    const after = await this.#page(call, origin, { cmd: 'after_click' }).catch(() => null);
    // The question may reach the next document, which knows nothing of the click.
    const page = after?.id !== sent.id
      ? 'navigated'
      : after.changed
        ? 'changed'
        : click.opened !== null
          ? 'opened a tab'
          : 'no visible change; the page may ignore events of add-ons';
    return { clicked: target.description, trusted_event: false, page, ...(click.opened !== null && { opened_tab: click.opened }) };
  }

  // Helpers

  #tab(id) {
    return this.api.getTab(id).catch(() => null);
  }

  #abort(match, code) {
    for (const c of this.calls) {
      if (!match(c) || c.aborted) continue;
      c.aborted = new ToolError(code, WHY[code]);
      c.reject(c.aborted);
      c.card?.close();
    }
  }

  #suspended(grants, code) {
    if (!grants.length) return;
    this.#abort((c) => grants.some((g) => g.sessionId === c.session.id && g.tabId === c.tabId), code);
    this.#forget(grants);
    for (const g of grants) this.#note(this.sessions.get(g.sessionId), 'grant', null, code);
    this.onChange();
  }

  /** Refs and covers in the page go when the grant goes. */
  #forget(grants) {
    for (const g of grants) {
      if (!this.grants.all.some((o) => o !== g && o.tabId === g.tabId && o.state === 'active')) this.api.forget(g.tabId);
    }
  }

  /** Names, codes and times only: no page text, no arguments. */
  #note(session, tool, origin, decision, ms = 0, approved = undefined) {
    this.log({ at: this.now(), session: session?.id ?? '?', tool: oneLine(tool, 40), origin, decision, ms, approved });
  }
}
