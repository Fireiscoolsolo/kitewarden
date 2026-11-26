// The one command path. The sidebar and every MCP server end up in `call`, with the same sessions, checks and log.
// What the tools do is in the *tools.mjs files and sitedata.mjs; every rule about who may do it is here.
import { noRules, ruleFor } from '../grants/rules.mjs';
import { GROUPS, LIMITS, PROTOCOL, TOOLS, ToolError, VERSION, VIRTUAL, checkArgs, oneLine, originOf, plainUrl, toolSpec } from '../shared/protocol.mjs';
import { devTools } from './devtools.mjs';
import { pageTools, screenshot } from './pagetools.mjs';
import { siteTools } from './sitedata.mjs';
import { tabTools } from './tabtools.mjs';

const SUSPENDED = {
  origin: ['grant_suspended', 'The tab moved to another origin. Ask the user to approve it in the sidebar.'],
  permission: ['permission_required', 'Firefox no longer allows this site. Ask the user to approve it in the sidebar.'],
};
const WHY = {
  paused: 'The user paused Kitewarden.',
  no_grant: 'The user revoked this tab.',
  session_ended: 'The session ended.',
  stopped: 'The user stopped this.',
  cancelled: 'The client cancelled the call.',
  timeout: 'The time of the batch is over.',
  tool_off: 'The user turned this off in the sidebar.',
  site_blocked: 'A site rule of the user forbids this site.',
  read_only_grant: 'The user allowed reading only.',
  grant_suspended: SUSPENDED.origin[1],
  permission_required: SUSPENDED.permission[1],
};
export const HANDLERS = { ...pageTools, ...tabTools, ...devTools, ...siteTools };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The frame that a ref names. 0 is the tab itself. */
export const frameOfRef = (ref) => Number(/^ref_f(\d+)_/.exec(ref ?? '')?.[1] ?? 0);

export class Router {
  /**
   * `api` is the browser: getTab, queryTabs, createTab, openUrl, hasHost, hasAllUrls, page, forget, captureTab, captureVisible,
   * annotate, browser, host. `onGrantEnd` hears of each grant that ended or no longer holds, also by a pause. `gif` keeps
   * the frames of recordings. `switches` are the groups that the user turned on, `folders` those that uploads may come from.
   * `observer` keeps console and network entries, `backends` the optional backends. Both are set after construction.
   */
  constructor({ api, grants, approvals, log, gif = null, handlers = HANDLERS, onGrantEnd = () => {}, onChange = () => {}, now = Date.now, linkStatus = () => ({}) }) {
    Object.assign(this, { api, grants, approvals, log, gif, handlers, onGrantEnd, onChange, now, linkStatus });
    this.observer = null;
    this.backends = null;
    this.sessions = new Map();
    this.calls = new Set();
    this.paused = false;
    this.unreadable = false; // the stored settings, so that no rule or pause of the user is missed
    this.halted = null; // after an emergency stop: what was under way
    this.stoppedTabs = new Map(); // tab -> why
    this.clicking = null; // the click under way, to tell whose tab a new tab is
    this.switches = {};
    this.rules = noRules(); // sites of the user, see ext/grants/rules.mjs
    this.folders = [];
    this.requests = new Map(); // tab requests that wait for the user
    this.lost = []; // grants that went with a lost link
    this.urls = new Map(); // last known address of tabs of a session
    this.turns = new Map(); // tab -> the action before
  }

  // Sessions

  openSession(id, kind, label) {
    this.sessions.set(id, { id, kind, owned: new Set(), windows: new Set(), acted: [], shots: new Map(), seen: new Map(), closed: [], downloads: [], group: null, current: null, handover: new Set(), recent: [], copied: null });
    this.label(id, label);
  }

  /** A client names itself, so its label always says that it is a client and which one. */
  label(id, name) {
    const s = this.sessions.get(id);
    s.name = oneLine(name, 80);
    s.label = s.kind === 'mcp' ? `Client ${oneLine(name, 50)} (${id.slice(0, 4)})` : s.kind === 'remote' ? `Remote ${oneLine(name, 70)} (${id.slice(0, 4)})` : name;
    this.onChange();
  }

  endSession(id, code = 'session_ended') {
    const s = this.sessions.get(id);
    if (!this.sessions.delete(id)) return;
    this.#abort((c) => c.session.id === id, code);
    for (const [k, r] of this.requests) if (r.session === s) this.requests.delete(k);
    this.#forget(this.grants.remove((g) => g.sessionId === id));
    this.api.sessionEnded?.(s);
    this.onChange();
  }

