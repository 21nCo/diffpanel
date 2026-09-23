import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const npmCli = resolve(dirname(process.execPath), process.platform === "win32"
  ? "node_modules/npm/bin/npm-cli.js"
  : "../lib/node_modules/npm/bin/npm-cli.js");
assert(existsSync(npmCli), `npm CLI is unavailable beside Node: ${npmCli}`);
const temporaryRoot = await mkdtemp(join(tmpdir(), "diffpanel-consumer-"));
const packDirectory = join(temporaryRoot, "packs");
const consumerDirectory = join(temporaryRoot, "consumer");
const repository = join(temporaryRoot, "repository");
const home = join(temporaryRoot, "home");
const packagePaths = [
  "packages/core",
  "packages/generation",
  "packages/git",
  "packages/presentation",
  "packages/storage",
];

try {
  await Promise.all([packDirectory, consumerDirectory, repository].map((directory) => mkdir(directory, { recursive: true })));
  const tarballs = packagePaths.map((packagePath) => {
    const output = execFileSync(
      process.execPath,
      [npmCli, "pack", "--json", "--pack-destination", packDirectory],
      { cwd: join(root, packagePath), encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
    const result = JSON.parse(output);
    assert.equal(result.length, 1, `${packagePath} must create one tarball`);
    const packedPaths = result[0].files.map((file) => file.path);
    assert(packedPaths.includes("package.json"), `${packagePath} must include package.json`);
    assert(packedPaths.includes("README.md"), `${packagePath} must include README.md`);
    assert(packedPaths.includes("LICENSE"), `${packagePath} must include LICENSE`);
    assert(packedPaths.some((file) => file.startsWith("dist/") && file.endsWith(".d.ts")), `${packagePath} must include declarations`);
    assert(!packedPaths.some((file) => file.startsWith("src/") || /(^|\/)\w+\.test\.[^.]+$/.test(file)), `${packagePath} must not include sources or tests`);
    return join(packDirectory, result[0].filename);
  });

  await writeFile(join(consumerDirectory, "package.json"), JSON.stringify({
    name: "diffpanel-external-consumer",
    private: true,
    type: "module",
  }, null, 2));
  execFileSync(
    process.execPath,
    [npmCli, "install", "--package-lock=false", "--no-audit", "--no-fund", ...tarballs],
    { cwd: consumerDirectory, stdio: "inherit" },
  );

  const consumerScript = `
    import assert from "node:assert/strict";
    import { execFileSync } from "node:child_process";
    import { readFile, writeFile } from "node:fs/promises";
    import { join } from "node:path";
    import { reviewManifestSchema } from "diffpanel";
    import { sha256 } from "diffpanel/node";
    import { formatGenerationInput, generationContract } from "@diffpanel/generation";
    import { captureReview } from "@diffpanel/git";
    import { chapterLabels } from "@diffpanel/presentation";
    import { DiffpanelStore } from "@diffpanel/storage";

    const repository = process.argv[2];
    const home = process.argv[3];
    const git = (...args) => execFileSync("git", args, { cwd: repository, stdio: "ignore" });
    git("init", "-b", "main");
    git("config", "user.email", "consumer@example.com");
    git("config", "user.name", "External Consumer");
    await writeFile(join(repository, "example.ts"), "export const value = 1;\\n");
    git("add", "example.ts");
    git("commit", "-m", "initial");

    await writeFile(join(repository, "example.ts"), "export const value = 2;\\n");
    const worktree = await captureReview({ type: "worktree", repository });
    assert.equal(worktree.files.length, 1);
    git("add", "example.ts");
    const staged = await captureReview({ type: "staged", repository });
    assert.match(staged.scope.indexSha, /^[a-f0-9]{40}$/);
    git("commit", "-m", "update");
    const range = await captureReview({ type: "range", repository, expression: "HEAD~1..HEAD" });
    assert.equal(range.files.length, 1);
    const snapshot = await captureReview({ type: "repository", repository, ref: "HEAD" });
    assert.equal(snapshot.files[0].items[0].kind, "file");

    const store = await DiffpanelStore.open(home);
    try {
      const receipt = await store.createPreparedRun(worktree, { title: "External consumer" });
      const stored = await store.getRun(receipt.runId);
      reviewManifestSchema.parse(stored.manifest);
      assert.match(formatGenerationInput(stored.manifest), /Provider-neutral generation contract/);
      assert.equal(generationContract.version, 1);
      assert.equal((await store.getFileContent(receipt.runId, stored.manifest.files[0].id, "after")).toString(), "export const value = 2;\\n");
      assert.equal(store.listRunsPage({ limit: 1 }).runs.length, 1);
    } finally {
      store.close();
    }

    const labels = chapterLabels([{ id: "root", parentId: null, order: 1, title: "Root", summary: "Root.", itemRefs: [], keyChanges: [] }]);
    assert.equal(labels.get("root"), "1");
    assert.equal(sha256("diffpanel").length, 64);
  `;
  const consumerScriptPath = join(consumerDirectory, "verify.mjs");
  await writeFile(consumerScriptPath, consumerScript);
  execFileSync(
    process.execPath,
    [consumerScriptPath, repository, home],
    { cwd: consumerDirectory, stdio: "inherit" },
  );
  execFileSync(process.execPath, [join(root, "scripts", "verify-browser-imports.mjs"), consumerDirectory], {
    cwd: consumerDirectory,
    stdio: "inherit",
  });
  assert.throws(() => execFileSync(
    process.execPath,
    [join(root, "scripts", "verify-browser-imports.mjs"), consumerDirectory, "--probe-node-global"],
    { cwd: consumerDirectory, stdio: "pipe" },
  ), /Browser bundle contains a Node\.js-only global/);

  const packedNames = tarballs.map((tarball) => tarball.slice(tarball.lastIndexOf("/") + 1));
  assert.equal(new Set(packedNames).size, packagePaths.length);
  const consumerPackage = await readFile(join(consumerDirectory, "package.json"), "utf8");
  assert.match(consumerPackage, /@diffpanel\/storage/);
  process.stdout.write("Published-package external consumer verified.\n");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
