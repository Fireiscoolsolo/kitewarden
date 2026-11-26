// Live: the installed helper starts the user's own Claude Code. Firefox is played by the test, nothing else.
// Shows launch and streaming, a second message that needs the first, resume after the process ended (also after the helper
// ended), the MCP link of the run, and stop. Exit 3: Claude Code is not signed in.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FakeFirefox, installHome, powershell, root, until } from '../helpers.mjs';

for (const k of Object.keys(process.env)) if (/^CLAUDE/.test(k)) delete process.env[k]; // as in a Firefox the user started

const home = installHome();
const result = { at: new Date().toISOString(), model: 'haiku', checks: [] };
let ff = new FakeFirefox(home);
let code = 1;
const session = randomUUID();

/** One message through the helper. `during` runs while the process lives. */
async function say(text, { resume, during, extras = false } = {}) {
  const run = randomUUID();
  const ticket = randomBytes(32).toString('hex');
  const from = ff.messages.length;
  const start = Date.now();
  ff.send({ type: 'chat_run', run, session: extras ? randomUUID() : session, resume: resume === true, model: 'haiku', extras, ticket, input: JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) });
  await during?.(run);
  const exit = await ff.wait('end of the run', (m) => m.type === 'chat_exit' && m.run === run, 120_000);
  let line = '';
  const events = [];
  for (const m of ff.messages.slice(from)) {
    if (m.type !== 'chat_event' || m.run !== run) continue;
    line += m.part;
    if (!m.end) continue;
    events.push(JSON.parse(line));
    line = '';
  }
  const deltas = events.filter((e) => e.type === 'stream_event' && e.event.delta?.type === 'text_delta');
  return { run, ticket, exit, events, deltas, ms: Date.now() - start, init: events.find((e) => e.subtype === 'init'), last: events.findLast((e) => e.type === 'result') };
}
const check = (name, facts) => {
  result.checks.push({ name, ...facts });
  console.log(`ok  ${name}: ${JSON.stringify(facts)}`);
};
const claudes = () => Number(powershell(`@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${home.dir.replaceAll("'", "''")}*' -and $_.Name -ne 'kitewarden-host.exe' -and $_.Name -ne 'powershell.exe' }).Count`));

try {
  await ff.wait('hello', (m) => m.type === 'hello');
  ff.send({ type: 'claude_info', id: 'i1' });
  const { result: info } = await ff.wait('claude_info', (m) => m.type === 'reply' && m.id === 'i1', 70_000);
  result.claude = info.version;
  assert.deepEqual(Object.keys(info).sort(), ['authMethod', 'installed', 'plugins', 'signedIn', 'version'], 'no account data');
  if (!info.signedIn) {
    console.log('PENDING: Claude Code is not signed in. Run "claude auth login", then run this again.');
    code = 3;
    throw Object.assign(new Error('not signed in'), { quiet: true });
  }
  check('account check through the helper', { installed: info.installed, version: info.version, signedIn: info.signedIn, plugins: info.plugins.length });

  const a = await say('Remember the code word KESTREL-41 for later. Then write the numbers from 1 to 30, separated by commas.');
  assert.equal(a.exit.code, 0, a.exit.detail);
  assert.ok(a.deltas.length > 1, 'text arrives in parts');
  assert.equal(a.init.session_id, session);
  assert.deepEqual(a.init.mcp_servers.map((s) => [s.name, s.status]), [['kitewarden', 'connected']]);
  assert.ok(a.init.tools.every((t) => t.startsWith('mcp__kitewarden__')), `tools: ${a.init.tools}`);
  const hello = ff.messages.find((m) => m.type === 'from_client' && JSON.parse(m.body).ticket === a.ticket);
  assert.ok(hello, 'the MCP server of the run presented the ticket of the run');
  check('launch and streaming', { exit: a.exit.code, text_parts: a.deltas.length, ms: a.ms, apiKeySource: a.init.apiKeySource, tools: a.init.tools.length, ticket: true, cost_usd: a.last.total_cost_usd });

  const b = await say('What was the code word? Answer with the code word only.', { resume: true });
  assert.match(b.last.result, /KESTREL-41/);
  assert.equal(b.last.session_id, session);
  check('second message depends on the first (--resume, new process)', { answer: b.last.result, same_session: true, ms: b.ms });

  const first = ff.child.pid;
  await ff.quit();
  ff = new FakeFirefox(home);
  await ff.wait('hello', (m) => m.type === 'hello');
  const c = await say('Say the code word again, and how many numbers you wrote. Answer as: WORD, COUNT', { resume: true });
  assert.match(c.last.result, /KESTREL-41\W+30/);
  assert.notEqual(ff.child.pid, first);
  check('resume after Claude and the helper ended', { answer: c.last.result, new_helper: true });

  let stopped;
  const d = await say('Write a story of 3000 words about a lighthouse.', {
    resume: true,
    during: async (run) => {
      await ff.wait('first text', (m) => m.type === 'chat_event' && m.run === run && /text_delta/.test(m.part), 60_000);
      const before = claudes();
      const t = Date.now();
      ff.send({ type: 'chat_stop', run });
      await ff.wait('exit', (m) => m.type === 'chat_exit' && m.run === run, 5000);
      stopped = { before, ms: Date.now() - t, after: await until('no process of the run', () => (claudes() === 0 ? 'none' : null), 4000, 100) };
    },
  });
  assert.equal(d.exit.stopped, true);
  assert.ok(stopped.before >= 2 && stopped.ms < 2000, JSON.stringify(stopped));
  check('stop ends Claude and its MCP server', { processes_before: stopped.before, processes_after: stopped.after, exit_after_ms: stopped.ms });

  const e = await say('Say the code word once more. Answer with the code word only.', { resume: true });
  assert.match(e.last.result, /KESTREL-41/);
  check('the conversation goes on after a stop', { answer: e.last.result });

  const x = await say('Say OK.', { extras: true });
  assert.ok(x.init.skills.length > 0 && x.init.agents.length > 0, 'skills and agents are reported');
  const own = x.init.tools.filter((t) => !t.startsWith('mcp__kitewarden__'));
  assert.ok(own.every((t) => ['Skill', 'Task', 'Agent'].includes(t)), `only these built-in tools: ${own}`);
  assert.deepEqual(x.init.mcp_servers.map((s) => s.name), ['kitewarden'], 'no MCP server of a plugin');
  assert.ok(!x.events.some((ev) => /^hook_/.test(ev.subtype ?? '')), 'no hook of the user ran');
  check('a chat that may use skills and agents', { skills: x.init.skills.length, agents: x.init.agents.length, plugins: x.init.plugins.length, built_in_tools: own, answer: x.last.result, cost_usd: x.last.total_cost_usd });

  assert.deepEqual(readdirSync(path.join(home.dir, 'chat')), ['rules.txt'], 'no file of a run is left');
  code = 0;
} catch (e) {
  result.error = e.message;
  if (!e.quiet) console.error(e, ff.stderr);
} finally {
  await ff.quit();
  await home.close();
  mkdirSync(path.join(root, 'test-results'), { recursive: true });
  writeFileSync(path.join(root, 'test-results/chat-lifecycle.json'), JSON.stringify({ ...result, exit: code }, null, 1));
  process.exit(code);
}
