// Workflows that the user saved and scheduled. A schedule holds a time and nothing else: no grant, no approval, no text. When it
// is due, the run is an ordinary replay in a tab that the user attached to the sidebar, and every step asks as always.
import { LIMITS, ToolError } from '../shared/protocol.mjs';

const LATE_MS = 5 * 60_000; // due longer ago than this: missed, not made up for
const WAIT_MS = 30 * 60_000; // for the user to give a tab or a text
const TICK_MS = 30_000;
const DAY = 86_400_000;
const SESSION = 'sidebar';

/** What was saved, so that a workflow which changed later does not run unseen. */
const digest = (w) => JSON.stringify([w.origin, w.tabs, w.steps]);

/** A schedule with known fields only. */
export function cleanSchedule(m) {
  const kind = m?.kind;
  const bad = (text) => {
    throw new ToolError('invalid_argument', text);
  };
  if (kind === 'once') return Number.isSafeInteger(m.at) ? { kind, at: m.at } : bad('Give a date and time.');
  if (kind === 'every') return Number.isSafeInteger(m.minutes) && m.minutes >= 15 && m.minutes <= 10_080 ? { kind, minutes: m.minutes } : bad('Give 15 to 10080 minutes.');
  if (!['daily', 'weekly'].includes(kind) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(m.time ?? '')) bad('Give a time like 08:30.');
  if (kind === 'daily') return { kind, time: m.time };
  const days = [...new Set(m.days)].filter((d) => Number.isSafeInteger(d) && d >= 0 && d <= 6).sort();
  return days.length ? { kind, time: m.time, days } : bad('Give at least one day.');
}

/** The next time after `from`, or null. Times of day are those of this computer. */
export function nextTime(s, from) {
  if (s.kind === 'once') return s.at > from ? s.at : null;
  if (s.kind === 'every') return from + s.minutes * 60_000;
  const [h, min] = s.time.split(':').map(Number);
  for (let n = 0; n <= 7; n++) {
    const d = new Date(from + n * DAY);
    d.setHours(h, min, 0, 0);
    if (d.getTime() > from && (s.kind === 'daily' || s.days.includes(d.getDay()))) return d.getTime();
  }
  return null;
}

export class Schedules {
  constructor({ store, workflows, replay, router, onChange = () => {}, now = Date.now, setTimer = (f, ms) => setTimeout(f, ms), uuid = () => crypto.randomUUID() }) {
    Object.assign(this, { store, workflows, replay, router, onChange, now, setTimer, uuid });
    this.list = [];
    this.run = null; // the one that is due: { schedule, record, since, values, started, state }
    this.due = []; // others that became due meanwhile
  }

  async load() {
    const { schedules } = await this.store.get({ schedules: [] });
    this.list = schedules;
    for (const s of this.list) {
      // What ran when Firefox closed did not go on.
      for (const r of s.runs) if (!r.ended) this.#close(r, 'interrupted', 'Firefox closed.');
      if (s.on && s.next !== null && this.now() - s.next > LATE_MS) this.#missed(s, 'Firefox was not running.');
    }
    this.#tick();
  }

