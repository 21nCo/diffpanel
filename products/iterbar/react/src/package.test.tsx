import { act, cleanup, render } from "@testing-library/react";
import { PAGE_API_GLOBAL, readPageApi, VARIANT_STORAGE_KEY } from "iterbar";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import * as React from "react";
import * as JsxRuntime from "react/jsx-runtime";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Variants } from "./index.js";

// jsdom replaces the URL global, so resolve the path from the module's file URL string.
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(packageDirectory, "dist", "index.js");
const SHARED_REGISTRY = Symbol.for("iterbar.variants.registry.v1");

// esbuild refuses to load under jsdom, whose Uint8Array belongs to another realm, so it runs in a child process.
const BUNDLE_SCRIPT = `
import { build } from "esbuild";
const [entry, nodeEnv] = process.argv.slice(1);
const result = await build({
  entryPoints: [entry], bundle: true, write: false, format: "cjs", platform: "browser", minify: true,
  define: { "process.env.NODE_ENV": JSON.stringify(nodeEnv) }, external: ["react", "react/*"], logLevel: "silent",
});
process.stdout.write(result.outputFiles[0].text);
`;

/** Bundles the built package as a consumer's bundler does, with `process.env.NODE_ENV` replaced. */
function bundle(nodeEnv: string): string {
  return execFileSync(process.execPath, ["--input-type=module", "--eval", BUNDLE_SCRIPT, dist, nodeEnv], {
    cwd: packageDirectory,
    encoding: "utf8",
  });
}

/** Runs a bundle the way a browser does: no `process` global, React from the page. */
function load(code: string): typeof Variants {
  const module = { exports: {} as { Variants: typeof Variants } };
  const modules: Record<string, unknown> = { react: React, "react/jsx-runtime": JsxRuntime };
  const evaluate = runInThisContext(`(function (require, module, exports, process) {${code}\n})`) as (
    require: (id: string) => unknown, target: typeof module, exports: object, process: undefined,
  ) => void;
  evaluate((id) => modules[id], module, module.exports, undefined);
  return module.exports.Variants;
}

const versions = { v1: <p>Plan one</p>, v2: <p>Plan two</p> };

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  const holder = globalThis as Record<PropertyKey, unknown>;
  delete holder[SHARED_REGISTRY];
  delete holder[PAGE_API_GLOBAL];
});

describe("built package", () => {
  const development = bundle("development");
  const production = bundle("production");
  const devOnly = ["MutationObserver", PAGE_API_GLOBAL, "data-iterbar-slot", VARIANT_STORAGE_KEY];

  it("keeps the \"use client\" directive", () => {
    expect(readFileSync(dist, "utf8")).toMatch(/^"use client";/);
  });

  it("leaves the development code out of a production bundle, which still renders the default", () => {
    for (const marker of devOnly) expect(production).not.toContain(marker);
    expect(production.length).toBeLessThan(2048);
    window.history.replaceState(null, "", "/plans?iterbar=pricing:v2");
    window.localStorage.setItem(VARIANT_STORAGE_KEY, "pricing:v2");
    // The runtime NODE_ENV no longer matters once the bundler has replaced it.
    vi.stubEnv("NODE_ENV", "development");
    const BuiltVariants = load(production);
    const { container } = render(<BuiltVariants slot="pricing" versions={versions} default="v1" />);
    expect(container.innerHTML).toBe("<p>Plan one</p>");
    expect(readPageApi(window)).toBeNull();
  });

  it("registers and switches a development bundle in a browser without a process global", () => {
    for (const marker of devOnly) expect(development).toContain(marker);
    window.history.replaceState(null, "", "/plans?iterbar=pricing:v2");
    vi.stubEnv("NODE_ENV", "development");
    const errors = vi.spyOn(console, "error");
    const container = document.createElement("div");
    // A development server, which has process, renders what the process-free client hydrates.
    container.innerHTML = renderToString(<Variants slot="pricing" versions={versions} default="v1" />);
    document.body.append(container);
    vi.stubEnv("NODE_ENV", "production");

    const BuiltVariants = load(development);
    render(<BuiltVariants slot="pricing" versions={versions} default="v1" />, { container, hydrate: true });
    const marked = () => [...container.querySelectorAll("[data-iterbar-slot=pricing]")].map((element) => element.textContent);
    expect(marked()).toEqual(["Plan two"]);
    const api = readPageApi(window);
    expect(api?.getSnapshot().slots).toMatchObject([{ slot: "pricing", activeVersion: "v2" }]);
    act(() => api?.select({ schemaVersion: 1, slot: "pricing", version: "v1" }));
    expect(marked()).toEqual(["Plan one"]);
    expect(errors).not.toHaveBeenCalled();
    container.remove();
  });
});
