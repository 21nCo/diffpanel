import type { Page } from "@playwright/test";
import { comment, fakeDaemon } from "./support/fake-daemon.js";
import { expect, inBar, mountBar, PRICING, registerSlots, test } from "./support/fixtures.js";

/** Rules that try to restyle the bar from outside: inherited properties, the host element, tag names and variables. */
const HOSTILE_CSS = `
  :root { --ib-bg: rgb(255, 0, 0); --ib-fg: rgb(0, 255, 0); --ib-accent: rgb(255, 0, 255); --ib-margin: 300px; }
  html, body {
    font: italic 700 31px/3 "Comic Sans MS", cursive !important;
    color: rgb(255, 0, 0) !important;
    letter-spacing: 7px !important;
    text-transform: uppercase !important;
    text-align: right !important;
    cursor: wait !important;
    visibility: visible;
    word-spacing: 20px !important;
    direction: rtl !important;
    unicode-bidi: bidi-override !important;
  }
  * { box-sizing: content-box !important; }
  iterbar-bar {
    display: block !important; position: absolute !important; top: -9999px !important; opacity: 0 !important;
    visibility: hidden !important; transform: scale(0.1) !important; filter: blur(4px) !important;
    pointer-events: none !important; font-size: 50px !important; color: rgb(0, 0, 255) !important; zoom: 3 !important;
  }
  iterbar-bar[style], iterbar-bar:not(#x) { display: none !important; }
  button, select, summary, li, p, h2, div, span, details, ol, section {
    all: unset !important; background: rgb(255, 0, 0) !important; border: 9px solid red !important;
    font-size: 40px !important; padding: 30px !important; outline: none !important;
  }
  .bar, .header, .version, .thread, .badge, #iterbar-body { background: rgb(255, 0, 0) !important; display: none !important; }
  :focus-visible { outline: none !important; }
`;

const PROPERTIES = [
  "display", "position", "font-family", "font-size", "font-style", "font-weight", "line-height", "color",
  "background-color", "letter-spacing", "word-spacing", "text-transform", "text-align", "cursor", "visibility",
  "opacity", "border-top-width", "border-top-style", "padding-top", "box-sizing", "outline-style", "transform",
  "filter", "pointer-events", "direction", "unicode-bidi", "zoom",
];

const SELECTORS = [
  ".bar", ".header", ".title", "[data-role=status]", "[data-role=handle]", "[data-role=comment]", "[data-role=toggle]",
  "#iterbar-body", ".section-title", "[data-role=slot-name]", "[data-version=v1]", "[data-version=v2]", ".thread",
  ".thread summary", ".badge", ".thread-text",
];

async function barStyles(page: Page) {
  return page.evaluate(({ selectors, properties }) => {
    const root = document.querySelector("iterbar-bar")!.shadowRoot!;
    const result: Record<string, Record<string, string>> = {};
    for (const selector of selectors) {
      const element = root.querySelector(selector);
      if (!element) throw new Error(`missing ${selector}`);
      const style = getComputedStyle(element);
      result[selector] = Object.fromEntries(properties.map((property) => [property, style.getPropertyValue(property)]));
    }
    const box = root.querySelector(".bar")!.getBoundingClientRect();
    result.box = { x: String(box.x), y: String(box.y), width: String(box.width), height: String(box.height) };
    return result;
  }, { selectors: SELECTORS, properties: PROPERTIES });
}

async function pageStyles(page: Page) {
  return page.evaluate((properties) => {
    const result: Record<string, Record<string, string>> = {};
    for (const selector of ["html", "body", "#app", "#page-heading", "#page-text", "#page-button"]) {
      const style = getComputedStyle(document.querySelector(selector)!);
      result[selector] = Object.fromEntries(properties.map((property) => [property, style.getPropertyValue(property)]));
    }
    return { styles: result, sheets: document.styleSheets.length, adopted: document.adoptedStyleSheets.length };
  }, PROPERTIES);
}

async function mountWithContent(page: Page, daemonUrl: string, token: string) {
  await registerSlots(page, [PRICING]);
  await mountBar(page, { daemonUrl, token });
  await expect(inBar(page, ".thread")).toHaveCount(1);
  await expect(inBar(page, "[data-version=v2]")).toBeVisible();
}

test("hostile page CSS does not change how the bar looks", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin, [comment("Styled thread", { status: "working" })]);
  await openFixture();
  await mountWithContent(page, daemon.url, daemon.token);
  const clean = await barStyles(page);

  await openFixture();
  await page.addStyleTag({ content: HOSTILE_CSS });
  // An inline style on the host is page CSS too.
  await page.evaluate(() => {
    window.fixture.defineIterbarBar();
    const bar = document.createElement("iterbar-bar");
    bar.setAttribute("style", "display: none !important; opacity: 0 !important");
    document.body.append(bar);
  });
  await mountWithContent(page, daemon.url, daemon.token);
  expect(await barStyles(page)).toEqual(clean);

  // Focus rings survive a page rule that removes outlines.
  await inBar(page, "[data-version=v2]").focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  const outline = await inBar(page, "[data-version=v2]").evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(outline).toBe("solid");
});

