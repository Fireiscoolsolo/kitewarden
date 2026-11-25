// LIVE AND PAID: the installed Claude Code (haiku) with the user's own sign-in, the installed helper, real Firefox (headless).
// 1. A workflow is recorded, exported as a skill by the helper, and that file is run by Claude Code.
// 2. A chat in the sidebar: file and shell tools off, denied, allowed; a PDF and a picture in a message.
// The export goes to a Claude configuration folder of its own. Claude Code reads the exported file from a project folder, so
// that nothing is written into the user's own ~/.claude. Usage: node test/live/audit.mjs [skill|chat|files]
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { installHome, root, sleep, until } from '../helpers.mjs';
import { Firefox, Sidebar } from '../firefox/firefox.mjs';
import { fixture } from '../firefox/fixtures.mjs';

const only = process.argv[2];
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/.test(k)));
const work = mkdtempSync(path.join(os.tmpdir(), 'fc-live-'));
const result = { at: new Date().toISOString(), claude: spawnSync('claude', ['--version'], { encoding: 'utf8', env }).stdout.trim(), model: 'haiku', checks: [] };
const done = (name, facts) => {
  result.checks.push({ name, ...facts });
  console.log(`ok  ${name}: ${JSON.stringify(facts)}`);
};
const home = installHome();
const A = await fixture(3000);
let code = 1;
let f;
let p;

/** Firefox with the add-on, connected. `press` finds a button by its text. */
async function begin(url, more = {}) {
  f = await Firefox.start({ headed: false, env: more });
  result.firefox = f.version;
  const sb = new Sidebar(f, await f.install(path.join(root, 'dist/extension')));
  await f.navigate(url);
  await sb.open();
  await sb.click('#connect');
  await until('connected', async () => (await sb.text('#link-title')) === 'Connected');
  sb.press = async (part, text) => {
    const i = await until(`button ${text}`, async () => {
      const n = await sb.eval('return [...document.querySelectorAll(arguments[0] + " button")].findIndex((b) => b.textContent === arguments[1])', part, text);
      return n >= 0 ? { n } : null;
    }, 8000);
    await sb.click(`${part} button`, i.n);
  };
  return sb;
}

