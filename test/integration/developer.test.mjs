// The developer build. It rebuilds dist/, so it is not among the unit tests, which run side by side.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { root } from '../helpers.mjs';

const files = (dir) => readdirSync(dir).flatMap((n) => (statSync(path.join(dir, n)).isDirectory() ? files(path.join(dir, n)) : [path.join(dir, n)]));
const read = (f) => readFileSync(f, 'utf8');
const everyday = () => [...files(path.join(root, 'dist/extension')), ...files(path.join(root, 'dist/mcp'))];

test('developer build: its own folder, the tool is there and off, and the everyday build has none of it afterwards', () => {
  execFileSync(process.execPath, [path.join(root, 'build/build.mjs'), '--developer'], { stdio: 'pipe' });
  const dev = path.join(root, 'dist/developer');
  try {
    assert.match(JSON.parse(read(path.join(dev, 'extension/manifest.json'))).name, /developer build/);
    for (const f of ['extension/page/pagescript.js', 'extension/background/pagescript.mjs']) assert.ok(statSync(path.join(dev, f)).size > 100);
    assert.match(read(path.join(dev, 'extension/background/main.mjs')), /Object\.assign\(HANDLERS, scriptTools\)/);
    for (const f of ['extension/shared/protocol.mjs', 'mcp/protocol.mjs']) assert.match(read(path.join(dev, f)), /GROUPS\.script = \[\];[\s\S]*TOOLS\.javascript_tool = \{/);
    for (const f of everyday().filter((x) => /\.(mjs|js)$/.test(x))) assert.ok(!/javascript_tool|pagescript/.test(read(f)), path.relative(root, f));
  } finally {
    rmSync(dev, { recursive: true, force: true });
  }
});
