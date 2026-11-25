// Developer build only. Runs code that the user approved in the world of the page, with the rights of the page and under its
// content security policy. Nothing of the add-on is within its reach.
(() => {
  if (globalThis.companionScript) return;
  globalThis.companionScript = true;
  const id = crypto.randomUUID().slice(0, 8);
  const page = window.wrappedJSObject;

  async function run({ code, ms }) {
    let promise;
    try {
      // The page's own eval, in its own scope: a policy that forbids it counts.
      promise = page.eval(`(async () => { const value = await (async () => {\n${code}\n})(); return JSON.stringify(value === undefined ? null : value); })()`);
    } catch (e) {
      return { error: 'page_error', message: String(e?.message ?? e).slice(0, 500) };
    }
    const LATE = {};
    try {
      const text = await Promise.race([new Promise((ok, no) => promise.then(exportFunction(ok, window), exportFunction(no, window))), new Promise((r) => setTimeout(r, ms, LATE))]);
      if (text === LATE) return { timed_out: true };
      return { json: String(text).slice(0, 20_001) };
    } catch (e) {
      return { error: 'page_error', message: String(e?.message ?? e).slice(0, 500) };
    }
  }

  browser.runtime.onMessage.addListener((m) => {
    if (m.cmd !== 'script') return;
    if (self.origin !== m.origin) return Promise.resolve({ error: 'origin_changed', message: 'The document has another origin.' });
    return run(m).then((r) => ({ ...r, id }));
  });
})();
