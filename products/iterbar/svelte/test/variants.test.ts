import { createVariantsRegistry, MAX_SLOTS, type VariantsRegistry } from "@iterbar/variants";
import { render, screen } from "@testing-library/svelte";
import { PAGE_API_GLOBAL, readPageApi, registrySnapshotSchema, VARIANT_STORAGE_KEY } from "iterbar";
import { flushSync, hydrate, unmount, type Component } from "svelte";
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { serverRenderAll, type ServerRenderJob } from "./support/bundle.js";
import { withoutComments } from "./support/markup.js";
import { Variants, type VersionContent } from "../src/index.js";
import Contexts from "./fixtures/Contexts.svelte";
import Disclosure from "./fixtures/Disclosure.svelte";
import InCard from "./fixtures/InCard.svelte";
import Invalid from "./fixtures/Invalid.svelte";
import Nested from "./fixtures/Nested.svelte";
import Observed from "./fixtures/Observed.svelte";
import Page from "./fixtures/Page.svelte";
import PlanOne from "./fixtures/PlanOne.svelte";
import PlanTwo from "./fixtures/PlanTwo.svelte";
import Plan from "./fixtures/Plan.svelte";
import Pricing from "./fixtures/Pricing.svelte";
import Slot from "./fixtures/Slot.svelte";
import Snippets from "./fixtures/Snippets.svelte";
import Toggle from "./fixtures/Toggle.svelte";

const SHARED_REGISTRY = Symbol.for("iterbar.variants.registry.v1");

/** Records console errors and warnings and uncaught window errors, such as Svelte's hydration reports. */
function collectErrors() {
  const errors: string[] = [];
  const record = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
  for (const level of ["error", "warn"] as const) vi.spyOn(console, level).mockImplementation(record);
  const onError = (event: ErrorEvent) => record(event.error ?? event.message);
  window.addEventListener("error", onError);
  onTestFinished(() => window.removeEventListener("error", onError));
  return errors;
}

/** The container's markup without Svelte's comment anchors. */
function markup(container: Element) {
  return withoutComments(container.innerHTML);
}

/** Text of each element marked as a root of `slot`. */
function roots(container: ParentNode, slot: string) {
  return [...container.querySelectorAll(`[data-iterbar-slot="${slot}"]`)].map((element) => element.textContent?.trim());
}

function visit(path: string) {
  window.history.replaceState(null, "", path);
}

function pageApi() {
  const api = readPageApi(window);
  if (!api) throw new Error("window.__ITERBAR__ is not installed");
  return api;
}

function slots(registry?: VariantsRegistry) {
  return registrySnapshotSchema.parse((registry ?? pageApi()).getSnapshot()).slots;
}

function select(slot: string, version: string) {
  pageApi().select({ schemaVersion: 1, slot, version });
  flushSync();
}

/** Lets the range observers, which run as microtasks after each change, settle before asserting. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
}

const PLACES = ["paragraph", "table", "list"] as const;
const NON_DEVELOPMENT = ["", "test", "staging", "production"];

/** Every server render the tests hydrate, prepared in one process before they run. */
const SERVER_RENDERS: ServerRenderJob[] = [
  { entry: "test/fixtures/Pricing.svelte", nodeEnv: "development" },
  ...NON_DEVELOPMENT.map((nodeEnv) => ({ entry: "test/fixtures/Pricing.svelte", nodeEnv })),
  ...PLACES.map((where) => ({ entry: "test/fixtures/Contexts.svelte", nodeEnv: "development", props: { where } })),
  { entry: "test/fixtures/Observed.svelte", nodeEnv: "development", props: { names: ["a", "b"], log: [] } },
];

let serverRender: (job: ServerRenderJob) => string;

beforeAll(() => {
  serverRender = serverRenderAll(SERVER_RENDERS);
}, 60_000);

