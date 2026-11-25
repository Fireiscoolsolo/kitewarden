// Injected on demand into the granted frames of a granted tab. Reads write nothing into the page. Only the add-on's own
// background page can send messages here, and each one names the origin that it expects.
(() => {
  if (globalThis.companion) return;
  globalThis.companion = true;

  const frame = browser.runtime.getFrameId(window);
  const id = crypto.randomUUID().slice(0, 8); // a ref names one element of one document and is never reused
  const refs = new Map();
  let refOf = new WeakMap();
  const everPassword = new WeakSet();
  let nextRef = 1;
  let covers = null;
  let watch = null;
  let epoch = 0; // an abort ends the loops that began before it

  const line = (s, max) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max)}…` : t;
  };
  const fail = (error, message) => {
    throw { error, message };
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Elements

  const ref = (el) => {
    let r = refOf.get(el);
    if (!r) {
      r = `ref_${frame ? `f${frame}_` : ''}${id}_${nextRef++}`;
      refOf.set(el, r);
      refs.set(r, new WeakRef(el));
    }
    return r;
  };

  const SECRET_AUTOCOMPLETE = /\b(current-password|new-password|one-time-code|cc-(number|csc|exp(-month|-year)?|name|type))\b/;
  const SECRET_NAME = /pass(word|code|phrase|wd)?\b|passwd|\botp\b|one.?time|verification.?code|security.?code|\b2fa\b|\bmfa\b|\bcvv?2?\b|\bcvc2?\b|card.?(number|no|num)\b|\biban\b|\bssn\b|\bpin\b|\bsecret\b/i;

  function isSecret(el) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
    if (el.type === 'password') everPassword.add(el);
    if (everPassword.has(el) || SECRET_AUTOCOMPLETE.test(el.autocomplete)) return true;
    const masked = getComputedStyle(el).getPropertyValue('-webkit-text-security');
    if (masked && masked !== 'none') return true;
    const words = [el.name, el.id, el.getAttribute('aria-label'), el.placeholder, ...[...(el.labels ?? [])].map((l) => l.textContent)];
    return SECRET_NAME.test(words.join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' '));
  }

  const INPUT_ROLES = { button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox', file: 'button', color: 'button' };
  const TAG_ROLES = { BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button', OPTION: 'option', NAV: 'navigation', MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo', ASIDE: 'complementary', FORM: 'form', IMG: 'image', UL: 'list', OL: 'list', LI: 'listitem', TABLE: 'table', TR: 'row', TD: 'cell', TH: 'columnheader', DIALOG: 'dialog', IFRAME: 'frame', FRAME: 'frame', OBJECT: 'frame', EMBED: 'frame' };
  const INTERACTIVE = new Set(['button', 'link', 'checkbox', 'radio', 'slider', 'spinbutton', 'searchbox', 'textbox', 'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch', 'tab', 'treeitem', 'gridcell']);
  const NAME_FROM_TEXT = new Set(['button', 'link', 'heading', 'option', 'menuitem', 'tab', 'switch', 'treeitem', 'checkbox', 'radio']);
  const FRAMES = ['IFRAME', 'FRAME', 'OBJECT', 'EMBED'];

  function roleOf(el) {
    const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0];
    if (FRAMES.includes(el.tagName)) return 'frame';
    if (explicit && explicit !== 'presentation' && explicit !== 'none') return explicit;
    if (el instanceof HTMLInputElement) return INPUT_ROLES[el.type] ?? 'textbox';
    if ((el.tagName === 'A' || el.tagName === 'AREA') && el.hasAttribute('href')) return 'link';
    if (/^H[1-6]$/.test(el.tagName)) return 'heading';
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return 'textbox';
    return TAG_ROLES[el.tagName] ?? (el.hasAttribute('onclick') || el.draggable && el.getAttribute('draggable') === 'true' || el.tabIndex >= 0 && el.hasAttribute('tabindex') ? 'clickable' : null);
  }

  const interactive = (role) => INTERACTIVE.has(role) || role === 'clickable';

  /** Text of a label without that of the control inside it: the options of a list are not its name. */
  function labelText(label, control) {
    let text = '';
    const walk = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) if (!control.contains(walk.currentNode)) text += walk.currentNode.data;
    return text;
  }

  function nameOf(el, role) {
    const by = el.getAttribute('aria-labelledby')?.split(/\s+/).map((i) => el.getRootNode().getElementById?.(i)?.textContent ?? '').join(' ');
    const label = line(by, 120) || line(el.getAttribute('aria-label'), 120);
    if (label) return label;
    if (el instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(el.type)) return line(el.value || el.type, 120);
    if ('labels' in el && el.labels?.length) return line([...el.labels].map((l) => labelText(l, el)).join(' '), 120);
    const alt = line(el.getAttribute('alt') || el.getAttribute('placeholder'), 120);
    if (alt) return alt;
    if (NAME_FROM_TEXT.has(role) || role === 'clickable') return line(el.innerText ?? el.textContent, 120) || line(el.querySelector('img[alt]')?.alt, 120) || line(el.title, 120);
    return line(el.title, 120);
  }

  function statesOf(el, role) {
    const s = [];
    if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') s.push('disabled');
    if (role === 'checkbox' || role === 'radio' || role === 'switch') s.push(el.checked || el.getAttribute('aria-checked') === 'true' ? 'checked' : 'unchecked');
    if (el.getAttribute('aria-expanded')) s.push(el.getAttribute('aria-expanded') === 'true' ? 'expanded' : 'collapsed');
    if (el.matches(':required')) s.push('required');
    if (role === 'heading') s.push(`level ${el.getAttribute('aria-level') ?? el.tagName.slice(1)}`);
    return s;
  }

  function valueOf(el) {
    if (isSecret(el)) return '[secret]';
    if (el instanceof HTMLSelectElement) return line([...el.selectedOptions].map((o) => o.text).join(', '), 120);
    if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !(INPUT_ROLES[el.type] === 'button') && !['checkbox', 'radio', 'hidden'].includes(el.type))) return line(el.value, 200);
    return '';
  }

  /** Address of a link without query and fragment, which often carry credentials. */
  function linkOf(el) {
    const a = el.closest('a[href], area[href]');
    if (!a) return null;
    try {
      const u = new URL(a.href);
      return { origin: u.origin, protocol: u.protocol, text: /^https?:$/.test(u.protocol) ? u.origin + u.pathname + (u.search ? '?…' : '') : u.protocol, download: a.hasAttribute('download') };
    } catch {
      return { origin: null, protocol: '', text: 'invalid address', download: false };
    }
  }

  const shadowOf = (el) => (typeof el.openOrClosedShadowRoot === 'object' ? el.openOrClosedShadowRoot : el.shadowRoot);
  const parentOf = (n) => n.assignedSlot ?? n.parentElement ?? (n.getRootNode() instanceof ShadowRoot ? n.getRootNode().host : null);
  const own = (n) => n === pill || n === covers;

  function childrenOf(el) {
    if (el.tagName === 'SLOT') {
      const assigned = el.assignedNodes();
      if (assigned.length) return assigned;
    }
    return [...(shadowOf(el) ?? el).childNodes];
  }

  /** Every element as rendered, through shadow roots, without hidden parts. */
  function* rendered(root = document.body) {
    if (!root || own(root) || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD'].includes(root.tagName)) return;
    const cs = getComputedStyle(root);
    if (cs.display === 'none' || cs.opacity === '0') return;
    if (cs.visibility === 'visible') yield root;
    for (const c of childrenOf(root)) if (c instanceof Element) yield* rendered(c);
  }

  const onScreen = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };

  // Reading

  /** The modal, or the layer over the middle of the page, that takes its clicks. */
  function overlay() {
    const modal = [...document.querySelectorAll('dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]')].findLast((e) => e.checkVisibility() && onScreen(e));
    if (modal) return modal;
    let e = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    for (; e && e !== document.body && e !== document.documentElement; e = parentOf(e)) {
      const r = e.getBoundingClientRect();
      if (!own(e) && getComputedStyle(e).position === 'fixed' && r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9) return e;
    }
    return null;
  }

  function snapshot({ filter, maxChars, maxNodes, root = null, depthLimit = 100, viewport = false, collect = null }) {
    const out = [];
    const frames = []; // { line, frame, depth }: where the outline of a frame goes
    let nodes = 0;
    let full = 0;
    let size = 0;
    const emit = (depth, s) => {
      const l = '  '.repeat(Math.min(depth, 20)) + s;
      full += l.length + 1;
      if (full > maxChars) return;
      out.push(l);
      size = full;
    };
    const walk = (node, depth, inName, style) => {
      if (++nodes > maxNodes || depth > depthLimit) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const t = line(node.data, 500);
        if (t && !inName && filter === 'all' && style.visibility === 'visible') emit(depth, `- text ${JSON.stringify(t)}`);
        return;
      }
      if (!(node instanceof Element) || own(node) || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD'].includes(node.tagName)) return;
      const cs = getComputedStyle(node);
      if (cs.display === 'none' || cs.opacity === '0') return;
      const visible = cs.visibility === 'visible' && (!viewport || onScreen(node));
      const role = roleOf(node);
      let d = depth;
      let named = inName;
      if (role && visible && (filter === 'all' || interactive(role) || role === 'frame')) {
        const name = nameOf(node, role);
        const states = statesOf(node, role);
        const value = valueOf(node);
        const link = role === 'link' ? linkOf(node) : null;
        if (interactive(role)) collect?.push({ el: node, role, name });
        emit(depth, [`- ${role}`, name && JSON.stringify(name), states.length && `[${states.join(', ')}]`, value && `value=${JSON.stringify(value)}`, link && `-> ${link.text}`, interactive(role) && `[${ref(node)}]`].filter(Boolean).join(' '));
        d = depth + 1;
        named = inName || NAME_FROM_TEXT.has(role) || role === 'clickable';
      }
      if (role === 'frame') {
        const f = browser.runtime.getFrameId(node);
        if (f > 0 && visible) frames.push({ line: out.length, frame: f, depth: d });
        return;
      }
      // Form values are printed above, so these are not walked.
      if (['textbox', 'searchbox', 'image'].includes(role) && !node.isContentEditable) return;
      if (node instanceof HTMLSelectElement) return;
      for (const c of childrenOf(node)) walk(c, d, named, cs);
    };
    const start = root ? target(root) : document.body;
    if (!root && !collect && filter === 'all') {
      const over = overlay();
      if (over) {
        const buttons = [...rendered(over)].filter((e) => ['button', 'link'].includes(roleOf(e))).slice(0, 12);
        emit(0, `- overlay ${JSON.stringify(nameOf(over, 'dialog') || line(over.innerText, 300))} takes the clicks of this page; what is behind it is blocked: ${buttons.map((b) => `${JSON.stringify(nameOf(b, 'button'))} [${ref(b)}]`).join(', ') || 'no buttons'}`);
      }
    }
    if (start) walk(start, 0, false, getComputedStyle(start));
    if (nodes > maxNodes) emit(0, `- (stopped after ${maxNodes} nodes)`);
    return { lines: out, frames, truncated: full > size, fullChars: full, ready: document.readyState };
  }

  /** Visible text, the main article first. Values of fields are no text. */
  function text({ root, links }) {
    const article = root ? target(root) : [...document.querySelectorAll('article, main, [role=main]')].filter((e) => e.checkVisibility()).sort((a, b) => b.innerText.length - a.innerText.length)[0];
    const from = article && (root || article.innerText.length > 200) ? article : document.body;
    const parts = [];
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return void parts.push(node.data.replace(/\s+/g, ' '));
      if (!(node instanceof Element) || own(node) || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT', ...FRAMES].includes(node.tagName)) return;
      const cs = getComputedStyle(node);
      if (cs.display === 'none' || cs.visibility !== 'visible' || cs.opacity === '0') return;
      const block = !['inline', 'contents', 'inline-block'].includes(cs.display) || node.tagName === 'BR';
      if (block) parts.push('\n');
      childrenOf(node).forEach(walk);
      if (block) parts.push('\n');
    };
    if (from) walk(from);
    const all = links && from ? [...rendered(from)].filter((e) => e.tagName === 'A').map((a) => ({ text: line(a.innerText, 100), link: linkOf(a) })).filter((l) => l.link && /^https?:$/.test(l.link.protocol)).slice(0, 200).map((l) => `${l.text} -> ${l.link.text}`) : [];
    return { title: line(document.title, 200), source: root ? 'element' : from === document.body ? 'body' : 'article', text: parts.join('').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), links: all };
  }

  /** A selector that tests the value of a field would tell the value of a secret one, so none may. */
  function bySelector(selector) {
    if (selector.includes('\\') || /\[[^\]]*value/i.test(selector)) fail('invalid_argument', 'A selector may not test values or use escapes.');
    try {
      document.createDocumentFragment().querySelector(selector);
    } catch {
      fail('invalid_argument', 'That is not a CSS selector.');
    }
    return [...rendered()].filter((e) => e.matches(selector));
  }

  function search({ query, selector, limit }) {
    const words = query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    const hits = [];
    for (const el of selector !== undefined ? bySelector(selector) : rendered()) {
      const role = roleOf(el);
      if (selector === undefined && (!role || role === 'frame' || !(interactive(role) || NAME_FROM_TEXT.has(role)))) continue;
      const name = nameOf(el, role ?? '');
      const kind = role ?? el.tagName.toLowerCase();
      let score = 0;
      if (selector === undefined) {
        const near = `${kind} ${name} ${el.getAttribute('title') ?? ''} ${el.getAttribute('placeholder') ?? ''} ${el.id} ${el.getAttribute('name') ?? ''}`.toLowerCase();
        score = words.filter((w) => near.includes(w)).length + (name.toLowerCase().includes(query.toLowerCase()) ? words.length + 1 : 0) + (name.toLowerCase() === query.toLowerCase() ? 5 : 0);
        if (!score) continue;
      }
      hits.push({ el, kind, name, score });
    }
    if (selector === undefined) hits.sort((a, b) => b.score - a.score);
    return { total: hits.length, hits: hits.slice(0, limit).map(({ el, kind, name, score }) => ({ ref: ref(el), role: kind, name, score, off_screen: !onScreen(el) })) };
  }

  function findText({ text: wanted }) {
    const body = line(document.body?.innerText, 2e6).toLowerCase();
    const needle = line(wanted, 500).toLowerCase();
    const at = [];
    for (let i = body.indexOf(needle); i >= 0 && at.length < 10_000; i = body.indexOf(needle, i + needle.length)) at.push(i);
    const plain = line(document.body?.innerText, 2e6);
    return { count: at.length, snippets: at.slice(0, 5).map((i) => plain.slice(Math.max(0, i - 60), i + needle.length + 60)) };
  }

  const shows = (t) => (document.body?.innerText ?? '').includes(t);

  function check(m) {
    if (m.text !== undefined) return { met: shows(m.text) };
    if (m.gone !== undefined) return { met: !shows(m.gone) };
    const el = refs.get(m.ref)?.deref();
    const there = Boolean(el?.isConnected);
    const visible = there && el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
    return { met: m.state === 'gone' ? !there : m.state === 'hidden' ? !visible : visible };
  }

  /** Frames of this document with their place in it, in CSS pixels. */
  const children = () => ({
    children: [...rendered()].filter((e) => FRAMES.includes(e.tagName)).map((e) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return { frame: browser.runtime.getFrameId(e), src: originText(e), name: line(e.title || e.name, 80), left: r.left + e.clientLeft + parseFloat(s.paddingLeft), top: r.top + e.clientTop + parseFloat(s.paddingTop), width: r.width, height: r.height };
    }).filter((c) => c.frame > 0),
  });
  const originText = (e) => {
    try {
      return new URL(e.src || e.data || 'about:blank', location.href).origin;
    } catch {
      return 'null';
    }
  };

  const marks = () => ({
    width: innerWidth,
    height: innerHeight,
    marks: [...rendered()].filter((e) => interactive(roleOf(e)) && onScreen(e)).slice(0, 100).map((e) => {
      const r = e.getBoundingClientRect();
      return { ref: ref(e), role: roleOf(e), name: nameOf(e, roleOf(e)), left: r.left, top: r.top, width: r.width, height: r.height };
    }),
  });

  const place = () => ({ width: innerWidth, height: innerHeight, scroll: [scrollX, scrollY, devicePixelRatio] });

  /** The deepest element at a point in CSS pixels, or the frame that has it. */
  function hitTest({ x, y }) {
    let el = document.elementFromPoint(x, y);
    while (el && shadowOf(el)) {
      const inner = shadowOf(el).elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    if (!el || own(el)) fail('not_actionable', `There is nothing at ${Math.round(x)},${Math.round(y)}.`);
    if (FRAMES.includes(el.tagName)) {
      const c = children().children.find((k) => k.frame === browser.runtime.getFrameId(el));
      return { frame: c?.frame ?? -1, x: x - (c?.left ?? 0), y: y - (c?.top ?? 0) };
    }
    for (let e = el; e; e = parentOf(e)) if (interactive(roleOf(e) ?? '')) return { ref: ref(e) };
    return { ref: ref(el) };
  }

  // Acting. Every event here is synthetic; what the page did with it is looked up afterwards.

  function target(refName) {
    const el = refs.get(refName)?.deref();
    if (!el || !el.isConnected) fail('stale_ref', 'That element is gone. Read the page again.');
    return el;
  }

  function describe(el) {
    const role = roleOf(el) ?? el.tagName.toLowerCase();
    const link = linkOf(el);
    const name = nameOf(el, role);
    const form = el instanceof HTMLButtonElement || el instanceof HTMLInputElement ? el.form : null;
    return {
      description: `${role} ${JSON.stringify(name)}`,
      link: link?.text ?? null,
      download: link?.download ?? false,
      // The approval is for this element as the user saw it.
      fingerprint: JSON.stringify([el.tagName, role, name, el.getAttribute('type'), link && el.closest('a[href], area[href]').href, form?.getAttribute('action') ?? null, form?.getAttribute('method') ?? null]),
    };
  }

  /** The element of an approved action, if it still is the one that the user saw. */
  function approved(m, name = 'ref', print = 'fingerprint') {
    const el = target(m[name]);
    if (describe(el).fingerprint !== m[print]) fail('stale_ref', 'The element changed after the user approved it.');
    return el;
  }

  function checkTarget(el) {
    const link = linkOf(el);
    if (link && !/^https?:$/.test(link.protocol)) fail('not_allowed', `Links with ${link.protocol || 'an invalid address'} are not clicked.`);
    if (el instanceof HTMLInputElement && el.type === 'file') fail('not_allowed', 'File pickers are not opened by a click. Use file_upload.');
    if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true' || el.closest('[inert]')) fail('not_actionable', 'The element is disabled.');
    if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) fail('not_actionable', 'The element is hidden.');
  }

  /** Scrolls it into view and returns the point and the innermost element there, or says what covers it. */
  function pointOf(el) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) fail('not_actionable', 'The element has no size.');
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const hit = el.getRootNode().elementFromPoint(x, y);
    const label = hit?.closest('label');
    if (!hit || !(el === hit || el.contains(hit) || (hit.contains(el) && !interactive(roleOf(hit)) && shadowOf(hit)) || label?.control === el)) {
      fail('covered', hit ? `Another element covers it: ${describe(hit).description} [${ref(hit)}]` : 'It is outside the visible area.');
    }
    return { x, y, hit: el.contains(hit) ? hit : el, at: placeOf(r) };
  }

  /** Middle of a rectangle as parts of the visible area, for the click mark of a GIF. */
  const placeOf = (r) => ({ x: (r.left + r.width / 2) / innerWidth, y: (r.top + r.height / 2) / innerHeight });

  /** Watches what the page does from here on. Our own nodes do not count. */
  function observe() {
    watch?.disconnect();
    const seen = { changed: false, url: location.href, focus: document.activeElement };
    watch = new MutationObserver((list) => {
      if (list.some((r) => r.type !== 'childList' || [...r.addedNodes, ...r.removedNodes].some((n) => !own(n) && !gone.has(n)))) seen.changed = true;
    });
    watch.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    watch.seen = seen;
  }

  // The page's own dialogs would block this script. They are answered while an action runs and reported.
  let dialogs = null;

  function guardDialogs(answer, textAnswer) {
    const w = window.wrappedJSObject;
    if (!w || dialogs || typeof exportFunction !== 'function') return;
    leaving = answer;
    const seen = [];
    const saved = {};
    const put = (name, fn) => {
      saved[name] = w[name];
      w[name] = exportFunction(fn, window);
    };
    put('alert', (m) => void seen.push({ kind: 'alert', text: line(m, 200), answer: 'closed' }));
    put('confirm', (m) => (seen.push({ kind: 'confirm', text: line(m, 200), answer: answer ? 'accepted' : 'cancelled' }), answer));
    put('prompt', (m) => (seen.push({ kind: 'prompt', text: line(m, 200), answer: answer ? 'accepted' : 'cancelled' }), answer ? textAnswer : null));
    dialogs = { seen, saved };
  }

  // A page may ask before it is left. Native dialogs cannot be answered, so the question is put to the page beforehand, and
  // its own handlers do not see the real event when the user accepted.
  let leaving = false;
  addEventListener('beforeunload', (e) => leaving && e.stopImmediatePropagation(), true);

  /** Whether the page would ask before it is left. With `accept` it will not. */
  function leave({ accept }) {
    leaving = false;
    const e = document.createEvent('BeforeUnloadEvent');
    e.initEvent('beforeunload', false, true);
    window.dispatchEvent(e);
    const asks = e.defaultPrevented || e.returnValue !== '';
    leaving = asks && accept;
    return { asks };
  }

  function releaseDialogs() {
    leaving = false;
    const seen = dialogs?.seen ?? [];
    if (dialogs) for (const [name, fn] of Object.entries(dialogs.saved)) window.wrappedJSObject[name] = fn;
    dialogs = null;
    return seen;
  }

  const mods = (m) => ({ ctrlKey: m.includes('ctrl'), shiftKey: m.includes('shift'), altKey: m.includes('alt'), metaKey: m.includes('meta') });
  const BUTTON = { left: 0, middle: 1, right: 2 };

  function pointer(m) {
    const el = approved(m);
    checkTarget(el);
    const { x, y, hit, at } = pointOf(el);
    observe();
    guardDialogs(m.accept, m.promptText ?? '');
    const button = BUTTON[m.button];
    const held = [1, 4, 2][button];
    const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button, ...mods(m.modifiers) };
    const mouse = { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    for (let n = 1; n <= m.count; n++) {
      const down = hit.dispatchEvent(new PointerEvent('pointerdown', { ...mouse, buttons: held })) && hit.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: held, detail: n }));
      if (down && n === 1 && button === 0) (hit.closest('a, button, input, select, textarea, [tabindex], [contenteditable]') ?? el).focus?.({ preventScroll: true });
      watch.seen.focus = document.activeElement; // that was us
      hit.dispatchEvent(new PointerEvent('pointerup', mouse));
      hit.dispatchEvent(new MouseEvent('mouseup', { ...init, detail: n }));
      if (button === 0 && !m.modifiers.length) hit.click();
      else hit.dispatchEvent(new PointerEvent(button === 0 ? 'click' : 'auxclick', { ...mouse, detail: n }));
      if (n === 2 && button === 0) hit.dispatchEvent(new MouseEvent('dblclick', { ...init, detail: 2 }));
    }
    if (button === 2) hit.dispatchEvent(new PointerEvent('contextmenu', mouse));
    if (m.count === 3 && button === 0) getSelection().selectAllChildren(hit.closest('p, li, td, pre, h1, h2, h3, div') ?? hit);
    return { at };
  }

  /** For input from outside the page: the checks of an action and the point of the element. Nothing is dispatched. */
  function aim(m) {
    const el = m.fingerprint === undefined ? target(m.ref) : approved(m);
    if (!m.loose) checkTarget(el);
    const { x, y, hit, at } = pointOf(el);
    observe();
    // Firefox itself moves the focus to this one, so that is no effect of the page.
    watch.seen.expected = hit.closest('a, button, input, select, textarea, [tabindex], [contenteditable]') ?? document.body;
    return { x, y, at, screen: { x: window.mozInnerScreenX, y: window.mozInnerScreenY, ratio: devicePixelRatio }, shown: document.visibilityState === 'visible', focused: document.hasFocus() };
  }

  let field = null;
  const fieldSize = () => (field?.isContentEditable ? field.textContent.length : field?.value?.length ?? 0);

  /** The field for keys from outside the page, with the checks of typing. */
  function fieldFor(m) {
    field = focusField(m) ?? document.body;
    if (m.typing) {
      if (!isText(field)) fail('not_actionable', 'No field has the focus.');
      checkField(field);
    } else if (isSecret(field) && !['Tab', 'Escape'].includes(m.key)) fail('secret_field', 'Keys go to no password, code or payment field.');
    observe();
    return { size: fieldSize() };
  }

  let hovered = null;

  function hover(m) {
    const el = target(m.ref);
    const { x, y, hit, at } = pointOf(el);
    observe();
    const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...mods(m.modifiers) };
    const path = (e) => (e ? [e, ...path(parentOf(e))] : []);
    const now = path(hit);
    const before = path(hovered?.isConnected ? hovered : null);
    const fire = (n, Kind, type, bubbles) => n.dispatchEvent(new Kind(type, { ...init, bubbles, relatedTarget: null }));
    if (before.length && before[0] !== hit) {
      fire(before[0], PointerEvent, 'pointerout', true);
      fire(before[0], MouseEvent, 'mouseout', true);
      for (const e of before) if (!now.includes(e)) for (const [K, t] of [[PointerEvent, 'pointerleave'], [MouseEvent, 'mouseleave']]) fire(e, K, t, false);
    }
    fire(hit, PointerEvent, 'pointerover', true);
    for (const e of now.reverse()) if (!before.includes(e)) fire(e, PointerEvent, 'pointerenter', false);
    fire(hit, PointerEvent, 'pointermove', true);
    fire(hit, MouseEvent, 'mouseover', true);
    for (const e of now) if (!before.includes(e)) fire(e, MouseEvent, 'mouseenter', false);
    fire(hit, MouseEvent, 'mousemove', true);
    hovered = hit;
    return { at };
  }

  const isChoice = (el) => el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio');
  const isText = (el) => el instanceof HTMLTextAreaElement || el?.isContentEditable || (el instanceof HTMLInputElement && !['button', 'submit', 'reset', 'image', 'hidden', 'checkbox', 'radio', 'file', 'range', 'color'].includes(el.type));

  function checkField(el) {
    if (isSecret(el)) fail('secret_field', 'Passwords, codes and payment fields are filled in by the user only.');
    checkTarget(el);
    if (!(isText(el) || isChoice(el) || el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && ['range', 'color'].includes(el.type)))) fail('not_actionable', 'That is not a form field.');
    if (el.readOnly) fail('not_actionable', 'The field is read-only.');
  }

  const announce = (el) => {
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  /** Options of a list by value, exact label, label without case, then the only one that holds the text. */
  function optionFor(el, value) {
    const all = [...el.options];
    const label = (o) => line(o.label, 200);
    const low = value.toLowerCase();
    const hits = [all.filter((o) => o.value === value), all.filter((o) => label(o) === value), all.filter((o) => label(o).toLowerCase() === low), all.filter((o) => label(o).toLowerCase().includes(low))].find((h) => h.length) ?? [];
    if (hits.length !== 1) fail(hits.length ? 'ambiguous' : 'no_match', `Options: ${(hits.length ? hits : all).slice(0, 50).map((o) => JSON.stringify(label(o))).join(', ')}`);
    if (hits[0].disabled) fail('not_actionable', 'That option is disabled.');
    return hits[0];
  }

  /** The values of one field as a check without any write. */
  function checkValue(el, value) {
    checkField(el);
    if (isChoice(el) && value !== 'true' && value !== 'false') fail('invalid_argument', 'A checkbox or radio button takes "true" or "false".');
    if (el instanceof HTMLSelectElement) for (const v of el.multiple ? value.split('\n') : [value]) optionFor(el, v);
  }

  function fill(el, value, commit) {
    checkValue(el, value);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const at = placeOf(el.getBoundingClientRect());
    const done = (changed) => {
      if (commit) el.blur();
      return { changed, at };
    };
    if (isChoice(el)) {
      const changed = el.checked !== (value === 'true');
      if (changed) el.click();
      if (el.checked !== (value === 'true')) fail('not_taken', 'The page did not keep the choice.');
      return done(changed);
    }
    if (el instanceof HTMLSelectElement) {
      const want = (el.multiple ? value.split('\n') : [value]).map((v) => optionFor(el, v));
      const before = [...el.selectedOptions];
      if (el.multiple) for (const o of el.options) o.selected = want.includes(o);
      else want[0].selected = true;
      const changed = before.length !== want.length || before.some((o) => !want.includes(o));
      if (changed) announce(el);
      if (!want.every((o) => o.selected)) fail('not_taken', 'The page did not keep the choice.');
      return done(changed);
    }
    el.focus({ preventScroll: true });
    if (el.isContentEditable) {
      getSelection().selectAllChildren(el);
      document.execCommand('insertText', false, value);
      if (line(el.innerText, 1e6) !== line(value, 1e6)) fail('not_taken', 'The editor did not keep the text.');
      return done(true);
    }
    const changed = el.value !== value;
    el.value = value;
    if (el.value !== value) fail('not_taken', 'The field does not accept this value.');
    if (changed) announce(el);
    if (el.value !== value) fail('not_taken', 'The page changed the value.');
    return done(changed);
  }

  /** The field that keys go to. */
  function focusField(m) {
    if (m.ref) {
      const el = approved(m);
      checkField(el);
      el.focus({ preventScroll: true });
      return el;
    }
    let el = document.activeElement;
    while (el && shadowOf(el)?.activeElement) el = shadowOf(el).activeElement;
    return el;
  }

  /** Inserts at the caret. Returns the number of characters that arrived. */
  function insert(el, s) {
    const size = () => (el.isContentEditable ? el.textContent.length : el.value.length);
    const before = size();
    if (!document.execCommand('insertText', false, s) && !el.isContentEditable) {
      const at = el.selectionStart ?? el.value.length;
      try {
        el.setRangeText(s, at, el.selectionEnd ?? at, 'end');
      } catch {
        el.value += s; // number and date fields have no caret
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: s }));
    }
    return size() - before;
  }

  async function type(m) {
    const el = focusField(m);
    if (!isText(el)) fail('not_actionable', 'No field has the focus.');
    checkField(el);
    observe();
    if (!m.slowly) {
      const n = insert(el, m.text);
      if (n <= 0 && m.text) fail('not_taken', 'The field did not take the text.');
      return { arrived: n };
    }
    const mine = epoch;
    let n = 0;
    for (const c of m.text) {
      if (epoch !== mine || !el.isConnected) break;
      keyEvents(el, c, [], () => (n += insert(el, c)));
      await sleep(Math.min(30, 8000 / m.text.length));
    }
    return { arrived: n, cut: epoch !== mine };
  }

  /** keydown, the default action unless the page cancels it, keyup. Returns whether the default was done. */
  function keyEvents(el, key, modifiers, action) {
    const init = { key, code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true, composed: true, view: window, ...mods(modifiers) };
    const go = el.dispatchEvent(new KeyboardEvent('keydown', init));
    const printable = [...key].length === 1 || key === 'Enter';
    const press = go && printable && !modifiers.includes('ctrl') ? el.dispatchEvent(new KeyboardEvent('keypress', init)) : go;
    const did = go && press && action ? action() !== false : false;
    if (el.isConnected) el.dispatchEvent(new KeyboardEvent('keyup', init));
    return did;
  }

  const tabbable = () => [...rendered()].filter((e) => e.tabIndex >= 0 && !e.matches(':disabled') && e.matches('a[href], button, input, select, textarea, summary, [tabindex], [contenteditable]'));

  function moveCaret(el, key) {
    const n = el.value.length;
    const at = el.selectionEnd ?? n;
    const to = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: n }[key];
    el.setSelectionRange(Math.max(0, Math.min(n, to)), Math.max(0, Math.min(n, to)));
  }

  function erase(el, forward) {
    if (document.execCommand(forward ? 'forwardDelete' : 'delete')) return;
    const a = el.selectionStart;
    const b = el.selectionEnd;
    el.setRangeText('', a === b && !forward ? Math.max(0, a - 1) : a, a === b && forward ? b + 1 : b, 'end');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: forward ? 'deleteContentForward' : 'deleteContentBackward' }));
  }

  /** What Firefox would do with a real key, from a fixed list. False: nothing is emulated. */
  function keyDefault(el, key, modifiers) {
    const field = isText(el);
    if (modifiers.includes('ctrl') || modifiers.includes('meta')) {
      if (key.toLowerCase() !== 'a') return false;
      if (field && el.select) el.select();
      else getSelection().selectAllChildren(field ? el : document.body);
      return true;
    }
    if (key === 'Tab') {
      const list = tabbable();
      const i = list.indexOf(el);
      const next = list[(i + (modifiers.includes('shift') ? -1 : 1) + list.length) % list.length];
      next?.focus();
      return Boolean(next);
    }
    if (key === 'Enter') {
      if (el instanceof HTMLTextAreaElement || el.isContentEditable) return insert(el, '\n') !== 0;
      if (el.matches('a[href], button, summary, [role=button], input[type=submit], input[type=button]')) return el.click(), true;
      const f = el.form;
      if (!f) return false;
      const button = f.querySelector('button:not([type]), button[type=submit], input[type=submit], input[type=image]');
      if (button) return button.disabled ? false : (button.click(), true);
      f.requestSubmit();
      return true;
    }
    if (key === ' ' && !field) {
      if (el.matches('button, summary, input[type=checkbox], input[type=radio], input[type=button], input[type=submit], [role=button], [role=checkbox]')) return el.click(), true;
      scrollBy({ top: innerHeight * 0.8, behavior: 'instant' });
      return true;
    }
    if (key === 'Escape') {
      const d = [...document.querySelectorAll('dialog[open]')].at(-1);
      if (!d) return false;
      if (d.dispatchEvent(new Event('cancel', { cancelable: true }))) d.close();
      return true;
    }
    if (key === 'Backspace' || key === 'Delete') return field ? (erase(el, key === 'Delete'), true) : false;
    if (/^Arrow|^Home$|^End$/.test(key)) {
      if (el instanceof HTMLSelectElement) {
        const i = { ArrowUp: el.selectedIndex - 1, ArrowDown: el.selectedIndex + 1, Home: 0, End: el.options.length - 1 }[key];
        if (i === undefined || i < 0 || i >= el.options.length) return false;
        el.selectedIndex = i;
        announce(el);
        return true;
      }
      if (el instanceof HTMLInputElement && ['range', 'number'].includes(el.type)) {
        if (/Up|Right/.test(key)) el.stepUp();
        else if (/Down|Left/.test(key)) el.stepDown();
        else return false;
        announce(el);
        return true;
      }
      if (field && el.setSelectionRange && /Left|Right|Home|End/.test(key)) return moveCaret(el, key), true;
      if (field) return false;
      const to = { ArrowDown: 40, ArrowUp: -40, Home: -1e7, End: 1e7 }[key];
      if (to) scrollBy({ top: to, behavior: 'instant' });
      return Boolean(to);
    }
    if (key === 'PageDown' || key === 'PageUp') return scrollBy({ top: innerHeight * (key === 'PageDown' ? 0.9 : -0.9), behavior: 'instant' }), true;
    if ([...key].length === 1 && field) return insert(el, key) !== 0;
    return false;
  }

  async function key(m) {
    let el = m.ref ? approved(m) : focusField({});
    if (m.ref) el.focus?.({ preventScroll: true });
    el ??= document.body;
    observe();
    guardDialogs(m.accept, m.promptText ?? '');
    const mine = epoch;
    let did = 0;
    for (let n = 0; n < m.repeat && epoch === mine; n++) {
      const now = el.isConnected ? el : focusField({}) ?? document.body;
      if (isSecret(now) && !['Tab', 'Escape'].includes(m.key)) fail('secret_field', 'Keys go to no password, code or payment field.');
      if (keyEvents(now, m.key, m.modifiers, () => keyDefault(now, m.key, m.modifiers))) did++;
      const after = focusField({});
      if (after && after !== document.body) el = after;
      if (n % 20 === 19) await sleep(0);
    }
    return { defaults: did };
  }

  /** The area that a scroll moves: the nearest scrollable one at or above the element, or the page. */
  function scroller(el) {
    for (let e = el; e && e !== document.body && e !== document.documentElement; e = parentOf(e)) {
      const s = getComputedStyle(e);
      if (/auto|scroll/.test(s.overflowY + s.overflowX) && (e.scrollHeight > e.clientHeight || e.scrollWidth > e.clientWidth)) return e;
    }
    return document.scrollingElement ?? document.documentElement;
  }

  /** Scroll functions only: no synthetic wheel, key or mouse event. */
  function scroll(m) {
    const s = scroller(m.ref ? target(m.ref) : null);
    const before = [s.scrollLeft, s.scrollTop];
    const by = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[m.direction];
    if (m.to) s.scrollTo({ top: m.to === 'top' ? 0 : s.scrollHeight, behavior: 'instant' });
    else s.scrollBy({ left: by[0] * m.amount, top: by[1] * m.amount, behavior: 'instant' });
    const after = [s.scrollLeft, s.scrollTop];
    return { from: before, to: after, moved: before.join() !== after.join(), at_end: s.scrollTop + s.clientHeight >= s.scrollHeight - 1, at_start: s.scrollTop <= 0, area: s === document.scrollingElement ? 'page' : 'element' };
  }

  function scrollTo(m) {
    const el = target(m.ref);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return { box: [r.left, r.top, r.width, r.height].map(Math.round), visible: onScreen(el) };
  }

  async function drag(m) {
    const from = approved(m);
    const to = approved(m, 'to', 'toPrint');
    checkTarget(from);
    const mine = epoch;
    const a = pointOf(from);
    to.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    const rb = to.getBoundingClientRect();
    const b = { x: rb.left + rb.width * (m.toX ?? 0.5), y: rb.top + rb.height * (m.toY ?? 0.5) };
    observe();
    const at = (n) => ({ clientX: a.x + ((b.x - a.x) * n) / 5, clientY: a.y + ((b.y - a.y) * n) / 5 });
    const base = { bubbles: true, cancelable: true, composed: true, view: window, button: 0 };
    const fire = (el, type, p, buttons = 1) => {
      const Kind = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      return el.dispatchEvent(new Kind(type, { ...base, ...p, buttons, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    };
    if (from instanceof HTMLInputElement && from.type === 'range') {
      const r = from.getBoundingClientRect();
      const share = Math.max(0, Math.min(1, (b.x - r.left) / r.width));
      const min = Number(from.min || 0);
      from.value = String(min + share * (Number(from.max || 100) - min));
      announce(from);
      return { accepted: true, handled: true, how: 'slider', at: a.at };
    }
    fire(a.hit, 'pointerdown', at(0));
    fire(a.hit, 'mousedown', at(0));
    const source = from.closest('[draggable=true], a[href], img');
    let accepted = null;
    let handled = null;
    if (source && source.draggable) {
      const data = new DataTransfer();
      const d = (el, type, p) => el.dispatchEvent(new DragEvent(type, { ...base, ...p, dataTransfer: data }));
      if (d(source, 'dragstart', at(0))) {
        d(source, 'drag', at(1));
        d(to, 'dragenter', at(4));
        for (const n of [4, 5]) accepted = !d(to, 'dragover', at(n));
        if (accepted) handled = !d(to, 'drop', at(5));
        else d(to, 'dragleave', at(5));
        d(source, 'dragend', at(5));
      }
    } else {
      for (let n = 1; n <= 5 && epoch === mine; n++) {
        const p = at(n);
        const over = document.elementFromPoint(p.clientX, p.clientY) ?? to;
        fire(over, 'pointermove', p);
        fire(over, 'mousemove', p);
        await sleep(16);
      }
    }
    fire(to, 'pointerup', at(5), 0);
    fire(to, 'mouseup', at(5), 0);
    return { accepted, handled, how: source?.draggable ? 'drag events' : 'pointer events', at: a.at };
  }

  /** Files that the user approved, into a file input or onto a drop zone. */
  function upload(m) {
    const el = approved(m);
    const input = el instanceof HTMLInputElement && el.type === 'file';
    // The page sees dropped files only in a DataTransfer of its own realm. The user approved giving them to this page.
    const data = input ? new DataTransfer() : new window.wrappedJSObject.DataTransfer();
    for (const f of m.files) {
      const file = new File([f.bytes], f.name, { type: f.type });
      if (f.relative) Object.defineProperty(file.wrappedJSObject ?? file, 'webkitRelativePath', { value: f.relative, configurable: true });
      data.items.add(file);
    }
    observe();
    if (input) {
      if (el.matches(':disabled')) fail('not_actionable', 'The field is disabled.');
      if (m.files.length > 1 && !el.multiple && !el.webkitdirectory) fail('not_actionable', 'The field takes one file.');
      el.files = data.files;
      announce(el);
      return { set: el.files.length, how: 'input' };
    }
    const r = el.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, composed: true, dataTransfer: data, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new DragEvent('dragenter', init));
    const accepted = !el.dispatchEvent(new DragEvent('dragover', init));
    const handled = accepted && !el.dispatchEvent(new DragEvent('drop', init));
    return { set: handled ? m.files.length : 0, how: 'drop', accepted, handled };
  }

  /** What an upload target is: an input (one, several, folder) or a drop zone. */
  function uploadTarget(m) {
    const el = target(m.ref);
    const input = el instanceof HTMLInputElement && el.type === 'file';
    return { ...describe(el), input, multiple: input && el.multiple, folder: input && el.webkitdirectory };
  }

  /** What the user selected, never from a secret field. */
  function selection({ max }) {
    const a = document.activeElement;
    let s = '';
    if ((a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) && a.selectionEnd > a.selectionStart) s = isSecret(a) ? '' : a.value.slice(a.selectionStart, a.selectionEnd);
    else s = String(getSelection() ?? '');
    return { text: s.slice(0, max), truncated: s.length > max };
  }

  // Questions without code

  const STYLES = ['display', 'visibility', 'opacity', 'position', 'z-index', 'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'text-align', 'width', 'height', 'margin', 'padding', 'border', 'overflow', 'cursor', 'pointer-events'];

  function query(m) {
    if (m.action === 'box') {
      const el = target(m.ref);
      const r = el.getBoundingClientRect();
      return { box: { left: r.left, top: r.top, width: r.width, height: r.height }, on_screen: onScreen(el), visible: el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) };
    }
    if (m.action === 'style') {
      const cs = getComputedStyle(target(m.ref));
      return { style: Object.fromEntries(STYLES.map((k) => [k, cs.getPropertyValue(k)])) };
    }
    if (m.action === 'table') {
      const el = target(m.ref).closest('table, [role=table], [role=grid]');
      if (!el) fail('not_actionable', 'That is no table.');
      const rows = [...(el.rows ?? el.querySelectorAll('[role=row]'))];
      return { total: rows.length, rows: rows.slice(0, 200).map((r) => [...(r.cells ?? r.querySelectorAll('[role=cell], [role=gridcell], [role=columnheader], [role=rowheader]'))].slice(0, 50).map((c) => line(c.innerText, 200))) };
    }
    const names = m.attributes ?? [];
    if (names.some((n) => !/^[a-z_:][\w:.-]*$/i.test(n))) fail('invalid_argument', 'That is no attribute name.');
    const found = search({ query: m.query, selector: m.selector, limit: 50 });
    if (m.action === 'count') return { total: found.total };
    return {
      total: found.total,
      elements: found.hits.map(({ score, off_screen, ...h }) => {
        const el = refs.get(h.ref).deref();
        const value = (n) => (isSecret(el) && /^(value|data-)/i.test(n) ? '[secret]' : el.getAttribute(n)?.slice(0, 300) ?? null);
        return { ...h, tag: el.tagName.toLowerCase(), text: isSecret(el) ? '' : line(el.innerText, 300), value: valueOf(el), visible: el.checkVisibility({ visibilityProperty: true, opacityProperty: true }), on_screen: !off_screen, ...(names.length && { attributes: Object.fromEntries(names.map((n) => [n, value(n)])) }) };
      }),
    };
  }

  function timing() {
    const all = (t) => performance.getEntriesByType(t);
    const known = PerformanceObserver.supportedEntryTypes;
    const [nav] = all('navigation');
    const ms = (n) => Math.round(n * 10) / 10;
    return {
      navigation: nav ? { type: nav.type, ...Object.fromEntries(['responseStart', 'responseEnd', 'domInteractive', 'domContentLoadedEventEnd', 'loadEventEnd'].map((k) => [k, ms(nav[k])])), transferred: nav.transferSize } : null,
      paints: all('paint').map((p) => ({ name: p.name, at: ms(p.startTime) })),
      slow_resources: all('resource').filter((r) => r.duration >= 500).sort((a, b) => b.duration - a.duration).slice(0, 50).map((r) => ({ url: r.name, type: r.initiatorType, start: ms(r.startTime), duration: ms(r.duration), bytes: r.transferSize })),
      marks: all('mark').slice(0, 100).map((e) => ({ name: line(e.name, 100), at: ms(e.startTime) })),
      measures: all('measure').slice(0, 100).map((e) => ({ name: line(e.name, 100), start: ms(e.startTime), duration: ms(e.duration) })),
      missing: ['navigation', 'resource', 'mark', 'measure', 'paint', 'largest-contentful-paint', 'first-input', 'event', 'longtask', 'layout-shift', 'element'].filter((t) => !known.includes(t)),
    };
  }

  function storage({ action, area, key, value, max }) {
    let s;
    try {
      s = area === 'local' ? localStorage : sessionStorage;
      s.length;
    } catch {
      fail('not_allowed', 'The page has no such storage.');
    }
    const entry = (k) => ({ key: k.slice(0, 500), length: s.getItem(k).length, value: s.getItem(k).slice(0, max) });
    if (action === 'list') return { total: s.length, entries: [...Array(Math.min(s.length, 200)).keys()].map((i) => entry(s.key(i))) };
    if (action === 'get') return { entry: s.getItem(key) === null ? null : entry(key) };
    if (action === 'set') return s.setItem(key, value), { set: s.getItem(key) === value };
    if (action === 'delete') return s.removeItem(key), { deleted: s.getItem(key) === null };
    const n = s.length;
    s.clear();
    return { cleared: n - s.length };
  }

  // Watched elements

  const watches = new Map();
  let nextWatch = 1;

  function watchElement(m) {
    const el = target(m.ref);
    if (watches.size >= 10) fail('limit_reached', 'Ten elements are watched already. Stop one first.');
    const w = { changes: [], dropped: 0 };
    const note = (c) => {
      w.changes.push({ at: Date.now(), ...c });
      if (w.changes.length > m.keep) w.changes.splice(0, w.changes.length - m.keep), w.dropped++;
    };
    const text = (n) => (n instanceof Element ? (isSecret(n) ? '[secret]' : line(n.innerText ?? n.textContent, 200)) : line(n.data, 200));
    w.observer = new MutationObserver((list) => {
      for (const r of list) {
        const at = r.target instanceof Element ? r.target : r.target.parentElement;
        const where = at ? `${roleOf(at) ?? at.tagName.toLowerCase()}` : 'text';
        if (r.type === 'childList') for (const [kind, nodes] of [['added', r.addedNodes], ['removed', r.removedNodes]]) for (const n of nodes) if (!own(n) && !gone.has(n) && text(n)) note({ kind, where, text: text(n) });
        if (r.type === 'characterData') note({ kind: 'text', where, text: at && isSecret(at) ? '[secret]' : text(r.target) });
        if (r.type === 'attributes') note({ kind: 'attribute', where, name: r.attributeName, value: isSecret(r.target) ? '[secret]' : r.target.getAttribute(r.attributeName)?.slice(0, 200) ?? null });
      }
    });
    w.observer.observe(el, { subtree: true, childList: true, characterData: true, attributes: true });
    const name = `w_${id}_${nextWatch++}`;
    watches.set(name, w);
    return { watch: name };
  }

  function watchRead({ watch: name, stop }) {
    const w = watches.get(name);
    if (!w) fail('not_found', 'Nothing is watched under that name. The page may have loaded again.');
    const { changes, dropped } = w;
    Object.assign(w, { changes: [], dropped: 0 });
    if (stop) w.observer.disconnect(), watches.delete(name);
    return { changes, dropped };
  }

  function quiet() {
    for (const w of watches.values()) w.observer.disconnect();
    watches.clear();
  }

  // The pill: a recording runs, or a session works here. It stops on a real click only.

  let pill = null;
  let pillKind = null;
  let pillTimer = null;
  const gone = new WeakSet(); // our own nodes after they left the page
  let recording = false;

  function setPill(kind, words, label, message) {
    clearTimeout(pillTimer);
    if (pill) gone.add(pill);
    pill?.remove();
    pill = null;
    pillKind = kind;
    if (!kind) return;
    pill = document.createElement('div');
    pill.style.cssText = 'all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647;pointer-events:auto';
    const root = pill.attachShadow({ mode: 'closed' });
    const box = document.createElement('div');
    box.style.cssText = 'display:flex;gap:8px;align-items:center;max-width:70vw;padding:6px 10px;border-radius:16px;background:#1c1b22;color:#fff;font:13px/1.3 system-ui,sans-serif;box-shadow:0 1px 6px #0006';
    const dot = document.createElement('span');
    dot.style.cssText = `flex:none;width:10px;height:10px;border-radius:50%;background:${kind === 'work' ? '#45a1ff' : '#e22850'}`;
    const text = document.createElement('span');
    text.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    text.textContent = words;
    const stop = document.createElement('button');
    stop.textContent = label;
    stop.style.cssText = 'flex:none;font:inherit;color:inherit;background:#fff3;border:0;border-radius:10px;padding:2px 10px;cursor:pointer';
    stop.addEventListener('click', (e) => e.isTrusted && browser.runtime.sendMessage(message));
    box.append(dot, text, stop);
    root.append(box);
    document.documentElement.append(pill);
  }

  const recordPill = (kind) => setPill(kind, kind === 'GIF' ? 'Recording pictures' : 'Recording steps', 'Stop', { type: 'stop_recording', kind });

  /** A session works in this tab. A recording's pill goes first. */
  function work({ who, what }) {
    if (pillKind && pillKind !== 'work') return {};
    setPill('work', `${who}: ${what}`, 'Take over', { type: 'take_over' });
    pillTimer = setTimeout(() => pillKind === 'work' && setPill(null), 6000);
    return {};
  }

  // Recording: the user's own gestures become steps.

  /** Role, name and number among equals, as in the outline that a replay reads. */
  function locate(el) {
    const all = [];
    snapshot({ filter: 'interactive', maxChars: 0, maxNodes: 20_000, collect: all });
    for (let e = el; e; e = e.parentElement ?? e.getRootNode().host ?? null) {
      const i = all.findIndex((x) => x.el === e);
      if (i < 0) continue;
      const same = all.filter((x) => x.role === all[i].role && x.name === all[i].name);
      return { role: all[i].role, name: all[i].name, nth: same.findIndex((x) => x.el === e), of: same.length };
    }
    return null;
  }

  const PERSONAL = /\b(username|email|tel|name|given-name|family-name|street-address|address-line\d|postal-code|bday|sex|organization)\b/;
  const step = (s) => browser.runtime.sendMessage({ type: 'step', step: s });
  const insidePill = (e) => pill !== null && e.composedPath().includes(pill);

  function onClick(e) {
    if (!recording || !e.isTrusted || insidePill(e)) return;
    const el = e.composedPath()[0];
    if (!(el instanceof Element)) return;
    if (typing !== el) reportTyping();
    const control = el.closest('label')?.control;
    if (control && control !== el && !el.closest('a,button')) return; // the control reports itself
    if (isChoice(el) || el instanceof HTMLSelectElement || el.closest('option') || el instanceof HTMLTextAreaElement || el.isContentEditable) return;
    if (el instanceof HTMLInputElement && !['button', 'submit', 'reset', 'image'].includes(el.type)) return;
    const at = locate(el);
    if (at) step({ kind: 'click', ...at });
    else if (getComputedStyle(el).cursor === 'pointer') step({ kind: 'manual', text: 'Click a part of the page that has no name' });
  }

  // A field in which the user types. Some pages and some ways to leave a field give no change event, so it is also
  // reported before the next gesture and before the page goes.
  let typing = null;

  function onInput(e) {
    if (!recording || !e.isTrusted) return;
    const el = e.composedPath()[0];
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable) || isChoice(el)) return;
    if (typing !== el) reportTyping();
    typing = el;
  }

  function reportTyping() {
    const el = typing;
    typing = null;
    if (el?.isConnected) reportField(el);
  }

  function onChange(e) {
    if (!recording || !e.isTrusted) return;
    const el = e.composedPath()[0];
    if (!(el instanceof Element)) return;
    if (typing === el) typing = null;
    else reportTyping();
    reportField(el);
  }

  function reportField(el) {
    const at = locate(el);
    if (!at) return step({ kind: 'manual', text: 'Fill in a field that has no name' });
    if (isSecret(el)) return step({ kind: 'secret', ...at });
    if (isChoice(el)) return step({ kind: 'check', ...at, value: String(el.checked) });
    if (el instanceof HTMLSelectElement) return step(el.multiple ? { kind: 'manual', text: 'Choose in a list with several choices' } : { kind: 'choose', ...at, value: line(el.selectedOptions[0]?.label, 200) });
    if (el.type === 'file') return step({ kind: 'manual', text: 'Choose a file' });
    // The text itself stays in the page: a replay asks for it.
    step({ kind: 'fill', ...at, sensitive: ['email', 'tel'].includes(el.type) || PERSONAL.test(el.autocomplete ?? '') });
  }

  function record({ on, kind }) {
    if (recording) reportTyping();
    recording = on;
    typing = null;
    if (frame === 0 && (on || pillKind === 'steps')) on ? recordPill(kind) : setPill(null);
    return {};
  }

  addEventListener('click', onClick, true);
  addEventListener('input', onInput, true);
  addEventListener('change', onChange, true);
  addEventListener('submit', () => recording && reportTyping(), true);
  addEventListener('pagehide', () => recording && reportTyping(), true);

  // Covers for captures: secret fields, and every frame that is not granted.

  function cover({ frames = [] }) {
    uncover();
    if (pill) pill.style.visibility = 'hidden';
    covers = document.createElement('div');
    covers.setAttribute('popover', 'manual');
    covers.style.cssText = 'all:initial;position:fixed;inset:0;width:100vw;height:100vh;margin:0;padding:0;border:0;background:transparent;pointer-events:none;overflow:visible;z-index:2147483647';
    const root = covers.attachShadow({ mode: 'closed' });
    const walk = (node) => {
      if (node instanceof Element) {
        const closed = FRAMES.includes(node.tagName) && !frames.includes(browser.runtime.getFrameId(node));
        if (closed || (isSecret(node) && node.value !== '')) {
          const r = node.getBoundingClientRect();
          const box = document.createElement('div');
          box.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;background:#000`;
          root.append(box);
        }
        if (shadowOf(node)) shadowOf(node).childNodes.forEach(walk);
      }
      node.childNodes.forEach(walk);
    };
    walk(document.documentElement);
    if (!root.childNodes.length) return void (covers = null);
    document.documentElement.append(covers);
    covers.showPopover?.(); // above modal dialogs of the page
  }

  function uncover() {
    if (covers) gone.add(covers);
    covers?.remove();
    covers = null;
    if (pill) pill.style.visibility = '';
  }

  const commands = {
    snapshot,
    text,
    search,
    find_text: findText,
    check,
    children,
    marks,
    place,
    hit: hitTest,
    describe: (m) => {
      const el = target(m.ref);
      if (m.fill) checkField(el);
      else if (m.value !== undefined) checkValue(el, m.value);
      else if (!m.loose) checkTarget(el);
      return describe(el);
    },
    upload_target: uploadTarget,
    pointer,
    hover,
    type,
    key,
    scroll,
    scroll_to: scrollTo,
    drag,
    upload,
    fill: (m) => fill(approved(m), m.value, m.commit),
    fill_many: ({ fields }) => {
      // Everything is checked before the first write.
      const list = fields.map((f) => [approved(f), f.value]);
      for (const [el, v] of list) checkValue(el, v);
      const set = [];
      for (const [i, [el, v]] of list.entries()) {
        try {
          fill(el, v, false);
          set.push(i);
        } catch (e) {
          return { set, failed: i, code: e.error ?? 'error', message: e.message };
        }
      }
      return { set };
    },
    aim,
    field: fieldFor,
    field_size: () => ({ size: fieldSize() }),
    leave,
    query,
    timing,
    storage,
    watch: watchElement,
    watch_read: watchRead,
    selection,
    record,
    work,
    pill: ({ kind }) => (kind || pillKind === 'GIF' ? recordPill(kind) : null, {}),
    after: () => {
      const s = watch?.seen;
      return { changed: Boolean(s && (s.changed || s.url !== location.href || ![s.focus, s.expected].includes(document.activeElement))), dialogs: releaseDialogs(), url: location.href !== s?.url };
    },
    cover,
    uncover,
  };

  browser.runtime.onMessage.addListener((m) => {
    if (m.cmd === 'hooks') return; // for hooks.js
    if (m.cmd === 'quiet') return quiet(), Promise.resolve({ id });
    if (m.cmd === 'where') return Promise.resolve({ origin: self.origin, path: location.pathname, id });
    if (m.cmd === 'abort') {
      epoch++;
      return Promise.resolve({ id });
    }
    if (m.cmd === 'forget') {
      epoch++;
      quiet();
      uncover();
      releaseDialogs();
      refs.clear();
      refOf = new WeakMap();
      record({ on: false });
      setPill(null);
      watch?.disconnect();
      return Promise.resolve({ id });
    }
    if (self.origin !== m.origin) return Promise.resolve({ error: 'origin_changed', message: 'The document has another origin.' });
    return (async () => ({ ...(await commands[m.cmd](m)), id }))().catch((e) => (e.error ? e : Promise.reject(e)));
  });
})();
