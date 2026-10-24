import { test, expect } from './fixtures.mjs';
import { scenarios } from './scenarios.mjs';

test.use({ firefoxOptions: { compositor: true } });

for (const scheme of ['light', 'dark']) {
  test.describe(scheme, () => {
    test('menu-shadow: shadow fits inside the popup window', async ({ firefox }) => {
      await firefox.setColorScheme(scheme);
      await scenarios.find((scenario) => scenario.id === 'page-context-menu').setup(firefox);
      const shadow = await firefox.exec(`
        const menu = document.querySelector('#contentAreaContextMenu');
        const content = menu.shadowRoot.querySelector('[part~="content"]');
        const style = getComputedStyle(content);
        const outer = menu.getBoundingClientRect();
        const inner = content.getBoundingClientRect();
        return {
          value: style.boxShadow,
          space: [
            inner.left - outer.left, inner.top - outer.top,
            outer.right - inner.right, outer.bottom - inner.bottom,
          ],
        };
      `);
      expect(shadow.value).toBe(
        'rgba(0, 0, 0, 0.65) 0px 2px 8px 0px, rgba(0, 0, 0, 0.45) 0px 0px 3px 0px',
      );
      // An 8px blur extends 12px; the downward offset needs another 2px.
      for (const space of shadow.space) expect(space).toBeGreaterThanOrEqual(14);
    });
  });
}
