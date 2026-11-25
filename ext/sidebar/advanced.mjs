// Optional backends, scheduled workflows and the remote link. Shows what the background page says and sends the user's gestures.
import { $, button, el, onPress, options, part, run, ui } from './ui.mjs';

const when = (ms) => (ms === null ? 'never' : new Date(ms).toLocaleString());
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const sub = (textContent) => el('span', { className: 'sub', textContent });

function drawBackends() {
  part('backends', ui.state.backends, (list) =>
    list.map((b) => {
      const li = el('li', { id: `backend-${b.id}` }, el('strong', { textContent: b.title }), ' ', sub(b.state === 'not running' ? 'not running' : `${b.state} · version ${b.version} · ${b.channel}${b.detail ? ` · ${b.detail}` : ''}`), el('p', { className: 'sub', textContent: b.permissions }));
      if (b.state === 'not running') li.append(el('p', { className: 'sub', textContent: b.setup }));
      else li.append(el('p', { className: 'row' }, b.state === 'on' ? button('Turn off', () => run('set_switch', { name: b.id, on: false }, 'Off.'), 'backend-off') : button('Turn on', () => run('set_switch', { name: b.id, on: true }, 'On until it disconnects.'), 'backend-on')));
      return li;
    }),
  );
}

// Schedules

const timeOf = (s) => ({ once: () => `once, ${when(s.at)}`, every: () => `every ${s.minutes} minutes`, daily: () => `daily at ${s.time}`, weekly: () => `${s.days.map((d) => DAYS[d]).join(', ')} at ${s.time}` })[s.kind]();

function drawSchedules() {
  const { saved } = ui.state.workflows;
  options('sched-workflow', saved.map((w) => [w.id, w.title]));
  $('sched-add').disabled = !saved.length;
  for (const p of document.querySelectorAll('[data-kind]')) p.hidden = !p.dataset.kind.split(' ').includes($('sched-kind').value);
  part('schedules', ui.state.schedules, (list) =>
    list.length
      ? list.map((s) => {
          const last = s.runs.at(-1);
          const li = el('li', {}, el('strong', { textContent: s.title }), ' ', sub(`${timeOf(s)} · ${s.on ? `next ${when(s.next)}` : 'off'}`));
          if (last) li.append(el('p', { className: 'sched-state', textContent: `${last.state}: ${last.message}` }), el('p', { className: 'sub', textContent: `${when(last.at)}${s.runs.length > 1 ? ` · before: ${s.runs.slice(0, -1).map((r) => r.state).join(', ')}` : ''}` }));
          if (s.asks.length) {
            const fields = s.asks.map((a) => [a.step, el('input', { className: 'sched-value' }), a.name]);
            li.append(...fields.map(([, input, name]) => el('label', {}, `${name} `, input)), el('p', { className: 'row' }, button('Use these texts', () => run('sched_answer', { schedule: s.id, values: Object.fromEntries(fields.map(([step, input]) => [step, input.value])) }, 'Given for this run.'), 'sched-answer')));
          }
          const row = el('p', { className: 'row' });
          if (s.open) row.append(button('Cancel this run', () => run('sched_cancel', { schedule: s.id }, 'Cancelled.'), 'sched-cancel'));
          row.append(button(s.on ? 'Turn off' : 'Turn on', () => run('sched_set', { schedule: s.id, on: !s.on }, s.on ? 'Off.' : 'On.'), 'sched-toggle'), button('Delete schedule', () => run('sched_remove', { schedule: s.id }, 'Deleted.'), 'sched-remove'));
          li.append(row);
          return li;
        })
      : [el('li', { className: 'sub', textContent: 'None. Nothing runs by itself.' })],
  );
}

function addSchedule() {
  const at = new Date($('sched-at').value).getTime();
  run('sched_add', { workflow: $('sched-workflow').value, kind: $('sched-kind').value, time: $('sched-time').value, minutes: Number($('sched-minutes').value), at: Number.isNaN(at) ? null : at, days: [...document.querySelectorAll('#sched-days input:checked')].map((x) => Number(x.value)) }, 'Scheduled.');
}

// Remote link

const WAITS = { offered: 'waits for the client', pending: 'waits for you', allowed: 'allowed', revoked: 'revoked', expired: 'expired' };

function drawRemote() {
  const { code, pairings } = ui.state.remote;
  part('remote-code', code, (c) => (c ? [el('p', {}, 'Code for the other computer, for one use until ', when(c.until), ':'), el('p', { className: 'code', textContent: c.text })] : []));
  part('pairings', pairings, (list) =>
    list.length
      ? list.map((p) => {
          const li = el('li', {}, el('strong', { textContent: p.name }), ' ', sub(`${WAITS[p.state]} · until ${when(p.expires)}${p.sessions ? ` · ${p.sessions} connected` : ''}`));
          if (p.fingerprint) li.append(el('p', { className: 'sub', textContent: `It calls itself ${p.device}, from ${p.address}. Last seen ${when(p.seen)}.` }), el('p', { className: 'fingerprint', textContent: `Fingerprint ${p.fingerprint}` }));
          const row = el('p', { className: 'row' });
          if (p.state === 'pending') row.append(button('Same fingerprint there: allow', () => run('remote_allow', { pairing: p.id, fingerprint: p.fingerprint }, 'Allowed.'), 'remote-allow'));
          row.append(['revoked', 'expired'].includes(p.state) ? button('Remove from the list', () => run('remote_forget', { pairing: p.id }), 'remote-forget') : button('Revoke', () => run('remote_revoke', { pairing: p.id }, 'Revoked.'), 'remote-revoke'));
          li.append(row);
          return li;
        })
      : [el('li', { className: 'sub', textContent: 'None.' })],
  );
  $('remote-offer').disabled = ui.state.backends.find((b) => b.id === 'remote')?.state !== 'on';
}

export function drawAdvanced() {
  drawBackends();
  drawSchedules();
  drawRemote();
}

export function startAdvanced() {
  onPress($('sched-add'), addSchedule);
  $('sched-kind').addEventListener('change', () => ui.state && drawSchedules());
  onPress($('remote-offer'), () => run('remote_offer', { name: $('remote-name').value, days: Number($('remote-days').value) }, 'Enter the code on the other computer.'));
  onPress($('containers-ok'), () => browser.permissions.request({ permissions: ['cookies'] }).then((ok) => ($('message').textContent = ok ? 'Tabs may be opened in containers.' : 'Firefox did not allow it.')));
  $('sched-days').replaceChildren(...DAYS.map((d, i) => el('label', { className: 'check' }, el('input', { type: 'checkbox', value: String(i) }), d)));
}
