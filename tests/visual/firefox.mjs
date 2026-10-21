// Isolated Firefox instance for visual regression tests: private Xvfb display,
// fresh profile, offline fixture site, deterministic prefs and seeded data.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Marionette, cleanEnv, BOOTSTRAP, REOPEN_WINDOW, SETTLE_ANIMATIONS } from '../../dev/mf.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORK = path.join(ROOT, '.dev', 'visual');
export const WIDTH = 1280;
export const HEIGHT = 800;
export const SITE = 'http://materialfox.test';
const WINDOW_RADIUS = 15;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(what, fn, { timeout = 15000, interval = 100 } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
    await sleep(interval);
  }
}

function findTool(name, env, pkg) {
  const candidates = [process.env[env], name, path.join(ROOT, `.dev/tools/${pkg}/usr/bin/${name}`)].filter(Boolean);
  for (const c of candidates) {
    try {
      execFileSync(c, ['-help'], { stdio: 'ignore' });
      return c;
    } catch (e) {
      if (e.code !== 'ENOENT') return c; // exists; `-help` exits non-zero
    }
  }
  throw new Error(`${name} not found. Install it (\`sudo apt install ${pkg}\`) or set ${env}=/path/to/${name}`);
}

// ------------------------------------------------------------- fixture site

const ICON_COLORS = ['#e8590c', '#1971c2', '#2f9e44', '#9c36b5', '#f08c00', '#c2255c', '#0c8599', '#5f3dc4'];
export const PAGES = {
  '/firefox': 'Firefox Browser — Fast, private and free',
  '/docs': 'Web Docs — CSS reference',
  '/mail': 'Inbox — Mail',
  '/news': 'Daily News — Front page',
  '/weather': 'Weather forecast',
  '/music': 'Music — Library',
  '/maps': 'Maps — Directions',
  '/recipes': 'Recipes — Pasta',
};
for (let i = 1; i <= 20; i++) PAGES[`/tab/${i}`] = `Example tab ${i}`;

function pageHtml(p) {
  const color = ICON_COLORS[Object.keys(PAGES).indexOf(p) % ICON_COLORS.length];
  const icon = `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="${color}"/></svg>`,
  )}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${PAGES[p]}</title>
<link rel="icon" href="${icon}">
<style>
  :root { color-scheme: light dark; font: 16px/1.5 sans-serif; }
  body { margin: 0; padding: 40px 64px; }
  h1 { font-size: 32px; margin: 0 0 16px; }
  p { max-width: 640px; }
</style></head>
<body><h1>${PAGES[p]}</h1>
<p id="text">MaterialFox visual regression fixture page. This paragraph contains plain text that is used as
the target for the page context menu screenshot. It is served locally so screenshots never depend on
the network.</p></body></html>`;
}

// Landing page for the README preview. Kept out of PAGES so it never shows up
// in history or urlbar results of the other scenarios.
export const SHOWCASE = {
  path: '/showcase',
  title: 'MaterialFox — Material Design for Firefox',
  html: `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>MaterialFox — Material Design for Firefox</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="#6750a4"/><circle cx="8" cy="8" r="3.5" fill="#fff"/></svg>',
  )}">
