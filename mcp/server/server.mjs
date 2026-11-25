// Installed as <home>\mcp\server.mjs. Options: "--with isolated,input" lists the tools of those optional backends as well;
// "--mail" serves Thunderbird instead of Firefox. Listing is no right: the add-on refuses what the user has not turned on.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Link } from './link.mjs';
import { PROTOCOL } from './protocol.mjs';
import { serve } from './serve.mjs';

const [option, list, ...rest] = process.argv.slice(2);
const parts = option === '--mail' ? ['mail'] : option === '--with' ? String(list).split(',') : [];
const known = option === undefined || (option === '--mail' && list === undefined) || (option === '--with' && rest.length === 0 && parts.every((p) => ['isolated', 'input'].includes(p)));
if (!known) {
  console.error('Options: --with isolated,input   or   --mail');
  process.exit(2);
}
serve(new Link(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'), PROTOCOL, { kind: parts.includes('mail') ? 'mail' : 'firefox' }), parts);
