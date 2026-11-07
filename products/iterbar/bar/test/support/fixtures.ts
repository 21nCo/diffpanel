import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { test as base, type Page } from "@playwright/test";
import { build } from "esbuild";

export const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Iterbar fixture</title></head>
  <body>
    <main id="app">
      <h1 id="page-heading">Fixture page</h1>
      <p id="page-text">Some page text.</p>
      <button id="page-button" type="button">Page button</button>
      <div id="pricing-view"></div>
    </main>
    <script type="module" src="/fixture.js"></script>
  </body>
</html>`;

export interface FixtureServer {
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string;
}

async function bundleFixture(): Promise<string> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./page-entry.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    write: false,
    logLevel: "warning",
  });
  return result.outputFiles.map((file) => file.text).join("\n");
}

export interface SlotDefinitionInput {
  readonly slot: string;
  readonly versions: readonly string[];
  readonly defaultVersion: string;
}

export const test = base.extend<{ openFixture: (path?: string) => Promise<void> }, { fixtureServer: FixtureServer }>({
  // Playwright reads fixture dependencies from the destructuring pattern, so an empty one is required here.
  // eslint-disable-next-line no-empty-pattern
  fixtureServer: [async ({}, use) => {
    const script = await bundleFixture();
    const server: Server = createServer((request, response) => {
      const path = (request.url ?? "/").split("?")[0];
      if (path === "/fixture.js") {
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        response.end(script);
        return;
      }
      if (path === "/favicon.ico") {
        response.writeHead(204).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(PAGE_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await use({ origin: `http://127.0.0.1:${port}` });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, { scope: "worker" }],

  openFixture: async ({ page, fixtureServer }, use) => {
    await use(async (path = "/") => {
      await page.goto(`${fixtureServer.origin}${path}`);
      await page.waitForFunction(() => window.fixture !== undefined);
    });
  },
});

export { expect } from "@playwright/test";

/** Registers slots in the page's shared registry, which installs `window.__ITERBAR__`. */
export async function registerSlots(page: Page, slots: readonly SlotDefinitionInput[]): Promise<void> {
  await page.evaluate((definitions) => {
    const registry = window.fixture.getVariantsRegistry();
    for (const definition of definitions) registry.register(definition);
  }, slots);
}

/** Adds the bar with an optional daemon configuration. */
export async function mountBar(page: Page, options: { daemonUrl?: string; token?: string } = {}): Promise<void> {
  await page.evaluate((config) => {
    window.fixture.mountIterbarBar(config);
  }, options);
}

/** A locator inside the bar's shadow root (Playwright's CSS engine pierces open shadow roots). */
export function inBar(page: Page, selector: string) {
  return page.locator(`iterbar-bar ${selector}`);
}

export const PRICING = { slot: "pricing", versions: ["v1", "v2", "v3"], defaultVersion: "v1" } as const;
export const HERO = { slot: "hero", versions: ["a", "b"], defaultVersion: "a" } as const;