<style>
  :root { color-scheme: dark; font: 16px/1.5 sans-serif; }
  body {
    margin: 0; min-height: 100vh; box-sizing: border-box; padding: 40px 48px;
    color: #fff; background: linear-gradient(160deg, #1d1b4b 0%, #3b2a7a 55%, #6750a4 100%);
  }
  .eyebrow { margin: 0; font-size: 13px; letter-spacing: .12em; text-transform: uppercase; color: #d0bcff; }
  h1 { margin: 8px 0 12px; font-size: 44px; line-height: 1.1; font-weight: 700; }
  p.lead { margin: 0 0 24px; max-width: 520px; font-size: 17px; color: #e8def8; }
  .chips { display: flex; gap: 12px; }
  .chip { padding: 8px 18px; border-radius: 20px; font-size: 14px; font-weight: 600; }
  .primary { background: #d0bcff; color: #381e72; }
  .tonal { background: rgba(255, 255, 255, .14); color: #fff; }
</style></head>
<body>
  <p class="eyebrow">userChrome.css theme</p>
  <h1>Material Design for Firefox</h1>
  <p class="lead">Rounded tabs, a pill-shaped address bar and Material menus, in light and dark.</p>
  <div class="chips"><span class="chip primary">Get MaterialFox</span><span class="chip tonal">Light &amp; dark</span></div>
</body></html>`,
};

// Firefox uses this as its HTTP(S) proxy: it serves the fixture site and
// refuses everything else, so tests never touch the network.
function startProxy() {
  const server = http.createServer((req, res) => {
    let url = null;
    try {
      url = new URL(req.url);
    } catch {}
    if (url?.host === 'materialfox.test' && (PAGES[url.pathname] || url.pathname === SHOWCASE.path)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(url.pathname === SHOWCASE.path ? SHOWCASE.html : pageHtml(url.pathname));
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('blocked by MaterialFox visual test proxy');
  });
  server.on('connect', (_req, sock) => sock.destroy());
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---------------------------------------------------------------- profile

function userJs(proxyPort, extra = {}) {
  const p = {
    'marionette.port': 0,
    // offline: everything goes through the fixture proxy
    'network.proxy.type': 1,
    'network.proxy.http': '127.0.0.1',
    'network.proxy.http_port': proxyPort,
    'network.proxy.ssl': '127.0.0.1',
    'network.proxy.ssl_port': proxyPort,
    'network.proxy.no_proxies_on': '',
    'network.proxy.allow_hijacking_localhost': true,
    'network.captive-portal-service.enabled': false,
    'network.connectivity-service.enabled': false,
    'dom.security.https_first': false,
    'dom.security.https_first_schemeless': false,
    'dom.security.https_only_mode': false,
    'browser.fixup.alternate.enabled': false,
    // locale, density, scale
    'intl.locale.requested': 'en-US',
    'intl.regional_prefs.use_os_locales': false,
    'browser.search.region': 'US',
    'browser.uidensity': 1,
    'layout.css.devPixelsPerPx': '1',
    'browser.toolbars.bookmarks.visibility': 'always',
    // no motion / blinking
    'ui.prefersReducedMotion': 1,
    'toolkit.cosmeticAnimations.enabled': false,
    'ui.caretBlinkTime': 0,
    'general.smoothScroll': false,
    'browser.tabs.hoverPreview.enabled': false,
    'browser.chrome.toolbar_tips': false, // tooltips appear after a racy delay
    // first-run, update and messaging UI
    'browser.shell.checkDefaultBrowser': false,
    'browser.aboutwelcome.enabled': false,
    'browser.startup.homepage_override.mstone': 'ignore',
    'startup.homepage_welcome_url': '',
    'browser.startup.page': 0,
    'browser.newtabpage.enabled': false,
    'browser.newtab.preload': false,
    'datareporting.policy.dataSubmissionEnabled': false,
    'toolkit.telemetry.reportingpolicy.firstRun': false,
    'app.update.disabledForTesting': true,
    'app.normandy.enabled': false,
    'messaging-system.rsexperimentloader.enabled': false,
    'browser.newtabpage.activity-stream.asrouter.userprefs.cfr.addons': false,
    'browser.newtabpage.activity-stream.asrouter.userprefs.cfr.features': false,
    'browser.translations.enable': false,
    'browser.tabs.warnOnClose': false,
    'browser.sessionstore.resume_from_crash': false,
    'extensions.getAddons.cache.enabled': false,
    // urlbar: only local history/bookmark results
    'browser.search.suggest.enabled': false,
    'browser.urlbar.suggest.searches': false,
    'browser.urlbar.suggest.topsites': false,
    'browser.urlbar.suggest.engines': false,
    'browser.urlbar.suggest.quickactions': false,
    'browser.urlbar.suggest.trending': false,
    'browser.urlbar.trending.featureGate': false,
    'browser.urlbar.suggest.recentsearches': false,
    'browser.urlbar.suggest.clipboard': false,
    'browser.urlbar.clipboard.featureGate': false,
    'browser.urlbar.suggest.openpage': false,
    'browser.urlbar.quicksuggest.enabled': false,
    'browser.urlbar.suggest.quicksuggest.sponsored': false,
    'browser.urlbar.suggest.quicksuggest.nonsponsored': false,
    'browser.urlbar.suggest.weather': false,
    'browser.urlbar.suggest.addons': false,
    'browser.urlbar.suggest.mdn': false,
    'browser.urlbar.suggest.yelp': false,
    'browser.urlbar.autoFill': false,
    ...extra,
  };
  const repoPrefs = fs.readFileSync(path.join(ROOT, 'user.js'), 'utf8');
  const lines = Object.entries(p).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`);
  return `${repoPrefs}\n${lines.join('\n')}\n`;
}

// ------------------------------------------------------- process handling

// Process groups we own; killed on any exit so no Xvfb/Firefox is left behind.
const live = new Set();
const killAll = () => {
  for (const pid of live) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
  }
};
process.on('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    killAll();
    process.exit(130);
  });
}

