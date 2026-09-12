import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const shared = {
  bundle: true,
  sourcemap: true,
  minify: false,
  logLevel: "info",
};

const extension = {
  ...shared,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  format: "cjs",
  platform: "node",
  target: "node20",
  external: ["vscode"],
};

const webview = {
  ...shared,
  entryPoints: ["src/webview/index.tsx"],
  outfile: "dist/webview.js",
  format: "iife",
  platform: "browser",
  target: "es2022",
};

const diagramEditor = { ...webview, entryPoints: ["src/webview/diagram-editor.tsx"], outfile: "dist/diagram-editor.js" };

if (watch) {
  const contexts = await Promise.all([esbuild.context(extension), esbuild.context(webview), esbuild.context(diagramEditor)]);
  await Promise.all(contexts.map((context) => context.watch()));
  console.log("Watching Diffpanel extension and webview...");
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(webview), esbuild.build(diagramEditor)]);
}
