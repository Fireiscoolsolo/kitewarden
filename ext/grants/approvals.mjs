// Approval cards. One answer serves one waiting call and nothing else.
import { LIMITS } from '../shared/protocol.mjs';

export class Approvals {
  #cards = new Map();
  #next = 1;

  constructor({ now = Date.now, setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t), onChange = () => {} } = {}) {
    Object.assign(this, { now, setTimer, clearTimer, onChange });
  }

  /** What the sidebar shows. */
  get cards() {
    return [...this.#cards.values()].map(({ id, card, shownAt }) => ({ id, ...card, deadline: shownAt === null ? null : shownAt + LIMITS.cardVisibleMs }));
  }

  /** Resolves to true (allowed) or false (denied or too late). `close` ends it without an answer. */
  ask(card) {
    const id = `a${this.#next++}`;
    let settle;
    const answer = new Promise((resolve) => (settle = resolve));
    const entry = { id, card, shownAt: null, settle, timer: this.setTimer(() => this.#end(id, false), LIMITS.cardHiddenMs) };
    this.#cards.set(id, entry);
    this.onChange();
    return { answer, close: () => this.#end(id, false) };
  }

  /** The card became visible in an open sidebar. */
  shown(id) {
    const c = this.#cards.get(id);
    if (!c || c.shownAt !== null) return;
    c.shownAt = this.now();
    this.clearTimer(c.timer);
    c.timer = this.setTimer(() => this.#end(id, false), LIMITS.cardVisibleMs);
    this.onChange();
  }

  /** Returns false when the answer does not count: unknown card, never shown, or too soon after it appeared. */
  answer(id, allow) {
    const c = this.#cards.get(id);
    if (!c || c.shownAt === null || this.now() - c.shownAt < LIMITS.cardGuardMs) return false;
    this.#end(id, allow === true);
    return true;
  }

  #end(id, allow) {
    const c = this.#cards.get(id);
    if (!c) return;
    this.#cards.delete(id);
    this.clearTimer(c.timer);
    c.settle(allow);
    this.onChange();
  }
}