/** Hydrates the server's HTML for `fixture` with NODE_ENV `nodeEnv` in a new container on the page. */
function hydrateServerHtml<Props extends Record<string, unknown>>(
  fixture: string,
  component: Component<Props>,
  nodeEnv: string,
  props: Props,
) {
  const container = document.createElement("div");
  container.innerHTML = serverRender({ entry: `test/fixtures/${fixture}`, nodeEnv, props });
  const serverMarkup = container.innerHTML;
  document.body.append(container);
  const instance = hydrate(component, { target: container, props });
  flushSync();
  onTestFinished(() => {
    unmount(instance);
    container.remove();
  });
  return { container, serverMarkup };
}

beforeEach(() => {
  visit("/plans");
  vi.stubEnv("NODE_ENV", "development");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  window.localStorage.clear();
  const holder = globalThis as Record<PropertyKey, unknown>;
  delete holder[SHARED_REGISTRY];
  delete holder[PAGE_API_GLOBAL];
});

describe("in development", () => {
  it("picks the URL version, then the stored one, then the default", () => {
    window.localStorage.setItem(VARIANT_STORAGE_KEY, "pricing:v1");
    visit("/plans?iterbar=pricing:v2");
    const first = render(Pricing);
    expect(screen.getByText("Plan two")).toBeDefined();
    first.unmount();

    window.localStorage.setItem(VARIANT_STORAGE_KEY, "pricing:v2");
    visit("/plans");
    const second = render(Pricing);
    expect(screen.getByText("Plan two")).toBeDefined();
    second.unmount();

    window.localStorage.clear();
    render(Pricing);
    expect(screen.getByText("Plan one")).toBeDefined();
  });

  it("mounts only the selected version on a client mount, never the default first", () => {
    visit("/plans?iterbar=probe:b");
    const log: string[] = [];
    render(Observed, { names: ["a", "b"], log });
    expect(log.filter((entry) => !entry.startsWith("shows"))).toEqual(["mount b"]);
    expect(slots()).toMatchObject([{ slot: "probe", activeVersion: "b" }]);
  });

  it("shows the default at once when new versions drop the active one", () => {
    const log: string[] = [];
    const { rerender } = render(Observed, { names: ["a", "b"], log });
    select("probe", "b");
    log.length = 0;
    rerender({ names: ["a", "c"], log });
    // Rendered in the same update as the new versions: the default, never an empty slot.
    expect(log.filter((entry) => entry.startsWith("shows"))).toEqual(["shows a"]);
    expect(log.filter((entry) => !entry.startsWith("shows")).sort()).toEqual(["mount a", "unmount b"]);
    expect(slots()).toMatchObject([{ slot: "probe", versions: ["a", "c"], activeVersion: "a" }]);
  });

  it("hydrates the server's default, then switches to the selected version", () => {
    visit("/plans?iterbar=probe:b");
    const errors = collectErrors();
    const log: string[] = [];
    const { container } = hydrateServerHtml("Observed.svelte", Observed, "development", { names: ["a", "b"], log });
    expect(log.filter((entry) => !entry.startsWith("shows"))).toEqual(["mount a", "mount b", "unmount a"]);
    expect(roots(container, "probe")).toEqual(["b"]);
    expect(errors).toEqual([]);
  });

  it("remounts when new versions change the active version, even from one default to another", () => {
    const { rerender } = render(Slot, { slot: "faq", versions: { a: Disclosure, b: Disclosure }, default: "a" });
    screen.getByRole("button").click();
    flushSync();
    rerender({ slot: "faq", versions: { b: Disclosure }, default: "b" });
    expect(screen.getByRole("button").textContent).toBe("More");
  });

  it("keeps the active version's state when only the default changes", () => {
    const { container, rerender } = render(Slot, { slot: "faq", versions: { a: Disclosure, b: Disclosure }, default: "a" });
    select("faq", "b");
    screen.getByRole("button").click();
    flushSync();
    rerender({ slot: "faq", versions: { a: Disclosure, b: Disclosure }, default: "b" });
    expect(container.textContent?.trim()).toBe("Details");
  });

  it("leaves no registry listener behind when registering fails", () => {
    const registry = createVariantsRegistry();
    for (let index = 0; index < MAX_SLOTS; index += 1) {
      registry.register({ slot: `slot${index}`, versions: ["a"], defaultVersion: "a" });
    }
    let listeners = 0;
    const subscribe = registry.subscribe.bind(registry);
    vi.spyOn(registry, "subscribe").mockImplementation((listener) => {
      listeners += 1;
      const unsubscribe = subscribe(listener);
      return () => {
        listeners -= 1;
        unsubscribe();
      };
    });
    expect(() => render(Slot, { slot: "extra", versions: { a: PlanOne }, default: "a", registry }))
      .toThrow(expect.objectContaining({ code: "invalid_message" }));
    expect(listeners).toBe(0);
  });

  it("switches in place through window.__ITERBAR__ without remounting the rest of the page", () => {
    visit("/plans?iterbar=pricing:v1#faq");
    const { container } = render(Page);
    screen.getByRole("button").click();
    flushSync();
    const button = screen.getByRole("button");
    expect(roots(container, "pricing")).toEqual(["Plan one"]);

    select("pricing", "v2");

    expect(roots(container, "pricing")).toEqual(["Plan two"]);
    expect(screen.queryByText("Plan one")).toBeNull();
    expect(screen.getByRole("button")).toBe(button);
    expect(button.textContent).toBe("clicked 1");
    expect(window.location.pathname + window.location.search + window.location.hash)
      .toBe("/plans?iterbar=pricing:v2#faq");
    expect(window.localStorage.getItem(VARIANT_STORAGE_KEY)).toBe("pricing:v2");
  });

  it("remounts the version on every switch, so versions never share state", async () => {
    const { container } = render(Slot, {
      slot: "faq",
      versions: { closed: Disclosure, again: Disclosure },
      default: "closed",
    });
    screen.getByRole("button").click();
    await settle();
    expect(roots(container, "faq")).toEqual(["Details"]);
    select("faq", "again");
    expect(roots(container, "faq")).toEqual(["More"]);
  });

  it("renders the default for an unknown URL version and reports a registry warning", () => {
    visit("/plans?iterbar=pricing:v9,checkout:b");
    render(Pricing);
    expect(screen.getByText("Plan one")).toBeDefined();
    expect(pageApi().getSnapshot().warnings).toEqual([
      expect.objectContaining({ code: "unknown_slot", source: "url", value: "checkout:b" }),
      expect.objectContaining({ code: "unknown_version", source: "url", value: "pricing:v9" }),
    ]);
  });

  it("registers once, unregisters on unmount, and stops following the registry", () => {
    visit("/plans?iterbar=pricing:v2");
    const { container, unmount: unmountPricing } = render(Pricing);
    expect(slots()).toEqual([
      { slot: "pricing", versions: ["v1", "v2"], defaultVersion: "v1", activeVersion: "v2", mounts: 1 },
    ]);
    select("pricing", "v1");
    expect(screen.getByText("Plan one")).toBeDefined();
    const api = pageApi();
    unmountPricing();
    expect(slots()).toEqual([]);
    expect(container.innerHTML).toBe("");
    api.select({ schemaVersion: 1, slot: "pricing", version: "v2" });
    flushSync();
    expect(container.innerHTML).toBe("");
    expect(api.getSnapshot().warnings).toContainEqual(
      expect.objectContaining({ code: "unknown_slot", source: "api", value: "pricing:v2" }),
    );
  });

  it("counts repeated slots, switches every instance and keeps the slot until the last one unmounts", () => {
    const { rerender, unmount: unmountPage } = render(Page, { copies: 2 });
    expect(slots()[0]?.mounts).toBe(2);

    select("pricing", "v2");
    expect(screen.getAllByText("Plan two")).toHaveLength(2);

    rerender({ copies: 1 });
    expect(slots()[0]).toMatchObject({ mounts: 1, activeVersion: "v2" });
    expect(screen.getAllByText("Plan two")).toHaveLength(1);
    unmountPage();
    expect(slots()).toEqual([]);
  });

  it("re-registers with a provided registry when the versions change, and never with the page's", () => {
    const registry = createVariantsRegistry();
    const { rerender, container } = render(Slot, { slot: "hero", versions: { a: PlanOne }, default: "a", registry });
    expect(slots(registry)).toMatchObject([{ slot: "hero", versions: ["a"] }]);
    rerender({ slot: "hero", versions: { a: PlanOne, b: PlanTwo }, default: "a", registry });
    expect(slots(registry)).toEqual([
      { slot: "hero", versions: ["a", "b"], defaultVersion: "a", activeVersion: "a", mounts: 1 },
    ]);
    registry.select({ schemaVersion: 1, slot: "hero", version: "b" });
    flushSync();
    expect(roots(container, "hero")).toEqual(["Plan two"]);
    expect(readPageApi(window)).toBeNull();
    expect((globalThis as Record<PropertyKey, unknown>)[SHARED_REGISTRY]).toBeUndefined();
  });

  it("keeps its registration when the versions object changes but its names do not", () => {
    const registry = createVariantsRegistry();
    const register = vi.spyOn(registry, "register");
    const { rerender } = render(Slot, { slot: "hero", versions: { a: PlanOne }, default: "a", registry });
    rerender({ slot: "hero", versions: { a: PlanTwo }, default: "a", registry });
    expect(register).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Plan two")).toBeDefined();
  });

  it("hydrates server-rendered default content, then shows the selected version", () => {
    visit("/plans?iterbar=pricing:v2");
    const errors = collectErrors();
    const { container, serverMarkup } = hydrateServerHtml("Pricing.svelte", Pricing, "development", {});
    expect(serverMarkup).toContain("Plan one");
    expect(serverMarkup).not.toContain("Plan two");
    expect(roots(container, "pricing")).toEqual(["Plan two"]);
    select("pricing", "v1");
    expect(roots(container, "pricing")).toEqual(["Plan one"]);
    expect(errors).toEqual([]);
  });

  it("offers new versions once every instance of a repeated slot has re-rendered with them", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = createVariantsRegistry();
    const before = { v1: PlanOne };
    const after = { v1: PlanOne, v2: PlanTwo };
    const first = render(Slot, { slot: "pricing", versions: before, default: "v1", registry });
    const second = render(Slot, { slot: "pricing", versions: before, default: "v1", registry });
    first.rerender({ slot: "pricing", versions: after, default: "v1", registry });
    expect(slots(registry)).toMatchObject([{ slot: "pricing", versions: ["v1"], mounts: 2 }]);
    second.rerender({ slot: "pricing", versions: after, default: "v1", registry });
    expect(slots(registry)).toMatchObject([{ slot: "pricing", versions: ["v1", "v2"], mounts: 2 }]);
    registry.select({ schemaVersion: 1, slot: "pricing", version: "v2" });
    flushSync();
    expect(screen.getAllByText("Plan two")).toHaveLength(2);
    first.unmount();
    second.unmount();
    expect(slots(registry)).toEqual([]);
  });

  it("throws an invalid_message error for an invalid slot definition", () => {
    const caught: unknown[] = [];
    render(Invalid, { onerror: (error: unknown) => caught.push(error) });
    expect(caught).toEqual([expect.objectContaining({ code: "invalid_message" })]);
    expect(screen.getByText("failed")).toBeDefined();
    expect(readPageApi(window)).toBeNull();
  });

  it("works as a direct child of a component when the slot name is passed by spread", () => {
    const { container } = render(InCard);
    expect(roots(container, "pricing")).toEqual(["Plan one"]);
    select("pricing", "v2");
    expect(container.querySelector("article [data-iterbar-slot=pricing]")?.textContent).toBe("Plan two");
  });
});

