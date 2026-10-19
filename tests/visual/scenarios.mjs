// The UI states captured by the visual regression suite. Each scenario starts from a
// freshly seeded browser (see TestFirefox.seed) in the requested color scheme.
//
//   setup(ff)  brings the UI into the state and asserts it got there
//   crop       elements/popups whose combined bounding box is captured

const ROW = '.urlbarView-row:not([hidden])';
const BACKGROUND_TAB = '.tabbrowser-tab:not([selected]):not([pinned])';

async function urlbarResults(ff) {
  await ff.click('#urlbar-input');
  await ff.exec(`gURLBar.search('materialfox')`);
  const rows = await ff.exec(`
    await new Promise(r => setTimeout(r, 300));
    return gURLBar.view.isOpen && document.querySelectorAll(arguments[0]).length`, [ROW]);
  if (rows < 4) throw new Error(`expected at least 4 urlbar results, got ${rows}`);
}

export const scenarios = [
  {
    id: 'toolbar-default',
    title: 'toolbox with tabs, navigation bar and bookmarks bar',
    crop: ['#navigator-toolbox'],
    async setup(ff) {
      await ff.park();
    },
  },
  {
    id: 'tab-hover',
    title: 'pointer over a background tab',
    crop: ['#TabsToolbar'],
    async setup(ff) {
      await ff.hover(BACKGROUND_TAB);
    },
  },
  {
    id: 'tabs-overflow',
    title: 'tab strip overflowing, scrolled to the selected last tab',
    crop: ['#TabsToolbar'],
    async setup(ff) {
      await ff.openTabs(Array.from({ length: 20 }, (_, i) => `/tab/${i + 1}`));
      await ff.exec(`gBrowser.selectedTab = gBrowser.tabs.at(-1)`);
      await ff.park();
      const overflowing = await ff.exec(`
        await new Promise(r => setTimeout(r, 300));
        return gBrowser.tabContainer.hasAttribute('overflow')`);
      if (!overflowing) throw new Error('tab strip is not overflowing');
    },
  },
  {
    id: 'urlbar-hover',
    title: 'pointer over the address bar',
    crop: ['#nav-bar'],
    async setup(ff) {
      await ff.hover('#urlbar-input');
    },
  },
  {
    id: 'urlbar-focused',
    title: 'address bar focused with the URL selected',
    crop: ['#nav-bar'],
    async setup(ff) {
      await ff.click('#urlbar-input');
      await ff.park();
      const ok = await ff.exec(`
        await new Promise(r => setTimeout(r, 300));
        if (gURLBar.view.isOpen) gURLBar.view.close();
        return gURLBar.hasAttribute('focused') && !gURLBar.view.isOpen`);
      if (!ok) throw new Error('address bar is not focused');
    },
  },
  {
    id: 'urlbar-results',
    title: 'address bar results for a typed query',
    crop: ['#nav-bar', '.urlbarView'],
    async setup(ff) {
      await urlbarResults(ff);
      await ff.park();
    },
  },
  {
    id: 'urlbar-result-selected',
    title: 'address bar result selected with the keyboard',
    crop: ['#nav-bar', '.urlbarView'],
    async setup(ff) {
      await urlbarResults(ff);
      await ff.park();
      await ff.exec(`gURLBar.view.selectBy(2)`);
      const selected = await ff.exec(`return gURLBar.view.selectedRowIndex`);
      if (selected !== 2) throw new Error(`expected row 2 to be selected, got ${selected}`);
    },
  },
  {
    id: 'urlbar-result-hover',
    title: 'pointer over an address bar result',
    crop: ['#nav-bar', '.urlbarView'],
    async setup(ff) {
      await urlbarResults(ff);
      await ff.hover(`${ROW}:nth-child(3)`);
    },
  },
  {
    id: 'bookmarks-folder',
    title: 'bookmarks toolbar folder opened',
    crop: ['#PlacesToolbarItems > toolbarbutton[type=menu]', '#PlacesToolbarItems > toolbarbutton[type=menu] > menupopup'],
    async setup(ff) {
      await ff.click('#PlacesToolbarItems > toolbarbutton[type=menu]');
      await ff.popupState('#PlacesToolbarItems > toolbarbutton[type=menu] > menupopup');
    },
  },
  {
    id: 'app-menu',
    title: 'main application menu',
    crop: ['#PanelUI-menu-button', '#appMenu-popup'],
    async setup(ff) {
      await ff.click('#PanelUI-menu-button');
      await ff.popupState('#appMenu-popup');
    },
  },
  {
    id: 'tab-context-menu',
    title: 'context menu of a background tab',
    crop: [BACKGROUND_TAB, '#tabContextMenu'],
    async setup(ff) {
      await ff.contextClick(BACKGROUND_TAB);
      await ff.popupState('#tabContextMenu');
    },
  },
  {
    id: 'page-context-menu',
    title: 'context menu of the web page',
    crop: ['#contentAreaContextMenu'],
    async setup(ff) {
      await ff.mouse([400, 500], ['move', 0], ['down', 2], ['up', 2]);
      await ff.popupState('#contentAreaContextMenu');
    },
  },
];