  /** The link is lost and agent sessions are about to end: the user may give the same tabs to a new one with one click. */
  rememberLost() {
    for (const s of this.sessions.values()) {
      if (s.kind === 'sidebar') continue;
      const list = this.grants.of(s.id).filter((g) => !g.private && g.state !== 'pending').map(({ tabId, origins, frames, level }) => ({ tabId, origins: [...origins], frames: [...frames], level }));
      if (list.length) this.lost = [...this.lost.filter((l) => l.name !== s.name || l.kind !== s.kind), { id: s.id, kind: s.kind, name: s.name, grants: list }];
    }
  }

  // User decisions. Only the sidebar reaches these.

  setPaused(on) {
    this.paused = on;
    if (on) {
      this.#abort((c) => c.tool !== 'connection_status', 'paused');
      for (const g of this.grants.all) this.onGrantEnd(g);
    }
    this.onChange();
  }

  /** Emergency stop. New work is refused and queued work ends until `resume`. Returns what may have taken effect. */
  halt() {
    const open = [...this.calls].filter((c) => !c.aborted && c.tool !== 'connection_status');
    this.halted = { at: this.now(), calls: open.map((c) => this.#report(c)) };
    this.#abort((c) => c.tool !== 'connection_status', 'stopped');
    for (const g of this.grants.all) this.onGrantEnd(g);
    this.onChange();
    return this.halted;
  }

  resume() {
    this.halted = null;
    this.onChange();
  }

  /** The user takes one tab over. Its calls end, and new ones are refused until the user gives it back. */
  stopTab(tabId, why = 'The user took this tab over. Ask the user to give it back in the sidebar.') {
    const open = [...this.calls].filter((c) => !c.aborted && c.tabId === tabId);
    this.stoppedTabs.set(tabId, why);
    const report = open.map((c) => this.#report(c));
    this.#abort((c) => open.includes(c), 'stopped');
    for (const g of this.grants.all) if (g.tabId === tabId) this.onGrantEnd(g);
    this.onChange();
    return report;
  }

  /** The user turned a group or a backend off: its calls end, and those that wait never begin. */
  stopGroup(name) {
    this.#abort((c) => TOOLS[c.tool]?.group === name || TOOLS[c.tool]?.backend === name || (name === 'isolated' && c.tabId >= VIRTUAL), 'tool_off');
    if (name === 'isolated') this.revoke((g) => g.tabId >= VIRTUAL);
    this.onChange();
  }

  resumeTab(tabId) {
    this.stoppedTabs.delete(tabId);
    this.onChange();
  }

  /** The site of an address, if no rule of the user forbids it. */
  allowedSite(origin) {
    if (ruleFor(this.rules, origin) === 'block') throw new ToolError('site_blocked', WHY.site_blocked);
    return origin;
  }

  /** The user changed the site rules. What they forbid now is suspended, and no grant or frame covers it any more. */
  async setRules(rules) {
    this.rules = rules;
    const blocked = (o) => ruleFor(rules, o) === 'block';
    const hit = [];
    for (const g of this.grants.all) {
      const tab = await this.tab(g.tabId);
      g.origins = g.origins.filter((o) => !blocked(o));
      g.frames = g.frames.filter((o) => !blocked(o));
      if (g.state === 'active' && blocked(originOf(tab?.url))) hit.push(g);
    }
    for (const g of hit) this.grants.suspend(g, 'origin');
    this.lost = this.lost.map((l) => ({ ...l, grants: l.grants.filter((g) => !g.origins.some(blocked)) })).filter((l) => l.grants.length);
    this.#suspended(hit, 'site_blocked');
    this.onChange();
  }

  /** The user changes what a grant allows. Less of it ends the acting calls of that tab, waiting ones as well. */
  setLevel(grantId, level) {
    const g = this.grants.get(grantId);
    if (!g || !['read', 'act'].includes(level)) throw new ToolError('invalid_argument', 'That grant is gone.');
    g.level = level;
    if (level === 'read') this.#abort((c) => c.session.id === g.sessionId && c.tabId === g.tabId && c.level === 'act', 'read_only_grant');
    this.#note(this.sessions.get(g.sessionId), 'grant', g.private ? null : g.origins.at(-1) ?? null, `level ${level}`);
    this.onChange();
  }

  #report(c) {
    return { session: c.session.label, tool: c.tool, tabId: c.tabId, state: c.state, may_have_taken_effect: c.sent?.what ?? null };
  }

  /** `private` and `move` are choices of the user for a private window and for a tab that another session has. */
  async grant({ sessionId, tabId, origin, level, private: allowPrivate = false, move = false }) {
    const tab = await this.tab(tabId);
    const session = this.sessions.get(sessionId);
    if (!session || !['read', 'act'].includes(level)) throw new ToolError('invalid_argument', 'That session is gone.');
    if (!tab || !origin || originOf(tab.url) !== origin) throw new ToolError('origin_changed', 'The tab shows another page now.');
    this.allowedSite(origin);
    if (tab.incognito && allowPrivate !== true) throw new ToolError('not_allowed', 'This is a private window. It needs a grant of its own.');
    if (tab.incognito && session.kind !== 'mcp') throw new ToolError('not_allowed', 'Chats and this sidebar keep a history, so a private tab can be given to an MCP client only.');
    if (!(await this.api.hasHost(origin, tabId))) throw new ToolError('permission_required', 'Firefox did not allow this site.');
    const holder = this.#holder(sessionId, tabId);
    if (holder && !move) throw new ToolError('conflict', `The tab is attached to ${this.sessions.get(holder.sessionId)?.label}. Move it here or revoke it first.`);
    if (holder) this.revoke((g) => g === holder);
    this.#abort((c) => c.session === session && c.tabId === tabId, 'no_grant');
    const g = this.grants.add({ sessionId, tabId, origin, level, private: tab.incognito === true });
    this.#remember(tab);
    this.#note(session, 'grant', g.private ? null : origin, `granted ${level}${g.private ? ' private' : ''}`);
    this.onChange();
    return g;
  }

  /** One agent session per tab. The sidebar's own session is the user. */
  #holder(sessionId, tabId) {
    if (this.sessions.get(sessionId)?.kind === 'sidebar') return null;
    return this.grants.all.find((g) => g.tabId === tabId && g.sessionId !== sessionId && this.sessions.get(g.sessionId)?.kind !== 'sidebar') ?? null;
  }

  async approveOrigin(grantId, origin) {
    const g = this.grants.get(grantId);
    const tab = g && (await this.tab(g.tabId));
    if (!tab || originOf(tab.url) !== origin) throw new ToolError('origin_changed', 'The tab shows another page now.');
    this.allowedSite(origin);
    if (!(await this.api.hasHost(origin, g.tabId))) throw new ToolError('permission_required', 'Firefox did not allow this site.');
    this.grants.approveOrigin(g, origin);
    this.#note(this.sessions.get(g.sessionId), 'grant', g.private ? null : origin, 'origin approved');
    this.onChange();
  }

  /** Frames of this origin in this tab. It says nothing about the tab itself moving there. */
  async approveFrames(grantId, origin) {
    const g = this.grants.get(grantId);
    if (!g || originOf(origin) !== origin) throw new ToolError('invalid_argument', 'That grant is gone.');
    this.allowedSite(origin);
    if (!(await this.api.hasHost(origin, g.tabId))) throw new ToolError('permission_required', 'Firefox did not allow this site.');
    if (!g.frames.includes(origin)) g.frames.push(origin);
    this.#note(this.sessions.get(g.sessionId), 'grant', g.private ? null : origin, 'frames approved');
    this.onChange();
  }

  /** The tabs of a lost session, for a new one of the same client, where they still show what was granted. */
  async regrant(lostId, sessionId) {
    const l = this.lost.find((x) => x.id === lostId);
    const s = this.sessions.get(sessionId);
    if (!l || !s || s.kind !== l.kind || s.name !== l.name) throw new ToolError('not_found', 'That session is gone.');
    this.lost = this.lost.filter((x) => x !== l);
    const given = [];
    for (const old of l.grants) {
      const tab = await this.tab(old.tabId);
      const origin = tab && originOf(tab.url);
      if (!origin || !old.origins.includes(origin)) continue;
      try {
        const g = await this.grant({ sessionId, tabId: old.tabId, origin, level: old.level });
        g.frames.push(...old.frames);
        given.push(old.tabId);
      } catch (e) {
        if (!(e instanceof ToolError)) throw e;
      }
    }
    this.onChange();
    return { given, left_out: l.grants.length - given.length };
  }

  /** The user answers a tab request with a tab and a level, or refuses it. */
  async answerRequest(id, { tabId = null, origin = null, level = null, ...more } = {}) {
    const r = this.requests.get(id);
    if (!r || r.state !== 'pending') throw new ToolError('not_found', 'That request is over.');
    if (tabId !== null) await this.grant({ sessionId: r.session.id, tabId, origin, level, ...more });
    Object.assign(r, tabId === null ? { state: 'denied' } : { state: 'granted', tabId });
    r.wake();
    this.onChange();
  }

  revoke(match) {
    const gone = this.grants.remove(match);
    this.#abort((c) => gone.some((g) => g.sessionId === c.session.id && g.tabId === c.tabId), 'no_grant');
    this.#forget(gone);
    for (const g of gone) this.#note(this.sessions.get(g.sessionId), 'grant', g.private ? null : g.origins.at(-1), 'revoked');
    this.onChange();
  }

  // Browser events

  tabMoved(tabId, url) {
    this.#suspended(this.grants.moved(tabId, originOf(url)), 'grant_suspended');
  }

  tabClosed(tabId) {
    const known = this.urls.get(tabId);
    for (const s of this.sessions.values()) {
      const mine = s.owned.delete(tabId) || this.grants.find(s.id, tabId);
      if (mine && known && originOf(known.url) && tabId < VIRTUAL) s.closed = [{ id: `c${tabId}`, ...known }, ...s.closed].slice(0, LIMITS.closed);
      if (s.current === tabId) s.current = null;
    }
    this.urls.delete(tabId);
    this.stoppedTabs.delete(tabId);
    this.revoke((g) => g.tabId === tabId);
  }

  /** A tab that a click of a session opened belongs to it, with a grant for the approved origin only. */
  tabOpened(tab) {
    const c = this.clicking;
    const g = c && tab.openerTabId === c.call.tabId && this.grants.find(c.call.session.id, c.call.tabId);
    if (!g) return;
    c.opened = tab.id;
    this.own(c.call.session, tab, { origin: c.origin, level: g.level, state: 'pending', private: g.private });
  }

  async permissionsRemoved() {
    const lost = [];
    for (const g of this.grants.all) {
      const tab = g.state === 'active' && (await this.tab(g.tabId));
      if (tab && !(await this.api.hasHost(originOf(tab.url) ?? g.origins[0], g.tabId))) lost.push(g);
    }
    for (const g of lost) this.grants.suspend(g, 'permission');
    this.#suspended(lost, 'permission_required');
  }

  // Calls

  /** `user` marks a gesture in the sidebar. It opens the tools that are for the user only and waives no other check. */
  async call(sessionId, callId, tool, args, { user = false, parent = null } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return { error: { code: 'session_ended', message: 'The session ended. This call was not carried out.' } };
    const call = { session, id: callId, tool, user, parent, tabId: Number.isInteger(args?.tabId) ? args.tabId : null, origin: null, aborted: null, sent: null, state: 'running', since: this.now(), waited: 0, frame: 0 };
    call.gone = new Promise((_, reject) => (call.reject = reject));
    call.gone.catch(() => {});
    this.calls.add(call);
    this.onChange();
    let reply;
    try {
      const result = await Promise.race([this.#run(call, tool, args), call.gone]);
      // An abort that arrived while the last answer was on its way wins.
      if (call.aborted) throw call.aborted;
      reply = { result };
    } catch (e) {
      const known = e instanceof ToolError;
      if (!known) console.error(tool, e);
      reply = { error: known ? { code: e.code, message: e.message, ...e.data } : { code: 'internal_error', message: 'The add-on failed.' } };
      if (call.sent && call.sent.outcome === 'unknown') reply.error.message += ' The action may have reached the page. Read the page before you repeat it.';
      if (call.progress) reply.error.steps = call.progress;
    } finally {
      this.calls.delete(call);
      call.release?.();
      call.card?.close();
    }
    this.#note(session, tool, call.private ? null : call.origin, reply.error?.code ?? 'ok', this.now() - call.since, call.approved);
    this.onChange();
    return reply;
  }

  cancel(sessionId, callId) {
    this.#abort((c) => c.session.id === sessionId && c.id === callId, 'cancelled');
  }

  /** Ends the calls of a session, or those that `match`. Returns what was under way, and whether the page may have it. */
  stopCalls(sessionId, code = 'stopped', match = () => true) {
    const hit = [...this.calls].filter((c) => c.session.id === sessionId && !c.aborted && match(c));
    this.#abort((c) => hit.includes(c), code);
    return hit.map((c) => ({ tool: c.tool, sent: c.sent?.what ?? null }));
  }

  async #run(call, tool, args) {
    if (!Object.hasOwn(TOOLS, tool) || (TOOLS[tool].user && !call.user) || TOOLS[tool].local) throw new ToolError('unknown_tool', 'No such tool.');
    if (!Object.hasOwn(this.handlers, tool) && !['connection_status', 'browser_batch'].includes(tool)) throw new ToolError('unknown_tool', 'This add-on has no such tool.');
    const bad = checkArgs(tool, args);
    if (bad) throw new ToolError('invalid_argument', bad);
    if (call.parent?.aborted) throw call.parent.aborted;
    if (tool === 'connection_status') return this.#status(call.session);
    this.#open();
    if (tool === 'browser_batch') return this.#batch(call, args);
    const spec = toolSpec(tool, args);
    await this.#ready(tool);
    this.#count(call.session);
    if (spec.level === 'none') return this.handlers[tool](this, call, spec, null, args);
    call.level = spec.level;
    let origin = await this.authorize(call, spec);
    if (spec.level === 'act') {
      await this.#turn(call);
      origin = await this.authorize(call, spec); // the one before may have moved the page
    }
    // The user wants to be asked for this site. A call with a card of its own asks there.
    if (ruleFor(this.rules, origin) === 'ask' && !spec.approval && !call.user) {
      await this.ask(call, spec, origin, { tool: 'site_rule', target: toolSpec(tool, args).title, value: 'You asked to be asked for this site' }, args.reason);
    }
    return this.handlers[tool](this, call, spec, origin, args);
  }

  /** Calls of one session in the last minute. The sidebar is the user. */
  #count(session) {
    if (session.kind === 'sidebar') return;
    const now = this.now();
    session.recent = session.recent.filter((t) => now - t < 60_000);
    if (session.recent.length >= LIMITS.callsPerMinute) throw new ToolError('rate_limited', `More than ${LIMITS.callsPerMinute} calls in a minute. Wait ${Math.ceil((60_000 - (now - session.recent[0])) / 1000)} s.`);
    session.recent.push(now);
  }

  /** The switch of a tool, and the optional backend that it needs. Nothing falls back to another backend. */
  async #ready(tool) {
    const { group, backend } = TOOLS[tool];
    if (group) await this.group(group);
    if (backend) {
      if (!this.backends) throw new ToolError('not_connected', `The optional backend ${backend} is not running.`);
      this.backends.require(backend);
    }
  }

