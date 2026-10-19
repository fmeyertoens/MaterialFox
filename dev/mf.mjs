#!/usr/bin/env node
// MaterialFox dev harness: drives an isolated Firefox over Marionette in the
// privileged chrome context so the browser UI can be inspected, scripted,
// screenshotted and hot-reloaded. See dev/README.md.

import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = path.join(ROOT, '.dev');
const PROFILE = path.join(DEV, 'profile');
const PIDFILE = path.join(DEV, 'firefox.pid');
const SHOTS = path.join(DEV, 'shots');
const PORT = Number(process.env.MF_MARIONETTE_PORT || 2829);
const DAEMON_PORT = PORT + 1;
const FIREFOX = process.env.MF_FIREFOX || 'firefox';

// ---------------------------------------------------------------- Marionette

class Client {
  // Runs `script` as an async function body in the chrome window (`arguments` and `await` work).
  async exec(script, args = []) {
    const wrapped = `return (async () => {\n${script}\n})();`;
    const r = await this.send('WebDriver:ExecuteScript', { script: wrapped, args, newSandbox: false });
    return r.value;
  }

  async selectBrowserWindow() {
    const handles = await this.send('WebDriver:GetWindowHandles');
    for (const h of handles.value ?? handles) {
      await this.send('WebDriver:SwitchToWindow', { handle: h, focus: false });
      const type = await this.exec(`return document.documentElement.getAttribute('windowtype')`);
      if (type === 'navigator:browser') return;
    }
  }
}

class Marionette extends Client {
  constructor(sock) {
    super();
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.id = 0;
    this.pending = new Map();
    this.hello = new Promise((r) => (this._hello = r));
    sock.on('data', (d) => this._onData(d));
  }

  static connect(port = PORT) {
    return new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('error', reject);
      sock.once('connect', async () => {
        const m = new Marionette(sock);
        await m.hello;
        resolve(m);
      });
    });
  }

  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const colon = this.buf.indexOf(':');
      if (colon < 0) return;
      const len = Number(this.buf.subarray(0, colon).toString());
      if (this.buf.length < colon + 1 + len) return;
      const msg = JSON.parse(this.buf.subarray(colon + 1, colon + 1 + len).toString());
      this.buf = this.buf.subarray(colon + 1 + len);
      if (!Array.isArray(msg)) {
        this._hello(msg);
        continue;
      }
      const [, id, error, result] = msg;
      const p = this.pending.get(id);
      this.pending.delete(id);
      if (error) p?.reject(new Error(`${error.error}: ${error.message}\n${error.stacktrace || ''}`));
      else p?.resolve(result);
    }
  }

  send(name, params = {}) {
    const id = ++this.id;
    const body = JSON.stringify([0, id, name, params]);
    this.sock.write(`${Buffer.byteLength(body)}:${body}`);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async session() {
    await this.send('WebDriver:NewSession', { capabilities: { alwaysMatch: {} } });
    await this.send('Marionette:SetContext', { value: 'chrome' });
    await this.selectBrowserWindow();
  }
}