describe("version content", () => {
  it("renders and switches between components and snippets, including text", () => {
    const { container } = render(Snippets);
    expect(roots(container, "pricing")).toEqual(["Plan one"]);
    select("pricing", "v2");
    expect(roots(container, "pricing")).toEqual(["Plan compact"]);
    select("pricing", "v3");
    expect(roots(container, "pricing")).toEqual([]);
    expect(container.textContent?.trim()).toBe("Plan as text");
  });

  it("renders nothing for a default that is not an own version name", () => {
    vi.stubEnv("NODE_ENV", "production");
    const { container } = render(Variants, { slot: "pricing", versions: { v1: PlanOne }, default: "toString" as "v1" });
    expect(container.textContent).toBe("");
  });

  it("keeps marking a version that replaces its own root element", async () => {
    const { container } = render(Slot, { slot: "faq", versions: { closed: Disclosure }, default: "closed" });
    expect(roots(container, "faq")).toEqual(["More"]);
    screen.getByRole("button").click();
    await settle();
    expect(roots(container, "faq")).toEqual(["Details"]);
  });
});

describe("markup in development", () => {
  const contexts = [
    { context: PLACES[0], text: { a: "ten", b: "twelve" } },
    { context: PLACES[1], text: { a: "Row A", b: "Row B" } },
    { context: PLACES[2], text: { a: "Item A", b: "Item B" } },
  ] as const;

  it.each(contexts)("renders a slot in a $context on the client without errors", ({ context, text }) => {
    const errors = collectErrors();
    const { container } = render(Contexts, { where: context });
    expect(roots(container, "demo")).toEqual([text.a]);
    select("demo", "b");
    expect(roots(container, "demo")).toEqual([text.b]);
    expect(errors).toEqual([]);
  });

  it.each(contexts)("hydrates a slot in a $context without hydration errors and marks the version", ({ context, text }) => {
    const errors = collectErrors();
    visit("/plans?iterbar=demo:b");
    const { container, serverMarkup } = hydrateServerHtml("Contexts.svelte", Contexts, "development", { where: context });
    expect(roots(container, "demo")).toEqual([text.b]);
    select("demo", "a");
    expect(roots(container, "demo")).toEqual([text.a]);
    expect(errors).toEqual([]);
    // The HTML parser kept the server markup as rendered: nothing was hoisted out of its parent.
    expect(serverMarkup).toBe(serverRender({ entry: "test/fixtures/Contexts.svelte", nodeEnv: "development", props: { where: context } }));
  });

  it("adds no wrapper element and removes the marks it set on unmount", () => {
    const { container, unmount: unmountList } = render(Contexts, { where: "list" });
    const list = container.querySelector("ul");
    expect([...(list?.children ?? [])].map((element) => element.localName)).toEqual(["template", "li", "template"]);
    expect([...(list?.querySelectorAll("template") ?? [])].map((element) => element.getAttribute("data-iterbar-slot-boundary")))
      .toEqual(["start", "end"]);
    const item = list?.querySelector("li");
    expect(item?.getAttribute("data-iterbar-slot")).toBe("demo");
    unmountList();
    expect(item?.hasAttribute("data-iterbar-slot")).toBe(false);
  });
});