  #open() {
    if (this.unreadable) throw new ToolError('settings_unreadable', 'The stored settings of Kitewarden cannot be read, so nothing is allowed. Ask the user to look into the sidebar.');
    if (this.paused) throw new ToolError('paused', WHY.paused);
    if (this.halted) throw new ToolError('stopped', 'The user stopped Kitewarden. Ask the user to press Resume work in the sidebar.');
  }

  async group(name) {
    if (!this.switches[name]) throw new ToolError('tool_off', `The user has not turned ${name} on in the sidebar.`);
    if (GROUPS[name].length && !(await this.api.browser.permissions.contains({ permissions: GROUPS[name] }))) throw new ToolError('permission_required', `Firefox no longer allows ${name}. Ask the user to turn it on again in the sidebar.`);
  }

  /** Actions in one tab run one after the other. A queued one that is stopped never begins. */
  async #turn(call) {
    const before = this.turns.get(call.tabId) ?? Promise.resolve();
    let release;
    const mine = new Promise((r) => (release = r));
    this.turns.set(call.tabId, before.then(() => mine));
    call.release = release;
    call.state = 'queued';
    await Promise.race([before, call.gone]);
    call.state = 'running';
  }

  /** Every check of one call, in the order of docs/feature-parity.md. Runs again right before an action. Returns the origin. */
  async authorize(call, spec, tabId = call.tabId) {
    this.#open();
    const g = this.grants.find(call.session.id, tabId);
    if (!g && this.#holder(call.session.id, tabId)) throw new ToolError('conflict', 'Another session has this tab.');
    if (!g) throw new ToolError('no_grant', 'The user has not attached this tab to this session. Ask the user to attach it in the sidebar.');
    const tab = await this.tab(tabId);
    if (!tab || (tab.incognito && !g.private)) throw new ToolError('no_grant', 'The tab is closed.');
    const origin = originOf(tab.url);
    call.origin = origin;
    call.private = g.private;
    // Before the move counts, which ends this call with another code.
    if (origin) this.allowedSite(origin);
    else if (g.state !== 'pending' && tab.url !== 'about:blank' && !call.session.owned.has(tabId)) throw new ToolError('restricted_page', 'The tab shows a page of Firefox itself, which no tool may use.');
    this.tabMoved(tabId, tab.url);
    if (g.state === 'suspended' && g.reason === 'origin') throw new ToolError(...SUSPENDED.origin);
    if (g.state === 'pending') throw new ToolError('grant_suspended', 'The new tab has not loaded yet. Try again.');
    if (this.stoppedTabs.has(tabId)) throw new ToolError('stopped', this.stoppedTabs.get(tabId));
    if (tabId >= VIRTUAL) {
      await this.group('isolated');
      this.backends.require('isolated');
    }
    if (spec.level === 'act' && g.level !== 'act') throw new ToolError('read_only_grant', 'The user allowed reading only.');
    if (spec.level === 'act' && call.session.handover.has(tabId)) throw new ToolError('paused', 'The tab is with the user until request_user ends.');
    if (g.state === 'suspended') throw new ToolError(...SUSPENDED[g.reason]);
    if (!(await this.api.hasHost(origin, tabId))) {
      this.grants.suspend(g, 'permission');
      this.onChange();
      throw new ToolError(...SUSPENDED.permission);
    }
    // Something may have changed during the two questions to the browser.
    if (call.aborted) throw call.aborted;
    if (this.grants.find(call.session.id, tabId) !== g || g.state !== 'active') throw new ToolError('no_grant', WHY.no_grant);
    this.#remember(tab);
    return origin;
  }

  /** One frame of an authorized tab, if the grant covers its origin. Returns its origin, as the frame itself reports it. */
  async authorizeFrame(call, origin, frame) {
    if (!frame) return origin;
    const w = await this.#ask1(call, { cmd: 'where' }, frame);
    const g = this.grants.find(call.session.id, call.tabId);
    if (!w || w.error) throw new ToolError('no_grant', 'That frame is gone, or Firefox does not let add-ons into it.');
    if (ruleFor(this.rules, w.origin) === 'block' && w.origin !== origin) throw new ToolError('no_grant', `${WHY.site_blocked} (${w.origin})`);
    if (!g || (w.origin !== origin && !(g.frames.includes(w.origin) && (await this.api.hasHost(w.origin, call.tabId))))) {
      throw new ToolError('no_grant', `The frame belongs to ${w.origin}. Ask the user to allow its frames in the sidebar.`);
    }
    if (call.aborted) throw call.aborted;
    return w.origin;
  }

  async #ask1(call, message, frame) {
    const timers = [];
    const late = new Promise((_, reject) => {
      timers.push(setTimeout(() => reject(new ToolError('timeout', 'The page did not answer.')), message.slow ?? LIMITS.pageMs));
      // A page that shows a native dialog answers nothing at all, and one that is only busy with this command answers.
      timers.push(setTimeout(async () => {
        const answers = await Promise.race([this.api.page(call.tabId, { cmd: 'where' }, () => call.aborted === null, frame), sleep(500)]).catch(() => null);
        if (!answers && (await this.tab(call.tabId))?.status === 'complete') reject(new ToolError('dialog_open', 'The page answers nothing. A dialog may be open in the tab, or its script is busy. Ask the user to close the dialog.'));
      }, LIMITS.dialogMs - 1000));
    });
    try {
      return await Promise.race([this.api.page(call.tabId, message, () => call.aborted === null, frame), late, call.gone]);
    } finally {
      timers.forEach(clearTimeout);
    }
  }

  /** One message to the content script of a frame. It compares the document's origin with `origin` before anything else. */
  async page(call, origin, message, frame = 0) {
    const r = await this.#ask1(call, { ...message, origin }, frame);
    if (!r) throw new ToolError('origin_changed', 'The page went away. Read it again.');
    if (r.error) throw Object.assign(new ToolError(r.error, r.message), { fromPage: true });
    return r;
  }

  /** Asks the user for one call. Afterwards grant, level, pause, origin, frame and permission are checked again. */
  async ask(call, spec, origin, card, reason, { frame = 0, hiddenMs, visibleMs } = {}) {
    const tab = call.tabId === null ? null : await this.tab(call.tabId);
    if (this.approvals.cards.filter((c) => c.session === call.session.id).length >= LIMITS.cards) throw new ToolError('rate_limited', 'Too many calls of this session wait for the user.');
    const start = this.now();
    call.state = 'waiting for approval';
    call.card = this.approvals.ask(
      { session: call.session.id, sessionLabel: call.session.label, tabId: call.tabId, tabTitle: oneLine(tab?.title), origin, ...card, reason: oneLine(reason, 200) },
      { hiddenMs, visibleMs },
    );
    this.onChange();
    const allowed = await Promise.race([call.card.answer, call.gone]);
    call.state = 'running';
    for (let c = call; c; c = c.parent) c.waited += this.now() - start;
    call.approved = allowed;
    if (!allowed) throw new ToolError('approval_denied', 'The user did not allow this.');
    if (spec.level === 'none') {
      await this.#ready(call.tool);
      if (call.aborted) throw call.aborted;
      return this.#open();
    }
    await this.#ready(call.tool);
    if (card.tool !== 'gif_creator') await this.frame(call, spec, origin, null);
    if ((await this.authorize(call, spec)) !== origin) throw new ToolError('origin_changed', 'The page changed its origin.');
    if (frame) await this.authorizeFrame(call, origin, frame);
  }

  /** The last gate of every action. From here on the page may have it, and the entry tells the user so if the call is stopped. */
  sent(call, what) {
    if (call.aborted) throw call.aborted;
    this.#open();
    call.sent = { what, outcome: 'unknown' };
    call.session.acted.push(call.sent);
    if (call.session.acted.length > 200) call.session.acted.shift();
    // The user sees in the page that a session acts, and can take over there.
    if (call.tabId !== null && call.origin) this.api.page(call.tabId, { cmd: 'work', origin: call.origin, who: oneLine(call.session.label, 40), what: oneLine(what, 60) }, () => call.aborted === null, 0);
  }

  notSent(call) {
    call.session.acted.splice(call.session.acted.indexOf(call.sent), 1);
    call.sent = null;
  }

  /** A tab of this session, with a grant for what the user approved. */
  own(session, tab, grant = null) {
    session.owned.add(tab.id);
    this.#remember(tab);
    if (grant) this.grants.add({ sessionId: session.id, tabId: tab.id, ...grant });
    this.onChange();
  }

  /** A frame for a running GIF. A picture that fails never fails the action. */
  async frame(call, spec, origin, mark) {
    if (!this.gif?.wants(call.session.id, call.tabId)) return;
    try {
      const { image, mimeType } = await screenshot(this, call, spec, origin);
      this.gif.add(call.session.id, call.tabId, { dataUrl: `data:${mimeType};base64,${image}`, label: mark?.label ?? null, at: mark?.at ?? null });
    } catch (e) {
      this.gif.missed(call.session.id, call.tabId, e.code ?? 'error');
    }
  }

  #status(session) {
    const mine = this.grants.of(session.id);
    const state = this.unreadable ? 'settings_unreadable' : this.halted ? 'stopped' : this.paused ? 'paused' : 'connected';
    return {
      state,
      session: { id: session.id, label: session.label },
      extension: { version: VERSION, protocol: PROTOCOL },
      helper: this.linkStatus(),
      grants: mine.length,
      suspended_grants: mine.filter((g) => g.state !== 'active').length,
      missing_permissions: [...new Set(mine.filter((g) => g.reason === 'permission').flatMap((g) => g.origins))],
      input: 'synthetic events; pages that check for trusted input ignore them. No other input is ever used by itself',
      switches_on: Object.keys(GROUPS).filter((n) => this.switches[n]),
      ...(this.backends && { optional_backends: this.backends.status() }),
      next_step: {
        settings_unreadable: 'The stored settings cannot be read. Ask the user to look into the sidebar.',
        stopped: 'The user stopped Kitewarden. Ask the user to press Resume work in the sidebar.',
        paused: 'The user paused Kitewarden. Ask the user to press Resume in the sidebar.',
        connected: mine.length ? 'Call tabs_context.' : 'Ask the user to attach a tab to this session in the Kitewarden sidebar, or call tab_request.',
      }[state],
    };
  }

  // Batches

  async #batch(call, { steps, timeout_s = 120 }) {
    for (const [i, s] of steps.entries()) {
      if (s.tool === 'browser_batch' || !Object.hasOwn(TOOLS, s.tool) || TOOLS[s.tool].user || TOOLS[s.tool].local) throw new ToolError('invalid_argument', `Step ${i + 1}: ${oneLine(s.tool, 40)} cannot be a step.`);
      const bad = checkArgs(s.tool, s.args);
      if (bad) throw new ToolError('invalid_argument', `Step ${i + 1}: ${bad}`);
    }
    const progress = (call.progress = steps.map((s, i) => ({ step: i + 1, tool: s.tool, state: 'not_run' })));
    const docOf = async (tabId) => (Number.isInteger(tabId) ? ((await this.api.page(tabId, { cmd: 'where' }, () => call.aborted === null, 0).catch(() => null))?.id ?? null) : null);
    for (const [i, s] of steps.entries()) {
      if (call.aborted) throw call.aborted;
      const left = timeout_s * 1000 - (this.now() - call.since - call.waited);
      if (left <= 0 || call.waited > LIMITS.batchCards) return this.#batchEnd(progress, 'timeout', `The time of the batch was over before step ${i + 1}.`);
      const granted = this.grants.find(call.session.id, s.args.tabId)?.state === 'active';
      const before = granted ? await docOf(s.args.tabId) : null;
      progress[i].state = 'running';
      const id = `${call.id}/${i + 1}`;
      // The clock of the batch stands still while the step waits for the user.
      const guard = setInterval(() => this.now() - call.since - call.waited - this.#cardTime(id) > timeout_s * 1000 && this.#abort((c) => c.id === id && c.parent === call, 'timeout'), 200);
      const r = await this.call(call.session.id, id, s.tool, s.args, { parent: call });
      clearInterval(guard);
      if (r.error) {
        Object.assign(progress[i], { state: 'failed', error: r.error });
        if (call.aborted) throw call.aborted;
        return this.#batchEnd(progress, r.error.code, `Step ${i + 1} failed, the rest did not run.`);
      }
      Object.assign(progress[i], { state: 'done', result: r.result });
      const after = granted ? await docOf(s.args.tabId) : null;
      if (i + 1 < steps.length && before && after !== before && !s.navigates && s.tool !== 'navigate') {
        progress[i].navigated = true;
        return this.#batchEnd(progress, 'navigated', `Step ${i + 1} moved the page, so its refs ended. Read the page, then go on.`);
      }
    }
    return this.#batchEnd(progress, null, 'All steps ran.');
  }

  #cardTime(id) {
    const c = [...this.calls].find((x) => x.id === id);
    return c?.state === 'waiting for approval' ? this.now() - c.since - c.waited : 0;
  }

  #batchEnd(steps, stopped, message) {
    return { completed: stopped === null, stopped_by: stopped, message, done: steps.filter((s) => s.state === 'done').length, steps };
  }

  // Helpers

  tab(id) {
    return this.api.getTab(id).catch(() => null);
  }

  #remember(tab) {
    if (!tab.incognito) this.urls.set(tab.id, { url: tab.url, title: oneLine(tab.title), cookieStoreId: tab.cookieStoreId });
  }

  #abort(match, code) {
    for (const c of [...this.calls]) {
      if (!match(c) || c.aborted) continue;
      c.aborted = new ToolError(code, WHY[code]);
      c.reject(c.aborted);
      c.card?.close();
      const step = c.parent?.progress?.find((s) => s.state === 'running');
      if (step) Object.assign(step, { state: code, may_have_taken_effect: c.sent?.what ?? null });
      if (c.tabId !== null && TOOLS[c.tool]) this.api.abort?.(c.tabId, c.frame);
      this.#abort((x) => x.parent === c, code);
    }
  }

  #suspended(grants, code) {
    if (!grants.length) return;
    this.#abort((c) => grants.some((g) => g.sessionId === c.session.id && g.tabId === c.tabId), code);
    this.#forget(grants);
    for (const g of grants) this.#note(this.sessions.get(g.sessionId), 'grant', null, code);
    this.onChange();
  }

  /** Refs, covers, pictures and recordings of a tab go when its grant goes. */
  #forget(grants) {
    for (const g of grants) {
      this.onGrantEnd(g);
      const s = this.sessions.get(g.sessionId);
      s?.seen.delete(g.tabId);
      if (s) for (const [k, shot] of s.shots) if (shot.tabId === g.tabId) s.shots.delete(k);
      if (!this.grants.all.some((o) => o !== g && o.tabId === g.tabId && o.state === 'active')) this.api.forget(g.tabId);
    }
  }

  /** Names, codes and times only: no page text, no arguments. */
  #note(session, tool, origin, decision, ms = 0, approved = undefined) {
    this.log({ at: this.now(), session: session?.id ?? '?', tool: oneLine(tool, 40), origin, decision, ms, approved });
  }

  /** What runs now, for the sidebar. */
  get activity() {
    return [...this.calls].map((c) => ({ session: c.session.label, tool: c.tool, tabId: c.tabId, state: c.state, since: c.since }));
  }
}
