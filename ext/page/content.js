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

  function nameOf(el, role) {
    const by = el.getAttribute('aria-labelledby')?.split(/\s+/).map((i) => el.getRootNode().getElementById?.(i)?.textContent ?? '').join(' ');
    const label = line(by, 120) || line(el.getAttribute('aria-label'), 120);
    if (label) return label;
    if (el instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(el.type)) return line(el.value || el.type, 120);
    if ('labels' in el && el.labels?.length) return line([...el.labels].map((l) => l.textContent).join(' '), 120);
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

  function snapshot({ filter, maxChars, maxNodes }) {
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
      if (!(node instanceof Element) || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD'].includes(node.tagName)) return;
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
    return {};
  }

  // Covers for captures: secret fields and every frame, because no frame has a grant of its own yet.

  function cover() {
    uncover();
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
  }

  const commands = {
    snapshot,
    find: ({ text }) => ({ found: (document.body?.innerText ?? '').includes(text) }),
    describe: (m) => {
      const el = target(m.ref);
      checkTarget(el);
      return describe(el);
    },
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
