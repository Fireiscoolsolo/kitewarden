// Shows the state of the background page and sends the user's gestures to it. It holds no rules of its own.
import { hostPattern, oneLine, originOf } from '../shared/protocol.mjs';
import { drawChat, startChat } from './chat.mjs';
import { $, answered, current, el, onPress, options, part, port, run, send, ui, withSite } from './ui.mjs';
import { drawWorkflows, startWorkflows } from './workflows.mjs';

let shot = null; // object URL of the last picture

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
  const { link, paused } = ui.state;
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

const WANTS = { left_click: 'click', form_input: 'fill in a field', navigate: 'open an address', gif_creator: 'record pictures' };
const cards = new Map();

function drawCards() {
  for (const [id, node] of cards) {
    if (ui.state.approvals.some((a) => a.id === id)) continue;
    node.remove();
    cards.delete(id);
  }
  for (const a of ui.state.approvals) {
    if (cards.has(a.id)) continue;
    const title = el('h2', { id: `t-${a.id}`, textContent: `${a.sessionLabel} wants to ${WANTS[a.tool]}` });
    const facts = el('dl');
    for (const [k, v] of [['Target', a.target], [a.tool === 'navigate' ? 'Note' : 'Value', a.value], ['Link',a.link && a.link + (a.download ? ' (download)' : '')], ['Tab', a.tabTitle], ['Site', a.origin], ['Its reason', a.reason]]) {
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

const sessionLabel = (id) => ui.state.sessions.find((s) => s.id === id)?.label ?? id;

function drawAttach() {
  const tab = current();
  const origin = tab && originOf(tab.url);
  part('tab', { title: oneLine(tab?.title), origin }, (d) => [el('strong', { textContent: d.title || 'No tab' }), el('br'), d.origin ?? 'This page cannot be attached.']);
  $('attach').disabled = !origin;
  options('session', ui.state.sessions.map((s) => [s.id, s.label]));
}

function attach() {
  const choice = { session: $('session').value, level: $('level').value };
  withSite((tab) => run('grant', { ...tab, ...choice }, 'Attached.'));
}

function approveOrigin(grant, origin) {
  browser.permissions.request({ origins: [hostPattern(origin)] }).then((ok) => (ok ? run('approve_origin', { grant, origin }, 'Approved.') : ($('message').textContent = 'Firefox did not allow this site.')));
}

function drawGrants() {
  const data = ui.state.grants.map((g) => {
    const tab = ui.tabs.find((t) => t.id === g.tabId);
    return { ...g, title: oneLine(tab?.title, 60), now: tab ? originOf(tab.url) : null, label: sessionLabel(g.sessionId) };
  });
  part('grants', data, (list) =>
    list.length
      ? list.map((g) => {
          const li = el('li', {}, el('strong', { textContent: g.title || `Tab ${g.tabId}` }), el('span', { className: 'sub', textContent: `${g.origins.join(', ')} · ${g.level === 'act' ? 'read and act' : 'read'} · ${g.label} · ${g.state === 'active' ? 'active' : g.reason === 'permission' ? 'suspended: Firefox took the permission away' : g.state === 'pending' ? 'loading' : 'suspended: other site'}` }));
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
  part('sessions', ui.state.sessions.filter((s) => s.kind === 'mcp'), (list) =>
    list.length
      ? list.map((s) => el('li', {}, `${s.label} `, el('span', { className: 'sub', textContent: s.id }), onPress(el('button', { textContent: 'Disconnect', className: 'end' }), () => run('end_session', { session: s.id }, 'Session disconnected.'))))
      : [el('li', { className: 'sub', textContent: 'No client is connected.' })],
  );
}

// Try it: the sidebar's own session, through the same calls as an MCP client

function drawTry() {
  const mine = ui.state.grants.filter((g) => g.sessionId === 'sidebar');
  options('try-tab', mine.map((g) => [g.tabId, oneLine(ui.tabs.find((t) => t.id === g.tabId)?.title, 50) || `Tab ${g.tabId}`]));
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
  part('log', ui.state.log, (list) => [...list].reverse().map((l) => el('li', { textContent: `${new Date(l.at).toLocaleTimeString()}  ${sessionLabel(l.session)}  ${l.tool}  ${l.origin ?? '-'}  ${l.decision}` })));
}

async function draw() {
  if (!ui.state) return;
  ui.tabs = await browser.tabs.query({});
  ui.windowId ??= (await browser.windows.getCurrent()).id;
  drawLink();
  drawCards();
  drawAttach();
  drawGrants();
  drawSessions();
  drawTry();
  drawLog();
  drawChat();
  drawWorkflows();
}

port.onMessage.addListener((m) => {
  if (m.type === 'reply') return answered(m);
  if (m.type === 'state') ui.state = m.state;
  if (m.type === 'chat') ui.chat = m.chat;
  draw();
});

for (const b of document.querySelectorAll('[data-show]')) {
  onPress(b, () => {
    for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== b.dataset.show;
    for (const o of document.querySelectorAll('[data-show]')) o.toggleAttribute('aria-current', o === b);
  });
}
port.onDisconnect.addListener(() => ($('link-title').textContent = 'The add-on restarted. Reopen this sidebar.'));

onPress($('connect'), () => run('connect'));
onPress($('disconnect'), () => run('disconnect'));
onPress($('retry'), () => run('retry'));
onPress($('pause'), () => run('pause', { on: !ui.state.paused }));
onPress($('attach'), attach);
onPress($('revoke-all'), () => run('revoke_all', {}, 'Revoked.'));
onPress($('screens'), () => browser.permissions.request({ origins: ['<all_urls>'] }).then((ok) => ($('message').textContent = ok ? 'Screenshots of attached tabs are allowed.' : 'Not allowed.')));
onPress($('try-read'), tryRead);
onPress($('try-shot'), tryShot);
onPress($('try-click'), tryClick);
startChat();
startWorkflows();
for (const e of ['onActivated', 'onUpdated', 'onRemoved', 'onAttached']) browser.tabs[e].addListener(draw);
setInterval(() => ui.state?.link.retryAt && drawLink(), 1000);
