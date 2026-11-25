// The chat part of the sidebar. Replies and tool results are shown as text or through markdown.mjs, never as HTML.
import { blanks, called, filled } from '../chat/prompts.mjs';
import { oneLine, originOf } from '../shared/protocol.mjs';
import { parse, render } from './markdown.mjs';
import { $, button, current, el, onPress, options, part, run, say, send, ui, withSite } from './ui.mjs';

const FILE_MAX = 20 * 1024 * 1024;
const STATES = { running: 'running', ok: 'done', error: 'refused or failed', unknown: 'outcome unknown' };
const size = (n) => (n < 2000 ? `${n}` : n < 2e6 ? `${Math.round(n / 1000)} k` : `${(n / 1e6).toFixed(1)} M`);

const rows = new Map(); // item key -> { json, node }
let shown = null; // chat ID of the drawn items
let info = null; // what Claude Code reports about itself
let found = null; // chat IDs of a search

const choices = () => ({ model: $('model').value, extras: $('extras').checked, tools: $('tools').checked });

let making = Promise.resolve(); // a new chat that is under way; what the user does meanwhile belongs to it

/** The open chat, or a new one. */
async function ensure() {
  await making;
  if (ui.chat) return ui.chat.id;
  const r = await run('chat_new', choices());
  if (r.error) return null;
  while (!ui.chat) await new Promise((f) => setTimeout(f, 20));
  return ui.chat.id;
}

// Items

function askLink(href) {
  $('link-ask').replaceChildren(el('p', { className: 'sub', textContent: `Open ${href}` }), el('p', { className: 'row' }, button('Open in a new tab', () => {
    browser.tabs.create({ url: href });
    $('link-ask').replaceChildren();
  }), button('Cancel', () => $('link-ask').replaceChildren())));
}

function draw(i) {
  if (i.type === 'user') {
    const files = i.files.length ? [el('p', { className: 'sub', textContent: i.files.map((f) => f.name).join(', ') })] : [];
    return el('div', { className: 'msg user' }, el('p', { textContent: i.text }), ...files);
  }
  if (i.type === 'assistant') return el('div', { className: 'msg assistant' }, ...render(parse(i.text), askLink));
  if (i.type === 'note') return el('p', { className: `note ${i.level}`, textContent: i.text });
  const d = el('details', { className: `tool ${i.state}` }, el('summary', { textContent: `${i.name} · ${STATES[i.state] ?? i.state}${i.sub ? ' · agent' : ''}` }), el('pre', { textContent: i.text }));
  if (i.result) d.append(el('pre', { textContent: i.result }));
  return d;
}

function drawItems(chat) {
  const box = $('chat-items');
  const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  if (shown !== (chat?.id ?? null)) {
    shown = chat?.id ?? null;
    rows.clear();
    box.replaceChildren();
  }
  const keep = new Set();
  let last = null;
  (chat?.items ?? []).forEach((i, n, all) => {
    // Items have no ID. Their time and place among items of that time do not change.
    const key = `${i.at}:${all.slice(0, n).filter((x) => x.at === i.at).length}`;
    keep.add(key);
    const json = JSON.stringify(i);
    const old = rows.get(key);
    if (old?.json !== json) {
      const node = draw(i);
      if (old) {
        if (old.node.open) node.open = true;
        old.node.replaceWith(node);
      } else if (last) last.after(node);
      else box.prepend(node);
      rows.set(key, { json, node });
    }
    last = rows.get(key).node;
  });
  for (const [key, { node }] of rows) {
    if (keep.has(key)) continue;
    node.remove();
    rows.delete(key);
  }
  if (atEnd) box.scrollTop = box.scrollHeight;
}

// Drafts

function drawDraft(chat) {
  part('draft', { chat: chat?.id, draft: chat?.draft ?? [] }, ({ draft }) =>
    draft.length
      ? [el('p', { className: 'sub', textContent: 'Sent with your message:' }), ...draft.map((d) => {
          const body = el('div');
          const box = el('details', { className: 'chip' }, el('summary', { textContent: `${d.name} (${size(d.size)})` }), body);
          box.addEventListener('toggle', async () => {
            if (!box.open || body.hasChildNodes()) return;
            const r = await send('chat_preview', { chat: chat.id, draft: d.id });
            const p = r.preview;
            if (p?.type === 'image') body.append(el('img', { src: p.url, alt: r.name }));
            else body.append(el('pre', { tabIndex: 0, textContent: p?.text ?? r.error.message }));
          });
          return el('div', { className: 'row' }, box, button('Remove', () => run('chat_detach', { chat: chat.id, draft: d.id }), 'detach'));
        })]
      : [],
  );
}

