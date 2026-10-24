import { defineConfig } from '@playwright/test';

// Visual regression suite for the browser chrome. Playwright is only the runner,
// image differ and reporter; Firefox is driven over Marionette (tests/visual/firefox.mjs).
export default defineConfig({
  testDir: './tests/visual',
  testMatch: '*.spec.mjs',
  // Every test runs its own Xvfb + Firefox, so tests are independent.
  fullyParallel: true,
  workers: Number(process.env.MF_VISUAL_WORKERS) || 4,
  retries: 0,
  timeout: 90000,
  expect: {
    // Rendering on Xvfb is deterministic, so any changed pixel is a real change.
    toMatchSnapshot: { threshold: 0, maxDiffPixels: 0 },
  },
  // Normal runs must never create or approve baselines; use `npm run test:visual:update`.
  updateSnapshots: 'none',
  snapshotPathTemplate: '{testDir}/baselines/linux-x64-xvfb/{arg}{ext}',
  outputDir: './test-results',
  reporter: [['list'], ['html', { open: 'never' }]],
});
