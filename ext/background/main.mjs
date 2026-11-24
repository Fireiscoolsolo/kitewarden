// Wiring: browser events, the native port and the sidebar ports. Rules live in router.mjs and ext/grants.
import { Gif } from '../capture/gif.mjs';
import { Chats } from '../chat/chats.mjs';
import { Approvals } from '../grants/approvals.mjs';
import { Grants } from '../grants/grants.mjs';
import { LIMITS, ToolError, hostPattern, oneLine, originOf } from '../shared/protocol.mjs';
import { Replay } from '../workflow/replay.mjs';
import { Workflows, skillText } from '../workflow/workflows.mjs';
import { NativeLink } from './native.mjs';
import { Router } from './router.mjs';

const HOST = 'firefox_companion';
const SIDEBAR = browser.runtime.getURL('sidebar/sidebar.html');
const LOG_LINES = 500;
const ASK_MS = 70_000;
const INFO_MS = 10 * 60_000;
const CHAT_MS = 80; // streamed text reaches the sidebar in steps of this length

const api = {
  getTab: (id) => browser.tabs.get(id),
  queryTabs: () => browser.tabs.query({}),
  createTab: () => browser.tabs.create({ active: false, url: 'about:blank' }),
  openUrl: (id, url) => browser.tabs.update(id, { url }),
  hasHost: (origin) => (origin ? browser.permissions.contains({ origins: [hostPattern(origin)] }) : Promise.resolve(false)),
  hasAllUrls: () => browser.permissions.contains({ origins: ['<all_urls>'] }),
  async page(tabId, message, wanted, frameId = 0) {
    try {
      await browser.tabs.executeScript(tabId, { file: '/page/content.js', runAt: 'document_end', frameId, matchAboutBlank: true });
    } catch {
      return { error: 'restricted_page', message: 'Firefox does not let add-ons into this page.' };
    }
    // The user may have revoked or paused while the script went in.
    return wanted() ? browser.tabs.sendMessage(tabId, message, { frameId }).catch(() => null) : null;
  },
  forget: (tabId) => browser.tabs.sendMessage(tabId, { cmd: 'forget' }).catch(() => {}), // every frame
  abort: (tabId, frameId) => browser.tabs.sendMessage(tabId, { cmd: 'abort' }, { frameId }).catch(() => {}),
  browser,
  host: (type, data) => ask(type, data),
  windowState: async (id) => (await browser.windows.get(id)).state,
  annotate,
  sessionEnded(s) {
    // Its tabs stay open and leave the group of the session.
    if (s.group !== null && s.owned.size) browser.tabs.ungroup([...s.owned]).catch(() => {});
  },
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

/** The picture with numbers on the given boxes, and its size. */
async function annotate(dataUrl, marks, css) {
  const img = await createImageBitmap(await (await fetch(dataUrl)).blob());
  if (!marks.length) return { dataUrl, width: img.width, height: img.height };
  const canvas = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
  const g = canvas.getContext('2d');
  g.drawImage(img, 0, 0);
  const k = img.width / css.width;
  g.font = 'bold 13px sans-serif';
  g.textBaseline = 'top';
  marks.forEach((m, n) => {
    const [x, y] = [m.left * k, m.top * k];
    g.strokeStyle = g.fillStyle = '#e22850';
    g.lineWidth = 2;
    g.strokeRect(x, y, m.width * k, m.height * k);
    g.fillRect(x, y, g.measureText(String(n + 1)).width + 6, 16);
    g.fillStyle = '#fff';
    g.fillText(String(n + 1), x + 3, y + 2);
  });
  const out = await smallest(async (quality) => canvas.toDataURL('image/jpeg', quality / 100));
  return { dataUrl: out, width: img.width, height: img.height };
}

const grants = new Grants();
const approvals = new Approvals({ onChange: changed });
let log = [];
let saveLog = null;

const gif = new Gif({ onChange: changed, onStop: (tabId) => pill(tabId, null) });
/** The tab itself, and every frame of an origin that the sidebar's grant covers. The content script checks the origin. */
async function recorderPage(tabId, origin, message, frames = []) {
  const top = await api.page(tabId, { ...message, origin }, () => true);
  if (message.cmd === 'record') {
    const enter = async (parent, parentOrigin, depth) => {
      const r = await api.page(tabId, { cmd: 'children', origin: parentOrigin }, () => true, parent);
      for (const c of r?.children ?? []) {
        const w = await api.page(tabId, { cmd: 'where' }, () => true, c.frame);
        if (!w?.origin || (w.origin !== origin && !frames.includes(w.origin))) continue;
        await api.page(tabId, { ...message, origin: w.origin }, () => true, c.frame);
        if (depth < LIMITS.frameDepth) await enter(c.frame, w.origin, depth + 1);
      }
    };
    await enter(0, origin, 1).catch(() => {});
  }
  return top;
}
const workflows = new Workflows({ store: browser.storage.local, grants, getTab: api.getTab, page: recorderPage, onChange: changed });

const router = new Router({
  api,
  grants,
  approvals,
  gif,
  onGrantEnd(g) {
    gif.grantEnded(g);
    workflows.grantEnded(g);
  },
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

const replay = new Replay({ router, onChange: changed });
const chats = new Chats({ store: browser.storage.local, post: (m) => native.post(m), connected: () => native.connected, router, onChange: chatChanged });

/** The mark of a GIF recording in the page. A workflow recording puts its own there. */
async function pill(tabId, kind) {
  const origin = originOf((await api.getTab(tabId).catch(() => null))?.url);
  if (!origin) return;
  await recorderPage(tabId, origin, { cmd: 'pill', kind });
  if (!kind) workflows.tabLoaded(tabId);
}

// Native host and MCP sessions

const sendTo = (session, body) => native.post({ type: 'to_client', session, body: JSON.stringify(body) });
const asks = new Map();
let nextAsk = 1;

const profile = { id: null, label: null };
const native = new NativeLink({
  hello: () => ({ profile: profile.id, label: profile.label }),
  open: () => browser.runtime.connectNative(HOST),
  onChange() {
    if (native.connected && chats.current) chats.session(chats.current);
    changed();
  },
  onLost: () => {
    router.rememberLost();
    chats.linkLost(); // says what had happened, and ends its sessions
    for (const done of [...asks.values()]) done(new ToolError('outcome_unknown', 'The helper stopped before it answered.'));
    for (const s of [...router.sessions.values()]) if (s.kind === 'mcp') router.endSession(s.id);
  },
  onMessage(m) {
    if (m.type === 'session_open') router.openSession(m.session, 'mcp', 'without a name');
    else if (m.type === 'session_close') {
      chats.unlink(m.session);
      router.endSession(m.session);
    } else if (m.type === 'from_client') fromClient(m.session, m.body);
    else if (m.type === 'chat_event' || m.type === 'chat_exit') chats.onHost(m);
    else if (m.type === 'reply') asks.get(m.id)?.(null, m.result);
    else console.error('refused host message', m.type);
  },
});

/** One question to the helper. */
function ask(type, data = {}) {
  if (!native.connected) throw new ToolError('not_connected', 'The helper is not running. Press Connect.');
  return new Promise((resolve, reject) => {
    const id = `q${nextAsk++}`;
    const done = (error, result) => {
      clearTimeout(timer);
      asks.delete(id);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => done(new ToolError('timeout', 'The helper did not answer.')), ASK_MS);
    asks.set(id, done);
    native.post({ ...data, type, id });
  });
}

let info = { at: 0, value: null };
async function claudeInfo(fresh) {
  if (fresh || !info.value || Date.now() - info.at > INFO_MS) info = { at: Date.now(), value: await ask('claude_info') };
  return info.value;
}

/** `pipe` is a client, or the MCP server of a chat run, which works in the session of its chat. */
async function fromClient(pipe, body) {
  let m;
  try {
    m = JSON.parse(body);
  } catch {
    m = null;
  }
  const chat = chats.sessionOf(pipe);
  if (chat === undefined) {
    if (m?.type === 'call') sendTo(pipe, { type: 'result', id: m.id, error: { code: 'stopped', message: 'The user stopped this chat. The call was not carried out.' } });
    return;
  }
  const sessionId = chat ?? pipe;
  const session = router.sessions.get(sessionId);
  if (session?.kind !== (chat ? 'chat' : 'mcp')) return;
  if (m?.type === 'hello') {
    if (chat) return;
    if (chats.redeem(pipe, m.ticket)) router.endSession(pipe);
    else router.label(pipe, `${m.client?.name ?? 'without a name'} ${m.client?.version ?? ''}`);
  } else if (m?.type === 'call' && Number.isSafeInteger(m.id)) {
    sendTo(pipe, { type: 'result', id: m.id, ...(await router.call(sessionId, `${pipe}:${m.id}`, String(m.tool), m.args)) });
  } else if (m?.type === 'cancel') {
    router.cancel(sessionId, `${pipe}:${m.id}`);
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
  halt() {
    // It holds as a pause after a restart of Firefox.
    browser.storage.local.set({ paused: true });
    const report = router.halt();
    chats.stopAll();
    replay.cancel();
    return report;
  },
  resume() {
    browser.storage.local.set({ paused: router.paused });
    router.resume();
  },
  stop_tab: (m) => ({ calls: router.stopTab(m.tabId) }),
  resume_tab: (m) => router.resumeTab(m.tabId),
  approve_frames: (m) => router.approveFrames(m.grant, m.origin),
  frames(m) {
    const g = grants.get(m.grant);
    return g ? router.call(g.sessionId, `frames:${m.id}`, 'list_frames', { tabId: g.tabId }, { user: true }) : {};
  },
  regrant: (m) => router.regrant(m.lost, m.session),
  request_answer: (m) => router.answerRequest(m.request, m.deny ? {} : { tabId: m.tabId, origin: m.origin, level: m.level, private: m.private === true, move: m.move === true }),
  set_switch(m) {
    if (!['bookmarks', 'history', 'downloads'].includes(m.name)) throw new ToolError('invalid_argument', 'Unknown switch.');
    router.switches[m.name] = m.on === true;
    browser.storage.local.set({ switches: router.switches });
    changed();
  },
  async add_folder(m) {
    const r = await ask('folder_check', { path: String(m.path) });
    if (r.code) throw new ToolError(r.code, r.message);
    router.folders = [...new Set([...router.folders, r.path])];
    browser.storage.local.set({ folders: router.folders });
    changed();
  },
  remove_folder(m) {
    router.folders = router.folders.filter((f) => f !== m.path);
    browser.storage.local.set({ folders: router.folders });
    changed();
  },
  set_label(m) {
    profile.label = oneLine(m.label, 40) || 'Firefox';
    browser.storage.local.set({ profile });
    native.post({ type: 'label', label: profile.label });
    changed();
  },
  pause: ({ on }) => {
    browser.storage.local.set({ paused: on === true });
    router.setPaused(on === true);
  },
  grant: (m) => router.grant({ sessionId: m.session, tabId: m.tabId, origin: m.origin, level: m.level, private: m.private === true, move: m.move === true }),
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
  call: (m) => router.call('sidebar', m.id, m.tool, m.args, { user: true }),

  claude_info: (m) => claudeInfo(m.fresh === true),
  chat_new: (m) => void chats.create({ model: m.model || null, extras: m.extras === true }),
  chat_select: (m) => chats.select(m.chat),
  chat_configure: (m) => chats.configure(m.chat, { model: m.model || null, extras: m.extras }),
  chat_delete: (m) => chats.remove(m.chat),
  chat_undo: (m) => chats.undo(m.chat),
  chat_clear: () => chats.clear(),
  chat_search: (m) => ({ ids: chats.search(m.query) }),
  /** A grant for the session of a chat. It never lowers one that covers the page already. */
  async chat_grant(m) {
    const sessionId = chats.session(m.chat);
    const g = grants.find(sessionId, m.tabId);
    if (g?.state === 'active' && g.origins.includes(m.origin) && (g.level === 'act' || m.level === 'read')) return;
    await router.grant({ sessionId, tabId: m.tabId, origin: m.origin, level: m.level, move: m.move === true });
  },
  chat_attach_tab: (m) => chats.attachTab(m.chat, m.kind, m.tabId),
  chat_attach_file: (m) => chats.attachFile(m.chat, { name: m.name, base64: m.base64 }),
  chat_detach: (m) => chats.detach(m.chat, m.draft),
  chat_preview: (m) => chats.preview(m.chat, m.draft),
  chat_send: (m) => chats.send(m.chat, m.text),
  chat_retry: (m) => chats.retry(m.chat),
  chat_unqueue: (m) => chats.unqueue(m.chat, m.index),
  chat_flush: (m) => chats.flush(m.chat),
  chat_stop: (m) => chats.stop(m.chat),

  wf_start: (m) => workflows.start(m.tabId),
  wf_pause: (m) => workflows.pause(m.on === true),
  wf_stop: () => workflows.stop(),
  wf_cancel: () => workflows.cancel(),
  wf_save: (m) => workflows.save({ id: m.workflow ?? null, title: m.title, steps: m.steps }),
  wf_delete: (m) => workflows.remove(m.workflow),
  wf_preview: (m) => replay.preview(workflows.get(m.workflow), m.tabId),
  wf_replay: (m) => replay.start(workflows.get(m.workflow), m.tabId, m.values),
  wf_proceed: (m) => replay.proceed({ done: m.done === true }),
  wf_retry: () => replay.retry(),
  wf_stop_replay: () => replay.cancel(),
  wf_close_replay: () => replay.clear(),
  /** With `dry` it only says what would be written and where. */
  async skill(m) {
    const name = String(m.name);
    const text = skillText(workflows.get(m.workflow), name);
    const r = await ask('skill_write', { name, text, dry: m.dry === true, replace: m.replace === true });
    if (r.error) throw new ToolError('not_allowed', r.error);
    return { ...r, text };
  },
  gif_start: (m) => router.call(m.session, `gif:${m.id}`, 'gif_creator', { action: 'start', tabId: m.tabId }, { user: true }),
  gif_export: (m) => gif.export(m.session, m.tabId, {}),
  gif_stop: (m) => gif.stop(m.session, m.tabId, 'stopped'),
  gif_clear: (m) => gif.clear(m.session, m.tabId),
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
  port.postMessage({ type: 'chat', chat: chats.open() });
});

// Content scripts report the user's own gestures, and only while the user records.
browser.runtime.onMessage.addListener((m, sender) => {
  if (sender.id !== browser.runtime.id || !sender.tab) return;
  if (m?.type === 'step') return void workflows.onStep(m.step, sender.tab.id, sender.url, sender.frameId, sender.origin);
  if (sender.frameId !== 0) return;
  if (m?.type === 'take_over') router.stopTab(sender.tab.id);
  else if (m?.type !== 'stop_recording') return;
  else if (m.kind === 'GIF') gif.view().filter((g) => g.tabId === sender.tab.id).forEach((g) => gif.stop(g.session, g.tabId, 'You stopped it in the page.'));
  else if (workflows.rec?.tabId === sender.tab.id) workflows.stop();
});

function view() {
  return {
    link: { ...native.status },
    paused: router.paused,
    sessions: [...router.sessions.values()].map(({ id, kind, label }) => ({ id, kind, label })),
    grants: grants.all.map((g) => ({ ...g })),
    approvals: approvals.cards,
    log: log.slice(-30),
    chats: chats.view(),
    workflows: workflows.view(),
    replay: replay.state,
    gifs: gif.view(),
    halted: router.halted,
    activity: router.activity,
    stoppedTabs: [...router.stoppedTabs.keys()],
    requests: [...router.requests.values()].filter((x) => x.state === 'pending').map(({ id, session, reason, level }) => ({ id, session: session.label, reason, level })),
    lost: router.lost.map(({ id, kind, name, grants: g }) => ({ id, kind, name, tabs: g.length })),
    switches: router.switches,
    folders: router.folders,
    profile,
  };
}

let queued = false;
function changed() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    for (const p of ports) p.postMessage({ type: 'state', state: view() });
    const [text, title] = approvals.cards.length || [...router.requests.values()].some((x) => x.state === 'pending')
      ? ['?', 'An approval is waiting']
      : router.paused || router.halted
        ? ['II', router.halted ? 'Stopped' : 'Paused']
        : native.connected
          ? ['', 'Connected']
          : ['!', 'Not connected'];
    browser.browserAction.setBadgeText({ text });
    browser.browserAction.setTitle({ title: `Firefox Companion: ${title}` });
  });
}

