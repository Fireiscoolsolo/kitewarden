// Drives the installed Firefox with a disposable profile through Marionette. Only the test uses this remote control;
// the product never opens a port.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { sleep, until } from '../helpers.mjs';

export const FIREFOX = process.env.FC_FIREFOX ?? 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';

const PREFS = {
  'marionette.port': 0,
  'app.update.disabledForTesting': true,
  'browser.aboutwelcome.enabled': false,
  'browser.preonboarding.enabled': false,
  'browser.shell.checkDefaultBrowser': false,
  'browser.startup.homepage': 'about:blank',
  'browser.startup.page': 0,
  'browser.newtabpage.enabled': false,
  'datareporting.healthreport.uploadEnabled': false,
  'datareporting.policy.dataSubmissionEnabled': false,
  'termsofuse.bypassNotification': true,
  'toolkit.telemetry.reportingpolicy.firstRun': false,
};

class Marionette {
  #id = 1;
  #waiting = new Map();
  #buf = Buffer.alloc(0);

  static async connect(port) {
    const m = new Marionette();
    m.socket = net.connect(port, '127.0.0.1');
    await new Promise((ok, no) => m.socket.once('connect', ok).once('error', no));
    m.socket.on('error', () => {});
    m.socket.on('data', (d) => m.#read(d));
    return m;
  }

  #read(d) {
    this.#buf = Buffer.concat([this.#buf, d]);
    for (;;) {
      const colon = this.#buf.indexOf(':');
      if (colon < 0) return;
      const n = Number(this.#buf.subarray(0, colon));
      if (this.#buf.length < colon + 1 + n) return;
      const msg = JSON.parse(this.#buf.subarray(colon + 1, colon + 1 + n));
      this.#buf = this.#buf.subarray(colon + 1 + n);
      if (!Array.isArray(msg)) continue; // the greeting
      const [, id, error, result] = msg;
      const w = this.#waiting.get(id);
      this.#waiting.delete(id);
      if (error) w?.reject(new Error(`${error.error}: ${error.message}\n${error.stacktrace ?? ''}`));
      else w?.resolve(result);
    }
  }

  send(command, params = {}) {
    const id = this.#id++;
    const body = JSON.stringify([0, id, command, params]);
    this.socket.write(`${Buffer.byteLength(body)}:${body}`);
    return new Promise((resolve, reject) => this.#waiting.set(id, { resolve, reject }));
  }
}

export class Firefox {
  static async start({ headed = process.env.FC_HEADED === '1', prefs = {}, env = {} } = {}) {
    const f = new Firefox();
    f.profile = mkdtempSync(path.join(os.tmpdir(), 'fc-profile-'));
    writeFileSync(path.join(f.profile, 'user.js'), Object.entries({ ...PREFS, ...prefs }).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n'));
    const args = ['-marionette', '-no-remote', '-profile', f.profile, '-width', '1280', '-height', '900'];
    if (!headed) args.unshift('-headless');
    // Firefox 160 asks for this variable before it lets a test look into its own windows. It reaches this process only.
    // Nothing of a Claude session that happens to run this test reaches Firefox, its helper or the user's Claude Code.
    const own = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/.test(k)));
    spawn(FIREFOX, args, { stdio: 'ignore', env: { ...own, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1', ...env } });
    const portFile = path.join(f.profile, 'MarionetteActivePort');
    const port = Number(await until('Marionette port', () => existsSync(portFile) && readFileSync(portFile, 'utf8').trim(), 60_000));
    f.m = await Marionette.connect(port);
    const session = await f.m.send('WebDriver:NewSession', { capabilities: { alwaysMatch: { acceptInsecureCerts: true, unhandledPromptBehavior: 'ignore' } } });
    f.capabilities = session.capabilities;
    f.pid = session.capabilities['moz:processID'];
    f.version = session.capabilities.browserVersion;
    await f.m.send('WebDriver:SetTimeouts', { script: 60_000, pageLoad: 30_000, implicit: 0 });
    return f;
  }

  async #script(context, script, args) {
    await this.m.send('Marionette:SetContext', { value: context });
    const { value } = await this.m.send('WebDriver:ExecuteScript', { script: `return (async () => { ${script} })();`, args, sandbox: context === 'chrome' ? 'system' : null, newSandbox: false });
    return value;
  }
  /** Privileged script in the browser window. */
  chrome(script, ...args) {
    return this.#script('chrome', script, args);
  }
  /** Script in the current tab. */
  page(script, ...args) {
    return this.#script('content', script, args);
  }

  async install(dir) {
    await this.m.send('Marionette:SetContext', { value: 'chrome' });
    return (await this.m.send('Addon:Install', { path: dir, temporary: true })).value;
  }

  async navigate(url) {
    await this.m.send('Marionette:SetContext', { value: 'content' });
    await this.m.send('WebDriver:Navigate', { url });
  }

  async tab(url) {
    await this.m.send('Marionette:SetContext', { value: 'content' });
    const { handle } = await this.m.send('WebDriver:NewWindow', { type: 'tab', focus: true });
    await this.m.send('WebDriver:SwitchToWindow', { handle, focus: true });
    if (url) await this.navigate(url);
    return handle;
  }

  async select(handle) {
    await this.m.send('Marionette:SetContext', { value: 'content' });
    await this.m.send('WebDriver:SwitchToWindow', { handle, focus: true });
  }

  /** A real click on an element of the page, or keys typed into it. */
  async #element(selector) {
    await this.m.send('Marionette:SetContext', { value: 'content' });
    return Object.values((await this.m.send('WebDriver:FindElement', { using: 'css selector', value: selector })).value)[0];
  }
  async pageClick(selector) {
    await this.m.send('WebDriver:ElementClick', { id: await this.#element(selector) });
  }
  async pageKeys(selector, text) {
    await this.m.send('WebDriver:ElementSendKeys', { id: await this.#element(selector), text });
  }

  async handle() {
    await this.m.send('Marionette:SetContext', { value: 'content' });
    return (await this.m.send('WebDriver:GetWindowHandle')).value;
  }

  /** Answers Firefox's own permission prompt and returns its text. */
  async prompt(allow) {
    const open = 'return PopupNotifications.panel.state === "open" && !!PopupNotifications.getNotification("addon-webext-permissions", gBrowser.selectedBrowser)';
    await until('Firefox permission prompt', () => this.chrome(open), 8000, 100);
    const text = (await this.chrome('return document.getElementById("addon-webext-permissions-notification").textContent')).trim().replace(/\s+/g, ' ');
    await sleep(700); // Firefox ignores clicks on a prompt that has just appeared
    await this.chrome(`document.querySelector('#addon-webext-permissions-notification .popup-notification-${allow ? 'primary' : 'secondary'}-button').click()`);
    await until('prompt closed', () => this.chrome('return PopupNotifications.panel.state === "closed"'), 8000, 100);
    return text;
  }

  async quit() {
    await this.m.send('Marionette:Quit', { flags: ['eForceQuit'] }).catch(() => {});
    this.m.socket.destroy();
    await until('profile removed', async () => {
      try {
        rmSync(this.profile, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    }, 20_000, 300);
  }
}

/** The real sidebar document, in its own process. */
export class Sidebar {
  constructor(firefox, addonId) {
    this.f = firefox;
    this.id = addonId;
  }

  async open() {
    await this.f.chrome(`
      const id = arguments[0].replace(/[^a-z0-9_-]/gi, '_').toLowerCase() + '-sidebar-action';
      const s = window.SidebarController ?? window.SidebarUI;
      if (!s.isOpen || s.currentID !== id) await s.show(id);
    `, this.id);
    await until('sidebar loaded', () => this.eval('return document.readyState === "complete" && !!document.getElementById("link-title")').catch(() => false), 15_000, 200);
  }

  /** Runs script in the sidebar document through Marionette's own window actor. Reads only; gestures go through click(). */
  eval(script, ...args) {
    return this.f.chrome(`
      const inner = document.getElementById('sidebar').contentDocument.getElementById('webext-panels-browser');
      const actor = inner.browsingContext.currentWindowGlobal.getActor('MarionetteCommands');
      return await actor.executeScript('return (async () => { ' + arguments[0] + ' })();', arguments[1], { sandboxName: null, timeout: 20000 });
    `, script, args);
  }

  async text(selector) {
    return this.eval('return document.querySelector(arguments[0])?.textContent ?? null', selector);
  }

  /** A real mouse click at the place of the element, sent to the browser window. */
  async click(selector, index = 0) {
    // The part of the sidebar that holds the element is opened first, as a user would.
    const closed = await this.eval('return document.querySelectorAll(arguments[0])[arguments[1]]?.closest("[data-panel][hidden]")?.dataset.panel ?? null', selector, index);
    if (closed) await this.click(`[data-show="${closed}"]`);
    const at = await this.eval(`
      const e = document.querySelectorAll(arguments[0])[arguments[1]];
      if (!e) return null;
      e.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = e.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    `, selector, index);
    if (!at) throw new Error(`no ${selector} in the sidebar`);
    await this.f.chrome(`
      const [x, y] = arguments[0];
      const inner = document.getElementById('sidebar').contentDocument.getElementById('webext-panels-browser');
      const outer = document.getElementById('sidebar').getBoundingClientRect();
      const r = inner.getBoundingClientRect();
      const px = outer.left + r.left + x, py = outer.top + r.top + y;
      window.synthesizeMouseEvent('mousemove', px, py, { button: 0, clickCount: 0 });
      window.synthesizeMouseEvent('mousedown', px, py, { button: 0, clickCount: 1 });
      window.synthesizeMouseEvent('mouseup', px, py, { button: 0, clickCount: 1 });
    `, at);
  }

  /** Attaches the current tab. `answer` is for Firefox's prompt; null when none is expected. Returns the prompt's text. */
  async attach(label, level, answer) {
    await this.choose('#session', await this.eval('return [...document.querySelectorAll("#session option")].find((o) => o.textContent.includes(arguments[0]))?.value', label));
    await this.choose('#level', level);
    await this.eval('document.querySelector("#message").textContent = ""');
    await this.click('#attach');
    const text = answer === null ? null : await this.f.prompt(answer);
    await until('answer of the sidebar', () => this.text('#message'));
    return text;
  }

  waitCard() {
    return until('approval card', () => this.text('#cards .card'), 5000, 20);
  }

  async answerCard(allow) {
    await this.waitCard();
    await sleep(700);
    await this.click(allow ? '.card .allow' : '.card .deny');
  }

  async choose(selector, value) {
    // A select opens a native list, so the value is set and announced; nothing is granted by this.
    await this.eval(`
      const s = document.querySelector(arguments[0]);
      s.value = arguments[1];
      s.dispatchEvent(new Event('change', { bubbles: true }));
    `, selector, value);
  }
}

export { sleep };
