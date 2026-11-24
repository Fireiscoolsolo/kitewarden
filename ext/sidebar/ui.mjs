// Shared by the parts of the sidebar: the port to the background page, real user gestures, and drawing.
import { hostPattern, originOf } from '../shared/protocol.mjs';

export const $ = (id) => document.getElementById(id);
export const ui = { state: null, chat: null, tabs: [], windowId: null };

export const port = browser.runtime.connect({ name: 'sidebar' });
const waiting = new Map();
let nextId = 1;

export function send(type, data = {}) {
  return new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    port.postMessage({ ...data, type, id });
  });
}

export function answered({ id, reply }) {
  waiting.get(id)?.(reply);
  waiting.delete(id);
}

export const say = (text) => ($('message').textContent = text);

export async function run(type, data, done = '') {
  const r = await send(type, data);
  say(r.error ? `${r.error.code}: ${r.error.message}` : done);
  return r;
}

/** Only real user gestures count. Page script cannot reach this document, and synthetic events are ignored. */
export function onPress(button, fn) {
  button.addEventListener('click', (e) => e.isTrusted && fn(e));
  return button;
}

export function el(tag, props = {}, ...children) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...children);
  return n;
}

export const button = (textContent, fn, className = '') => onPress(el('button', { textContent, className, type: 'button' }), fn);

const drawn = new Map();
/** Redraws a part only when its data changed, so that focus stays where the user put it. */
export function part(id, data, build) {
  const key = JSON.stringify(data);
  if (drawn.get(id) === key) return;
  drawn.set(id, key);
  $(id).replaceChildren(...build(data));
}

/** Fills a select and keeps the user's choice while it exists. */
export function options(id, pairs) {
  const keep = $(id).value;
  part(id, pairs, (list) => list.map(([value, textContent]) => el('option', { value, textContent })));
  if (pairs.some(([value]) => String(value) === keep)) $(id).value = keep;
}

export const current = () => ui.tabs.find((t) => t.active && t.windowId === ui.windowId) ?? null;

/** Asks Firefox for the site of the current tab, from this same click, and then goes on with the tab. */
export function withSite(then) {
  const tab = current();
  const origin = tab && originOf(tab.url);
  if (!origin) return say('This page cannot be attached.');
  browser.permissions.request({ origins: [hostPattern(origin)] }).then(
    (ok) => (ok ? then({ tabId: tab.id, origin }) : say('Firefox did not allow this site. Nothing was attached.')),
    (e) => say(e.message),
  );
}
