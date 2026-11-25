// Tools that read or act in a granted tab. Each gets the router, the call, its spec and the origin that was authorized.
// An action is described, approved, checked again and dispatched; what the page did with it is looked up afterwards.
import { LIMITS, ToolError, VIRTUAL, oneLine, originOf, plainUrl } from '../shared/protocol.mjs';
import { elements } from '../workflow/elements.mjs';
import { frameOfRef, sleep } from './router.mjs';

const NO_EFFECT = 'no visible change; the page may ignore events of add-ons';
const BACKEND = 'If the page needs trusted input, ask the user to do this step. Two optional backends exist, windows_input and a tab of the isolated Firefox; none is used by itself.';

// Frames

/** The frame of a ref, authorized. */
export async function frameFor(r, call, origin, ref) {
  const frame = (call.frame = frameOfRef(ref));
  return { frame, origin: await r.authorizeFrame(call, origin, frame) };
}

/** All frames, the granted ones first level by level. A frame without a grant is listed and not entered. */
async function listFrames(r, call, origin) {
  const list = [{ frame: 0, parent: null, origin, granted: true, left: 0, top: 0, depth: 0 }];
  for (let i = 0; i < list.length && list.length < LIMITS.frames; i++) {
    const p = list[i];
    if (!p.granted || p.depth >= LIMITS.frameDepth) continue;
    const { children } = await r.page(call, p.origin, { cmd: 'children' }, p.frame);
    for (const c of children) {
      const entry = { frame: c.frame, parent: p.frame, origin: c.src, name: c.name, granted: false, left: p.left + c.left, top: p.top + c.top, depth: p.depth + 1 };
      try {
        entry.origin = await r.authorizeFrame(call, origin, c.frame);
        entry.granted = true;
      } catch (e) {
        if (e.code !== 'no_grant') throw e;
      }
      list.push(entry);
    }
  }
  return list;
}

export const granted = async (r, call, origin) => (await listFrames(r, call, origin)).filter((f) => f.granted);

/** Remembers what refs stood for, so that a stale one can be found again. */
export function remember(call, list) {
  const seen = call.session.seen.get(call.tabId) ?? new Map();
  for (const e of list) seen.set(e.ref, { role: e.role, name: e.name });
  while (seen.size > 5000) seen.delete(seen.keys().next().value);
  call.session.seen.set(call.tabId, seen);
}

/** Runs `fn`, and names up to three elements of the same role and name when its ref is stale. */
export async function withRef(r, call, origin, ref, fn) {
  try {
    return await fn(await frameFor(r, call, origin, ref));
  } catch (e) {
    const was = call.session.seen.get(call.tabId)?.get(ref);
    if (!was || !(e.code === 'stale_ref' || (e.code === 'no_grant' && frameOfRef(ref)))) throw e;
    const now = elements((await outline(r, call, origin, { filter: 'interactive', maxChars: 200_000 })).text).filter((x) => x.role === was.role && x.name === was.name).slice(0, 3);
    remember(call, now);
    const found = now.map((x) => `${x.role} ${JSON.stringify(x.name)} [${x.ref}]`).join(', ');
    throw Object.assign(new ToolError('stale_ref', `${e.message} ${found ? `Now there (names come from the page): ${found}` : 'Nothing of that role and name is there now.'}`), { fromPage: e.fromPage, data: { candidates: now } });
  }
}

// Reading

/** The outline of the tab with its granted frames put in their place. */
async function outline(r, call, origin, { filter, maxChars, ref, depth, viewport }) {
  const opts = { cmd: 'snapshot', filter, maxChars, maxNodes: LIMITS.snapshotNodes, root: ref ?? null, depthLimit: depth ?? 100, viewport: viewport === true };
  let full = 0;
  let cut = false;
  const frames = [];
  const read = async (frame, frameOrigin, indent, level) => {
    let s = await r.page(call, frameOrigin, frame === frameOfRef(ref) ? opts : { ...opts, root: null }, frame);
    // A document that has not drawn yet gets a moment.
    for (let n = 0; n < (s.ready === 'loading' ? 15 : 4) && s.lines.length < 2 && !ref; n++) {
      await Promise.race([sleep(300), call.gone]);
      s = await r.page(call, frameOrigin, { ...opts, root: null }, frame);
    }
    full += s.fullChars;
    cut ||= s.truncated;
    const lines = s.lines.map((l) => '  '.repeat(Math.min(indent, 20)) + l);
    let added = 0;
    for (const f of s.frames) {
      if (frames.length >= LIMITS.frames || level >= LIMITS.frameDepth) break;
      let inner;
      try {
        const o = await r.authorizeFrame(call, origin, f.frame);
        frames.push({ frame: f.frame, origin: o });
        inner = [`${'  '.repeat(Math.min(indent + f.depth, 20))}- frame ${f.frame} of ${o}`, ...(await read(f.frame, o, indent + f.depth + 1, level + 1))];
      } catch (e) {
        if (!['no_grant', 'origin_changed', 'timeout'].includes(e.code)) throw e;
        inner = [`${'  '.repeat(Math.min(indent + f.depth, 20))}- frame ${f.frame} not read: ${e.message}`];
      }
      lines.splice(f.line + added, 0, ...inner);
      added += inner.length;
    }
    return lines;
  };
  const start = await frameFor(r, call, origin, ref);
  let text = (await read(start.frame, start.origin, 0, 0)).join('\n');
  if (text.length > maxChars) {
    cut = true;
    text = text.slice(0, text.lastIndexOf('\n', maxChars));
  }
  return { text, frames, truncated: cut, fullChars: full };
}

