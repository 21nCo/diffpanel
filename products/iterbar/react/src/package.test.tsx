// @vitest-environment node
// esbuild refuses to run under jsdom, whose TextEncoder returns another realm's Uint8Array.
import { build } from "esbuild";
import { PAGE_API_GLOBAL, VARIANT_STORAGE_KEY } from "iterbar";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import * as React from "react";
import * as JsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Variants } from "./index.js";

const dist = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/** Bundles the built package as a consumer's bundler does, with `process.env.NODE_ENV` replaced. */
async function bundle(nodeEnv: string) {
  const result = await build({
    entryPoints: [dist],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "browser",
    minify: true,
    define: { "process.env.NODE_ENV": JSON.stringify(nodeEnv) },
    external: ["react", "react/*"],
    logLevel: "silent",
  });
  return result.outputFiles[0]!.text;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("built package", () => {
  it("keeps the \"use client\" directive", async () => {
    expect(await readFile(dist, "utf8")).toMatch(/^"use client";/);
  });

  it("leaves the development code out of a production bundle, which still renders the default", async () => {
    const development = await bundle("development");
    const production = await bundle("production");
    const devOnly = ["MutationObserver", PAGE_API_GLOBAL, "data-iterbar-slot", VARIANT_STORAGE_KEY];
    for (const marker of devOnly) expect(development).toContain(marker);
    for (const marker of devOnly) expect(production).not.toContain(marker);
    expect(production.length).toBeLessThan(2048);

    const module = { exports: {} as { Variants: typeof Variants } };
    const modules: Record<string, unknown> = { react: React, "react/jsx-runtime": JsxRuntime };
    const evaluate = runInThisContext(`(function (require, module, exports) {${production}\n})`) as (
      require: (id: string) => unknown, target: typeof module, exports: object,
    ) => void;
    evaluate((id) => modules[id], module, module.exports);
    const { Variants: BuiltVariants } = module.exports;
    // The bundle ignores the runtime NODE_ENV: a development render would add boundary templates.
    vi.stubEnv("NODE_ENV", "development");
    const versions = { v1: <p>Plan one</p>, v2: <p>Plan two</p> };
    expect(renderToStaticMarkup(<BuiltVariants slot="pricing" versions={versions} default="v1" />)).toBe("<p>Plan one</p>");
    expect(PAGE_API_GLOBAL in globalThis).toBe(false);
  });
});
