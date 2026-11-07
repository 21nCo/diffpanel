import type { Page } from "@playwright/test";
import { comment, fakeDaemon } from "./support/fake-daemon.js";
import { expect, HERO, inBar, mountBar, PRICING, registerSlots, test } from "./support/fixtures.js";

/** The control focused inside the bar, described by its role, or `null` when focus is outside the bar. */
function focusedControl(page: Page) {
  return page.evaluate(() => {
    const active = document.querySelector("iterbar-bar")?.shadowRoot?.activeElement as HTMLElement | null | undefined;
    if (!active) return null;
    const style = getComputedStyle(active);
    return {
      id: active.dataset.role ?? active.dataset.version ?? (active.tagName === "SUMMARY" ? "summary" : active.tagName),
      outline: `${style.outlineStyle} ${style.outlineWidth}`,
    };
  });
}

test("is fully operable from the keyboard, with visible focus on every control", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin, [comment("Keyboard thread")]);
  await openFixture();
  await page.evaluate(() => localStorage.setItem(window.fixture.BAR_STATE_STORAGE_KEY, JSON.stringify({ collapsed: true })));
  await registerSlots(page, [PRICING, HERO]);
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
  await expect(inBar(page, ".thread")).toHaveCount(1);
  await expect(inBar(page, "#iterbar-body")).toBeHidden();

  await page.locator("#page-button").focus();
  // The shortcut expands the bar from anywhere and moves focus into it.
  await page.keyboard.press("Alt+Shift+KeyI");
  await expect(inBar(page, "#iterbar-body")).toBeVisible();
  expect(await focusedControl(page)).toMatchObject({ id: "toggle" });
  await expect(inBar(page, "[data-role=toggle]")).toHaveAttribute("aria-expanded", "true");

  // Every control is reachable by Tab, in order, and each shows a focus ring.
  const visited: string[] = [];
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  for (let step = 0; step < 12; step += 1) {
    const focused = await focusedControl(page);
    if (!focused) break;
    expect(focused.outline, `focus ring on ${focused.id}`).toMatch(/^solid [1-9]/);
    visited.push(focused.id);
    await page.keyboard.press("Tab");
  }
  expect(visited).toEqual(["handle", "comment", "toggle", "slot-select", "v1", "v2", "v3", "summary"]);
  const controls = await page.evaluate(() => [...document.querySelector("iterbar-bar")!.shadowRoot!
    .querySelectorAll("button, select, summary, input, textarea, a[href], [tabindex]")]
    .filter((element) => (element as HTMLElement).checkVisibility()).length);
  expect(controls).toBe(visited.length);

  // Choose the second slot by typing, then switch its version with Enter.
  await inBar(page, "[data-role=slot-select]").focus();
  await page.keyboard.type("h");
  await expect(inBar(page, "[data-role=versions] button")).toHaveText(["a (default)", "b"]);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  expect(await focusedControl(page)).toMatchObject({ id: "b" });
  await page.keyboard.press("Enter");
  await expect(inBar(page, "[data-version=b]")).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => location.search)).toBe("?iterbar=hero:b");

  // Open a thread with the keyboard.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(inBar(page, ".thread details")).toHaveAttribute("open", "");

  // Comment mode toggles with Space and announces the change.
  const events = page.evaluate(() => new Promise<boolean>((resolve) => {
    document.addEventListener(window.fixture.COMMENT_MODE_EVENT, (event) => resolve((event as CustomEvent<{ active: boolean }>).detail.active), { once: true });
  }));
  await inBar(page, "[data-role=comment]").focus();
  await page.keyboard.press("Space");
  expect(await events).toBe(true);
  await expect(inBar(page, "[data-role=comment]")).toHaveAttribute("aria-pressed", "true");

  // Arrow keys on the handle move the bar to that screen edge.
  await inBar(page, "[data-role=handle]").focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(async () => (await inBar(page, ".bar").boundingBox())?.y).toBe(12);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => (await inBar(page, ".bar").boundingBox())?.x).toBe(12);

  // The shortcut collapses it again; focus that was inside stays on a visible control.
  await page.keyboard.press("Alt+Shift+KeyI");
  await expect(inBar(page, "#iterbar-body")).toBeHidden();
  expect(await focusedControl(page)).toMatchObject({ id: "toggle" });
  await page.keyboard.press("Enter");
  await expect(inBar(page, "#iterbar-body")).toBeVisible();
});

test("the shortcut ignores other modifier combinations", async ({ page, openFixture }) => {
  await openFixture();
  await mountBar(page);
  await expect(inBar(page, "#iterbar-body")).toBeVisible();
  for (const keys of ["Alt+KeyI", "Shift+KeyI", "Control+Alt+Shift+KeyI", "Meta+Alt+Shift+KeyI"]) {
    await page.keyboard.press(keys);
    await expect(inBar(page, "#iterbar-body")).toBeVisible();
  }
});