/** Ancestor rules that would make the page's root the bar's containing block, or paint over or hide it. */
const HOSTILE_ANCESTORS = [
  "body { transform: translate(-500px, -500px); }",
  "html { transform: scale(0.5); } body { will-change: transform; }",
  "body { filter: opacity(0); } html { filter: blur(6px); }",
  "html, body { opacity: 0; }",
  "html { zoom: 2; } body { zoom: 0.75; }",
  "html, body { contain: strict; } body { overflow: hidden; height: 50px; }",
  "body { position: relative; z-index: 2147483647; isolation: isolate; } #app { position: fixed; inset: 0; z-index: 2147483647; background: rgb(255, 0, 0); }",
];

async function barSnapshot(page: Page) {
  const bar = page.locator("iterbar-bar .bar");
  const box = await bar.boundingBox();
  if (!box) throw new Error("the bar has no box");
  const clip = { x: box.x + 12, y: box.y + 12, width: box.width - 24, height: box.height - 24 };
  const pixels = await page.screenshot({ clip, animations: "disabled", caret: "hide" });
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.localName ?? null, { x: box.x + box.width / 2, y: box.y + 8 });
  return { box, pixels, hit };
}

test("hostile ancestor CSS cannot move, scale, hide or cover the bar", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin, [comment("Ancestor check")]);
  await openFixture();
  await mountWithContent(page, daemon.url, daemon.token);
  const clean = await barSnapshot(page);
  expect(clean.hit).toBe("iterbar-bar");

  for (const css of HOSTILE_ANCESTORS) {
    await openFixture();
    await page.addStyleTag({ content: css });
    await mountWithContent(page, daemon.url, daemon.token);
    const hostile = await barSnapshot(page);
    expect(hostile.box, css).toEqual(clean.box);
    expect(hostile.hit, css).toBe("iterbar-bar");
    expect(hostile.pixels.equals(clean.pixels), css).toBe(true);
    // Still operable where it is drawn.
    await inBar(page, "[data-version=v2]").click();
    await expect(inBar(page, "[data-version=v2]"), css).toHaveAttribute("aria-pressed", "true");
    // The choice outlives the page load; switch back so the next case starts from the same pixels.
    await inBar(page, "[data-version=v1]").click();
    await expect(inBar(page, "[data-version=v1]"), css).toHaveAttribute("aria-pressed", "true");
  }

  // Moving the bar in the page takes it out of the top layer; connecting it again puts it back.
  await page.evaluate(() => {
    const bar = document.querySelector("iterbar-bar")!;
    document.documentElement.append(bar);
  });
  expect((await barSnapshot(page)).box).toEqual(clean.box);
  expect(await inBar(page, ".bar").evaluate((element) => element.matches(":popover-open"))).toBe(true);
});

test("the bar's styles do not leak into the page", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin, [comment("Leak check")]);
  await openFixture();
  await page.addStyleTag({ content: "button { padding: 1px 2px; } #page-text { color: rgb(1, 2, 3); }" });
  const before = await pageStyles(page);
  await mountWithContent(page, daemon.url, daemon.token);
  await inBar(page, "[data-version=v2]").click();
  expect(await pageStyles(page)).toEqual(before);
});

test("follows prefers-color-scheme", async ({ page, openFixture }) => {
  await openFixture();
  await mountBar(page);
  const colors = () => inBar(page, ".bar").evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, color: style.color, scheme: style.colorScheme };
  });
  await page.emulateMedia({ colorScheme: "light" });
  expect(await colors()).toEqual({ background: "rgb(255, 255, 255)", color: "rgb(27, 29, 33)", scheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await colors()).toEqual({ background: "rgb(28, 31, 37)", color: "rgb(232, 234, 238)", scheme: "dark" });
});

test("loads nothing but the page and the daemon", async ({ page, openFixture, fixtureServer }) => {
  const daemon = await fakeDaemon(page, fixtureServer.origin, [comment("Network check")]);
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  page.on("websocket", (socket) => requested.push(socket.url()));
  await openFixture();
  await mountWithContent(page, daemon.url, daemon.token);
  await page.emulateMedia({ colorScheme: "dark" });
  await inBar(page, "[data-version=v2]").click();
  await inBar(page, ".thread summary").click();
  const allowed = [fixtureServer.origin, daemon.url, daemon.url.replace("http:", "ws:")];
  expect(requested.filter((url) => !allowed.some((origin) => url.startsWith(`${origin}/`)))).toEqual([]);
});
