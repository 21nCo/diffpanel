import { build } from "esbuild";
import { resolve } from "node:path";

const result = await build({
  stdin: {
    contents: [
      'import { reviewManifestSchema } from "diffpanel";',
      'import { generationContract } from "@diffpanel/generation";',
      'import { chapterLabels } from "@diffpanel/presentation";',
      "void reviewManifestSchema;",
      "void generationContract;",
      "void chapterLabels;",
    ].join("\n"),
    loader: "js",
    resolveDir: resolve(process.argv[2] ?? process.cwd()),
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  write: false,
  logLevel: "warning",
});

const bundled = result.outputFiles?.map((file) => file.text).join("\n") ?? "";
if (/\b(?:process|Buffer|global|__dirname|__filename)\s*[.[]/.test(bundled) || /(?:from|require\()\s*["']node:/.test(bundled)) {
  throw new Error("Browser bundle contains a Node.js-only global or built-in import.");
}

process.stdout.write("Browser-safe package imports verified.\n");
