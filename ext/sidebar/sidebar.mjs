// Shows the state of the background page and sends the user's gestures to it. It holds no rules of its own.
import { hostPattern, oneLine, originOf } from '../shared/protocol.mjs';

const $ = (id) => document.getElementById(id);
const port = browser.runtime.connect({ name: 'sidebar' });
const waiting = new Map();
let nextId = 1;
let state = null;
let tabs = [];
let windowId = null;
let shot = null; // object URL of the last picture

function send(type, data = {}) {
  return new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    port.postMessage({ ...data, type, id });
  });
}

/** Only real user gestures count. Page script cannot reach this document, and synthetic events are ignored. */
function onPress(button, fn) {
  button.addEventListener('click', (e) => e.isTrusted && fn(e));
  return button;
}

function el(tag, props = {}, ...children) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...children);
  return n;
}

async function run(type, data, done = '') {
  const r = await send(type, data);
  $('message').textContent = r.error ? `${r.error.code}: ${r.error.message}` : done;
  return r;
}

const drawn = new Map();
/** Redraws a part only when its data changed, so that focus stays where the user put it. */
function part(id, data, build) {
  const key = JSON.stringify(data);
  if (drawn.get(id) === key) return;
  drawn.set(id, key);
  $(id).replaceChildren(...build(data));
}

/** Fills a select and keeps the user's choice while it exists. */
function options(id, pairs) {
  const keep = $(id).value;
  part(id, pairs, (list) => list.map(([value, textContent]) => el('option', { value, textContent })));
  if (pairs.some(([value]) => String(value) === keep)) $(id).value = keep;
}

// Connection

const LINK = {
  off: ['Not connected', 'Press Connect to start the helper on this computer. Claude then sees only the tabs you attach.'],
  connecting: ['Connecting', 'Starting the helper.'],
  connected: ['Connected', 'The helper is running.'],
  waiting: ['Helper stopped', 'It is started again by itself.'],
  refused: ['The helper refused to start', 'Run the doctor: firefox-companion-host.exe doctor'],
  version_mismatch: ['Versions differ', 'Update the older part, then press Retry now.'],
};

function drawLink() {
  const { link, paused } = state;
  let [title, next] = LINK[link.state];
  if (link.code === 'helper_missing') [title, next] = ['Helper not installed', 'Run the installer: firefox-companion-host.exe install'];
  if (paused) [title, next] = [`Paused (${title.toLowerCase()})`, 'Every call is refused until you press Resume.'];
  document.body.dataset.link = paused ? 'paused' : link.state;
  $('link-title').textContent = title;
  const retry = link.retryAt ? ` Next try in ${Math.max(0, Math.ceil((link.retryAt - Date.now()) / 1000))} s.` : '';
  $('link-detail').textContent = [link.detail, next + retry, link.host && `Helper ${link.host}.`].filter(Boolean).join(' ');
  $('connect').hidden = link.state !== 'off';
  $('disconnect').hidden = link.state === 'off';
  $('retry').hidden = !link.retryAt;
  $('pause').textContent = paused ? 'Resume' : 'Pause';
  $('pause').setAttribute('aria-pressed', String(paused));
}

// Approval cards

const cards = new Map();

function drawCards() {
  for (const [id, node] of cards) {
    if (state.approvals.some((a) => a.id === id)) continue;
    node.remove();
    cards.delete(id);
  }
  for (const a of state.approvals) {
    if (cards.has(a.id)) continue;
    const title = el('h2', { id: `t-${a.id}`, textContent: `${a.sessionLabel} wants to click` });
    const facts = el('dl');
    for (const [k, v] of [['Target', a.target], ['Link', a.link && a.link + (a.download ? ' (download)' : '')], ['Tab', a.tabTitle], ['Site', a.origin], ['Its reason', a.reason]]) {
      if (v) facts.append(el('dt', { textContent: k }), el('dd', { textContent: v }));
    }
    const answer = (allow) => () => send('answer', { card: a.id, allow });
    const card = el('section', { className: 'card' }, title, facts, el('p', { className: 'row' }, onPress(el('button', { textContent: 'Allow once', className: 'allow' }), answer(true)), onPress(el('button', { textContent: 'Deny', className: 'deny' }), answer(false))));
    card.setAttribute('role', 'group');
    card.setAttribute('aria-labelledby', title.id);
    cards.set(a.id, card);
    $('cards').append(card);
    send('card_shown', { card: a.id });
  }
}

// Attach

const current = () => tabs.find((t) => t.active && t.windowId === windowId) ?? null;
const sessionLabel = (id) => state.sessions.find((s) => s.id === id)?.label ?? id;

function drawAttach() {
  const tab = current();
  const origin = tab && originOf(tab.url);
  part('tab', { title: oneLine(tab?.title), origin }, (d) => [el('strong', { textContent: d.title || 'No tab' }), el('br'), d.origin ?? 'This page cannot be attached.']);
  $('attach').disabled = !origin;
  options('session', state.sessions.map((s) => [s.id, s.label]));
}

function attach() {
  const tab = current();
  const origin = tab && originOf(tab.url);
  if (!origin) return;
  const grant = { tabId: tab.id, origin, session: $('session').value, level: $('level').value };
  // Firefox asks for the site from this same click.
  browser.permissions.request({ origins: [hostPattern(origin)] }).then(
    (ok) => (ok ? run('grant', grant, 'Attached.') : ($('message').textContent = 'Firefox did not allow this site. Nothing was attached.')),
    (e) => ($('message').textContent = e.message),
  );
}

