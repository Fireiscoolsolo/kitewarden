// Paired remote clients. The gateway is an optional backend that the user starts; it holds the keys and speaks TLS. Who may come
// in, for how long and until when is decided here, by the user. Without both the switch and the gateway nothing remote exists.
import { LIMITS, ToolError, oneLine } from '../shared/protocol.mjs';

const DAY = 86_400_000;
const TICK_MS = 15_000;

export class Remote {
  /** `close(pipe, code, message)` ends the connection of one remote session. */
  constructor({ store, backends, router, close, onChange = () => {}, now = Date.now, setTimer = (f, ms) => setTimeout(f, ms) }) {
    Object.assign(this, { store, backends, router, close, onChange, now, setTimer });
    this.pairings = [];
    this.code = null; // shown once, in memory only
    this.sessions = new Map(); // pipe -> pairing ID
  }

  async load() {
    const { pairings } = await this.store.get({ pairings: [] });
    // An offer ends with Firefox, because its code was in memory only.
    this.pairings = pairings.filter((p) => p.state !== 'offered');
    const tick = () => {
      this.setTimer(tick, TICK_MS);
      this.check();
    };
    tick();
  }

  #save() {
    this.store.set({ pairings: this.pairings });
    this.onChange();
  }

  #find(id) {
    return this.pairings.find((p) => p.id === id) ?? null;
  }

  get #up() {
    return this.router.switches.remote === true && this.backends.list.get('remote')?.on === true;
  }

  #tell(method, params) {
    if (this.#up) this.backends.command('remote', method, params).catch(() => {}); // the gateway learns it at its next start otherwise
  }

  // The user's choices. Only the sidebar reaches these.

  async offer({ name, days }) {
    if (!this.#up) throw new ToolError('tool_off', 'Start the gateway and turn the remote link on first.');
    const label = oneLine(name, 40);
    if (!label || !Number.isSafeInteger(days) || days < 1 || days > LIMITS.pairDays) throw new ToolError('invalid_argument', `Give a name and 1 to ${LIMITS.pairDays} days.`);
    if (this.pairings.filter((p) => !['revoked', 'expired'].includes(p.state)).length >= LIMITS.pairings) throw new ToolError('limit_reached', 'There are too many pairings. Revoke one first.');
    if (this.code) this.revoke(this.code.id); // one offer at a time
    const until = this.now() + LIMITS.pairMs;
    const { id, code } = await this.backends.command('remote', 'offer', { until });
    this.code = { id, text: String(code), until };
    this.pairings.push({ id, name: label, state: 'offered', created: this.now(), expires: this.now() + days * DAY, fingerprint: null, device: null, seen: null, address: null });
    this.#save();
  }

  /** The user compared the fingerprint with the one that the client shows. */
  allow(id, fingerprint) {
    const p = this.#find(id);
    if (p?.state !== 'pending' || p.fingerprint !== fingerprint) throw new ToolError('not_found', 'That pairing waits for nothing.');
    p.state = 'allowed';
    this.#tell('allow', { id, expires: p.expires });
    this.#save();
  }

  /** Ends its sessions at once. The key of the client works no more. */
  revoke(id) {
    const p = this.#find(id);
    if (!p) throw new ToolError('not_found', 'That pairing is gone.');
    this.#endOf(id, 'revoked');
  }

  /** Takes a pairing that is over out of the list. */
  forget(id) {
    const p = this.#find(id);
    if (!p || !['revoked', 'expired'].includes(p.state)) throw new ToolError('conflict', 'Revoke it first.');
    this.pairings = this.pairings.filter((x) => x !== p);
    this.#save();
  }

  #endOf(id, state) {
    const p = this.#find(id);
    p.state = state;
    if (this.code?.id === id) this.code = null;
    this.#tell('revoke', { id });
    for (const [pipe, of] of [...this.sessions]) if (of === id) this.#endSession(pipe, state);
    this.#save();
  }

  #endSession(pipe, why) {
    this.sessions.delete(pipe);
    this.close(pipe, 'pairing_ended', { revoked: 'The user revoked this pairing.', expired: 'This pairing has expired.', off: 'The user turned the remote link off.' }[why]);
  }

  // Events

  /** The gateway came, went, or has news. What it says of a client is a claim, so it changes nothing but an offer. */
  onEvent(m) {
    if (m.type === 'on') {
      // Keys that no valid pairing has are deleted there.
      this.#tell('sync', { clients: this.pairings.filter((p) => p.state === 'allowed').map(({ id, expires }) => ({ id, expires })) });
    } else if (m.type === 'off' || m.type === 'gone') {
      for (const pipe of [...this.sessions.keys()]) this.#endSession(pipe, 'off');
      if (this.code) this.#endOf(this.code.id, 'revoked');
      for (const p of this.pairings) if (p.state === 'pending') p.state = 'revoked';
      this.#save();
    } else if (m.event === 'paired') {
      const p = this.#find(m.id);
      if (p?.state !== 'offered' || this.code?.id !== m.id || this.now() > this.code.until) return this.#tell('revoke', { id: m.id });
      Object.assign(p, { state: 'pending', fingerprint: oneLine(m.fingerprint, 40), device: oneLine(m.device, 60), address: oneLine(m.address, 60) });
      this.code = null;
      this.#save();
    }
  }

  /** A connection that the gateway opened for a client. Returns the pairing, or throws. */
  admit(pipe, { id, address }) {
    const p = this.#find(id);
    if (!this.#up) throw new ToolError('tool_off', 'The user has not turned the remote link on.');
    if (p?.state !== 'allowed' || this.now() >= p.expires) throw new ToolError('pairing_ended', 'That pairing is not valid.');
    Object.assign(p, { seen: this.now(), address: oneLine(address, 60) });
    this.sessions.set(pipe, id);
    this.#save();
    return p;
  }

  /** Whether a remote session may still make a call. */
  valid(pipe) {
    const p = this.#find(this.sessions.get(pipe));
    return this.#up && p?.state === 'allowed' && this.now() < p.expires;
  }

  gone(pipe) {
    this.sessions.delete(pipe);
  }

  check() {
    if (this.code && this.now() > this.code.until) this.#endOf(this.code.id, 'expired');
    for (const p of this.pairings) if (['allowed', 'pending'].includes(p.state) && this.now() >= p.expires) this.#endOf(p.id, 'expired');
  }

  view() {
    return { code: this.code, pairings: this.pairings.map((p) => ({ ...p, sessions: [...this.sessions.values()].filter((id) => id === p.id).length })) };
  }
}
