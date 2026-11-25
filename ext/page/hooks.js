// Injected only while the user has console or webmcp on, and only into granted frames of a granted tab. It wraps the console
// of the page and offers WebMCP to it. Page script reaches the functions that are exported here and nothing behind them.
(() => {
  if (globalThis.companionHooks) return;
  globalThis.companionHooks = true;

  const page = window.wrappedJSObject;
  const id = crypto.randomUUID().slice(0, 8);
  const METHODS = ['debug', 'log', 'info', 'warn', 'error'];
  const MAX = 2000;
  let waiting = [];
  let timer = null;
  let sent = 0;

  /** The background checks sender, tab, frame and origin, and drops what no grant covers. */
  function report(entry) {
    if (!consoleOn || sent > 5000) return;
    sent++;
    waiting.push({ at: Date.now(), ...entry });
    timer ??= setTimeout(() => {
      timer = null;
      browser.runtime.sendMessage({ type: 'console', entries: waiting.splice(0) }).catch(() => {});
    }, 30);
  }

  /** Own data properties only: no getter, no toString and no toJSON of the page runs. */
  function show(v, depth = 3) {
    try {
      if (typeof v === 'string') return depth === 3 ? v.slice(0, MAX) : JSON.stringify(v.slice(0, 200));
      if (typeof v === 'function') return '[function]';
      if (v === null || typeof v !== 'object') return String(v);
      if (v instanceof window.Error || v instanceof Error || v instanceof DOMException) return `${v.name}: ${v.message}`.slice(0, MAX);
      if (v instanceof Element) return `<${v.localName}${v.id ? ` id=${JSON.stringify(v.id.slice(0, 60))}` : ''}>`;
      if (v instanceof Node) return `[${v.nodeName}]`;
      if (!depth) return Array.isArray(v) ? '[…]' : '{…}';
      const part = (k) => show(Object.getOwnPropertyDescriptor(v, k)?.value, depth - 1);
      if (Array.isArray(v)) return `[${[...Array(Math.min(v.length, 20)).keys()].map(part).join(', ')}${v.length > 20 ? ', …' : ''}]`;
      const keys = Object.keys(v);
      return `{${keys.slice(0, 20).map((k) => `${k}: ${part(k)}`).join(', ')}${keys.length > 20 ? ', …' : ''}}`;
    } catch {
      return '[object]';
    }
  }

  // Console

  let consoleOn = false;
  const put = new Map();

  function hookConsole() {
    const c = page.console;
    for (const m of METHODS) {
      const original = c[m];
      if (typeof original !== 'function') continue;
      c[m] = exportFunction((...args) => {
        report({ level: m, kind: 'console', text: args.slice(0, 20).map((a) => show(a)).join(' ').slice(0, MAX) });
        return Reflect.apply(original, c, args); // `apply` of the page would read our array, which it may not
      }, window, { allowCrossOriginArguments: true });
      put.set(m, { original, mine: c[m] });
    }
  }

  function unhookConsole() {
    const c = page.console;
    for (const [m, { original, mine }] of put) if (c[m] === mine) c[m] = original;
    put.clear();
  }

  addEventListener('error', (e) => {
    if (!consoleOn || !e.isTrusted) return;
    if (e.target instanceof Element) report({ level: 'error', kind: 'resource', text: `${e.target.localName} did not load`, url: String(e.target.src || e.target.href || '').slice(0, MAX) });
    else if (e instanceof ErrorEvent) report({ level: 'error', kind: 'uncaught', text: String(e.message).slice(0, MAX), url: String(e.filename ?? '').slice(0, MAX), line: e.lineno });
  }, true);
  addEventListener('unhandledrejection', (e) => consoleOn && e.isTrusted && report({ level: 'error', kind: 'rejection', text: `Unhandled rejection: ${show(e.reason)}`.slice(0, MAX) }), true);

  // WebMCP: tools that the page offers. Firefox 160 has none of its own; if it has, that one stays.

  let webmcp = null;
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const waive = (o) => (o && typeof o === 'object' ? o.wrappedJSObject ?? o : o);

  function offerWebmcp() {
    const tools = new Map();
    const targets = [page.navigator, page.document];
    if (targets.some((t) => t.modelContext !== undefined)) return void (webmcp = { tools, native: true });
    const fail = (m) => {
      throw new window.Error(m);
    };
    const add = (raw) => {
      const def = waive(raw);
      const name = text(def?.name, 100);
      if (!/^[\w.-]{1,64}$/.test(name)) fail('A tool needs a name of letters, digits, _, . and -.');
      if (typeof def.execute !== 'function') fail('A tool needs an execute function.');
      if (tools.size >= 50 && !tools.has(name)) fail('A page offers at most 50 tools.');
      let schema = '{}';
      try {
        schema = text(page.JSON.stringify(def.inputSchema ?? {}), 5000);
        JSON.parse(schema);
      } catch {
        schema = '{}';
      }
      tools.set(name, { name, description: text(def.description, 1000), schema, readOnly: def.annotations?.readOnlyHint === true, def });
    };
    const context = cloneInto({}, window).wrappedJSObject;
    exportFunction(add, context, { defineAs: 'registerTool' });
    exportFunction((name) => void tools.delete(text(name, 100)), context, { defineAs: 'unregisterTool' });
    exportFunction((raw) => {
      tools.clear();
      const list = waive(raw)?.tools;
      for (let i = 0; i < Math.min(list?.length ?? 0, 50); i++) add(list[i]);
    }, context, { defineAs: 'provideContext' });
    exportFunction(() => tools.clear(), context, { defineAs: 'clearContext' });
    const value = cloneInto({ configurable: true, enumerable: true, writable: false }, window).wrappedJSObject;
    value.value = context;
    for (const t of targets) page.Object.defineProperty(t, 'modelContext', value);
    webmcp = { tools, native: false, targets, late: document.readyState !== 'loading' };
  }

  function withdrawWebmcp() {
    for (const t of webmcp.targets ?? []) delete t.modelContext;
    webmcp = null;
  }

  /** Callbacks go into the page as exported functions, because it may not call those of a content script. */
  const settled = (result) =>
    typeof waive(result)?.then === 'function' ? new Promise((ok, no) => waive(result).then(exportFunction(ok, window), exportFunction(no, window))) : Promise.resolve(result);

  async function useTool({ name, input, ms }) {
    const tool = webmcp?.tools.get(name);
    if (!tool) return { error: 'not_found', message: 'The page offers no such tool now. List them again.' };
    const LATE = {};
    try {
      const result = await Promise.race([settled(tool.def.execute(cloneInto(JSON.parse(input), window))), new Promise((r) => setTimeout(r, ms, LATE))]);
      if (result === LATE) return { error: 'timeout', message: 'The tool of the page did not end in time. It may still run.' };
      return { output: typeof result === 'string' ? result.slice(0, 20_000) : text(page.JSON.stringify(waive(result)), 20_000) };
    } catch (e) {
      return { error: 'page_error', message: `The tool of the page failed: ${show(e)}`.slice(0, 500) };
    }
  }

  function set(m) {
    if (m.console !== consoleOn) {
      consoleOn = m.console;
      consoleOn ? hookConsole() : unhookConsole();
      if (!consoleOn) waiting = [];
    }
    if (m.webmcp && !webmcp) offerWebmcp();
    if (!m.webmcp && webmcp) withdrawWebmcp();
    return { id, late: document.readyState !== 'loading' };
  }

  browser.runtime.onMessage.addListener((m) => {
    if (m.cmd === 'forget') return void set({ console: false, webmcp: false });
    if (m.cmd !== 'hooks') return;
    if (m.action === 'off') return Promise.resolve(set({ console: false, webmcp: false }));
    if (self.origin !== m.origin) return Promise.resolve({ error: 'origin_changed', message: 'The document has another origin.' });
    if (m.action === 'set') return Promise.resolve(set(m));
    if (m.action === 'tools') return Promise.resolve({ id, native: webmcp?.native === true, late: webmcp?.late === true, tools: [...(webmcp?.tools.values() ?? [])].map(({ def, ...t }) => t) });
    if (m.action === 'use') return m.doc === id ? useTool(m) : Promise.resolve({ error: 'stale_ref', message: 'The page loaded again. List its tools again.' });
  });
})();