async function readPage(r, call, spec, origin, a) {
  const o = await withRef(r, call, origin, a.ref_id, () => outline(r, call, origin, { filter: a.filter ?? 'all', maxChars: a.max_chars ?? LIMITS.readChars, ref: a.ref_id, depth: a.depth, viewport: a.viewport_only }));
  remember(call, elements(o.text));
  return { origin, outline: o.text, truncated: o.truncated, fullChars: o.fullChars, frames: o.frames };
}

async function pageText(r, call, spec, origin, a) {
  const parts = [];
  let first = null;
  const list = a.ref ? [await frameFor(r, call, origin, a.ref)] : await granted(r, call, origin);
  for (const f of list) {
    const t = await withRef(r, call, origin, a.ref, () => r.page(call, f.origin, { cmd: 'text', root: a.ref ?? null, links: a.links === true && !a.offset }, f.frame));
    first ??= t;
    if (f.frame && !a.ref) parts.push(`[frame ${f.frame} of ${f.origin}]`);
    parts.push(t.text);
    if (t.links.length) parts.push(`Links:\n${t.links.join('\n')}`);
  }
  const all = parts.filter(Boolean).join('\n\n');
  const from = a.offset ?? 0;
  const text = all.slice(from, from + (a.max_chars ?? 20_000));
  const end = from + text.length;
  return { origin, title: first.title, source: first.source, text, totalChars: all.length, nextOffset: end < all.length ? end : null, ...(all.length < 10 && { note: 'The page has almost no text.' }) };
}

async function find(r, call, spec, origin, a) {
  const hits = [];
  let total = 0;
  for (const f of await granted(r, call, origin)) {
    const s = await r.page(call, f.origin, { cmd: 'search', query: a.query, selector: a.selector, limit: 20 }, f.frame);
    total += s.total;
    hits.push(...s.hits.map((h) => ({ ...h, ...(f.frame && { frame: f.frame, frame_origin: f.origin }) })));
  }
  if (a.query !== undefined) hits.sort((x, y) => y.score - x.score);
  const list = hits.slice(0, 20).map(({ score, ...h }) => h);
  remember(call, list);
  return { origin, total, elements: list };
}

async function findText(r, call, spec, origin, a) {
  let count = 0;
  const snippets = [];
  for (const f of await granted(r, call, origin)) {
    const t = await r.page(call, f.origin, { cmd: 'find_text', text: a.text }, f.frame);
    count += t.count;
    snippets.push(...t.snippets);
  }
  return { origin, count, snippets: snippets.slice(0, 5) };
}

const glob = (pattern) => new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');

async function waitFor(r, call, spec, origin, a) {
  const limit = (a.timeout_s ?? 10) * 1000;
  const what = ['text', 'text_gone', 'ref', 'url', 'title', 'load'].find((k) => a[k] !== undefined);
  const test = {
    text: async () => (await any({ text: a.text })).some(Boolean),
    text_gone: async () => (await any({ gone: a.text_gone })).every(Boolean),
    ref: async () => {
      const f = await frameFor(r, call, origin, a.ref);
      return (await r.page(call, f.origin, { cmd: 'check', ref: a.ref, state: a.state ?? 'visible' }, f.frame)).met;
    },
    url: async () => glob(a.url).test(plainUrl((await r.tab(call.tabId)).url)),
    title: async () => glob(a.title).test(oneLine((await r.tab(call.tabId)).title)),
    load: async () => (await r.tab(call.tabId)).status === 'complete',
  }[what];
  const any = async (m) => {
    const met = [];
    for (const f of await granted(r, call, origin)) met.push((await r.page(call, f.origin, { cmd: 'check', ...m }, f.frame)).met);
    return met;
  };
  for (;;) {
    const found = await test();
    const elapsed_ms = r.now() - call.since;
    if (found || elapsed_ms >= limit) return { found, condition: what, elapsed_ms };
    await Promise.race([sleep(Math.min(250, limit - elapsed_ms)), call.gone]);
    if ((await r.authorize(call, spec)) !== origin) throw new ToolError('origin_changed', 'The page changed its origin.');
  }
}

