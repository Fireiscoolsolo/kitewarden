// Developer build only: the one tool that takes code. Off at first, level act, and the user sees the whole code each time.
import { ToolError, VIRTUAL } from '../shared/protocol.mjs';
import { redactBody } from '../shared/redact.mjs';

async function script(r, call, spec, origin, a) {
  if (call.tabId >= VIRTUAL) throw new ToolError('not_supported', 'Page script runs in tabs of this Firefox only.');
  await r.ask(call, spec, origin, { tool: 'javascript_tool', target: `Script with the rights of ${origin}`, value: a.code }, a.reason);
  await r.api.browser.tabs.executeScript(call.tabId, { file: '/page/pagescript.js', runAt: 'document_end', frameId: 0 });
  if ((await r.authorize(call, spec)) !== origin) throw new ToolError('origin_changed', 'The page changed its origin.');
  r.sent(call, 'page script');
  const ms = (a.timeout_s ?? 10) * 1000;
  const x = await r.page(call, origin, { cmd: 'script', code: a.code, ms, slow: ms + 2000 });
  call.sent.outcome = 'done';
  if (x.timed_out) return { origin, timed_out: true, note: 'The wait ended. The code may still run.' };
  if (x.json.length > 20_000) throw new ToolError('too_large', 'The result is longer than 20,000 characters.');
  return { origin, result: redactBody(x.json), from: 'the page' };
}

export const scriptTools = { javascript_tool: script };
