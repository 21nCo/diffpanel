import { createVariantsRegistry, type VariantsRegistry } from "@iterbar/variants";
import { act, cleanup, render, screen } from "@testing-library/react";
import { PAGE_API_GLOBAL, readPageApi, registrySnapshotSchema, VARIANT_STORAGE_KEY } from "iterbar";
import { Component, StrictMode, useState, version as reactVersion, type ReactNode } from "react";
import { version as reactDomVersion } from "react-dom";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Variants, VariantsProvider } from "./index.js";

const SHARED_REGISTRY = Symbol.for("iterbar.variants.registry.v1");

function Pricing() {
  return <Variants slot="pricing" versions={{ v1: <p>Plan one</p>, v2: <p>Plan two</p> }} default="v1" />;
}

function Counter() {
  const [count, setCount] = useState(0);
  return <button type="button" onClick={() => setCount(count + 1)}>clicked {count}</button>;
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
  act(() => pageApi().select({ schemaVersion: 1, slot, version }));
}

beforeEach(() => {
  visit("/plans");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  window.localStorage.clear();
  const holder = globalThis as Record<PropertyKey, unknown>;
  delete holder[SHARED_REGISTRY];
  delete holder[PAGE_API_GLOBAL];
});

it(`runs against React ${process.env.ITERBAR_TEST_REACT_MAJOR}`, () => {
  expect(reactVersion.split(".")[0]).toBe(process.env.ITERBAR_TEST_REACT_MAJOR);
  expect(reactDomVersion.split(".")[0]).toBe(process.env.ITERBAR_TEST_REACT_MAJOR);
});