function spawnGroup(cmd, args, opts) {
  const child = spawn(cmd, args, { ...opts, detached: true });
  live.add(child.pid);
  const exited = new Promise((r) => child.once('exit', r));
  return { child, exited, running: () => child.exitCode === null && child.signalCode === null };
}

async function stopGroup(proc, timeout = 10000) {
  if (!proc) return;
  if (proc.running()) {
    const exited = await Promise.race([proc.exited.then(() => true), sleep(timeout).then(() => false)]);
    if (!exited) {
      try {
        process.kill(-proc.child.pid, 'SIGKILL');
      } catch {}
      await proc.exited;
    }
  }
  try {
    process.kill(-proc.child.pid, 'SIGKILL'); // leftover children, e.g. content processes
  } catch {}
  live.delete(proc.child.pid);
}

// ----------------------------------------------------------------- browser

export class TestFirefox {
  // screen: Xvfb screen size in device px.
  // compositor: run a compositing manager, so GTK window decorations get rounded,
  //   transparent corners (`-moz-gtk-csd-transparency-available`). Without one,
  //   popups have no shadows and their rounded corners render black (deterministically).
  // prefs: extra prefs for user.js.
  static async launch({ name = 'run', firefox = process.env.MF_FIREFOX || 'firefox', screen = [WIDTH, HEIGHT], compositor = false, prefs = {} } = {}) {
    const ff = new TestFirefox();
    ff.screen = screen;
    ff.prefs = prefs;
    try {
      await ff._launch(name, firefox, compositor);
      return ff;
    } catch (e) {
      const log = ff.logFile && fs.existsSync(ff.logFile) ? fs.readFileSync(ff.logFile, 'utf8').slice(-2000) : '';
      await ff.close();
      throw new Error(`${e.message}${log ? `\n--- firefox/xvfb log (tail) ---\n${log}` : ''}`);
    }
  }

