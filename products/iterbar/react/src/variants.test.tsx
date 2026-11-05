import { createVariantsRegistry, markSlotRange, SLOT_BOUNDARY_ATTRIBUTE, type VariantsRegistry } from "@iterbar/variants";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { PAGE_API_GLOBAL, readPageApi, registrySnapshotSchema, VARIANT_STORAGE_KEY } from "iterbar";
import {
  Component,
  forwardRef,
  memo,
  StrictMode,
  useState,
  version as reactVersion,
  type ReactElement,
  type ReactNode,
} from "react";
import { version as reactDomVersion } from "react-dom";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { Variants, VariantsProvider } from "./index.js";

const SHARED_REGISTRY = Symbol.for("iterbar.variants.registry.v1");

function Pricing() {
  return <Variants slot="pricing" versions={{ v1: <p>Plan one</p>, v2: <p>Plan two</p> }} default="v1" />;
}

function PlanOne() {
  return <p>Plan one</p>;
}

const PlanTwo = memo(function PlanTwo() {
  return <p>Plan two</p>;
});

const PlanThree = forwardRef<HTMLParagraphElement>(function PlanThree(_props, ref) {
  return <p ref={ref}>Plan three</p>;
});

class PlanFour extends Component {
  render() {
    return <p>Plan four</p>;
  }
}

/** Records console errors and warnings and uncaught window errors, such as React's nesting and hydration reports. */
function collectErrors() {
  const errors: string[] = [];
  const record = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  vi.spyOn(console, "error").mockImplementation(record);
  vi.spyOn(console, "warn").mockImplementation(record);
  const onError = (event: ErrorEvent) => record(event.error ?? event.message);
  window.addEventListener("error", onError);
  onTestFinished(() => window.removeEventListener("error", onError));
  return errors;
}

function Counter() {
  const [count, setCount] = useState(0);
  return <button type="button" onClick={() => setCount(count + 1)}>clicked {count}</button>;
}

/** Text of each element marked as a root of `slot`. */
function roots(container: ParentNode, slot: string) {
  return [...container.querySelectorAll(`[data-iterbar-slot="${slot}"]`)].map((element) => element.textContent);
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
  vi.stubEnv("NODE_ENV", "development");
});

