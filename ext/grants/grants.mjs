// Grant store. Memory only: after a restart of Firefox no grant exists.
// A grant belongs to one session and one tab, and holds for the exact origins the user approved.

export class Grants {
  #list = [];
  #next = 1;

  get all() {
    return this.#list;
  }

  of(sessionId) {
    return this.#list.filter((g) => g.sessionId === sessionId);
  }

  find(sessionId, tabId) {
    return this.#list.find((g) => g.sessionId === sessionId && g.tabId === tabId) ?? null;
  }

  get(id) {
    return this.#list.find((g) => g.id === id) ?? null;
  }

  /** State 'pending' is for a tab that a click just opened and that has not loaded a page yet. */
  add({ sessionId, tabId, origin, level, state = 'active' }) {
    this.remove((g) => g.sessionId === sessionId && g.tabId === tabId);
    const grant = { id: `g${this.#next++}`, sessionId, tabId, origins: [origin], level, state, reason: null };
    this.#list.push(grant);
    return grant;
  }

  /** Returns the removed grants. */
  remove(match) {
    const gone = this.#list.filter(match);
    this.#list = this.#list.filter((g) => !gone.includes(g));
    return gone;
  }

  /** The tab shows another address. Returns the grants this suspends. */
  moved(tabId, origin) {
    const here = this.#list.filter((g) => g.tabId === tabId && (g.state === 'active' || (g.state === 'pending' && origin !== null)));
    const hit = here.filter((g) => !g.origins.includes(origin));
    for (const g of here) g.state = 'active';
    for (const g of hit) Object.assign(g, { state: 'suspended', reason: 'origin' });
    return hit;
  }

  suspend(grant, reason) {
    Object.assign(grant, { state: 'suspended', reason });
  }

  /** Only a user gesture leads here. It adds the origin for this tab only. */
  approveOrigin(grant, origin) {
    if (!grant.origins.includes(origin)) grant.origins.push(origin);
    Object.assign(grant, { state: 'active', reason: null });
  }
}
