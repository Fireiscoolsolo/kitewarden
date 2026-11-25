// Installed as <home>\mcp\server.mjs. Options: "--with isolated,input" lists the tools of those optional backends as well;
// "--mail" serves Thunderbird instead of Firefox; "--home <folder>" names another installation. Listing is no right: the add-on refuses what the user has not turned on.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Link } from './link.mjs';
import { PROTOCOL } from './protocol.mjs';
import { serve } from './serve.mjs';

const args = process.argv.slice(2);
const at = args.indexOf('--home');
const [, given] = at < 0 ? [] : args.splice(at, 2);
const [option, list, ...rest] = args;
const parts = option === '--mail' ? ['mail'] : option === '--with' ? String(list).split(',') : [];
const known = (at < 0 || given) && (option === undefined || (option === '--mail' && list === undefined) || (option === '--with' && rest.length === 0 && parts.every((p) => ['isolated', 'input'].includes(p))));
if (!known) {
  console.error('Options: [--home folder] and --with isolated,input   or   --mail');
  process.exit(2);
}
serve(new Link(given ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'), PROTOCOL, { kind: parts.includes('mail') ? 'mail' : 'firefox' }), parts);
