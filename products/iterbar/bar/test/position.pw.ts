import { fakeDaemon } from "./support/fake-daemon.js";
import { expect, inBar, mountBar, test } from "./support/fixtures.js";

test("drags to any screen edge and remembers the position and collapsed state for the origin", async ({ page, openFixture }) => {
  await openFixture();
  await mountBar(page);
  const bar = inBar(page, ".bar");
  const viewport = page.viewportSize()!;
  // Default: bottom right.
  let box = (await bar.boundingBox())!;
  expect(Math.round(box.x + box.width)).toBe(viewport.width - 12);
  expect(Math.round(box.y + box.height)).toBe(viewport.height - 12);

  const handle = inBar(page, "[data-role=handle]");
  /** Drags the handle to (x, y) and returns where the bar's box was when it was dropped. */
  const drag = async (x: number, y: number) => {
    const start = (await handle.boundingBox())!;
    const from = (await bar.boundingBox())!;
    const grabX = start.x + start.width / 2;
    const grabY = start.y + start.height / 2;
    await page.mouse.move(grabX, grabY);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 8 });
    await page.mouse.up();
    return { x: from.x + x - grabX, y: from.y + y - grabY };
  };
  const near = (actual: number, expected: number) => Math.abs(actual - expected) < 1;

  // Each drop docks to the nearest edge and stays where it was dropped along that edge.
  let dropped = await drag(20, viewport.height / 2);
  await expect.poll(async () => (await bar.boundingBox())?.x).toBe(12);
  expect(near((await bar.boundingBox())!.y, dropped.y)).toBe(true);

  dropped = await drag(viewport.width / 2, 15);
  await expect.poll(async () => (await bar.boundingBox())?.y).toBe(12);
  expect(near((await bar.boundingBox())!.x, dropped.x)).toBe(true);

  dropped = await drag(viewport.width / 3, viewport.height - 5);
  await expect(bar).toHaveAttribute("data-edge", "bottom");
  box = (await bar.boundingBox())!;
  expect(Math.round(box.y + box.height)).toBe(viewport.height - 12);
  expect(near(box.x, dropped.x)).toBe(true);

  dropped = await drag(viewport.width - 5, viewport.height / 2);
  await expect.poll(async () => {
    const current = (await bar.boundingBox())!;
    return Math.round(current.x + current.width);
  }).toBe(viewport.width - 12);
  const placed = (await bar.boundingBox())!;
  expect(near(placed.y, dropped.y)).toBe(true);

  // A click on the handle without moving it is not a drag.
  await handle.click();
  expect(await bar.boundingBox()).toEqual(placed);

  // The position comes back exactly after a reload, and so does the collapsed state.
  const reload = async () => {
    await page.reload();
    await page.waitForFunction(() => window.fixture !== undefined);
    await mountBar(page);
  };
  await reload();
  await expect(inBar(page, ".bar")).toHaveAttribute("data-edge", "right");
  box = (await bar.boundingBox())!;
  expect(near(box.x, placed.x) && near(box.y, placed.y)).toBe(true);

  await inBar(page, "[data-role=toggle]").click();
  await expect(inBar(page, "#iterbar-body")).toBeHidden();
  await reload();
  await expect(inBar(page, "#iterbar-body")).toBeHidden();
  await expect(inBar(page, ".bar")).toHaveAttribute("data-edge", "right");
  await expect.poll(async () => {
    const current = (await bar.boundingBox())!;
    return Math.round(current.x + current.width);
  }).toBe(viewport.width - 12);
});

test("applies a collapsed property set before the element was defined, over the saved state", async ({ page, openFixture }) => {
  await openFixture();
  await page.evaluate(() => {
    localStorage.setItem(window.fixture.BAR_STATE_STORAGE_KEY, JSON.stringify({ collapsed: false }));
    const bar = document.createElement("iterbar-bar") as HTMLElement & { collapsed: boolean };
    bar.collapsed = true;
    document.body.append(bar);
    window.fixture.defineIterbarBar();
  });
  await expect(inBar(page, "#iterbar-body")).toBeHidden();
  await page.evaluate(() => {
    (document.querySelector("iterbar-bar") as HTMLElement & { collapsed: boolean }).collapsed = false;
  });
  await expect(inBar(page, "#iterbar-body")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem(window.fixture.BAR_STATE_STORAGE_KEY))).toContain('"collapsed":false');
});

test("fits narrow screens, expanded and collapsed, while reconnecting, and keeps one row when there is room", async ({ page, openFixture, fixtureServer }) => {
  // Nothing answers the socket, so the bar keeps reconnecting.
  const daemon = await fakeDaemon(page, fixtureServer.origin, [], { socket: false });
  await openFixture();
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  await expect(inBar(page, "[data-role=status]")).toHaveText("Reconnecting…");
  const toggle = inBar(page, "[data-role=toggle]");
  const fits = async (width: number) => {
    const bar = (await inBar(page, ".bar").boundingBox())!;
    const boxes = await Promise.all((await inBar(page, ".header > *").all()).map(async (control) => (await control.boundingBox())!));
    for (const box of [bar, ...boxes]) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(Math.min(width, bar.x + bar.width) + 0.5);
    }
    if (width >= 640) expect(new Set(boxes.map((box) => Math.round(box.y + box.height / 2))).size).toBe(1);
  };
  for (const width of [1280, 320, 280]) {
    await page.setViewportSize({ width, height: 568 });
    await fits(width);
    await toggle.click();
    await expect(inBar(page, "#iterbar-body")).toBeHidden();
    await fits(width);
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(inBar(page, "#iterbar-body")).toBeVisible();
  }
});

test("ignores a corrupt stored position and keeps working without storage", async ({ page, openFixture }) => {
  await openFixture();
  await page.evaluate(() => localStorage.setItem(window.fixture.BAR_STATE_STORAGE_KEY, "{corrupt"));
  await mountBar(page);
  await expect(inBar(page, ".bar")).toHaveAttribute("data-edge", "bottom");
  await page.evaluate(() => {
    Object.defineProperty(window, "localStorage", { configurable: true, get: () => { throw new DOMException("denied", "SecurityError"); } });
  });
  await inBar(page, "[data-role=toggle]").click();
  await expect(inBar(page, "#iterbar-body")).toBeHidden();
});
