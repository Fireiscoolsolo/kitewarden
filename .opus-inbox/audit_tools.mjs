// Usage: node .opus-inbox/audit_tools.mjs expand|check NN [NN...]
//        node .opus-inbox/audit_tools.mjs expand-parity | check-parity
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const inbox = path.dirname(path.resolve(process.argv[1]));
const root = path.dirname(inbox);
const manifest = JSON.parse(fs.readFileSync(path.join(inbox, 'manifest.json'), 'utf8'));
const PARITY = path.join(root, 'docs/feature-parity.md');
const STATUSES = ['implemented', 'partial', 'planned', 'planned-adapted', 'deferred', 'excluded', 'platform-blocked'];
const HEADS = ['Architecture', 'Permission boundaries', 'Tool inventory', 'Features', 'Tests', 'Claimed but not verified', 'Firefox implementation notes'];
const PERM = ['Manifest permissions:', 'Host permissions:', 'Per-tab or per-site grant:', 'Authentication:', 'Sensitive-action gating:', 'Gaps:'];
const tracked = new Map();
const files = (m) => {
  if (!tracked.has(m.n)) tracked.set(m.n, new Set(execFileSync('git', ['-C', m.dir, 'ls-files', '-z'], { maxBuffer: 1 << 28 }).toString().split('\0').filter(Boolean)));
  return tracked.get(m.n);
};
const lineCount = (m, p) => fs.readFileSync(path.join(m.dir, p), 'utf8').split('\n').length;
const cells = (l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((s) => s.trim());
const get = (n) => { const m = manifest.find((x) => x.n === n); if (!m) throw new Error('unknown source ' + n); return m; };

function rangeError(m, p, a, b) {
  if (!files(m).has(p)) return `path not in pinned commit: ${p}`;
  if (!a) return null;
  const total = lineCount(m, p);
  const lo = +a, hi = +(b || a);
  if (lo < 1 || hi < lo || hi > total) return `bad line range L${a}${b ? '-L' + b : ''} in ${p} (${total} lines)`;
  return null;
}

function expand(n) {
  const m = get(n), f = path.join(root, m.file), errs = [];
  let t = fs.readFileSync(f, 'utf8');
  t = t.replace(/@@([^@\s]+?)(?:#L(\d+)(?:-L?(\d+))?)?@@/g, (all, p, a, b) => {
    const e = rangeError(m, p, a, b);
    if (e) { errs.push(e); return all; }
    const frag = a ? `#L${a}${b ? '-L' + b : ''}` : '';
    return `[${path.posix.basename(p)}${frag}](https://github.com/${m.repo}/blob/${m.sha}/${p.split('/').map(encodeURIComponent).join('/')}${frag})`;
  });
  fs.writeFileSync(f, t);
  return errs;
}

function parse(n) {
  const m = get(n), t = fs.readFileSync(path.join(root, m.file), 'utf8');
  const rows = t.split('\n').filter((l) => new RegExp(`^\\|\\s*${n}-F\\d+\\s*\\|`).test(l)).map(cells);
  return { m, t, rows };
}

function check(n) {
  const errs = [], m = get(n), product = !m.dir;
  if (!fs.existsSync(path.join(root, m.file))) return [`missing ${m.file}`];
  const { t, rows } = parse(n);
  if (!product && execFileSync('git', ['-C', m.dir, 'rev-parse', 'HEAD']).toString().trim() !== m.sha) errs.push('checkout moved off the pinned commit');
  if (!t.startsWith(`# ${n} ${m.repo}`)) errs.push(`first line must be "# ${n} ${m.repo}"`);
  if (!product) for (const [k, v] of [['Repository', `https://github.com/${m.repo}`], ['Reviewed commit', m.sha], ['Commit date', m.date]])
    if (!t.includes(`- ${k}: ${v}`)) errs.push(`header must contain "- ${k}: ${v}"`);
  if (product && !t.includes(m.sha)) errs.push(`snapshot sha256 ${m.sha} missing`);
  for (const k of ['License', 'Derived from', 'Summary']) if (!new RegExp(`^- ${k}: \\S`, 'm').test(t)) errs.push(`header field missing: ${k}`);
  for (const h of HEADS) {
    const s = t.split(new RegExp(`^## ${h}\\s*$`, 'm'))[1];
    if (s === undefined) errs.push(`section missing: ${h}`);
    else if (s.split(/^## /m)[0].trim().length < 4) errs.push(`section empty: ${h}`);
  }
  for (const p of PERM) if (!t.includes(`- ${p}`)) errs.push(`permission field missing: ${p}`);
  if (/@@/.test(t)) errs.push('unexpanded @@ citation left (run expand)');
  if (!rows.length) errs.push('no feature rows');
  rows.forEach((r, i) => {
    const want = `${n}-F${String(i + 1).padStart(2, '0')}`;
    if (r[0] !== want) errs.push(`row ${i + 1}: id ${r[0]}, expected ${want}`);
    if (r.length !== 6) { errs.push(`${r[0]}: ${r.length} cells, expected 6`); return; }
    if (r.some((c) => !c)) errs.push(`${r[0]}: empty cell`);
    if (!product && !/github\.com/.test(r[3])) errs.push(`${r[0]}: no pinned evidence link`);
    if (product && !/\]\(https:\/\/(claude\.com|code\.claude\.com)\//.test(r[3])) errs.push(`${r[0]}: no product evidence link`);
    if (!/^(native$|adapt: \S|unavailable: \S)/.test(r[4])) errs.push(`${r[0]}: bad Firefox fit "${r[4]}"`);
    if (!/^(verified$|partial: \S|claimed-only)/.test(r[5])) errs.push(`${r[0]}: bad Verification "${r[5]}"`);
    if (!product && r[5] === 'verified' && !/#L\d+/.test(r[3])) errs.push(`${r[0]}: verified row without a line range`);
    if (!product && /not (been |fully )?read|unread|read only at|grep only|by grep|not opened|not inspected|not examined|only searched|were not checked|traced only|cited from|not covered here|not checked here|from search results|cited only at|read only in part|cited by function|outside this row/i.test(r[5])) errs.push(`${r[0]}: handler not read; read it and update the row`);
  });
  const tests = (t.split(/^## Tests\s*$/m)[1] || '').split(/^## /m)[0];
  if (!product && /names? only|not read|by (file )?name/i.test(tests)) errs.push('Tests: say what the tests assert (read the test titles and the relevant cases), not just file names');
  if (product) return errs;
  for (const [, repo, ref, p, a, b] of t.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:blob|tree|raw)\/([^/\s)]+)\/([^\s)#]+)(?:#L(\d+)(?:-L(\d+))?)?/g)) {
    if (repo !== m.repo) { errs.push(`link to another repository: ${repo}`); continue; }
    if (ref !== m.sha) { errs.push(`link not pinned to the reviewed commit: ${ref}`); continue; }
    const e = rangeError(m, decodeURIComponent(p), a, b);
    if (e) errs.push(e);
  }
  const inv = (t.split(/^## Tool inventory\s*$/m)[1] || '').split(/^## /m)[0];
  const count = +((inv.match(/Count:\s*(\d+)/) || [])[1] ?? -1);
  const names = [...((inv.match(/Tools:([\s\S]*)/) || [])[1] || '').matchAll(/`([^`]+)`/g)].map((x) => x[1]);
  if (count < 0) errs.push('Tool inventory: no "Count:"');
  else if (count !== names.length) errs.push(`Tool inventory: Count ${count} but ${names.length} names listed`);
  if (new Set(names).size !== names.length) errs.push('Tool inventory: duplicate names');
  const src = [...files(m)].filter((p) => !/(^|\/)(node_modules|dist)\//.test(p) && /\.(m?[jt]sx?|cjs|py|rs|go|json|toml|ya?ml)$/i.test(p)).map((p) => { try { return fs.readFileSync(path.join(m.dir, p), 'utf8'); } catch { return ''; } }).join('\n');
  const text = rows.map((r) => `${r[1]} ${r[2]}`).join('\n');
  for (const x of names) {
    if (!src.includes(x)) errs.push(`tool name not found in source: ${x}`);
    if (!text.includes('`' + x + '`')) errs.push(`tool not covered by any feature row: ${x}`);
  }
  return errs;
}

// finding id -> first evidence link
function evidence() {
  const map = new Map();
  for (const m of manifest) {
    const f = path.join(root, m.file);
    if (!fs.existsSync(f)) continue;
    for (const r of parse(m.n).rows) map.set(r[0], (r[3].match(/\((https:\/\/[^)\s]+)\)/) || [])[1]);
  }
  return map;
}

function expandParity() {
  const ev = evidence(), errs = [];
  let t = fs.readFileSync(PARITY, 'utf8');
  t = t.replace(/(?<![\[\w-])(\d\d-F\d{2,3})\b(?!\]\()/g, (id) => {
    if (!ev.get(id)) { errs.push(`unknown finding id ${id}`); return id; }
    return `[${id}](${ev.get(id)})`;
  });
  fs.writeFileSync(PARITY, t);
  return errs;
}

const TARGETS = ['ext/manifest', 'ext/background', 'ext/grants', 'ext/page', 'ext/sidebar', 'ext/overlay', 'ext/capture', 'ext/options', 'host/native', 'host/claude-runner', 'mcp/server', 'shared/protocol', 'install/windows', 'build/release', 'test/', 'docs/', 'none'];
const SECTIONS = ['How to use this document', 'Pinned sources and licenses', 'Platform prerequisites', 'Permission boundaries', 'Architecture and component map', 'Decisions', 'Capability matrix', 'Features that need a different Firefox implementation', 'Excluded and blocked capabilities', 'Findings not carried as capabilities', 'Claude in Chrome benchmark coverage', 'Open questions', 'Audit limits'];
// groups: digest group names; empty means every finding and every section must be present
function checkParity(groups) {
  const errs = [], ev = evidence(), all = !groups.length;
  if (!fs.existsSync(PARITY)) return ['missing docs/feature-parity.md'];
  const t = fs.readFileSync(PARITY, 'utf8');
  const rows = t.split('\n').filter((l) => /^\|\s*FC-/.test(l)).map(cells);
  const seen = new Set(), used = new Set();
  if (rows.length < (all ? 100 : 40)) errs.push(`only ${rows.length} FC- rows`);
  if (all) for (const s of SECTIONS) if (!t.includes(`\n## ${s}\n`)) errs.push(`section missing: ${s}`);
  for (const r of rows) {
    if (r.length !== 8) continue;
    if (!TARGETS.some((x) => r[5].includes(x))) errs.push(`${r[0]}: target names no known component`);
    if (/^(`)?(implemented|partial|excluded|platform-blocked|deferred|planned-adapted)/.test(r[7]) && !/: \S{3}/.test(r[7])) errs.push(`${r[0]}: status needs a reason after a colon`);
    if (r[4].length < 8) errs.push(`${r[0]}: platform prerequisites too thin`);
    if (r[2].length < 40) errs.push(`${r[0]}: observable behavior too thin`);
  }
  for (const r of rows) {
    const id = r[0];
    if (!/^FC-[A-Z]{2,5}-\d{2,3}$/.test(id)) errs.push(`bad id ${id}`);
    if (seen.has(id)) errs.push(`duplicate id ${id}`);
    seen.add(id);
    if (r.length !== 8) { errs.push(`${id}: ${r.length} cells, expected 8`); continue; }
    if (r.some((c) => !c || c === '-')) errs.push(`${id}: empty cell`);
    const links = [...r[3].matchAll(/\[(\d\d-F\d{2,3})\]\((https:\/\/[^)]+)\)/g)];
    if (!links.length) errs.push(`${id}: no pinned source link`);
    if (!STATUSES.includes(r[7].replace(/`/g, '').split(/[ :(]/)[0])) errs.push(`${id}: bad status "${r[7]}"`);
    if (r[6].length < 25) errs.push(`${id}: acceptance test too thin`);
    for (const [x] of r[3].matchAll(/(?<![\[\w-])\d\d-F\d{2,3}(?!\]\()/g)) errs.push(`${id}: unlinked finding id ${x}`);
  }
  for (const [, id, url] of t.matchAll(/\[(\d\d-F\d{2,3})\]\((https:\/\/[^)]+)\)/g)) {
    used.add(id);
    if (!ev.has(id)) errs.push(`unknown finding id ${id}`);
    else if (ev.get(id) !== url) errs.push(`${id}: link differs from the findings`);
  }
  const wanted = all ? [...ev.keys()] : groups.flatMap((g) => fs.readFileSync(path.join(inbox, 'digest', g + '.md'), 'utf8').split('\n').map((l) => l.split(' | ')[0]).filter((x) => ev.has(x)));
  const missing = wanted.filter((k) => !used.has(k));
  if (missing.length) errs.push(`${missing.length} findings not carried into the parity document: ${missing.slice(0, 40).join(' ')}`);
  for (const m of manifest) if (!t.includes(m.sha)) errs.push(`pin missing for ${m.n} ${m.repo}`);
  const cited = new Set([...t.matchAll(/\bFC-[A-Z]{2,5}-\d{2,3}\b/g)].map((x) => x[0]));
  for (const id of cited) if (!seen.has(id)) errs.push(`reference to undefined ${id}`);
  console.log(`rows ${rows.length}, findings ${ev.size}, carried ${used.size}`);
  return errs;
}

const [cmd, ...args] = process.argv.slice(2);
let errs = [];
if (cmd === 'expand') for (const n of args) errs.push(...expand(n).map((e) => `${n}: ${e}`));
else if (cmd === 'check') for (const n of args) errs.push(...check(n).map((e) => `${n}: ${e}`));
else if (cmd === 'expand-parity') errs = expandParity();
else if (cmd === 'check-parity') errs = checkParity(args);
else { console.error('usage: expand|check NN... | expand-parity | check-parity [GROUP...]'); process.exit(2); }
if (errs.length) { console.error(errs.slice(0, 80).join('\n')); console.error(`FAIL ${errs.length} problem(s)`); process.exit(1); }
console.log('OK', cmd, args.join(' '));
