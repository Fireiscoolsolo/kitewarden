// Tools for tabs, windows, groups, containers and browser data. A session sees and changes only its own tabs and those the
// user gave it. Nothing here takes the focus, unless the call asks for it or Firefox does it and it is handed back.
import { LIMITS, ToolError, oneLine, originOf, plainUrl } from '../shared/protocol.mjs';
import { address, loaded } from './pagetools.mjs';
import { sleep } from './router.mjs';

const b = (r) => r.api.browser;
const mineOf = (r, s, id) => s.owned.has(id) || Boolean(r.grants.find(s.id, id));

/** A tab of this session, or the refusal that fits. */
async function mine(r, call, id) {
  const tab = await r.tab(id);
  const g = r.grants.find(call.session.id, id);
  if (!g && !call.session.owned.has(id)) {
    if (r.grants.all.some((o) => o.tabId === id && r.sessions.get(o.sessionId)?.kind !== 'sidebar')) throw new ToolError('conflict', 'Another session has this tab.');
    throw new ToolError('no_grant', 'The user has not attached this tab to this session.');
  }
  if (!tab || (tab.incognito && !g?.private)) throw new ToolError('no_grant', 'The tab is closed.');
  if (r.stoppedTabs.has(id)) throw new ToolError('stopped', r.stoppedTabs.get(id));
  return tab;
}

/** An origin that an active grant of this session covers, with its level. */
const covered = (r, s, origin) => r.grants.of(s.id).filter((g) => g.state === 'active' && !g.private && g.origins.includes(origin)).sort((x) => (x.level === 'act' ? -1 : 1))[0] ?? null;

/** Every tab or window that opens on a new origin asks first. Returns the grant that its tab gets. */
async function grantFor(r, call, spec, url, extra, reason) {
  const origin = originOf(url);
  const has = covered(r, call.session, origin);
  if (has && !extra) return { origin, level: has.level };
  await r.ask(call, spec, origin, { tool: call.tool, target: url, value: [`The new tab gets level ${has?.level ?? 'read'} on ${origin}`, extra].filter(Boolean).join('. ') }, reason);
  if (!(await r.api.hasHost(origin))) throw new ToolError('permission_required', `Firefox does not allow ${origin} yet. Ask the user to attach a tab of that site once.`);
  return { origin, level: has?.level ?? 'read' };
}

/** Right before the tab opens: without an approval an attached tab must still cover the origin. */
function opening(r, call, grant, what) {
  if (grant && !call.approved && !covered(r, call.session, grant.origin)) throw new ToolError('no_grant', 'No attached tab covers that origin any more.');
  r.sent(call, what);
}

function limit(r, s) {
  if (s.owned.size >= LIMITS.tabsOwned) throw new ToolError('limit_reached', `This session has ${LIMITS.tabsOwned} tabs: ${[...s.owned].join(', ')}. Close one first.`);
}

/** The group of the session. A group that Firefox refuses never fails the tab. */
async function putInGroup(r, s, tab) {
  try {
    s.group = await b(r).tabs.group({ tabIds: [tab.id], ...(s.group !== null ? { groupId: s.group } : { createProperties: { windowId: tab.windowId } }) });
    await b(r).tabGroups?.update(s.group, { title: s.name.slice(0, 30), color: 'blue' });
  } catch {
    // no groups in this Firefox, or the group is gone: the session still knows its tabs
  }
}

async function context(r, call, spec, origin, a) {
  const s = call.session;
  let tabs = await r.api.queryTabs();
  const list = () => tabs.filter((t) => mineOf(r, s, t.id) && (!t.incognito || r.grants.find(s.id, t.id)?.private));
  if (a.createIfEmpty && list().length === 0) {
    r.sent(call, 'opening a tab');
    r.own(s, await r.api.createTab());
    call.sent.outcome = 'done';
    tabs = await r.api.queryTabs();
  }
  const out = list().map((t) => {
    const g = r.grants.find(s.id, t.id);
    const base = { tabId: t.id, windowId: t.windowId, active: t.active, owned: s.owned.has(t.id), level: g?.level ?? null, current: s.current === t.id, ...(t.groupId > 0 && { group: t.groupId }), ...(g?.private && { private: true }) };
    if (r.stoppedTabs.has(t.id)) return { ...base, state: 'stopped' };
    // Title and address only where the grant covers the page that the tab shows now.
    if (!g || g.state !== 'active' || !g.origins.includes(originOf(t.url))) return { ...base, state: g ? 'suspended' : 'no_grant' };
    return { ...base, state: 'active', title: oneLine(t.title), url: plainUrl(t.url), loading: t.status === 'loading', discarded: t.discarded === true };
  });
  return { session: s.id, tabs: out, otherTabs: tabs.filter((t) => !t.incognito).length - list().filter((t) => !t.incognito).length };
}

