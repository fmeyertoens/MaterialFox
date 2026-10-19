# Dev harness

`dev/mf.mjs` launches an isolated Firefox with this theme and drives its **browser chrome** over Marionette (Firefox's built-in WebDriver backend) in the privileged chrome context. You can then inspect the UI DOM, script UI states, take screenshots and hot-reload CSS. It's like Playwright, but for `userChrome.css`. There are no extra dependencies; it needs only Node and Firefox.

```sh
npm run dev -- start                 # or: node dev/mf.mjs start [--width 1280 --height 800]
npm run dev -- watch                 # rebuild SCSS + hot-reload on every change in src/
npm run dev -- stop
```

## How it works

- Profile: `.dev/profile` (git-ignored). Its `chrome` is a symlink to the repo's `chrome/`, and its `user.js` is generated from the repo's `user.js` plus dev prefs. Put extra prefs (e.g. `user_pref("browser.uidensity", 0);`) in `.dev/extra-prefs.js` and run `restart`.
- fx-autoconfig is emulated: `chrome/utils/chrome.manifest` gets registered and `*.au.css`/`*.ag.css`/`*.us.css` are loaded the same way `userChromeAgentAuthorSheetLoader` does it. This means no `config.js` is needed in the (read-only, snap) Firefox install folder.
- A small daemon (`127.0.0.1:2830`) holds a single Marionette session (`:2829`, override with `MF_MARIONETTE_PORT`). UI state such as an open urlbar popup survives between commands.
- `reload` re-parses each loaded theme sheet in place, keeping its user/author origin. That's what the Browser Toolbox Style Editor does, so no restart is needed. Restart only after changing `chrome.manifest`, prefs or JS.

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

# README screenshots (media/material-fox-{light,dark}.webp): 806×449 viewport at 2×
node dev/mf.mjs eval 'Services.prefs.setCharPref("layout.css.devPixelsPerPx", "2")'
node dev/mf.mjs size 832 475   # outer size; inner becomes 806×449 with Linux CSD shadows
node dev/mf.mjs shot light && magick .dev/shots/light.png -quality 90 media/material-fox-light.webp
```

Notes:
- Firefox started from a snap-packaged VS Code inherits variables that crash snap Firefox, so `start` strips them.
- Firefox's striped "remote controlled" urlbar cue is removed automatically so it doesn't skew screenshots.
- A dev window hidden behind other windows (Wayland) gets no frame callbacks, so CSS transitions freeze. `shot` finishes all pending animations before capturing; keep that in mind when reading computed styles with `inspect`/`eval` right after a state change.

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

[tests/visual/scenarios.mjs](../tests/visual/scenarios.mjs) defines the UI states. Each one is captured in light and dark (`<id>-<scheme>.png`):

| id | state |
| --- | --- |
| toolbar-default | whole toolbox: tabs, navigation bar, bookmarks bar |
| tab-hover | pointer over a background tab |
| tabs-overflow | overflowing tab strip, scrolled to the selected last tab |
| tab-groups | expanded tab group containing the selected tab, and a collapsed tab group |
| split-view | active split view and an inactive split view in the tab strip |
| urlbar-hover / urlbar-focused | address bar hovered / focused with the URL selected |
| urlbar-results / -result-selected / -result-hover | results popup: plain, keyboard selection, pointer hover |
| bookmarks-folder | bookmarks toolbar folder popup |
| app-menu | main menu panel |
| tab-context-menu / page-context-menu | context menus |

To add a state, add an entry with a `setup(ff)` that drives the UI (use `ff.hover/click/contextClick/park/exec`, and assert that the state was actually reached) and the `crop` selectors. Then run `npm run test:visual:update -- -g <id>`.

## How it works

- Playwright Test is only the runner, image differ and reporter. Firefox is driven over Marionette by [tests/visual/firefox.mjs](../tests/visual/firefox.mjs), using the same client as `mf.mjs`.
- Every test starts its own Xvfb display (1280×800, scale 1) and a fresh Firefox with a throwaway profile under `.dev/visual/`. Tests run in parallel (`MF_VISUAL_WORKERS`, default 4) and never touch your desktop, mouse or the dev Firefox.
- Screenshots are grabbed from the X screen with ImageMagick `import`, so popups and menus are included (Marionette screenshots omit them). A capture is only accepted once two consecutive grabs are identical.
- Pointer interaction uses native OS mouse events, so `:hover`, clicks and context menus behave as they do for a real user.
- Determinism: Firefox's proxy is a local server that serves the fixture pages (`http://materialfox.test/...`) and blocks everything else, so there is no network access. Fixed prefs cover locale, compact density, reduced motion, tooltips and urlbar suggestions. Bookmarks, history and tabs are seeded with fixed data. Comparisons are strict (`threshold: 0`, `maxDiffPixels: 0`).
- Without a compositor, popups have no shadows and their transparent rounded corners render black. This is the same in every run, so it doesn't affect comparisons.

Requirements:
- `firefox` on `PATH`, or `MF_FIREFOX=/path/to/firefox`.
- ImageMagick (`import`).
- Xvfb (`sudo apt install xvfb`), or `MF_XVFB=/path/to/Xvfb`.

Baselines are specific to this setup (Linux, fonts, GTK theme), so regenerate them when switching machines. Set `MF_KEEP_PROFILE=1` to keep a test's profile and Firefox log in `.dev/visual/`.
