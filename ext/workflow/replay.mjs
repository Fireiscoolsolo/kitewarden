// Replays a workflow through the router, with the sidebar's own session: every step meets the grants, the origin and the
// approvals of this moment. It holds no right of its own.
import { ToolError } from '../shared/protocol.mjs';
import { stepText } from './workflows.mjs';

const SESSION = 'sidebar';
const FIND_MS = 5000;
const PAGE_MS = 10_000;
const LINE = /^\s*- (\S+)(?: ("(?:[^"\\]|\\.)*"))?.*\[(ref_\w+)\]$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The elements of an interactive outline: role, name and ref. */
export function elements(outline) {
  return outline.split('\n').map((l) => LINE.exec(l)).filter(Boolean).map(([, role, name, ref]) => ({ role, name: name ? JSON.parse(name) : '', ref }));
}

/** The ref of a step's element. The number of equal elements must be the recorded one. */
export function match(step, list) {
  const hits = list.filter((e) => e.role === step.role && e.name === step.name);
  if (!hits.length) return { problem: 'not_found' };
  return hits.length === step.of ? { ref: hits[step.nth].ref } : { problem: 'ambiguous' };
}

const PROBLEM = {
  not_found: 'The element of this step is not on the page.',
  ambiguous: 'The page has another number of such elements than when this was recorded.',
};

export class Replay {
  #next = 1;
  #call = null;

  constructor({ router, onChange = () => {} }) {
    Object.assign(this, { router, onChange });
    this.state = null;
  }

  async #run(tool, args) {
    this.#call = `replay:${this.#next++}`;
    const r = await this.router.call(SESSION, this.#call, tool, args, { user: true });
    this.#call = null;
    if (r.error) throw new ToolError(r.error.code, r.error.message);
    return r.result;
  }

