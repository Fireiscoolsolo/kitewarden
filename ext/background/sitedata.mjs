// Cookies and storage of the site of a granted tab, and the downloads of a session. The only code that reads cookies.
// No value of an HttpOnly cookie, and none that looks like a credential, leaves this file.
import { LIMITS, ToolError, VIRTUAL, oneLine, originOf, plainUrl } from '../shared/protocol.mjs';
import { MASK, isSecretName, redactUrl, redactValue } from '../shared/redact.mjs';

const b = (r) => r.api.browser;

function everyday(call) {
  if (call.tabId >= VIRTUAL) throw new ToolError('not_supported', 'That works for tabs of this Firefox only.');
}

// Cookies

const where = (tab) => ({ url: tab.url, storeId: tab.cookieStoreId, firstPartyDomain: null });

const shown = (c) => ({ name: oneLine(c.name, 200), domain: c.domain, path: c.path, http_only: c.httpOnly, secure: c.secure, same_site: c.sameSite, session: c.session, expires: c.session ? null : new Date(c.expirationDate * 1000).toISOString() });

/** A value that may be shown: script of the page can read it, and neither name nor value look like a credential. */
const open = (c) => !c.httpOnly && c.value !== '' && redactValue(c.name, c.value) === c.value;

async function getCookies(r, call, spec, origin, a) {
  everyday(call);
  const read = async () => b(r).cookies.getAll(where(await r.tab(call.tabId)));
  const before = await read();
  const names = before.filter(open).map((c) => c.name);
  await r.ask(call, spec, origin, { tool: 'get_cookies', target: `Cookies of ${origin}`, value: a.values ? `Values of: ${names.map((n) => oneLine(n, 60)).join(', ') || 'none that may be shown'}. HttpOnly and credential-like values stay hidden` : 'Names and flags only' }, a.reason);
  const list = await read();
  return {
    origin,
    cookies: list.slice(0, 200).map((c) => ({ ...shown(c), value: a.values && open(c) && names.includes(c.name) ? c.value : c.value === '' ? '' : MASK })),
    note: 'HttpOnly values and values that look like credentials are never returned.',
  };
}

/** The address of a cookie of this tab's site, if nothing HttpOnly is under that name. */
async function changeable(r, call, origin, a) {
  everyday(call);
  const path = a.path ?? '/';
  if (!path.startsWith('/') || /[;\s\\]/.test(path) || /[=;,\s]/.test(a.name)) throw new ToolError('invalid_argument', 'A name has no spaces, = ; or ,. A path starts with /.');
  const tab = await r.tab(call.tabId);
  const url = origin + path;
  const same = await b(r).cookies.getAll({ ...where(tab), url, name: a.name });
  if (same.some((c) => c.httpOnly)) throw new ToolError('not_allowed', 'There is an HttpOnly cookie of that name. Those are not changed.');
  return { tab, url, path, same };
}

async function setCookie(r, call, spec, origin, a) {
  const { path } = await changeable(r, call, origin, a);
  if (/[;\r\n]/.test(a.value)) throw new ToolError('invalid_argument', 'A value has no ; and no line break.');
  await r.ask(call, spec, origin, { tool: 'set_cookie', target: `Cookie ${a.name} of ${origin}${path === '/' ? '' : path}`, value: `${a.value}${a.expires_s ? ` (for ${a.expires_s} s)` : ' (until Firefox closes)'}` }, a.reason);
  const { tab, url } = await changeable(r, call, origin, a);
  r.sent(call, `setting cookie ${oneLine(a.name, 40)}`);
  const c = await b(r).cookies.set({ url, storeId: tab.cookieStoreId, firstPartyDomain: null, name: a.name, value: a.value, path, secure: origin.startsWith('https:'), httpOnly: false, sameSite: 'lax', ...(a.expires_s && { expirationDate: Math.floor(r.now() / 1000) + a.expires_s }) });
  call.sent.outcome = 'done';
  return { set: Boolean(c), ...(c && { cookie: shown(c) }) };
}

async function removeCookie(r, call, spec, origin, a) {
  if (!(await changeable(r, call, origin, a)).same.length) throw new ToolError('not_found', 'The site has no such cookie there.');
  await r.ask(call, spec, origin, { tool: 'remove_cookie', target: `Cookie ${a.name} of ${origin}` }, a.reason);
  const { tab, url } = await changeable(r, call, origin, a);
  r.sent(call, `removing cookie ${oneLine(a.name, 40)}`);
  await b(r).cookies.remove({ url, storeId: tab.cookieStoreId, firstPartyDomain: null, name: a.name });
  call.sent.outcome = 'done';
  return { removed: (await b(r).cookies.getAll({ ...where(tab), url, name: a.name })).length === 0 };
}

// Storage

const entry = ({ key, length, value }) => ({ key: isSecretName(key) ? key : redactValue('', key), length, value: redactValue(key, value), ...(length > value.length && { cut: true }) });

async function pageStorage(r, call, spec, origin, a) {
  const what = `${a.area}Storage of ${origin}`;
  const send = (action) => r.page(call, origin, { cmd: 'storage', action, area: a.area, key: a.key, value: a.value, max: 20_000 });
  if (a.action === 'list' || a.action === 'get') {
    await r.ask(call, spec, origin, { tool: 'page_storage', target: what, value: a.action === 'list' ? 'Read all keys and values; credential-like values stay hidden' : `Read ${a.key}` }, a.reason);
    const x = await send(a.action);
    return { origin, area: a.area, ...(a.action === 'list' ? { total: x.total, entries: x.entries.map(entry) } : { entry: x.entry && entry(x.entry) }) };
  }
  const count = a.action === 'clear' ? (await send('list')).total : null;
  await r.ask(call, spec, origin, { tool: 'page_storage', target: what, value: { set: `Set ${a.key} to: ${a.value}`, delete: `Delete ${a.key}`, clear: `Delete all ${count} keys` }[a.action] }, a.reason);
  r.sent(call, `${a.action} in ${a.area} storage`);
  const { id, ...x } = await send(a.action);
  call.sent.outcome = 'done';
  return { origin, area: a.area, ...x };
}

// Downloads

async function inspect(r, call, spec, origin, a) {
  if (!call.session.downloads.includes(a.id)) throw new ToolError('not_found', 'This session started no such download.');
  const [d] = await b(r).downloads.search({ id: a.id });
  if (!d) throw new ToolError('not_found', 'Firefox no longer lists that download.');
  return {
    id: d.id,
    file: oneLine(d.filename.split(/[\\/]/).pop(), 200), // the folder is the user's
    url: redactUrl(d.url),
    from: originOf(d.referrer ?? '') ?? null,
    type: d.mime ?? null,
    state: d.state,
    paused: d.paused,
    can_resume: d.canResume,
    error: d.error ?? null,
    bytes: d.bytesReceived,
    total: d.totalBytes,
    size: d.fileSize,
    started: d.startTime,
    ended: d.endTime ?? null,
    danger: d.danger ?? null,
    file_exists: d.exists,
  };
}

export const siteTools = { get_cookies: getCookies, set_cookie: setCookie, remove_cookie: removeCookie, page_storage: pageStorage, download_inspect: inspect };
