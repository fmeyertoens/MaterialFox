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
