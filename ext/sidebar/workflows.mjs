// The workflow part of the sidebar: record, review, edit, preview and replay, save as a skill, GIF recordings.
import { oneLine, originOf } from '../shared/protocol.mjs';
import { $, button, current, el, onPress, options, part, run, send, ui, withSite } from './ui.mjs';

let edit = null; // { id, title, steps, why } while a workflow is open
let preview = null; // { id, tabId, problem, steps }
let skill = null; // { id, name, path, exists, text }

const input = (props, onInput) => {
  const i = el('input', props);
  i.addEventListener('input', () => onInput(props.type === 'checkbox' ? i.checked : i.value));
  return i;
};
const labeled = (text, node) => el('label', {}, text, node);

// Editor

/** A text is asked for at each replay, unless the user decides here to store one. */
function textChoice(s) {
  const choose = (patch) => {
    for (const k of ['old', 'literal', 'value', 'shown']) delete s[k];
    Object.assign(s, patch);
    drawEditor();
  };
  if (s.old) {
    return [
      el('p', { className: 'note warn', textContent: 'An earlier version stored a text for this step. It is not used until you decide.' }),
      ...(s.shown ? [el('pre', { textContent: s.value })] : []),
      el('p', { className: 'row' },
        button(s.shown ? 'Hide text' : 'Show text', () => choose({ old: true, value: s.value, shown: !s.shown }), 'old-show'),
        button('Keep this text in the workflow', () => choose({ literal: true, value: s.value }), 'old-keep'),
        button('Delete it and ask each time', () => choose({ ask: true }), 'old-drop')),
    ];
  }
  if (s.sensitive) return [el('p', { className: 'sub', textContent: 'A personal field: the value is asked for at each replay.' })];
  const store = input({ type: 'checkbox', className: 'literal', checked: s.literal === true }, (on) => choose(on ? { literal: true, ask: false, value: '' } : { ask: true }));
  return [
    el('label', { className: 'check' }, store, 'Store a text in the workflow instead of asking each time'),
    ...(s.literal ? [labeled('Text to store (not for secrets)', input({ className: 'literal-text', value: s.value }, (v) => (s.value = v)))] : []),
  ];
}

function stepRow(s, i) {
  const line = el('div', { className: 'step' }, el('strong', { textContent: `${i + 1}. ${s.line}` }));
  if (s.role !== undefined) line.append(labeled('Element name', input({ value: s.name }, (v) => (s.name = v))));
  if (s.kind === 'fill') line.append(...textChoice(s));
  if (['choose', 'check'].includes(s.kind)) {
    if (!s.ask) line.append(labeled('Value', input({ value: s.value }, (v) => (s.value = v))));
    const ask = input({ type: 'checkbox', checked: s.ask === true }, (v) => {
      s.ask = v;
      if (v) delete s.value;
      else s.value = '';
      drawEditor();
    });
    line.append(el('label', { className: 'check' }, ask, 'Ask each time'));
  }
  line.append(labeled('Note', input({ value: s.note ?? '', maxLength: 200 }, (v) => (s.note = v))));
  const move = (to) => {
    edit.steps.splice(to, 0, ...edit.steps.splice(i, 1));
    drawEditor();
  };
  line.append(el('p', { className: 'row' },
    button('Up', () => i > 0 && move(i - 1)),
    button('Down', () => i < edit.steps.length - 1 && move(i + 1)),
    button('Delete step', () => {
      edit.steps.splice(i, 1);
      drawEditor();
    }, 'del-step')));
  return line;
}

function drawEditor() {
  const box = $('wf-edit');
  box.hidden = !edit;
  if (!edit) return box.replaceChildren();
  box.replaceChildren(
    el('h3', { textContent: edit.id ? 'Edit workflow' : 'Review the recording' }),
    ...(edit.why ? [el('p', { className: 'sub', textContent: edit.why })] : []),
    el('p', { className: 'sub', textContent: 'Typed text and secret fields are not recorded: a replay asks for them. Nothing is stored before Save. A text that looks like a credential is not stored even if you choose to.' }),
    labeled('Name', input({ id: 'wf-title', value: edit.title, maxLength: 80 }, (v) => (edit.title = v))),
    ...edit.steps.map(stepRow),
    el('p', { className: 'row' },
      button('Save', async () => {
        const r = await run('wf_save', { workflow: edit.id, title: edit.title, steps: edit.steps }, 'Saved.');
        if (r.error) return;
        edit = null;
        drawEditor();
      }, 'wf-save'),
      button('Cancel', () => {
        // The editor of a recording closes when the background page has dropped it.
        if (!edit.id) return run('wf_cancel', {}, 'The recording is gone.');
        edit = null;
        drawEditor();
      }, 'wf-cancel')),
  );
}

// Preview and replay

