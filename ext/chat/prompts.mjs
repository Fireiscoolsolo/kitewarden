// Saved prompts: text that the user names and starts with /name, with blanks like {{city}}. Running one gives no right.
import { ToolError } from '../shared/protocol.mjs';

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const BLANK = /\{\{\s*([^{}]{1,40}?)\s*\}\}/g;
const MAX = 100;

export const blanks = (text) => [...new Set([...text.matchAll(BLANK)].map((m) => m[1]))];
export const filled = (text, values) => text.replace(BLANK, (_, name) => values[name] ?? '');

/** The saved prompt that an input starts, with what follows its name, or null. */
export function called(list, input) {
  const m = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/.exec(input.trim());
  const prompt = m && list.find((p) => p.name === m[1]);
  return prompt ? { prompt, rest: m[2] ?? '' } : null;
}

export class Prompts {
  constructor({ store, onChange = () => {} }) {
    Object.assign(this, { store, onChange, list: [] });
  }

  async load() {
    this.list = (await this.store.get({ prompts: [] })).prompts ?? [];
    this.onChange();
  }

  #keep(list) {
    this.list = list.sort((a, b) => a.name.localeCompare(b.name));
    this.onChange();
    return this.store.set({ prompts: this.list });
  }

  save({ name, text, replace }) {
    const value = String(text).trim();
    if (!NAME.test(name) || name.length > 40) throw new ToolError('invalid_argument', 'A name has lower case letters, digits and single hyphens, at most 40.');
    if (!value || value.length > 20_000) throw new ToolError('invalid_argument', 'A saved prompt has 1 to 20000 characters.');
    const others = this.list.filter((p) => p.name !== name);
    if (others.length < this.list.length && replace !== true) throw new ToolError('conflict', `/${name} exists already. Save it again to replace it.`);
    if (others.length >= MAX) throw new ToolError('limit_reached', `There are ${MAX} saved prompts. Delete one first.`);
    return this.#keep([...others, { name, text: value }]);
  }

  remove(name) {
    return this.#keep(this.list.filter((p) => p.name !== name));
  }
}
