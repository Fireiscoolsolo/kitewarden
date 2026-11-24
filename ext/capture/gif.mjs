// GIF recordings: covered pictures before and after each action of one session in one tab, in memory until the user saves.
import { LIMITS, ToolError } from '../shared/protocol.mjs';
import { encodeGif } from './encoder.mjs';

const KEEP = 4; // recordings

const key = (session, tabId) => `${session} ${tabId}`;

export class Gif {
  #recs = new Map();

  /** `draw` turns stored frames into pixels: it needs a canvas, so tests replace it. */
  constructor({ draw = drawFrames, onChange = () => {}, onStop = () => {}, makeUrl = (bytes) => URL.createObjectURL(new Blob([bytes], { type: 'image/gif' })), dropUrl = (u) => URL.revokeObjectURL(u) } = {}) {
    Object.assign(this, { draw, onChange, onStop, makeUrl, dropUrl });
  }

  start(session, tabId) {
    this.clear(session, tabId);
    while (this.#recs.size >= KEEP) this.#drop([...this.#recs.keys()][0]);
    this.#recs.set(key(session, tabId), { session, tabId, on: true, frames: [], missed: 0, why: null, file: null });
    this.onChange();
  }

  wants(session, tabId) {
    return this.#recs.get(key(session, tabId))?.on === true;
  }

  frames(session, tabId) {
    return this.#recs.get(key(session, tabId))?.frames.length ?? 0;
  }

  add(session, tabId, frame) {
    const r = this.#recs.get(key(session, tabId));
    if (!r?.on) return; // stopped while the picture was taken
    r.frames.push(frame);
    if (r.frames.length >= LIMITS.gifFrames) this.stop(session, tabId, `It has ${LIMITS.gifFrames} frames, the most it can have.`);
    this.onChange();
  }

  missed(session, tabId, why) {
    const r = this.#recs.get(key(session, tabId));
    if (r) Object.assign(r, { missed: r.missed + 1, why });
    this.onChange();
  }

  stop(session, tabId, why) {
    const r = this.#recs.get(key(session, tabId));
    if (!r?.on) return;
    Object.assign(r, { on: false, why });
    this.onStop(tabId);
    this.onChange();
  }

  grantEnded(g) {
    this.stop(g.sessionId, g.tabId, 'It stopped because the tab is no longer attached, its site changed, or everything is paused.');
  }

  clear(session, tabId) {
    this.stop(session, tabId, 'stopped');
    this.#drop(key(session, tabId));
    this.onChange();
  }

  #drop(k) {
    const r = this.#recs.get(k);
    if (r?.on) this.stop(r.session, r.tabId, 'stopped');
    if (r?.file) this.dropUrl(r.file.url);
    this.#recs.delete(k);
  }

  async export(session, tabId, { quality = 10, marks = true, labels = true, progress = true }) {
    const r = this.#recs.get(key(session, tabId));
    if (!r?.frames.length) throw new ToolError('not_found', 'There is no recording with frames.');
    const { width, height, frames } = await this.draw(r.frames, { marks, labels, progress, edge: LIMITS.gifEdge });
    const bytes = await encodeGif({ width, height, frames, quality });
    if (r.file) this.dropUrl(r.file.url);
    r.file = { url: this.makeUrl(bytes), bytes: bytes.length };
    this.onChange();
    return { frames: frames.length, width, height, bytes: bytes.length, saved: false, next_step: 'The user saves it with Save GIF in the sidebar. Review it before sharing.' };
  }

  view() {
    return [...this.#recs.values()].map(({ session, tabId, on, frames, missed, why, file }) => ({ session, tabId, on, frames: frames.length, missed, why, file }));
  }
}

async function drawFrames(list, { marks, labels, progress, edge }) {
  const images = [];
  for (const f of list) images.push(await createImageBitmap(await (await fetch(f.dataUrl)).blob()));
  const scale = Math.min(1, edge / Math.max(images[0].width, images[0].height));
  const width = Math.max(1, Math.round(images[0].width * scale));
  const height = Math.max(1, Math.round(images[0].height * scale));
  const canvas = document.createElement('canvas');
  Object.assign(canvas, { width, height });
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const frames = images.map((img, i) => {
    const { label, at } = list[i];
    g.drawImage(img, 0, 0, width, height);
    if (marks && at) {
      g.lineWidth = 3;
      g.strokeStyle = '#e22850';
      g.beginPath();
      g.arc(at.x * width, at.y * height, 14, 0, 7);
      g.stroke();
    }
    if (labels && label) {
      g.font = '14px sans-serif';
      const text = label.slice(0, 80);
      g.fillStyle = '#1c1b22e0';
      g.fillRect(6, height - 32, Math.min(width - 12, g.measureText(text).width + 16), 24);
      g.fillStyle = '#fff';
      g.fillText(text, 14, height - 15, width - 28);
    }
    if (progress) {
      g.fillStyle = '#e22850';
      g.fillRect(0, height - 4, (width * (i + 1)) / images.length, 4);
    }
    img.close();
    return { rgba: g.getImageData(0, 0, width, height).data, delayMs: label ? 1200 : 700 };
  });
  return { width, height, frames };
}
