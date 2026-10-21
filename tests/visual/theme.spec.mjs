import fs from 'node:fs';
import path from 'node:path';
import { test as base, expect } from '@playwright/test';
import { TestFirefox } from './firefox.mjs';
import { preview, scenarios } from './scenarios.mjs';

const test = base.extend({
  // Extra TestFirefox.launch options; the default Xvfb setup when empty.
  firefoxOptions: [{}, { option: true }],
  // A fresh, seeded browser per test keeps scenarios independent of each other.
  firefox: async ({ firefoxOptions }, use, testInfo) => {
    const ff = await TestFirefox.launch({ name: testInfo.title, ...firefoxOptions });
    try {
      await ff.seed();
      const env = await ff.info();
      testInfo.annotations.push({ type: 'firefox', description: env.firefox });
      if (!Object.keys(firefoxOptions).length) recordEnvironment(env, testInfo);
      await use(ff);
    } finally {
      await ff.close();
    }
  },
});

// Baselines remember which Firefox they were taken with, so a failing run after an
// update shows "baseline: Firefox X, now: Firefox Y" in the report.
function recordEnvironment(env, testInfo) {
  const file = path.join(path.dirname(testInfo.snapshotPath('x.png')), 'environment.json');
  if (testInfo.config.updateSnapshots === 'all') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(env, null, 2) + '\n');
  } else if (fs.existsSync(file)) {
    const baseline = JSON.parse(fs.readFileSync(file, 'utf8'));
    testInfo.annotations.push({ type: 'baseline firefox', description: baseline.firefox });
  }
}

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