// Pictures

/** The visible area, with secret fields and every frame without a grant covered. */
export async function screenshot(r, call, spec, origin) {
  const tab = await r.tab(call.tabId);
  if ((await r.api.windowState?.(tab?.windowId)) === 'minimized') throw new ToolError('not_allowed', 'The window is minimized, so Firefox draws nothing. Ask the user to restore it.');
  const open = await granted(r, call, origin);
  const frames = open.map((f) => f.frame);
  const ids = [];
  let shot;
  const after = [];
  try {
    for (const f of open) ids.push((await r.page(call, f.origin, { cmd: 'cover', frames }, f.frame)).id);
    shot = await capture(r, call);
  } finally {
    for (const f of open) after.push(await r.page(call, f.origin, { cmd: 'uncover' }, f.frame).catch(() => null));
  }
  // The picture counts only if the same documents were there before and after it.
  await r.authorize(call, spec);
  if (after.some((x, i) => x?.id !== ids[i])) throw new ToolError('origin_changed', 'The page changed during the capture.');
  const [, mimeType, image] = /^data:([^;]+);base64,(.*)$/s.exec(shot.dataUrl);
  if (image.length > LIMITS.imageBase64) throw new ToolError('too_large', 'The picture is too large.');
  return { image, mimeType, origin, via: shot.via };
}

async function capture(r, call) {
  if (call.tabId >= VIRTUAL || (await r.api.hasAllUrls())) return { dataUrl: await r.api.captureTab(call.tabId), via: 'captureTab' };
  const need = new ToolError('permission_required', 'A picture needs the user: ask them to press the Firefox Companion toolbar button on this tab, or to allow screenshots of any granted tab in the sidebar.');
  const tab = await r.tab(call.tabId);
  if (!tab?.active) throw need;
  let dataUrl;
  try {
    dataUrl = await r.api.captureVisible(tab.windowId);
  } catch {
    throw need;
  }
  // captureVisibleTab takes whatever tab is in front. Make sure that it still is this one.
  if (!(await r.tab(call.tabId))?.active) throw new ToolError('origin_changed', 'Another tab came to the front during the capture.');
  return { dataUrl, via: 'captureVisibleTab' };
}

async function look(r, call, spec, origin, a) {
  const marks = [];
  if (a.annotate) {
    for (const f of await granted(r, call, origin)) {
      const m = await r.page(call, f.origin, { cmd: 'marks' }, f.frame);
      marks.push(...m.marks.map((x) => ({ ...x, left: x.left + f.left, top: x.top + f.top })));
    }
    remember(call, marks);
  }
  const place = await r.page(call, origin, { cmd: 'place' });
  const s = await screenshot(r, call, spec, origin);
  const drawn = await r.api.annotate(`data:${s.mimeType};base64,${s.image}`, marks.slice(0, 100), place);
  const image_id = `img_${crypto.randomUUID().slice(0, 12)}`;
  call.session.shots.set(image_id, { tabId: call.tabId, doc: place.id, scroll: place.scroll.join(), css: [place.width, place.height], size: [drawn.width, drawn.height], at: r.now() });
  while (call.session.shots.size > 20) call.session.shots.delete(call.session.shots.keys().next().value);
  const [, mimeType, image] = /^data:([^;]+);base64,(.*)$/s.exec(drawn.dataUrl);
  return { image, mimeType, origin, via: s.via, image_id, width: drawn.width, height: drawn.height, css_per_pixel: place.width / drawn.width, ...(a.annotate && { marks: marks.slice(0, 100).map((m, i) => ({ number: i + 1, ref: m.ref, role: m.role, name: m.name })) }) };
}