describe("in development", () => {
  it("picks the URL version, then the stored one, then the default", () => {
    window.localStorage.setItem(VARIANT_STORAGE_KEY, "pricing:v1");
    visit("/plans?iterbar=pricing:v2");
    const first = render(<Pricing />);
    expect(screen.getByText("Plan two")).toBeDefined();
    first.unmount();

    window.localStorage.setItem(VARIANT_STORAGE_KEY, "pricing:v2");
    visit("/plans");
    const second = render(<Pricing />);
    expect(screen.getByText("Plan two")).toBeDefined();
    second.unmount();

    window.localStorage.clear();
    render(<Pricing />);
    expect(screen.getByText("Plan one")).toBeDefined();
  });

  it("switches in place through window.__ITERBAR__ without remounting the rest of the page", () => {
    visit("/plans?iterbar=pricing:v1#faq");
    const { container } = render(<><Counter /><Pricing /></>);
    act(() => screen.getByRole("button").click());
    const slotRoot = container.querySelector('[data-iterbar-slot="pricing"]');
    expect(slotRoot?.textContent).toBe("Plan one");

    select("pricing", "v2");

    expect(container.querySelector('[data-iterbar-slot="pricing"]')).toBe(slotRoot);
    expect(slotRoot?.textContent).toBe("Plan two");
    expect(screen.getByRole("button").textContent).toBe("clicked 1");
    expect(window.location.pathname + window.location.search + window.location.hash)
      .toBe("/plans?iterbar=pricing:v2#faq");
    expect(window.localStorage.getItem(VARIANT_STORAGE_KEY)).toBe("pricing:v2");
  });

  it("renders the default for an unknown URL version and reports a registry warning", () => {
    visit("/plans?iterbar=pricing:v9,checkout:b");
    render(<Pricing />);
    expect(screen.getByText("Plan one")).toBeDefined();
    expect(pageApi().getSnapshot().warnings).toEqual([
      expect.objectContaining({ code: "unknown_slot", source: "url", value: "checkout:b" }),
      expect.objectContaining({ code: "unknown_version", source: "url", value: "pricing:v9" }),
    ]);
  });

  it("registers a StrictMode instance once and unregisters it on unmount", () => {
    visit("/plans?iterbar=pricing:v2");
    const { unmount } = render(<StrictMode><Pricing /></StrictMode>);
    expect(screen.getByText("Plan two")).toBeDefined();
    expect(slots()).toEqual([
      { slot: "pricing", versions: ["v1", "v2"], defaultVersion: "v1", activeVersion: "v2", mounts: 1 },
    ]);
    select("pricing", "v1");
    expect(screen.getByText("Plan one")).toBeDefined();
    unmount();
    expect(slots()).toEqual([]);
  });

  it("counts repeated slots, switches every instance and keeps the slot until the last one unmounts", () => {
    function Page({ both }: { both: boolean }) {
      return <StrictMode><Pricing />{both ? <Pricing /> : null}</StrictMode>;
    }
    const { rerender, unmount } = render(<Page both />);
    expect(slots()[0]?.mounts).toBe(2);

    select("pricing", "v2");
    expect(screen.getAllByText("Plan two")).toHaveLength(2);

    rerender(<Page both={false} />);
    expect(slots()[0]).toMatchObject({ mounts: 1, activeVersion: "v2" });
    expect(screen.getAllByText("Plan two")).toHaveLength(1);
    unmount();
    expect(slots()).toEqual([]);
  });

  it("re-registers when the versions change", () => {
    const registry = createVariantsRegistry();
    const { rerender } = render(
      <VariantsProvider registry={registry}>
        <Variants slot="hero" versions={{ a: "A" }} default="a" />
      </VariantsProvider>,
    );
    rerender(
      <VariantsProvider registry={registry}>
        <Variants slot="hero" versions={{ a: "A", b: "B" }} default="a" />
      </VariantsProvider>,
    );
    expect(slots(registry)).toEqual([
      { slot: "hero", versions: ["a", "b"], defaultVersion: "a", activeVersion: "a", mounts: 1 },
    ]);
    expect(readPageApi(window)).toBeNull();
  });

  it("hydrates server-rendered default content, then shows the selected version", () => {
    visit("/plans?iterbar=pricing:v2");
    const html = renderToString(<Pricing />);
    expect(html).toContain("Plan one");
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const errors = vi.spyOn(console, "error");
    render(<Pricing />, { container, hydrate: true });
    expect(container.textContent).toBe("Plan two");
    expect(errors).not.toHaveBeenCalled();
  });

  it("throws an invalid_message error for an invalid slot definition", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // React 18 also re-dispatches render errors as window error events in development; jsdom would print them.
    const silence = (event: ErrorEvent) => event.preventDefault();
    window.addEventListener("error", silence);
    const caught: unknown[] = [];
    class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() {
        return { failed: true };
      }
      componentDidCatch(error: unknown) {
        caught.push(error);
      }
      render() {
        return this.state.failed ? null : this.props.children;
      }
    }
    render(<Boundary><Variants slot="bad slot" versions={{ v1: "one" }} default="v1" /></Boundary>);
    window.removeEventListener("error", silence);
    expect(caught).toEqual([expect.objectContaining({ code: "invalid_message" })]);
  });
});

describe("in production", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
  });

  it("renders only the default, ignores URL and storage, and registers nothing", () => {
    visit("/plans?iterbar=pricing:v2");
    window.localStorage.setItem(VARIANT_STORAGE_KEY, "pricing:v2");
    const { container } = render(<StrictMode><Pricing /></StrictMode>);
    expect(container.innerHTML).toBe("<p>Plan one</p>");
    expect(readPageApi(window)).toBeNull();
    expect((globalThis as Record<PropertyKey, unknown>)[SHARED_REGISTRY]).toBeUndefined();
  });

  it("leaves a provided registry empty", () => {
    const registry = createVariantsRegistry();
    const { container } = render(
      <VariantsProvider registry={registry}><Pricing /></VariantsProvider>,
    );
    expect(container.textContent).toBe("Plan one");
    expect(slots(registry)).toEqual([]);
  });
});
