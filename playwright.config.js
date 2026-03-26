// @ts-check
import { defineConfig } from '@playwright/test';

/**
 * Playwright configuration for CAD Modeller e2e tests.
 *
 * Traces are collected on first-retry so failures produce a downloadable
 * trace archive.  Screenshot diffs use the default pixel comparison.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 1,

  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  /* Start the static file server before running tests */
  webServer: {
    command: 'npx serve . -l 3000',
    port: 3000,
    reuseExistingServer: !process.env.CI,
  },

  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