function attachTab(kind) {
  withSite(async (tab) => {
    const chat = await ensure();
    if (!chat) return;
    const g = await run('chat_grant', { chat, ...tab, level: 'read' });
    if (!g.error) await run('chat_attach_tab', { chat, kind, tabId: tab.tabId }, 'Added to your message. Nothing was sent yet.');
  });
}

function allow(level) {
  withSite(async (tab) => {
    const chat = await ensure();
    if (!chat) return;
    const said = level === 'act' ? 'Claude may read this tab and ask for actions.' : 'Claude may read this tab.';
    const r = await run('chat_grant', { chat, ...tab, level }, said);
    if (r.error?.code !== 'conflict') return;
    $('move').hidden = false;
    $('move').onclick = (e) => {
      $('move').onclick = null;
      if (e.isTrusted) run('chat_grant', { chat, ...tab, level, move: true }, said);
    };
  });
}

async function addFiles(list) {
  const files = [...list];
  if (!files.length) return;
  const chat = await ensure();
  if (!chat) return;
  for (const f of files) {
    if (f.size > FILE_MAX) {
      say(`too_large: ${f.name} is larger than 20 MB.`);
      continue;
    }
    const url = await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => resolve('');
      r.readAsDataURL(f);
    });
    const r = await run('chat_attach_file', { chat, name: f.name, base64: url.slice(url.indexOf(',') + 1) }, 'Added to your message. Nothing was sent yet.');
    if (r.error) break;
  }
}

function submit() {
  const saved = called(ui.state.prompts, $('prompt').value);
  const names = saved ? blanks(saved.prompt.text) : [];
  if (names.length) return askBlanks(saved, names);
  return sendText(saved ? [saved.prompt.text, saved.rest].filter(Boolean).join('\n') : $('prompt').value);
}

async function sendText(text) {
  const chat = await ensure();
  if (!chat) return;
  const r = await run('chat_send', { chat, text });
  if (!r.error) $('prompt').value = '';
}

async function editWaiting(chat, index) {
  const r = await run('chat_edit', { chat, index });
  if (!r.error) $('prompt').value = [r.text, $('prompt').value].filter(Boolean).join('\n');
  $('prompt').focus();
}

const stop = () => ui.chat?.running && run('chat_stop', { chat: ui.chat.id });

// Account and lists

async function loadInfo(fresh) {
  if (ui.state.link.state !== 'connected') return;
  $('claude').textContent = 'Asking Claude Code…';
  const r = await send('claude_info', { fresh });
  info = r.error ? null : r;
  if (r.error) $('claude').textContent = `${r.error.code}: ${r.error.message}`;
  else if (!r.installed) $('claude').textContent = 'Claude Code was not found. Install it, or add claude.exe to PATH and restart Firefox. MCP clients work without it.';
  else if (r.problem) $('claude').textContent = `Claude Code did not answer: ${r.problem}`;
  else $('claude').textContent = `${r.version}, ${r.signedIn ? `signed in (${r.authMethod})` : 'not signed in. Run "claude auth login" in a terminal.'}`;
  drawLists();
}

function drawLists() {
  const l = ui.state.chats.lists;
  const names = (list) => el('p', { className: 'sub', textContent: list.join(', ') || 'None' });
  part('lists', { l, plugins: info?.plugins ?? null }, (d) => [
    el('h3', { textContent: 'Plugins' }),
    names((d.plugins ?? []).map((p) => `${p.id}${p.enabled ? '' : ' (off)'}`)),
    ...(d.l
      ? [el('h3', { textContent: `Skills (${d.l.skills.length})` }), names(d.l.skills), el('h3', { textContent: `Agents (${d.l.agents.length})` }), names(d.l.agents), el('p', { className: 'sub', textContent: `As Claude Code reported on ${new Date(d.l.at).toLocaleString()}.` })]
      : [el('p', { className: 'sub', textContent: 'Skills and agents are listed after the first message of a chat that may use them.' })]),
  ]);
  options('skill-pick', [['', 'Insert a skill'], ...(ui.chat?.extras && l ? l.skills.map((s) => [s, s]) : [])]);
  $('skill-pick').hidden = !(ui.chat?.extras && l?.skills.length);
}

