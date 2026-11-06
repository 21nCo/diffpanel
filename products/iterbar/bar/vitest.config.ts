import { defineConfig } from "vitest/config";

export default defineConfig({
  // Pure logic only; the element itself is tested in Chromium by `pnpm test:browser`.
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
