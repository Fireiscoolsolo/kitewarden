// Shared by the integration, Firefox and live checks. Installs into a temporary home and restores the registry key.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { frame, frameReader } from '../dist/mcp/link.mjs';
import { PROTOCOL } from '../shared/protocol.mjs';

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOST = path.join(root, 'dist/host/firefox-companion-host.exe');
export const EXTENSION_ID = 'bridge@firefox-companion.invalid';
const REG = 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\firefox_companion';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(what, fn, ms = 10_000, step = 50) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms: ${what}`);
    await sleep(step);
  }
}

export function registered() {
  const r = spawnSync('reg', ['query', REG, '/ve'], { encoding: 'utf8' });
  return r.status === 0 ? (/REG_SZ\s+(.+?)\r?\n/.exec(r.stdout)?.[1] ?? null) : null;
}

export const host = (...args) => spawnSync(HOST, args, { encoding: 'utf8' });

export const powershell = (script) =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim();

/** A fresh installation in a temporary folder. `close` removes it and puts the old registration back. */
export function installHome() {
  const before = registered();
  const base = mkdtempSync(path.join(os.tmpdir(), 'fc-test-'));
  const dir = path.join(base, 'home');
  const r = host('install', '--home', dir);
  if (r.status !== 0) throw new Error(`install: ${r.stderr}`);
  return {
    dir,
    output: r.stdout,
    exe: path.join(dir, 'firefox-companion-host.exe'),
    server: path.join(dir, 'mcp/server.mjs'),
    get pipe() {
      return JSON.parse(readFileSync(path.join(dir, 'install.json'), 'utf8')).pipe;
    },
    async close() {
      if (before) execFileSync('reg', ['add', REG, '/ve', '/d', before, '/f']);
      else spawnSync('reg', ['delete', REG, '/f']);
      await until('home folder removed', () => {
        try {
          rmSync(base, { recursive: true, force: true });
          return true;
        } catch {
          return false;
        }
      }, 5000, 200);
    },
  };
}

/** dist/ of an earlier commit, built from its own files in the folder `src`. */
export function buildAt(commit, src) {
  mkdirSync(src, { recursive: true });
  execFileSync('tar', ['-xf', '-'], { cwd: src, input: execFileSync('git', ['archive', commit], { cwd: root, maxBuffer: 1e8 }) });
  execFileSync(process.execPath, ['build/build.mjs'], { cwd: src });
  return path.join(src, 'dist');
}

/** A folder with a TEST DOUBLE named claude.exe, to be put first on PATH. */
export function fakeClaude() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fc-double-'));
  execFileSync(path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', `/out:${path.join(dir, 'claude.exe')}`, path.join(root, 'test/doubles/Stub.cs')]);
  cpSync(path.join(root, 'test/doubles/claude.mjs'), path.join(dir, 'claude.mjs'));
  return { dir, close: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) };
}

/** Plays Firefox: starts the host and speaks native messaging with it. */
export class FakeFirefox {
  constructor(home, { protocol = PROTOCOL, hello = true, profile = undefined, label = undefined, id = EXTENSION_ID } = {}) {
    this.messages = [];
    this.stderr = '';
    this.child = spawn(home.exe, [path.join(home.dir, 'native-manifest.json'), id], { stdio: 'pipe' });
    this.exit = new Promise((r) => this.child.on('exit', (code) => r(code)));
    this.child.stdin.on('error', () => {});
    this.child.stderr.on('data', (d) => (this.stderr += d));
    this.child.stdout.on('data', frameReader(64 * 1024 * 1024, (m) => {
      this.messages.push(m);
      this.onMessage?.(m);
    }));
    if (hello) this.send({ type: 'hello', protocol, extension: 'test', profile, label });
  }
  send(m) {
    this.child.stdin.write(frame(m));
  }
  wait(what, match, ms) {
    return until(what, () => this.messages.find(match), ms);
  }
  /** Answers every call with `fn(call, session)`. */
  answer(fn) {
    this.onMessage = async (m) => {
      if (m.type !== 'from_client') return;
      const body = JSON.parse(m.body);
      if (body.type !== 'call') return;
      const reply = await fn(body, m.session);
      if (reply) this.send({ type: 'to_client', session: m.session, body: JSON.stringify({ type: 'result', id: body.id, ...reply }) });
    };
  }
  get calls() {
    return this.messages.filter((m) => m.type === 'from_client').map((m) => ({ session: m.session, ...JSON.parse(m.body) })).filter((b) => b.type === 'call');
  }
  async quit() {
    this.child.stdin.end();
    return this.exit;
  }
}

/** A scripted MCP client over stdio. */
export class McpClient {
  constructor(home, { name = 'test-client', args = [] } = {}) {
    this.name = name;
    this.lines = [];
    this.stderr = '';
    this.next = 1;
    this.waiting = new Map();
    this.child = spawn(process.execPath, [home.server, ...args], { stdio: 'pipe' });
    this.exit = new Promise((r) => this.child.on('exit', (code) => r(code)));
    this.child.stderr.on('data', (d) => (this.stderr += d));
    createInterface({ input: this.child.stdout }).on('line', (l) => {
      this.lines.push(l);
      const m = JSON.parse(l);
      this.waiting.get(m.id)?.(m);
      this.waiting.delete(m.id);
    });
  }
  request(method, params) {
    const id = this.next++;
    const reply = new Promise((r) => this.waiting.set(id, r));
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return Object.assign(reply, { id });
  }
  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  async init() {
    const r = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: this.name, version: '1' } });
    this.notify('notifications/initialized');
    return r.result;
  }
  /** The tool result, with `code` for an error and `data` for a JSON text. */
  async call(name, args = {}) {
    const { result } = await this.request('tools/call', { name, arguments: args });
    const text = result.content.find((c) => c.type === 'text')?.text ?? '';
    let data = null;
    try {
      data = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    } catch {
      // not JSON
    }
    return { ...result, text, data, code: result.structuredContent?.code ?? null };
  }
  async close() {
    this.child.stdin.end();
    return this.exit;
  }
}
