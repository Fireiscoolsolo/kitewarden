// Shows the state of the background page and sends the user's gestures to it. It holds no rules of its own.
import { GROUPS, VIRTUAL, hostPattern, oneLine, originOf } from '../shared/protocol.mjs';
import { drawAdvanced, startAdvanced } from './advanced.mjs';
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
  refused: ['The helper refused to start', 'Start KitewardenSetup and choose Diagnose.'],
  version_mismatch: ['Versions differ', 'Update the older part, then press Retry now.'],
};

function drawLink() {
  const { link, paused } = ui.state;
  let [title, next] = LINK[link.state];
  if (link.code === 'helper_missing') [title, next] = ['Helper not installed', 'Run the installer, KitewardenSetup. This page connects by itself after that.'];
  if (paused) [title, next] = [`Paused (${title.toLowerCase()})`, 'Every call is refused until you press Resume.'];
  if (ui.state.unreadable) [title, next] = ['Settings cannot be read', 'Every call is refused. Restart Firefox. If it stays, reset the site rules below; nothing else is deleted.'];
  $('reset-rules').hidden = !ui.state.unreadable;
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

const WANTS = {
  left_click: 'click', right_click: 'click with the right button', middle_click: 'click with the middle button', double_click: 'double-click', triple_click: 'click three times', left_click_drag: 'drag',
  type: 'type', key: 'press keys', form_input: 'fill in a field', form_fill: 'fill in fields', file_upload: 'upload files', navigate: 'open an address', gif_creator: 'record pictures', request_user: 'hand this tab to you',
  site_rule: 'read this site', copy_to_clipboard: 'put something on your clipboard', chat_permission: 'use a tool on this computer',
  tabs_create: 'open a tab', tabs_close: 'close your tab', closed_tabs: 'reopen a tab', windows_create: 'open a window', resize_window: 'change a window', search_bookmarks: 'search your bookmarks',
  add_bookmark: 'add a bookmark', search_history: 'search your history', download_start: 'download a file', read_network_requests: 'keep what this tab sends and receives', page_storage: 'use the storage of this site',
  get_cookies: 'see the cookies of this site', set_cookie: 'set a cookie', remove_cookie: 'remove a cookie', webmcp_call: 'use a tool of this page', windows_input: 'send real Windows input', isolated_browser: 'use the isolated Firefox', isolated_debug: 'debug in the isolated Firefox',
};
const LABEL = { clipboard: 'putting something on your clipboard', console: 'console messages and errors of attached tabs', network: 'requests of attached tabs', bodies: 'bodies of requests', cookies: 'cookies of attached sites, without HttpOnly values and tokens', storage: 'the storage of attached sites', webmcp: 'tools that attached pages offer (WebMCP)' };
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
    for (const [k, v] of [['Target', a.target], [a.tool === 'navigate' ? 'Note' : 'Value', a.value], ['Link',a.link && a.link + (a.download ? ' (download)' : '')], ['Tab', a.tabTitle], ['Site', a.origin], ['Frame of', a.frame], ['Its reason', a.reason]]) {
      if (v) facts.append(el('dt', { textContent: k }), el('dd', { textContent: v }));
    }
    const answer = (allow) => () => send('answer', { card: a.id, allow });
    const card = el('section', { className: 'card' }, title, facts, el('p', { className: 'row' }, onPress(el('button', { textContent: a.tool === 'request_user' ? 'Done' : 'Allow once', className: 'allow' }), answer(true)), onPress(el('button', { textContent: a.tool === 'request_user' ? 'Cancel' : 'Deny', className: 'deny' }), answer(false))));
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
  $('private-row').hidden = !tab?.incognito;
  options('session', ui.state.sessions.map((s) => [s.id, s.label]));
}

function attach() {
  const choice = { session: $('session').value, level: $('level').value, private: $('private-ok').checked && current()?.incognito === true };
  $('private-ok').checked = false; // each private grant is its own choice
  withSite((tab) => give('grant', { ...tab, ...choice }));
}

/** A grant, and the choice to move the tab when another session has it. */
async function give(type, data) {
  const r = await run(type, data, 'Attached.');
  $('move').hidden = r.error?.code !== 'conflict';
  moving = r.error?.code === 'conflict' ? () => run(type, { ...data, move: true }, 'Moved here.') : null;
  return r;
}
let moving = null;

/** Frames of other sites in a tab, which the user may allow one site at a time. */
async function showFrames(grant) {
  const r = await send('frames', { grant });
  const list = r.result?.frames ?? [];
  const sites = [...new Set(list.filter((f) => !f.granted && /^https?:/.test(f.origin)).map((f) => f.origin))];
  $('frames').replaceChildren(
    el('p', { className: 'sub', textContent: r.error ? `${r.error.code}: ${r.error.message}` : sites.length ? 'Frames of other sites in this tab:' : 'There are no frames of other sites that could be allowed.' }),
    ...sites.map((origin) => el('p', { className: 'row' }, onPress(el('button', { textContent: `Allow frames of ${origin}`, className: 'allow-frame' }), () => siteFor(ui.state.grants.find((g) => g.id === grant)?.tabId, origin).then((ok) => ok && run('approve_frames', { grant, origin }, 'Frames allowed.').then(() => $('frames').replaceChildren()))))),
  );
}

