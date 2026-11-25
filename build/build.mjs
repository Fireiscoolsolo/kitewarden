// Assembles dist/: the extension, the host program and the MCP server. No dependency: the host is built with the
// C# compiler that ships with Windows.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL, VERSION } from '../shared/protocol.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

// The parts must agree on version and protocol before anything is built.
const host = readFileSync(path.join(root, 'host/native/Host.cs'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(root, 'ext/manifest.json'), 'utf8'));
const want = { 'Host.cs Version': [/Version = "([^"]+)"/.exec(host)?.[1], VERSION], 'Host.cs Protocol': [Number(/Protocol = (\d+)/.exec(host)?.[1]), PROTOCOL], 'manifest version': [manifest.version, VERSION], 'manifest id': [manifest.browser_specific_settings.gecko.id, /ExtensionId = "([^"]+)"/.exec(host)?.[1]] };
for (const [name, [got, expected]] of Object.entries(want)) if (got !== expected) throw new Error(`${name}: ${got}, expected ${expected}`);

for (const part of ['extension', 'mcp', 'host', 'backends', 'remote']) {
  rmSync(path.join(dist, part), { recursive: true, force: true });
  mkdirSync(path.join(dist, part), { recursive: true });
}
cpSync(path.join(root, 'ext'), path.join(dist, 'extension'), { recursive: true });
for (const f of ['protocol.mjs', 'redact.mjs']) cpSync(path.join(root, 'shared', f), path.join(dist, 'extension/shared', f));
for (const f of ['server.mjs', 'serve.mjs', 'link.mjs']) cpSync(path.join(root, 'mcp/server', f), path.join(dist, 'mcp', f));
cpSync(path.join(root, 'shared/protocol.mjs'), path.join(dist, 'mcp/protocol.mjs'));
// Optional parts, which nothing of the everyday product starts or contains.
for (const f of ['link.mjs', 'isolated.mjs']) cpSync(path.join(root, 'backends', f), path.join(dist, 'backends', f));
cpSync(path.join(root, 'ext/page/content.js'), path.join(dist, 'backends/content.js'));

execFileSync(path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), [
  '/nologo', '/warnaserror+', '/optimize+', '/platform:x64', '/target:exe',
  `/out:${path.join(dist, 'host/firefox-companion-host.exe')}`,
  '/r:System.Web.Extensions.dll', '/r:System.Core.dll',
  ...['Host.cs', 'Setup.cs', 'Chat.cs', 'Files.cs'].map((f) => path.join(root, 'host/native', f)),
], { stdio: 'inherit' });
console.log('built dist/extension, dist/mcp, dist/host, dist/backends, dist/remote');