// The daemon holds the single long-lived Marionette session. A new session per
// command would steal focus (NewSession focuses the content browser), closing
// popups like the urlbar results between commands.
class Remote extends Client {
  async send(name, params = {}) {
    let res;
    try {
      res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/`, { method: 'POST', body: JSON.stringify({ name, params }) });
    } catch {
      throw new Error('dev Firefox is not running — run `node dev/mf.mjs start`');
    }
    const body = await res.json();
    if (body.error) throw new Error(body.error);
    return body.result;
  }
}

async function withSession(fn) {
  return fn(new Remote());
}

// ------------------------------------------------------------------ helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) opt[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) opt[k] = argv[++i];
      else opt[k] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}

function pidAlive(file = PIDFILE) {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    process.kill(pid, 0);
    return pid;
  } catch {
    return 0;
  }
}

async function daemonUp() {
  try {
    await new Remote().send('WebDriver:GetWindowHandle');
    return true;
  } catch {
    return false;
  }
}

async function portOpen() {
  try {
    const m = await Marionette.connect();
    m.sock.end();
    return true;
  } catch {
    return false;
  }
}

// Strip variables leaked by a snap-packaged parent (e.g. VS Code), which crash snap Firefox.
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(SNAP|GTK_|GDK_PIXBUF_|GIO_|GSETTINGS_)/.test(k) || k === 'LOCPATH') delete env[k];
  }
  for (const k of Object.keys(env)) {
    const m = /^(.*)_VSCODE_SNAP_ORIG$/.exec(k);
    if (m) {
      if (env[k]) env[m[1]] = env[k];
      else delete env[m[1]];
      delete env[k];
    }
  }
  return env;
}

function writeProfile() {
  fs.mkdirSync(PROFILE, { recursive: true });
  const link = path.join(PROFILE, 'chrome');
  try {
    fs.lstatSync(link);
  } catch {
    fs.symlinkSync(path.join(ROOT, 'chrome'), link);
  }
  const prefs = [
    fs.readFileSync(path.join(ROOT, 'user.js'), 'utf8'),
    '',
    '// --- dev harness (generated by dev/mf.mjs) ---',
    `user_pref("marionette.port", ${PORT});`,
    'user_pref("devtools.chrome.enabled", true);',
    'user_pref("devtools.debugger.remote-enabled", true);',
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("browser.aboutwelcome.enabled", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("browser.tabs.warnOnClose", false);',
    'user_pref("browser.sessionstore.resume_from_crash", false);',
    'user_pref("browser.startup.page", 0);',
    'user_pref("app.update.disabledForTesting", true);',
    'user_pref("browser.toolbars.bookmarks.visibility", "always");',
    // README "recommended settings"; override in .dev/extra-prefs.js.
    'user_pref("browser.uidensity", 1);',
  ];
  const extra = path.join(DEV, 'extra-prefs.js');
  if (fs.existsSync(extra)) prefs.push(fs.readFileSync(extra, 'utf8'));
  fs.writeFileSync(path.join(PROFILE, 'user.js'), prefs.join('\n') + '\n');
}

// Emulates fx-autoconfig + userChromeAgentAuthorSheetLoader: registers
// chrome/utils/chrome.manifest and loads *.au/.ag/.us.css from the profile chrome dir.
const BOOTSTRAP = `
  if (Services.mfDevBooted) return 'already';
  const chromeDir = Services.dirsvc.get('UChrm', Ci.nsIFile);
  const manifest = chromeDir.clone();
  manifest.append('utils'); manifest.append('chrome.manifest');
  if (manifest.exists()) Components.manager.QueryInterface(Ci.nsIComponentRegistrar).autoRegister(manifest);
  const sss = Cc['@mozilla.org/content/style-sheet-service;1'].getService(Ci.nsIStyleSheetService);
  const base = Services.io.newFileURI(chromeDir).spec;
  const loaded = [];
  for (const f of chromeDir.directoryEntries) {
    const m = /\\.(au|ag|us)\\.css$/i.exec(f.leafName);
    if (!m || !f.isFile()) continue;
    const type = { au: sss.AUTHOR_SHEET, ag: sss.AGENT_SHEET, us: sss.USER_SHEET }[m[1].toLowerCase()];
    sss.loadAndRegisterSheet(Services.io.newURI(base + f.leafName), type);
    loaded.push(f.leafName);
  }
  Services.mfDevBooted = true;
  return loaded;
`;

// Re-reads every stylesheet loaded from the profile chrome dir in place
// (keeping its cascade origin), like the Browser Toolbox Style Editor does.
const RELOAD = `
  const chromeDir = Services.dirsvc.get('UChrm', Ci.nsIFile);
  const base = Services.io.newFileURI(chromeDir).spec;
  const files = new Set();
  // *.au/ag/us.css live in nsIStyleSheetService, not in documents: re-register them.
  const sss = Cc['@mozilla.org/content/style-sheet-service;1'].getService(Ci.nsIStyleSheetService);
  const registered = [];
  for (const f of chromeDir.directoryEntries) {
    const m = /\\.(au|ag|us)\\.css$/i.exec(f.leafName);
    if (!m || !f.isFile()) continue;
    const type = { au: sss.AUTHOR_SHEET, ag: sss.AGENT_SHEET, us: sss.USER_SHEET }[m[1].toLowerCase()];
    const uri = Services.io.newURI(base + f.leafName);
    if (sss.sheetRegistered(uri, type)) sss.unregisterSheet(uri, type);
    registered.push([uri, type]);
    files.add(f.path);
  }
  try { ChromeUtils.clearResourceCache({ types: ['stylesheet'] }); } catch { ChromeUtils.clearResourceCache(); }
  for (const [uri, type] of registered) sss.loadAndRegisterSheet(uri, type);

  const docs = [...Services.wm.getEnumerator(null)].map(w => w.document);
  // Two passes: reparsing a parent re-creates its @import children from cache.
  for (let pass = 0; pass < 2; pass++) {
    const done = new Set();
    const walk = async (s) => {
      if (!s?.href?.startsWith(base) || done.has(s)) return;
      done.add(s);
      const file = Services.io.newURI(s.href.split(/[?#]/)[0]).QueryInterface(Ci.nsIFileURL).file;
      InspectorUtils.parseStyleSheet(s, await IOUtils.readUTF8(file.path));
      files.add(file.path);
      for (const r of s.cssRules) if (r.styleSheet) await walk(r.styleSheet);
    };
    for (const doc of docs) for (const s of InspectorUtils.getAllStyleSheets(doc, false)) await walk(s);
  }
  // Style-set-owned sheets don't invalidate the cascade on reparse; adding and
  // removing a dummy sheet per origin forces the stylist to rebuild it.
  for (const doc of docs) {
    const wu = doc.defaultView?.windowUtils;
    if (!wu) continue;
    for (const type of [wu.USER_SHEET, wu.AUTHOR_SHEET, wu.AGENT_SHEET]) {
      const uri = 'data:text/css,/*mf-reload-' + type + '*/';
      wu.loadSheetUsingURIString(uri, type);
      wu.removeSheetUsingURIString(uri, type);
    }
  }
  return files.size;
`;

const INSPECT = `
  const [sel, props, depth, rules] = arguments;
  const els = [...document.querySelectorAll(sel)];
  const tree = (el, d) => {
    const attrs = [...el.attributes].map(a => a.name + '="' + a.value.slice(0, 60) + '"').join(' ');
    let s = '  '.repeat(d) + '<' + el.localName + (attrs ? ' ' + attrs : '') + '>';
    if (el.shadowRoot) s += '\\n' + '  '.repeat(d + 1) + '#shadow-root: ' + [...el.shadowRoot.children]
      .map(c => c.localName + (c.id ? '#' + c.id : '') + (c.getAttribute('part') ? '[part=' + c.getAttribute('part') + ']' : '')).join(', ');
    if (d >= depth) return s + (el.children.length ? '  …' + el.children.length + ' children' : '');
    for (const k of el.children) s += '\\n' + tree(k, d + 1);
    return s;
  };
  const out = els.slice(0, 5).map(el => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const o = {
      tree: tree(el, 0),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      computed: Object.fromEntries(props.map(p => [p, cs.getPropertyValue(p)])),
    };
    if (rules) o.rules = InspectorUtils.getMatchingCSSRules(el).map(rule => {
      const href = rule.parentStyleSheet?.href || '(inline)';
      // Nested declaration blocks have no selector; report their parent rule's.
      let sel = rule.selectorText, r = rule;
      while (sel === undefined && r.parentRule) sel = (r = r.parentRule).selectorText;
      let line = '?';
      if (sel === undefined && !rule.parentStyleSheet) return 'element.style';
      try { line = InspectorUtils.getRelativeRuleLine(r); } catch {}
      return sel + '  —  ' + href.replace(/^.*\\/chrome\\//, 'chrome/') + ':' + line;
    }).reverse();
    return o;
  });
  if (!els.length) out.push({ note: 'no match for ' + sel });
  if (els.length > 5) out.push({ note: (els.length - 5) + ' more matches' });
  return out;
`;

// ----------------------------------------------------------------- commands

const commands = {
  async start({ opt }) {
    if (await daemonUp()) return console.log('already running');
    fs.mkdirSync(DEV, { recursive: true });
    writeProfile();
    const args = ['-profile', PROFILE, '-no-remote', '-new-instance', '--marionette', '--remote-allow-system-access'];
    const log = fs.openSync(path.join(DEV, 'firefox.log'), 'w');
    const child = spawn(FIREFOX, args, { detached: true, stdio: ['ignore', log, log], env: cleanEnv() });
    child.unref();
    fs.writeFileSync(PIDFILE, String(child.pid));
    for (let i = 0; i < 120 && !(await portOpen()); i++) await sleep(500);
    if (!(await portOpen())) throw new Error('Marionette did not come up; see .dev/firefox.log');

    const dlog = fs.openSync(path.join(DEV, 'daemon.log'), 'w');
    const daemon = spawn(process.execPath, [fileURLToPath(import.meta.url), 'daemon'], { detached: true, stdio: ['ignore', dlog, dlog] });
    daemon.unref();
    for (let i = 0; i < 60 && !(await daemonUp()); i++) await sleep(250);
    if (!(await daemonUp())) throw new Error('daemon did not come up; see .dev/daemon.log');

    await withSession(async (m) => {
      await m.exec(`return delayedStartupPromise`);
      console.log('loaded sheets:', await m.exec(BOOTSTRAP));
      // chrome.manifest overrides only affect newly built windows, so swap in a fresh one.
      await m.exec(`
        const old = window;
        const w = OpenBrowserWindow();
        await new Promise(r => w.addEventListener('load', r, { once: true }));
        await w.delayedStartupPromise;
        setTimeout(() => old.close());
      `);
      await sleep(500);
      await m.send('mf:selectBrowserWindow');
      const [w, h] = [Number(opt.width || 1280), Number(opt.height || 800)];
      await m.send('WebDriver:SetWindowRect', { x: 0, y: 0, width: w, height: h });
    });
    console.log(`Firefox running (pid ${child.pid}, marionette :${PORT}, daemon :${DAEMON_PORT})`);
  },

  // Internal: holds the Marionette session and proxies commands from the CLI.
  async daemon() {
    const m = await Marionette.connect();
    await m.session();
    m.sock.on('close', () => process.exit(0));
    fs.writeFileSync(path.join(DEV, 'daemon.pid'), String(process.pid));
    let queue = Promise.resolve();
    const handle = async ({ name, params }) => {
      if (name === 'mf:selectBrowserWindow') return m.selectBrowserWindow();
      const run = () => m.send(name, params);
      let result;
      try {
        result = await run();
      } catch (e) {
        if (!/no such window/.test(e.message)) throw e;
        await m.selectBrowserWindow();
        result = await run();
      }
      // Hide the striped "remote controlled" urlbar cue so it doesn't skew screenshots.
      await m
        .exec(`for (const w of Services.wm.getEnumerator('navigator:browser')) w.document.documentElement.removeAttribute('remotecontrol');`)
        .catch(() => {});
      return result;
    };
    http
      .createServer((req, res) => {
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', () => {
          queue = queue.then(async () => {
            let out;
            try {
              out = { result: (await handle(JSON.parse(body))) ?? null };
            } catch (e) {
              out = { error: e.message };
            }
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(out));
          });
        });
      })
      .listen(DAEMON_PORT, '127.0.0.1');
  },

  async stop() {
    try {
      await withSession((m) => m.send('Marionette:Quit', { flags: ['eForceQuit'] }));
    } catch {}
    await sleep(500);
    for (const f of [PIDFILE, path.join(DEV, 'daemon.pid')]) {
      const pid = pidAlive(f);
      if (pid) process.kill(pid);
      fs.rmSync(f, { force: true });
    }
    console.log('stopped');
  },

  async restart(a) {
    await commands.stop(a);
    await sleep(1000);
    await commands.start(a);
  },

  // eval '<js function body>'  — runs in the browser window; use `return`. Pass `-` to read stdin.
  async eval({ pos }) {
    const src = pos[0] === '-' ? fs.readFileSync(0, 'utf8') : pos.join(' ');
    const r = await withSession((m) => m.exec(src));
    console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 2));
  },

  // inspect <selector> [--props a,b] [--depth N] [--rules]
  async inspect({ pos, opt }) {
    const props = (opt.props || 'display,color,background-color,border-radius,padding,margin,height,font-size').split(',');
    const r = await withSession((m) => m.exec(INSPECT, [pos[0], props, Number(opt.depth ?? 1), !!opt.rules]));
    for (const e of r) {
      if (e.note) {
        console.log(e.note);
        continue;
      }
      console.log(e.tree);
      console.log('rect', JSON.stringify(e.rect));
      console.log('computed', e.computed);
      if (e.rules) console.log('matching rules (highest priority first):\n  ' + e.rules.join('\n  '));
      console.log('---');
    }
  },

  // shot [name|file.png] [--selector css] [--pad N]
  async shot({ pos, opt }) {
    fs.mkdirSync(SHOTS, { recursive: true });
    const name = pos[0] || (opt.selector ? 'element' : 'window');
    const file = name.endsWith('.png') ? path.resolve(name) : path.join(SHOTS, name + '.png');
    const b64 = await withSession(async (m) => {
      // An occluded window (e.g. behind the editor on Wayland) gets no frame
      // callbacks, so transitions freeze at their start value. Settle them.
      await m.exec(`
        for (const w of Services.wm.getEnumerator(null))
          for (const a of w.document.getAnimations()) try { a.finish(); } catch {}
      `);
      if (!opt.selector) return (await m.send('WebDriver:TakeScreenshot', { full: false, hash: false, scroll: false })).value;
      return m.exec(
        `
        const [sel, pad] = arguments;
        const el = document.querySelector(sel);
        if (!el) throw new Error('no element for ' + sel);
        const r = el.getBoundingClientRect();
        const x = Math.max(0, r.x - pad), y = Math.max(0, r.y - pad);
        const w = Math.min(innerWidth - x, r.width + 2 * pad), h = Math.min(innerHeight - y, r.height + 2 * pad);
        const bmp = await browsingContext.currentWindowGlobal.drawSnapshot(new DOMRect(x, y, w, h), devicePixelRatio, 'rgb(255,255,255)');
        const c = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
        c.width = bmp.width; c.height = bmp.height;
        c.getContext('2d').drawImage(bmp, 0, 0);
        return c.toDataURL('image/png').split(',')[1];
      `,
        [opt.selector, Number(opt.pad ?? 4)],
      );
    });
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    console.log(file);
  },

  // reload [--no-build]  — runs `npm run build`, then hot-swaps the theme's sheets
  async reload({ opt }) {
    if (!opt['no-build']) execSync('npm run --silent build -- --quiet', { cwd: ROOT, stdio: 'inherit' });
    const n = await withSession((m) => m.exec(RELOAD));
    console.log(`reloaded ${n} stylesheet(s)`);
  },

  // watch  — rebuild + hot-reload whenever src/ changes
  async watch() {
    let timer;
    let busy = Promise.resolve();
    const run = () =>
      (busy = busy.then(() => commands.reload({ opt: {} }).catch((e) => console.error(e.message))));
    fs.watch(path.join(ROOT, 'src'), { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(run, 150);
    });
    console.log('watching src/ …');
  },

  // pseudo <selector> <:hover|:active|:focus-visible|…> [--off]  — lock a pseudo-class for screenshots
  async pseudo({ pos, opt }) {
    const r = await withSession((m) =>
      m.exec(
        `const [sel, pc, off] = arguments;
         const els = [...document.querySelectorAll(sel)];
         for (const el of els) off ? InspectorUtils.removePseudoClassLock(el, pc) : InspectorUtils.addPseudoClassLock(el, pc);
         return els.length;`,
        [pos[0], pos[1], !!opt.off],
      ),
    );
    console.log(`${opt.off ? 'unlocked' : 'locked'} ${pos[1]} on ${r} element(s)`);
  },

  // size <width> <height>
  async size({ pos }) {
    await withSession((m) => m.send('WebDriver:SetWindowRect', { width: Number(pos[0]), height: Number(pos[1]) }));
  },
};

const [cmd, ...rest] = process.argv.slice(2);
if (!commands[cmd]) {
  console.log('usage: node dev/mf.mjs <start|stop|restart|eval|inspect|shot|reload|watch|pseudo|size> …  (see dev/README.md)');
  process.exit(cmd ? 1 : 0);
}
commands[cmd](parseArgs(rest)).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