// Drawing

export function drawChat() {
  if (!ui.state) return;
  const { chats, link, grants, paused, approvals } = ui.state;
  const chat = ui.chat;
  const list = chats.list.filter((c) => !found || found.includes(c.id) || c.id === chat?.id);
  part('chat-list', { list: list.map((c) => [c.id, c.title, c.running, c.waiting]), current: chat?.id ?? '' }, (d) => [
    ...(d.current ? [] : [el('option', { value: '', textContent: d.list.length ? 'Choose a chat' : 'No chats yet' })]),
    ...d.list.map(([value, title, running, waiting]) => el('option', { value, selected: value === d.current, textContent: `${running ? '● ' : ''}${title}${waiting ? ` (${waiting} waiting)` : ''}` })),
  ]);
  $('chat-delete').disabled = !chat;
  part('chat-undo', chats.deleted, (gone) => gone.map((d) => el('p', { className: 'row' }, el('span', { className: 'sub', textContent: `Deleted: ${d.title}` }), button('Undo', () => run('chat_undo', { chat: d.id }, 'Restored.'), 'undo'))));

  const tab = current();
  const origin = tab && originOf(tab.url);
  const g = chat && tab && grants.find((x) => x.sessionId === chat.session && x.tabId === tab.id);
  const state = !origin ? 'This page cannot be attached.' : !g ? 'Claude in this chat cannot see this tab.' : g.state !== 'active' ? 'Suspended: approve the site under Tabs.' : g.level === 'act' ? 'Claude in this chat may read this tab and ask for actions.' : 'Claude in this chat may read this tab.';
  part('chat-tab', { title: oneLine(tab?.title, 60), state }, (d) => [el('strong', { textContent: d.title || 'No tab' }), el('span', { className: 'sub', textContent: d.state })]);
  for (const id of ['allow-read', 'allow-act', 'attach-page', 'attach-selection', 'attach-shot']) $(id).disabled = !origin;

  drawItems(chat);
  drawDraft(chat);
  part('queue', { id: chat?.id, queue: chat?.queue ?? [], running: chat?.running }, (d) => [
    ...d.queue.map((q, index) => el('p', { className: 'row' }, el('span', { className: 'sub', textContent: `Waiting: ${oneLine(q.text, 60)}${q.files ? ` (${q.files} attachments)` : ''}` }), button('Edit', () => editWaiting(d.id, index), 'edit-waiting'), button('Remove', () => run('chat_unqueue', { chat: d.id, index })))),
    ...(d.queue.length && !d.running ? [button('Send waiting messages', () => run('chat_flush', { chat: d.id }))] : []),
  ]);
  const card = approvals.some((a) => a.session === chat?.session);
  $('run-state').textContent = chat?.running ? (card ? 'Claude waits for your approval, above.' : 'Claude is working…') : link.state !== 'connected' ? 'The helper is not running. Press Connect to chat; the history stays readable.' : paused ? 'Paused: Claude can answer, and every browser call is refused.' : '';
  $('stop').hidden = !chat?.running;
  const failed = chat?.items.at(-1)?.type === 'note' && chat.items.at(-1).level === 'error';
  $('try-again').hidden = !(failed && chat.canRetry);
  $('send').textContent = chat?.running ? 'Send next' : 'Send';
  if (chat) {
    if (document.activeElement !== $('model')) $('model').value = chat.model ?? '';
    $('extras').checked = chat.extras;
    $('tools').checked = chat.tools === true;
  }
  drawPrompts();
  drawLists();
  if (link.state === 'connected' && !info && !loadInfo.asked) {
    loadInfo.asked = true;
    loadInfo(false);
  }
  if (link.state !== 'connected') loadInfo.asked = false;
}

function configure() {
  const chosen = choices();
  making.then(() => ui.chat && run('chat_configure', { chat: ui.chat.id, ...chosen }));
}

function drawPrompts() {
  const list = ui.state.prompts;
  part('prompts', list, (all) =>
    all.length
      ? all.map((p) => el('li', {}, el('strong', { textContent: `/${p.name}` }), el('span', { className: 'sub', textContent: ` ${oneLine(p.text, 80)} ` }), button('Delete', () => run('prompt_remove', { name: p.name }, 'Deleted.'), 'prompt-delete')))
      : [el('li', { className: 'sub', textContent: 'None' })],
  );
  options('prompt-pick', [['', 'Insert a saved prompt'], ...list.map((p) => [p.name, `/${p.name}`])]);
  $('prompt-pick').hidden = $('prompt-export').hidden = !list.length;
}

