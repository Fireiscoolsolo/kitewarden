// Packs dist/ into release/: the files that a user gets, with checksums. Nothing is signed, sent or published here.
// The same commit and compiler give the same bytes: entries are sorted, stored without compression and dated 1980.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { VERSION, mcpTools } from '../shared/protocol.mjs';
import { compile } from './compile.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const out = path.join(root, 'release');

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** [name, bytes] of each file under a folder. */
export const tree = (dir, under = '') =>
  readdirSync(path.join(dir, under)).flatMap((n) => {
    const name = under ? `${under}/${n}` : n;
    return statSync(path.join(dir, name)).isDirectory() ? tree(dir, name) : [[name, readFileSync(path.join(dir, name))]];
  });

/** A zip file that depends on names and bytes only. */
export function zip(files) {
  const parts = [];
  const central = [];
  let at = 0;
  for (const [name, data] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const n = Buffer.from(name);
    const head = Buffer.alloc(26); // what the local and the central header share
    head.writeUInt16LE(20, 0);
    head.writeUInt16LE(0x800, 2); // UTF-8 names
    head.writeUInt16LE(0x21, 8); // 1980-01-01
    head.writeUInt32LE(crc32(data), 10);
    head.writeUInt32LE(data.length, 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt16LE(n.length, 22);
    const tail = Buffer.alloc(14);
    tail.writeUInt32LE(at, 10);
    central.push(Buffer.from('PK\x01\x02\x14\x00', 'latin1'), head, tail, n);
    parts.push(Buffer.from('PK\x03\x04', 'latin1'), head, n, data);
    at += 30 + n.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.write('PK\x05\x06', 'latin1');
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(at, 16);
  return Buffer.concat([...parts, directory, end]);
}

/** The bundle for Claude Desktop, MCPB manifest 0.3. It holds the server; the helper comes with the installer. */
export const bundleManifest = () => ({
  manifest_version: '0.3',
  name: 'kitewarden',
  display_name: 'Kitewarden',
  version: VERSION,
  description: 'Works with the Firefox tabs that you attach.',
  long_description: 'Needs the Firefox add-on and its helper for Windows (KitewardenSetup). Works only with tabs that you attach in the Firefox sidebar.',
  author: { name: 'Kitewarden' },
  license: 'MPL-2.0',
  server: {
    type: 'node',
    entry_point: 'server/server.mjs',
    mcp_config: { command: 'node', args: ['${__dirname}/server/server.mjs', '--home', '${user_config.home}'] },
  },
  tools: mcpTools([]).map(({ name, description }) => ({ name, description })),
  compatibility: { platforms: ['win32'], runtimes: { node: '>=22.0.0' } },
  user_config: { home: { type: 'directory', title: 'Folder of Kitewarden', description: 'Where KitewardenSetup put the helper. Leave it as it is unless you chose another folder.', required: true, default: '${HOME}/AppData/Local/Kitewarden' } },
});

function release() {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(path.join(out, 'optional'), { recursive: true });
  const notice = ['NOTICE.txt', readFileSync(path.join(root, 'NOTICE.txt'))];
  const at = (dir, part) => tree(path.join(dist, part)).map(([n, d]) => [`${dir}/${n}`, d]);
  const packages = {
    [`kitewarden-${VERSION}-unsigned.xpi`]: [...tree(path.join(dist, 'extension')), notice],
    [`kitewarden-${VERSION}.mcpb`]: [['manifest.json', Buffer.from(`${JSON.stringify(bundleManifest(), null, 2)}\n`)], ...at('server', 'mcp'), notice],
    [`optional/kitewarden-mail-${VERSION}-unsigned.xpi`]: [...tree(path.join(dist, 'thunderbird')), notice],
    [`optional/kitewarden-optional-${VERSION}.zip`]: [...at('backends', 'backends'), ...at('remote', 'remote'), ...at('mcp', 'mcp'), notice],
  };
  const contents = [];
  for (const [name, files] of Object.entries(packages)) {
    const developer = files.find(([n, d]) => /\.(mjs|js|json|html)$/.test(n) && /javascript_tool|pagescript/.test(d));
    if (developer) throw new Error(`${name}: ${developer[0]} belongs to the developer build`);
    writeFileSync(path.join(out, name), zip(files));
    for (const [n, d] of files) contents.push(`${sha256(d)}  ${name}!${n}`);
  }

  // The installer is the helper's own program with the files inside it.
  const inside = [['kitewarden-host.exe', path.join(dist, 'host/kitewarden-host.exe')], ['NOTICE.txt', path.join(root, 'NOTICE.txt')], ...tree(path.join(dist, 'mcp')).map(([n]) => [`mcp\\${n}`, path.join(dist, 'mcp', n)])];
  const list = path.join(dist, 'payload.txt');
  writeFileSync(list, inside.map(([n, f]) => `${sha256(readFileSync(f))}  ${n}\n`).join(''));
  const setup = `KitewardenSetup-${VERSION}.exe`;
  const sources = ['Host.cs', 'Setup.cs', 'Chat.cs', 'Files.cs'].map((f) => path.join(root, 'host/native', f));
  compile(path.join(dist, 'KitewardenSetup.exe'), ['/r:System.Web.Extensions.dll', '/r:System.Core.dll', ...[['payload.txt', list], ...inside].map(([n, f]) => `/resource:${f},${n}`), ...sources]);
  cpSync(path.join(dist, 'KitewardenSetup.exe'), path.join(out, setup));
  for (const [n, f] of inside) contents.push(`${sha256(readFileSync(f))}  ${setup}!${n}`);

  for (const f of ['LICENSE', 'NOTICE.txt', 'docs/SETUP.md']) cpSync(path.join(root, f), path.join(out, path.basename(f)));
  writeFileSync(path.join(out, 'CONTENTS.txt'), `${contents.sort().join('\n')}\n`);
  const sums = tree(out).map(([n, d]) => `${sha256(d)}  ${n}\n`).join('');
  writeFileSync(path.join(out, 'SHA256SUMS.txt'), sums);
  console.log(`release/ of ${VERSION}, not signed\n${sums}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) release();
