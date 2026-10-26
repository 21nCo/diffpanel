import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./browser-tests", use: { headless: true, viewport: { width: 700, height: 900 } }, workers: 1 });
