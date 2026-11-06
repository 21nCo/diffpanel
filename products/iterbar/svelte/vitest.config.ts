import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [svelte({ configFile: false })],
  test: {
    projects: [
      {
        extends: true,
        // Svelte's browser build and client-compiled components, as in a page.
        plugins: [svelteTesting()],
        test: { name: "client", environment: "jsdom", include: ["test/**/*.test.ts"], exclude: ["test/**/*.server.test.ts"] },
      },
      {
        extends: true,
        // Server-compiled components in Node.js, with no window, document or storage, as in SvelteKit SSR.
        test: { name: "server", environment: "node", include: ["test/**/*.server.test.ts"] },
      },
    ],
  },
});
