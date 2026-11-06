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
//   Server-renders each job's `entry` with `props` (and `idPrefix`, if any), as a server whose NODE_ENV is the job's `nodeEnv` does,
//   and prints the bodies as a JSON array in job order.
//
// node bundle.mjs vite <entries JSON>
//   Builds a production page that mounts each entry with Vite's default settings and prints its JavaScript
//   as a JSON array in entry order.
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
    const moduleKey = ({ entry, nodeEnv }) => JSON.stringify([entry, nodeEnv]);
    const keys = [...new Set(jobs.map(moduleKey))];
    // Bundling and importing read no NODE_ENV, so every module loads at once; rendering below does not.
    const loaded = await Promise.all(keys.map((key, index) => {
      const [entry, nodeEnv] = JSON.parse(key);
      return serverModule(directory, entry, nodeEnv, index);
    }));
    const modules = new Map(keys.map((key, index) => [key, loaded[index]]));
    return jobs.map((job) => {
      const server = modules.get(moduleKey(job));
      // An unreplaced bundle reads NODE_ENV while rendering, so each job renders alone with its own.
      process.env.NODE_ENV = job.nodeEnv;
      return server.render(server.default, { props: job.props, idPrefix: job.idPrefix }).body;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Builds a page that mounts each entry with Vite's own defaults (Rollup tree-shaking, esbuild minification,
 * `process.env.NODE_ENV` replaced) in production mode, bundling Svelte's runtime as an app does.
 */
async function viteBuild(entries) {
  // As `vite build` runs from a shell: Vite then sets NODE_ENV to production itself; the test runner's would win.
  delete process.env.NODE_ENV;
  const [{ build }, { svelte }] = await Promise.all([import("vite"), import("@sveltejs/vite-plugin-svelte")]);
  return Promise.all(entries.map(async (entry) => {
    const page = "\0iterbar-page.js";
    const output = await build({
      configFile: false,
      root: process.cwd(),
      mode: "production",
      logLevel: "silent",
      plugins: [
        svelte({ configFile: false }),
        {
          name: "iterbar-page",
          resolveId: (id) => (id === "iterbar:page" ? page : null),
          load: (id) => (id === page
            ? `import { mount } from "svelte"; import Entry from ${JSON.stringify(resolve(entry))}; mount(Entry, { target: document.body });`
            : null),
        },
      ],
      build: { write: false, rollupOptions: { input: "iterbar:page" } },
    });
    return output.output.filter((file) => file.type === "chunk").map((chunk) => chunk.code).join("\n");
  }));
}

const [mode, input] = process.argv.slice(2);
const options = JSON.parse(input);
const commands = {
  bundle: async () => browserBundle(options),
  render: async () => JSON.stringify(await serverRender(options)),
  vite: async () => JSON.stringify(await viteBuild(options)),
};
process.stdout.write(await commands[mode]());