/** The element at a point of an earlier picture of this tab. */
async function atPoint(r, call, origin, a) {
  const s = call.session.shots.get(a.image_id);
  if (!s || s.tabId !== call.tabId) throw new ToolError('not_found', 'No such picture of this tab.');
  const place = await r.page(call, origin, { cmd: 'place' });
  if (r.now() - s.at > LIMITS.imageMs || place.id !== s.doc || place.scroll.join() !== s.scroll || [place.width, place.height].join() !== s.css.join()) throw new ToolError('expired', 'The page moved or changed its size since that picture, or it is too old. Take a new one.');
  if (a.x >= s.size[0] || a.y >= s.size[1]) throw new ToolError('invalid_argument', `The point ${a.x},${a.y} is outside the picture of ${s.size.join(' by ')}.`);
  let at = { x: (a.x * s.css[0]) / s.size[0], y: (a.y * s.css[1]) / s.size[1], frame: 0 };
  for (let n = 0; n <= LIMITS.frameDepth; n++) {
    const h = await r.page(call, await r.authorizeFrame(call, origin, at.frame), { cmd: 'hit', x: at.x, y: at.y }, at.frame);
    if (h.ref) return h.ref;
    at = h;
  }
  throw new ToolError('not_found', 'The point lies in too many frames.');
}

// Acting

const refFor = async (r, call, origin, a) => a.ref ?? (await atPoint(r, call, origin, a));

/** What the page did, apart from what was sent to it. */
async function effect(r, call, f, id, extra = {}) {
  const after = await r.page(call, f.origin, { cmd: 'after' }, f.frame).catch(() => null);
  // The question may reach the next document, which knows nothing of the action.
  const none = call.trusted ? 'no visible change' : NO_EFFECT;
  const page = after?.id !== id ? 'navigated' : extra.opened != null ? 'opened a tab' : after.changed ? 'changed' : none;
  const errors = r.observer?.takeErrors(call.session.id, call.tabId);
  return { dispatched: true, trusted_event: call.trusted === true, observed: page !== none, page, ...(page === NO_EFFECT && { hint: BACKEND }), ...(after?.dialogs?.length && { dialogs: after.dialogs }), ...(errors && { page_errors: errors }) };
}

async function send(r, call, f, what, message) {
  r.sent(call, what);
  try {
    const sent = await r.page(call, f.origin, message, f.frame);
    call.trusted = sent.trusted === true; // an isolated tab takes real input; everything else is synthetic
    return sent;
  } catch (e) {
    if (e.fromPage && e.code !== 'not_taken') r.notSent(call); // the page refused before it did anything
    throw e;
  }
}

async function click(r, call, spec, origin, a) {
  const ref = await refFor(r, call, origin, a);
  return withRef(r, call, origin, ref, async (f) => {
    const t = await r.page(call, f.origin, { cmd: 'describe', ref }, f.frame);
    const [button, count] = { left_click: ['left', 1], right_click: ['right', 1], middle_click: ['middle', 1], double_click: ['left', 2], triple_click: ['left', 3] }[a.action];
    const held = [a.modifiers?.length && a.modifiers.join('+'), a.dialog === 'accept' && 'accepts a dialog of the page'].filter(Boolean).join(', ');
    await r.ask(call, spec, origin, { tool: a.action, target: t.description, link: t.link, download: t.download, value: held || null, ...(f.frame && { frame: f.origin }) }, a.reason, f);
    const click = (r.clicking = { call, origin: f.origin, opened: null });
    let sent;
    try {
      sent = await send(r, call, f, `click on ${t.description}`, { cmd: 'pointer', ref, fingerprint: t.fingerprint, button, count, modifiers: a.modifiers ?? [], accept: a.dialog === 'accept', promptText: a.prompt_text });
      await Promise.race([sleep(300), call.gone]);
    } finally {
      if (r.clicking === click) r.clicking = null;
    }
    const seen = await effect(r, call, f, sent.id, click);
    call.sent.outcome = 'done';
    await r.frame(call, spec, origin, { label: `Click ${t.description}`, at: f.frame ? null : sent.at });
    return { clicked: t.description, ...seen, ...(click.opened !== null && { opened_tab: click.opened }) };
  });
}

async function hover(r, call, spec, origin, a) {
  const ref = await refFor(r, call, origin, a);
  return withRef(r, call, origin, ref, async (f) => {
    const t = await r.page(call, f.origin, { cmd: 'describe', ref, loose: true }, f.frame);
    const sent = await send(r, call, f, `hover over ${t.description}`, { cmd: 'hover', ref, modifiers: a.modifiers ?? [] });
    await Promise.race([sleep(150), call.gone]);
    const seen = await effect(r, call, f, sent.id);
    call.sent.outcome = 'done';
    return { hovered: t.description, ...seen, ...(!seen.observed && { hint: 'Only styles that react to :hover may have been missed; synthetic events do not set it.' }) };
  });
}