  async _launch(name, firefoxBin, compositor) {
    fs.mkdirSync(WORK, { recursive: true });
    this.dir = fs.mkdtempSync(path.join(WORK, `${name.replace(/[^\w-]+/g, '_')}-`));
    this.logFile = path.join(this.dir, 'firefox.log');
    const log = fs.openSync(this.logFile, 'a');

    // Xvfb picks a free display itself and reports it on fd 3.
    const [sw, sh] = this.screen;
    this.xvfb = spawnGroup(findTool('Xvfb', 'MF_XVFB', 'xvfb'), ['-displayfd', '3', '-screen', '0', `${sw}x${sh}x24`, '-nolisten', 'tcp'], {
      stdio: ['ignore', log, log, 'pipe'],
    });
    let buf = '';
    this.xvfb.child.stdio[3].on('data', (d) => (buf += d));
    const num = await until('Xvfb to start', () => {
      if (!this.xvfb.running()) throw new Error('Xvfb exited');
      return buf.includes('\n') && buf.trim();
    }, { timeout: 10000, interval: 50 });
    this.display = `:${num}`;
    if (compositor) {
      this.compositor = spawnGroup(findTool('xcompmgr', 'MF_XCOMPMGR', 'xcompmgr'), ['-n'], {
        stdio: ['ignore', log, log],
        env: { ...process.env, DISPLAY: this.display },
      });
    }

    this.proxy = await startProxy();
    this.profile = path.join(this.dir, 'profile');
    fs.mkdirSync(this.profile);
    fs.symlinkSync(path.join(ROOT, 'chrome'), path.join(this.profile, 'chrome'));
    fs.writeFileSync(path.join(this.profile, 'user.js'), userJs(this.proxy.address().port, this.prefs));

    const env = cleanEnv();
    delete env.WAYLAND_DISPLAY;
    Object.assign(env, {
      DISPLAY: this.display,
      MOZ_ENABLE_WAYLAND: '0',
      GDK_BACKEND: 'x11',
      GTK_THEME: 'Adwaita',
      MOZ_CRASHREPORTER_DISABLE: '1',
    });
    if (compositor) {
      // Adwaita has rounded CSD corners, but with no window manager on Xvfb its
      // `.titlebar` rules end up with a 0 radius. Override it with a selector
      // specific enough to win (GTK3 CSS has no !important).
      const theme = path.join(this.dir, 'share', 'themes', 'MaterialFoxTest', 'gtk-3.0');
      fs.mkdirSync(theme, { recursive: true });
      fs.writeFileSync(
        path.join(theme, 'gtk.css'),
        '@import url("resource:///org/gtk/libgtk/theme/Adwaita/gtk-contained.css");\n' +
          'headerbar.titlebar.default-decoration:not(.mf-a):not(.mf-b):not(.mf-c):not(.mf-d) ' +
          `{ border-radius: ${WINDOW_RADIUS}px ${WINDOW_RADIUS}px 0 0; }\n`,
      );
      env.XDG_DATA_DIRS = [path.join(this.dir, 'share'), env.XDG_DATA_DIRS || '/usr/local/share:/usr/share'].join(':');
      env.GTK_THEME = 'MaterialFoxTest';
    }
    this.firefox = spawnGroup(
      firefoxBin,
      ['-profile', this.profile, '-no-remote', '-new-instance', '--marionette', '--remote-allow-system-access'],
      { stdio: ['ignore', log, log], env },
    );

    const portFile = path.join(this.profile, 'MarionetteActivePort');
    const port = await until('Marionette to start', () => {
      if (!this.firefox.running()) throw new Error('Firefox exited');
      return fs.existsSync(portFile) && Number(fs.readFileSync(portFile, 'utf8'));
    }, { timeout: 60000, interval: 250 });
    this.m = await until('Marionette connection', () => Marionette.connect(port), { interval: 250 });
    await this.m.session();
    await this.exec(`return delayedStartupPromise`);
    const sheets = await this.exec(BOOTSTRAP);
    if (!Array.isArray(sheets) || !sheets.includes('userChrome.au.css')) throw new Error(`author sheet not loaded: ${JSON.stringify(sheets)}`);
    await this.exec(REOPEN_WINDOW);
    await until('the fresh browser window', async () => {
      await this.m.selectBrowserWindow();
      return this.exec(`return [...Services.wm.getEnumerator('navigator:browser')].length === 1 && window.gBrowserInit?.delayedStartupFinished`);
    });
    // With a compositor, GTK adds client-side shadows around the window; the
    // caller sets its own geometry then.
    if (!compositor) {
      await this.m.send('WebDriver:SetWindowRect', { x: 0, y: 0, width: WIDTH, height: HEIGHT });
      await until(`window to be ${WIDTH}x${HEIGHT} at 0,0`, () =>
        this.exec(
          `return innerWidth === ${WIDTH} && innerHeight === ${HEIGHT} && mozInnerScreenX === 0 && mozInnerScreenY === 0 && devicePixelRatio === 1`,
        ),
      );
    }
    const themed = await this.exec(
      `return InspectorUtils.getAllStyleSheets(document, false).some(s => s.href?.endsWith('/chrome/userChrome.css'))`,
    );
    if (!themed) throw new Error('userChrome.css is not applied');
    if (compositor)
      await until('rounded transparent window corners to be available', () =>
        this.exec(`return matchMedia('(-moz-gtk-csd-transparency-available)').matches`),
      );
  }

