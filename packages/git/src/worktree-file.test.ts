import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { readWorktreeFile, WorktreeFileTooLargeError } from "./worktree-file.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("readWorktreeFile", () => {
  it.skipIf(process.platform === "win32")("rejects a parent replacement between metadata inspection and descriptor open", async () => {
    const repository = await mkdtemp(join(tmpdir(), "diffpanel-descriptor-repo-"));
    const outside = await mkdtemp(join(tmpdir(), "diffpanel-descriptor-outside-"));
    temporaryDirectories.push(repository, outside);
    await mkdir(join(repository, "nested"));
    await writeFile(join(repository, "nested", "value.ts"), "inside\n");
    await writeFile(join(outside, "value.ts"), "outside secret\n");

    await expect(readWorktreeFile(repository, "nested/value.ts", 1_024, {
      async beforeOpen() {
        await rm(join(repository, "nested"), { recursive: true, force: true });
        await symlink(outside, join(repository, "nested"));
      },
    })).rejects.toThrow(/symbolic-link parent|changed during capture/);
  });

  it("bounds reads even when a file grows beyond its initial size", async () => {
    const repository = await mkdtemp(join(tmpdir(), "diffpanel-bounded-read-"));
    temporaryDirectories.push(repository);
    const file = join(repository, "value.ts");
    await writeFile(file, "small\n");

    await expect(readWorktreeFile(repository, "value.ts", 16, {
      async afterOpen() {
        await writeFile(file, "x".repeat(1_024));
      },
    })).rejects.toBeInstanceOf(WorktreeFileTooLargeError);
  });

  it.skipIf(process.platform === "win32")("bounds the UTF-8 bytes of a symlink target", async () => {
    const repository = await mkdtemp(join(tmpdir(), "diffpanel-bounded-link-"));
    temporaryDirectories.push(repository);
    await symlink("é".repeat(40), join(repository, "link.ts"));

    await expect(readWorktreeFile(repository, "link.ts", 64)).rejects.toBeInstanceOf(WorktreeFileTooLargeError);
  });
});
