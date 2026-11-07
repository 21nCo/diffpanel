import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: "**/*.pw.ts",
  outputDir: "./test-results",
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    browserName: "chromium",
    headless: true,
    viewport: { width: 1000, height: 700 },
    trace: "retain-on-failure",
  },
});
