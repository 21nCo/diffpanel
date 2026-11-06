import { PAGE_API_GLOBAL, VARIANT_STORAGE_KEY } from "iterbar";
import { render } from "svelte/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Variants } from "../src/index.js";
import Invalid from "./fixtures/Invalid.svelte";
import Nested from "./fixtures/Nested.svelte";
import PlanOne from "./fixtures/PlanOne.svelte";
import PlanTwo from "./fixtures/PlanTwo.svelte";
import Pricing from "./fixtures/Pricing.svelte";
import Snippets from "./fixtures/Snippets.svelte";

const SHARED_REGISTRY = Symbol.for("iterbar.variants.registry.v1");

/** Markup without Svelte's hydration comments or the whitespace between tags. */
function html(body: string) {
  return body.replace(/<!--[^>]*-->/g, "").replace(/>\s+</g, "><").trim();
}

/** Fails the test if rendering reads any browser global; Node.js has none of them. */
function expectNoBrowserGlobals() {
  for (const name of ["window", "document", "localStorage", "location", "history", "MutationObserver"]) {
    expect(name in globalThis, name).toBe(false);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  const holder = globalThis as Record<PropertyKey, unknown>;
  expect(holder[SHARED_REGISTRY]).toBeUndefined();
  expect(holder[PAGE_API_GLOBAL]).toBeUndefined();
});

describe("server rendering in development", () => {
  it("renders the default between the slot boundaries, with no registry and no browser globals", () => {
    expectNoBrowserGlobals();
    vi.stubEnv("NODE_ENV", "development");
    const { body } = render(Pricing);
    expect(html(body)).toBe(
      '<template data-iterbar-slot-boundary="start"></template><p>Plan one</p><template data-iterbar-slot-boundary="end"></template>',
    );
    expect(body).not.toContain("data-iterbar-slot=");
    expect(body).not.toContain(VARIANT_STORAGE_KEY);
  });

  it("renders snippet defaults and nested slots' defaults", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(html(render(Snippets).body)).toContain("<p>Plan one</p>");
    expect(html(render(Nested, { props: { form: "snippet" } }).body)).toBe(
      '<div><template data-iterbar-slot-boundary="start"></template>'
      + '<template data-iterbar-slot-boundary="start"></template><p>Inner A</p><template data-iterbar-slot-boundary="end"></template>'
      + '<p>Outer one</p><template data-iterbar-slot-boundary="end"></template></div>',
    );
  });

  it("throws an invalid_message error for an invalid slot definition", () => {
    vi.stubEnv("NODE_ENV", "development");
    const invalid = expect.objectContaining({ code: "invalid_message" });
    // Rendering runs when the body is read; a server-side boundary does not catch it.
    expect(() => render(Invalid, { props: { onerror: () => {} } }).body).toThrow(invalid);
    expect(() => render(Variants, { props: { slot: "pricing", versions: { v1: PlanOne }, default: "v2" as "v1" } }).body)
      .toThrow(invalid);
  });
});

describe("server rendering outside development", () => {
  it.each([undefined, "test", "production"])("renders only the default when NODE_ENV is %s", (value) => {
    vi.stubEnv("NODE_ENV", value);
    const { body } = render(Variants, { props: { slot: "pricing", versions: { v1: PlanOne, v2: PlanTwo }, default: "v1" } });
    expect(html(body)).toBe("<p>Plan one</p>");
  });
});