  exec(script, args = []) {
    return this.m.exec(script, args);
  }

  info() {
    return this.exec(`return {
      firefox: Services.appinfo.version + ' (build ' + Services.appinfo.appBuildID + ')',
      os: Services.appinfo.OS + ' ' + Services.sysinfo.getProperty('arch'),
      backend: 'xvfb',
      locale: Services.locale.appLocaleAsBCP47,
      density: Services.prefs.getIntPref('browser.uidensity'),
      dpr: devicePixelRatio,
      window: innerWidth + 'x' + innerHeight,
    }`);
  }

  // Bookmarks toolbar (folder + bookmark), history and the standard tab set.
  async seed() {
    await this.exec(
      `
      const [site, pages] = arguments;
      const { PlacesUtils } = ChromeUtils.importESModule('resource://gre/modules/PlacesUtils.sys.mjs');
      await PlacesUtils.bookmarks.eraseEverything();
      await PlacesUtils.history.clear();
      const toolbar = PlacesUtils.bookmarks.toolbarGuid;
      const folder = await PlacesUtils.bookmarks.insert({ parentGuid: toolbar, type: PlacesUtils.bookmarks.TYPE_FOLDER, title: 'Bookmarks', index: 0 });
      for (const p of ['/firefox', '/docs', '/news', '/weather'])
        await PlacesUtils.bookmarks.insert({ parentGuid: folder.guid, url: site + p, title: pages[p] });
      await PlacesUtils.bookmarks.insert({ parentGuid: toolbar, url: site + '/music', title: 'Music' });
      const base = Date.UTC(2026, 0, 1);
      await PlacesUtils.history.insertMany(Object.keys(pages).filter(p => !p.startsWith('/tab/')).map((p, i) => ({
        url: site + p, title: pages[p],
        visits: Array.from({ length: 3 + i }, (_, j) => ({ date: new Date(base + (i * 10 + j) * 3600e3) })),
      })));
      const principal = Services.scriptSecurityManager.getSystemPrincipal();
      const old = [...gBrowser.tabs];
      const pinned = gBrowser.addTab(site + '/mail', { triggeringPrincipal: principal });
      gBrowser.pinTab(pinned);
      const selected = gBrowser.addTab(site + '/firefox', { triggeringPrincipal: principal });
      gBrowser.addTab(site + '/docs', { triggeringPrincipal: principal });
      gBrowser.selectedTab = selected;
      for (const t of old) gBrowser.removeTab(t);
    `,
      [SITE, PAGES],
    );
    await this.waitForTabs();
  }

  async openTabs(paths) {
    await this.exec(
      `const [urls] = arguments;
       const principal = Services.scriptSecurityManager.getSystemPrincipal();
       for (const u of urls) gBrowser.addTab(u, { triggeringPrincipal: principal, skipAnimation: true });`,
      [paths.map((p) => SITE + p)],
    );
    await this.waitForTabs();
  }

  waitForTabs() {
    return until('tabs to load with favicons and bookmarks toolbar', () =>
      this.exec(`return gBrowser.tabs.every(t => !t.hasAttribute('busy') && t.linkedBrowser.currentURI.spec.startsWith('${SITE}')
        && t.getAttribute('image')) && document.querySelectorAll('#PlacesToolbarItems > toolbarbutton').length === 2
        && !document.getElementById('reload-button')?.hasAttribute('disabled')`),
    );
  }

