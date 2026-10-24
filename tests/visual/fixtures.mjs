import fs from 'node:fs';
import path from 'node:path';
import { test as base } from '@playwright/test';
import { TestFirefox } from './firefox.mjs';

export { expect } from '@playwright/test';

export const test = base.extend({
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