describe("nested slots", () => {
  /** Once the range observers settle, the elements marked as roots of the inner and the outer slot. */
  async function expectMarks(container: ParentNode, inner: readonly string[], outer: readonly string[]) {
    await settle();
    expect([roots(container, "inner"), roots(container, "outer")]).toEqual([inner, outer]);
  }
  const toggle = () => screen.getByRole("button").click();

  it.each([
    { form: "component", own: [] },
    { form: "snippet", own: ["Outer one"] },
  ] as const)("keeps each slot's marks when an inner slot is the top level of a $form version", async ({ form, own }) => {
    const errors = collectErrors();
    const { container, unmount: unmountNested } = render(Nested, { form });
    await expectMarks(container, ["Inner A"], own);
    select("inner", "b");
    await expectMarks(container, ["Inner B"], own);
    select("outer", "v2");
    await expectMarks(container, [], ["Outer two"]);
    // The inner slot unmounted with the outer slot's first version.
    expect(slots().map((state) => state.slot)).toEqual(["outer"]);
    select("outer", "v1");
    await expectMarks(container, ["Inner B"], own);

    const paragraphs = [...container.querySelectorAll("p")];
    unmountNested();
    expect(paragraphs.filter((paragraph) => paragraph.hasAttribute("data-iterbar-slot"))).toEqual([]);
    expect(slots()).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("keeps the outer slot's marks while an inner slot mounts and unmounts inside the same version", async () => {
    const { container } = render(Slot, { slot: "outer", versions: { v1: Toggle }, default: "v1" });
    await expectMarks(container, [], ["toggle"]);
    toggle();
    await expectMarks(container, ["Inner A"], ["toggle"]);
    select("inner", "b");
    await expectMarks(container, ["Inner B"], ["toggle"]);
    toggle();
    await expectMarks(container, [], ["toggle"]);
    expect(slots().map((state) => state.slot)).toEqual(["outer"]);
  });
});

describe("in production", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
  });

  it("renders only the default, ignores URL and storage, and registers nothing", () => {
    visit("/plans?iterbar=pricing:v2");
    window.localStorage.setItem(VARIANT_STORAGE_KEY, "pricing:v2");
    const { container } = render(Pricing);
    expect(markup(container)).toBe("<p>Plan one</p>");
    expect(readPageApi(window)).toBeNull();
    expect((globalThis as Record<PropertyKey, unknown>)[SHARED_REGISTRY]).toBeUndefined();
  });

  it("renders a snippet default without markers", () => {
    const { container } = render(Snippets);
    expect(markup(container)).toBe("<p>Plan one</p>");
  });

  it("leaves a provided registry empty", () => {
    const registry = createVariantsRegistry();
    const { container } = render(Slot, { slot: "pricing", versions: { v1: PlanOne, v2: PlanTwo }, default: "v1", registry });
    expect(container.textContent).toBe("Plan one");
    expect(container.querySelector("template")).toBeNull();
    expect(slots(registry)).toEqual([]);
  });

  it("does not validate the slot definition", () => {
    const { container } = render(Variants, { slot: "bad slot", versions: { v1: PlanOne }, default: "v1" });
    expect(container.textContent).toBe("Plan one");
  });
});

