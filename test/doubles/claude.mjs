// TEST DOUBLE of Claude Code: the documented stream-json lines, sessions by ID, and the MCP server of --mcp-config.
// It is no model. The last word of the user's message says what to do; see `answers`.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const value = (name) => argv[argv.indexOf(name) + 1];
const here = path.dirname(fileURLToPath(import.meta.url));

if (argv[0] === '--version') {
  console.log('0.0.0 (test double)');
  process.exit(0);
}
if (argv[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: !existsSync(path.join(here, 'signed-out')), authMethod: 'claude.ai', email: 'private@example.invalid', orgId: 'private' }));
  process.exit(0);
}
if (argv[0] === 'plugin') {
  console.log(JSON.stringify([{ id: 'one@test', version: '1', enabled: true, installPath: 'C:\\private' }]));
  process.exit(0);
}

const session = argv.includes('--resume') ? value('--resume') : value('--session-id');
const file = path.join(here, `${session}.json`);
if (argv.includes('--resume') && !existsSync(file)) {
  console.error(`No conversation found with session ID: ${session}`);
  process.exit(1);
}
const past = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
const out = (e) => process.stdout.write(JSON.stringify({ session_id: session, ...e }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const input = JSON.parse((await createInterface({ input: process.stdin })[Symbol.asyncIterator]().next()).value);
const blocks = input.message.content;
const text = blocks.findLast((b) => b.type === 'text').text;
writeFileSync(file, JSON.stringify([...past, text]));

const config = JSON.parse(readFileSync(value('--mcp-config'), 'utf8')).mcpServers['kitewarden'];
const mcp = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'inherit'] });
const waiting = new Map();
let next = 1;
createInterface({ input: mcp.stdout }).on('line', (l) => {
  const m = JSON.parse(l);
  waiting.get(m.id)?.(m.result);
});
const ask = (method, params) => new Promise((r) => {
  waiting.set(next, r);
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next++, method, params }) + '\n');
});
await ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-double', version: '0' } });
const { tools } = await ask('tools/list', {});
out({ type: 'system', subtype: 'init', model: value('--model') ?? 'default', apiKeySource: 'none', tools: tools.map((t) => `mcp__kitewarden__${t.name}`), mcp_servers: [{ name: 'kitewarden', status: 'connected' }], skills: ['demo-skill'], agents: ['demo-agent'], plugins: [{ name: 'demo-plugin', path: 'C:\\private' }] });

let n = 0;
async function say(full, ms = 0) {
  const id = `msg_${++n}`;
  out({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  for (const part of full.match(/.{1,12}/gsu) ?? []) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } } });
    if (ms) await sleep(ms);
  }
  out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  out({ type: 'assistant', message: { id, content: [{ type: 'text', text: full }] } });
  return full;
}
async function call(name, args) {
  const id = `toolu_${++n}`;
  out({ type: 'assistant', message: { id: `msg_${n}`, content: [{ type: 'tool_use', id, name: `mcp__kitewarden__${name}`, input: args }] } });
  const r = await ask('tools/call', { name, arguments: args });
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: r.isError === true, content: r.content }] } });
  return r.content.map((c) => c.text ?? '').join('');
}

const [word, ...rest] = text.split('\n').at(-1).split(' ');
const answers = {
  args: async () => {
    await ask('tools/call', { name: 'connection_status', arguments: {} }); // the server is logged in before this run ends
    return say(JSON.stringify({ argv, cwd: process.cwd(), ticket: 'FC_CHAT_TICKET' in process.env, tools: tools.map((t) => t.name) }));
  },
  /** As Claude Code asks with --permission-prompt-tool, and it runs nothing. */
  shell: async () => {
    const input = { command: rest.join(' ') };
    const id = `toolu_${++n}`;
    out({ type: 'assistant', message: { id: `msg_${n}`, content: [{ type: 'tool_use', id, name: 'Bash', input }] } });
    const r = await ask('tools/call', { name: 'chat_permission', arguments: { tool_name: 'Bash', input, tool_use_id: id } });
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'nothing was run by the double' }] } });
    return say(`Permission: ${JSON.stringify(r)}`);
  },
  recall: () => say(`Earlier you wrote: ${past.join(' | ')}`),
  blocks: () => say(JSON.stringify(blocks.map((b) => b.type))),
  big: () => say('🦊é"\\'.repeat(120_000)),
  slow: () => say('slow '.repeat(2000), 40),
  crash: async () => {
    console.error('the double crashed');
    process.exit(3);
  },
  markdown: () => say('<b>no html</b> **bold** [site](https://example.invalid/x) ![i](https://example.invalid/i.png)'),
  click: async () => {
    const tabId = JSON.parse((await call('tabs_context', {})).split('\n').slice(1).join('\n')).tabs[0]?.tabId;
    if (tabId === undefined) return say('No tab is attached.');
    const page = await call('read_page', { tabId });
    const ref = new RegExp(`"${rest.join(' ')}".*\\[(ref_\\w+)\\]`).exec(page)?.[1];
    return say(`Result: ${await call('computer', { action: 'left_click', tabId, ref, reason: 'The test asked for it.' })}`);
  },
};
const last = await (answers[word] ?? (() => say(`You wrote: ${text}`)))();
out({ type: 'result', subtype: 'success', is_error: false, result: last.slice(0, 1000), total_cost_usd: 0 });
mcp.stdin.end();
process.exit(0);
