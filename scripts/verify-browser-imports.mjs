import { build } from "esbuild";
import { resolve } from "node:path";

const probeNodeGlobal = process.argv.includes("--probe-node-global");
const forbiddenGlobals = {
  process: "__DIFFPANEL_FORBIDDEN_PROCESS__",
  Buffer: "__DIFFPANEL_FORBIDDEN_BUFFER__",
  global: "__DIFFPANEL_FORBIDDEN_GLOBAL__",
  __dirname: "__DIFFPANEL_FORBIDDEN_DIRNAME__",
  __filename: "__DIFFPANEL_FORBIDDEN_FILENAME__",
};
const result = await build({
  stdin: {
    contents: [
      'import { reviewManifestSchema } from "diffpanel";',
      'import { generationContract } from "@diffpanel/generation";',
      'import { chapterLabels } from "@diffpanel/presentation";',
      "globalThis.__diffpanelBrowserVerification = [reviewManifestSchema, generationContract, chapterLabels];",
      ...(probeNodeGlobal ? ["globalThis.__diffpanelProbe = process;"] : []),
    ].join("\n"),
    loader: "js",
    resolveDir: resolve(process.argv[2] ?? process.cwd()),
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  define: forbiddenGlobals,
  write: false,
  logLevel: "warning",
});

const bundled = result.outputFiles?.map((file) => file.text).join("\n") ?? "";
if (Object.values(forbiddenGlobals).some((sentinel) => bundled.includes(sentinel))
  || /(?:from|require\()\s*["']node:/.test(bundled)) {
  throw new Error("Browser bundle contains a Node.js-only global or built-in import.");
}

process.stdout.write("Browser-safe package imports verified.\n");
