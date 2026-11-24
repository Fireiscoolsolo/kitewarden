// Markdown of replies as a tree of a few fixed elements. Nothing is parsed as HTML, so a tag in a reply is text.

const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|\[([^\]\n]*)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>"')\]]+)/g;

function link(text, href) {
  try {
    const u = new URL(href);
    if (u.protocol === 'http:' || u.protocol === 'https:') return { tag: 'a', href: u.href, children: [text || u.href] };
  } catch {
    // not an address
  }
  return null;
}

/** Text and { tag, children } nodes of one paragraph. */
export function inline(s) {
  const out = [];
  let at = 0;
  for (const m of s.matchAll(INLINE)) {
    if (m.index > at) out.push(s.slice(at, m.index));
    at = m.index + m[0].length;
    const [all, code, bold, italic, label, href, bare] = m;
    if (code !== undefined) out.push({ tag: 'code', children: [code] });
    else if (bold !== undefined) out.push({ tag: 'strong', children: inline(bold) });
    else if (italic !== undefined) out.push({ tag: 'em', children: inline(italic) });
    else out.push((href !== undefined ? link(label, href) : link(bare, bare)) ?? all);
  }
  if (at < s.length) out.push(s.slice(at));
  return out;
}

const FENCE = /^\s*(```+|~~~+)/;
const HEADING = /^#{1,6}\s+(.*)$/;
const ITEM = /^\s*(?:([-*+])|\d+[.)])\s+(.*)$/;

export function parse(md) {
  const lines = String(md).split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const fence = FENCE.exec(lines[i]);
    const heading = HEADING.exec(lines[i]);
    const item = ITEM.exec(lines[i]);
    if (fence) {
      const body = [];
      while (++i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i]);
      i++;
      out.push({ tag: 'pre', children: [body.join('\n')] });
    } else if (heading) {
      out.push({ tag: 'h3', children: inline(heading[1]) });
      i++;
    } else if (item) {
      const items = [];
      for (let m; i < lines.length && (m = ITEM.exec(lines[i])) && Boolean(m[1]) === Boolean(item[1]); i++) items.push({ tag: 'li', children: inline(m[2]) });
      out.push({ tag: item[1] ? 'ul' : 'ol', children: items });
    } else if (!lines[i].trim()) i++;
    else {
      const para = [];
      while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !ITEM.test(lines[i])) para.push(lines[i++]);
      out.push({ tag: 'p', children: inline(para.join('\n')) });
    }
  }
  return out;
}

const TAGS = new Set(['p', 'pre', 'code', 'strong', 'em', 'h3', 'ul', 'ol', 'li', 'a']);

/** `onLink` gets the full address. A link is a button without an address of its own, so nothing opens or loads by itself. */
export function render(nodes, onLink) {
  return nodes.map((n) => {
    if (typeof n === 'string') return document.createTextNode(n);
    if (!TAGS.has(n.tag)) throw new Error(n.tag);
    const el = document.createElement(n.tag === 'a' ? 'button' : n.tag);
    if (n.tag === 'a') {
      el.className = 'link';
      el.title = n.href;
      el.addEventListener('click', (e) => e.isTrusted && onLink(n.href));
    }
    el.append(...render(n.children, onLink));
    return el;
  });
}