/** Firefox's own question, which a tab of the isolated Firefox does not need. */
const siteFor = (tabId, origin) => (tabId >= VIRTUAL ? Promise.resolve(true) : browser.permissions.request({ origins: [hostPattern(origin)] }));

function approveOrigin(grant, origin, tabId) {
  siteFor(tabId, origin).then((ok) => (ok ? run('approve_origin', { grant, origin }, 'Approved.') : ($('message').textContent = 'Firefox did not allow this site.')));
}

async function goTo(tabId) {
  const tab = await browser.tabs.update(tabId, { active: true });
  await browser.windows.update(tab.windowId, { focused: true });
}

function drawRules() {
  const say = { block: 'never', ask: 'asks before each read', allow: 'only these' };
  part('rules', ui.state.rules, (r) => {
    const list = Object.entries(r).flatMap(([kind, hosts]) => hosts.map((host) => el('li', {}, `${host} (${say[kind]}) `, onPress(el('button', { textContent: 'Remove', className: 'rule-remove' }), () => run('rule_remove', { kind, host }, 'Removed.')))));
    return list.length ? list : [el('li', { className: 'sub', textContent: 'None' })];
  });
}

function drawGrants() {
  const data = ui.state.grants.map((g) => {
    const tab = ui.tabs.find((t) => t.id === g.tabId);
    return { ...g, title: oneLine(tab?.title, 60), now: tab ? originOf(tab.url) : null, label: sessionLabel(g.sessionId), stopped: ui.state.stoppedTabs.includes(g.tabId) };
  });
  part('grants', data, (list) =>
    list.length
      ? list.map((g) => {
          const li = el('li', { className: `pass ${g.level} ${g.stopped ? 'stopped' : g.state}` }, el('strong', { textContent: g.title || `Tab ${g.tabId}` }), el('span', { className: 'sub', textContent: `${g.origins.join(', ')} · ${g.frames.length ? `frames of ${g.frames.join(', ')} · ` : ''}${g.private ? 'private · ' : ''}${g.stopped ? 'with you · ' : ''}${g.level === 'act' ? 'read and act' : 'read'} · ${g.label} · ${g.state === 'active' ? 'active' : g.reason === 'permission' ? 'suspended: Firefox took the permission away' : g.state === 'pending' ? 'loading' : 'suspended: other site'}` }));
          const row = el('p', { className: 'row' });
          if (g.state === 'suspended' && g.now) row.append(onPress(el('button', { textContent: `Approve ${g.now}`, className: 'approve' }), () => approveOrigin(g.id, g.now, g.tabId)));
          if (g.state === 'active') row.append(onPress(el('button', { textContent: 'Frames…', className: 'frames' }), () => showFrames(g.id)));
          if (g.tabId < VIRTUAL) row.append(onPress(el('button', { textContent: 'Go to', className: 'go-to' }), () => goTo(g.tabId)));
          row.append(onPress(el('button', { textContent: g.level === 'act' ? 'Only read' : 'Read and act', className: 'level' }), () => run('set_level', { grant: g.id, level: g.level === 'act' ? 'read' : 'act' }, 'Changed.')));
          row.append(g.stopped ? onPress(el('button', { textContent: 'Give back', className: 'give-back' }), () => run('resume_tab', { tabId: g.tabId }, 'Given back.')) : onPress(el('button', { textContent: 'Take over', className: 'take-over' }), () => run('stop_tab', { tabId: g.tabId }, 'You have this tab.').then(report)));
          row.append(onPress(el('button', { textContent: 'Revoke', className: 'revoke' }), () => run('revoke', { grant: g.id }, 'Revoked.')));
          li.append(row);
          return li;
        })
      : [el('li', { className: 'sub', textContent: 'None' })],
  );
  $('revoke-all').hidden = !data.length;
}

