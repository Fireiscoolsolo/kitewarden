// Real mouse clicks in a window of the everyday Firefox, for pages that ignore synthetic events. The user starts it, on the same
// desktop. It gets one click at a time, after the approval, and Input.exe refuses when the window or the moment does not fit.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Backend, before, homeOf, options, profileOf } from './link.mjs';

const EXE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'kitewarden-input.exe');

const o = options(process.argv.slice(2), { home: 'folder' });
if (process.platform !== 'win32' || !existsSync(EXE)) {
  console.error('This needs Windows and the built program kitewarden-input.exe next to it.');
  process.exit(1);
}

const handlers = {
  click: ({ x, y, count, title }, c) =>
    new Promise((resolve, reject) => {
      const helper = profileOf(backend.link)?.pid;
      if (!helper || ![x, y, count].every(Number.isSafeInteger)) return reject(before('not_actionable', 'The Firefox of this profile was not found.'));
      const child = execFile(EXE, [helper, x, y, count].map(String), { timeout: 15_000, windowsHide: true }, (e, out) => {
        clearInterval(watch);
        if (/^sent/.test(out)) resolve({ sent: true });
        else if (/^refused: /.test(out)) resolve({ sent: false, why: `No click was sent: ${out.slice(9, 200)}.` });
        else reject(c.cancelled ? before('cancelled', 'It was cancelled before the click.') : Object.assign(new Error('The input program ended without an answer.'), { code: 'outcome_unknown' }));
      });
      child.stdin.on('error', () => {});
      child.stdin.end(String(title));
      const watch = setInterval(() => c.cancelled && child.kill(), 30); // while it waits for the user to rest
    }),
};

const backend = new Backend({ home: homeOf(o), id: 'input', info: { channel: 'Windows messages', detail: 'mouse clicks only' }, handlers });
const end = () => {
  backend.stop();
  process.exit(0);
};
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(s, end);
if (process.env.FC_BACKEND_STDIN === '1') process.stdin.on('end', end).resume();
backend.run();
