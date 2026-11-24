// GIF89a encoder: one palette per frame (median cut over 5 bits per channel) and LZW. Pure functions.

/** At most 256 colors. `step` samples every n-th pixel. */
export function palette(rgba, step) {
  const count = new Uint32Array(32768);
  for (let i = 0; i < rgba.length; i += 4 * step) count[((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3)]++;
  const colors = [];
  for (let c = 0; c < 32768; c++) if (count[c]) colors.push(c);
  const part = (c, ch) => (c >> (10 - 5 * ch)) & 31;
  const box = (list) => {
    let best = 0;
    let width = -1;
    for (let ch = 0; ch < 3; ch++) {
      let lo = 31;
      let hi = 0;
      for (const c of list) {
        lo = Math.min(lo, part(c, ch));
        hi = Math.max(hi, part(c, ch));
      }
      if (hi - lo > width) [best, width] = [ch, hi - lo];
    }
    return { list, ch: best, width };
  };
  const boxes = [box(colors)];
  while (boxes.length < 256) {
    let at = -1;
    for (let i = 0; i < boxes.length; i++) if (boxes[i].list.length > 1 && (at < 0 || boxes[i].width > boxes[at].width)) at = i;
    if (at < 0) break;
    const { list, ch } = boxes[at];
    list.sort((a, b) => part(a, ch) - part(b, ch));
    const half = list.reduce((s, c) => s + count[c], 0) / 2;
    let sum = 0;
    let cut = 0;
    while (cut < list.length - 1 && sum < half) sum += count[list[cut++]];
    cut = Math.max(1, Math.min(cut, list.length - 1));
    boxes.splice(at, 1, box(list.slice(0, cut)), box(list.slice(cut)));
  }
  const out = new Uint8Array(768);
  boxes.forEach(({ list }, i) => {
    const n = list.reduce((s, c) => s + count[c], 0) || 1;
    for (let ch = 0; ch < 3; ch++) out[i * 3 + ch] = Math.round(((list.reduce((s, c) => s + part(c, ch) * count[c], 0) / n) * 255) / 31);
  });
  return { colors: out, size: boxes.length };
}

function indices(rgba, { colors, size }) {
  const cache = new Int16Array(32768).fill(-1);
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    const key = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3);
    if (cache[key] < 0) {
      let best = 0;
      let d = Infinity;
      for (let c = 0; c < size; c++) {
        const e = (colors[c * 3] - rgba[i]) ** 2 + (colors[c * 3 + 1] - rgba[i + 1]) ** 2 + (colors[c * 3 + 2] - rgba[i + 2]) ** 2;
        if (e < d) [best, d] = [c, e];
      }
      cache[key] = best;
    }
    out[p] = cache[key];
  }
  return out;
}

/** LZW with 8-bit symbols, in sub-blocks of at most 255 bytes. */
export function lzw(symbols) {
  const CLEAR = 256;
  const END = 257;
  const out = [];
  let bits = 0;
  let n = 0;
  let block = [];
  const put = (code, size) => {
    bits |= code << n;
    n += size;
    while (n >= 8) {
      block.push(bits & 255);
      bits >>>= 8;
      n -= 8;
      if (block.length === 255) {
        out.push(255, ...block);
        block = [];
      }
    }
  };
  let dict = new Map();
  let next = END + 1;
  let size = 9;
  put(CLEAR, size);
  let cur = symbols[0];
  for (let i = 1; i < symbols.length; i++) {
    const key = cur * 256 + symbols[i];
    const hit = dict.get(key);
    if (hit !== undefined) {
      cur = hit;
      continue;
    }
    put(cur, size);
    if (next < 4096) {
      dict.set(key, next);
      if (next === 1 << size) size++; // the decoder is one entry behind
      next++;
    } else {
      put(CLEAR, size);
      dict = new Map();
      next = END + 1;
      size = 9;
    }
    cur = symbols[i];
  }
  put(cur, size);
  put(END, size);
  if (n > 0) block.push(bits & 255);
  if (block.length) out.push(block.length, ...block);
  out.push(0);
  return out;
}

/** `frames`: { rgba, delayMs }. Gives way to other work after each frame. */
export async function encodeGif({ width, height, frames, quality = 10 }) {
  const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
  const u16 = (v) => [v & 255, v >> 8];
  const parts = [new Uint8Array([...ascii('GIF89a'), ...u16(width), ...u16(height), 0x70, 0, 0])];
  parts.push(new Uint8Array([0x21, 0xff, 11, ...ascii('NETSCAPE2.0'), 3, 1, 0, 0, 0])); // repeat without end
  for (const { rgba, delayMs } of frames) {
    const p = palette(rgba, quality);
    parts.push(new Uint8Array([0x21, 0xf9, 4, 4, ...u16(Math.round(delayMs / 10)), 0, 0, 0x2c, 0, 0, 0, 0, ...u16(width), ...u16(height), 0x87]));
    parts.push(p.colors, new Uint8Array([8]), Uint8Array.from(lzw(indices(rgba, p))));
    await new Promise((r) => setTimeout(r));
  }
  parts.push(new Uint8Array([0x3b]));
  const out = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
  let at = 0;
  for (const x of parts) {
    out.set(x, at);
    at += x.length;
  }
  return out;
}