  async setColorScheme(scheme) {
    const dark = scheme === 'dark';
    await this.exec(
      `const [dark] = arguments;
       Services.prefs.setIntPref('ui.systemUsesDarkTheme', dark ? 1 : 0);
       Services.prefs.setIntPref('browser.theme.toolbar-theme', dark ? 0 : 1);
       Services.prefs.setIntPref('browser.theme.content-theme', dark ? 0 : 1);
       // The default theme only re-reads these prefs when it is (re)applied.
       await (await AddonManager.getAddonByID('firefox-compact-light@mozilla.org')).enable();
       await (await AddonManager.getAddonByID('default-theme@mozilla.org')).enable();`,
      [dark],
    );
    await until(`${scheme} color scheme`, () =>
      this.exec(`return matchMedia('(prefers-color-scheme: dark)').matches === ${dark}
        && (await AddonManager.getAddonByID('default-theme@mozilla.org')).isActive`),
    );
  }

  // Native (OS-level) mouse events at the centre of an element, or at screen coordinates.
  async mouse(target, ...messages) {
    await this.exec(
      `const [target, messages] = arguments;
       let x, y;
       if (typeof target === 'string') {
         const el = document.querySelector(target);
         if (!el) throw new Error('mouse: no element for ' + target);
         const r = el.getBoundingClientRect();
         if (!r.width || !r.height) throw new Error('mouse: ' + target + ' is not visible');
         x = r.x + r.width / 2 + mozInnerScreenX; y = r.y + r.height / 2 + mozInnerScreenY;
       } else [x, y] = target;
       const M = { move: 'MOVE', down: 'BUTTON_DOWN', up: 'BUTTON_UP' };
       for (const [msg, button] of messages)
         windowUtils.sendNativeMouseEvent(Math.round(x * devicePixelRatio), Math.round(y * devicePixelRatio),
           windowUtils['NATIVE_MOUSE_MESSAGE_' + M[msg]], button, 0, document.documentElement);`,
      [target, messages],
    );
  }

  async hover(selector) {
    await this.mouse(selector, ['move', 0]);
    await until(`${selector} to be hovered`, () =>
      this.exec(`return document.querySelector(arguments[0]).matches(':hover')`, [selector]),
    );
  }

  click(selector) {
    return this.mouse(selector, ['move', 0], ['down', 0], ['up', 0]);
  }

  contextClick(selector) {
    return this.mouse(selector, ['move', 0], ['down', 2], ['up', 2]);
  }

  // Moves the pointer to the bottom-right corner of the page, away from any chrome UI.
  async park() {
    await this.mouse([WIDTH - 2, HEIGHT - 2], ['move', 0]);
    await until('no chrome element to be hovered', () => this.exec(`return !document.querySelector('#navigator-toolbox:hover')`));
  }

  // Waits for a XUL popup/panel to reach the given state ('open' or 'closed').
  popupState(selector, state = 'open') {
    return until(`${selector} to be ${state}`, () =>
      this.exec(`return document.querySelector(arguments[0])?.state === arguments[1]`, [selector, state]),
    );
  }

  // Bounding box (screen CSS px) of elements and/or open popups.
  rectOf(selectors) {
    return this.exec(
      `const rects = [];
       for (const sel of arguments[0]) {
         const el = document.querySelector(sel);
         if (!el) throw new Error('crop: no element for ' + sel);
         let r;
         if (el.getOuterScreenRect && el.state === 'open') r = el.getOuterScreenRect();
         else {
           const b = el.getBoundingClientRect();
           r = { x: b.x + mozInnerScreenX, y: b.y + mozInnerScreenY, width: b.width, height: b.height };
         }
         if (!r.width || !r.height) throw new Error('crop: ' + sel + ' is not visible');
         rects.push(r);
       }
       return {
         x: Math.min(...rects.map(r => r.x)), y: Math.min(...rects.map(r => r.y)),
         right: Math.max(...rects.map(r => r.x + r.width)), bottom: Math.max(...rects.map(r => r.y + r.height)),
       };`,
      [selectors],
    );
  }

