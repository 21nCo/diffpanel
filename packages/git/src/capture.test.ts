import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
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

  it("rejects invalid repository snapshot limits", async () => {
    const repository = await createRepository();
    await expect(captureReview({ type: "repository", repository, maxFiles: 0 })).rejects.toThrow(/positive integer/);
  });

  it.each(["staged", "worktree", "range"] as const)("retains pure move evidence in %s captures", async (type) => {
    const repository = await createRepository();
    await runProcess("git", ["mv", "alpha.ts", "moved.ts"], repository);
    if (type === "range") await runProcess("git", ["commit", "-m", "move"], repository);
    const request = type === "range" ? { type, repository, expression: "HEAD~1..HEAD" } : { type, repository };
    const captured = await captureReview(request);
    expect(captured.skipped).toEqual([]);
    expect(captured.files).toHaveLength(1);
    const file = captured.files[0]!;
    expect(file).toMatchObject({ status: "renamed", oldPath: "alpha.ts", filePath: "moved.ts", additions: 0, deletions: 0 });
    expect(file.beforeContent?.equals(file.afterContent!)).toBe(true);
    expect(file.items).toHaveLength(1);
    expect(file.items[0]).toMatchObject({ kind: "file", status: "renamed", oldStart: null, newStart: null });
    expect(file.items[0]!.patch).toContain("rename from alpha.ts");
  });

  it("retains mode-only edits and distinguishes excluded binary content", async () => {
    const repository = await createRepository();
    await runProcess("git", ["config", "core.filemode", "true"], repository);
    await chmod(join(repository, "alpha.ts"), 0o755);
    await writeFile(join(repository, "binary.dat"), Buffer.from([0, 1, 2]));
    const captured = await captureReview({ type: "worktree", repository });
    expect(captured.files[0]!.items[0]!.kind).toBe("file");
    expect(captured.files[0]!.items[0]!.patch).toContain("new mode 100755");
    expect(captured.skipped).toEqual([{ filePath: "binary.dat", reason: "binary file" }]);
  });

  it("captures an empty-file move", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "empty.ts"), "");
    await runProcess("git", ["add", "empty.ts"], repository);
    await runProcess("git", ["commit", "-m", "empty file"], repository);
    await runProcess("git", ["mv", "empty.ts", "empty-moved.ts"], repository);
    const captured = await captureReview({ type: "staged", repository });
    expect(captured.files[0]).toMatchObject({ status: "renamed", beforeContent: Buffer.alloc(0), afterContent: Buffer.alloc(0) });
    expect(captured.files[0]!.items[0]!.kind).toBe("file");
  });

  it("captures a symlink target without following it outside the repository", async () => {
    const repository = await createRepository();
    const outside = await mkdtemp(join(tmpdir(), "diffpanel-outside-"));
    temporaryDirectories.push(outside);
    const secret = join(outside, "secret.ts");
    await writeFile(secret, "do not capture this content\n");
    await symlink(secret, join(repository, "linked.ts"));

    const captured = await captureReview({ type: "worktree", repository });
    const linked = captured.files.find((file) => file.filePath === "linked.ts");
    expect(linked?.afterContent?.toString("utf8")).toBe(secret);
    expect(linked?.afterContent?.toString("utf8")).not.toContain("do not capture");
  });

  it("retries when the worktree changes during capture", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "alpha.ts"), "export const alpha = 2;\n");
    let changed = false;
    const captured = await captureReview(
      { type: "worktree", repository },
      { onProgress(progress) {
        if (progress.phase === "verify" && !changed) {
          changed = true;
          writeFileSync(join(repository, "alpha.ts"), "export const alpha = 3;\n");
        }
      } },
    );
    expect(captured.files[0]?.afterContent?.toString("utf8")).toContain("alpha = 3");
  });

  it("anchors staged captures to an immutable index tree", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "alpha.ts"), "export const alpha = 2;\n");
    await runProcess("git", ["add", "alpha.ts"], repository);
    const captured = await captureReview({ type: "staged", repository });
    expect(captured.scope).toMatchObject({ type: "staged", indexSha: expect.stringMatching(/^[a-f0-9]{40}$/) });
    expect(captured.files[0]?.afterContent?.toString("utf8")).toContain("alpha = 2");
  });

  it("enforces aggregate capture budgets", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "alpha.ts"), "export const alpha = 2;\n");
    await writeFile(join(repository, "beta.ts"), "export const beta = 2;\n");
    const captured = await captureReview(
      { type: "worktree", repository },
      { limits: { maxTotalBytes: 55 } },
    );
    expect(captured.files).toHaveLength(1);
    expect(captured.skipped).toEqual([expect.objectContaining({ reason: expect.stringContaining("content limit") })]);
  });

  it("honors cancellation before spawning Git", async () => {
    const repository = await createRepository();
    const controller = new AbortController();
    controller.abort();
    await expect(captureReview({ type: "worktree", repository }, { signal: controller.signal })).rejects.toThrow(/cancelled/);
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

  it("rejects paths that escape the repository", () => {
    expect(() => parseNameStatus(Buffer.from("M\0../secret.ts\0"))).toThrow(/Unsafe repository path/);
  });
});