  async #read(w, tabId) {
    const r = await this.#run('read_page', { tabId, filter: 'interactive', max_chars: 200_000 });
    if (r.origin !== w.origin) throw new ToolError('origin_changed', `This workflow belongs to ${w.origin}. The tab shows ${r.origin}.`);
    if (r.truncated) throw new ToolError('too_large', 'The page is too large to find its elements for sure.');
    return elements(r.outline);
  }

  /** What a replay would do and need now. Acts on nothing. */
  async preview(w, tabId) {
    const grant = this.router.grants.find(SESSION, tabId);
    const needsAct = w.steps.some((s) => ['click', 'fill', 'choose', 'check', 'page'].includes(s.kind));
    let list = null;
    let problem = null;
    try {
      list = await this.#read(w, tabId);
      if (needsAct && grant?.level !== 'act') problem = 'read_only_grant: Attach the tab with level "Read and act".';
    } catch (e) {
      problem = `${e.code}: ${e.message}`;
    }
    let samePage = list !== null; // later pages are not here yet
    const steps = w.steps.map((s, i) => {
      if (s.kind === 'page' && i > 0) samePage = false;
      const found = samePage && s.role ? match(s, list).problem ?? 'found' : null;
      const needs = s.kind === 'secret' || s.kind === 'manual' ? 'you' : s.kind === 'page' && i > 0 ? 'nothing' : 'your approval';
      return { line: stepText(s), needs, ask: s.ask === true, found };
    });
    return { problem, steps };
  }

  /** `values` holds the answers to the questions, by step number. They are kept in memory for this replay only. */
  start(w, tabId, values) {
    if (this.state && ['running', 'waiting', 'failed'].includes(this.state.status)) throw new ToolError('conflict', 'A replay runs already.');
    const missing = w.steps.findIndex((s, i) => s.ask && typeof values?.[i] !== 'string');
    if (missing >= 0) throw new ToolError('invalid_argument', `Step ${missing + 1} needs a value.`);
    this.w = structuredClone(w);
    this.values = { ...values };
    this.state = { title: w.title, tabId, at: 0, status: 'running', message: '', steps: w.steps.map((s) => ({ line: stepText(s), state: 'open' })) };
    this.#go();
  }

  #set(patch) {
    Object.assign(this.state, patch);
    this.onChange();
  }

  async #go() {
    const state = this.state;
    while (state.status === 'running' && state.at < this.w.steps.length) {
      const i = state.at;
      const s = this.w.steps[i];
      state.steps[i].state = 'running';
      this.#set({ message: '' });
      if (s.kind === 'secret' || s.kind === 'manual') {
        state.steps[i].state = 'waiting';
        return this.#set({ status: 'waiting', message: 'Do this step in the page, then press Continue.' });
      }
      try {
        await this.#step(s, i, state.tabId);
      } catch (e) {
        if (this.state !== state || state.status !== 'running') return; // cancelled meanwhile
        state.steps[i].state = 'failed';
        return this.#set({ status: 'failed', message: `${e.code ?? 'error'}: ${e.message}` });
      }
      if (this.state !== state || state.status !== 'running') return;
      state.steps[i].state = 'done';
      state.at++;
    }
    if (state.status === 'running') this.#finish({ status: 'done', message: 'All steps are done.' });
  }

  #finish(patch) {
    this.values = null;
    this.#set(patch);
  }

  async #step(s, i, tabId) {
    if (s.kind === 'page') return this.#page(s, i, tabId);
    const end = Date.now() + FIND_MS;
    let m;
    for (;;) {
      this.#alive();
      m = match(s, await this.#read(this.w, tabId));
      if (m.ref || Date.now() > end) break;
      await sleep(250);
    }
    if (m.problem) throw new ToolError(m.problem, PROBLEM[m.problem]);
    this.#alive();
    const reason = `Replay of ${JSON.stringify(this.w.title)}, step ${i + 1}`.slice(0, 200);
    if (s.kind === 'click') return this.#run('computer', { action: 'left_click', tabId, ref: m.ref, reason });
    return this.#run('form_input', { tabId, ref: m.ref, value: s.ask ? this.values[i] : s.value, reason });
  }

  async #page(s, i, tabId) {
    const here = async () => {
      const { tabs } = await this.#run('tabs_context', {});
      const t = tabs.find((x) => x.tabId === tabId);
      if (!t || t.state === 'no_grant') throw new ToolError('no_grant', 'The tab is not attached to this sidebar.');
      if (t.state !== 'active') throw new ToolError('grant_suspended', 'The tab moved to another site.');
      return !t.loading && new URL(t.url).origin === s.origin && new URL(t.url).pathname === s.path;
    };
    if (await here()) return;
    this.#alive();
    if (i === 0) {
      if (s.path.includes('…')) throw new ToolError('not_found', 'The address holds a part that was not recorded. Open the page yourself, then press Retry.');
      await this.#run('navigate', { tabId, url: s.origin + s.path, reason: `Replay of ${JSON.stringify(this.w.title)}, step 1`.slice(0, 200) });
      if (await here()) return;
    }
    const end = Date.now() + PAGE_MS;
    while (Date.now() < end) {
      await sleep(250);
      this.#alive();
      if (await here()) return;
    }
    throw new ToolError('timeout', `The tab did not reach ${s.path} as it did in the recording.`);
  }

  /** No further step after a cancel, also when the cancel fell between two calls. */
  #alive() {
    if (this.state.status !== 'running') throw new ToolError('cancelled', 'The replay was cancelled.');
  }

  /** The user did a step by hand, or gives a failed step up. */
  proceed({ done }) {
    const s = this.state;
    if (!s || !['waiting', 'failed'].includes(s.status)) throw new ToolError('not_found', 'No step waits.');
    s.steps[s.at].state = done ? 'done' : 'skipped';
    s.at++;
    s.status = 'running';
    this.#go();
  }

  retry() {
    if (this.state?.status !== 'failed') throw new ToolError('not_found', 'No step failed.');
    this.state.status = 'running';
    this.#go();
  }

  /** Stops at once and says whether the step under way may have taken effect. */
  cancel() {
    const s = this.state;
    if (!s || !['running', 'waiting', 'failed'].includes(s.status)) return;
    s.status = 'cancelled';
    const id = this.#call;
    const hit = id === null ? [] : this.router.stopCalls(SESSION, 'cancelled', (c) => c.id === id);
    const sent = hit.find((h) => h.sent)?.sent ?? null;
    const failed = s.steps[s.at]?.state === 'failed' && /may have reached/.test(s.message);
    if (s.steps[s.at]) s.steps[s.at].state = sent || failed ? 'unknown' : 'not done';
    const done = s.steps.filter((x) => x.state === 'done').length;
    this.#finish({ message: `Cancelled after ${done} of ${s.steps.length} steps. ${sent || failed ? `The step under way may have taken effect (${sent ?? 'see above'}). Check the page.` : 'The step under way was not carried out.'}` });
  }

  clear() {
    if (this.state && ['running', 'waiting', 'failed'].includes(this.state.status)) throw new ToolError('conflict', 'Cancel the replay first.');
    this.state = null;
    this.onChange();
  }
}
