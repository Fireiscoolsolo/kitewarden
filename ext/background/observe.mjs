// Console entries, requests and bodies of granted tabs, in memory only. A capture belongs to one grant: it starts with the
// grant while the user has the switch on, and ends with its release, suspension or pause. Nothing hooks any other tab.
import { LIMITS, VIRTUAL, originOf } from '../shared/protocol.mjs';
import { redactBody, redactHeaders, redactText, redactUrl } from '../shared/redact.mjs';

const TEXT_TYPE = /json|xml|text|javascript|x-www-form-urlencoded/i;
const levelOf = { trace: 'debug' };

export class Observer {
  /** `walk(grant, fn)` runs fn(frame, origin) for each frame that the grant covers. `send(tabId, frame, message)` reaches hooks.js. */
  constructor({ api, grants, router, webRequest = () => null, walk, send, now = Date.now, setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t) }) {
    Object.assign(this, { api, grants, router, webRequest, walk, send, now, setTimer, clearTimer });
    this.captures = new Map(); // grant ID -> capture
    this.listening = new Map(); // tab -> function that ends its listeners
  }

  #wants(g) {
    const r = this.router;
    return g.state === 'active' && this.grants.get(g.id) === g && !r.paused && !r.halted && !r.stoppedTabs.has(g.tabId);
  }

  get #hooks() {
    const s = this.router.switches;
    return { console: s.console === true, webmcp: s.webmcp === true };
  }

  /** Brings captures in line with grants and switches. Cheap when nothing changed. */
  sync() {
    const s = this.router.switches;
    for (const [id, c] of this.captures) if (!this.#wants(c.grant)) this.#end(id);
    for (const g of this.grants.all) {
      if (!this.#wants(g) || g.tabId >= VIRTUAL) continue;
      let c = this.captures.get(g.id);
      if (!c) this.captures.set(g.id, (c = { grant: g, origin: g.origins.at(-1), doc: null, hooked: '', since: this.now(), console: [], errors: [], requests: new Map(), networkSince: null, bodies: null }));
      const want = JSON.stringify([this.#hooks, g.frames]);
      if (c.hooked !== want) {
        c.hooked = want;
        if (!s.console) Object.assign(c, { console: [], errors: [] });
        this.#hook(c);
      }
      if (s.network) c.networkSince ??= this.now();
      else Object.assign(c, { networkSince: null, requests: new Map() });
      if (!s.network || !s.bodies) this.stopBodies(g.id);
    }
    this.#listen();
  }

  /** The tab began a new document, or moved inside the one that it has. `url` saves a question to the browser. */
  tabLoading(tabId, url) {
    for (const c of this.captures.values()) if (c.grant.tabId === tabId) this.#hook(c, url);
  }

  async #hook(c, url = null) {
    const hooks = this.#hooks;
    const g = c.grant;
    if (!hooks.console && !hooks.webmcp) return c.doc && this.#unhook(c);
    await this.walk(g, async (frame, origin) => {
      if (!this.#wants(g) || this.captures.get(g.id) !== c) return;
      const r = await this.send(g.tabId, frame, { cmd: 'hooks', action: 'set', origin, ...this.#hooks });
      if (frame || !r?.id || r.id === c.doc) return;
      // A new document in the tab: its entries begin here.
      if (c.doc) Object.assign(c, { console: [], errors: [] });
      Object.assign(c, { doc: r.id, since: this.now(), late: r.late === true });
    }, url).catch(() => {});
    if (!this.#wants(g)) this.#unhook(c);
  }

  #unhook(c) {
    c.doc = null;
    if (![...this.captures.values()].some((o) => o !== c && o.grant.tabId === c.grant.tabId)) this.send(c.grant.tabId, null, { cmd: 'hooks', action: 'off' });
  }

  #end(id) {
    const c = this.captures.get(id);
    this.stopBodies(id);
    this.captures.delete(id);
    this.#unhook(c);
    this.api.quiet?.(c.grant.tabId);
  }

  /** A release, a suspension, a pause or a stop. */
  grantEnded(g) {
    if (this.captures.has(g.id)) this.#end(g.id);
    this.#listen();
  }

  of(sessionId, tabId) {
    const g = this.grants.find(sessionId, tabId);
    return (g && this.captures.get(g.id)) ?? null;
  }

  // Console

  /** Entries of a content script. The sender is what Firefox says, not what the message says. */
  onConsole(entries, { tab, frameId, origin }) {
    if (!Array.isArray(entries) || !this.router.switches.console) return;
    for (const c of this.captures.values()) {
      const g = c.grant;
      if (g.tabId !== tab.id || !this.#wants(g)) continue;
      if (!(g.origins.includes(origin) && originOf(tab.url) === origin) && !(frameId !== 0 && g.frames.includes(origin))) continue;
      for (const e of entries.slice(0, 1000)) this.#keep(c, { at: Number(e.at) || this.now(), level: String(e.level), kind: String(e.kind), text: redactText(String(e.text).slice(0, LIMITS.entryChars)), frame: frameId, origin, ...(e.url && { url: redactUrl(String(e.url)) }), ...(Number.isSafeInteger(e.line) && { line: e.line }) });
    }
  }

  #keep(c, entry) {
    c.console.push(entry);
    if (c.console.length > LIMITS.logEntries) c.console.shift();
    if (entry.level === 'error') c.errors.push(entry.text);
  }

  /** Errors that are new since the last reply, for the reply of an action. */
  takeErrors(sessionId, tabId) {
    const c = this.of(sessionId, tabId);
    if (!c?.errors.length) return null;
    const [first] = c.errors;
    const n = c.errors.splice(0).length;
    return { new: n, first: first.split('\n')[0].slice(0, 300) };
  }

  // Requests, from Firefox itself. Page script can neither add nor hide one.

  #listen() {
    const want = new Set([...this.captures.values()].filter((c) => c.networkSince !== null).map((c) => c.grant.tabId));
    for (const [tabId, end] of this.listening) if (!want.has(tabId)) end(), this.listening.delete(tabId);
    const wr = this.webRequest();
    if (!wr) return;
    for (const tabId of want) {
      if (this.listening.has(tabId)) continue;
      const filter = { urls: ['<all_urls>'], tabId };
      const on = [];
      const add = (event, fn, extra) => {
        wr[event].addListener(fn, filter, ...(extra ? [extra] : []));
        on.push(() => wr[event].removeListener(fn));
      };
      add('onBeforeRequest', (d) => this.#began(tabId, d), ['requestBody']);
      add('onSendHeaders', (d) => this.#patch(tabId, d, { requestHeaders: redactHeaders(d.requestHeaders) }), ['requestHeaders']);
      add('onBeforeRedirect', (d) => this.#redirected(tabId, d));
      add('onResponseStarted', (d) => this.#patch(tabId, d, { status: d.statusCode, responseHeaders: redactHeaders(d.responseHeaders), fromCache: d.fromCache === true }), ['responseHeaders']);
      add('onCompleted', (d) => this.#patch(tabId, d, { state: 'done', status: d.statusCode, ended: d.timeStamp, bytes: d.responseSize ?? null }));
      add('onErrorOccurred', (d) => this.#patch(tabId, d, { state: 'failed', error: redactText(d.error ?? ''), ended: d.timeStamp }));
      this.listening.set(tabId, () => on.forEach((f) => f()));
    }
  }

  /** The captures whose grant covers the document that made the request. */
  #covering(tabId, d) {
    const by = d.type === 'main_frame' ? originOf(d.url) : originOf(d.documentUrl ?? d.originUrl);
    return [...this.captures.values()].filter(({ grant: g, networkSince }) => networkSince !== null && g.tabId === tabId && this.#wants(g) && by !== null && (g.origins.includes(by) || (d.frameId !== 0 && g.frames.includes(by))));
  }

  #began(tabId, d) {
    for (const c of this.#covering(tabId, d)) {
      if (c.requests.has(d.requestId)) continue; // after a redirect
      c.requests.set(d.requestId, { id: d.requestId, method: d.method, url: redactUrl(d.url), raw: d.url, type: d.type, frame: d.frameId, started: d.timeStamp, state: 'running', status: null, redirects: [] });
      if (c.requests.size > LIMITS.logEntries) c.requests.delete(c.requests.keys().next().value);
      if (c.bodies && d.requestBody) this.#requestBody(c, d);
    }
  }

  #entries = (tabId, id) => [...this.captures.values()].filter((c) => c.grant.tabId === tabId).map((c) => c.requests.get(id)).filter(Boolean);

  #patch(tabId, d, change) {
    for (const e of this.#entries(tabId, d.requestId)) Object.assign(e, change);
  }

  #redirected(tabId, d) {
    for (const c of this.captures.values()) {
      const e = c.grant.tabId === tabId && c.requests.get(d.requestId);
      if (!e) continue;
      // A move of the tab to another site is told as that site only.
      const to = d.type === 'main_frame' && !c.grant.origins.includes(originOf(d.redirectUrl)) ? originOf(d.redirectUrl) ?? 'another scheme' : redactUrl(d.redirectUrl);
      e.redirects.push({ status: d.statusCode, from: e.url, to });
      Object.assign(e, { url: to, raw: d.redirectUrl });
    }
  }

  /** What a client may see of a capture's requests. */
  list(c, a) {
    const glob = a.url && new RegExp(a.url.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*'), 'i');
    const state = (e) => (e.state !== 'done' ? e.state : `${Math.floor(e.status / 100)}xx`);
    const hits = [...c.requests.values()].filter((e) => (!glob || glob.test(e.url)) && (!a.method || e.method === a.method.toUpperCase()) && (!a.status || state(e) === a.status) && (!a.type || e.type === a.type));
    const shown = hits.slice(-(a.limit ?? 100)).map(({ raw, requestHeaders, responseHeaders, started, ended, ...e }) => ({ ...e, started: Math.round(started), ms: ended ? Math.round(ended - started) : null, ...(a.headers && { request_headers: requestHeaders ?? [], response_headers: responseHeaders ?? [] }) }));
    return { total: hits.length, requests: shown };
  }

  // Bodies. Each chunk goes on to the page unchanged.

  startBodies(c) {
    this.stopBodies(c.grant.id);
    const wr = this.webRequest();
    const tabId = c.grant.tabId;
    const b = (c.bodies = { since: this.now(), kept: new Map(), bytes: 0, end: null });
    const typeOf = (d) => d.responseHeaders?.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '';
    const types = new Map();
    const mine = (d) => c.bodies === b && this.#covering(tabId, d).includes(c);
    const onHeaders = (d) => void (mine(d) && types.set(d.requestId, typeOf(d)));
    // The filter is there before the request is sent, so that no byte of the answer can pass it.
    const onRequest = (d) => {
      if (!mine(d)) return;
      const entry = { ...b.kept.get(d.requestId), response_type: '', response_bytes: 0, response: null, response_cut: false };
      b.kept.set(d.requestId, entry);
      const filter = wr.filterResponseData(d.requestId);
      const chunks = [];
      let size = 0;
      filter.ondata = (ev) => {
        filter.write(ev.data);
        entry.response_bytes += ev.data.byteLength;
        entry.response_type = types.get(d.requestId) ?? entry.response_type;
        if (entry.response_type && !TEXT_TYPE.test(entry.response_type)) return;
        const room = Math.min(LIMITS.bodyBytes - size, LIMITS.bodiesBytes - b.bytes);
        if (c.bodies !== b || room <= 0) return void (entry.response_cut = true);
        const part = new Uint8Array(ev.data.slice(0, room));
        if (part.length < ev.data.byteLength) entry.response_cut = true;
        chunks.push(part);
        size += part.length;
        b.bytes += part.length;
      };
      filter.onstop = () => {
        filter.close();
        if (c.bodies !== b) return;
        entry.response_type = types.get(d.requestId) ?? '';
        if (!TEXT_TYPE.test(entry.response_type)) return void (entry.note = 'not text, so not kept');
        const all = new Uint8Array(size);
        chunks.reduce((at, p) => (all.set(p, at), at + p.length), 0);
        entry.response = redactBody(new TextDecoder().decode(all), entry.response_type);
      };
      filter.onerror = () => (entry.note = redactText(filter.error ?? 'not read'));
    };
    const filter = { urls: ['<all_urls>'], tabId };
    wr.onBeforeRequest.addListener(onRequest, filter, ['blocking']);
    wr.onHeadersReceived.addListener(onHeaders, filter, ['blocking', 'responseHeaders']); // the type is known before the first byte
    const timer = this.setTimer(() => this.stopBodies(c.grant.id), LIMITS.bodiesMs);
    b.end = () => {
      this.clearTimer(timer);
      wr.onBeforeRequest.removeListener(onRequest);
      wr.onHeadersReceived.removeListener(onHeaders);
    };
  }

  #requestBody(c, d) {
    const raw = d.requestBody;
    let body = null;
    if (raw.formData) body = redactBody(new URLSearchParams(Object.entries(raw.formData).flatMap(([k, v]) => v.map((x) => [k, x]))).toString(), 'application/x-www-form-urlencoded');
    else if (raw.raw?.every((p) => p.bytes)) {
      const size = raw.raw.reduce((n, p) => n + p.bytes.byteLength, 0);
      body = size > LIMITS.bodyBytes ? `(${size} bytes, not kept)` : redactBody(raw.raw.map((p) => new TextDecoder().decode(p.bytes)).join(''));
    }
    if (body !== null) c.bodies.kept.set(d.requestId, { ...c.bodies.kept.get(d.requestId), request: body });
  }

  /** Ends the capture of bodies and deletes what it kept. */
  stopBodies(grantId) {
    const c = this.captures.get(grantId);
    c?.bodies?.end?.();
    if (c) c.bodies = null;
  }

  /** The same entries from an isolated tab, in the same form and with the same masks. */
  static fromBackend(g, list) {
    const ok = (o, frame) => g.origins.includes(o) || (frame !== 0 && g.frames.includes(o));
    return {
      console: list.console.filter((e) => ok(e.origin, e.frame)).map((e) => ({ ...e, level: levelOf[e.level] ?? e.level, text: redactText(String(e.text).slice(0, LIMITS.entryChars)), ...(e.url && { url: redactUrl(e.url) }) })),
      requests: new Map(list.requests.filter((e) => ok(e.origin, e.frame)).map(({ requestHeaders, responseHeaders, origin, ...e }) => [e.id, { ...e, url: redactUrl(e.url), requestHeaders: redactHeaders(requestHeaders), responseHeaders: redactHeaders(responseHeaders), redirects: [], ...(e.error && { error: redactText(e.error) }) }])),
    };
  }
}
