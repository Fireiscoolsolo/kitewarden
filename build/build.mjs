// Assembles dist/: the extension, the host program and the MCP server. No dependency: the host is built with the
// C# compiler that ships with Windows.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL, VERSION } from '../shared/protocol.mjs';
import { compile } from './compile.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

const developer = process.argv.includes('--developer');

// The parts must agree on version and protocol before anything is built.
const host = readFileSync(path.join(root, 'host/native/Host.cs'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(root, 'ext/manifest.json'), 'utf8'));
const want = { 'Host.cs Version': [/Version = "([^"]+)"/.exec(host)?.[1], VERSION], 'Host.cs Protocol': [Number(/Protocol = (\d+)/.exec(host)?.[1]), PROTOCOL], 'manifest version': [manifest.version, VERSION], 'thunderbird version': [JSON.parse(readFileSync(path.join(root, 'thunderbird/manifest.json'), 'utf8')).version, VERSION], 'manifest id': [manifest.browser_specific_settings.gecko.id, /ExtensionId = "([^"]+)"/.exec(host)?.[1]] };
for (const [name, [got, expected]] of Object.entries(want)) if (got !== expected) throw new Error(`${name}: ${got}, expected ${expected}`);

for (const part of ['extension', 'mcp', 'host', 'backends', 'remote', 'thunderbird']) {
  rmSync(path.join(dist, part), { recursive: true, force: true });
  mkdirSync(path.join(dist, part), { recursive: true });
}
cpSync(path.join(root, 'ext'), path.join(dist, 'extension'), { recursive: true });
for (const f of ['protocol.mjs', 'redact.mjs']) cpSync(path.join(root, 'shared', f), path.join(dist, 'extension/shared', f));
for (const f of ['server.mjs', 'serve.mjs', 'link.mjs']) cpSync(path.join(root, 'mcp/server', f), path.join(dist, 'mcp', f));
cpSync(path.join(root, 'shared/protocol.mjs'), path.join(dist, 'mcp/protocol.mjs'));
// Optional parts, which nothing of the everyday product starts or contains.
for (const f of ['link.mjs', 'isolated.mjs', 'input.mjs']) cpSync(path.join(root, 'backends', f), path.join(dist, 'backends', f));
cpSync(path.join(root, 'ext/page/content.js'), path.join(dist, 'backends/content.js'));
for (const f of ['gateway.mjs', 'client.mjs', 'wire.mjs']) cpSync(path.join(root, 'remote', f), path.join(dist, 'remote', f));
// The other computer needs the folder remote alone.
for (const f of ['serve.mjs', 'link.mjs', 'protocol.mjs']) cpSync(path.join(dist, 'mcp', f), path.join(dist, 'remote', f));

compile(path.join(dist, 'backends/kitewarden-input.exe'), [path.join(root, 'backends/Input.cs')]);
compile(path.join(dist, 'host/kitewarden-host.exe'), ['/r:System.Web.Extensions.dll', '/r:System.Core.dll', ...['Host.cs', 'Setup.cs', 'Chat.cs', 'Files.cs'].map((f) => path.join(root, 'host/native', f))]);
cpSync(path.join(root, 'NOTICE.txt'), path.join(dist, 'host/NOTICE.txt'));
// The add-on for Thunderbird: the rules of the everyday add-on, and tools of its own.
cpSync(path.join(root, 'thunderbird'), path.join(dist, 'thunderbird/thunderbird'), { recursive: true });
cpSync(path.join(dist, 'thunderbird/thunderbird/manifest.json'), path.join(dist, 'thunderbird/manifest.json'));
rmSync(path.join(dist, 'thunderbird/thunderbird/manifest.json'));
for (const f of ['icon.svg', 'background/router.mjs', 'background/native.mjs', 'background/pagetools.mjs', 'background/tabtools.mjs', 'background/devtools.mjs', 'background/sitedata.mjs', 'background/observe.mjs', 'grants/grants.mjs', 'grants/approvals.mjs', 'grants/rules.mjs', 'workflow/elements.mjs', 'shared/protocol.mjs', 'shared/redact.mjs']) cpSync(path.join(dist, 'extension', f), path.join(dist, 'thunderbird', f));

// The developer build is another add-on with the same ID, for a Firefox of its own that takes unsigned add-ons. It is never signed.
rmSync(path.join(dist, 'developer'), { recursive: true, force: true });
if (developer) {
  const dev = path.join(dist, 'developer');
  for (const part of ['extension', 'mcp']) cpSync(path.join(dist, part), path.join(dev, part), { recursive: true });
  cpSync(path.join(root, 'developer/pagescript.js'), path.join(dev, 'extension/page/pagescript.js'));
  cpSync(path.join(root, 'developer/pagescript.mjs'), path.join(dev, 'extension/background/pagescript.mjs'));
  const change = (file, from, to) => {
    const text = readFileSync(path.join(dev, file), 'utf8');
    if (!text.includes(from)) throw new Error(`developer build: ${file} has no ${JSON.stringify(from)}`);
    writeFileSync(path.join(dev, file), text.replace(from, () => to));
  };
  const more = readFileSync(path.join(root, 'developer/protocol.txt'), 'utf8');
  for (const f of ['extension/shared/protocol.mjs', 'mcp/protocol.mjs']) change(f, 'const own = (o, k)', `${more}\nconst own = (o, k)`);
  change('extension/background/main.mjs', "import { Router } from './router.mjs';", "import { scriptTools } from './pagescript.mjs';\nimport { HANDLERS, Router } from './router.mjs';");
  change('extension/background/main.mjs', '// developer build: more tools', 'Object.assign(HANDLERS, scriptTools);');
  change('extension/page/content.js', "if (m.cmd === 'hooks') return; // for hooks.js", "if (m.cmd === 'hooks' || m.cmd === 'script') return;");
  change('extension/sidebar/sidebar.mjs', 'const WANTS = {', "const WANTS = {\n  javascript_tool: 'run script in this page',");
  change('extension/manifest.json', '"Kitewarden"', '"Kitewarden (developer build)"');
  change('mcp/serve.mjs', 'const PAGE_DATA = [', "const PAGE_DATA = ['javascript_tool', ");
}
console.log('built dist/extension, dist/mcp, dist/host, dist/backends, dist/remote, dist/thunderbird');
