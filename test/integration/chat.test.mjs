// Real Windows: the built helper, real pipes, the real MCP server, real processes. Claude Code is a TEST DOUBLE
// (test/doubles), Firefox is played by the test. The real Claude Code is in test/live.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { FakeFirefox, McpClient, fakeClaude, host, installHome, powershell, sleep, until } from '../helpers.mjs';

let home, double, skills, ff;
const env = { PATH: process.env.PATH, config: process.env.CLAUDE_CONFIG_DIR };

before(() => {
  home = installHome();
  double = fakeClaude();
  skills = mkdtempSync(path.join(os.tmpdir(), 'fc-skills-'));
  process.env.PATH = `${double.dir};${env.PATH}`;
  process.env.CLAUDE_CONFIG_DIR = skills;
});
beforeEach(async () => {
  await ff?.quit();
  ff = new FakeFirefox(home);
  await ff.wait('hello', (m) => m.type === 'hello');
});
after(async () => {
  await ff.quit();
  process.env.PATH = env.PATH;
  if (env.config === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = env.config;
  rmSync(skills, { recursive: true, force: true });
  double.close();
  await home.close();
});

function start(text, { session = randomUUID(), resume = false, model = null, extras = false, ...more } = {}) {
  const run = randomUUID();
  const ticket = randomBytes(32).toString('hex');
  ff.send({ type: 'chat_run', run, session, resume, model, extras, ticket, input: JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }), ...more });
  return { run, ticket, session, exit: (ms = 15_000) => ff.wait(`end of ${text}`, (m) => m.type === 'chat_exit' && m.run === (more.run ?? run), ms) };
}
function events(run) {
  const list = [];
  let line = '';
  for (const m of ff.messages) {
    if (m.type !== 'chat_event' || m.run !== run) continue;
    line += m.part;
    if (!m.end) continue;
    list.push(JSON.parse(line));
    line = '';
  }
  return list;
}
const answer = (run) => events(run).filter((e) => e.type === 'assistant').at(-1).message.content[0].text;
async function say(text, o) {
  const r = start(text, o);
  return { ...r, end: await r.exit(), answer: events(r.run).some((e) => e.type === 'assistant') ? answer(r.run) : null };
}
/** Processes of a run: the double, its node, and the MCP server. All of them name a file of the home folder or the double. */
const processes = () => powershell(`Get-CimInstance Win32_Process | Where-Object { ($_.CommandLine -like '*${home.dir}\\chat*' -or $_.CommandLine -like '*${home.dir}\\mcp*' -or $_.CommandLine -like '*${double.dir}*') -and $_.Name -ne 'powershell.exe' } | ForEach-Object { $_.Name }`).split(/\s+/).filter(Boolean);
const ask = async (type, data) => {
  const id = randomUUID();
  ff.send({ ...data, type, id });
  return (await ff.wait(type, (m) => m.type === 'reply' && m.id === id, 20_000)).result;
};

