// Injected on demand into the top frame of a granted tab. Reads write nothing into the page. Only the add-on's own
// background page can send messages here.
(() => {
  if (globalThis.companion) return;
  globalThis.companion = true;

  const id = crypto.randomUUID().slice(0, 8); // a ref names one element of one document and is never reused
  const refs = new Map();
  let refOf = new WeakMap();
  const everPassword = new WeakSet();
  let nextRef = 1;
  let covers = null;
  let watch = null;

  const line = (s, max) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max)}…` : t;
  };

  // Elements

  const ref = (el) => {
    let r = refOf.get(el);
    if (!r) {
      r = `ref_${id}_${nextRef++}`;
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

  function roleOf(el) {
    const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0];
    if (explicit && explicit !== 'presentation' && explicit !== 'none') return explicit;
    if (el instanceof HTMLInputElement) return INPUT_ROLES[el.type] ?? 'textbox';
    if ((el.tagName === 'A' || el.tagName === 'AREA') && el.hasAttribute('href')) return 'link';
    if (/^H[1-6]$/.test(el.tagName)) return 'heading';
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return 'textbox';
    return TAG_ROLES[el.tagName] ?? (el.hasAttribute('onclick') || el.tabIndex >= 0 && el.hasAttribute('tabindex') ? 'clickable' : null);
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
    if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !(el.type in INPUT_ROLES && INPUT_ROLES[el.type] === 'button') && !['checkbox', 'radio', 'hidden'].includes(el.type))) return line(el.value, 200);
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

  function childrenOf(el) {
    if (el.tagName === 'SLOT') {
      const assigned = el.assignedNodes();
      if (assigned.length) return assigned;
    }
    return [...(shadowOf(el) ?? el).childNodes];
  }

  // Reading

  function snapshot({ filter, maxChars, maxNodes, collect = null }) {
    const out = [];
    let nodes = 0;
    let full = 0;
    let size = 0;
    const emit = (depth, s) => {
      const l = '  '.repeat(Math.min(depth, 20)) + s;
      full += l.length + 1;
      if (full <= maxChars) {
        out.push(l);
        size = full;
      }
    };
    const walk = (node, depth, inName, style) => {
      if (++nodes > maxNodes) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const t = line(node.data, 500);
        if (t && !inName && filter === 'all' && style.visibility === 'visible') emit(depth, `- text ${JSON.stringify(t)}`);
        return;
      }
      if (!(node instanceof Element) || node === pill || ['SCRIPT','STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD'].includes(node.tagName)) return;
      const cs = getComputedStyle(node);
      if (cs.display === 'none' || cs.opacity === '0') return;
      const visible = cs.visibility === 'visible';
      const role = roleOf(node);
      let d = depth;
      let named = inName;
      if (role && visible && (filter === 'all' || interactive(role))) {
        const name = nameOf(node, role);
        const states = statesOf(node, role);
        const value = valueOf(node);
        const link = role === 'link' ? linkOf(node) : null;
        if (interactive(role)) collect?.push({ el: node, role, name });
        emit(depth, [`- ${role}`, name && JSON.stringify(name), states.length && `[${states.join(', ')}]`, value && `value=${JSON.stringify(value)}`, link && `-> ${link.text}`, interactive(role) && `[${ref(node)}]`].filter(Boolean).join(' '));
        d = depth + 1;
        named = inName || NAME_FROM_TEXT.has(role) || role === 'clickable';
      }
      // Frames are placeholders and form values are printed above, so neither is walked.
      if (['frame', 'textbox', 'searchbox', 'image'].includes(role) && !node.isContentEditable) return;
      if (node instanceof HTMLSelectElement) return;
      for (const c of childrenOf(node)) walk(c, d, named, cs);
    };
    if (document.body) walk(document.body, 0, false, getComputedStyle(document.body));
    if (nodes > maxNodes) emit(0, `- (stopped after ${maxNodes} nodes)`);
    return { outline: out.join('\n'), truncated: full > size, fullChars: full };
  }

  // Acting

  function target(refName) {
    const el = refs.get(refName)?.deref();
    if (!el || !el.isConnected) throw { error: 'stale_ref', message: 'That element is gone. Read the page again.' };
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

  function checkTarget(el) {
    const link = linkOf(el);
    if (link && !/^https?:$/.test(link.protocol)) throw { error: 'not_allowed', message: `Links with ${link.protocol || 'an invalid address'} are not clicked.` };
    if (el instanceof HTMLInputElement && el.type === 'file') throw { error: 'not_allowed', message: 'File pickers are not opened by a click.' };
    if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true' || el.closest('[inert]')) throw { error: 'not_actionable', message: 'The element is disabled.' };
    if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) throw { error: 'not_actionable', message: 'The element is hidden.' };
  }

  function click(el) {
    checkTarget(el);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) throw { error: 'not_actionable', message: 'The element has no size.' };
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    let hit = el.getRootNode().elementFromPoint(x, y);
    const label = hit?.closest('label');
    if (!hit || !(el === hit || el.contains(hit) || hit.contains(el) && !interactive(roleOf(hit)) && shadowOf(hit) || label?.control === el)) {
      throw { error: 'covered', message: hit ? `Another element covers it: ${describe(hit).description}` : 'It is outside the visible area.' };
    }
    hit = el.contains(hit) ? hit : el;
    watch?.disconnect();
    const seen = { changed: false };
    watch = new MutationObserver(() => (seen.changed = true));
    watch.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    watch.seen = seen;
    const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0, detail: 1 };
    hit.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    hit.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1 }));
    el.focus?.({ preventScroll: true });
    hit.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    hit.dispatchEvent(new MouseEvent('mouseup', init));
    hit.click();
    return { at: placeOf(r) };
  }

  /** Middle of a rectangle as parts of the visible area, for the click mark of a GIF. */
  const placeOf = (r) => ({ x: (r.left + r.width / 2) / innerWidth, y: (r.top + r.height / 2) / innerHeight });

  const isChoice = (el) => el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio');

  function checkField(el) {
    if (isSecret(el)) throw { error: 'secret_field', message: 'Passwords, codes and payment fields are filled in by the user only.' };
    checkTarget(el);
    const field = el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el.isContentEditable ||
      (el instanceof HTMLInputElement && !['button', 'submit', 'reset', 'image', 'hidden'].includes(el.type));
    if (!field) throw { error: 'not_actionable', message: 'That is not a form field.' };
    if (el.readOnly) throw { error: 'not_actionable', message: 'The field is read-only.' };
  }

  function fill(el, value) {
    checkField(el);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const at = placeOf(el.getBoundingClientRect());
    const announce = () => {
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText' }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    if (isChoice(el)) {
      if (value !== 'true' && value !== 'false') throw { error: 'invalid_argument', message: 'A checkbox or radio button takes "true" or "false".' };
      const changed = el.checked !== (value === 'true');
      if (changed) el.click();
      if (el.checked !== (value === 'true')) throw { error: 'not_taken', message: 'The page did not keep the choice.' };
      return { changed, at };
    }
    if (el instanceof HTMLSelectElement) {
      if (el.multiple) throw { error: 'not_actionable', message: 'Lists with several choices are not supported.' };
      const all = [...el.options];
      const label = (o) => line(o.label, 200);
      const same = (o, f) => f(o).toLowerCase() === value.toLowerCase();
      const hits = [all.filter((o) => o.value === value), all.filter((o) => label(o) === value), all.filter((o) => same(o, label))].find((h) => h.length) ?? [];
      if (hits.length !== 1) throw { error: hits.length ? 'ambiguous' : 'no_match', message: `Options: ${(hits.length ? hits : all).slice(0, 50).map((o) => JSON.stringify(label(o))).join(', ')}` };
      if (hits[0].disabled) throw { error: 'not_actionable', message: 'That option is disabled.' };
      const changed = !hits[0].selected;
      hits[0].selected = true;
      if (changed) announce();
      if (!hits[0].selected) throw { error: 'not_taken', message: 'The page did not keep the choice.' };
      return { changed, at };
    }
    el.focus({ preventScroll: true });
    if (el.isContentEditable) {
      getSelection().selectAllChildren(el);
      document.execCommand('insertText', false, value);
      if (line(el.innerText, 1e6) !== line(value, 1e6)) throw { error: 'not_taken', message: 'The editor did not keep the text.' };
      return { changed: true, at };
    }
    const changed = el.value !== value;
    el.value = value;
    if (el.value !== value) throw { error: 'not_taken', message: 'The field does not accept this value.' };
    if (changed) announce();
    if (el.value !== value) throw { error: 'not_taken', message: 'The page changed the value.' };
    return { changed, at };
  }

  /** What the user selected, never from a secret field. */
  function selection({ max }) {
    const a = document.activeElement;
    let text = '';
    if ((a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) && a.selectionEnd > a.selectionStart) text = isSecret(a) ? '' : a.value.slice(a.selectionStart, a.selectionEnd);
    else text = String(getSelection() ?? '');
    return { text: text.slice(0, max), truncated: text.length > max };
  }

  // Recording: the user's own gestures become steps, and a pill shows that it runs.

  let pill = null;
  let recording = false;

  function setPill(kind) {
    pill?.remove();
    pill = null;
    if (!kind) return;
    pill = document.createElement('div');
    pill.style.cssText = 'all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647;pointer-events:auto';
    const root = pill.attachShadow({ mode: 'closed' });
    const box = document.createElement('div');
    box.style.cssText = 'display:flex;gap:8px;align-items:center;padding:6px 10px;border-radius:16px;background:#1c1b22;color:#fff;font:13px/1.3 system-ui,sans-serif;box-shadow:0 1px 6px #0006';
    const dot = document.createElement('span');
    dot.style.cssText = 'width:10px;height:10px;border-radius:50%;background:#e22850';
    const label = document.createElement('span');
    label.textContent = kind === 'GIF' ? 'Recording pictures' : 'Recording steps';
    const stop = document.createElement('button');
    stop.textContent = 'Stop';
    stop.style.cssText = 'font:inherit;color:inherit;background:#fff3;border:0;border-radius:10px;padding:2px 10px;cursor:pointer';
    stop.addEventListener('click', (e) => e.isTrusted && browser.runtime.sendMessage({ type: 'stop_recording', kind }));
    box.append(dot, label, stop);
    root.append(box);
    document.documentElement.append(pill);
  }

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
    const personal = ['email', 'tel'].includes(el.type) || PERSONAL.test(el.autocomplete ?? '');
    step(personal ? { kind: 'fill', ...at, ask: true } : { kind: 'fill', ...at, value: String(el.value ?? el.innerText).slice(0, 10_000) });
  }

  function record({ on, kind }) {
    if (recording) reportTyping();
    recording = on;
    typing = null;
    setPill(on ? kind : null);
    return {};
  }

  addEventListener('click', onClick, true);
  addEventListener('input', onInput, true);
  addEventListener('change', onChange, true);
  addEventListener('submit', () => recording && reportTyping(), true);
  addEventListener('pagehide', () => recording && reportTyping(), true);

  // Covers for captures: secret fields and every frame, because no frame has a grant of its own yet.

  function cover() {
    uncover();
    if (pill) pill.style.visibility = 'hidden';
    covers = document.createElement('div');
    covers.setAttribute('popover', 'manual');
    covers.style.cssText = 'all:initial;position:fixed;inset:0;width:100vw;height:100vh;margin:0;padding:0;border:0;background:transparent;pointer-events:none;overflow:visible;z-index:2147483647';
    const root = covers.attachShadow({ mode: 'closed' });
    const walk = (node) => {
      if (node instanceof Element) {
        const frame = ['IFRAME', 'FRAME', 'OBJECT', 'EMBED'].includes(node.tagName);
        if (frame || (isSecret(node) && node.value !== '')) {
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
    if (!root.childNodes.length) return;
    document.documentElement.append(covers);
    covers.showPopover?.(); // above modal dialogs of the page
  }

  function uncover() {
    covers?.remove();
    covers = null;
    if (pill) pill.style.visibility = '';
  }

  const commands = {
    snapshot,
    find: ({ text }) => ({ found: (document.body?.innerText ?? '').includes(text) }),
    describe: (m) => {
      const el = target(m.ref);
      if (m.fill) checkField(el);
      else checkTarget(el);
      return describe(el);
    },
    fill: (m) => {
      const el = target(m.ref);
      if (describe(el).fingerprint !== m.fingerprint) throw { error: 'stale_ref', message: 'The element changed after the user approved it.' };
      return fill(el, m.value);
    },
    selection,
    record,
    pill: ({ kind }) => (setPill(kind), {}),
    click: (m) => {
      const el = target(m.ref);
      if (describe(el).fingerprint !== m.fingerprint) throw { error: 'stale_ref', message: 'The element changed after the user approved it.' };
      return click(el);
    },
    after_click: () => ({ changed: watch?.seen.changed ?? false }),
    cover,
    uncover,
  };

  browser.runtime.onMessage.addListener((m) => {
    if (m.cmd === 'forget') {
      uncover();
      refs.clear();
      refOf = new WeakMap();
      record({ on: false });
      watch?.disconnect();
      return Promise.resolve({ id });
    }
    if (location.origin !== m.origin) return Promise.resolve({ error: 'origin_changed', message: 'The document has another origin.' });
    try {
      return Promise.resolve({ ...commands[m.cmd](m), id });
    } catch (e) {
      return e.error ? Promise.resolve(e) : Promise.reject(e);
    }
  });
})();
