import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await build({ entryPoints: ["src/server.ts"], outfile: "dist/server.js", bundle: true, packages: "external", platform: "node", format: "esm", sourcemap: true });
const ui = await build({ entryPoints: ["src/ui.tsx"], bundle: true, write: false, platform: "browser", format: "iife", target: "es2022", minify: true, metafile: true });
for (const input of Object.keys(ui.metafile.inputs)) {
  if (/packages\/(storage|git|generation)\/|better-sqlite3|node:|vscode\/src\/(?!webview\/)/.test(input)) throw new Error(`Node/host dependency in browser build: ${input}`);
}
const js = ui.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const css = await readFile("src/styles.css", "utf8");
await writeFile("dist/review.html", `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`);
await writeFile("dist/browser-metafile.json", JSON.stringify(ui.metafile, null, 2));
