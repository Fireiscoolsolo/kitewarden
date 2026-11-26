// What may and may not be in the built packages. Reads dist/, so the build has to be there.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const files = (dir) => readdirSync(dir).flatMap((n) => (statSync(path.join(dir, n)).isDirectory() ? files(path.join(dir, n)) : [path.join(dir, n)]));
const read = (f) => readFileSync(f, 'utf8');
const everyday = () => [...files(path.join(root, 'dist/extension')), ...files(path.join(root, 'dist/mcp'))];

test('everyday package: no code from strings, no user scripts, no remote code, no server, no debugging flag, no developer tool', () => {
  const never = {
    eval: /\beval\s*\(|wrappedJSObject\.eval/,
    'new Function': /\bnew Function\b|\bFunction\s*\(\s*['"`]/,
    'code string in executeScript': /executeScript\([^)]*\bcode\s*:/,
    userScripts: /\buserScripts\b|scripting\.register/,
    'script from elsewhere': /<script[^>]+src=["']https?:|import\s*\(\s*['"]https?:/,
    'a server': /createServer|\.listen\s*\(\s*\d/,
    'a debugging port': /remote-debugging|marionette|WebSocket/i,
    'a debugger': /chrome\.debugger|browser\.debugger|"debugger"|"devtools"/,
    'the developer tool': /javascript_tool|pagescript/,
    'test actions': /['"]test\.[a-z]/,
  };
  for (const f of everyday().filter((x) => /\.(mjs|js|html|json)$/.test(x))) for (const [what, re] of Object.entries(never)) assert.ok(!re.test(read(f)), `${what} in ${path.relative(root, f)}`);
  assert.ok(!everyday().some((f) => /isolated|gateway|kitewarden-input|pagescript|thunderbird/i.test(path.basename(f))), 'optional parts are installed apart');
});

test('every script of the packages parses, also those that only Firefox loads', () => {
  const scripts = ['extension', 'mcp', 'backends', 'remote', 'thunderbird'].flatMap((d) => files(path.join(root, 'dist', d))).filter((f) => /\.m?js$/.test(f));
  const bad = scripts.map((f) => [f, spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' })]).filter(([, r]) => r.status !== 0);
  assert.deepEqual(bad.map(([f, r]) => `${path.relative(root, f)}: ${r.stderr.split('\n').slice(0, 5).join(' ')}`), []);
});

test('permissions: exactly these, each with a use in the code, and cookies only where they are read or a container is opened', () => {
  const m = JSON.parse(read(path.join(root, 'dist/extension/manifest.json')));
  assert.deepEqual([...m.permissions].sort(), ['activeTab', 'contextualIdentities', 'nativeMessaging', 'storage', 'tabs']);
  assert.deepEqual([...m.optional_permissions].sort(), ['<all_urls>', 'bookmarks', 'clipboardWrite', 'cookies', 'downloads', 'history', 'tabGroups', 'webRequest', 'webRequestBlocking']);
  const code = files(path.join(root, 'dist/extension')).filter((f) => /\.m?js$/.test(f)).map((f) => [path.basename(f), read(f)]);
  const used = { contextualIdentities: /contextualIdentities\./, nativeMessaging: /connectNative/, storage: /storage\.local/, tabs: /tabs\.query/, activeTab: /captureVisibleTab/, bookmarks: /bookmarks\.search/, history: /history\.search/, downloads: /downloads\.download/, tabGroups: /tabGroups/, clipboardWrite: /clipboard\.writeText/, cookies: /cookies\.getAll/, webRequest: /webRequest/, webRequestBlocking: /filterResponseData/, '<all_urls>': /captureTab/ };
  for (const p of [...m.permissions, ...m.optional_permissions]) assert.ok(code.some(([, c]) => used[p].test(c)), `${p} is used`);
  assert.deepEqual(code.filter(([, c]) => /\.cookies\b(?!\s*[:,}])/.test(c.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ''))).map(([n]) => n), ['sitedata.mjs'], 'one file reads cookies');
  assert.equal(m.externally_connectable, undefined);
  for (const part of ['extension', 'thunderbird']) assert.ok(JSON.parse(read(path.join(root, 'dist', part, 'manifest.json'))).name.length <= 45, `${part}: web-ext lint refuses a longer name`);
});
