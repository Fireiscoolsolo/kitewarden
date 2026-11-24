// The installed Claude Code with the MCP server, in real Firefox.
// Part 1 needs no sign-in: Claude Code registers and starts the server, and its own health check talks to it.
// Part 2 runs a model with the user's own sign-in and one approved click. Exit 3 means: part 2 is pending a sign-in.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { installHome, root, sleep, until } from '../helpers.mjs';
import { Firefox, Sidebar } from '../firefox/firefox.mjs';
import { fixture } from '../firefox/fixtures.mjs';

// As in a new terminal: nothing of a Claude session that happens to run this script.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/.test(k)));
const work = mkdtempSync(path.join(os.tmpdir(), 'fc-claude-'));
const claude = (args, extra = {}) => spawnSync('claude', args, { encoding: 'utf8', cwd: work, env: { ...env, ...extra }, timeout: 60_000 });

const result = { at: new Date().toISOString(), claude: claude(['--version']).stdout.trim() };
const home = installHome();
const fx = await fixture(3000);
const f = await Firefox.start();
let code = 1;
let p;
try {
  result.firefox = f.version;
  const sb = new Sidebar(f, await f.install(path.join(root, 'dist/extension')));
  await f.navigate(`${fx.origin}/`);
  await sb.open();
  await sb.click('#connect');
  await until('connected', async () => (await sb.text('#link-title')) === 'Connected');

  // Part 1, with its own config folder, so that the user's Claude Code settings are not touched.
  const config = { CLAUDE_CONFIG_DIR: path.join(work, 'config') };
  const add = claude(['mcp', 'add', '-s', 'user', 'firefox-companion', '--', 'node', home.server], config);
  assert.equal(add.status, 0, add.stderr);
  const list = claude(['mcp', 'list'], config);
  const listed = list.stdout;
  assert.equal(list.status, 0, list.stderr);
  result.health = listed.split(/\r?\n/).find((l) => l.startsWith('firefox-companion'))?.replace(/:.* - /, ': ');
  console.log(`part 1: ${result.claude}; ${result.health}`);
  assert.match(listed, /firefox-companion: .*Connected/);

  // Part 2
  const auth = JSON.parse(claude(['auth', 'status']).stdout || '{}');
  result.signed_in = auth.loggedIn === true;
  if (!result.signed_in) {
    console.log('part 2: PENDING. Claude Code is not signed in. Run "claude auth login" in a terminal, then run this again.');
    code = 3;
  } else {
    const mcp = path.join(work, 'mcp.json');
    writeFileSync(mcp, JSON.stringify({ mcpServers: { 'firefox-companion': { command: 'node', args: [home.server] } } }));
    const prompt = `Use only the firefox-companion tools, one call at a time.
1. Call connection_status.
2. Call tabs_context. If it lists no tab, call it again, up to 20 times, because the user is attaching one now.
3. Call read_page on that tab.
4. Click the button "Count up" exactly once with computer left_click. The user approves it.
5. Call read_page again and answer with one line: the word that starts with ALPHA-, then the number that the page shows after the button.`;
    // The first two lines are the documented path of the AC-08 record; the rest keeps the run small and apart.
    p = spawn('claude', [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--strict-mcp-config', '--mcp-config', mcp,
      '--model', 'haiku', '--setting-sources', '', '--tools', '', '--allowedTools', 'mcp__firefox-companion', '--no-session-persistence', '--max-turns', '30',
    ], { cwd: work, env });
    const events = [];
    createInterface({ input: p.stdout }).on('line', (l) => {
      try {
        events.push(JSON.parse(l));
      } catch {
        // not an event
      }
    });
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += d));
    p.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n');
    const ended = new Promise((r) => p.on('exit', r));
    let running = true;
    ended.then(() => (running = false));
    await until('claude-code in the sidebar', async () => (await sb.text('#sessions')).includes('claude-code'), 60_000, 100);
    await sb.attach('claude-code', 'act', true);
    while (running) {
      const card = await sb.text('#cards .card').catch(() => null);
      if (card) {
        result.card = card;
        assert.match(card, /claude-code .*wants to click.*button "Count up"/);
        await sb.answerCard(true);
      }
      await sleep(200);
    }
    const last = events.findLast((e) => e.type === 'result');
    const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
    const blocks = (type) => events.filter((e) => e.type === type).flatMap((e) => e.message.content);
    const uses = blocks('assistant').filter((x) => x.type === 'tool_use');
    const first = blocks('user').find((x) => x.type === 'tool_result' && x.tool_use_id === uses[0]?.id);
    result.model = init?.model;
    result.mcp_servers = init?.mcp_servers;
    result.tools = uses.map((x) => x.name.replace('mcp__firefox-companion__', '') + (x.input.action ? ` ${x.input.action}` : ''));
    result.connection_status = JSON.parse([first?.content].flat().map((x) => x?.text ?? x).join(''));
    result.streamed_parts = events.filter((e) => e.type === 'stream_event').length;
    result.answer = last?.result;
    result.cost_usd = last?.total_cost_usd;
    result.page_reports = fx.reports;
    console.log(`part 2: ${result.model}; calls: ${result.tools.join(', ')}; answer: ${result.answer}; page: ${fx.reports.join(', ')}${stderr ? `; stderr: ${stderr.slice(0, 300)}` : ''}`);
    assert.deepEqual(init.mcp_servers.map((s) => [s.name, s.status]), [['firefox-companion', 'connected']], 'only this MCP server');
    assert.ok(init.tools.every((t) => t.startsWith('mcp__firefox-companion__')), `only its tools: ${init.tools}`);
    assert.equal(result.tools[0], 'connection_status');
    assert.equal(result.connection_status.state, 'connected');
    assert.match(result.connection_status.session.label, /^Client claude-code/);
    assert.ok(result.streamed_parts > 0, 'partial messages arrive');
    assert.deepEqual(result.tools.filter((t) => t === 'computer left_click').length, 1);
    assert.deepEqual(fx.reports, ['count=1;trusted=false']);
    assert.match(result.answer, new RegExp(`ALPHA-${fx.port}.*1`, 's'));
    code = 0;
  }
} catch (e) {
  result.error = e.message;
  console.error(e);
} finally {
  p?.kill(); // a failed check must not leave a model running
  await f.quit();
  await fx.close();
  await home.close();
  rmSync(work, { recursive: true, force: true });
  mkdirSync(path.join(root, 'test-results'), { recursive: true });
  writeFileSync(path.join(root, 'test-results/claude.json'), JSON.stringify({ ...result, exit: code }, null, 1));
  process.exit(code);
}