async function create(r, call, spec, origin, a) {
  const s = call.session;
  limit(r, s);
  if (a.duplicateOf !== undefined) {
    const from = await mine(r, call, a.duplicateOf);
    const g = r.grants.find(s.id, from.id);
    if (!g || g.state !== 'active' || g.private) throw new ToolError('no_grant', 'Only an attached tab can be copied.');
    r.sent(call, 'copying a tab');
    const tab = await b(r).tabs.duplicate(from.id, { active: false });
    call.sent.outcome = 'done';
    r.own(s, tab, { origin: originOf(from.url), level: g.level });
    await putInGroup(r, s, tab);
    return { tabId: tab.id, windowId: tab.windowId, state: 'copied' };
  }
  const url = a.url === undefined ? null : address(a.url);
  let cookieStoreId;
  if (a.container !== undefined) {
    const found = await b(r).contextualIdentities.query({ name: a.container });
    if (found.length !== 1) throw new ToolError('not_found', `There is no container named ${JSON.stringify(a.container)}.`);
    cookieStoreId = found[0].cookieStoreId;
  }
  const grant = url ? await grantFor(r, call, spec, url, a.container !== undefined && `Container ${a.container}`, a.reason) : null;
  const front = await b(r).windows.getLastFocused({ windowTypes: ['normal'] });
  const windowId = [...s.windows][0] ?? (front.incognito ? (await b(r).windows.getAll({ windowTypes: ['normal'] })).find((w) => !w.incognito)?.id : front.id);
  opening(r, call, grant, `opening a tab${url ? ` on ${plainUrl(url)}` : ''}`);
  const tab = await b(r).tabs.create({ active: false, url: url ?? 'about:blank', ...(windowId !== undefined && { windowId }), ...(cookieStoreId && { cookieStoreId }) });
  r.own(s, tab, grant && { ...grant, state: 'pending' });
  s.current = tab.id;
  await putInGroup(r, s, tab);
  call.sent.outcome = 'done';
  if (!url) return { tabId: tab.id, windowId: tab.windowId, state: 'blank' };
  const now = await loaded(r, call, tab.id);
  if (!now) throw new ToolError('no_grant', 'The tab is closed.');
  r.tabMoved(tab.id, now.url);
  const g = r.grants.find(s.id, tab.id);
  return { tabId: tab.id, windowId: now.windowId, state: now.status === 'loading' ? 'still loading' : g?.state === 'active' ? 'loaded' : 'suspended', ...(g?.state === 'active' && { url: plainUrl(now.url), title: oneLine(now.title) }) };
}

async function close(r, call, spec, origin, a) {
  const tab = await mine(r, call, a.tabId);
  if (!call.session.owned.has(tab.id)) await r.ask(call, spec, originOf(tab.url), { tool: 'tabs_close', target: oneLine(tab.title), value: 'Text that was not sent in this tab is lost' }, a.reason);
  await mine(r, call, a.tabId);
  const { tabs } = await b(r).windows.get(tab.windowId, { populate: true });
  r.sent(call, 'closing a tab');
  await b(r).tabs.remove(tab.id);
  call.sent.outcome = 'done';
  return { closed: tab.id, window_closed: tabs.length === 1 };
}

