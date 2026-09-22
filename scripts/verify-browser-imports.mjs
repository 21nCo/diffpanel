import { build } from "esbuild";

await build({
  stdin: {
    contents: [
      'import { reviewManifestSchema } from "./packages/core/dist/index.js";',
      'import { generationContract } from "./packages/generation/dist/index.js";',
      'import { chapterLabels } from "./packages/presentation/dist/index.js";',
      "void reviewManifestSchema;",
      "void generationContract;",
      "void chapterLabels;",
    ].join("\n"),
    loader: "js",
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  write: false,
  logLevel: "warning",
});

process.stdout.write("Browser-safe package imports verified.\n");
