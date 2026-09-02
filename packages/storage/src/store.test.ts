import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { CapturedReview } from "@diffpanel/git";
import { DiffpanelStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function capturedReview(): CapturedReview {
  return {
    repositoryId: "repo-1",
    repositoryRoot: "/tmp/example",
    repositoryName: "example",
    scope: { type: "worktree", baseRef: "HEAD", baseSha: "abc" },
    skipped: [],
    files: [{
      id: "file-1",
      filePath: "src/example.ts",
      oldPath: null,
      status: "modified",
      beforeContent: Buffer.from("before\n"),
      afterContent: Buffer.from("after\n"),
      additions: 1,
      deletions: 1,
      language: "typescript",
      size: 6,
      items: [{
        id: "item-1",
        kind: "hunk",
        filePath: "src/example.ts",
        oldPath: null,
        status: "modified",
        ordinal: 0,
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        patch: "@@ -1 +1 @@\n-before\n+after",
        contentHash: "hash",
      }],
    }],
  };
}

function generatedReview(runId: string) {
  return {
    schemaVersion: 1 as const,
    runId,
    generator: "test",
    chapters: [{ id: "chapter-1", order: 1, title: "Review the behavior", summary: "One coherent behavior changed.", itemRefs: ["item-1"], keyChanges: [] }],
    prologue: {
      motivation: null,
      outcome: null,
      diagram: null,
      keyChanges: [{ summary: "Behavior now follows the replacement", description: "The original value is replaced in one location." }],
      focusAreas: [{ type: "testing-gap" as const, severity: "info" as const, title: "Focused test coverage", description: "The behavior changed without accompanying tests; confirm existing coverage is sufficient.", locations: ["src/example.ts"] }],
      complexity: { level: "low" as const, reasoning: "One small file changed." },
    },
  };
}

describe("DiffpanelStore", () => {
  it("opens the legacy database filename when it is the only existing store", async () => {
    const home = await mkdtemp(join(tmpdir(), "diffpanel-legacy-store-"));
    temporaryDirectories.push(home);
    const legacyDatabase = join(home, "conductor.sqlite3");
    await writeFile(legacyDatabase, "");

    const store = await DiffpanelStore.open(home);
    expect(store.databasePath).toBe(legacyDatabase);
    store.close();
  });

  it("persists prepared and published runs", async () => {
    const home = await mkdtemp(join(tmpdir(), "diffpanel-store-"));
    temporaryDirectories.push(home);
    const store = await DiffpanelStore.open(home);
    const receipt = await store.createPreparedRun(capturedReview());
    expect(store.listRuns()).toHaveLength(1);
    expect((await store.getRun(receipt.runId)).review).toBeNull();

    await store.publish(receipt.runId, generatedReview(receipt.runId));
    const stored = await store.getRun(receipt.runId);
    expect(stored.summary.status).toBe("ready");
    expect(stored.summary.archivedAt).toBeNull();
    expect(stored.summary.reviewTitle).toBe("Working tree");
    expect(stored.review?.chapters[0]?.itemRefs).toEqual(["item-1"]);

    const archived = store.setArchived(receipt.runId, true);
    expect(archived.archivedAt).not.toBeNull();
    expect(store.listRuns()).toEqual([]);
    expect(store.listRuns(undefined, true)).toHaveLength(1);
    expect(store.setArchived(receipt.runId, false).archivedAt).toBeNull();
    expect(store.listRuns()).toHaveLength(1);
    store.close();
  });

  it("stores custom review titles from prep, publish, and rename", async () => {
    const home = await mkdtemp(join(tmpdir(), "diffpanel-title-store-"));
    temporaryDirectories.push(home);
    const store = await DiffpanelStore.open(home);
    const receipt = await store.createPreparedRun(capturedReview(), { title: "  Account runtime  " });
    expect(receipt.title).toBe("Account runtime");
    expect(receipt.reviewTitle).toBe("Account runtime");
    expect(store.listRuns()[0]?.reviewTitle).toBe("Account runtime");

    await store.publish(receipt.runId, {
      ...generatedReview(receipt.runId),
      title: "AuthFn account runtime",
    });
    expect((await store.getRun(receipt.runId)).summary.reviewTitle).toBe("AuthFn account runtime");

    expect(store.setReviewTitle(receipt.runId, "PR 569 account runtime").reviewTitle).toBe("PR 569 account runtime");
    expect(store.setReviewTitle(receipt.runId, null).reviewTitle).toBe("Working tree");
    store.close();
  });
});
