// Mail tools with a mocked Thunderbird. Real: Router, approvals, shares, redaction. Simulated evidence only.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { Router } from '../../dist/thunderbird/background/router.mjs';
import { Approvals } from '../../dist/thunderbird/grants/approvals.mjs';
import { Grants } from '../../dist/thunderbird/grants/grants.mjs';
import { Shares, mailTools, redactMail, textOf } from '../../dist/thunderbird/thunderbird/mail.mjs';
import { mcpTools } from '../../dist/thunderbird/shared/protocol.mjs';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const msg = (id, account, subject, more = {}) => ({ id, date: new Date(2026, 10, id), author: 'Ada <ada@a.example>', subject, read: false, folder: { accountId: account, path: '/INBOX' }, ...more });
let messages, asked, router, approvals, shares, n, body;

beforeEach(() => {
  messages = [msg(1, 'a1', 'Lunch'), msg(2, 'a1', 'Your code is 493817'), msg(3, 'a2', 'Private')];
  body = { parts: [{ contentType: 'text/plain', body: 'Hello. Reset: https://x.example/reset?token=abc123 password: hunter2. Code 493817. Call 5551234.' }, { contentType: 'application/pdf', name: 'bill.pdf', size: 9, body: 'PDFDATA' }] };
  asked = [];
  n = 0;
  approvals = new Approvals();
  shares = new Shares();
  const messenger = {
    accounts: { list: async () => [{ id: 'a1', name: 'Work', type: 'imap', folders: [{ path: '/INBOX', name: 'Inbox', subFolders: [{ path: '/INBOX/x', name: 'x' }] }] }, { id: 'a2', name: 'Home', type: 'imap', folders: [] }] },
    // A server that answers more than was asked for.
    messages: { query: async (q) => (asked.push(q), { id: null, messages }), continueList: async () => null, get: async (id) => messages.find((m) => m.id === id) ?? Promise.reject(new Error('none')), getFull: async (id) => (asked.push(['full', id]), body) },
  };
  router = new Router({ api: { getTab: () => Promise.reject(new Error('no')), page: async () => null, forget() {}, browser: {} }, grants: new Grants(), approvals, handlers: mailTools({ messenger, shares }), log: () => {} });
  for (const s of ['s1', 's2']) router.openSession(s, 'mcp', s);
});
const call = (tool, args = {}, s = 's1') => router.call(s, ++n, tool, args);
const code = async (p) => (await p).error?.code ?? 'ok';
const answer = async (yes) => {
  for (let i = 0; i < 100 && !approvals.cards.length; i++) await tick();
  const c = approvals.cards[0];
  approvals.shown(c.id);
  await tick(510);
  approvals.answer(c.id, yes);
  return c;
};

test('nothing is shared at first: accounts are a number, searching and reading are refused without a card', async () => {
  assert.deepEqual((await call('mail_accounts')).result, { accounts: [], otherAccounts: 2 });
  assert.equal(await code(call('mail_search', { account: 'a1' })), 'no_grant');
  assert.equal(await code(call('mail_read', { message: 1 })), 'no_grant');
  assert.equal(await code(call('mail_read', { message: 99 })), 'no_grant', 'a message that does not exist looks the same');
  assert.deepEqual([approvals.cards.length, asked.length], [0, 0]);
});

test('the Firefox tools are not there, and no tool of the mail server can change anything', async () => {
  for (const t of ['tabs_context', 'read_page', 'get_cookies', 'isolated_browser', 'search_history']) assert.equal(await code(call(t, t === 'read_page' || t === 'get_cookies' ? { tabId: 1 } : {})), 'unknown_tool', t);
  assert.deepEqual(mcpTools(['mail']).map((t) => t.name).filter((x) => x.startsWith('mail')), ['mail_accounts', 'mail_search', 'mail_read']);
  assert.ok(!mcpTools().some((t) => t.name.startsWith('mail')));
});

test('a shared account shows its subjects to this session only, never those of another account, with codes masked', async () => {
  shares.set('s1', 'a1', true);
  const a = (await call('mail_accounts')).result;
  assert.deepEqual([a.accounts.map((x) => x.account), a.otherAccounts, a.accounts[0].folders.map((f) => f.path)], [['a1'], 1, ['/INBOX', '/INBOX/x']]);
  const r = (await call('mail_search', { account: 'a1', text: 'x' })).result;
  assert.deepEqual(r.messages.map((m) => [m.message, m.subject]), [[2, 'Your code is [code]'], [1, 'Lunch']]);
  assert.equal(await code(call('mail_search', { account: 'a2' })), 'no_grant');
  assert.equal(await code(call('mail_search', { account: 'a1' }, 's2')), 'no_grant');
});

test('a message: denied nothing is read, approved its text comes without tokens, codes and passwords, attachments are named only', async () => {
  shares.set('s1', 'a1', true);
  let p = call('mail_read', { message: 2 });
  assert.match((await answer(false)).target, /Your code/);
  assert.equal(await code(p), 'approval_denied');
  assert.deepEqual(asked, []);
  p = call('mail_read', { message: 2 });
  await answer(true);
  const { result } = await p;
  for (const s of ['abc123', 'hunter2', '493817', 'PDFDATA']) assert.ok(!JSON.stringify(result).includes(s), s);
  assert.deepEqual([result.attachments, /Hello/.test(result.text)], [[{ name: 'bill.pdf', type: 'application/pdf', bytes: 9 }], true]);
  p = call('mail_read', { message: 1 });
  assert.equal(approvals.cards.length <= 1, true, 'each message asks again');
  await answer(false);
  await p;
});

test('taken back, stopped or paused while the card is open: the message is not opened', async () => {
  for (const [end, want] of [[() => (shares.set('s1', 'a1', false), router.stopCalls('s1', 'no_grant')), 'no_grant'], [() => router.halt(), 'stopped'], [() => router.setPaused(true), 'paused'], [() => (shares.end('s1'), router.endSession('s1')), 'session_ended']]) {
    router.resume();
    router.setPaused(false);
    if (router.sessions.has('s1')) shares.set('s1', 'a1', true);
    const p = call('mail_read', { message: 1 });
    for (let i = 0; i < 100 && !approvals.cards.length; i++) await tick();
    end();
    assert.equal(await code(p), want);
  }
  router.openSession('s1', 'mcp', 's1');
  router.setPaused(false);
  shares.set('s1', 'a1', true);
  const p = call('mail_read', { message: 1 });
  for (let i = 0; i < 100 && !approvals.cards.length; i++) await tick();
  shares.set('s1', 'a1', false); // and the card is answered all the same
  await answer(true);
  assert.equal(await code(p), 'no_grant');
  assert.deepEqual(asked, []);
});

test('text: the plain part first, HTML without scripts, and only mails about codes lose their numbers', () => {
  const parse = (html) => ({ querySelectorAll: () => [], body: { textContent: html.replace(/<[^>]+>/g, '') } });
  assert.equal(textOf({ parts: [{ contentType: 'text/html', body: '<b>h</b>' }, { contentType: 'text/plain', body: 'p' }] }, parse), 'p');
  assert.equal(textOf({ parts: [{ contentType: 'text/html; charset=utf-8', body: '<b>h</b>' }] }, parse), 'h');
  assert.equal(redactMail('Invoice 20931 of 2026, 4 items'), 'Invoice 20931 of 2026, 4 items');
  assert.equal(redactMail('Your verification code: 12 34 or 123 456 or AB12CD'), 'Your verification code: 12 34 or [code] or [code]');
});