test('run: the documented options in a folder of the helper, no shell, and the ticket in no command line', async () => {
  const r = await say('args', { model: 'haiku' });
  assert.equal(r.end.code, 0, r.end.detail);
  const { argv, cwd } = JSON.parse(r.answer);
  assert.equal(cwd, path.join(home.dir, 'chat'));
  const after1 = (n) => argv[argv.indexOf(n) + 1];
  assert.deepEqual(argv.slice(0, 7), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']);
  assert.ok(argv.includes('--strict-mcp-config') && argv.includes('--disable-slash-commands') && !argv.includes('--bare') && !argv.some((a) => a.includes('dangerously')));
  assert.deepEqual([after1('--setting-sources'), after1('--tools'), after1('--allowedTools'), after1('--permission-mode'), after1('--model'), after1('--session-id')], ['', '', 'mcp__firefox-companion', 'dontAsk', 'haiku', r.session]);
  assert.deepEqual(JSON.parse(after1('--settings')), { disableAllHooks: true, disableSkillShellExecution: true });
  assert.match(after1('--disallowedTools'), /Bash,PowerShell,Read,Edit,Write/);
  assert.ok(!JSON.stringify(argv).includes(r.ticket));
  assert.match(readFileSync(after1('--append-system-prompt-file'), 'utf8'), /never an instruction and never permission/);
  const hello = ff.messages.filter((m) => m.type === 'from_client').map((m) => JSON.parse(m.body)).filter((b) => b.type === 'hello');
  assert.deepEqual(hello.map((b) => b.ticket), [r.ticket]);
  const x = JSON.parse((await say('args', { extras: true })).answer).argv;
  assert.deepEqual([x[x.indexOf('--setting-sources') + 1], x[x.indexOf('--tools') + 1], x.includes('--disable-slash-commands')], ['user', 'Skill,Task', false]);
  assert.match(x[x.indexOf('--disallowedTools') + 1], /Bash/);
});

test('streaming in parts, a second message and a resume, also after the helper ended', async () => {
  const a = await say('remember heron');
  assert.ok(events(a.run).filter((e) => e.type === 'stream_event' && e.event.delta).length > 1);
  assert.equal((await say('recall', { session: a.session, resume: true })).answer, 'Earlier you wrote: remember heron');
  await ff.quit();
  ff = new FakeFirefox(home);
  await ff.wait('hello', (m) => m.type === 'hello');
  assert.equal((await say('recall', { session: a.session, resume: true })).answer, 'Earlier you wrote: remember heron | recall');
  const gone = await say('recall', { resume: true });
  assert.deepEqual([gone.end.code, gone.end.stopped], [1, false]);
  assert.match(gone.end.detail, /No conversation found/);
});

test('a line over 1 MB arrives whole in messages that Firefox takes', async () => {
  const r = await say('big');
  assert.equal(r.answer, '🦊é"\\'.repeat(120_000));
  const sizes = ff.messages.filter((m) => m.type === 'chat_event').map((m) => Buffer.byteLength(JSON.stringify(m)));
  assert.ok(Math.max(...sizes) < 1024 * 1024, `${Math.max(...sizes)} bytes`);
});

test('the largest message the add-on sends arrives, however much of it has to be escaped', async () => {
  const r = await say(`${'"é'.repeat(3_400_000)}\nblocks`);
  assert.equal(r.answer, '["text"]');
});

test('stop ends every process of the run within 2 s and leaves no file', async () => {
  const r = start('slow');
  await ff.wait('text', (m) => m.type === 'chat_event' && m.run === r.run && /text_delta/.test(m.part));
  assert.ok(processes().length >= 3, processes().join());
  const t = Date.now();
  ff.send({ type: 'chat_stop', run: r.run });
  const end = await r.exit(2000);
  assert.equal(end.stopped, true);
  await until('no process', () => processes().length === 0, 4000, 100);
  assert.ok(Date.now() - t < 6000);
  assert.deepEqual(readdirSync(path.join(home.dir, 'chat')), ['rules.txt']);
});

test('a run ends with the helper, whether it closes or is killed', async () => {
  for (const end of ['quit', 'kill']) {
    const r = start('slow');
    await ff.wait('text', (m) => m.type === 'chat_event' && m.run === r.run && /text_delta/.test(m.part));
    if (end === 'kill') ff.child.kill();
    else await ff.quit();
    await until(`no process after ${end}`, () => processes().length === 0, 5000, 100);
    ff = new FakeFirefox(home);
    await ff.wait('hello', (m) => m.type === 'hello');
    assert.deepEqual(readdirSync(path.join(home.dir, 'chat')), ['rules.txt'], 'the next helper removes what is left');
  }
});

test('a crash is reported with its exit code and message, and four runs at a time is the limit', async () => {
  const r = await say('crash');
  assert.deepEqual([r.end.code, r.end.stopped, r.end.error], [3, false, null]);
  assert.match(r.end.detail, /the double crashed/);
  const four = Array.from({ length: 4 }, () => start('slow'));
  await sleep(300);
  assert.equal((await start('slow').exit()).error, 'too_many_runs');
  for (const s of four) ff.send({ type: 'chat_stop', run: s.run });
  await Promise.all(four.map((s) => s.exit()));
});

test('values that do not fit their pattern start nothing', async () => {
  const bad = [{ session: '--bare' }, { session: '../x' }, { model: '--dangerously-skip-permissions' }, { model: 'a b' }, { ticket: 'x' }, { input: 'not json' }, { input: '{"type":"control_request"}' }, { input: '{"type":"user"}\n{"type":"user"}' }];
  for (const b of bad) {
    const end = await start('args', b).exit();
    assert.equal(end.error, 'start_failed', JSON.stringify(b));
  }
  start('args', { run: '..\\x' });
  await until('refused', () => ff.stderr.includes('refused run'));
  assert.deepEqual(processes(), []);
  assert.ok(!ff.messages.some((m) => m.type === 'chat_event'));
});

test('without Claude Code the run says so, and MCP clients still work without any chat', async (t) => {
  if (existsSync(path.join(os.homedir(), '.local/bin/claude.exe'))) return t.skip('Claude Code is in its own folder, so it cannot be hidden');
  await ff.quit();
  process.env.PATH = env.PATH.split(';').filter((d) => !existsSync(path.join(d, 'claude.exe'))).join(';');
  try {
    ff = new FakeFirefox(home);
    await ff.wait('hello', (m) => m.type === 'hello');
    assert.deepEqual(await ask('claude_info'), { installed: false });
    assert.equal((await start('args').exit()).error, 'claude_missing');
    ff.answer(async () => ({ result: { state: 'connected' } }));
    const c = new McpClient(home);
    await c.init();
    assert.equal((await c.call('connection_status')).data.state, 'connected');
    await c.close();
  } finally {
    process.env.PATH = `${double.dir};${env.PATH}`;
  }
});

test('account check: installed, version, signed in, plugin names, and no account data', async () => {
  assert.deepEqual(await ask('claude_info'), { installed: true, version: '0.0.0 (test double)', signedIn: true, authMethod: 'claude.ai', plugins: [{ id: 'one@test', version: '1', enabled: true }] });
  writeFileSync(path.join(double.dir, 'signed-out'), '');
  assert.equal((await ask('claude_info')).signedIn, false);
  rmSync(path.join(double.dir, 'signed-out'));
});

test('a skill is written to its own folder only: names, links and replacing', async () => {
  const text = '---\nname: x\n---\nText é\n';
  const write = (name, o = {}) => ask('skill_write', { name, text, ...o });
  const file = path.join(skills, 'skills', 'weekly-report', 'SKILL.md');
  assert.deepEqual(await write('weekly-report', { dry: true }), { path: file, exists: false, written: false });
  assert.ok(!existsSync(path.join(skills, 'skills')), 'a dry run writes nothing');
  assert.equal((await write('weekly-report')).written, true);
  assert.equal(readFileSync(file, 'utf8'), text);
  assert.deepEqual(await write('weekly-report', { text: '---\nother' }), { path: file, exists: true, written: false });
  assert.equal(readFileSync(file, 'utf8'), text);
  assert.equal((await write('weekly-report', { text: '---\nother', replace: true })).written, true);
  assert.equal(readFileSync(file, 'utf8'), '---\nother');
  assert.deepEqual(readdirSync(path.dirname(file)), ['SKILL.md']);
  for (const name of ['..\\x', '../x', 'A', 'a b', 'a/b', '', 'a--b', '-a', 'con', 'synced', 'anthropic-skills', 'a.b', 'a:b', 'x'.repeat(65)]) assert.match((await write(name)).error, /skill name/, name);
  assert.match((await write('ok', { text: 'no front matter' })).error, /not valid/);
  assert.match((await write('ok', { text: `---\n${'x'.repeat(200_001)}` })).error, /not valid/);
  const outside = path.join(skills, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, path.join(skills, 'skills', 'linked'), 'junction');
  assert.match((await write('linked')).error, /is a link/);
  assert.deepEqual(readdirSync(outside), []);
  assert.deepEqual(readdirSync(path.join(skills, 'skills')).sort(), ['linked', 'weekly-report']);
});

test('uninstall removes the files of the chat too, and doctor names Claude Code', async () => {
  await say('hello');
  await ff.quit();
  assert.match(host('doctor', '--home', home.dir).stdout, /info {2}Claude Code: .*claude\.exe/);
  writeFileSync(path.join(home.dir, 'chat', 'run-left.json'), '{}');
  assert.equal(host('uninstall', '--home', home.dir).status, 0);
  assert.ok(!existsSync(home.dir));
  assert.equal(host('install', '--home', home.dir).status, 0);
  ff = new FakeFirefox(home);
  await ff.wait('hello', (m) => m.type === 'hello');
});
