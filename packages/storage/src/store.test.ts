import { access, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
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
    diagramAssessment: { kind: "other" as const, reasoning: "One local value edit.", overviewOmissionReason: "No ownership or flow changes to draw." },
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
    expect(store.databasePath).toBe(join(await realpath(home), "conductor.sqlite3"));
    store.close();
  });

  it("persists prepared and published runs", async () => {
    const home = await mkdtemp(join(tmpdir(), "diffpanel-store-"));
    temporaryDirectories.push(home);
    const store = await DiffpanelStore.open(home);
    const receipt = await store.createPreparedRun(capturedReview());
    expect(store.listRuns()).toHaveLength(1);
    expect((await store.getRun(receipt.runId)).review).toBeNull();
    expect((await store.getRun(receipt.runId)).manifest.requirements).toEqual({ diagramAssessment: true });
    expect(await readFile(receipt.generationInputPath, "utf8")).toContain("## Required visual assessment");

    await store.publish(receipt.runId, generatedReview(receipt.runId));
    const stored = await store.getRun(receipt.runId);
    expect(stored.summary.status).toBe("ready");
    expect(stored.summary.archivedAt).toBeNull();
    expect(stored.summary.reviewTitle).toBe("Working tree");
    expect(stored.review?.chapters[0]?.itemRefs).toEqual(["item-1"]);

    const archived = await store.setArchived(receipt.runId, true);
    expect(archived.archivedAt).not.toBeNull();
    expect(store.listRuns()).toEqual([]);
    expect(store.listRuns(undefined, true)).toHaveLength(1);
    expect((await store.setArchived(receipt.runId, false)).archivedAt).toBeNull();
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

    expect((await store.setReviewTitle(receipt.runId, "PR 569 account runtime")).reviewTitle).toBe("PR 569 account runtime");
    expect((await store.setReviewTitle(receipt.runId, null)).reviewTitle).toBe("Working tree");
    store.close();
  });

  it("does not report a setter update committed when another operation rolls back", async () => {
    const home = await mkdtemp(join(tmpdir(), "diffpanel-setter-rollback-"));
    temporaryDirectories.push(home);
    const store = await DiffpanelStore.open(home);
    try {
      const receipt = await store.createPreparedRun(capturedReview());
      let entered!: () => void;
      let release!: () => void;
      const transactionEntered = new Promise<void>((resolvePromise) => { entered = resolvePromise; });
      const holdTransaction = new Promise<void>((resolvePromise) => { release = resolvePromise; });
      const maintenance = store as unknown as {
        withMaintenanceLock<T>(operation: () => Promise<T>): Promise<T>;
      };
      const failedOperation = maintenance.withMaintenanceLock(async () => {
        entered();
        await holdTransaction;
        throw new Error("simulated maintenance failure");
      });
      const failedAssertion = expect(failedOperation).rejects.toThrow(/simulated maintenance failure/);
      await transactionEntered;
      const setter = store.setArchived(receipt.runId, true);
      release();
      await failedAssertion;
      expect((await setter).archivedAt).not.toBeNull();
      expect(store.listRuns()).toEqual([]);
    } finally { store.close(); }
  });

  it("queues a second connection's setter behind in-process maintenance", async () => {
    const home = await mkdtemp(join(tmpdir(), "diffpanel-setter-queue-"));
    temporaryDirectories.push(home);
    const first = await DiffpanelStore.open(home);
    const second = await DiffpanelStore.open(home, { recover: false });
    try {
      const receipt = await first.createPreparedRun(capturedReview());
      let entered!: () => void;
      let release!: () => void;
      const transactionEntered = new Promise<void>((resolvePromise) => { entered = resolvePromise; });
      const holdTransaction = new Promise<void>((resolvePromise) => { release = resolvePromise; });
      const maintenance = first as unknown as {
        withMaintenanceLock<T>(operation: () => Promise<T>): Promise<T>;
      };
      const pending = maintenance.withMaintenanceLock(async () => {
        entered();
        await holdTransaction;
      });
      await transactionEntered;
      (second as unknown as { database: Database.Database }).database.pragma("busy_timeout = 100");
      const setter = second.setReviewTitle(receipt.runId, "Queued title");
      release();
      await pending;
      expect((await setter).reviewTitle).toBe("Queued title");
      expect(first.listRuns()[0]?.reviewTitle).toBe("Queued title");
    } finally { first.close(); second.close(); }
  });

  it("queues a new store open behind in-process maintenance", async () => {
    const home = await mkdtemp(join(tmpdir(), "diffpanel-open-queue-"));
    temporaryDirectories.push(home);
    const first = await DiffpanelStore.open(home);
    let second: DiffpanelStore | undefined;
    let release!: () => void;
    let entered!: () => void;
    const transactionEntered = new Promise<void>((resolvePromise) => { entered = resolvePromise; });
    const holdTransaction = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const maintenance = first as unknown as {
      withMaintenanceLock<T>(operation: () => Promise<T>): Promise<T>;
    };
    const pending = maintenance.withMaintenanceLock(async () => {
      entered();
      await holdTransaction;
    });
    await transactionEntered;
    const releaseTimer = setTimeout(release, 250);
    try {
      second = await DiffpanelStore.open(home, { recover: false });
      await pending;
      const receipt = await second.createPreparedRun(capturedReview());
      expect(first.listRuns()[0]?.runId).toBe(receipt.runId);
    } finally {
      clearTimeout(releaseTimer);
      release();
      await pending;
      second?.close();
      first.close();
    }
  });

  it("persists empty-file move evidence and its zero-byte content hashes", async () => {
    const home = await mkdtemp(join(tmpdir(), "diffpanel-empty-move-"));
    temporaryDirectories.push(home);
    const store = await DiffpanelStore.open(home);
    try {
      const captured = capturedReview();
      const file = captured.files[0]!;
      file.oldPath = "old/example.ts";
      file.status = "renamed";
      file.beforeContent = file.afterContent = Buffer.alloc(0);
      file.additions = file.deletions = file.size = 0;
      file.items = [{ ...file.items[0]!, kind: "file", status: "renamed", oldPath: file.oldPath,
        oldStart: null, oldLines: null, newStart: null, newLines: null, patch: "rename from old/example.ts\nrename to src/example.ts" }];
      const receipt = await store.createPreparedRun(captured);
      const stored = await store.getRun(receipt.runId);
      expect(stored.manifest.files[0]!.beforeBlob).not.toBeNull();
      expect(stored.manifest.files[0]!.beforeBlob).toBe(stored.manifest.files[0]!.afterBlob);
      await store.publish(receipt.runId, generatedReview(receipt.runId));
      expect((await store.getRun(receipt.runId)).review?.chapters[0]!.itemRefs).toEqual(["item-1"]);
    } finally { store.close(); }
  });

  it("paginates runs with stable cursors", async () => {
    const home = await mkdtemp(join(tmpdir(), "diffpanel-pages-"));
    temporaryDirectories.push(home);
    const store = await DiffpanelStore.open(home);
    try {
      for (let index = 0; index < 3; index += 1) await store.createPreparedRun(capturedReview(), { title: `Run ${index}` });
      const first = store.listRunsPage({ limit: 2 });
      const second = store.listRunsPage({ limit: 2, cursor: first.nextCursor! });
      expect(first.runs).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      expect(second.runs).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      expect(new Set([...first.runs, ...second.runs].map((run) => run.runId)).size).toBe(3);
      expect(() => store.listRunsPage({ limit: 201 })).toThrow(/between 1 and 200/);
      expect(() => store.listRunsPage({ cursor: "not-a-cursor" })).toThrow(/Invalid run-list cursor/);
    } finally { store.close(); }
  });

  it("keeps the legacy list-all API exhaustive beyond one page", async () => {
    const home = await mkdtemp(join(tmpdir(), "diffpanel-list-all-"));
    temporaryDirectories.push(home);
    const store = await DiffpanelStore.open(home);
    try {
      for (let index = 0; index < 205; index += 1) {
        await store.createPreparedRun({ ...capturedReview(), repositoryId: `repo-${index}` });
      }
      expect(store.listRuns(undefined, true)).toHaveLength(205);
    } finally { store.close(); }
  });

  it("authorizes blob reads through a referencing run", async () => {
    const home = await mkdtemp(join(tmpdir(), "diffpanel-blob-auth-"));
    temporaryDirectories.push(home);
    const store = await DiffpanelStore.open(home);
    try {
      const first = await store.createPreparedRun(capturedReview());
      const second = await store.createPreparedRun({ ...capturedReview(), repositoryId: "repo-2" });
      const run = await store.getRun(first.runId);
      const hash = run.manifest.files[0]!.afterBlob!;
      expect((await store.getRunBlob(first.runId, hash)).toString("utf8")).toBe("after\n");
      await expect(store.getRunBlob("missing-run", hash)).rejects.toThrow(/not referenced/);
      expect((await store.getFileContent(second.runId, "file-1", "before"))?.toString("utf8")).toBe("before\n");
    } finally { store.close(); }
  });

  it("backfills version-4 blob references during migration without full recovery", async () => {
    const home = await mkdtemp(join(tmpdir(), "diffpanel-v4-blob-migration-"));
    temporaryDirectories.push(home);
    const initial = await DiffpanelStore.open(home);
    const receipt = await initial.createPreparedRun(capturedReview());
    const stored = await initial.getRun(receipt.runId);
    const hash = stored.manifest.files[0]!.afterBlob!;
    const databasePath = initial.databasePath;
    initial.close();

    const legacy = new Database(databasePath);
    legacy.exec("DROP TABLE run_blobs; UPDATE schema_version SET version = 4;");
    legacy.close();

    const [first, second] = await Promise.all([
      DiffpanelStore.open(home, { recover: false }),
      DiffpanelStore.open(home, { recover: false }),
    ]);
    try {
      expect(first.lastRecoveryReport).toBeNull();
      expect(second.lastRecoveryReport).toBeNull();
      expect((await first.getRunBlob(receipt.runId, hash)).toString("utf8")).toBe("after\n");
      expect((await second.getRunBlob(receipt.runId, hash)).toString("utf8")).toBe("after\n");
    } finally {
      first.close();
      second.close();
    }
  });

  it("keeps shared blobs referenced by retained runs during retention", async () => {
    const home = await mkdtemp(join(tmpdir(), "diffpanel-retention-"));
    temporaryDirectories.push(home);
    const store = await DiffpanelStore.open(home);
    try {
      const receipts: Array<{ runId: string }> = [];
      for (let index = 0; index < 3; index += 1) {
        const receipt = await store.createPreparedRun(capturedReview(), { title: `Run ${index}` });
        await store.setArchived(receipt.runId, true);
        receipts.push(receipt);
      }
      const retainedHash = (await store.getRun(receipts[2]!.runId)).manifest.files[0]!.afterBlob!;
      const result = await store.applyRetention({ keepLatest: 1, olderThan: new Date(Date.now() + 60_000) });
      expect(result.deletedRunIds).toHaveLength(2);
      expect(store.listRuns(undefined, true)).toHaveLength(1);
      expect((await store.getRunBlob(store.listRuns(undefined, true)[0]!.runId, retainedHash)).toString()).toBe("after\n");
      expect(result.deletedBlobCount).toBe(0);
    } finally { store.close(); }
  });

  it("recovers a validated review written before its database update", async () => {
    const home = await mkdtemp(join(tmpdir(), "diffpanel-recovery-"));
    temporaryDirectories.push(home);
    const store = await DiffpanelStore.open(home);
    const receipt = await store.createPreparedRun(capturedReview());
    await writeFile(join(home, "runs", receipt.runId, "review.json"), `${JSON.stringify(generatedReview(receipt.runId))}\n`);
    store.close();

    const recovered = await DiffpanelStore.open(home);
    try {
      expect(recovered.lastRecoveryReport?.recoveredRunIds).toContain(receipt.runId);
      expect((await recovered.getRun(receipt.runId)).summary.status).toBe("ready");
    } finally { recovered.close(); }
  });

  it("marks runs failed when immutable content is missing on restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "diffpanel-missing-blob-"));
    temporaryDirectories.push(home);
    const store = await DiffpanelStore.open(home);
    const receipt = await store.createPreparedRun(capturedReview());
    const hash = (await store.getRun(receipt.runId)).manifest.files[0]!.afterBlob!;
    store.close();
    await unlink(join(home, "blobs", hash.slice(0, 2), hash.slice(2)));

    const recovered = await DiffpanelStore.open(home);
    try {
      expect(recovered.lastRecoveryReport?.failedRunIds).toContain(receipt.runId);
      expect((await recovered.getRun(receipt.runId)).summary.status).toBe("failed");
    } finally { recovered.close(); }
  });

  it("marks runs failed when immutable content is corrupt on restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "diffpanel-corrupt-blob-"));
    temporaryDirectories.push(home);
    const store = await DiffpanelStore.open(home);
    const receipt = await store.createPreparedRun(capturedReview());
    const hash = (await store.getRun(receipt.runId)).manifest.files[0]!.afterBlob!;
    store.close();
    await writeFile(join(home, "blobs", hash.slice(0, 2), hash.slice(2)), "tampered\n");

    const recovered = await DiffpanelStore.open(home);
    try {
      expect(recovered.lastRecoveryReport?.failedRunIds).toContain(receipt.runId);
      expect((await recovered.getRun(receipt.runId)).summary.status).toBe("failed");
    } finally { recovered.close(); }
  });

  it("serializes maintenance across store instances", async () => {
    const home = await mkdtemp(join(tmpdir(), "diffpanel-concurrent-store-"));
    temporaryDirectories.push(home);
    const first = await DiffpanelStore.open(home);
    const second = await DiffpanelStore.open(home);
    try {
      const receipts = await Promise.all(Array.from({ length: 12 }, (_, index) =>
        (index % 2 === 0 ? first : second).createPreparedRun({ ...capturedReview(), repositoryId: `repo-${index}` })));
      await Promise.all([first.garbageCollectBlobs(), second.recover()]);
      expect(first.listRuns(undefined, true)).toHaveLength(12);
      await Promise.all(receipts.map(async ({ runId }) => {
        expect((await first.getFileContent(runId, "file-1", "after"))?.toString()).toBe("after\n");
      }));
    } finally { first.close(); second.close(); }
  });

  it("preflights retained manifests before deleting expired runs", async () => {
    const home = await mkdtemp(join(tmpdir(), "diffpanel-retention-preflight-"));
    temporaryDirectories.push(home);
    const store = await DiffpanelStore.open(home);
    try {
      const older = await store.createPreparedRun(capturedReview(), { title: "Older" });
      await store.setArchived(older.runId, true);
      const retained = await store.createPreparedRun(capturedReview(), { title: "Retained" });
      await store.setArchived(retained.runId, true);
      await writeFile(retained.manifestPath, "not json\n");
      await expect(store.applyRetention({ keepLatest: 1, olderThan: new Date(Date.now() + 60_000) })).rejects.toThrow(/retained run/);
      expect(store.listRuns(undefined, true).map((run) => run.runId)).toEqual(expect.arrayContaining([older.runId, retained.runId]));
      await access(older.manifestPath);
    } finally { store.close(); }
  });

  it("does not restore rows after filesystem deletion when an unrelated retained manifest is corrupt", async () => {
    const home = await mkdtemp(join(tmpdir(), "diffpanel-retention-global-preflight-"));
    temporaryDirectories.push(home);
    const store = await DiffpanelStore.open(home);
    try {
      const scoped = { ...capturedReview(), repositoryId: "repo-scoped", repositoryRoot: "/tmp/scoped" };
      const older = await store.createPreparedRun(scoped, { title: "Scoped older" });
      await store.setArchived(older.runId, true);
      const newest = await store.createPreparedRun(scoped, { title: "Scoped newest" });
      await store.setArchived(newest.runId, true);
      const unrelated = await store.createPreparedRun({
        ...capturedReview(),
        repositoryId: "repo-unrelated",
        repositoryRoot: "/tmp/unrelated",
      });
      await writeFile(unrelated.manifestPath, "not json\n");

      await expect(store.applyRetention({
        repositoryRoot: scoped.repositoryRoot,
        keepLatest: 1,
        olderThan: new Date(Date.now() + 60_000),
      })).rejects.toThrow(/retained run|collect blobs/);

      expect(store.listRuns(undefined, true).map((run) => run.runId)).toContain(older.runId);
      await access(older.manifestPath);
    } finally { store.close(); }
  });

  it("marks ready runs failed when their review is corrupt", async () => {
    const home = await mkdtemp(join(tmpdir(), "diffpanel-corrupt-review-"));
    temporaryDirectories.push(home);
    const store = await DiffpanelStore.open(home);
    const receipt = await store.createPreparedRun(capturedReview());
    await store.publish(receipt.runId, generatedReview(receipt.runId));
    store.close();
    await writeFile(join(home, "runs", receipt.runId, "review.json"), "{}\n");

    const recovered = await DiffpanelStore.open(home);
    try {
      expect(recovered.lastRecoveryReport?.failedRunIds).toContain(receipt.runId);
      expect((await recovered.getRun(receipt.runId)).summary.status).toBe("failed");
    } finally { recovered.close(); }
  });

  it("removes orphan run directories and interrupted temporary writes on restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "diffpanel-orphan-recovery-"));
    temporaryDirectories.push(home);
    const initial = await DiffpanelStore.open(home);
    initial.close();
    await mkdir(join(home, "runs", "orphan-run"), { recursive: true });
    await writeFile(join(home, "runs", "orphan-run", "manifest.json.tmp"), "partial");
    const recovered = await DiffpanelStore.open(home);
    try {
      expect(recovered.lastRecoveryReport?.removedOrphanRunIds).toContain("orphan-run");
      await expect(access(join(home, "runs", "orphan-run"))).rejects.toThrow();
    } finally { recovered.close(); }
  });

  it("allows read-only clients to open without running filesystem recovery", async () => {
    const home = await mkdtemp(join(tmpdir(), "diffpanel-read-only-open-"));
    temporaryDirectories.push(home);
    const initial = await DiffpanelStore.open(home);
    initial.close();
    const orphan = join(home, "runs", "active-external-writer");
    await mkdir(orphan, { recursive: true });

    const reader = await DiffpanelStore.open(home, { recover: false });
    try {
      expect(reader.lastRecoveryReport).toBeNull();
      await access(orphan);
    } finally { reader.close(); }

    const maintainer = await DiffpanelStore.open(home);
    try {
      expect(maintainer.lastRecoveryReport?.removedOrphanRunIds).toContain("active-external-writer");
      await expect(access(orphan)).rejects.toThrow();
    } finally { maintainer.close(); }
  });
});