// shortcut: the whole open chat goes to the sidebar each time (at most 400 items); send only what changed if that is slow.
let chatTimer = null;
function chatChanged() {
  chatTimer ??= setTimeout(() => {
    chatTimer = null;
    for (const p of ports) p.postMessage({ type: 'chat', chat: chats.open() });
    changed();
  }, CHAT_MS);
}

// Browser events

browser.browserAction.onClicked.addListener(() => browser.sidebarAction.open());
browser.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url) {
    router.tabMoved(tabId, change.url);
    workflows.tabMoved(tabId, change.url);
  }
  if (change.status !== 'complete') return;
  workflows.tabLoaded(tabId);
  if (workflows.rec?.tabId !== tabId && gif.view().some((g) => g.on && g.tabId === tabId)) pill(tabId, 'GIF');
}, { properties: ['url', 'status'] });
browser.tabs.onActivated.addListener(({ tabId }) => workflows.tabShown(tabId));
browser.tabs.onRemoved.addListener((tabId) => router.tabClosed(tabId));
browser.tabs.onCreated.addListener((tab) => router.tabOpened(tab));
browser.permissions.onRemoved.addListener(() => router.permissionsRemoved());

router.openSession('sidebar', 'sidebar', 'This sidebar');
browser.storage.local.get({ connect: false, paused: false, log: [], switches: {}, folders: [], profile: null }).then(async (s) => {
  log = [...s.log, ...log].slice(-LOG_LINES);
  router.setPaused(s.paused);
  router.switches = s.switches;
  router.folders = s.folders;
  // A random ID of this profile and nothing else. The helper keeps one pipe for each.
  Object.assign(profile, s.profile ?? { id: crypto.randomUUID(), label: 'Firefox' });
  if (!s.profile) browser.storage.local.set({ profile });
  await Promise.all([chats.load(), workflows.load()]);
  if (s.connect) native.start();
});
