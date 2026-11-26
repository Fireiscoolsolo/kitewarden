// Live: the user's own Claude Code (model haiku), the installed helper, real Firefox with a disposable profile, local pages.
// Attach a page, stream, approve an action, a follow-up that needs the context, resume after Claude, the add-on and the
// helper ended, and a small workflow recorded, edited and replayed. Exit 3: Claude Code is not signed in.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { installHome, powershell, root, sleep, until } from '../helpers.mjs';
import { Firefox, Sidebar } from '../firefox/firefox.mjs';
import { fixture } from '../firefox/fixtures.mjs';

const result = { at: new Date().toISOString(), model: 'haiku', checks: [] };
const home = installHome();
const A = await fixture(3000);
const f = await Firefox.start();
let code = 1;
const done = (name, facts) => {
  result.checks.push({ name, ...facts });
  console.log(`ok  ${name}: ${JSON.stringify(facts)}`);
};
const out = path.join(root, 'test-results');
mkdirSync(out, { recursive: true });

try {
  const addon = await f.install(path.join(root, 'dist/extension'));
  const sb = new Sidebar(f, addon);
  const answers = () => sb.eval('return [...document.querySelectorAll("#chat-items .assistant")].map((e) => e.textContent)');
  const idle = () => until('the run ended', () => sb.eval('return document.getElementById("stop").hidden'), 120_000, 200);
  const running = () => sb.eval('return !document.getElementById("stop").hidden');
  const say = async (text) => {
    await sb.eval('document.getElementById("prompt").value = arguments[0]', text);
    await sb.click('#send');
    await until('the run shows', running, 5000, 10);
  };
  const press = async (part, text) => {
    const i = await until(`button ${text}`, async () => {
      const n = await sb.eval('return [...document.querySelectorAll(arguments[0] + " button")].findIndex((b) => b.textContent === arguments[1])', part, text);
      return n >= 0 ? { n } : null;
    }, 8000);
    await sb.click(`${part} button`, i.n);
  };
  const helperPid = () => powershell(`Get-CimInstance Win32_Process -Filter "Name='kitewarden-host.exe'" | Where-Object { $_.ExecutablePath -eq '${home.exe}' } | ForEach-Object ProcessId`);
  const claudes = () => Number(powershell(`@(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Where-Object { $_.CommandLine -like '*${home.dir}*' }).Count`));

  result.firefox = f.version;
  await f.navigate(`${A.origin}/`);
  await sb.open();
  await sb.click('#connect');
  await until('connected', async () => (await sb.text('#link-title')) === 'Connected');
  await until('account', async () => /signed in/.test(await sb.text('#claude')), 70_000, 200);
  result.claude = await sb.text('#claude');
  if (/not signed in/.test(result.claude)) {
    code = 3;
    throw Object.assign(new Error('Claude Code is not signed in. Run "claude auth login", then run this again.'), { quiet: true });
  }
  await sb.choose('#model', 'haiku');
  await sb.click('#chat-new');

  // A page, attached and shown first
  await sb.click('#attach-page');
  await f.prompt(true);
  await until('draft', async () => /Page http/.test(await sb.text('#draft')));
  await sb.click('#draft summary');
  const preview = await until('preview', () => sb.text('#draft pre'));
  assert.ok(preview.includes(`ALPHA-${A.port}`) && !preview.includes('hunter2secret'));
  assert.equal(claudes(), 0);
  done('a page is attached, with a preview, and nothing is sent yet', { preview_chars: preview.length });

  await sb.eval('window.seen = new Set(); new MutationObserver(() => window.seen.add(document.querySelector("#chat-items .assistant:last-child")?.textContent.length)).observe(document.getElementById("chat-items"), { subtree: true, childList: true })');
  const t = Date.now();
  await say('From the attached page only, without any tool: which word starts with ALPHA-? Name it first. Then write one paragraph of about 80 words about what is on this page.');
  await until('first text', async () => (await answers()).length > 0, 60_000, 50);
  const first = Date.now() - t;
  await idle();
  const steps = await sb.eval('return window.seen.size');
  const reply = (await answers()).join(' ');
  assert.match(reply, new RegExp(`ALPHA-${A.port}`));
  assert.ok(steps > 1, `the sidebar showed the text in ${steps} steps`);
  done('the answer streams into the sidebar and uses the page', { first_text_ms: first, shown_in_steps: steps, answer: reply.slice(0, 100), deleted_by_page: A.reports.length });

  // An action with an approval
  await sb.click('#allow-act');
  await until('granted', async () => /ask for actions/.test(await sb.text('#message')));
  await say('Use the browser tools, one call at a time: tabs_context, then read_page on that tab, then click the button "Count up" exactly once with computer left_click. Then stop and answer with one short sentence.');
  let card = null;
  while (await running()) {
    const text = await sb.text('#cards .card').catch(() => null);
    if (text) {
      card = text;
      assert.match(text, /^Chat: .*wants to click.*button "Count up"/);
      await sb.answerCard(true);
    }
    await sleep(200);
  }
  assert.ok(card, 'an approval was asked');
  assert.deepEqual(A.reports, ['count=1;trusted=false']);
  const tools = await sb.eval('return [...document.querySelectorAll("#chat-items .tool summary")].map((e) => e.textContent)');
  done('one browser action, approved by a click in the sidebar, confirmed by the page', { card: card.slice(0, 120), tools, page: A.reports });

  writeFileSync(path.join(out, 'sidebar-chat.png'), Buffer.from(await f.chrome('const c = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas"); const s = document.getElementById("sidebar-box") ?? document.getElementById("sidebar"); const r = s.getBoundingClientRect(); c.width = r.width; c.height = r.height; const b = await window.browsingContext.currentWindowGlobal.drawSnapshot(new DOMRect(r.left, r.top, r.width, r.height), 1, "white"); c.getContext("2d").drawImage(b, 0, 0); return c.toDataURL().split(",")[1]').catch(() => ''), 'base64'));

  // A follow-up that needs the context
  await say('Without any tool, from this conversation: which button did you click, and which word did you name first? Answer as BUTTON / WORD.');
  await idle();
  const follow = (await answers()).at(-1);
  assert.match(follow, /count up/i);
  assert.match(follow, new RegExp(`ALPHA-${A.port}`));
  done('a follow-up uses the earlier messages', { answer: follow.slice(0, 120) });

  // Resume: Claude ended after each message; now the add-on and the helper end as well
  assert.equal(claudes(), 0, 'no Claude process between messages');
  const before = helperPid();
  await f.install(path.join(root, 'dist/extension'));
  await sleep(1500);
  await sb.open();
  await until('connected', async () => (await sb.text('#link-title')) === 'Connected', 20_000);
  assert.notEqual(helperPid(), before);
  await sb.choose('#chat-list', await sb.eval('return document.querySelector("#chat-list option[value]:not([value=\\"\\"])").value'));
  await until('restored', async () => (await answers()).length > 0);
  assert.equal(await sb.text('#grants'), 'None');
  await say('Without any tool: say again which button you clicked earlier and the word. Answer as BUTTON / WORD.');
  await idle();
  const resumed = (await answers()).at(-1);
  assert.match(resumed, /count up/i);
  assert.match(resumed, new RegExp(`ALPHA-${A.port}`));
  done('the restored chat resumes after Claude, the add-on and the helper ended; its old grants are gone', { answer: resumed.slice(0, 120) });

  // A workflow, recorded by real gestures, edited, replayed with an approval for each step
  await f.navigate(`${A.origin}/form`);
  await sb.click('#wf-record');
  await until('recording', async () => /Recording in/.test(await sb.text('#wf-rec')));
  await f.pageClick('[name=q]');
  await f.pageKeys('[name=q]', 'first text');
  await f.pageClick('[name=pw]');
  await f.pageKeys('[name=pw]', 'hunter2secret');
  await f.pageClick('form button');
  await until('second page', async () => /\/done/.test(await sb.text('#wf-rec')));
  await press('#wf-rec', 'Stop');
  await until('review', async () => /Review the recording/.test(await sb.text('#wf-edit')));
  const recorded = await sb.eval('return [...document.querySelectorAll("#wf-edit .step strong")].map((e) => e.textContent)');
  await sb.click('#wf-edit .del-step', 2); // the password step
  await sb.click('#wf-edit .literal');
  await sb.eval('const i = document.querySelector("#wf-edit .literal-text"); i.value = "edited text"; i.dispatchEvent(new Event("input"))');
  await sb.eval('const i = document.getElementById("wf-title"); i.value = "Milestone"; i.dispatchEvent(new Event("input"))');
  await press('#wf-edit', 'Save');
  await until('saved', async () => /Milestone/.test(await sb.text('#wf-list')));
  assert.ok(!JSON.stringify(await sb.eval('return browser.storage.local.get(null)')).includes('hunter2secret'));
  await press('#wf-list', 'Replay…');
  await until('preview', async () => /Replay in this tab/.test(await sb.text('#wf-preview')));
  await press('#wf-preview', 'Attach tab to act');
  await until('ready', async () => /Every step is checked again/.test(await sb.text('#wf-preview')));
  await press('#wf-preview', 'Start replay');
  const asked = [];
  while (!/\((done|failed)\)/.test((await sb.text('#wf-replay h3')) ?? '')) {
    const text = await sb.text('#cards .card').catch(() => null);
    if (text) {
      asked.push(/wants to (.*?)Target/.exec(text)[1]);
      await sb.answerCard(true);
    }
    await sleep(150);
  }
  assert.match(await sb.text('#wf-replay h3'), /done/, await sb.text('#replay-message'));
  assert.deepEqual(asked, ['open an address', 'fill in a field', 'click']);
  assert.deepEqual(A.reports.slice(1), ['saved q=first text;color=Red;urgent=false;pw=13', 'saved q=edited text;color=Red;urgent=false;pw=0']);
  done('a workflow is recorded, edited and replayed, each step approved, and the page confirms it', { recorded, approvals: asked, page: A.reports.slice(1) });
  code = 0;
} catch (e) {
  result.error = e.message;
  if (e.quiet) console.log(e.message);
  else console.error(e);
} finally {
  await f.quit();
  await A.close();
  await home.close();
  writeFileSync(path.join(out, 'milestone.json'), JSON.stringify({ ...result, exit: code }, null, 1));
  process.exit(code);
}
