import { test, expect } from './fixtures.mjs';
import { preview, scenarios } from './scenarios.mjs';

for (const scheme of ['light', 'dark']) {
  test.describe(scheme, () => {
    for (const scenario of scenarios) {
      test(`${scenario.id}: ${scenario.title}`, async ({ firefox }) => {
        await firefox.setColorScheme(scheme);
        await scenario.setup(firefox);
        const png = await firefox.capture(scenario.crop);
        expect(png).toMatchSnapshot(`${scenario.id}-${scheme}.png`);
      });
    }

    // Whole window; the baselines double as the README screenshots.
    test.describe(() => {
      test.use({ firefoxOptions: preview.launch });
      test(`${preview.id}: ${preview.title}`, async ({ firefox }) => {
        await firefox.setColorScheme(scheme);
        await preview.setup(firefox);
        expect(await firefox.captureWindow()).toMatchSnapshot(`${preview.id}-${scheme}.png`);
      });
    });
  });
}
