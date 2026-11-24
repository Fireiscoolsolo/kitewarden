// Wiring: browser events, the native port and the sidebar ports. Rules live in router.mjs and ext/grants.
import { Approvals } from '../grants/approvals.mjs';
import { Grants } from '../grants/grants.mjs';
import { LIMITS, ToolError, hostPattern, oneLine, originOf } from '../shared/protocol.mjs';
import { NativeLink } from './native.mjs';
import { Router } from './router.mjs';

const HOST = 'firefox_companion';
const SIDEBAR = browser.runtime.getURL('sidebar/sidebar.html');
const LOG_LINES = 500;

const api = {
  getTab: (id) => browser.tabs.get(id),
  queryTabs: () => browser.tabs.query({}),
  createTab: () => browser.tabs.create({ active: false, url: 'about:blank' }),
  hasHost: (origin) => (origin ? browser.permissions.contains({ origins: [hostPattern(origin)] }) : Promise.resolve(false)),
  hasAllUrls: () => browser.permissions.contains({ origins: ['<all_urls>'] }),
  async page(tabId, message, wanted) {
    try {
      await browser.tabs.executeScript(tabId, { file: '/page/content.js', runAt: 'document_end' });
    } catch {
      return { error: 'restricted_page', message: 'Firefox does not let add-ons into this page.' };
    }
    // The user may have revoked or paused while the script went in.
    return wanted() ? browser.tabs.sendMessage(tabId, message, { frameId: 0 }).catch(() => null) : null;
  },
  forget: (tabId) => browser.tabs.sendMessage(tabId, { cmd: 'forget' }, { frameId: 0 }).catch(() => {}),
  captureTab: async (tabId) => {
    const tab = await browser.tabs.get(tabId);
    const scale = Math.min(1, LIMITS.imageEdge / Math.max(tab.width || 1, tab.height || 1));
    return smallest((quality) => browser.tabs.captureTab(tabId, { format: 'jpeg', quality, scale }));
  },
  // shortcut: no scaling without <all_urls>, only a lower quality; scale in a canvas when FC-SHOT-01 is completed.
  captureVisible: (windowId) => smallest((quality) => browser.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality })),
};

async function smallest(take) {
  let url;
  for (const quality of [85, 60, 35]) {
    url = await take(quality);
    if (url.length < LIMITS.imageBase64) break;
  }
  return url;
}

const grants = new Grants();
const approvals = new Approvals({ onChange: changed });
let log = [];
let saveLog = null;

const router = new Router({
  api,
  grants,
  approvals,
  onChange: changed,
  linkStatus: () => ({ state: native.status.state, version: native.status.host }),
  log(line) {
    log.push(line);
    log = log.slice(-LOG_LINES);
    saveLog ??= setTimeout(() => {
      saveLog = null;
      browser.storage.local.set({ log });
    }, 1000);
    changed();
  },
});

// Native host and MCP sessions

const sendTo = (session, body) => native.post({ type: 'to_client', session, body: JSON.stringify(body) });

const native = new NativeLink({
  open: () => browser.runtime.connectNative(HOST),
  onChange: changed,
  onLost: () => {
    for (const s of [...router.sessions.values()]) if (s.kind === 'mcp') router.endSession(s.id);
  },
  onMessage(m) {
    if (m.type === 'session_open') router.openSession(m.session, 'mcp', 'without a name');
    else if (m.type === 'session_close') router.endSession(m.session);
    else if (m.type === 'from_client') fromClient(m.session, m.body);
    else console.error('refused host message', m.type);
  },
});

async function fromClient(sessionId, body) {
  const session = router.sessions.get(sessionId);
  let m;
  try {
    m = JSON.parse(body);
  } catch {
    m = null;
  }
  if (!session || session.kind !== 'mcp') return;
  if (m?.type === 'hello') {
    router.label(sessionId, `${m.client?.name ?? 'without a name'} ${m.client?.version ?? ''}`);
  } else if (m?.type === 'call' && Number.isSafeInteger(m.id)) {
    sendTo(sessionId, { type: 'result', id: m.id, ...(await router.call(sessionId, m.id, String(m.tool), m.args)) });
  } else if (m?.type === 'cancel') {
    router.cancel(sessionId, m.id);
  } else {
    console.error('refused client message', oneLine(m?.type, 40));
  }
}