  #save() {
    this.store.set({ schedules: this.list });
    this.onChange();
  }

  // The user's choices. Only the sidebar reaches these, and no tool does.

  add(m) {
    const w = this.workflows.get(m.workflow);
    if (this.list.length >= LIMITS.schedules) throw new ToolError('limit_reached', 'There are too many schedules. Delete one first.');
    const when = cleanSchedule(m);
    const next = nextTime(when, this.now());
    if (next === null) throw new ToolError('invalid_argument', 'That time is over.');
    const id = this.uuid();
    this.list.push({ id, workflow: w.id, title: w.title, digest: digest(w), ...when, on: true, next, created: this.now(), runs: [] });
    this.#save();
    return { id };
  }

  #get(id) {
    const s = this.list.find((x) => x.id === id);
    if (!s) throw new ToolError('not_found', 'That schedule is gone.');
    return s;
  }

  set(id, on) {
    const s = this.#get(id);
    if (on) {
      const w = this.workflows.get(s.workflow);
      const next = nextTime(s, this.now());
      if (next === null) throw new ToolError('invalid_argument', 'That time is over.');
      Object.assign(s, { title: w.title, digest: digest(w), next });
    } else {
      s.next = null;
      this.cancel(id);
    }
    s.on = on;
    this.#save();
  }

  remove(id) {
    this.#get(id);
    this.cancel(id);
    this.list = this.list.filter((s) => s.id !== id);
    this.#save();
  }

  /** Ends the run of a schedule, also one that waits its turn. The schedule itself stays. */
  cancel(id) {
    for (const x of this.due.filter((d) => d.schedule.id === id)) this.#close(x.record, 'cancelled', 'You cancelled it before it began.');
    this.due = this.due.filter((d) => d.schedule.id !== id);
    const run = this.run;
    if (run?.schedule.id !== id) return;
    if (run.started && this.replay.state === run.state) this.replay.cancel();
    if (this.run === run) this.#end('cancelled', run.started ? run.state.message : 'You cancelled it before it began.');
  }

  /** A stop of everything ends what is due as well. */
  cancelAll() {
    for (const s of this.list) this.cancel(s.id);
  }

  /** The texts that the steps ask for. They are kept for this run only. */
  answer(id, values) {
    if (this.run?.schedule.id !== id || this.run.started) throw new ToolError('not_found', 'That run waits for nothing.');
    this.run.values = { ...values };
    this.#advance();
  }

  // Running

  #tick() {
    this.setTimer(() => this.#tick(), TICK_MS);
    this.check();
  }

  /** Looks at the clock. */
  check() {
    const now = this.now();
    for (const s of this.list) {
      if (!s.on || s.next === null || s.next > now) continue;
      if (now - s.next > LATE_MS) this.#missed(s, 'The computer was asleep.');
      else this.#begin(s);
    }
    this.#advance();
  }

  #record(s, state, message) {
    const r = { at: this.now(), state, message, ended: null };
    s.runs.push(r);
    s.runs.splice(0, Math.max(0, s.runs.length - LIMITS.runs));
    s.next = nextTime(s, this.now());
    if (s.next === null) s.on = false;
    return r;
  }

  #close(record, state, message) {
    Object.assign(record, { state, message, ended: this.now() });
    this.#save();
  }

  #missed(s, message) {
    this.#close(this.#record(s, 'missed', message), 'missed', message);
  }

  #begin(s) {
    const open = this.run?.schedule === s || this.due.some((d) => d.schedule === s);
    if (open) return this.#missed(s, 'The run before it was still open.');
    this.due.push({ schedule: s, record: this.#record(s, 'waiting', 'Waits for the run before it.'), since: this.now(), values: {}, started: false, state: null });
    this.#save();
  }

  #end(state, message) {
    const run = this.run;
    this.run = null;
    run.values = null;
    this.#close(run.record, state, message);
    this.#advance();
  }

  #note(state, message) {
    const r = this.run.record;
    if (r.message === message && r.state === state) return;
    Object.assign(r, { state, message });
    this.#save();
  }

  /** One step further with the run that is due. Called on the clock and whenever something changed. */
  #advance() {
    if (!this.run) {
      this.run = this.due.shift() ?? null;
      if (!this.run) return;
    }
    const { schedule: s, record, started, since, values } = this.run;
    if (started) return this.#watch();
    if (this.router.halted || this.router.paused) return this.#end('missed', 'You had stopped or paused Firefox Companion.');
    if (this.now() - since > WAIT_MS) return this.#end('missed', record.message);
    let w;
    try {
      w = this.workflows.get(s.workflow);
    } catch {
      Object.assign(s, { on: false, next: null });
      return this.#end('failed', 'The workflow was deleted.');
    }
    if (digest(w) !== s.digest) {
      Object.assign(s, { on: false, next: null });
      return this.#end('failed', 'The workflow changed after it was scheduled. Turn the schedule on again to use it as it is now.');
    }
    if (this.replay.state && ['running', 'waiting', 'failed'].includes(this.replay.state.status)) return this.#note('needs you', 'Another replay is open.');
    const tabs = this.router.grants.of(SESSION).filter((g) => g.state === 'active' && g.origins.includes(w.origin));
    if (tabs.length !== 1) return this.#note('needs you', tabs.length ? `Several attached tabs show ${w.origin}. Keep one.` : `Attach a tab on ${w.origin} to "This sidebar".`);
    if (w.steps.some((x, i) => x.ask && typeof values[i] !== 'string')) return this.#note('needs you', 'Give the texts that its steps ask for.');
    this.run.started = true;
    this.replay.start(w, tabs[0].tabId, values);
    this.run.state = this.replay.state;
    this.#note('running', 'Each step asks as always.');
  }

  #watch() {
    const { state, since } = this.run;
    if (this.replay.state !== state) return this.#end('cancelled', 'The replay was closed.');
    if (state.status === 'done') return this.#end('done', state.message);
    if (state.status === 'cancelled') return this.#end('cancelled', state.message);
    const waits = ['waiting', 'failed'].includes(state.status);
    if (waits && this.now() - since > WAIT_MS) {
      const why = state.message;
      this.replay.cancel();
      if (this.run?.state === state) this.#end('failed', why);
      return;
    }
    this.#note(waits ? 'needs you' : 'running', state.message || 'Each step asks as always.');
  }

  /** Something changed: grants, the replay, a pause. */
  changed() {
    if (this.run) this.#advance();
  }

  /** For the sidebar: no texts. */
  view() {
    return this.list.map(({ digest: _, ...s }) => ({ ...s, runs: s.runs.slice(-5), open: this.run?.schedule.id === s.id || this.due.some((x) => x.schedule.id === s.id), asks: this.run?.schedule.id === s.id && !this.run.started ? this.#asks(s) : [] }));
  }

  #asks(s) {
    try {
      return this.workflows.get(s.workflow).steps.flatMap((x, i) => (x.ask ? [{ step: i, name: `${x.role} ${JSON.stringify(x.name)}`, given: typeof this.run.values[i] === 'string' }] : []));
    } catch {
      return [];
    }
  }
}
