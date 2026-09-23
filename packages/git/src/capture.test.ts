import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { chmodSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { captureReview, parseNameStatus } from "./capture.js";
import { runProcess } from "./process.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 50,
  })));
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
  it.skipIf(process.platform === "win32")("captures legal POSIX filenames in every scope", async () => {
    const repository = await createRepository();
    const filePath = "odd\\name\r\n.ts";
    await writeFile(join(repository, filePath), "export const value = 1;\n");
    await runProcess("git", ["add", "--", filePath], repository);
    await runProcess("git", ["commit", "-m", "add unusual path"], repository);
    await writeFile(join(repository, filePath), "export const value = 2;\n");

    const worktree = await captureReview({ type: "worktree", repository });
    await runProcess("git", ["add", "--", filePath], repository);
    const staged = await captureReview({ type: "staged", repository });
    await runProcess("git", ["commit", "-m", "change unusual path"], repository);
    const range = await captureReview({ type: "range", repository, expression: "HEAD~1..HEAD" });
    const snapshot = await captureReview({ type: "repository", repository, ref: "HEAD" });

    for (const captured of [worktree, staged, range, snapshot]) {
      const file = captured.files.find((item) => item.filePath === filePath);
      expect(file?.afterContent?.toString("utf8")).toBe("export const value = 2;\n");
      expect(file?.items.length).toBeGreaterThan(0);
    }
  });

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

  it.each(["repository", "staged", "range"] as const)("skips gitlinks without losing reviewable %s content", async (type) => {
    const repository = await createRepository();
    await writeFile(join(repository, "alpha.ts"), "export const alpha = 2;\n");
    await runProcess("git", ["add", "alpha.ts"], repository);
    await runProcess("git", ["update-index", "--add", "--cacheinfo", `160000,${"a".repeat(40)},deps/lib`], repository);
    if (type === "repository" || type === "range") await runProcess("git", ["commit", "-m", "change with gitlink"], repository);
    const request = type === "range"
      ? { type, repository, expression: "HEAD~1..HEAD" }
      : { type, repository };

    const captured = await captureReview(request);
    expect(captured.files.map((file) => file.filePath)).toContain("alpha.ts");
    expect(captured.files.map((file) => file.filePath)).not.toContain("deps/lib");
    expect(captured.skipped).toContainEqual({ filePath: "deps/lib", reason: "git submodule (gitlink)" });
  });

  it("skips a changed worktree submodule without opening its directory", async () => {
    const repository = await createRepository();
    const submodule = join(repository, "deps", "lib");
    await mkdir(submodule, { recursive: true });
    await runProcess("git", ["init", "-b", "main"], submodule);
    await runProcess("git", ["config", "user.email", "diffpanel@example.com"], submodule);
    await runProcess("git", ["config", "user.name", "Diffpanel Test"], submodule);
    await writeFile(join(submodule, "value.ts"), "export const value = 1;\n");
    await runProcess("git", ["add", "value.ts"], submodule);
    await runProcess("git", ["commit", "-m", "submodule initial"], submodule);
    await runProcess("git", ["add", "deps/lib"], repository);
    await runProcess("git", ["commit", "-m", "add gitlink"], repository);
    await writeFile(join(submodule, "value.ts"), "export const value = 2;\n");
    await runProcess("git", ["commit", "-am", "submodule change"], submodule);
    await writeFile(join(repository, "alpha.ts"), "export const alpha = 2;\n");

    const captured = await captureReview({ type: "worktree", repository });
    expect(captured.files.map((file) => file.filePath)).toEqual(["alpha.ts"]);
    expect(captured.skipped).toContainEqual({ filePath: "deps/lib", reason: "git submodule (gitlink)" });
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

  it("rejects an intermediate directory replaced by a symlink during capture", async () => {
    const repository = await createRepository();
    const outside = await mkdtemp(join(tmpdir(), "diffpanel-parent-symlink-"));
    temporaryDirectories.push(outside);
    await mkdir(join(repository, "nested"));
    await writeFile(join(repository, "nested", "value.ts"), "export const value = 'inside';\n");
    await runProcess("git", ["add", "nested/value.ts"], repository);
    await runProcess("git", ["commit", "-m", "nested file"], repository);
    await writeFile(join(repository, "nested", "value.ts"), "export const value = 'changed';\n");
    await writeFile(join(outside, "value.ts"), "outside secret\n");
    let replaced = false;

    await expect(captureReview({ type: "worktree", repository }, {
      onProgress(progress) {
        if (progress.phase === "capture" && progress.filePath === "nested/value.ts" && !replaced) {
          replaced = true;
          rmSync(join(repository, "nested"), { recursive: true, force: true });
          symlinkSync(outside, join(repository, "nested"));
        }
      },
    })).rejects.toThrow(/symbolic-link parent/);
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

  it("retries when worktree metadata or skipped-file classification changes", async () => {
    const repository = await createRepository();
    await runProcess("git", ["config", "core.filemode", "true"], repository);
    await writeFile(join(repository, "beta.ts"), "export const beta = 2;\n");
    await writeFile(join(repository, "changing.dat"), Buffer.from([0, 1, 2]));
    let changed = false;
    const captured = await captureReview({ type: "worktree", repository }, {
      onProgress(progress) {
        if (progress.phase === "verify" && !changed) {
          changed = true;
          writeFileSync(join(repository, "changing.dat"), "now reviewable\n");
          chmodSync(join(repository, "alpha.ts"), 0o755);
        }
      },
    });
    expect(captured.files.map((file) => file.filePath)).toContain("changing.dat");
    expect(captured.files.find((file) => file.filePath === "alpha.ts")?.items[0]?.patch).toContain("new mode 100755");
  });

  it("counts only captured files against the file limit", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "aaa.dat"), Buffer.from([0, 1, 2]));
    await writeFile(join(repository, "beta.ts"), "export const beta = 2;\n");
    const captured = await captureReview({ type: "worktree", repository }, { limits: { maxFiles: 1 } });
    expect(captured.files.map((file) => file.filePath)).toEqual(["beta.ts"]);
    expect(captured.skipped).toContainEqual({ filePath: "aaa.dat", reason: "binary file" });
  });

  it.skipIf(process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0))("rejects oversized worktree files before reading their contents", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "alpha.ts"), "export const alpha = 2;\n");
    const oversized = join(repository, "oversized.txt");
    await writeFile(oversized, "x".repeat(1_024));
    await chmod(oversized, 0o000);
    try {
      const captured = await captureReview(
        { type: "worktree", repository },
        { limits: { maxFileBytes: 64 } },
      );
      expect(captured.files.map((file) => file.filePath)).toEqual(["alpha.ts"]);
      expect(captured.skipped).toContainEqual({ filePath: "oversized.txt", reason: "file exceeds 64 bytes" });
    } finally {
      await chmod(oversized, 0o600);
    }
  });

  it.skipIf(process.platform === "win32")("skips oversized symlink targets while retaining reviewable files", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "alpha.ts"), "export const alpha = 2;\n");
    await symlink("é".repeat(40), join(repository, "link.ts"));

    const captured = await captureReview({ type: "worktree", repository }, { limits: { maxFileBytes: 64 } });
    expect(captured.files.map((file) => file.filePath)).toEqual(["alpha.ts"]);
    expect(captured.skipped).toContainEqual({ filePath: "link.ts", reason: "file exceeds 64 bytes" });
  });

  it("anchors staged captures to an immutable index tree", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "alpha.ts"), "export const alpha = 2;\n");
    await runProcess("git", ["add", "alpha.ts"], repository);
    const captured = await captureReview({ type: "staged", repository });
    expect(captured.scope).toMatchObject({ type: "staged", indexSha: expect.stringMatching(/^[a-f0-9]{40}$/) });
    expect(captured.files[0]?.afterContent?.toString("utf8")).toContain("alpha = 2");
  });

  it("falls back to the live index only for confirmed unmerged entries", async () => {
    const repository = await createRepository();
    await runProcess("git", ["checkout", "-b", "side"], repository);
    await writeFile(join(repository, "alpha.ts"), "export const alpha = 'side';\n");
    await runProcess("git", ["commit", "-am", "side"], repository);
    await runProcess("git", ["checkout", "main"], repository);
    await writeFile(join(repository, "alpha.ts"), "export const alpha = 'main';\n");
    await runProcess("git", ["commit", "-am", "main"], repository);
    await runProcess("git", ["merge", "side"], repository, { acceptedExitCodes: [0, 1] });
    const captured = await captureReview({ type: "staged", repository });
    expect(captured.scope).not.toHaveProperty("indexSha");
    expect(captured.files[0]?.status).toBe("unmerged");
  });

  it("retries when a conflicted index is resolved during capture", async () => {
    const repository = await createRepository();
    await runProcess("git", ["checkout", "-b", "side"], repository);
    await writeFile(join(repository, "alpha.ts"), "export const alpha = 'side';\n");
    await runProcess("git", ["commit", "-am", "side"], repository);
    await runProcess("git", ["checkout", "main"], repository);
    await writeFile(join(repository, "alpha.ts"), "export const alpha = 'main';\n");
    await runProcess("git", ["commit", "-am", "main"], repository);
    await runProcess("git", ["merge", "side"], repository, { acceptedExitCodes: [0, 1] });
    let resolved = false;

    const captured = await captureReview({ type: "staged", repository }, {
      onProgress(progress) {
        if (progress.phase !== "verify" || resolved) return;
        resolved = true;
        writeFileSync(join(repository, "alpha.ts"), "export const alpha = 'resolved';\n");
        execFileSync("git", ["add", "alpha.ts"], { cwd: repository });
      },
    });

    expect(captured.scope).toMatchObject({ type: "staged", indexSha: expect.stringMatching(/^[a-f0-9]{40}$/) });
    expect(captured.files[0]).toMatchObject({ status: "modified" });
    expect(captured.files[0]?.afterContent?.toString("utf8")).toContain("alpha = 'resolved'");
    expect(captured.files[0]?.items[0]?.patch).toContain("+export const alpha = 'resolved'");
  });

  it("retries when a conflicted path is resolved by deletion during capture", async () => {
    const repository = await createRepository();
    await runProcess("git", ["checkout", "-b", "side"], repository);
    await writeFile(join(repository, "alpha.ts"), "export const alpha = 'side';\n");
    await runProcess("git", ["commit", "-am", "side"], repository);
    await runProcess("git", ["checkout", "main"], repository);
    await writeFile(join(repository, "alpha.ts"), "export const alpha = 'main';\n");
    await runProcess("git", ["commit", "-am", "main"], repository);
    await runProcess("git", ["merge", "side"], repository, { acceptedExitCodes: [0, 1] });
    let resolved = false;

    const captured = await captureReview({ type: "staged", repository }, {
      onProgress(progress) {
        if (progress.phase !== "capture" || resolved) return;
        resolved = true;
        execFileSync("git", ["rm", "alpha.ts"], { cwd: repository });
      },
    });

    expect(captured.scope).toMatchObject({ type: "staged", indexSha: expect.stringMatching(/^[a-f0-9]{40}$/) });
    expect(captured.files[0]).toMatchObject({ status: "deleted", filePath: "alpha.ts", afterContent: null });
    expect(captured.files[0]?.items[0]?.patch).toContain("-export const alpha = 'main'");
  });

  it("captures a small conflict without serializing unrelated index entries into the process output budget", async () => {
    const repository = await createRepository();
    for (let index = 0; index < 40; index += 1) {
      await writeFile(join(repository, `unrelated-${index}.ts`), `export const value = ${index};\n`);
    }
    await runProcess("git", ["add", "--", ...Array.from({ length: 40 }, (_, index) => `unrelated-${index}.ts`)], repository);
    await runProcess("git", ["commit", "-m", "unrelated files"], repository);
    await runProcess("git", ["checkout", "-b", "side"], repository);
    await writeFile(join(repository, "alpha.ts"), "export const alpha = 'side';\n");
    await runProcess("git", ["commit", "-am", "side"], repository);
    await runProcess("git", ["checkout", "main"], repository);
    await writeFile(join(repository, "alpha.ts"), "export const alpha = 'main';\n");
    await runProcess("git", ["commit", "-am", "main"], repository);
    await runProcess("git", ["merge", "side"], repository, { acceptedExitCodes: [0, 1] });

    expect((await runProcess("git", ["ls-files", "--stage", "-z"], repository)).stdout.length).toBeGreaterThan(1_024);
    const captured = await captureReview({ type: "staged", repository }, { limits: { maxProcessOutputBytes: 1_024 } });
    expect(captured.scope).not.toHaveProperty("indexSha");
    expect(captured.files.find((file) => file.filePath === "alpha.ts")?.status).toBe("unmerged");
    expect(captured.files).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")("checks for unmerged entries before attempting write-tree", async () => {
    const repository = await createRepository();
    await runProcess("git", ["checkout", "-b", "side"], repository);
    await writeFile(join(repository, "alpha.ts"), "export const alpha = 'side';\n");
    await runProcess("git", ["commit", "-am", "side"], repository);
    await runProcess("git", ["checkout", "main"], repository);
    await writeFile(join(repository, "alpha.ts"), "export const alpha = 'main';\n");
    await runProcess("git", ["commit", "-am", "main"], repository);
    await runProcess("git", ["merge", "side"], repository, { acceptedExitCodes: [0, 1] });

    const wrapperDirectory = await mkdtemp(join(tmpdir(), "diffpanel-git-wrapper-"));
    temporaryDirectories.push(wrapperDirectory);
    const marker = join(wrapperDirectory, "write-tree-invoked");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const wrapper = join(wrapperDirectory, "git");
    await writeFile(wrapper, [
      "#!/usr/bin/env node",
      "const { spawnSync } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      `if (process.argv[2] === 'write-tree') { writeFileSync(${JSON.stringify(marker)}, ''); process.exit(1); }`,
      `const result = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: 'inherit' });`,
      "process.exit(result.status ?? 1);",
    ].join("\n"));
    await chmod(wrapper, 0o755);

    const previousPath = process.env.PATH;
    process.env.PATH = `${wrapperDirectory}:${previousPath ?? ""}`;
    try {
      const captured = await captureReview({ type: "staged", repository });
      expect(captured.files[0]?.status).toBe("unmerged");
      await expect(access(marker)).rejects.toThrow();
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("propagates process output limits instead of treating failures as missing objects", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "alpha.ts"), `export const alpha = "${"x".repeat(1_000)}";\n`);
    await runProcess("git", ["add", "alpha.ts"], repository);
    await expect(captureReview(
      { type: "staged", repository },
      { limits: { maxProcessOutputBytes: 200 } },
    )).rejects.toThrow(/output limit/);
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

  it("honors cancellation before the verification capture", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "untracked.ts"), "export const untracked = true;\n");
    const controller = new AbortController();
    await expect(captureReview({ type: "worktree", repository }, {
      signal: controller.signal,
      onProgress(progress) {
        if (progress.phase === "verify") controller.abort();
      },
    })).rejects.toThrow(/cancelled/);
  });

  it.each(["staged", "range"] as const)("honors cancellation at the immutable %s capture return boundary", async (type) => {
    const repository = await createRepository();
    await writeFile(join(repository, "alpha.ts"), "export const alpha = 2;\n");
    await runProcess("git", ["add", "alpha.ts"], repository);
    if (type === "range") await runProcess("git", ["commit", "-m", "change"], repository);
    const request = type === "range"
      ? { type, repository, expression: "HEAD~1..HEAD" }
      : { type, repository };
    const controller = new AbortController();

    await expect(captureReview(request, {
      signal: controller.signal,
      onProgress(progress) {
        if (progress.phase === "verify") controller.abort();
      },
    })).rejects.toThrow(/cancelled/);
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