async function showPreview(id) {
  const tab = current();
  const r = tab ? await send('wf_preview', { workflow: id, tabId: tab.id }) : { problem: 'There is no tab.', steps: [] };
  preview = r.error ? null : { id, tabId: tab?.id, values: {}, ...r };
  if (r.error) $('message').textContent = `${r.error.code}: ${r.error.message}`;
  drawPreview();
}

function drawPreview() {
  const box = $('wf-preview');
  box.hidden = !preview;
  if (!preview) return box.replaceChildren();
  const { id, tabId, values } = preview;
  box.replaceChildren(
    el('h3', { textContent: 'Replay in this tab' }),
    el('p', { className: preview.problem ? 'note warn' : 'sub', textContent: preview.problem ?? 'The tab is attached and shows the right site. Every step is checked again when it runs.' }),
    el('ol', {}, ...preview.steps.map((s, i) => {
      const li = el('li', {}, s.line, el('span', { className: 'sub', textContent: [s.needs === 'nothing' ? 'waits for the page' : s.needs === 'you' ? 'you do this' : 'asks for your approval', s.found && (s.found === 'found' ? 'element found' : `element ${s.found.replace('_', ' ')}`)].filter(Boolean).join(' · ') }));
      if (s.ask) li.append(labeled('Value for this replay', input({ className: 'ask', value: values[i] ?? '' }, (v) => (values[i] = v))));
      return li;
    })),
    el('p', { className: 'row' },
      button('Start replay', async () => {
        const r = await run('wf_replay', { workflow: id, tabId, values }, 'Replay started.');
        if (r.error) return;
        preview = null;
        drawPreview();
      }, 'wf-start-replay'),
      button('Attach tab to act', () => withSite(async (tab) => {
        const r = await run('grant', { session: 'sidebar', ...tab, level: 'act' }, 'Attached.');
        if (!r.error) showPreview(id);
      }), 'wf-attach'),
      button('Check again', () => showPreview(id)),
      button('Close', () => {
        preview = null;
        drawPreview();
      })),
  );
}

function drawReplay() {
  part('wf-replay', ui.state.replay, (r) => {
    if (!r) return [];
    const row = el('p', { className: 'row' });
    if (r.status === 'waiting') row.append(button('Continue', () => run('wf_proceed', { done: true }), 'wf-continue'));
    if (r.status === 'failed') row.append(button('Retry step', () => run('wf_retry')), button('Skip step', () => run('wf_proceed', { done: false })));
    if (['running', 'waiting', 'failed'].includes(r.status)) row.append(button('Cancel replay', () => run('wf_stop_replay'), 'wf-stop-replay'));
    else row.append(button('Close', () => run('wf_close_replay'), 'wf-close-replay'));
    return [
      el('h3', { textContent: `Replay: ${r.title} (${r.status})` }),
      el('p', { id: 'replay-message', className: r.status === 'running' ? 'sub' : 'note', textContent: r.message }),
      el('ol', {}, ...r.steps.map((s) => el('li', {}, s.line, el('span', { className: 'sub', textContent: s.state })))),
      row,
    ];
  });
}

// Skill

async function showSkill(id, name) {
  const r = await run('skill', { workflow: id, name, dry: true });
  skill = r.error ? { id, name } : { id, name, ...r };
  drawSkill();
}

async function writeSkill(replace) {
  const r = await run('skill', { workflow: skill.id, name: skill.name, replace });
  if (r.error) return;
  if (!r.written) {
    skill = { ...skill, exists: true, asked: true };
    return drawSkill();
  }
  skill = null;
  drawSkill();
  $('message').textContent = `Saved as ${r.path}`;
}

function drawSkill() {
  const box = $('wf-skill');
  box.hidden = !skill;
  if (!skill) return box.replaceChildren();
  const body = skill.text
    ? [
        el('p', { className: 'sub', textContent: `Will be written to ${skill.path}. Claude uses it only when you call /${skill.name}. It holds no approval.` }),
        el('pre', { id: 'skill-text', tabIndex: 0, textContent: skill.text }),
        ...(skill.exists ? [el('p', { className: 'note warn', textContent: 'A skill of this name exists. Replace it?' })] : []),
        el('p', { className: 'row' }, button(skill.exists ? 'Replace the skill' : 'Save skill', () => writeSkill(skill.exists === true), 'skill-save')),
      ]
    : [];
  box.replaceChildren(
    el('h3', { textContent: 'Save as a Claude Code skill' }),
    labeled('Skill name (lower case letters, digits, hyphens)', input({ id: 'skill-name', value: skill.name }, (v) => (skill.name = v))),
    el('p', { className: 'row' }, button('Show what will be written', () => showSkill(skill.id, skill.name), 'skill-show'), button('Close', () => {
      skill = null;
      drawSkill();
    })),
    ...body,
  );
}