function drawSessions() {
  part('sessions', ui.state.sessions.filter((s) => s.kind === 'mcp' || s.kind === 'remote'), (list) =>
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

/** What a stop ended, and what may have taken effect. */
function report(r) {
  const list = r?.calls ?? [];
  $('halt-report').replaceChildren(...(list.length ? [el('ul', {}, ...list.map((c) => el('li', { textContent: `${c.session}: ${c.tool}, ${c.state}. ${c.may_have_taken_effect ? `May already have taken effect: ${c.may_have_taken_effect}. Check the page.` : 'Not carried out.'}` })))] : [el('p', { className: 'sub', textContent: 'Nothing was under way.' })]));
}

function drawControl() {
  const s = ui.state;
  $('halt').hidden = Boolean(s.halted);
  $('resume-work').hidden = !s.halted;
  if (s.halted) {
    $('link-title').textContent = 'Stopped by you';
    $('link-detail').textContent = 'Every call is refused until you press Resume work.';
  }
  part('requests', s.requests, (list) => list.map((q) => el('section', { className: 'card' }, el('h2', { textContent: `${q.session} asks for a tab` }), el('p', { textContent: q.reason }), el('p', { className: 'row' },
    ...['read', 'act'].filter((l) => l === 'read' || q.level === 'act').map((level) => onPress(el('button', { textContent: level === 'act' ? 'Give this tab, read and act' : 'Give this tab, read', className: `give-${level}` }), () => withSite((tab) => give('request_answer', { request: q.id, ...tab, level, private: $('private-ok').checked && current()?.incognito === true })))),
    onPress(el('button', { textContent: 'Refuse', className: 'refuse' }), () => run('request_answer', { request: q.id, deny: true }, 'Refused.'))))));
  part('lost', { lost: s.lost, sessions: s.sessions.map((x) => [x.id, x.label, x.kind]) }, ({ lost, sessions }) => lost.flatMap((l) => sessions.filter(([, label, kind]) => kind === l.kind && label.includes(l.name)).map(([id, label]) => el('p', { className: 'row' }, onPress(el('button', { textContent: `Attach the same ${l.tabs} tabs again to ${label}`, className: 'regrant' }), () => run('regrant', { lost: l.id, session: id }).then((r) => !r.error && ($('message').textContent = `Attached ${r.given.length}, left out ${r.left_out}.`)))))));
  part('now', s.activity, (list) => list.map((c) => el('li', { textContent: `${c.session}: ${c.tool}${c.tabId === null ? '' : ` in tab ${c.tabId}`}, ${c.state}` })));
  part('folders', s.folders, (list) => (list.length ? list.map((f) => el('li', {}, f, ' ', onPress(el('button', { textContent: 'Remove' }), () => run('remove_folder', { path: f }, 'Removed.')))) : [el('li', { className: 'sub', textContent: 'None: every upload is refused.' })]));
  part('switches', s.switches, (on) => Object.keys(GROUPS).filter((n) => !s.backends.some((b) => b.id === n)).map((name) => {
    const box = el('input', { type: 'checkbox', checked: on[name] === true, id: `switch-${name}` });
    onPress(box, () => (box.checked ? (GROUPS[name].length ? browser.permissions.request({ permissions: GROUPS[name] }) : Promise.resolve(true)).then((ok) => run('set_switch', { name, on: ok }, ok ? 'On.' : 'Firefox did not allow it.')) : run('set_switch', { name, on: false }, 'Off.')));
    return el('label', { className: 'check' }, box, `Clients may ask for ${LABEL[name] ?? name}`);
  }));
  if (document.activeElement !== $('profile-label')) $('profile-label').value = s.profile.label ?? '';
}

function drawLog() {
  part('log', ui.state.log, (list) => [...list].reverse().map((l) => el('li', { textContent: `${new Date(l.at).toLocaleTimeString()}  ${sessionLabel(l.session)}  ${l.tool}  ${l.origin ?? '-'}  ${l.decision}` })));
}

async function draw() {
  if (!ui.state) return;
  ui.tabs = [...(await browser.tabs.query({})), ...ui.state.backendTabs];
  ui.windowId ??= (await browser.windows.getCurrent()).id;
  drawLink();
  drawCards();
  drawAttach();
  drawGrants();
  drawRules();
  drawSessions();
  drawTry();
  drawControl();
  drawLog();
  drawChat();
  drawWorkflows();
  drawAdvanced();
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
onPress($('halt'), () => run('halt', {}, 'Stopped.').then(report));
onPress($('resume-work'), () => run('resume', {}, 'Work may go on.').then(() => $('halt-report').replaceChildren()));
onPress($('move'), () => {
  $('move').hidden = true;
  moving?.();
});
onPress($('folder-add'), () => run('add_folder', { path: $('folder-path').value }, 'Added.').then((r) => !r.error && ($('folder-path').value = '')));
onPress($('reset-rules'), () => run('reset_rules'));
onPress($('rule-add'), () => run('rule_add', { kind: $('rule-kind').value, host: $('rule-host').value }, 'Added.').then((r) => !r.error && ($('rule-host').value = '')));
onPress($('profile-save'), () => run('set_label', { label: $('profile-label').value }, 'Saved.'));
onPress($('groups-ok'), () => browser.permissions.request({ permissions: ['tabGroups'] }));
onPress($('attach'), attach);
onPress($('revoke-all'), () => run('revoke_all', {}, 'Revoked.'));
onPress($('screens'), () => browser.permissions.request({ origins: ['<all_urls>'] }).then((ok) => ($('message').textContent = ok ? 'Screenshots of attached tabs are allowed.' : 'Not allowed.')));
onPress($('try-read'), tryRead);
onPress($('try-shot'), tryShot);
onPress($('try-click'), tryClick);
startChat();
startWorkflows();
startAdvanced();
for (const e of ['onActivated', 'onUpdated', 'onRemoved', 'onAttached']) browser.tabs[e].addListener(draw);
setInterval(() => ui.state?.link.retryAt && drawLink(), 1000);