async function select(r, call, spec, origin, a) {
  await b(r).tabs.update(a.tabId, { active: true });
  call.session.current = a.tabId;
  const tab = await r.tab(a.tabId);
  if (!a.focusWindow) return { active: tab.active };
  await b(r).windows.update(tab.windowId, { focused: true });
  await Promise.race([sleep(200), call.gone]);
  return { active: tab.active, windowFocused: (await b(r).windows.get(tab.windowId)).focused };
}

async function release(r, call, spec, origin, a) {
  await mine(r, call, a.tabId);
  call.session.owned.delete(a.tabId);
  r.revoke((g) => g.sessionId === call.session.id && g.tabId === a.tabId);
  return { released: a.tabId };
}

async function group(r, call, spec, origin, a) {
  for (const id of a.tabIds) await mine(r, call, id);
  r.sent(call, 'grouping tabs');
  const groupId = await b(r).tabs.group({ tabIds: a.tabIds });
  call.sent.outcome = 'done';
  let style = null;
  if (a.title !== undefined || a.color !== undefined) {
    try {
      if (!b(r).tabGroups) throw new Error('Firefox allows a title and a color only with the tab groups permission, which the user can give in the sidebar.');
      await b(r).tabGroups.update(groupId, { ...(a.title !== undefined && { title: a.title }), ...(a.color !== undefined && { color: a.color }) });
    } catch (e) {
      style = oneLine(e.message, 200);
    }
  }
  return { group: groupId, tabs: a.tabIds, ...(style && { style_error: style }) };
}

async function ungroup(r, call, spec, origin, a) {
  for (const id of a.tabIds) await mine(r, call, id);
  r.sent(call, 'ungrouping tabs');
  await b(r).tabs.ungroup(a.tabIds);
  call.sent.outcome = 'done';
  return { ungrouped: a.tabIds };
}

async function closedTabs(r, call, spec, origin, a) {
  const s = call.session;
  if (a.action === 'list') return { tabs: s.closed.map(({ id, title, url }) => ({ id, title, url: plainUrl(url) })) };
  const c = s.closed.find((x) => x.id === a.id);
  if (!c) throw new ToolError('not_found', 'This session had no such tab.');
  limit(r, s);
  await r.ask(call, spec, originOf(c.url), { tool: 'closed_tabs', target: c.url, value: 'Opens again in the background, with level read' }, a.reason);
  r.sent(call, 'reopening a tab');
  const tab = await b(r).tabs.create({ active: false, url: c.url, ...(c.cookieStoreId && { cookieStoreId: c.cookieStoreId }) });
  s.closed = s.closed.filter((x) => x !== c);
  r.own(s, tab, { origin: originOf(c.url), level: 'read', state: 'pending' });
  await putInGroup(r, s, tab);
  call.sent.outcome = 'done';
  return { tabId: tab.id, history_restored: false };
}

// Windows

async function windowsList(r, call) {
  const s = call.session;
  const all = (await b(r).windows.getAll({ populate: true, windowTypes: ['normal'] })).filter((w) => !w.incognito || w.tabs.some((t) => r.grants.find(s.id, t.id)?.private));
  const own = all.filter((w) => w.tabs.some((t) => mineOf(r, s, t.id)));
  return { windows: own.map((w) => ({ windowId: w.id, state: w.state, width: w.width, height: w.height, focused: w.focused, my_tabs: w.tabs.filter((t) => mineOf(r, s, t.id)).length, owned: s.windows.has(w.id) })), otherWindows: all.length - own.length };
}

async function windowsCreate(r, call, spec, origin, a) {
  const s = call.session;
  limit(r, s);
  const url = a.url === undefined ? null : address(a.url);
  const grant = url ? await grantFor(r, call, spec, url, null, a.reason) : null;
  const front = await b(r).windows.getLastFocused().catch(() => null);
  opening(r, call, grant, 'opening a window');
  const w = await b(r).windows.create({ url: url ?? 'about:blank', incognito: false });
  s.windows.add(w.id);
  const [tab] = w.tabs ?? (await b(r).tabs.query({ windowId: w.id }));
  r.own(s, tab, grant && { ...grant, state: 'pending' });
  s.current = tab.id;
  // Firefox raises a new window. The one that had the focus gets it back.
  let handed = null;
  if (front?.focused) {
    await b(r).windows.update(front.id, { focused: true });
    await Promise.race([sleep(300), call.gone]);
    handed = (await b(r).windows.get(front.id)).focused;
  }
  call.sent.outcome = 'done';
  return { windowId: w.id, tabId: tab.id, focus_returned: handed };
}