// Sidebar

const ports = new Set();

const fromSidebar = {
  connect: () => {
    browser.storage.local.set({ connect: true });
    native.start();
  },
  disconnect: () => {
    browser.storage.local.set({ connect: false });
    native.stop();
  },
  retry: () => native.retryNow(),
  pause: ({ on }) => {
    browser.storage.local.set({ paused: on === true });
    router.setPaused(on === true);
  },
  grant: (m) => router.grant({ sessionId: m.session, tabId: m.tabId, origin: m.origin, level: m.level }),
  approve_origin: (m) => router.approveOrigin(m.grant, m.origin),
  revoke: (m) => router.revoke((g) => g.id === m.grant),
  revoke_all: () => router.revoke(() => true),
  end_session: (m) => {
    if (router.sessions.get(m.session)?.kind !== 'mcp') return;
    sendTo(m.session, { type: 'bye', message: 'The user disconnected this session.' });
    router.endSession(m.session, 'stopped');
    // The replies of the ended calls go out first.
    setTimeout(() => native.post({ type: 'close_session', session: m.session }));
  },
  card_shown: (m) => approvals.shown(m.card),
  answer: (m) => approvals.answer(m.card, m.allow),
  call: (m) => router.call('sidebar', m.id, m.tool, m.args),
};

browser.runtime.onConnect.addListener((port) => {
  // Only the sidebar itself: not a tab that shows the same page, not a content script, not another add-on.
  const { id, url, tab, frameId } = port.sender;
  if (port.name !== 'sidebar' || id !== browser.runtime.id || url !== SIDEBAR || tab || frameId) return port.disconnect();
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener(async (m) => {
    let reply;
    try {
      if (!Object.hasOwn(fromSidebar, m.type)) throw new ToolError('invalid_argument', 'Unknown message.');
      reply = (await fromSidebar[m.type](m)) ?? {};
    } catch (e) {
      reply = { error: { code: e.code ?? 'internal_error', message: e.message } };
    }
    if (m.id !== undefined && ports.has(port)) port.postMessage({ type: 'reply', id: m.id, reply });
  });
  port.postMessage({ type: 'state', state: view() });
});

function view() {
  return {
    link: { ...native.status },
    paused: router.paused,
    sessions: [...router.sessions.values()].map(({ id, kind, label }) => ({ id, kind, label })),
    grants: grants.all.map((g) => ({ ...g })),
    approvals: approvals.cards,
    log: log.slice(-30),
  };
}

let queued = false;
function changed() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    for (const p of ports) p.postMessage({ type: 'state', state: view() });
    const [text, title] = approvals.cards.length
      ? ['?', 'An approval is waiting']
      : router.paused
        ? ['II', 'Paused']
        : native.connected
          ? ['', 'Connected']
          : ['!', 'Not connected'];
    browser.browserAction.setBadgeText({ text });
    browser.browserAction.setTitle({ title: `Firefox Companion: ${title}` });
  });
}

// Browser events

browser.browserAction.onClicked.addListener(() => browser.sidebarAction.open());
browser.tabs.onUpdated.addListener((tabId, info) => info.url && router.tabMoved(tabId, info.url), { properties: ['url'] });
browser.tabs.onRemoved.addListener((tabId) => router.tabClosed(tabId));
browser.tabs.onCreated.addListener((tab) => router.tabOpened(tab));
browser.permissions.onRemoved.addListener(() => router.permissionsRemoved());

router.openSession('sidebar', 'sidebar', 'This sidebar');
browser.storage.local.get({ connect: false, paused: false, log: [] }).then((s) => {
  log = [...s.log, ...log].slice(-LOG_LINES);
  router.setPaused(s.paused);
  if (s.connect) native.start();
});
