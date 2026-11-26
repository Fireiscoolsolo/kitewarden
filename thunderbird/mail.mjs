// Reading mail in Thunderbird through its documented add-on interfaces. A session sees the accounts that the user shared with
// it, subjects and senders there, and the text of one message after an approval. Nothing is sent, moved, marked or deleted.
import { ToolError, oneLine } from '../shared/protocol.mjs';
import { redactText } from '../shared/redact.mjs';

// A login or reset code is a credential that can be used once.
const CODE_WORDS = /\b(code|otp|pin|passcode|password|one.?time|verification|verify|log.?in|sign.?in|confirm|security|reset|2fa|mfa)\b/i;

/** Text of a mail without credentials: tokens, links with tokens, and codes where the mail is about one. */
export function redactMail(text, about = text) {
  const t = redactText(text);
  return CODE_WORDS.test(about) ? t.replace(/(?<![\w./:@-])(\d{3}[ -]?\d{3}|\d{4,8}|(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{5,10})(?![\w/@])/g, '[code]') : t;
}

/** Plain text of the parts of a message, the plain version first. */
export function textOf(part, parse = (html) => new DOMParser().parseFromString(html, 'text/html')) {
  const all = [];
  const walk = (p) => {
    if (p.body && !p.name) all.push(p);
    (p.parts ?? []).forEach(walk);
  };
  walk(part);
  const plain = all.filter((p) => /^text\/plain/i.test(p.contentType ?? ''));
  if (plain.length) return plain.map((p) => p.body).join('\n\n');
  return all.filter((p) => /^text\/html/i.test(p.contentType ?? '')).map((p) => {
    const doc = parse(p.body);
    for (const e of doc.querySelectorAll('script, style, head, template')) e.remove();
    return doc.body?.textContent ?? '';
  }).join('\n\n').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

export class Shares {
  #by = new Map(); // session -> Set of accounts

  of(session) {
    return this.#by.get(session) ?? new Set();
  }
  set(session, account, on) {
    const s = new Set(this.of(session));
    if (on) s.add(account);
    else s.delete(account);
    this.#by.set(session, s);
  }
  end(session) {
    this.#by.delete(session);
  }
  view() {
    return Object.fromEntries([...this.#by].map(([k, v]) => [k, [...v]]));
  }
}

export function mailTools({ messenger, shares, parse }) {
  const need = (call, account) => {
    if (!shares.of(call.session.id).has(account)) throw new ToolError('no_grant', 'The user has not shared that account with this session. Ask the user to do it in Kitewarden in Thunderbird.');
  };
  const header = (m) => ({ message: m.id, date: new Date(m.date).toISOString(), from: redactMail(oneLine(m.author, 200), ''), subject: redactMail(oneLine(m.subject, 300)), read: m.read, folder: m.folder?.path ?? null });

  async function accounts(r, call) {
    const all = await messenger.accounts.list(true);
    const mine = all.filter((x) => shares.of(call.session.id).has(x.id));
    const folders = (list) => (list ?? []).flatMap((f) => [{ path: f.path, name: oneLine(f.name, 100) }, ...folders(f.subFolders)]);
    return { accounts: mine.map((x) => ({ account: x.id, name: oneLine(x.name, 100), type: x.type, folders: folders(x.folders ?? x.rootFolder?.subFolders).slice(0, 200) })), otherAccounts: all.length - mine.length };
  }

  async function search(r, call, spec, origin, a) {
    need(call, a.account);
    const limit = a.limit ?? 25;
    const base = { accountId: a.account, ...(a.unread !== undefined && { read: !a.unread }) };
    const found = new Map();
    for (const q of a.text ? [{ subject: a.text }, { author: a.text }] : [{}]) {
      let page = await messenger.messages.query({ ...base, ...q });
      for (let n = 0; page && n < 20; n++) {
        for (const m of page.messages) if (m.folder?.accountId === a.account && (!a.folder || m.folder.path === a.folder)) found.set(m.id, m);
        page = page.id && found.size < 500 ? await Promise.race([messenger.messages.continueList(page.id), call.gone]) : null;
      }
    }
    need(call, a.account); // the user may have taken it back meanwhile
    const list = [...found.values()].sort((x, y) => new Date(y.date) - new Date(x.date));
    return { total: list.length, messages: list.slice(0, limit).map(header) };
  }

  async function read(r, call, spec, origin, a) {
    const m = await messenger.messages.get(a.message).catch(() => null);
    // A message of an account that is not shared and one that does not exist look the same.
    if (!m || !shares.of(call.session.id).has(m.folder?.accountId)) throw new ToolError('no_grant', 'There is no such message in an account that the user shared with this session.');
    await r.ask(call, spec, null, { tool: 'mail_read', target: oneLine(m.subject, 200), value: `From ${oneLine(m.author, 200)}, ${new Date(m.date).toLocaleString()}` }, a.reason);
    need(call, m.folder.accountId);
    const full = await Promise.race([messenger.messages.getFull(a.message), call.gone]);
    need(call, m.folder.accountId);
    const raw = textOf(full, parse);
    const max = a.max_chars ?? 20_000;
    const names = [];
    const walk = (p) => {
      if (p.name) names.push({ name: oneLine(p.name, 150), type: p.contentType, bytes: p.size ?? null });
      (p.parts ?? []).forEach(walk);
    };
    walk(full);
    return { ...header(m), text: redactMail(raw.slice(0, max), `${m.subject} ${raw.slice(0, max)}`), ...(raw.length > max && { cut: raw.length }), attachments: names.slice(0, 50) };
  }

  return { mail_accounts: accounts, mail_search: search, mail_read: read };
}