/** Lets the range observers, which run as microtasks after each commit, settle before asserting. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

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

  it("offers new versions once every instance of a repeated slot has re-rendered with them", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = { v1: <p>Plan one</p>, v2: <p>Plan two</p> };
    const after = { ...before, v3: PlanThree };
    const page = (first: typeof before, second: typeof before) => (
      <StrictMode>
        <Variants slot="pricing" versions={first} default="v1" />
        <Variants slot="pricing" versions={second} default="v1" />
      </StrictMode>
    );
    const { container, rerender, unmount } = render(page(before, before));
    rerender(page(after, before));
    rerender(page(after, after));
    expect(slots()).toMatchObject([{ slot: "pricing", versions: ["v1", "v2", "v3"], mounts: 2 }]);
    select("pricing", "v3");
    expect(roots(container, "pricing")).toEqual(["Plan three", "Plan three"]);
    unmount();
    expect(slots()).toEqual([]);
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

describe("version content", () => {
  it("renders and switches between component types and elements", () => {
    const { container } = render(
      <Variants
        slot="pricing"
        versions={{ v1: PlanOne, v2: PlanTwo, v3: PlanThree, v4: PlanFour, v5: <p>Plan five</p> }}
        default="v1"
      />,
    );
    expect(roots(container, "pricing")).toEqual(["Plan one"]);
    for (const [version, text] of [["v2", "Plan two"], ["v3", "Plan three"], ["v4", "Plan four"], ["v5", "Plan five"]]) {
      select("pricing", version!);
      expect(roots(container, "pricing")).toEqual([text]);
    }
  });

  it("keeps marking a version that replaces its own root element", async () => {
    function Disclosure() {
      const [open, setOpen] = useState(false);
      return open ? <section>Details</section> : <button type="button" onClick={() => setOpen(true)}>More</button>;
    }
    const { container } = render(<Variants slot="faq" versions={{ closed: Disclosure }} default="closed" />);
    expect(roots(container, "faq")).toEqual(["More"]);
    act(() => screen.getByRole("button").click());
    await waitFor(() => expect(roots(container, "faq")).toEqual(["Details"]));
  });
});

describe("markup in development", () => {
  const contexts: {
    name: string;
    page: (slot: ReactElement) => ReactElement;
    versions: Record<string, ReactNode>;
    text: { a: string; b: string };
  }[] = [
    {
      name: "inline text in a <p>",
      page: (slot) => <p>Price: {slot} per month</p>,
      versions: { a: <strong>ten</strong>, b: <em>twelve</em> },
      text: { a: "ten", b: "twelve" },
    },
    {
      name: "<tr> versions in a <tbody>",
      page: (slot) => <table><tbody>{slot}</tbody></table>,
      versions: { a: <tr><td>Row A</td></tr>, b: <tr><td>Row B</td></tr> },
      text: { a: "Row A", b: "Row B" },
    },
    {
      name: "<li> versions in a <ul>",
      page: (slot) => <ul>{slot}</ul>,
      versions: { a: <li>Item A</li>, b: <li>Item B</li> },
      text: { a: "Item A", b: "Item B" },
    },
  ];

  // Runs before the hydration cases: React reports each invalid nesting only once per page.
  it.each(contexts)("renders $name on the client without nesting errors", ({ page, versions, text }) => {
    const errors = collectErrors();
    const { container } = render(page(<Variants slot="demo" versions={versions} default="a" />));
    expect(roots(container, "demo")).toEqual([text.a]);
    select("demo", "b");
    expect(roots(container, "demo")).toEqual([text.b]);
    expect(errors).toEqual([]);
  });

  it.each(contexts)("hydrates $name without nesting or hydration errors and marks the version", ({ page, versions, text }) => {
    const errors = collectErrors();
    visit("/plans?iterbar=demo:b");
    const tree = () => page(<Variants slot="demo" versions={versions} default="a" />);
    const container = document.createElement("div");
    container.innerHTML = renderToString(tree());
    const serverMarkup = container.innerHTML;
    document.body.append(container);

    render(tree(), { container, hydrate: true });
    expect(roots(container, "demo")).toEqual([text.b]);
    select("demo", "a");
    expect(roots(container, "demo")).toEqual([text.a]);

    expect(errors).toEqual([]);
    // The HTML parser kept the server markup as rendered: nothing was hoisted out of its parent.
    expect(serverMarkup).toBe(renderToString(tree()));
  });

  it("adds no wrapper element and removes the marks it set on unmount", () => {
    const { container, unmount } = render(<ul><Variants slot="list" versions={{ a: <li>One</li> }} default="a" /></ul>);
    const list = container.querySelector("ul");
    expect([...(list?.children ?? [])].map((element) => element.localName)).toEqual(["template", "li", "template"]);
    const item = list?.querySelector("li");
    expect(item?.getAttribute("data-iterbar-slot")).toBe("list");
    unmount();
    expect(item?.hasAttribute("data-iterbar-slot")).toBe(false);
  });
});

describe("nested slots", () => {
  function Inner() {
    return <Variants slot="inner" versions={{ a: <p>Inner A</p>, b: <p>Inner B</p> }} default="a" />;
  }

  function marks(container: ParentNode) {
    return { inner: roots(container, "inner"), outer: roots(container, "outer") };
  }

  const nestings: { name: string; versions: Record<string, ReactNode | typeof Inner>; own: string[] }[] = [
    { name: "a component-type version", versions: { v1: Inner, v2: <p>Outer two</p> }, own: [] },
    {
      name: "a fragment version",
      versions: { v1: <><Inner /><p>Outer one</p></>, v2: <p>Outer two</p> },
      own: ["Outer one"],
    },
  ];

  it.each(nestings)("keeps each slot's marks when an inner slot is the top level of $name", async ({ versions, own }) => {
    const errors = collectErrors();
    const { container, unmount } = render(
      <StrictMode><div><Variants slot="outer" versions={versions} default="v1" /></div></StrictMode>,
    );
    await settle();
    expect(marks(container)).toEqual({ inner: ["Inner A"], outer: own });

    select("inner", "b");
    await settle();
    expect(marks(container)).toEqual({ inner: ["Inner B"], outer: own });

    select("outer", "v2");
    await settle();
    expect(marks(container)).toEqual({ inner: [], outer: ["Outer two"] });
    expect(slots().map((state) => state.slot)).toEqual(["outer"]);

    select("outer", "v1");
    await settle();
    expect(marks(container)).toEqual({ inner: ["Inner B"], outer: own });

    const elements = [...container.querySelectorAll("p")];
    unmount();
    expect(elements.filter((element) => element.hasAttribute("data-iterbar-slot"))).toEqual([]);
    expect(slots()).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("keeps the outer slot's marks while an inner slot mounts and unmounts inside the same version", async () => {
    function Toggle() {
      const [shown, setShown] = useState(false);
      return (
        <>
          {shown ? <Inner /> : null}
          <button type="button" onClick={() => setShown(!shown)}>toggle</button>
        </>
      );
    }
    const { container } = render(<div><Variants slot="outer" versions={{ v1: Toggle }} default="v1" /></div>);
    await settle();
    expect(marks(container)).toEqual({ inner: [], outer: ["toggle"] });

    act(() => screen.getByRole("button").click());
    await settle();
    expect(marks(container)).toEqual({ inner: ["Inner A"], outer: ["toggle"] });

    select("inner", "b");
    await settle();
    expect(marks(container)).toEqual({ inner: ["Inner B"], outer: ["toggle"] });

    act(() => screen.getByRole("button").click());
    await settle();
    expect(marks(container)).toEqual({ inner: [], outer: ["toggle"] });
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
    const { container } = render(<StrictMode><Pricing /></StrictMode>);
    expect(container.innerHTML).toBe("<p>Plan one</p>");
    expect(readPageApi(window)).toBeNull();
    expect((globalThis as Record<PropertyKey, unknown>)[SHARED_REGISTRY]).toBeUndefined();
  });

  it("renders a component-type default without markers", () => {
    const { container } = render(<Variants slot="pricing" versions={{ v1: PlanTwo, v2: PlanOne }} default="v1" />);
    expect(container.innerHTML).toBe("<p>Plan two</p>");
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

describe("development activation", () => {
  // A server whose NODE_ENV is anything but "development" renders what a production client hydrates.
  it.each([undefined, "test", "staging", "production"])("renders and hydrates only the default when NODE_ENV is %s", (value) => {
    const tree = () => <div><Pricing /></div>;
    vi.stubEnv("NODE_ENV", "production");
    const productionHtml = renderToString(tree());
    const errors = collectErrors();
    visit("/plans?iterbar=pricing:v2");
    window.localStorage.setItem(VARIANT_STORAGE_KEY, "pricing:v2");
    vi.stubEnv("NODE_ENV", value);
    const html = renderToString(tree());
    expect(html).toBe(productionHtml);
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);

    vi.stubEnv("NODE_ENV", "production");
    render(tree(), { container, hydrate: true });
    expect(container.innerHTML).toBe("<div><p>Plan one</p></div>");
    expect(readPageApi(window)).toBeNull();
    expect(errors).toEqual([]);
  });
});

describe("slot ranges", () => {
  function boundary(edge: "start" | "end") {
    const template = document.createElement("template");
    template.setAttribute(SLOT_BOUNDARY_ATTRIBUTE, edge);
    return template;
  }

  function paragraph(text: string) {
    const element = document.createElement("p");
    element.textContent = text;
    return element;
  }

  it("follows a range into each parent it moves to, keeps nested ownership and stops on cleanup", async () => {
    const [start, end, innerStart, innerEnd] = [boundary("start"), boundary("end"), boundary("start"), boundary("end")];
    const fragment = document.createDocumentFragment();
    fragment.append(start, paragraph("One"), innerStart, paragraph("Inner"), innerEnd, end);
    const stopInner = markSlotRange(innerStart, innerEnd, "inner");
    const stop = markSlotRange(start, end, "outer");
    const host = document.createElement("div");
    document.body.append(host);
    const marks = () => ({ inner: roots(document.body, "inner"), outer: roots(document.body, "outer") });

    host.append(fragment);
    await settle();
    expect(marks()).toEqual({ inner: ["Inner"], outer: ["One"] });

    start.nextElementSibling?.replaceWith(paragraph("Two"));
    innerStart.nextElementSibling?.replaceWith(paragraph("Inner two"));
    await settle();
    expect(marks()).toEqual({ inner: ["Inner two"], outer: ["Two"] });

    const other = document.createElement("section");
    document.body.append(other);
    other.append(...host.childNodes);
    await settle();
    other.insertBefore(paragraph("Three"), end);
    await settle();
    expect(marks()).toEqual({ inner: ["Inner two"], outer: ["Two", "Three"] });

    stop();
    stopInner();
    other.insertBefore(paragraph("Four"), end);
    await settle();
    expect(marks()).toEqual({ inner: [], outer: [] });
    host.remove();
    other.remove();
  });
});