async function windowsClose(r, call, spec, origin, a) {
  const w = await b(r).windows.get(a.windowId, { populate: true }).catch(() => null);
  const s = call.session;
  if (!w || !w.tabs.some((t) => mineOf(r, s, t.id))) throw new ToolError('no_grant', 'That window holds no tab of this session.');
  const others = w.tabs.filter((t) => !s.owned.has(t.id)).length;
  if (others) throw Object.assign(new ToolError('not_allowed', `The window holds ${others} tabs that this session does not own.`), { data: { otherTabs: others } });
  r.sent(call, 'closing a window');
  await b(r).windows.remove(w.id);
  s.windows.delete(w.id);
  call.sent.outcome = 'done';
  return { closed: w.id };
}

async function resize(r, call, spec, origin, a) {
  const tab = await r.tab(call.tabId);
  const w = await b(r).windows.get(tab.windowId, { populate: true });
  if (w.tabs.some((t) => !mineOf(r, call.session, t.id))) {
    await r.ask(call, spec, origin, { tool: 'resize_window', target: 'A window that holds other tabs as well', value: ['state', 'width', 'height', 'left', 'top'].filter((k) => a[k] !== undefined).map((k) => `${k} ${a[k]}`).join(', ') }, a.reason);
  }
  const change = {};
  for (const k of ['state', 'width', 'height', 'left', 'top']) if (a[k] !== undefined) change[k] = a[k];
  if (change.state && change.state !== 'normal') for (const k of ['width', 'height', 'left', 'top']) delete change[k];
  r.sent(call, 'changing a window');
  await b(r).windows.update(w.id, change);
  call.sent.outcome = 'done';
  await Promise.race([sleep(300), call.gone]);
  const now = await b(r).windows.get(w.id);
  return { state: now.state, width: now.width, height: now.height, left: now.left, top: now.top };
}

async function containers(r, call) {
  let list;
  try {
    list = await b(r).contextualIdentities.query({});
  } catch {
    return { containers: [], note: 'Containers are turned off in this Firefox.' };
  }
  const tabs = (await r.api.queryTabs()).filter((t) => mineOf(r, call.session, t.id));
  return { containers: list.map((c) => ({ name: c.name, color: c.color, icon: c.icon, my_tabs: tabs.filter((t) => t.cookieStoreId === c.cookieStoreId).length })) };
}

// The user picks a tab

async function request(r, call, spec, origin, a) {
  const s = call.session;
  if ([...r.requests.values()].some((x) => x.session === s && x.state === 'pending')) throw new ToolError('rate_limited', 'A request of this session waits already.');
  const id = `rq_${crypto.randomUUID().slice(0, 12)}`;
  let wake;
  const answered = new Promise((f) => (wake = f));
  const x = { id, session: s, reason: oneLine(a.reason, 200), level: a.level, state: 'pending', tabId: null, answered, wake: () => (clearTimeout(timer), wake()) };
  r.requests.set(id, x);
  const timer = setTimeout(() => {
    if (x.state === 'pending') x.state = 'timed_out';
    wake();
    r.onChange();
  }, LIMITS.requestMs);
  r.onChange();
  return { request_id: id, state: 'pending' };
}

async function requestResult(r, call, spec, origin, a) {
  const x = r.requests.get(a.request_id);
  if (!x || x.session !== call.session) throw new ToolError('unknown_request', 'There is no such request of this session.');
  if (x.state === 'pending' && a.wait_s) await Promise.race([x.answered, sleep(a.wait_s * 1000), call.gone]);
  if (x.state !== 'pending') r.requests.delete(x.id);
  return { state: x.state, ...(x.state === 'granted' && { tabId: x.tabId }) };
}

// Bookmarks, history, downloads

