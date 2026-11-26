// The add-on for Thunderbird: the same sessions, cards, pause, stop and log as in Firefox, with tools for reading mail only.
import { NativeLink } from '../background/native.mjs';
import { Router } from '../background/router.mjs';
import { Approvals } from '../grants/approvals.mjs';
import { Grants } from '../grants/grants.mjs';
import { ToolError, oneLine } from '../shared/protocol.mjs';
import { Shares, mailTools } from './mail.mjs';

const HOST = 'kitewarden_mail';
const PAGE = browser.runtime.getURL('thunderbird/page.html');
const profile = { id: null, label: 'Thunderbird' };
let log = [];

const approvals = new Approvals({ onChange: changed });
const shares = new Shares();
const none = () => Promise.reject(new Error('Thunderbird has no page tools'));
const router = new Router({
  api: { getTab: none, queryTabs: async () => [], page: async () => null, forget() {}, hasHost: async () => false, hasAllUrls: async () => false, browser },
  grants: new Grants(),
  approvals,
  handlers: mailTools({ messenger: browser, shares }),
  onChange: changed,
  linkStatus: () => ({ state: native.status.state, version: native.status.host }),
  log(line) {
    log = [...log, line].slice(-200);
    changed();
  },
});

const sendTo = (session, body) => native.post({ type: 'to_client', session, body: JSON.stringify(body) });
const end = (id, code) => {
  shares.end(id);
  router.endSession(id, code);
};
const native = new NativeLink({
  hello: () => ({ profile: profile.id, label: profile.label }),
  open: () => browser.runtime.connectNative(HOST),
  onChange: changed,
  onLost: () => {
    for (const s of [...router.sessions.values()]) end(s.id);
  },
  onMessage(m) {
    if (m.type === 'session_open') router.openSession(m.session, 'mcp', 'without a name');
    else if (m.type === 'session_close') end(m.session);
    else if (m.type === 'from_client') fromClient(m.session, m.body);
    else console.error('refused host message', oneLine(m.type, 40));
  },
});

async function fromClient(session, body) {
  let m = null;
  try {
    m = JSON.parse(body);
  } catch {
    // refused below
  }
  if (!router.sessions.has(session)) return;
  if (m?.type === 'hello' && !m.backend && !m.remote) router.label(session, `${m.client?.name ?? 'without a name'} ${m.client?.version ?? ''}`);
  else if (m?.type === 'hello') {
    // Neither a backend nor a remote client has anything to do with mail.
    end(session);
    native.post({ type: 'close_session', session });
  } else if (m?.type === 'call' && Number.isSafeInteger(m.id)) sendTo(session, { type: 'result', id: m.id, ...(await router.call(session, m.id, String(m.tool), m.args)) });
  else if (m?.type === 'cancel') router.cancel(session, m.id);
  else console.error('refused client message', oneLine(m?.type, 40));
}

const fromPage = {
  connect: () => (browser.storage.local.set({ connect: true }), native.start()),
  disconnect: () => (browser.storage.local.set({ connect: false }), native.stop()),
  pause: ({ on }) => router.setPaused(on === true),
  halt: () => router.halt(),
  resume: () => router.resume(),
  share(m) {
    if (!router.sessions.has(m.session)) throw new ToolError('session_ended', 'That client is gone.');
    shares.set(m.session, String(m.account), m.on === true);
    if (m.on !== true) router.stopCalls(m.session, 'no_grant');
    changed();
  },
  end_session(m) {
    sendTo(m.session, { type: 'bye', message: 'The user disconnected this session.' });
    end(m.session, 'stopped');
    setTimeout(() => native.post({ type: 'close_session', session: m.session }));
  },
  card_shown: (m) => approvals.shown(m.card),
  answer: (m) => approvals.answer(m.card, m.allow),
};

const ports = new Set();
browser.runtime.onConnect.addListener((port) => {
  if (port.name !== 'companion' || port.sender.id !== browser.runtime.id || port.sender.url !== PAGE || port.sender.frameId) return port.disconnect();
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener(async (m) => {
    let error = null;
    try {
      if (!Object.hasOwn(fromPage, m.type)) throw new ToolError('invalid_argument', 'Unknown message.');
      await fromPage[m.type](m);
    } catch (e) {
      error = e.message;
    }
    if (ports.has(port)) port.postMessage({ type: 'answer', error });
  });
  show(port);
});

async function show(port) {
  const accounts = await browser.accounts.list(false);
  port.postMessage({
    type: 'state',
    state: { link: { ...native.status }, paused: router.paused, halted: Boolean(router.halted), sessions: [...router.sessions.values()].map(({ id, label }) => ({ id, label })), accounts: accounts.map((a) => ({ id: a.id, name: a.name })), shares: shares.view(), approvals: approvals.cards, log: log.slice(-30) },
  });
}

let queued = false;
function changed() {
  if (queued) return;
  queued = true;
  setTimeout(() => {
    queued = false;
    for (const p of ports) show(p);
    browser.browserAction.setBadgeText({ text: approvals.cards.length ? '?' : router.halted || router.paused ? 'II' : native.connected ? '' : '!' });
  });
}

browser.browserAction.onClicked.addListener(async () => {
  const [open] = await browser.tabs.query({ url: PAGE });
  if (open) browser.tabs.update(open.id, { active: true });
  else browser.tabs.create({ url: PAGE });
});

browser.storage.local.get({ connect: false, profile: null }).then((s) => {
  Object.assign(profile, s.profile ?? { id: crypto.randomUUID() });
  if (!s.profile) browser.storage.local.set({ profile });
  if (s.connect) native.start();
});
