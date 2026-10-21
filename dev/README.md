# Dev harness

`dev/mf.mjs` launches an isolated Firefox with this theme and drives its **browser chrome** over Marionette (Firefox's built-in WebDriver backend) in the privileged chrome context. You can then inspect the UI DOM, script UI states, take screenshots and hot-reload CSS. It's like Playwright, but for `userChrome.css`. There are no extra dependencies; it needs only Node and Firefox.

```sh
npm run dev -- start                 # or: node dev/mf.mjs start [--width 1280 --height 800]
npm run dev -- watch                 # rebuild SCSS + hot-reload on every change in src/
npm run dev -- stop
```

## Setup

- The profile lives in `.dev/profile` (git-ignored) and uses the repo's `chrome/` and `user.js`. fx-autoconfig is emulated, so nothing has to be installed into the Firefox folder. Put extra prefs (e.g. `user_pref("browser.uidensity", 0);`) in `.dev/extra-prefs.js` and run `restart`.
- UI state such as an open urlbar popup survives between commands. Marionette listens on `:2829` (override with `MF_MARIONETTE_PORT`).
- `reload` hot-swaps the CSS. Restart only after changing `chrome.manifest`, prefs or JS.

## Commands

| Command | Purpose |
| - | - |
| `start` / `stop` / `restart` | Manage the dev Firefox instance |
| `reload [--no-build]` | `npm run build`, then hot-swap all theme stylesheets |
| `watch` | `reload` on every change in `src/` |
| `shot [name\|file.png] [--selector css] [--pad N]` | Screenshot the window, or crop to an element → `.dev/shots/<name>.png` |
| `inspect <selector> [--rules] [--depth N] [--props a,b]` | DOM tree (incl. shadow-root parts), rect, computed styles, matching rules with file:line |
| `eval '<js>'` | Run JS in the browser window (async body; use `return`). `eval -` reads stdin |
| `pseudo <selector> :hover [--off]` | Lock/unlock a pseudo-class (`:hover`, `:active`, `:focus-visible`…) |
| `size <w> <h>` | Resize the window |

## Recipes

```sh
# urlbar focused with results open, then screenshot
node dev/mf.mjs eval 'gURLBar.focus(); gURLBar.search("mozilla"); await new Promise(r => setTimeout(r, 1000))'
node dev/mf.mjs shot urlbar-open

# which rules style the selected result row?
node dev/mf.mjs inspect '.urlbarView-row[selected]' --rules --props background-color,border-radius

# close the popup / blur the urlbar
node dev/mf.mjs eval 'gURLBar.view.close(); gBrowser.selectedBrowser.focus()'

# tab states
node dev/mf.mjs eval 'gBrowser.addTab("about:robots", { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() })'
node dev/mf.mjs pseudo '.tabbrowser-tab:not([selected])' :hover
node dev/mf.mjs shot tabs --selector '#TabsToolbar'

# open the app menu
node dev/mf.mjs eval 'PanelUI.show()'

# switch light/dark (default theme reads these prefs only when it's (re)applied)
node dev/mf.mjs eval '
  const dark = 1;  // 0 = light
  Services.prefs.setIntPref("ui.systemUsesDarkTheme", dark);
  Services.prefs.setIntPref("browser.theme.toolbar-theme", dark ? 0 : 1);
  Services.prefs.setIntPref("browser.theme.content-theme", dark ? 0 : 1);
  await (await AddonManager.getAddonByID("firefox-compact-light@mozilla.org")).enable();
  await (await AddonManager.getAddonByID("default-theme@mozilla.org")).enable();'
```

The README screenshots are the `preview` visual test baselines (see below), so you don't take them by hand. Regenerate them with `npm run test:visual:update -- -g preview`.

When the dev window is hidden behind other windows, CSS transitions can freeze. `shot` settles them, but `inspect`/`eval` right after a state change may read start values.

# Visual regression tests

Screenshot tests that catch every visual change in the themed browser chrome. Typical use is a before/after comparison around a Firefox update:

```sh
npm run test:visual          # build, then compare against the baselines
npm run test:visual:report   # open the HTML report: expected / actual / diff (with slider)
npm run test:visual:update   # accept the current rendering as the new baselines
```

Firefox update workflow:
1. Before updating, run `npm run test:visual`. It should pass; if not, update the baselines and commit them first.
2. Update Firefox, then run `npm run test:visual` again. Each failing test shows which UI state changed. The report annotates every test with the Firefox version used now and the one the baselines were taken with (`baselines/linux-x64-xvfb/environment.json`).
3. Fix the theme until it looks right, then run `npm run test:visual:update`, review the new PNGs in the git diff, and commit them.

The same loop works for theme changes: intentional changes show up as failures, so review them in the report and update the baselines.

## What is captured

[tests/visual/scenarios.mjs](../tests/visual/scenarios.mjs) defines the UI states, each captured in light and dark as `<id>-<scheme>.png`. To add one, add a scenario there, then run `npm run test:visual:update -- -g <id>`.

Every test runs in its own Xvfb display with a fresh, offline Firefox, so the tests never touch your desktop, mouse or the dev Firefox. They run in parallel (`MF_VISUAL_WORKERS`, default 4). [tests/visual/firefox.mjs](../tests/visual/firefox.mjs) explains how the environment is set up.

Requirements:
- `firefox` on `PATH`, or `MF_FIREFOX=/path/to/firefox`.
- ImageMagick (`import`).
- Xvfb (`sudo apt install xvfb`), or `MF_XVFB=/path/to/Xvfb`.
- xcompmgr for the `preview` test (`sudo apt install xcompmgr`), or `MF_XCOMPMGR=/path/to/xcompmgr`.

Baselines are specific to this setup (Linux, fonts, GTK theme), so regenerate them when switching machines. Set `MF_KEEP_PROFILE=1` to keep a test's profile and Firefox log in `.dev/visual/`.