function approveOrigin(grant, origin) {
  browser.permissions.request({ origins: [hostPattern(origin)] }).then((ok) => (ok ? run('approve_origin', { grant, origin }, 'Approved.') : ($('message').textContent = 'Firefox did not allow this site.')));
}

function drawGrants() {
  const data = state.grants.map((g) => {
    const tab = tabs.find((t) => t.id === g.tabId);
    return { ...g, title: oneLine(tab?.title, 60), now: tab ? originOf(tab.url) : null, label: sessionLabel(g.sessionId) };
  });
  part('grants', data, (list) =>
    list.length
      ? list.map((g) => {
          const li = el('li', {}, el('strong', { textContent: g.title || `Tab ${g.tabId}` }), el('span', { className: 'sub', textContent: `${g.origins.join(', ')} · ${g.level === 'act' ? 'read and click' : 'read'} · ${g.label} · ${g.state === 'active' ? 'active' : g.reason === 'permission' ? 'suspended: Firefox took the permission away' : g.state === 'pending' ? 'loading' : 'suspended: other site'}` }));
          const row = el('p', { className: 'row' });
          if (g.state === 'suspended' && g.now) row.append(onPress(el('button', { textContent: `Approve ${g.now}`, className: 'approve' }), () => approveOrigin(g.id, g.now)));
          row.append(onPress(el('button', { textContent: 'Revoke', className: 'revoke' }), () => run('revoke', { grant: g.id }, 'Revoked.')));
          li.append(row);
          return li;
        })
      : [el('li', { className: 'sub', textContent: 'None' })],
  );
  $('revoke-all').hidden = !data.length;
}

function drawSessions() {
  part('sessions', state.sessions.filter((s) => s.kind === 'mcp'), (list) =>
    list.length
      ? list.map((s) => el('li', {}, `${s.label} `, el('span', { className: 'sub', textContent: s.id }), onPress(el('button', { textContent: 'Disconnect', className: 'end' }), () => run('end_session', { session: s.id }, 'Session disconnected.'))))
      : [el('li', { className: 'sub', textContent: 'No client is connected.' })],
  );
}

// Try it: the sidebar's own session, through the same calls as an MCP client

function drawTry() {
  const mine = state.grants.filter((g) => g.sessionId === 'sidebar');
  options('try-tab', mine.map((g) => [g.tabId, oneLine(tabs.find((t) => t.id === g.tabId)?.title, 50) || `Tab ${g.tabId}`]));
  $('try').hidden = !mine.length;
}

async function tryCall(tool, args) {
  $('try-state').textContent = 'Working…';
  const r = await send('call', { tool, args: { tabId: Number($('try-tab').value), ...args } });
  $('try-state').textContent = r.error ? `${r.error.code}: ${r.error.message}` : 'Done';
  return r.result;
}

async function tryRead() {
  const r = await tryCall('read_page', {});
  if (!r) return;
  $('try-output').textContent = r.outline;
  const targets = [...r.outline.matchAll(/^\s*- (.+?) \[(ref_\w+)\]$/gm)].map(([, name, ref]) => [ref, name.slice(0, 60)]);
  $('try-ref').replaceChildren(...targets.map(([ref, name]) => el('option', { value: ref, textContent: name })));
  $('try-click').disabled = !targets.length;
}

async function tryShot() {
  const r = await tryCall('computer', { action: 'screenshot' });
  if (!r) return;
  if (shot) URL.revokeObjectURL(shot);
  shot = URL.createObjectURL(new Blob([Uint8Array.from(atob(r.image), (c) => c.charCodeAt(0))], { type: r.mimeType }));
  $('try-image').src = shot;
  $('try-image').hidden = false;
}

async function tryClick() {
  const r = await tryCall('computer', { action: 'left_click', ref: $('try-ref').value, reason: 'You pressed Click in the sidebar.' });
  if (r) $('try-state').textContent = `Clicked ${r.clicked}. Page: ${r.page}.`;
}

function drawLog() {
  part('log', state.log, (list) => [...list].reverse().map((l) => el('li', { textContent: `${new Date(l.at).toLocaleTimeString()}  ${sessionLabel(l.session)}  ${l.tool}  ${l.origin ?? '-'}  ${l.decision}` })));
}

async function draw() {
  if (!state) return;
  tabs = await browser.tabs.query({});
  windowId ??= (await browser.windows.getCurrent()).id;
  drawLink();
  drawCards();
  drawAttach();
  drawGrants();
  drawSessions();
  drawTry();
  drawLog();
}

port.onMessage.addListener((m) => {
  if (m.type === 'state') {
    state = m.state;
    draw();
  } else if (m.type === 'reply') {
    waiting.get(m.id)?.(m.reply);
    waiting.delete(m.id);
  }
});
port.onDisconnect.addListener(() => ($('link-title').textContent = 'The add-on restarted. Reopen this sidebar.'));

onPress($('connect'), () => run('connect'));
onPress($('disconnect'), () => run('disconnect'));
onPress($('retry'), () => run('retry'));
onPress($('pause'), () => run('pause', { on: !state.paused }));
onPress($('attach'), attach);
onPress($('revoke-all'), () => run('revoke_all', {}, 'Revoked.'));
onPress($('screens'), () => browser.permissions.request({ origins: ['<all_urls>'] }).then((ok) => ($('message').textContent = ok ? 'Screenshots of attached tabs are allowed.' : 'Not allowed.')));
onPress($('try-read'), tryRead);
onPress($('try-shot'), tryShot);
onPress($('try-click'), tryClick);
for (const e of ['onActivated', 'onUpdated', 'onRemoved', 'onAttached']) browser.tabs[e].addListener(draw);
setInterval(() => state?.link.retryAt && drawLink(), 1000);
