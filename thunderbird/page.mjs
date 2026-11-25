// What the user sees and decides in Thunderbird. It holds no rules of its own.
const $ = (id) => document.getElementById(id);
const port = browser.runtime.connect({ name: 'companion' });
const send = (type, data = {}) => port.postMessage({ ...data, type });
const drawn = new Map();
const shown = new Set();

function el(tag, props = {}, ...children) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...children);
  return n;
}
/** Only real user gestures count. */
function onPress(node, fn) {
  node.addEventListener('click', (e) => e.isTrusted && fn(e));
  return node;
}
const button = (textContent, fn, className = '') => onPress(el('button', { textContent, className, type: 'button' }), fn);
function part(id, data, build) {
  const key = JSON.stringify(data);
  if (drawn.get(id) === key) return;
  drawn.set(id, key);
  $(id).replaceChildren(...build(data));
}

const WANTS = { mail_read: 'read a message' };

function draw(s) {
  const state = s.halted ? 'Stopped by you' : s.paused ? 'Paused' : { connected: 'Connected', connecting: 'Connecting', off: 'Not connected' }[s.link.state] ?? 'The helper does not run';
  $('state').textContent = [state, s.link.code === 'helper_missing' ? 'Run the installer with --thunderbird.' : s.link.detail].filter(Boolean).join('. ');
  part('controls', [s.link.state, s.paused, s.halted], () => [
    s.link.state === 'off' ? button('Connect', () => send('connect')) : button('Disconnect', () => send('disconnect')),
    button(s.paused ? 'Resume' : 'Pause', () => send('pause', { on: !s.paused })),
    s.halted ? button('Resume work', () => send('resume')) : button('Stop everything', () => send('halt')),
  ]);
  part('cards', s.approvals, (list) => list.map((a) => el('section', { className: 'card' }, el('h2', { textContent: `${a.sessionLabel} wants to ${WANTS[a.tool] ?? a.tool}` }), el('p', { textContent: a.target }), el('p', { textContent: a.value ?? '' }), el('p', { textContent: a.reason ? `Its reason: ${a.reason}` : '' }), el('p', {}, button('Allow once', () => send('answer', { card: a.id, allow: true }), 'allow'), ' ', button('Deny', () => send('answer', { card: a.id, allow: false }), 'deny')))));
  if (document.visibilityState === 'visible') for (const a of s.approvals) if (!shown.has(a.id)) shown.add(a.id), send('card_shown', { card: a.id });
  part('sessions', [s.sessions, s.accounts, s.shares], ([sessions, accounts, shares]) =>
    sessions.length
      ? sessions.map((x) => el('li', {}, el('strong', { textContent: x.label }), ' ', button('Disconnect', () => send('end_session', { session: x.id })), ...accounts.map((a) => {
          const box = el('input', { type: 'checkbox', checked: (shares[x.id] ?? []).includes(a.id) });
          onPress(box, () => send('share', { session: x.id, account: a.id, on: box.checked }));
          return el('label', {}, box, ` may see subjects of ${a.name}`);
        })))
      : [el('li', { textContent: 'No client is connected.' })],
  );
  part('log', s.log, (list) => [...list].reverse().map((l) => el('li', { textContent: `${new Date(l.at).toLocaleTimeString()}  ${l.tool}  ${l.decision}` })));
}

port.onMessage.addListener((m) => {
  if (m.type === 'state') draw(m.state);
  if (m.type === 'answer') $('message').textContent = m.error ?? '';
});
document.addEventListener('visibilitychange', () => drawn.delete('cards'));
