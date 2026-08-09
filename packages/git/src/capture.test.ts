import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { captureReview, parseNameStatus } from "./capture.js";
import { runProcess } from "./process.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "diffpanel-git-"));
  temporaryDirectories.push(directory);
  await runProcess("git", ["init", "-b", "main"], directory);
  await runProcess("git", ["config", "user.email", "diffpanel@example.com"], directory);
  await runProcess("git", ["config", "user.name", "Diffpanel Test"], directory);
  await writeFile(join(directory, "alpha.ts"), "export const alpha = 1;\n");
  await runProcess("git", ["add", "alpha.ts"], directory);
  await runProcess("git", ["commit", "-m", "initial"], directory);
  return directory;
}

describe("captureReview", () => {
  it("captures tracked and untracked worktree changes", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "alpha.ts"), "export const alpha = 2;\n");
    await writeFile(join(repository, "beta.ts"), "export const beta = true;\n");

    const captured = await captureReview({ type: "worktree", repository });
    expect(captured.files.map((file) => file.filePath).sort()).toEqual(["alpha.ts", "beta.ts"]);
    expect(captured.files.flatMap((file) => file.items)).toHaveLength(2);
    expect((await readFile(join(repository, "alpha.ts"), "utf8"))).toContain("alpha = 2");
  });

  it("captures a repository snapshot", async () => {
    const repository = await createRepository();
    const captured = await captureReview({ type: "repository", repository, ref: "HEAD" });
    expect(captured.scope.type).toBe("repository");
    expect(captured.files[0]?.items[0]?.kind).toBe("file");
  });
});

describe("parseNameStatus", () => {
  it("parses ordinary and renamed entries", () => {
    const result = parseNameStatus(Buffer.from("M\0src/a.ts\0R100\0src/old.ts\0src/new.ts\0"));
    expect(result).toEqual([
      { status: "modified", oldPath: null, filePath: "src/a.ts" },
      { status: "renamed", oldPath: "src/old.ts", filePath: "src/new.ts" },
    ]);
  });
});