async function type(r, call, spec, origin, a) {
  return withRef(r, call, origin, a.ref, async (f) => {
    const t = a.ref ? await r.page(call, f.origin, { cmd: 'describe', ref: a.ref, fill: true }, f.frame) : { description: 'the field with the focus' };
    await r.ask(call, spec, origin, { tool: 'type', target: t.description, value: a.text, ...(f.frame && { frame: f.origin }) }, a.reason, f);
    const sent = await send(r, call, f, `typing in ${t.description}`, { cmd: 'type', ref: a.ref, fingerprint: t.fingerprint, text: a.text, slowly: a.slowly === true });
    call.sent.outcome = 'done';
    await r.frame(call, spec, origin, { label: `Type in ${t.description}`, at: null });
    const want = [...a.text].length;
    return { field: t.description, dispatched: true, trusted_event: call.trusted, observed: sent.arrived > 0, characters_sent: want, characters_arrived: sent.arrived };
  });
}

const SHORTCUTS = /^(F\d{1,2}|(ctrl|meta)\+(shift\+)?([rtwnlpqjhdfgsu0+=-]|plus|minus|Tab|PageUp|PageDown))$/i;

async function key(r, call, spec, origin, a) {
  if (SHORTCUTS.test(a.keys)) throw new ToolError('not_allowed', 'Shortcuts of the browser are not sent. Use navigate to reload.');
  const parts = a.keys === '+' ? ['+'] : a.keys.split('+');
  const name = parts.pop();
  const modifiers = parts.map((p) => p.toLowerCase().replace('control', 'ctrl').replace('cmd', 'meta'));
  if (!name || modifiers.some((m) => !['ctrl', 'shift', 'alt', 'meta'].includes(m))) throw new ToolError('invalid_argument', 'keys is one key, with ctrl, shift, alt or meta in front.');
  const k = { space: ' ', esc: 'Escape', escape: 'Escape', enter: 'Enter', return: 'Enter', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', plus: '+' }[name.toLowerCase()] ?? name;
  if ([...k].length > 1 && !/^(Escape|Enter|Tab|Backspace|Delete|Arrow(Up|Down|Left|Right)|Home|End|PageUp|PageDown)$/.test(k)) throw new ToolError('invalid_argument', `There is no key ${JSON.stringify(name)}.`);
  return withRef(r, call, origin, a.ref, async (f) => {
    const t = a.ref ? await r.page(call, f.origin, { cmd: 'describe', ref: a.ref, loose: true }, f.frame) : { description: 'the element with the focus' };
    await r.ask(call, spec, origin, { tool: 'key', target: t.description, value: `${a.keys}${a.repeat > 1 ? ` (${a.repeat} times)` : ''}${a.dialog === 'accept' ? ', accepts a dialog of the page' : ''}`, ...(f.frame && { frame: f.origin }) }, a.reason, f);
    const sent = await send(r, call, f, `key ${a.keys} to ${t.description}`, { cmd: 'key', ref: a.ref, fingerprint: t.fingerprint, key: k, modifiers, repeat: a.repeat ?? 1, accept: a.dialog === 'accept', promptText: a.prompt_text });
    await Promise.race([sleep(200), call.gone]);
    const seen = await effect(r, call, f, sent.id);
    call.sent.outcome = 'done';
    await r.frame(call, spec, origin, { label: `Key ${a.keys}`, at: null });
    return { key: a.keys, ...seen, observed: seen.observed || sent.defaults > 0, default_actions: sent.defaults };
  });
}

async function drag(r, call, spec, origin, a) {
  const ref = await refFor(r, call, origin, a);
  if (frameOfRef(ref) !== frameOfRef(a.to_ref)) throw new ToolError('not_supported', 'Both ends must be in the same frame.');
  return withRef(r, call, origin, ref, async (f) => {
    const from = await r.page(call, f.origin, { cmd: 'describe', ref }, f.frame);
    const to = await r.page(call, f.origin, { cmd: 'describe', ref: a.to_ref, loose: true }, f.frame);
    await r.ask(call, spec, origin, { tool: 'left_click_drag', target: from.description, value: `to ${to.description}`, ...(f.frame && { frame: f.origin }) }, a.reason, f);
    const sent = await send(r, call, f, `drag of ${from.description} to ${to.description}`, { cmd: 'drag', ref, fingerprint: from.fingerprint, to: a.to_ref, toPrint: to.fingerprint });
    await Promise.race([sleep(200), call.gone]);
    const seen = await effect(r, call, f, sent.id);
    call.sent.outcome = 'done';
    await r.frame(call, spec, origin, { label: `Drag ${from.description}`, at: f.frame ? null : sent.at });
    return { dragged: from.description, to: to.description, how: sent.how, accepted: sent.accepted, handled: sent.handled, ...seen };
  });
}

async function scroll(r, call, spec, origin, a) {
  return withRef(r, call, origin, a.ref, (f) => r.page(call, f.origin, { cmd: 'scroll', ref: a.ref, direction: a.direction, amount: a.amount ?? 300, to: a.to }, f.frame)).then(({ id, ...x }) => x);
}

async function scrollTo(r, call, spec, origin, a) {
  return withRef(r, call, origin, a.ref, (f) => r.page(call, f.origin, { cmd: 'scroll_to', ref: a.ref }, f.frame)).then(({ id, ...x }) => x);
}

async function pause(r, call, spec, origin, a) {
  await Promise.race([sleep(a.seconds * 1000), call.gone]);
  return { waited_s: (r.now() - call.since) / 1000 };
}

async function fill(r, call, spec, origin, a) {
  return withRef(r, call, origin, a.ref, async (f) => {
    const t = await r.page(call, f.origin, { cmd: 'describe', ref: a.ref, value: a.value }, f.frame);
    await r.ask(call, spec, origin, { tool: 'form_input', target: t.description, value: a.value, ...(f.frame && { frame: f.origin }) }, a.reason, f);
    const x = await send(r, call, f, `entry in ${t.description}`, { cmd: 'fill', ref: a.ref, fingerprint: t.fingerprint, value: a.value, commit: a.commit === true });
    call.sent.outcome = 'done';
    await r.frame(call, spec, origin, { label: `Fill ${t.description}`, at: f.frame ? null : x.at });
    return { field: t.description, set: true, dispatched: true, observed: true, changed: x.changed };
  });
}

async function fillMany(r, call, spec, origin, a) {
  const [first] = a.fields;
  if (a.fields.some((x) => frameOfRef(x.ref) !== frameOfRef(first.ref))) throw new ToolError('not_supported', 'All fields must be in the same frame.');
  return withRef(r, call, origin, first.ref, async (f) => {
    const fields = [];
    for (const x of a.fields) {
      const t = await r.page(call, f.origin, { cmd: 'describe', ref: x.ref, value: x.value }, f.frame);
      fields.push({ ref: x.ref, value: x.value, fingerprint: t.fingerprint, description: t.description });
    }
    await r.ask(call, spec, origin, { tool: 'form_fill', target: `${fields.length} fields`, value: fields.map((x) => `${x.description}: ${x.value}`).join('\n'), ...(f.frame && { frame: f.origin }) }, a.reason, f);
    const x = await send(r, call, f, `entries in ${fields.length} fields`, { cmd: 'fill_many', fields });
    call.sent.outcome = 'done';
    const set = x.set.map((i) => fields[i].description);
    if (x.failed !== undefined) throw Object.assign(new ToolError(x.code, `${fields[x.failed].description}: ${x.message} Set before that: ${set.join(', ') || 'none'}.`), { data: { set } });
    return { set, dispatched: true, observed: true };
  });
}

const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json', html: 'text/html', md: 'text/markdown', zip: 'application/zip' };

async function upload(r, call, spec, origin, a) {
  return withRef(r, call, origin, a.ref, async (f) => {
    const t = await r.page(call, f.origin, { cmd: 'upload_target', ref: a.ref }, f.frame);
    if (t.folder && a.paths.length !== 1) throw new ToolError('invalid_argument', 'This field takes one folder.');
    if (t.input && !t.multiple && !t.folder && a.paths.length > 1) throw new ToolError('invalid_argument', 'This field takes one file.');
    if (!r.folders.length) throw new ToolError('path_not_allowed', 'The user has not listed a folder for uploads in the sidebar.');
    const ask = async (type, data) => {
      const x = await Promise.race([r.api.host(type, { ...data, folders: r.folders }), call.gone]);
      if (x.code) throw new ToolError(x.code, x.message);
      return x;
    };
    // The helper resolves every path and answers only for files inside the folders of the user.
    const { files } = await ask('file_stat', { paths: a.paths, folder: t.folder === true });
    const total = files.reduce((s, x) => s + x.size, 0);
    if (total > LIMITS.uploadBytes || files.length > LIMITS.uploadFiles) throw new ToolError('too_large', `An upload takes at most ${LIMITS.uploadBytes / 1024 / 1024} MB and ${LIMITS.uploadFiles} files.`);
    if (!files.length) throw new ToolError('not_found', 'The folder is empty.');
    await r.ask(call, spec, origin, { tool: 'file_upload', target: t.description, value: files.map((x) => `${x.path} (${x.size} bytes)`).join('\n'), ...(f.frame && { frame: f.origin }) }, a.reason, f);
    const ready = [];
    for (const x of files) {
      const bytes = new Uint8Array(x.size);
      for (let at = 0; at < x.size; ) {
        const part = await ask('file_read', { path: x.path, stamp: x.stamp, offset: at, count: Math.min(LIMITS.uploadChunk, x.size - at) });
        const raw = Uint8Array.from(atob(part.data), (c) => c.charCodeAt(0));
        if (!raw.length) throw new ToolError('path_not_allowed', `${x.name} changed after the approval.`);
        bytes.set(raw, at);
        at += raw.length;
      }
      ready.push({ name: x.name, type: TYPES[x.name.split('.').pop().toLowerCase()] ?? '', bytes: bytes.buffer, relative: x.relative ?? null });
    }
    if ((await r.authorize(call, spec)) !== origin) throw new ToolError('origin_changed', 'The page changed its origin.');
    await r.authorizeFrame(call, origin, f.frame);
    const x = await send(r, call, f, `upload of ${files.length} files to ${t.description}`, { cmd: 'upload', ref: a.ref, fingerprint: t.fingerprint, files: ready });
    await Promise.race([sleep(200), call.gone]);
    const seen = await effect(r, call, f, x.id);
    call.sent.outcome = 'done';
    return { target: t.description, files: files.map(({ name, size }) => ({ name, size })), how: x.how, ...(x.how === 'drop' && { accepted: x.accepted, handled: x.handled }), ...seen, observed: x.set > 0 };
  });
}

// Navigation

/** An address that may be opened, or an error. A bare host becomes https, a local one http. */
export function address(text) {
  let s = text.trim();
  // A name with a dot, or localhost. Anything else is a scheme or nonsense.
  if (/^(localhost|[\w-]+(\.[\w-]+)+|\[::1\])(:\d+)?([/?#]|$)/i.test(s)) s = `${/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])([:/?#]|$)/i.test(s) ? 'http' : 'https'}://${s}`;
  if (!originOf(s) || new URL(s).username || new URL(s).password) throw new ToolError('invalid_argument', 'Only http and https addresses without a user name are opened.');
  return new URL(s).href;
}

/** Waits for the end of a load. */
export async function loaded(r, call, tabId) {
  const end = r.now() + LIMITS.loadMs;
  await Promise.race([sleep(250), call.gone]); // the old page still says complete for a moment
  let tab;
  while ((tab = await r.tab(tabId))?.status === 'loading' && r.now() < end) await Promise.race([sleep(100), call.gone]);
  return tab;
}

async function navigate(r, call, spec, origin, a) {
  const { tabs } = r.api.browser ?? {};
  let what;
  let go;
  // A page that asks before it is left would open a native dialog, which nothing here can answer.
  const leave = async () => {
    const x = await r.page(call, origin, { cmd: 'leave', accept: a.dialog === 'accept' });
    if (x.asks && a.dialog !== 'accept') throw new ToolError('not_allowed', 'The page asks before it is left, so it stays. Say dialog: accept to leave it anyway; the user sees that on the card.');
    return x;
  };
  if (a.url !== undefined) address(a.url); // a bad address is told first
  await leave();
  if (a.url !== undefined) {
    const url = address(a.url);
    const to = originOf(url);
    what = `opening ${plainUrl(url)}`;
    await r.ask(call, spec, origin, { tool: 'navigate', target: url, value: [to !== origin && `Leaves ${origin} for ${to}`, a.dialog === 'accept' && 'Leaves even if the page asks'].filter(Boolean).join('. ') || null }, a.reason);
    go = () => r.api.openUrl(call.tabId, url);
  } else {
    what = { back: 'going back', forward: 'going forward', reload: 'reload', hard_reload: 'reload without cache' }[a.history];
    await r.ask(call, spec, origin, { tool: 'navigate', target: `This tab: ${what}`, value: a.dialog === 'accept' ? 'Leaves even if the page asks' : null }, a.reason);
    go = call.tabId >= VIRTUAL ? () => r.api.history(call.tabId, a.history) : { back: () => tabs.goBack(call.tabId), forward: () => tabs.goForward(call.tabId), reload: () => tabs.reload(call.tabId), hard_reload: () => tabs.reload(call.tabId, { bypassCache: true }) }[a.history];
  }
  // The page may have changed its mind while the card was open.
  const { asks } = await leave();
  const before = { url: (await r.tab(call.tabId)).url, doc: (await r.page(call, origin, { cmd: 'place' })).id };
  r.sent(call, what);
  await Promise.race([go(), call.gone]).catch((e) => {
    if (e instanceof ToolError) throw e;
    r.notSent(call);
    throw new ToolError(a.history ? 'no_history' : 'load_failed', oneLine(e.message, 200));
  });
  call.session.current = call.tabId;
  if (a.wait === 'none') return { state: 'started', dispatched: true, observed: false };
  let tab = await loaded(r, call, call.tabId);
  call.sent.outcome = 'done';
  if (!tab) throw new ToolError('no_grant', 'The tab is closed.');
  if (tab.status === 'loading') return { state: 'still loading', dispatched: true, observed: false };
  const now = await r.authorize(call, spec);
  const place = await r.page(call, now, { cmd: 'place' }).catch((e) => {
    throw e.code === 'restricted_page' ? new ToolError('load_failed', 'Firefox shows an error page instead of the address.') : e;
  });
  if (['back', 'forward'].includes(a.history) && place.id === before.doc && tab.url === before.url) throw new ToolError('no_history', `There is no page to go ${a.history} to.`);
  await r.frame(call, spec, now, { label: a.url !== undefined ? `Open ${now}` : what, at: null });
  tab = await r.tab(call.tabId);
  return { state: 'loaded', dispatched: true, ...(asks && { dialogs: [{ kind: 'beforeunload', answer: 'accepted' }] }), observed: place.id !== before.doc || tab.url !== before.url, url: plainUrl(tab.url), title: oneLine(tab.title) };
}

/** The tab is with the user until they press Done or Cancel. The answer gives no right. */
async function requestUser(r, call, spec, origin, a) {
  const ms = (a.timeout_s ?? 180) * 1000;
  const tab = await r.tab(call.tabId);
  call.session.handover.add(call.tabId);
  call.state = 'with the user';
  const start = r.now();
  try {
    call.card = r.approvals.ask({ session: call.session.id, sessionLabel: call.session.label, tool: 'request_user', tabId: call.tabId, tabTitle: oneLine(tab?.title), origin, target: oneLine(a.message, 300), reason: '' }, { hiddenMs: ms, visibleMs: ms });
    r.onChange();
    const done = await Promise.race([call.card.answer, call.gone]);
    for (let c = call; c; c = c.parent) c.waited += r.now() - start;
    if (!done) return { answer: r.now() - start >= ms - 50 ? 'timed_out' : 'cancelled' };
  } finally {
    call.session.handover.delete(call.tabId);
  }
  const now = await r.authorize(call, spec);
  return { answer: 'done', note: 'The user says so. Read the page to see what is there now.', origin: now };
}

async function gif(r, call, spec, origin, a) {
  const at = [call.session.id, call.tabId];
  if (a.action === 'start') {
    if (call.private) throw new ToolError('not_allowed', 'A private tab is not recorded.');
    await r.ask(call, spec, origin, { tool: 'gif_creator', target: 'Record pictures of this tab before and after each action' }, a.reason);
    if (!(await r.api.hasAllUrls()) && !(await r.tab(call.tabId))?.active) throw new ToolError('permission_required', 'Bring the tab to the front, or allow screenshots in the sidebar.');
    r.gif.start(...at);
    try {
      await r.page(call, origin, { cmd: 'pill', kind: 'GIF' });
    } catch (e) {
      r.gif.clear(...at); // no recording without its mark in the page
      throw e;
    }
    await r.frame(call, spec, origin, null);
    return { recording: true, frames: r.gif.frames(...at) };
  }
  if (a.action === 'stop') r.gif.stop(...at, 'stopped');
  if (a.action === 'clear') r.gif.clear(...at);
  if (a.action !== 'export') return { recording: false, frames: r.gif.frames(...at) };
  return Promise.race([r.gif.export(...at, a), call.gone]);
}

const COMPUTER = { screenshot: look, left_click: click, right_click: click, middle_click: click, double_click: click, triple_click: click, hover, type, key, scroll, scroll_to: scrollTo, left_click_drag: drag, wait: pause };

export const pageTools = {
  list_frames: async (r, call, spec, origin) => ({ origin, frames: (await listFrames(r, call, origin)).map(({ frame, parent, origin: o, granted: g, name }) => ({ frame, parent, origin: o, granted: g, ...(name && { name }) })) }),
  read_page: readPage,
  get_page_text: pageText,
  find,
  find_text: findText,
  wait_for: waitFor,
  computer: (r, call, spec, origin, a) => COMPUTER[a.action](r, call, spec, origin, a),
  form_input: fill,
  form_fill: fillMany,
  file_upload: upload,
  navigate,
  request_user: requestUser,
  gif_creator: gif,
  get_selection: async (r, call, spec, origin) => ({ origin, ...(await r.page(call, origin, { cmd: 'selection', max: LIMITS.selectionChars })) }),
};