async function skill() {
  const config = path.join(work, 'config');
  const sb = await begin(`${A.origin}/form`, { CLAUDE_CONFIG_DIR: config });
  await sb.click('#wf-record');
  await f.prompt(true).catch(() => {});
  await until('recording', async () => /Recording in/.test(await sb.text('#wf-rec')));
  await f.pageClick('[name=q]');
  await f.pageKeys('[name=q]', 'first text');
  await f.pageClick('form button');
  await until('second page', async () => /\/done/.test(await sb.text('#wf-rec')));
  await sb.press('#wf-rec', 'Stop');
  await until('review', async () => /Review the recording/.test(await sb.text('#wf-edit')));
  await sb.eval('const i = document.getElementById("wf-title"); i.value = "Audit form"; i.dispatchEvent(new Event("input"))');
  await sb.press('#wf-edit', 'Save');
  await until('saved', async () => /Audit form/.test(await sb.text('#wf-list')));
  await sb.press('#wf-list', 'Save as skill…');
  await sb.click('#wf-skill .skill-show');
  const shown = await until('shown', () => sb.text('#skill-text'));
  await sb.click('#wf-skill .skill-save');
  await until('written', async () => /Saved as/.test(await sb.text('#message')));
  const file = path.join(config, 'skills/audit-form/SKILL.md');
  assert.equal(readFileSync(file, 'utf8'), shown);
  assert.ok(!shown.includes('first text'), 'the recorded text is asked for, not kept');
  mkdirSync(path.join(work, '.claude/skills'), { recursive: true });
  cpSync(path.dirname(file), path.join(work, '.claude/skills/audit-form'), { recursive: true });
  const before = A.reports.length;

  const mcp = path.join(work, 'mcp.json');
  writeFileSync(mcp, JSON.stringify({ mcpServers: { 'firefox-companion': { command: 'node', args: [home.server] } } }));
  p = spawn('claude', [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--mcp-config', mcp,
    '--model', 'haiku', '--setting-sources', 'project', '--tools', '', '--allowedTools', 'mcp__firefox-companion', '--no-session-persistence', '--max-turns', '40',
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
  const say = (text) => p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n');
  let running = true;
  p.on('exit', () => (running = false));
  say('/audit-form');
  await until('claude-code in the sidebar', async () => (await sb.text('#sessions')).includes('claude-code'), 60_000, 100);
  await sb.attach('claude-code', 'act', null);
  const cards = [];
  const answers = [];
  let said = 0;
  for (const end = Date.now() + 240_000; running && Date.now() < end; await sleep(200)) {
    const card = await sb.text('#cards .card').catch(() => null);
    if (card) {
      cards.push(/wants to (.*?)Target/.exec(card)?.[1] ?? card.slice(0, 60));
      assert.match(card, /claude-code/);
      await sb.answerCard(true);
      await until('answered', async () => (await sb.text('#cards .card')) !== card, 4000).catch(() => {});
    }
    const results = events.filter((e) => e.type === 'result');
    if (results.length <= said) continue;
    answers.push(String(results.at(-1).result).slice(0, 200));
    said = results.length;
    if (A.reports.length > before || said >= 4) break;
    say('The value is: audit value 7. Go on with the steps of the skill.');
  }
  p.stdin.end();
  const init = events.find((e) => e.subtype === 'init');
  const uses = events.filter((e) => e.type === 'assistant').flatMap((e) => e.message.content).filter((x) => x.type === 'tool_use').map((x) => x.name.replace('mcp__firefox-companion__', '') + (x.input.action ? ` ${x.input.action}` : ''));
  Object.assign(result, { skill_tools: uses, skill_cards: cards, skill_answers: answers, skill_page: A.reports.slice(before), skill_stderr: stderr.slice(0, 300) });
  assert.ok([...(init.slash_commands ?? []), ...(init.skills ?? []).map((s) => s.name ?? s)].includes('audit-form'), 'Claude Code offers the exported skill');
  assert.ok(init.tools.every((t) => t.startsWith('mcp__firefox-companion__')), `only its tools: ${init.tools}`);
  assert.deepEqual(A.reports.slice(before), ['saved q=audit value 7;color=Red;urgent=false;pw=0'], 'the page confirms one save with the value that was asked for');
  assert.ok(answers.some((a) => /\?|value|provide|text/i.test(a)), 'it asked for the value');
  done('an exported skill, run by Claude Code in real Firefox', { tools: uses, cards, first_answer: answers[0], page: A.reports.slice(before), cost_usd: events.findLast((e) => e.type === 'result')?.total_cost_usd });
  await f.quit();
  f = null;
}

/** A PDF of one line of text. */
function pdf(text) {
  const objects = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>', '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>', null, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'];
  const stream = `BT /F1 18 Tf 20 50 Td (${text}) Tj ET`;
  objects[3] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const at = objects.map((o, i) => {
    const n = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return n;
  });
  const xref = out.length;
  return `${out}xref\n0 6\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
}

async function chat() {
  const sb = await begin(`${A.origin}/`);
  const answers = () => sb.eval('return [...document.querySelectorAll("#chat-items .assistant")].map((e) => e.textContent)');
  const running = () => sb.eval('return !document.getElementById("stop").hidden');
  const folder = path.join(home.dir, 'chat');
  /** Sends a message, answers cards with `yes`, and returns the last answer and the cards. */
  const say = async (text, yes = null) => {
    const from = (await answers()).length;
    await sb.eval('document.getElementById("prompt").value = arguments[0]', text);
    await sb.click('#send');
    await until('the run shows', running, 8000, 10).catch(() => {});
    const cards = [];
    for (const end = Date.now() + 180_000; Date.now() < end && (await running()); await sleep(200)) {
      const card = await sb.text('#cards .card').catch(() => null);
      if (!card) continue;
      assert.notEqual(yes, null, `a card that was not expected: ${card}`);
      cards.push(card.replace(/\s+/g, ' ').slice(0, 260));
      await sb.answerCard(yes);
      await until('answered', async () => (await sb.text('#cards .card')) !== card, 4000).catch(() => {});
    }
    return { cards, answer: (await answers()).slice(from).join(' ').slice(0, 300) };
  };
  await until('account', async () => /signed in/.test(await sb.text('#claude')), 70_000, 200);
  if (/not signed in/.test(await sb.text('#claude'))) throw Object.assign(new Error('Claude Code is not signed in.'), { pending: true });
  await sb.choose('#model', 'haiku');
  await sb.click('#chat-new');
  if (only !== 'files') await tools(sb, say, folder);
  await files(sb, say);
  await f.quit();
  f = null;
}

async function tools(sb, say, folder) {
  const none = await say('Do you have any tool in this conversation that lists files or runs a shell command on this computer? Start your answer with YES or NO. Call no tool.');
  assert.match(none.answer, /^\W*NO\b/i);
  done('a new chat has no file or shell tool', none);

  await sb.eval('for (let e = document.getElementById("tools"); e; e = e.parentElement) if (e.tagName === "DETAILS") e.open = true');
  await sb.click('#tools');
  await until('kept', () => sb.eval('const { chats } = await browser.storage.local.get("chats"); return (chats ?? []).some((x) => x.tools === true)'), 4000);
  const command = 'echo FC-AUDIT-1 > audit-probe.txt';
  const probe = path.join(folder, 'audit-probe.txt');
  const denied = await say(`The user just turned shell tools on. Run exactly this command once with the Bash tool: ${command}\nIf it is refused, stop and say REFUSED.`, false);
  assert.ok(denied.cards.length >= 1 && denied.cards[0].includes(command), JSON.stringify(denied));
  assert.ok(!existsSync(probe), 'a denied command did not run');
  done('shell: the card shows the whole command, and Deny runs nothing', denied);
  const listed = await say('Run exactly this command once with the Bash tool: ls\nIf it is refused, stop and say REFUSED.', false);
  assert.ok(listed.cards.length >= 1 && /command: ls/.test(listed.cards[0]), JSON.stringify(listed));
  done('shell: a read-only command asks as well', listed);
  const allowed = await say(`The user changed their mind and allows it now. Run exactly this command once with the Bash tool: ${command}`, true);
  assert.ok(allowed.cards.length >= 1);
  assert.match(readFileSync(probe, 'utf8'), /FC-AUDIT-1/);
  done('shell: an allowed command runs once it is allowed', { ...allowed, file: readFileSync(probe, 'utf8').trim() });
  const read = await say('Read the file audit-probe.txt in the current folder with the Read tool and answer with its content only.', true);
  assert.ok(read.cards.some((x) => /Read/.test(x) && /audit-probe\.txt/.test(x)), JSON.stringify(read));
  assert.match(read.answer, /FC-AUDIT-1/);
  done('files: reading a file of the working folder asks first', read);

}

async function files(sb, say) {
  await sb.click('#chat-new');
  await until('an empty chat', async () => (await sb.text('#chat-items')) === '');
  await sb.choose('#model', 'haiku');
  await sb.eval(`
    const dt = new DataTransfer();
    dt.items.add(new File([arguments[0]], 'code.pdf', { type: 'application/pdf' }));
    const c = Object.assign(document.createElement('canvas'), { width: 64, height: 64 });
    const g = c.getContext('2d');
    g.fillStyle = '#e00000';
    g.fillRect(0, 0, 64, 64);
    dt.items.add(new File([await new Promise((r) => c.toBlob(r, 'image/png'))], 'color.png', { type: 'image/png' }));
    const i = document.getElementById('file');
    i.files = dt.files;
    i.dispatchEvent(new Event('change'));`, pdf('The code word is FOXGLOVE-77'));
  await until('two drafts', () => sb.eval('return document.querySelectorAll("#draft summary").length === 2'), 8000).catch(async (e) => {
    throw new Error(`${e.message}; ${await sb.text('#message')}; ${await sb.text('#draft')}`);
  });
  const both = await say('Which code word is in the PDF, and which color has the picture? Answer as WORD / COLOR. Call no tool.');
  assert.match(both.answer, /FOXGLOVE-77/);
  assert.match(both.answer, /red/i);
  done('a PDF and a picture reach Claude', both);
}

try {
  if (!only || only === 'skill') await skill();
  if (only !== 'skill') await chat();
  code = 0;
} catch (e) {
  result.error = e.message;
  code = e.pending ? 3 : 1;
  console.error(e);
} finally {
  p?.kill();
  await f?.quit().catch(() => {});
  await A.close();
  await home.close().catch((e) => console.error('home', e.message));
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  mkdirSync(path.join(root, 'test-results'), { recursive: true });
  writeFileSync(path.join(root, `test-results/live-audit${only ? `-${only}` : ''}.json`), JSON.stringify({ ...result, exit: code }, null, 1));
  process.exit(code);
}
