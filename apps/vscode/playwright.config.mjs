import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './browser-tests',
  testMatch: '**/*.pw.mjs',
  outputDir: './test-results',
  workers: 1,
  use: {
    headless: true,
    viewport: { width: 420, height: 900 },
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
  },
});
