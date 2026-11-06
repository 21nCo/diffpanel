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
  const drag = async (x: number, y: number) => {
    const start = (await handle.boundingBox())!;
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 8 });
    await page.mouse.up();
  };

  await drag(20, viewport.height / 2);
  await expect.poll(async () => (await bar.boundingBox())?.x).toBe(12);
  box = (await bar.boundingBox())!;
  expect(box.y).toBeGreaterThan(12);
  expect(box.y + box.height).toBeLessThan(viewport.height - 12);

  await drag(viewport.width / 2, 15);
  await expect.poll(async () => (await bar.boundingBox())?.y).toBe(12);

  await drag(viewport.width - 5, viewport.height / 2);
  await expect.poll(async () => {
    const current = (await bar.boundingBox())!;
    return Math.round(current.x + current.width);
  }).toBe(viewport.width - 12);
  const placed = (await bar.boundingBox())!;

  // A click on the handle without moving it is not a drag.
  await handle.click();
  expect(await bar.boundingBox()).toEqual(placed);

  await inBar(page, "[data-role=toggle]").click();
  await expect(inBar(page, "#iterbar-body")).toBeHidden();

  await page.reload();
  await page.waitForFunction(() => window.fixture !== undefined);
  await mountBar(page);
  await expect(inBar(page, "#iterbar-body")).toBeHidden();
  await expect(inBar(page, ".bar")).toHaveAttribute("data-edge", "right");
  await expect.poll(async () => {
    const current = (await bar.boundingBox())!;
    return Math.round(current.x + current.width);
  }).toBe(viewport.width - 12);
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