  // Captures from the X screen, which (unlike Marionette screenshots) includes popups.
  grab({ x, y, right, bottom }, margin) {
    const x0 = Math.max(0, Math.floor(x - margin));
    const y0 = Math.max(0, Math.floor(y - margin));
    const w = Math.min(WIDTH, Math.ceil(right + margin)) - x0;
    const h = Math.min(HEIGHT, Math.ceil(bottom + margin)) - y0;
    const args = ['-display', this.display, '-window', 'root', '-crop', `${w}x${h}+${x0}+${y0}`, '+repage'];
    args.push('-strip', '-define', 'png:exclude-chunks=date,time', 'png:-');
    return new Promise((resolve, reject) =>
      execFile('import', args, { encoding: 'buffer', maxBuffer: 64 << 20, timeout: 15000 }, (err, out) =>
        err ? reject(err) : resolve(out),
      ),
    );
  }

  // Settles animations and returns a capture once two consecutive ones are identical.
  async capture(selectors, { margin = 0, attempts = 10 } = {}) {
    let prev;
    for (let i = 0; i < attempts; i++) {
      await this.exec(`document.documentElement.removeAttribute('remotecontrol');\n${SETTLE_ANIMATIONS}`);
      await sleep(250);
      const shot = await this.grab(await this.rectOf(selectors), margin);
      if (prev?.equals(shot)) return shot;
      prev = shot;
    }
    throw new Error(`screenshot of ${selectors.join(', ')} did not stabilise after ${attempts} attempts`);
  }

  // Scales the UI and sizes the window so its content area is exactly w×h CSS px.
  async setContentSize(w, h, scale) {
    await this.exec(
      `Services.prefs.setBoolPref('widget.gtk.rounded-bottom-corners.enabled', true);
       Services.prefs.setCharPref('layout.css.devPixelsPerPx', String(arguments[0]));`,
      [scale],
    );
    await until(`scale ${scale}`, () => this.exec(`return devicePixelRatio === ${scale}`));
    await until(`window content to be ${w}x${h}`, async () => {
      const [iw, ih, ow, oh] = await this.exec(`return [innerWidth, innerHeight, outerWidth, outerHeight]`);
      if (iw === w && ih === h) return this.exec(`return document.documentElement.getAttribute('sizemode') === 'normal'`);
      // outer − inner is the CSD frame, so this converges in one step.
      await this.m.send('WebDriver:SetWindowRect', { x: 0, y: 0, width: w + ow - iw, height: h + oh - ih });
      await sleep(300);
    });
  }

  // The whole window at device resolution, with transparent rounded corners.
  // The root's GTK decoration painting is turned off for the snapshot: it only
  // exists on X11 to fill the corners and would make them opaque.
  async captureWindow({ attempts = 10 } = {}) {
    let prev;
    for (let i = 0; i < attempts; i++) {
      await this.exec(`document.documentElement.removeAttribute('remotecontrol');\n${SETTLE_ANIMATIONS}`);
      await sleep(250);
      const b64 = await this.exec(`
        if (document.documentElement.matches(':-moz-window-inactive')) throw new Error('window is not active');
        const root = document.documentElement;
        root.style.setProperty('appearance', 'none', 'important');
        try {
          const bmp = await browsingContext.currentWindowGlobal.drawSnapshot(
            new DOMRect(0, 0, innerWidth, innerHeight), devicePixelRatio, 'transparent');
          const c = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
          c.width = bmp.width; c.height = bmp.height;
          c.getContext('2d').drawImage(bmp, 0, 0);
          return c.toDataURL('image/png').split(',')[1];
        } finally {
          root.style.removeProperty('appearance');
        }`);
      const shot = Buffer.from(b64, 'base64');
      if (prev?.equals(shot)) return shot;
      prev = shot;
    }
    throw new Error(`window screenshot did not stabilise after ${attempts} attempts`);
  }

  async close() {
    if (this.m) {
      await Promise.race([this.m.send('Marionette:Quit', { flags: ['eForceQuit'] }).catch(() => {}), sleep(5000)]);
      this.m.sock.destroy();
    }
    await stopGroup(this.firefox);
    await stopGroup(this.compositor, 0);
    await stopGroup(this.xvfb, 0);
    this.proxy?.close();
    if (this.dir && !process.env.MF_KEEP_PROFILE) fs.rmSync(this.dir, { recursive: true, force: true });
  }
}
