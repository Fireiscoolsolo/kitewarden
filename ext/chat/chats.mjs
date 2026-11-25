// Chats with the user's own Claude Code: history on this computer, one run per message, drafts with attachments.
// A chat is a session of the router like any client: its own grants, its own approvals, the same command path.
import { LIMITS, ToolError, oneLine, wrapFileText, wrapPageText } from '../shared/protocol.mjs';

const UNDO_MS = 5000;
const SAVE_MS = 500;
const TOOL = /^mcp__firefox-companion__/;
const CHAT_TOOLS = ['Bash', 'PowerShell', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch']; // the same list is in Chat.cs
const HIDDEN = /[\p{Cf}\p{Zl}\p{Zp}]|(?![\n\t])\p{Cc}/gu; // what a card could not show as it is
const LOGIN =/not logged in|\/login|authentication|oauth|invalid api key|401/i;

const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const textOf = (content) => (typeof content === 'string' ? content : (content ?? []).map((b) => (b.type === 'text' ? b.text : `[${b.type === 'image' ? 'picture' : oneLine(b.type, 20)}]`)).join('\n'));

export class Chats {
  #items = new Map(); // chat ID -> items
  #runs = new Map(); // run ID -> run
  #links = new Map(); // pipe session of a run's MCP server -> run
  #sessions = new Map(); // chat ID -> router session
  #queues = new Map();
  #drafts = new Map();
  #last = new Map(); // chat ID -> last message, for Try again
  #trash = new Map();
  #dirty = new Set();
  #timer = null;
  #next = 1;

  /** `store` is browser.storage.local, `post` sends to the helper, `connected` tells whether it runs. */
  constructor({ store, post, connected, router, onChange = () => {}, now = Date.now, uuid = () => crypto.randomUUID(), setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t) }) {
    Object.assign(this, { store, post, connected, router, onChange, now, uuid, setTimer, clearTimer });
    this.list = [];
    this.current = null;
    this.lists = null; // skills, agents and plugins, as the last run with them reported
  }

  // shortcut: all chats are kept in memory (200 of 400 items); read them one by one when that is too much.
  async load() {
    const all = await this.store.get(null);
    this.list = all.chats ?? [];
    this.lists = all.claudeLists ?? null;
    const known = new Set(this.list.map((c) => `chat:${c.id}`));
    const orphans = Object.keys(all).filter((k) => k.startsWith('chat:') && !known.has(k));
    if (orphans.length) await this.store.remove(orphans);
    for (const c of this.list) {
      this.#items.set(c.id, all[`chat:${c.id}`] ?? []);
      if (!c.running) continue;
      c.running = false;
      this.#end(c.id);
      this.#note(c.id, 'warn', 'Firefox or the add-on ended during this reply. An action that was under way may have taken effect. Your next message goes on with this conversation.');
    }
    this.onChange();
  }

  // Chats

  create({ model = null, extras = false, tools = false } = {}) {
    if (this.list.length >= LIMITS.chats) throw new ToolError('limit_reached', `There are ${LIMITS.chats} chats. Delete one first.`);
    const c = { id: this.uuid(), title: 'New chat', created: this.now(), updated: this.now(), claude: this.uuid(), started: false, model, extras, tools, running: false };
    this.list.unshift(c);
    this.#items.set(c.id, []);
    this.select(c.id);
    this.#save(c.id);
    return c;
  }

  select(id) {
    this.#chat(id);
    this.current = id;
    if (this.connected()) this.session(id);
    this.onChange();
  }

  configure(id, { model, extras, tools }) {
    const c = this.#chat(id);
    if (model !== null && !(typeof model === 'string' && /^[a-z0-9][a-z0-9.\-[\]]{0,59}$/.test(model))) throw new ToolError('invalid_argument', 'That is not a model name.');
    Object.assign(c, { model, extras: extras === true, tools: tools === true });
    this.#save(id);
  }

  /** Claude Code asks before a file, shell or web tool of a run. The user sees the whole input; nothing runs here. */
  async permission(r, call, spec, origin, a) {
    const run = [...this.#runs.values()].find((x) => x.sid === call.session.id && x.tools);
    const on = () => {
      if (!run || run.stopped || !this.#runs.has(run.id) || this.#find(run.chat)?.tools !== true) throw new ToolError('tool_off', 'The user has not turned file and shell tools on in this chat.');
    };
    on();
    if (!CHAT_TOOLS.includes(a.tool_name)) throw new ToolError('not_allowed', `${oneLine(a.tool_name, 60)} is not offered in this chat.`);
    const text = Object.entries(a.input).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n').replace(HIDDEN, (c) => `\\u{${c.codePointAt(0).toString(16)}}`);
    if (text.length > LIMITS.chatToolInput) throw new ToolError('too_large', 'The input is too long to be shown whole on the card, so it is not allowed.');
    const lines = text.split('\n').length;
    const size = lines > 8 || text.length > 600 ? ` (${lines} lines, ${text.length} characters: scroll to see all)` : '';
    await r.ask(call, spec, null, { tool: 'chat_permission', target: a.tool_name + size, value: text }, '');
    on();
    r.sent(call, `${a.tool_name} ${oneLine(a.input.command ?? a.input.file_path ?? a.input.url ?? a.input.pattern ?? '', 80)}`.trim());
    call.sent.use = a.tool_use_id; // its result tells the outcome
    return { behavior: 'allow' };
  }

  /** The chat leaves the list at once, and the stored text goes after five seconds, unless the user takes it back. */
  remove(id) {
    const c = this.#chat(id);
    this.stop(id);
    this.list = this.list.filter((x) => x !== c);
    this.#trash.set(id, { chat: c, timer: this.setTimer(() => this.#erase(id), UNDO_MS) });
    if (this.current === id) this.current = null;
    this.#endSession(id);
    this.#queues.delete(id);
    this.#drafts.delete(id);
    this.#save();
  }

  undo(id) {
    const t = this.#trash.get(id);
    if (!t) throw new ToolError('not_found', 'The chat is already gone.');
    this.clearTimer(t.timer);
    this.#trash.delete(id);
    this.list.unshift(t.chat);
    this.#save(id);
    this.select(id);
  }

  async #erase(id) {
    this.#trash.delete(id);
    this.#items.delete(id);
    this.#last.delete(id);
    this.#dirty.delete(id);
    await this.store.remove(`chat:${id}`);
    this.onChange();
  }

  async clear() {
    for (const c of [...this.list]) this.remove(c.id);
    for (const [id, t] of [...this.#trash]) {
      this.clearTimer(t.timer);
      await this.#erase(id);
    }
    this.lists = null;
    await this.store.remove('claudeLists');
  }

  search(query) {
    const q = String(query).toLowerCase();
    return this.list.filter((c) => c.title.toLowerCase().includes(q) || this.#items.get(c.id).some((i) => i.text?.toLowerCase().includes(q))).map((c) => c.id);
  }

  /** The router session of a chat. After it ended, a new one has a new ID and no grant. */
  session(id) {
    const c = this.#chat(id);
    const old = this.#sessions.get(id);
    if (old && this.router.sessions.has(old)) return old;
    const sid = `chat-${hex(8)}`;
    this.#sessions.set(id, sid);
    this.router.openSession(sid, 'chat', `Chat: ${c.title}`);
    return sid;
  }

  #endSession(id) {
    const sid = this.#sessions.get(id);
    this.#sessions.delete(id);
    if (sid) this.router.endSession(sid);
  }

  // Attachments. A tab is read through the router, with the grant of this chat's session.

  async attachTab(id, kind, tabId) {
    const sid = this.session(id);
    const call = async (tool, args) => {
      const r = await this.router.call(sid, `attach:${this.#next++}`, tool, args, { user: true });
      if (r.error) throw new ToolError(r.error.code, r.error.message);
      return r.result;
    };
    if (kind === 'page') {
      const r = await call('read_page', { tabId });
      return this.#addText(id, kind, `Page ${r.origin}${r.truncated ? ' (cut)' : ''}`, wrapPageText(r.origin, r.outline));
    }
    if (kind === 'selection') {
      const r = await call('get_selection', { tabId });
      if (!r.text.trim()) throw new ToolError('no_match', 'No text is selected in this tab.');
      return this.#addText(id, kind, `Selection from ${r.origin}${r.truncated ? ' (cut)' : ''}`, wrapPageText(r.origin, r.text));
    }
    if (kind === 'screenshot') {
      const r = await call('computer', { action: 'screenshot', tabId });
      return this.#addImage(id, kind, `Screenshot of ${r.origin}`, r.mimeType, r.image);
    }
    throw new ToolError('invalid_argument', 'Unknown attachment.');
  }

  /** A file that the user picked. The bytes decide what it is, not its name. */
  attachFile(id, { name, base64 }) {
    this.#chat(id);
    const label = oneLine(name, 100) || 'file';
    let bytes;
    try {
      bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    } catch {
      throw new ToolError('invalid_argument', 'The file could not be read.');
    }
    const starts = (...b) => b.every((x, i) => x === null || bytes[i] === x);
    const image = starts(0x89, 0x50, 0x4e, 0x47) ? 'image/png' : starts(0xff, 0xd8, 0xff) ? 'image/jpeg' : starts(0x47, 0x49, 0x46, 0x38) ? 'image/gif' : starts(0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50) ? 'image/webp' : null;
    const over = (max) => {
      if (bytes.length > max) throw new ToolError('too_large', `${label} is larger than ${max / 1024 / 1024} MB.`);
    };
    if (image) {
      over(LIMITS.fileImage);
      return this.#addImage(id, 'file', label, image, base64);
    }
    if (starts(0x25, 0x50, 0x44, 0x46)) {
      over(LIMITS.filePdf);
      return this.#add(id, { kind: 'file', name: label, size: bytes.length, preview: { type: 'none', text: 'PDF, sent whole.' }, block: { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 }, title: label } });
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      text = '\0';
    }
    if (text.includes('\0')) throw new ToolError('not_supported', `${label} is not a picture, a PDF or a text file.`);
    if (text.length > LIMITS.fileText) throw new ToolError('too_large', `${label} has more than ${LIMITS.fileText} characters.`);
    return this.#addText(id, 'file', label, wrapFileText(label, text));
  }

  #addText(id, kind, name, text) {
    return this.#add(id, { kind, name, size: text.length, preview: { type: 'text', text }, block: { type: 'text', text } });
  }

  #addImage(id, kind, name, mime, data) {
    return this.#add(id, { kind, name, size: Math.floor((data.length * 3) / 4), preview: { type: 'image', url: `data:${mime};base64,${data}` }, block: { type: 'image', source: { type: 'base64', media_type: mime, data } } });
  }

  #add(id, a) {
    const draft = this.#drafts.get(id) ?? [];
    if (draft.length >= LIMITS.attachments) throw new ToolError('limit_reached', `A message carries at most ${LIMITS.attachments} attachments.`);
    const entry = { id: `d${this.#next++}`, ...a };
    this.#drafts.set(id, [...draft, entry]);
    this.onChange();
    return { id: entry.id };
  }

  detach(id, draftId) {
    this.#drafts.set(id, (this.#drafts.get(id) ?? []).filter((d) => d.id !== draftId));
    this.onChange();
  }

  /** Exactly what one attachment will send. */
  preview(id, draftId) {
    const d = (this.#drafts.get(id) ?? []).find((x) => x.id === draftId);
    if (!d) throw new ToolError('not_found', 'That attachment is gone.');
    return { name: d.name, preview: d.preview };
  }

  // Runs

  send(id, text) {
    const c = this.#chat(id);
    const msg = { text: String(text).trim(), files: this.#drafts.get(id) ?? [] };
    if (!msg.text && !msg.files.length) throw new ToolError('invalid_argument', 'The message is empty.');
    if (this.#input(msg).length > LIMITS.message) throw new ToolError('too_large', 'The message with its attachments is too large.');
    if (!this.connected()) throw new ToolError('not_connected', 'The helper is not running. Press Connect.');
    const queue = this.#queues.get(id) ?? [];
    const wait = c.running || queue.length > 0;
    if (wait && queue.length >= LIMITS.queue) throw new ToolError('limit_reached', 'Too many messages wait.');
    this.#drafts.delete(id);
    if (wait) {
      this.#queues.set(id, [...queue, msg]);
      if (!c.running) this.#following(id);
      this.onChange();
    } else this.#start(c, msg);
    return { queued: wait };
  }

  /** Sends the last message again. Its attachments are kept in memory only. */
  retry(id) {
    const c = this.#chat(id);
    const msg = this.#last.get(id);
    if (!msg || c.running) throw new ToolError('not_found', 'There is nothing to send again.');
    if (!this.connected()) throw new ToolError('not_connected', 'The helper is not running. Press Connect.');
    this.#start(c, msg);
  }

  /** A waiting message goes back to the input: its text is returned, its attachments are drafts again. */
  editQueued(id, i) {
    const msg = (this.#queues.get(id) ?? [])[i];
    if (!msg) throw new ToolError('not_found', 'That message is not waiting any more.');
    this.#drafts.set(id, [...msg.files, ...(this.#drafts.get(id) ?? [])].slice(0, LIMITS.attachments));
    this.unqueue(id, i);
    return { text: msg.text };
  }

  unqueue(id, i) {
    this.#queues.set(id, (this.#queues.get(id) ?? []).filter((_, n) => n !== i));
    this.onChange();
  }

  /** The next waiting message, after a stop or an error when the user says so. */
  flush(id) {
    if (this.#chat(id).running) return;
    if (!this.connected()) throw new ToolError('not_connected', 'The helper is not running. Press Connect.');
    this.#following(id);
  }

  #following(id) {
    const [msg, ...rest] = this.#queues.get(id) ?? [];
    if (!msg) return;
    this.#queues.set(id, rest);
    this.#start(this.#chat(id), msg);
  }

  #input(msg) {
    const content = [...msg.files.map((f) => f.block), ...(msg.text ? [{ type: 'text', text: msg.text }] : [])];
    // One line, also for a reader that ends a line at these two.
    return JSON.stringify({ type: 'user', message: { role: 'user', content } }).replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
  }

  #start(c, msg) {
    const sid = this.session(c.id);
    const run = { id: this.uuid(), chat: c.id, sid, tools: c.tools === true, ticket: hex(32), line: '', text: null, streamed: new Set(), stopped: false, result: null, failed: false, before: new Set(this.router.sessions.get(sid).acted) };
    if (c.title === 'New chat') {
      c.title = oneLine(msg.text || msg.files[0].name, 60);
      this.router.label(sid, `Chat: ${c.title}`);
    }
    c.running = true;
    this.#last.set(c.id, msg);
    this.#push(c.id, { type: 'user', text: msg.text, files: msg.files.map(({ kind, name, size }) => ({ kind, name, size })) });
    this.#runs.set(run.id, run);
    this.post({ type: 'chat_run', run: run.id, session: c.claude, resume: c.started, model: c.model, extras: c.extras, tools: run.tools, ticket: run.ticket, input: this.#input(msg) });
  }

  #runOf(id) {
    return [...this.#runs.values()].find((r) => r.chat === id);
  }

  /** Ends the run and its calls, and says what may already have happened. */
  stop(id) {
    const run = this.#runOf(id);
    if (!run || run.stopped) return;
    run.stopped = true;
    this.router.stopCalls(run.sid);
    this.post({ type: 'chat_stop', run: run.id });
    this.#end(id);
    this.#note(id, 'warn', `Stopped. ${this.#outcome(run)}`);
  }

  /** Emergency stop: every run ends. A pause ends those that may have a command under way, which no call here could end. */
  stopAll(match = () => true) {
    for (const run of [...this.#runs.values()]) if (match(run)) this.stop(run.chat);
  }

  #outcome(run) {
    const acted = (this.router.sessions.get(run.sid)?.acted ?? []).filter((a) => !run.before.has(a));
    const names = (o) => acted.filter((a) => a.outcome === o).map((a) => a.what).join('; ');
    const maybe = names('unknown');
    const done = names('done');
    return [
      maybe && `May already have taken effect: ${maybe}. Check the page.`,
      done && `Carried out before that: ${done}.`,
      !maybe && !done && 'No action had been sent to a page.',
    ].filter(Boolean).join(' ');
  }

  /** The helper is gone, and with it every run and every grant. */
  linkLost() {
    for (const run of [...this.#runs.values()]) {
      const text = this.#outcome(run);
      this.#runs.delete(run.id);
      const c = this.#find(run.chat);
      if (!c) continue;
      c.running = false;
      this.#end(run.chat);
      if (!run.stopped) this.#note(run.chat, 'warn', `The helper stopped, so this reply is cut. ${text} Attach the tabs again; your next message goes on with this conversation.`);
    }
    this.#links.clear();
    for (const id of [...this.#sessions.keys()]) this.#endSession(id);
    this.#save();
  }

  // The MCP server of a run joins the session of its chat with a ticket that works once.

  redeem(pipe, ticket) {
    const run = typeof ticket === 'string' && [...this.#runs.values()].find((r) => r.ticket === ticket && !r.stopped);
    if (!run) return false;
    run.ticket = null;
    this.#links.set(pipe, run);
    return true;
  }

  /** The chat session behind a pipe, null for any other client, undefined once its run was stopped or ended. */
  sessionOf(pipe) {
    const run = this.#links.get(pipe);
    if (!run) return null;
    return run.stopped || !this.#runs.has(run.id) ? undefined : run.sid;
  }

  unlink(pipe) {
    const run = this.#links.get(pipe);
    this.#links.delete(pipe);
    if (run) this.router.stopCalls(run.sid, 'stopped', (c) => String(c.id).startsWith(`${pipe}:`));
  }

  // Messages of the helper

  onHost(m) {
    const run = this.#runs.get(m.run);
    const c = run && this.#find(run.chat);
    if (!c) return void this.#runs.delete(m.run);
    if (m.type === 'chat_exit') return this.#exit(run, c, m);
    run.line += m.part;
    if (!m.end) return;
    const line = run.line;
    run.line = '';
    if (run.stopped) return;
    try {
      this.#event(run, c, JSON.parse(line));
    } catch (e) {
      console.error('event', e); // an event of another shape never ends the chat
    }
  }

  #event(run, c, e) {
    const sub = Boolean(e.parent_tool_use_id);
    if (e.type === 'system' && e.subtype === 'init') {
      c.started = true;
      if (e.apiKeySource && e.apiKeySource !== 'none') this.#note(c.id, 'warn', `Claude Code uses an API key from its own settings (${oneLine(e.apiKeySource, 40)}), not a claude.ai sign-in.`);
      if (!e.mcp_servers?.some((s) => s.name === 'firefox-companion' && s.status === 'connected')) this.#note(c.id, 'warn', 'The browser tools did not connect in this run.');
      if (c.extras) {
        const names = (l) => (l ?? []).map((x) => oneLine(x?.name ?? x, 100));
        this.lists = { at: this.now(), model: oneLine(e.model, 60), skills: names(e.skills), agents: names(e.agents), plugins: names(e.plugins) };
        this.store.set({ claudeLists: this.lists });
      }
    } else if (e.type === 'stream_event' && !sub) {
      const v = e.event;
      if (v.type === 'message_start') run.streamed.add(v.message.id);
      else if (v.type === 'content_block_start') run.text = v.content_block.type === 'text' ? this.#push(c.id, { type: 'assistant', text: '' }) : null;
      else if (v.type === 'content_block_delta' && v.delta.type === 'text_delta' && run.text) run.text.text = (run.text.text + v.delta.text).slice(0, 200_000);
      else return;
    } else if (e.type === 'assistant') {
      for (const b of e.message.content) {
        if (b.type === 'text' && !sub && !run.streamed.has(e.message.id)) this.#push(c.id, { type: 'assistant', text: b.text });
        if (b.type === 'tool_use') this.#push(c.id, { type: 'tool', id: b.id, name: oneLine(b.name.replace(TOOL, ''), 60), text: oneLine(JSON.stringify(b.input), 300), state: 'running', result: '', sub });
      }
    } else if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        const item = b.type === 'tool_result' && this.#items.get(c.id).findLast((i) => i.type === 'tool' && i.id === b.tool_use_id);
        if (item) Object.assign(item, { state: b.is_error ? 'error' : 'ok', result: textOf(b.content).slice(0, LIMITS.toolResultChars) });
        const allowed = this.router.sessions.get(run.sid)?.acted.find((x) => x.use && x.use === b.tool_use_id);
        if (allowed) allowed.outcome = 'done';
      }
    } else if (e.type === 'result') {
      run.result = e;
      if (e.is_error) this.#failed(run, c, oneLine(e.result ?? e.errors?.join(' ') ?? e.subtype, 500));
      for (const d of (e.permission_denials ?? []).slice(0, 5)) this.#note(c.id, 'info', `Not allowed in this chat: ${oneLine(d.tool_name, 60)}`);
    } else if (e.type === 'rate_limit_event' && e.rate_limit_info?.status === 'rejected') {
      this.#note(c.id, 'warn', 'The usage limit of your Claude account is reached for now.');
    } else return;
    this.#save(c.id);
  }

  #failed(run, c, text) {
    run.failed = true;
    this.#note(c.id, 'error', LOGIN.test(text) ? `Claude Code is not signed in. Run "claude auth login" in a terminal, then press Try again. (${text})` : text || 'Claude Code reported an error.');
  }

  #exit(run, c, m) {
    this.#runs.delete(run.id);
    c.running = false;
    this.#end(c.id);
    const detail = oneLine(m.detail, 500);
    if (!run.stopped && !run.result) {
      if (/no conversation found/i.test(detail)) {
        Object.assign(c, { started: false, claude: this.uuid() });
        this.#failed(run, c, 'Claude Code no longer has this conversation. Try again starts it anew, without the earlier messages.');
      } else if (/already in use/i.test(detail)) {
        c.started = true;
        this.#failed(run, c, 'The conversation exists already. Press Try again.');
      } else if (m.error === 'claude_missing') this.#failed(run, c, `Claude Code was not found. Install it, or add it to PATH and restart Firefox. (${detail})`);
      else this.#failed(run, c, `Claude Code ended without a result (exit code ${m.code}). ${this.#outcome(run)} ${detail}`.trim());
    }
    this.#save(c.id);
    if (!run.stopped && !run.failed) this.#following(c.id);
  }

  // Items

  #find(id) {
    return this.list.find((x) => x.id === id) ?? this.#trash.get(id)?.chat ?? null;
  }

  #chat(id) {
    const c = this.#find(id);
    if (!c) throw new ToolError('not_found', 'That chat is gone.');
    return c;
  }

  #push(id, item) {
    const items = this.#items.get(id);
    items.push({ at: this.now(), ...item });
    if (items.length > LIMITS.chatItems) items.splice(0, items.length - LIMITS.chatItems);
    this.#chat(id).updated = this.now();
    this.#save(id);
    return items.at(-1);
  }

  #note(id, level, text) {
    this.#push(id, { type: 'note', level, text });
  }

  /** Nothing runs any more: a step without an answer has an unknown outcome. */
  #end(id) {
    for (const i of this.#items.get(id) ?? []) if (i.type === 'tool' && i.state === 'running') i.state = 'unknown';
  }

  #save(id) {
    if (id) this.#dirty.add(id);
    this.onChange();
    this.#timer ??= this.setTimer(() => this.flushStore(), SAVE_MS);
  }

  flushStore() {
    this.clearTimer(this.#timer);
    this.#timer = null;
    const data = { chats: this.list };
    for (const id of this.#dirty) if (this.#items.has(id)) data[`chat:${id}`] = this.#items.get(id);
    this.#dirty.clear();
    return this.store.set(data);
  }

  // View

  view() {
    return {
      list: this.list.map((c) => ({ id: c.id, title: c.title, updated: c.updated, running: c.running, waiting: this.#queues.get(c.id)?.length ?? 0 })),
      current: this.current,
      deleted: [...this.#trash.values()].map((t) => ({ id: t.chat.id, title: t.chat.title })),
      lists: this.lists,
    };
  }

  /** The open chat. The content of attachments is fetched one by one with `preview`. */
  open() {
    const c = this.list.find((x) => x.id === this.current);
    if (!c) return null;
    return {
      ...c,
      session: this.#sessions.get(c.id) ?? null,
      items: this.#items.get(c.id),
      queue: (this.#queues.get(c.id) ?? []).map((q) => ({ text: q.text, files: q.files.length })),
      draft: (this.#drafts.get(c.id) ?? []).map(({ id, kind, name, size }) => ({ id, kind, name, size })),
      canRetry: !c.running && this.#last.has(c.id),
    };
  }
}
