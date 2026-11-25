// Diagnostics of a granted tab, tools that a page offers, and the optional backends. Everything here needs the same session,
// tab, origin, frame, switch and approval as any other tool; a backend gets a command only after the last gate.
import { LIMITS, ToolError, VIRTUAL, oneLine, originOf } from '../shared/protocol.mjs';
import { isSecretName, redactBody, redactData, redactText, redactUrl, redactValue } from '../shared/redact.mjs';
import { Observer } from './observe.mjs';
import { address, frameFor, granted, loaded, remember, withRef } from './pagetools.mjs';
import { frameOfRef } from './router.mjs';

// Console and network

/** The capture of this grant, or what an isolated tab holds. */
async function captured(r, call) {
  if (call.tabId < VIRTUAL) {
    r.observer.sync();
    const c = r.observer.of(call.session.id, call.tabId);
    if (!c) throw new ToolError('not_found', 'Nothing is captured for this tab.');
    return c;
  }
  const g = r.grants.find(call.session.id, call.tabId);
  const list = await r.backends.command('isolated', 'log', { tabId: call.tabId }, call);
  return { grant: g, since: list.since, networkSince: list.since, bodies: null, ...Observer.fromBackend(g, list) };
}

async function consoleMessages(r, call, spec, origin, a) {
  const c = await captured(r, call);
  const glob = a.pattern && new RegExp(a.pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*'), 'i');
  const hits = c.console.filter((e) => (!a.level || e.level === a.level) && (!glob || glob.test(e.text)));
  if (a.clear && call.tabId < VIRTUAL) c.console = [];
  return { origin, capture_started: new Date(c.since).toISOString(), ...(c.late && { note: 'The capture began after the page did, so earlier output is missing.' }), total: hits.length, entries: hits.slice(-(a.limit ?? 100)).map(({ at, ...e }) => ({ at: new Date(at).toISOString(), ...e })) };
}

async function networkRequests(r, call, spec, origin, a) {
  const c = await captured(r, call);
  if (a.bodies) {
    await r.group('bodies');
    if (call.tabId >= VIRTUAL) throw new ToolError('not_supported', 'Bodies are kept for tabs of this Firefox only.');
  }
  if (a.bodies === 'start') {
    await r.ask(call, spec, origin, { tool: 'read_network_requests', target: `Keep request and response bodies of ${origin} in this tab`, value: 'For at most 10 minutes. Text only; fields that look like credentials stay hidden' }, a.reason);
    await r.group('bodies');
    r.observer.startBodies(await captured(r, call));
    return { origin, bodies: 'started', until: new Date(r.now() + LIMITS.bodiesMs).toISOString() };
  }
  if (a.bodies === 'stop') {
    r.observer.stopBodies(c.grant.id);
    return { origin, bodies: 'stopped' };
  }
  if (a.bodies === 'read') {
    if (!c.bodies) throw new ToolError('not_found', 'No bodies are kept now. Say bodies: start.');
    const x = c.bodies.kept.get(a.request_id);
    if (!x) throw new ToolError('not_found', 'No body of that request was kept.');
    return { origin, request_id: a.request_id, ...x };
  }
  const list = r.observer.list(c, a);
  if (a.clear && call.tabId < VIRTUAL) c.requests.clear();
  return { origin, capture_started: new Date(c.networkSince).toISOString(), bodies: c.bodies ? 'on' : 'off', ...list, note: 'Requests to or from sites that Firefox does not allow this add-on, and those of frames that are not granted, are not seen.' };
}

// Watching, queries, timing

async function watch(r, call, spec, origin, a) {
  return withRef(r, call, origin, a.ref, async (f) => {
    const { id, ...x } = await r.page(call, f.origin, { cmd: 'watch', ref: a.ref, keep: LIMITS.watched }, f.frame);
    return { origin, watch: f.frame ? `f${f.frame}.${x.watch}` : x.watch };
  });
}

const watched = (stop) => async (r, call, spec, origin, a) => {
  const [, frame, name] = /^(?:f(\d+)\.)?(w_\w+)$/.exec(a.watch) ?? [];
  if (!name) throw new ToolError('invalid_argument', 'watch is a name from observe_element.');
  const f = Number(frame ?? 0);
  const { id, ...x } = await r.page(call, await r.authorizeFrame(call, origin, f), { cmd: 'watch_read', watch: name, stop }, f);
  return { origin, ...redactData(x), ...(stop && { stopped: true }) };
};

const URLS = /^(href|src|action|formaction|data|poster|cite)$/i;

async function query(r, call, spec, origin, a) {
  if (a.ref) return withRef(r, call, origin, a.ref, async (f) => ((x) => ({ origin, ...x, id: undefined }))(await r.page(call, f.origin, { cmd: 'query', action: a.action, ref: a.ref }, f.frame)));
  let total = 0;
  const list = [];
  for (const f of await granted(r, call, origin)) {
    const x = await r.page(call, f.origin, { cmd: 'query', action: a.action, selector: a.selector, query: a.query, attributes: a.attributes }, f.frame);
    total += x.total;
    list.push(...(x.elements ?? []).map((e) => ({ ...e, ...(f.frame && { frame: f.frame, frame_origin: f.origin }) })));
  }
  if (a.action === 'count') return { origin, total };
  const out = list.slice(0, 50);
  remember(call, out);
  for (const e of out) for (const [n, v] of Object.entries(e.attributes ?? {})) if (v !== null && v !== '[secret]') e.attributes[n] = URLS.test(n) && originOf(v) ? redactUrl(v) : redactValue(n, v);
  return { origin, total, elements: out };
}

async function timing(r, call, spec, origin) {
  const { id, ...t } = await r.page(call, origin, { cmd: 'timing' });
  return { origin, ...t, slow_resources: t.slow_resources.map((x) => ({ ...x, url: redactUrl(x.url) })) };
}

// Tools of the page

async function webmcpList(r, call, spec, origin) {
  if (call.tabId >= VIRTUAL) throw new ToolError('not_supported', 'WebMCP is offered in tabs of this Firefox only.');
  r.observer.sync();
  const tools = [];
  let late = false;
  for (const f of await granted(r, call, origin)) {
    const x = await r.page(call, f.origin, { cmd: 'hooks', action: 'tools' }, f.frame).catch(() => null);
    if (f.frame === 0) late = x?.late === true || !x;
    for (const t of x?.tools ?? []) tools.push({ id: `${f.frame}.${x.id}.${t.name}`, name: t.name, description: redactText(t.description), input_schema: JSON.parse(t.schema), says_read_only: t.readOnly, ...(f.frame && { frame_origin: f.origin }) });
  }
  return { origin, tools, ...(late && !tools.length && { note: 'WebMCP was offered to this page only after it began to load. Reload it, and list again.' }) };
}

async function webmcpCall(r, call, spec, origin, a) {
  const [, frame, doc, name] = /^(\d+)\.(\w+)\.([\w.-]{1,64})$/.exec(a.tool) ?? [];
  if (!name || call.tabId >= VIRTUAL) throw new ToolError('invalid_argument', 'tool is an id from webmcp_list.');
  const f = Number(frame);
  const at = await r.authorizeFrame(call, origin, f);
  const now = await r.page(call, at, { cmd: 'hooks', action: 'tools' }, f);
  const t = now.id === doc && now.tools.find((x) => x.name === name);
  if (!t) throw new ToolError('stale_ref', 'The page does not offer that tool now. List its tools again.');
  const input = JSON.stringify(a.input);
  if (input.length > 20_000) throw new ToolError('too_large', 'The input is too large.');
  await r.ask(call, spec, origin, { tool: 'webmcp_call', target: `Tool ${JSON.stringify(name)} of the page`, value: `Input: ${input}\nThe page says it does: ${oneLine(t.description, 200)}`, ...(f && { frame: at }) }, a.reason, { frame: f });
  r.sent(call, `tool ${name} of the page`);
  const x = await r.page(call, at, { cmd: 'hooks', action: 'use', doc, name, input, ms: 20_000, slow: 22_000 }, f);
  call.sent.outcome = 'done';
  return { origin, tool: name, output: redactBody(x.output), from: 'the page' };
}

// Windows input: asked for by name, never as a second try of something else

async function windowsInput(r, call, spec, origin, a) {
  if (call.tabId >= VIRTUAL) throw new ToolError('not_supported', 'The isolated Firefox takes real input by itself.');
  if (frameOfRef(a.ref)) throw new ToolError('not_supported', 'Real Windows input works in the top frame only.');
  return withRef(r, call, origin, a.ref, async (f) => {
    const t = await r.page(call, f.origin, { cmd: 'describe', ref: a.ref }, f.frame);
    await r.ask(call, spec, origin, { tool: 'windows_input', target: t.description, value: 'A real mouse click in this Firefox window, sent by the Windows input backend', link: t.link, download: t.download }, a.reason, f);
    const tab = await r.tab(call.tabId);
    const w = tab?.active ? await r.api.browser.windows.get(tab.windowId) : null;
    if (!w || w.state === 'minimized') throw new ToolError('not_actionable', 'The tab is not in front, or its window is minimized.');
    const p = await r.page(call, f.origin, { cmd: 'aim', ref: a.ref, fingerprint: t.fingerprint }, f.frame);
    const to = { x: Math.round((p.screen.x + p.x) * p.screen.ratio), y: Math.round((p.screen.y + p.y) * p.screen.ratio) };
    if ((await r.authorize(call, spec)) !== origin) throw new ToolError('origin_changed', 'The page changed its origin.');
    r.sent(call, `real click on ${t.description}`);
    const x = await r.backends.command('input', 'click', { ...to, count: a.action === 'double_click' ? 2 : 1, title: w.title, focused: w.focused }, call);
    if (!x.sent) {
      r.notSent(call);
      throw new ToolError('not_actionable', oneLine(x.why, 200));
    }
    await Promise.race([new Promise((ok) => setTimeout(ok, 400)), call.gone]);
    const after = await r.page(call, f.origin, { cmd: 'after' }, f.frame).catch(() => null);
    call.sent.outcome = 'done';
    const page = after?.id !== p.id ? 'navigated' : after.changed ? 'changed' : 'no visible change';
    return { clicked: t.description, backend: 'input', dispatched: true, trusted_event: true, observed: page !== 'no visible change', page };
  });
}

// The isolated Firefox

async function isolated(r, call, spec, origin, a) {
  const b = r.backends;
  const s = call.session;
  if (a.action === 'open') {
    const url = address(a.url);
    if (s.owned.size >= LIMITS.tabsOwned) throw new ToolError('limit_reached', `This session has ${LIMITS.tabsOwned} tabs. Close one first.`);
    const site = r.allowedSite(originOf(url));
    await r.ask(call, spec, site, { tool: 'isolated_browser', target: url, value: 'Opens in the isolated Firefox, which has no logins of yours. The new tab gets level read and act on this site' }, a.reason);
    r.sent(call, 'opening a tab in the isolated Firefox');
    const tab = await b.command('isolated', 'open', { url }, call);
    r.own(s, tab, { origin: site, level: 'act', state: 'pending' });
    s.current = tab.id;
    call.sent.outcome = 'done';
    call.tabId = tab.id;
    const now = await loaded(r, call, tab.id);
    if (now) r.tabMoved(tab.id, now.url);
    const g = r.grants.find(s.id, tab.id);
    return { tabId: tab.id, backend: 'isolated', state: now?.status === 'loading' ? 'still loading' : g?.state === 'active' ? 'loaded' : 'suspended' };
  }
  if (call.tabId < VIRTUAL || (!s.owned.has(call.tabId) && !r.grants.find(s.id, call.tabId))) throw new ToolError('no_grant', 'This session has no such tab in the isolated Firefox.');
  if (a.action === 'close') {
    r.sent(call, 'closing a tab of the isolated Firefox');
    await b.command('isolated', 'close', { tabId: call.tabId }, call);
    call.sent.outcome = 'done';
    return { closed: call.tabId };
  }
  const { action, tabId, reason, ...more } = a;
  const says = {
    dialog: () => `${a.answer === 'accept' ? 'Accept' : 'Dismiss'} the open dialog${a.text !== undefined ? ` with: ${a.text}` : ''}`,
    dialog_policy: () => ({ hold: 'Later dialogs stay open until they are answered', dismiss: 'Later dialogs are dismissed at once', accept: 'Later dialogs are ACCEPTED at once, without asking you' })[a.policy],
    emulate: () => Object.entries(more).map(([k, v]) => `${k} ${v}`).join(', ') || 'nothing',
  }[action]();
  const open = action === 'dialog' ? (await b.command('isolated', 'dialog_state', { tabId }, call)).dialog : null;
  if (action === 'dialog' && !open) throw new ToolError('not_found', 'No dialog is open in that tab.');
  await r.ask(call, spec, origin, { tool: 'isolated_browser', target: open ? `${open.type}: ${oneLine(open.message, 200)}` : `Isolated tab: ${action}`, value: says }, reason);
  r.sent(call, `${action} in the isolated Firefox`);
  const x = await b.command('isolated', action, { tabId, ...more }, call);
  call.sent.outcome = 'done';
  return { tabId, backend: 'isolated', ...redactData(x) };
}

async function debug(r, call, spec, origin, a) {
  if (call.tabId < VIRTUAL) throw new ToolError('not_supported', 'Debugging works in a tab of the isolated Firefox only. Open one with isolated_browser.');
  const { action, tabId, reason, ...more } = a;
  const g = r.grants.find(call.session.id, tabId);
  const mine = (url) => g.origins.includes(originOf(url)) || g.frames.includes(originOf(url));
  if (a.script && !mine(a.script)) throw new ToolError('no_grant', 'That script belongs to a site that this tab is not granted for.');
  const ASK = { logpoint: () => `Record local variables at ${a.script}, line ${a.line}, each time it runs`, profile_start: () => 'Record a performance profile of the isolated Firefox', video_start: () => 'Record a video of this isolated tab' };
  if (ASK[action]) {
    await r.ask(call, spec, origin, { tool: 'isolated_debug', target: ASK[action](), value: action === 'logpoint' ? null : 'The file stays in the folder of the backend' }, reason);
    r.sent(call, `${action} in the isolated Firefox`);
  }
  const x = await r.backends.command('isolated', action, { tabId, ...more }, call);
  if (call.sent) call.sent.outcome = 'done';
  if (action === 'scripts') return { origin, scripts: x.scripts.filter(mine).map((s) => ({ script: s, shown: redactUrl(s) })) };
  if (action === 'source') return { origin, script: a.script, source: redactText(x.source.slice(0, 100_000)), ...(x.source.length > 100_000 && { cut: x.source.length }) };
  if (action === 'logpoint_hits') return { origin, hits: x.hits.map((h) => ({ ...h, variables: Object.fromEntries(Object.entries(h.variables).map(([k, v]) => [k, isSecretName(k) ? '[redacted]' : redactText(String(v))])) })) };
  return { origin, ...x };
}

export const devTools = {
  read_console_messages: consoleMessages,
  read_network_requests: networkRequests,
  observe_element: watch,
  observe_read: watched(false),
  observe_stop: watched(true),
  page_query: query,
  page_timing: timing,
  webmcp_list: webmcpList,
  webmcp_call: webmcpCall,
  windows_input: windowsInput,
  isolated_browser: isolated,
  isolated_debug: debug,
};
