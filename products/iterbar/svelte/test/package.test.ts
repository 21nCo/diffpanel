import { PAGE_API_GLOBAL, readPageApi, VARIANT_STORAGE_KEY } from "iterbar";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInThisContext } from "node:vm";
import * as Svelte from "svelte";
import * as SvelteInternal from "svelte/internal/client";
import { flushSync, hydrate, mount, unmount, type Component } from "svelte";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { bundle, packageDirectory, serverRenderAll } from "./support/bundle.js";

const SHARED_REGISTRY = Symbol.for("iterbar.variants.registry.v1");
const FIXTURE = "test/fixtures/BuiltPricing.svelte";

/** Runs a CommonJS bundle the way a browser does: no `process` global (or the given one), Svelte from the page. */
function load(code: string, process?: object): Component<Record<string, never>> {
  const module = { exports: {} as { default: Component<Record<string, never>> } };
  const modules: Record<string, unknown> = {
    svelte: Svelte,
    "svelte/internal/client": SvelteInternal,
    "svelte/internal/disclose-version": {},
    "svelte/internal/flags/legacy": {},
  };
  const require = (id: string) => {
    if (!(id in modules)) throw new Error(`The bundle requires ${id}, which the test does not provide`);
    return modules[id];
  };
  const evaluate = runInThisContext(`(function (require, module, exports, process) {${code}\n})`) as (
    require: (id: string) => unknown, target: typeof module, exports: object, process: object | undefined,
  ) => void;
  evaluate(require, module, module.exports, process);
  return module.exports.default;
}

/** Mounts, or hydrates `html`, in a new container on the page until the test finishes. */
function show(component: Component<Record<string, never>>, html?: string) {
  const container = document.createElement("div");
  document.body.append(container);
  if (html !== undefined) container.innerHTML = html;
  const instance = html === undefined ? mount(component, { target: container }) : hydrate(component, { target: container });
  flushSync();
  onTestFinished(() => {
    unmount(instance);
    container.remove();
  });
  return container;
}

function text(container: Element) {
  return container.textContent?.trim();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  const holder = globalThis as Record<PropertyKey, unknown>;
  delete holder[SHARED_REGISTRY];
  delete holder[PAGE_API_GLOBAL];
});

describe("built package", () => {
  const development = bundle(FIXTURE, { dev: true, nodeEnv: "development" });
  const production = bundle(FIXTURE, { dev: false, nodeEnv: "production" });
  const unreplaced = bundle(FIXTURE, { dev: false, nodeEnv: "" });
  const devOnly = ["MutationObserver", PAGE_API_GLOBAL, "data-iterbar-slot", VARIANT_STORAGE_KEY];

  it("ships Svelte sources, declarations and no tests", () => {
    const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")) as {
      exports: Record<string, Record<string, string>>;
      peerDependencies: Record<string, string>;
    };
    expect(manifest.exports["."]).toMatchObject({ types: "./dist/index.d.ts", svelte: "./dist/index.js" });
    expect(manifest.peerDependencies.svelte).toBeDefined();
    for (const file of ["index.js", "index.d.ts", "Variants.svelte", "Variants.svelte.d.ts", "VariantsProvider.svelte"]) {
      expect(readFileSync(join(packageDirectory, "dist", file), "utf8").length, file).toBeGreaterThan(0);
    }
    expect(unreplaced).toContain("process.env.NODE_ENV");
  });

  it("leaves the development code out of a production bundle, which still renders the default", () => {
    for (const marker of devOnly) expect(production).not.toContain(marker);
    expect(production.length).toBeLessThan(4096);
    window.history.replaceState(null, "", "/plans?iterbar=pricing:v2");
    window.localStorage.setItem(VARIANT_STORAGE_KEY, "pricing:v2");
    // The runtime NODE_ENV no longer matters once the bundler has replaced it.
    vi.stubEnv("NODE_ENV", "development");
    const container = show(load(production));
    expect(text(container)).toBe("Plan one");
    expect(container.querySelector("template, [data-iterbar-slot]")).toBeNull();
    expect(readPageApi(window)).toBeNull();
  });

  it.each([["no process global", undefined], ["a process without env", {}]])(
    "renders only the default from an unreplaced bundle in a browser with %s",
    (_name, process) => {
      window.history.replaceState(null, "", "/plans?iterbar=pricing:v2");
      const container = show(load(unreplaced, process));
      expect(text(container)).toBe("Plan one");
      expect(readPageApi(window)).toBeNull();
    },
  );

  it("hydrates, registers and switches a development bundle in a browser without a process global", () => {
    for (const marker of devOnly) expect(development).toContain(marker);
    window.history.replaceState(null, "", "/plans?iterbar=pricing:v2");
    const errors = vi.spyOn(console, "error");
    const warnings = vi.spyOn(console, "warn");
    // A development server, which has process, renders what the process-free client hydrates.
    const html = serverRenderAll([{ entry: FIXTURE, nodeEnv: "development" }])({ entry: FIXTURE, nodeEnv: "development" });
    vi.stubEnv("NODE_ENV", "production");

    const container = show(load(development), html);
    const marked = () => [...container.querySelectorAll("[data-iterbar-slot=pricing]")].map((element) => element.textContent);
    expect(marked()).toEqual(["Plan two"]);
    const api = readPageApi(window);
    expect(api?.getSnapshot().slots).toMatchObject([{ slot: "pricing", activeVersion: "v2" }]);
    api?.select({ schemaVersion: 1, slot: "pricing", version: "v1" });
    flushSync();
    expect(marked()).toEqual(["Plan one"]);
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
  });
});