// Lists

function record() {
  withSite(async (tab) => {
    const has = ui.state.grants.some((g) => g.sessionId === 'sidebar' && g.tabId === tab.tabId && g.state === 'active' && g.origins.includes(tab.origin));
    if (!has) {
      const r = await run('grant', { session: 'sidebar', ...tab, level: 'read' });
      if (r.error) return;
    }
    await run('wf_start', { tabId: tab.tabId }, 'Recording. Use the page as usual.');
  });
}

function drawRecording({ rec, draft }) {
  part('wf-rec', rec, (r) =>
    r
      ? [
          el('p', { className: 'note rec', textContent: `${r.paused ? 'Recording paused' : 'Recording'} in ${oneLine(ui.tabs.find((t) => t.id === r.tabId)?.title, 50) || 'a tab'}: ${r.steps.length} steps` }),
          el('ol', {}, ...r.steps.slice(-8).map((s) => el('li', { textContent: s }))),
          el('p', { className: 'row' }, button(r.paused ? 'Resume recording' : 'Pause recording', () => run('wf_pause', { on: !r.paused })), button('Stop', () => run('wf_stop'), 'wf-stop'), button('Cancel', () => run('wf_cancel', {}, 'The recording is gone.'), 'wf-drop')),
        ]
      : [],
  );
  $('wf-record').disabled = Boolean(rec);
  if (draft && !edit) {
    edit = { id: null, title: draft.title, why: draft.why, steps: structuredClone(draft.steps) };
    drawEditor();
  }
  if (!draft && edit && !edit.id) {
    edit = null;
    drawEditor();
  }
}

function drawGifs() {
  part('gifs', ui.state.gifs, (list) =>
    list.map((g) => {
      const row = el('p', { className: 'row' });
      const of = { session: g.session, tabId: g.tabId };
      if (g.on) row.append(button('Stop', () => run('gif_stop', of), 'gif-stop'));
      else if (g.frames) row.append(button('Make GIF', () => run('gif_export', of, 'The GIF is ready. Review it before you share it.'), 'gif-export'));
      if (g.file) row.append(el('a', { href: g.file.url, download: 'kitewarden.gif', textContent: `Save GIF (${Math.ceil(g.file.bytes / 1024)} kB)` }));
      row.append(button('Delete', () => run('gif_clear', of)));
      const who = ui.state.sessions.find((s) => s.id === g.session)?.label ?? 'ended session';
      return el('div', {}, el('p', { className: g.on ? 'note rec' : 'sub', textContent: `${g.on ? 'Recording pictures' : 'Recording'} for ${who}: ${g.frames} frames${g.missed ? `, ${g.missed} missed` : ''}. ${g.why ?? ''}` }), row, ...(g.file ? [el('img', { src: g.file.url, alt: 'Preview of the GIF' })] : []));
    }),
  );
}

export function drawWorkflows() {
  if (!ui.state) return;
  const w = ui.state.workflows;
  drawRecording(w);
  part('wf-list', w.saved, (list) =>
    list.length
      ? list.map((x) => el('li', {}, el('strong', { textContent: x.title }), el('span', { className: 'sub', textContent: `${x.origin} · ${x.steps.length} steps` }), el('p', { className: 'row' },
          button('Replay…', () => showPreview(x.id), 'wf-open-replay'),
          button('Edit', () => {
            edit = { id: x.id, title: x.title, steps: structuredClone(x.steps) };
            drawEditor();
          }, 'wf-edit-saved'),
          button('Save as skill…', () => {
            skill = { id: x.id, name: x.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) };
            drawSkill();
          }, 'wf-skill-open'),
          button('Delete', () => run('wf_delete', { workflow: x.id }, 'Deleted.')))))
      : [el('li', { className: 'sub', textContent: 'None' })],
  );
  drawReplay();
  drawGifs();
  const mine = ui.state.grants.filter((g) => g.state === 'active' && (g.sessionId === 'sidebar' || g.sessionId === ui.chat?.session));
  options('gif-session', mine.map((g) => [`${g.sessionId} ${g.tabId}`, `${oneLine(ui.tabs.find((t) => t.id === g.tabId)?.title, 40)} · ${ui.state.sessions.find((s) => s.id === g.sessionId)?.label ?? ''}`]));
  $('gif-start').disabled = !mine.length;
  const tab = current();
  $('wf-record').title = tab && originOf(tab.url) ? '' : 'This page cannot be recorded.';
}

export function startWorkflows() {
  onPress($('wf-record'), record);
  onPress($('gif-start'), async () => {
    const [session, tabId] = $('gif-session').value.split(' ');
    const r = await send('gif_start', { session, tabId: Number(tabId) });
    $('message').textContent = r.error ? `${r.error.code}: ${r.error.message}` : 'Recording pictures.';
  });
}