describe("development activation", () => {
  // A server whose NODE_ENV is anything but "development" renders what a production client hydrates.
  it.each(NON_DEVELOPMENT)("renders and hydrates only the default when NODE_ENV is %j", (value) => {
    const productionHtml = serverRender({ entry: "test/fixtures/Pricing.svelte", nodeEnv: "production" });
    const errors = collectErrors();
    visit("/plans?iterbar=pricing:v2");
    window.localStorage.setItem(VARIANT_STORAGE_KEY, "pricing:v2");
    vi.stubEnv("NODE_ENV", value || undefined);
    const { container, serverMarkup } = hydrateServerHtml("Pricing.svelte", Pricing, value, {});
    expect(serverMarkup).toBe(productionHtml);
    expect(container.textContent?.trim()).toBe("Plan one");
    expect(container.querySelector("template, [data-iterbar-slot]")).toBeNull();
    expect(readPageApi(window)).toBeNull();
    expect(errors).toEqual([]);
  });
});

describe("types", () => {
  it("accept components without required props and snippets, and only version names as the default", () => {
    const versions: Record<string, VersionContent> = { v1: PlanOne, v2: Disclosure };
    // @ts-expect-error A version component cannot require props; pass them through { snippet } instead.
    const needsProps: VersionContent = Plan;
    // @ts-expect-error The default must be one of the version names.
    const unknownDefault: Parameters<typeof Variants<{ v1: typeof PlanOne }>>[1] = { slot: "pricing", versions: { v1: PlanOne }, default: "v2" };
    expect([Object.keys(versions), needsProps, unknownDefault.default]).toEqual([["v1", "v2"], Plan, "v2"]);
  });
});
