import { expect, HERO, inBar, mountBar, PRICING, registerSlots, test } from "./support/fixtures.js";

test.describe("slot dropdown", () => {
  test("says so when the page has a registry but no slots", async ({ page, openFixture }) => {
    await openFixture();
    await page.evaluate(() => window.fixture.getVariantsRegistry());
    await mountBar(page);
    await expect(inBar(page, "[data-role=slots-message]")).toHaveText("No slots on this page.");
    await expect(inBar(page, "[data-role=slot-select]")).toBeHidden();
    await expect(inBar(page, "[data-role=slot-name]")).toBeHidden();
    await expect(inBar(page, "[data-role=versions]")).toBeHidden();
  });

  test("waits for a registry installed after the bar", async ({ page, openFixture }) => {
    await openFixture();
    await mountBar(page);
    await expect(inBar(page, "[data-role=slots-message]")).toHaveText("No Iterbar variants on this page.");
    await registerSlots(page, [PRICING]);
    await expect(inBar(page, "[data-role=slot-name]")).toHaveText("Slot pricing");
  });

  test("shows a single slot by name, without a dropdown", async ({ page, openFixture }) => {
    await openFixture();
    await registerSlots(page, [PRICING]);
    await mountBar(page);
    await expect(inBar(page, "[data-role=slot-name]")).toHaveText("Slot pricing");
    await expect(inBar(page, "[data-role=slot-select]")).toBeHidden();
    await expect(inBar(page, "[data-role=versions] button")).toHaveText(["v1 (default)", "v2", "v3"]);
    await expect(inBar(page, "[data-version=v1]")).toHaveAttribute("aria-pressed", "true");
    await expect(inBar(page, "[data-version=v2]")).toHaveAttribute("aria-pressed", "false");
  });

  test("offers a dropdown with two slots and shows the chosen slot's versions", async ({ page, openFixture }) => {
    await openFixture("/?iterbar=hero:b");
    await registerSlots(page, [PRICING, HERO]);
    await mountBar(page);
    const select = inBar(page, "[data-role=slot-select]");
    await expect(select).toBeVisible();
    await expect(select.locator("option")).toHaveText(["pricing", "hero"]);
    await expect(inBar(page, "[data-role=slot-name]")).toBeHidden();
    await expect(inBar(page, "[data-role=versions] button")).toHaveText(["v1 (default)", "v2", "v3"]);
    await select.selectOption("hero");
    await expect(inBar(page, "[data-role=versions] button")).toHaveText(["a (default)", "b"]);
    await expect(inBar(page, "[data-version=b]")).toHaveAttribute("aria-pressed", "true");
  });

  test("follows slots that mount and unmount while it is open", async ({ page, openFixture }) => {
    await openFixture();
    await registerSlots(page, [PRICING]);
    await mountBar(page);
    await expect(inBar(page, "[data-role=slot-select]")).toBeHidden();
    const unregister = await page.evaluateHandle(() => window.fixture.getVariantsRegistry().register({ slot: "hero", versions: ["a", "b"], defaultVersion: "a" }));
    await expect(inBar(page, "[data-role=slot-select] option")).toHaveText(["pricing", "hero"]);
    await unregister.evaluate((dispose) => dispose());
    await expect(inBar(page, "[data-role=slot-select]")).toBeHidden();
    await expect(inBar(page, "[data-role=slot-name]")).toHaveText("Slot pricing");
  });
});

test.describe("switching a version", () => {
  test("updates the registry and adds the slot to the iterbar URL parameter", async ({ page, openFixture }) => {
    await openFixture("/products?q=a%20b#plans");
    await registerSlots(page, [PRICING, HERO]);
    await page.evaluate(() => {
      // The page renders whatever the registry selects, as a Variants component would.
      const registry = window.fixture.getVariantsRegistry();
      const definition = { slot: "pricing", versions: ["v1", "v2", "v3"], defaultVersion: "v1" };
      const view = document.getElementById("pricing-view")!;
      const render = () => { view.textContent = `pricing ${registry.activeVersion(definition)}`; };
      registry.subscribe(render);
      render();
    });
    await mountBar(page);
    await expect(page.locator("#pricing-view")).toHaveText("pricing v1");

    await inBar(page, "[data-version=v2]").click();

    await expect(inBar(page, "[data-version=v2]")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#pricing-view")).toHaveText("pricing v2");
    const state = await page.evaluate(() => ({
      active: window.__ITERBAR__!.getSnapshot().slots.find((slot) => slot.slot === "pricing")?.activeVersion,
      search: location.search,
      hash: location.hash,
      pathname: location.pathname,
      historyLength: history.length,
    }));
    expect(state).toMatchObject({ active: "v2", search: "?q=a%20b&iterbar=pricing:v2", hash: "#plans", pathname: "/products" });

    // A second switch replaces the slot's entry and keeps the other slot's.
    await page.evaluate(() => history.replaceState(null, "", `${location.pathname}?iterbar=hero:b,pricing:v2${location.hash}`));
    await inBar(page, "[data-version=v3]").click();
    await expect.poll(() => page.evaluate(() => location.search)).toBe("?iterbar=hero:b,pricing:v3");
    expect(await page.evaluate(() => history.length)).toBe(state.historyLength);

    // A reload restores the selection from the URL.
    await page.reload();
    await page.waitForFunction(() => window.fixture !== undefined);
    await registerSlots(page, [PRICING, HERO]);
    await mountBar(page);
    await expect(inBar(page, "[data-version=v3]")).toHaveAttribute("aria-pressed", "true");
  });

  test("leaves the URL alone when the registry refuses the switch", async ({ page, openFixture }) => {
    await openFixture("/?q=1");
    await page.evaluate(() => {
      // A registry whose select() ignores every request, like one whose slot changed versions under the bar.
      const real = window.fixture.createVariantsRegistry();
      real.register({ slot: "pricing", versions: ["v1", "v2"], defaultVersion: "v1" });
      Object.defineProperty(window, "__ITERBAR__", {
        configurable: true,
        value: { ...real.pageApi, select: () => undefined },
      });
    });
    await mountBar(page);
    await inBar(page, "[data-version=v2]").click();
    await expect(inBar(page, "[data-version=v1]")).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => location.search)).toBe("?q=1");
  });

  test("reports an incompatible page API instead of using it", async ({ page, openFixture }) => {
    await openFixture();
    await page.evaluate(() => {
      Object.defineProperty(window, "__ITERBAR__", { configurable: true, value: { schemaVersion: 2 } });
    });
    await mountBar(page);
    await expect(inBar(page, "[data-role=slots-message]")).toContainText("not compatible");
  });

  test("reports a malformed snapshot instead of rendering it", async ({ page, openFixture }) => {
    await openFixture();
    await page.evaluate(() => {
      const snapshot = { schemaVersion: 1, slots: [{ slot: "pricing", versions: [], activeVersion: "x" }], warnings: [] };
      Object.defineProperty(window, "__ITERBAR__", {
        configurable: true,
        value: { schemaVersion: 1, getSnapshot: () => snapshot, select: () => undefined, subscribe: () => () => undefined },
      });
    });
    await mountBar(page);
    await expect(inBar(page, "[data-role=slots-message]")).toContainText("invalid snapshot");
    await expect(inBar(page, "[data-role=versions]")).toBeHidden();
  });
});
