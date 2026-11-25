// Site rules of the user. They stand above every grant: a grant says what a session may do, a rule says where nobody may.
import { ToolError } from '../shared/protocol.mjs';

export const KINDS = ['block', 'ask', 'allow'];
const MAX = 200;

export const noRules = () => ({ block: [], ask: [], allow: [] });

/** The host of an entry or an address, without the dot that may end it, or null. */
function hostOf(text) {
  try {
    const u = new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`);
    return u.username || u.password ? null : u.hostname.replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

/** Rules as they were stored. Anything else is no rule set, and then nothing may go on as if there were none. */
export const readable = (rules) => KINDS.every((k) => Array.isArray(rules?.[k]) && rules[k].every((h) => typeof h === 'string' && hostOf(h) === h));

const covers = (list, host) => list.some((h) => host === h || host.endsWith(`.${h}`));

/** What the rules say about a site: 'block', 'ask' or null. Never wins; a list of allowed sites blocks all others. */
export function ruleFor(rules, origin) {
  const host = origin && hostOf(origin);
  if (!host || covers(rules.block, host) || (rules.allow.length && !covers(rules.allow, host))) return 'block';
  return covers(rules.ask, host) ? 'ask' : null;
}

export function addRule(rules, kind, text) {
  const host = hostOf(String(text).trim().replace(/^\*\./, ''));
  if (!KINDS.includes(kind) || !host || /[\s/*]/.test(host)) throw new ToolError('invalid_argument', 'Give a site like example.com.');
  if (rules[kind].length >= MAX) throw new ToolError('limit_reached', `There are ${MAX} entries. Remove one first.`);
  return { ...rules, [kind]: [...new Set([...rules[kind], host])] };
}

export const removeRule = (rules, kind, host) => (KINDS.includes(kind) ? { ...rules, [kind]: rules[kind].filter((h) => h !== host) } : rules);