/** Asks for the blanks of a saved prompt, and sends what comes out. */
function askBlanks({ prompt, rest }, names) {
  const fields = names.map((n) => [n, el('input', { maxLength: 2000 })]);
  $('prompt-blanks').replaceChildren(
    ...fields.map(([n, input]) => el('label', {}, `${n} `, input)),
    el('p', { className: 'row' }, button('Send filled in', () => {
      $('prompt-blanks').replaceChildren();
      sendText([filled(prompt.text, Object.fromEntries(fields.map(([n, i]) => [n, i.value]))), rest].filter(Boolean).join('\n'));
    }, 'send-filled'), button('Cancel', () => $('prompt-blanks').replaceChildren())),
  );
  fields[0][1].focus();
}

function exportPrompts() {
  const url = URL.createObjectURL(new Blob([JSON.stringify(ui.state.prompts, null, 1)], { type: 'application/json' }));
  $('prompt-file').replaceChildren(el('a', { href: url, download: 'saved-prompts.json', textContent: 'Save saved-prompts.json' }));
}

export function startChat() {
  onPress($('chat-new'), () => (making = run('chat_new', { ...choices(), tools: false }))); // on is a choice for one chat
  $('tools').addEventListener('change', configure);
  onPress($('prompt-save'), () => {
    const [name, text] = [$('prompt-name').value.trim().replace(/^\//, ''), $('prompt').value];
    run('prompt_save', { name, text, replace: $('prompt-save').dataset.replace === name }, 'Saved.').then((r) => {
      // The second press on the same name replaces it.
      if (r.error?.code === 'conflict') $('prompt-save').dataset.replace = name;
      else delete $('prompt-save').dataset.replace;
    });
  });
  onPress($('prompt-export'), exportPrompts);
  $('prompt-pick').addEventListener('change', (e) => {
    if (e.target.value) $('prompt').value = `/${e.target.value} ${$('prompt').value}`.trim();
    e.target.value = '';
    $('prompt').focus();
  });
  onPress($('chat-delete'), () => run('chat_delete', { chat: ui.chat.id }));
  onPress($('chat-clear'), () => ($('chat-clear-sure').hidden = false));
  onPress($('chat-clear-yes'), () => {
    $('chat-clear-sure').hidden = true;
    run('chat_clear', {}, 'All chats are gone from this add-on.');
  });
  onPress($('chat-clear-no'), () => ($('chat-clear-sure').hidden = true));
  $('chat-list').addEventListener('change', (e) => e.target.value && run('chat_select', { chat: e.target.value }));
  $('chat-search').addEventListener('input', async (e) => {
    found = e.target.value ? (await send('chat_search', { query: e.target.value })).ids : null;
    drawChat();
  });
  onPress($('allow-read'), () => allow('read'));
  onPress($('allow-act'), () => allow('act'));
  onPress($('attach-page'), () => attachTab('page'));
  onPress($('attach-selection'), () => attachTab('selection'));
  onPress($('attach-shot'), () => attachTab('screenshot'));
  onPress($('attach-file'), () => $('file').click());
  $('file').addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  });
  $('prompt').addEventListener('paste', (e) => e.isTrusted && addFiles(e.clipboardData.files));
  $('composer').addEventListener('dragover', (e) => e.preventDefault());
  $('composer').addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.isTrusted) addFiles(e.dataTransfer.files);
  });
  $('prompt').addEventListener('keydown', (e) => {
    if (!e.isTrusted || e.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  addEventListener('keydown', (e) => e.isTrusted && e.key === 'Escape' && stop());
  onPress($('send'), submit);
  onPress($('stop'), stop);
  onPress($('try-again'), () => run('chat_retry', { chat: ui.chat.id }));
  onPress($('claude-check'), () => loadInfo(true));
  $('model').addEventListener('change', configure);
  $('extras').addEventListener('change', configure);
  $('skill-pick').addEventListener('change', (e) => {
    if (e.target.value) $('prompt').value = `/${e.target.value} ${$('prompt').value}`;
    e.target.value = '';
    $('prompt').focus();
  });
}