async function searchBookmarks(r, call, spec, origin, a) {
  await r.ask(call, spec, null, { tool: 'search_bookmarks', target: `Bookmarks with: ${a.query}` }, a.reason);
  const hits = (await b(r).bookmarks.search({ query: a.query })).filter((x) => x.url && originOf(x.url));
  return { total: hits.length, bookmarks: hits.slice(0, 200).map((x) => ({ id: x.id, title: oneLine(x.title), url: plainUrl(x.url) })) };
}

async function addBookmark(r, call, spec, origin, a) {
  const url = address(a.url);
  await r.ask(call, spec, null, { tool: 'add_bookmark', target: url, value: `${a.title} (Other Bookmarks)` }, a.reason);
  const [has] = await b(r).bookmarks.search({ url });
  if (has) return { exists: true, id: has.id };
  r.sent(call, 'adding a bookmark');
  const made = await b(r).bookmarks.create({ title: a.title, url, parentId: 'unfiled_____' });
  call.sent.outcome = 'done';
  return { exists: false, id: made.id };
}

async function searchHistory(r, call, spec, origin, a) {
  const days = a.days ?? 30;
  await r.ask(call, spec, null, { tool: 'search_history', target: `History of ${days} days with: ${a.query}` }, a.reason);
  const hits = (await b(r).history.search({ text: a.query, startTime: r.now() - days * 86_400_000, maxResults: 500 })).filter((x) => originOf(x.url));
  return { entries: hits.slice(0, 100).map((x) => ({ title: oneLine(x.title), url: plainUrl(x.url), last_visit: new Date(x.lastVisitTime).toISOString() })), cut: hits.length > 100 };
}

async function downloadsOf(r, s) {
  const list = [];
  for (const id of s.downloads) list.push(...(await b(r).downloads.search({ id })));
  return list.map((d) => ({ id: d.id, file: d.filename.split(/[\\/]/).pop(), url: plainUrl(d.url), state: d.state, bytes: d.bytesReceived, size: d.fileSize, started: d.startTime }));
}

async function download(r, call, spec, origin, a) {
  const at = await r.authorize(call, { level: 'read' });
  const url = address(a.url);
  if (originOf(url) !== at) throw new ToolError('not_allowed', `Only addresses of ${at} can be downloaded from this tab.`);
  if (a.filename !== undefined && (/[\\/:*?"<>|]/.test(a.filename) || /^\.+$/.test(a.filename))) throw new ToolError('invalid_argument', 'filename is a plain name without a folder.');
  await r.ask(call, spec, at, { tool: 'download_start', target: url, value: `Into the Downloads folder${a.filename ? ` as ${a.filename}` : ''}` }, a.reason);
  if ((await r.authorize(call, { level: 'read' })) !== at) throw new ToolError('origin_changed', 'The page changed its origin.');
  const tab = await r.tab(call.tabId);
  r.sent(call, `download of ${plainUrl(url)}`);
  const id = await b(r).downloads.download({ url, conflictAction: 'uniquify', saveAs: false, incognito: tab.incognito === true, ...(a.filename && { filename: a.filename }), ...(tab.cookieStoreId && { cookieStoreId: tab.cookieStoreId }) });
  call.session.downloads.push(id);
  for (let n = 0; n < 300; n++) {
    const [d] = await b(r).downloads.search({ id });
    if (d && d.state !== 'in_progress') break;
    await Promise.race([sleep(200), call.gone]);
  }
  call.sent.outcome = 'done';
  return (await downloadsOf(r, call.session)).find((d) => d.id === id);
}

export const tabTools = {
  tabs_context: context,
  tab_request: request,
  tab_request_result: requestResult,
  tabs_create: create,
  tabs_close: close,
  tabs_select: select,
  tabs_release: release,
  tabs_group: group,
  tabs_ungroup: ungroup,
  closed_tabs: closedTabs,
  windows_list: windowsList,
  windows_create: windowsCreate,
  windows_close: windowsClose,
  resize_window: resize,
  containers_list: containers,
  search_bookmarks: searchBookmarks,
  add_bookmark: addBookmark,
  search_history: searchHistory,
  list_downloads: async (r, call) => ({ downloads: await downloadsOf(r, call.session) }),
  download_start: download,
};
