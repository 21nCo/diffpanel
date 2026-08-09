import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { runProcess } from "@diffpanel/git";
import type { ReviewManifest } from "@diffpanel/core";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function runCli(args: string[], home: string, cwd: string): Promise<string> {
  const entry = resolve("dist/index.js");
  const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolvePromise, reject) => {
    const child = runProcess(process.execPath, [entry, ...args], cwd);
    child.then((value) => resolvePromise({
      stdout: value.stdout.toString("utf8"),
      stderr: value.stderr.toString("utf8"),
      code: value.exitCode,
    })).catch(reject);
  });
  expect(result.code, result.stderr).toBe(0);
  return result.stdout;
}

describe("diffpanel CLI", () => {
  it("prepares, validates, publishes, lists, and reads immutable content", async () => {
    const repository = await mkdtemp(join(tmpdir(), "diffpanel-cli-repo-"));
    const home = await mkdtemp(join(tmpdir(), "diffpanel-cli-home-"));
    temporaryDirectories.push(repository, home);
    await runProcess("git", ["init", "-b", "main"], repository);
    await runProcess("git", ["config", "user.email", "diffpanel@example.com"], repository);
    await runProcess("git", ["config", "user.name", "Diffpanel Test"], repository);
    await writeFile(join(repository, "example.ts"), "export const value = 1;\n");
    await runProcess("git", ["add", "example.ts"], repository);
    await runProcess("git", ["commit", "-m", "initial"], repository);
    await writeFile(join(repository, "example.ts"), "export const value = 2;\n");

    const previousHome = process.env.DIFFPANEL_HOME;
    process.env.DIFFPANEL_HOME = home;
    try {
      const receipt = JSON.parse(await runCli(["prep", "--worktree", "--repository", repository, "--json"], home, repository)) as {
        runId: string;
        manifestPath: string;
      };
      const manifest = JSON.parse(await readFile(receipt.manifestPath, "utf8")) as ReviewManifest;
      const itemRefs = manifest.files.flatMap((file) => file.items.map((item) => item.id));
      const reviewPath = join(home, "review.json");
      await writeFile(reviewPath, JSON.stringify({
        schemaVersion: 1,
        runId: receipt.runId,
        generator: "e2e",
        chapters: [{
          id: "chapter-1",
          parentId: null,
          order: 1,
          title: "Update the exported value",
          summary: "The exported value changes while preserving its public shape.",
          itemRefs,
          keyChanges: [],
        }],
        prologue: {
          motivation: null,
          outcome: "Consumers now receive the updated value.",
          diagram: null,
          keyChanges: [{ summary: "Consumers receive the revised exported value", description: "The module retains its existing export while changing the returned constant." }],
          focusAreas: [{ type: "testing-gap", severity: "info", title: "Consumer expectation coverage", description: "The exported value changed without a test update; confirm consumers expect the new value.", locations: ["example.ts"] }],
          complexity: { level: "low", reasoning: "One value changed in one file." },
        },
      }));

      expect(await runCli(["validate", reviewPath, "--run", receipt.runId], home, repository)).toContain("cover every item exactly once");
      expect(await runCli(["publish", reviewPath, "--run", receipt.runId], home, repository)).toContain("Published 1 chapters");
      const runs = JSON.parse(await runCli(["list", "--json"], home, repository)) as Array<{ status: string; runId: string }>;
      expect(runs).toEqual([expect.objectContaining({ runId: receipt.runId, status: "ready" })]);
      expect(await runCli(["archive", receipt.runId], home, repository)).toContain(`Archived ${receipt.runId}`);
      expect(JSON.parse(await runCli(["list", "--json"], home, repository))).toEqual([]);
      const archivedRuns = JSON.parse(await runCli(["list", "--include-archived", "--json"], home, repository)) as Array<{ archivedAt: string | null }>;
      expect(archivedRuns[0]?.archivedAt).not.toBeNull();
      expect(await runCli(["unarchive", receipt.runId], home, repository)).toContain(`Restored ${receipt.runId}`);
      const file = manifest.files[0]!;
      expect(await runCli(["content", receipt.runId, file.id, "after"], home, repository)).toContain("value = 2");
    } finally {
      if (previousHome === undefined) delete process.env.DIFFPANEL_HOME;
      else process.env.DIFFPANEL_HOME = previousHome;
    }
  });
});
