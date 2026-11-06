// Bundles Svelte components with esbuild the way a consumer's bundler does, in a child process: esbuild
// refuses to run under jsdom, whose Uint8Array belongs to another realm.
//
// node bundle.mjs bundle <options JSON>
//   Prints a minified CommonJS browser bundle of `entry`, with Svelte left external.
//   entry      file to bundle
//   dev        Svelte's development mode
//   nodeEnv    value that replaces process.env.NODE_ENV; "" leaves it unreplaced
//
// node bundle.mjs render <jobs JSON>
//   Server-renders each job's `entry` with `props`, as a server whose NODE_ENV is the job's `nodeEnv` does,
//   and prints the bodies as a JSON array in job order.
import { build } from "esbuild";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "svelte/compiler";

function sveltePlugin(generate, dev) {
  return {
    name: "svelte",
    setup(builder) {
      builder.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
        const source = await readFile(path, "utf8");
        const output = compile(source, { filename: relative(process.cwd(), path), generate, dev });
        return { contents: output.js.code, loader: "js", resolveDir: dirname(path) };
      });
    },
  };
}

function define(nodeEnv) {
  return nodeEnv ? { "process.env.NODE_ENV": JSON.stringify(nodeEnv) } : {};
}

async function browserBundle({ entry, dev, nodeEnv }) {
  const result = await build({
    entryPoints: [resolve(entry)],
    bundle: true,
    write: false,
    format: "cjs",
    // For the browser platform esbuild replaces NODE_ENV itself when minifying; "neutral" leaves it unreplaced.
    platform: nodeEnv ? "browser" : "neutral",
    minify: true,
    conditions: ["svelte", "browser", dev ? "development" : "production"],
    mainFields: ["svelte", "module", "main"],
    define: define(nodeEnv),
    external: ["svelte", "svelte/*"],
    plugins: [sveltePlugin("client", dev)],
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

/** Bundles `entry` with Svelte's server runtime into one module and imports it. */
async function serverModule(directory, entry, nodeEnv, index) {
  const result = await build({
    stdin: {
      contents: `export { render } from "svelte/server"; export { default } from ${JSON.stringify(resolve(entry))};`,
      resolveDir: process.cwd(),
      loader: "js",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    // Svelte's runtime picks its development mode from these conditions, as Vite sets them; it must match
    // the components' compiled mode.
    conditions: [nodeEnv === "development" ? "development" : "production"],
    define: define(nodeEnv),
    plugins: [sveltePlugin("server", nodeEnv === "development")],
    logLevel: "silent",
  });
  const file = join(directory, `server-${index}.mjs`);
  await writeFile(file, result.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

async function serverRender(jobs) {
  const directory = await mkdtemp(join(tmpdir(), "iterbar-svelte-ssr-"));
  try {
    const modules = new Map();
    const bodies = [];
    for (const { entry, nodeEnv, props } of jobs) {
      const key = JSON.stringify([entry, nodeEnv]);
      if (!modules.has(key)) modules.set(key, await serverModule(directory, entry, nodeEnv, modules.size));
      const server = modules.get(key);
      // An unreplaced bundle reads NODE_ENV while rendering.
      process.env.NODE_ENV = nodeEnv;
      bodies.push(server.render(server.default, { props }).body);
    }
    return bodies;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const [mode, input] = process.argv.slice(2);
const options = JSON.parse(input);
const output = mode === "render" ? JSON.stringify(await serverRender(options)) : await browserBundle(options);
process.stdout.write(output);
