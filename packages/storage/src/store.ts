import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, type Dirent } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  assertGeneratedReview,
  displayReviewTitle,
  parseReviewTitle,
  reviewManifestSchema,
  type GeneratedReview,
  type ReviewManifest,
} from "diffpanel";
import { createRunId, sha256 } from "diffpanel/node";
import { formatGenerationInput } from "@diffpanel/generation";
import type { CapturedReview } from "@diffpanel/git";
import { defaultDiffpanelHome } from "./paths.js";
import type {
  ListRunsOptions,
  PreparedRunReceipt,
  RecoveryReport,
  RetentionPolicy,
  RetentionResult,
  RunPage,
  RunSummary,
  StoredRun,
} from "./types.js";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

interface RunRow {
  run_id: string;
  repository_id: string;
  root_path: string;
  repository_name: string;
  scope_json: string;
  snapshot_hash: string;
  status: "prepared" | "ready" | "failed";
  generator: string | null;
  created_at: string;
  published_at: string | null;
  archived_at: string | null;
  file_count: number;
  item_count: number;
  chapter_count: number;
  manifest_path: string;
  review_path: string | null;
  review_title: string | null;
}

export class DiffpanelStore {
  readonly home: string;
  readonly databasePath: string;
  readonly blobsPath: string;
  readonly runsPath: string;
  private readonly database: Database.Database;
  lastRecoveryReport: RecoveryReport | null = null;

  private constructor(home: string, databasePath: string, database: Database.Database) {
    this.home = home;
    this.databasePath = databasePath;
    this.blobsPath = join(home, "blobs");
    this.runsPath = join(home, "runs");
    this.database = database;
  }

  static async open(home = defaultDiffpanelHome()): Promise<DiffpanelStore> {
    await mkdir(join(home, "blobs"), { recursive: true });
    await mkdir(join(home, "runs"), { recursive: true });
    const databasePath = resolveDatabasePath(home);
    const database = new Database(databasePath);
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    migrate(database);
    const store = new DiffpanelStore(home, databasePath, database);
    store.lastRecoveryReport = await store.recover();
    return store;
  }

  close(): void {
    this.database.close();
  }

  async createPreparedRun(captured: CapturedReview, options: { title?: string } = {}): Promise<PreparedRunReceipt> {
    const createdAt = new Date().toISOString();
    const runId = createRunId();
    const runDirectory = join(this.runsPath, runId);
    await mkdir(runDirectory, { recursive: true });

    const files: ReviewManifest["files"] = [];
    const blobHashes = new Set<string>();
    for (const file of captured.files) {
      const beforeBlob = file.beforeContent !== null ? await this.putBlob(file.beforeContent) : null;
      const afterBlob = file.afterContent !== null ? await this.putBlob(file.afterContent) : null;
      if (beforeBlob) blobHashes.add(beforeBlob);
      if (afterBlob) blobHashes.add(afterBlob);
      files.push({
        id: file.id,
        filePath: file.filePath,
        oldPath: file.oldPath,
        status: file.status,
        beforeBlob,
        afterBlob,
        additions: file.additions,
        deletions: file.deletions,
        language: file.language,
        size: file.size,
        items: file.items,
      });
    }

    const snapshotHash = sha256(JSON.stringify({
      repositoryId: captured.repositoryId,
      scope: captured.scope,
      files: files.map((file) => ({
        path: file.filePath,
        before: file.beforeBlob,
        after: file.afterBlob,
        items: file.items.map((item) => item.contentHash),
      })),
    }));
    const manifest: ReviewManifest = reviewManifestSchema.parse({
      schemaVersion: 1,
      runId,
      repositoryId: captured.repositoryId,
      repositoryRoot: captured.repositoryRoot,
      repositoryName: captured.repositoryName,
      createdAt,
      snapshotHash,
      scope: captured.scope,
      files,
      skipped: captured.skipped,
      requirements: { diagramAssessment: true },
    });

    const manifestPath = join(runDirectory, "manifest.json");
    const generationInputPath = join(runDirectory, "generation-input.md");
    const receiptPath = join(runDirectory, "receipt.json");
    const itemCount = files.reduce((total, file) => total + file.items.length, 0);
    const title = options.title === undefined ? null : parseReviewTitle(options.title);
    const receipt: PreparedRunReceipt = {
      runId,
      receiptPath,
      manifestPath,
      generationInputPath,
      repositoryRoot: captured.repositoryRoot,
      scope: captured.scope,
      title,
      reviewTitle: displayReviewTitle(title, captured.scope),
      fileCount: files.length,
      itemCount,
      skippedCount: captured.skipped.length,
    };

    await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await atomicWrite(generationInputPath, formatGenerationInput(manifest));
    await atomicWrite(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

    const insertRun = this.database.prepare(`
      INSERT INTO runs (
        run_id, repository_id, root_path, repository_name, scope_json,
        snapshot_hash, status, created_at, file_count, item_count, manifest_path,
        review_title
      ) VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?)
    `);
    const insertItem = this.database.prepare(`
      INSERT INTO items (item_id, run_id, file_id, file_path, ordinal, kind)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertBlob = this.database.prepare(`
      INSERT OR IGNORE INTO run_blobs (run_id, blob_hash) VALUES (?, ?)
    `);
    const transaction = this.database.transaction(() => {
      insertRun.run(
        runId,
        captured.repositoryId,
        captured.repositoryRoot,
        captured.repositoryName,
        JSON.stringify(captured.scope),
        snapshotHash,
        createdAt,
        files.length,
        itemCount,
        manifestPath,
        title,
      );
      for (const file of files) {
        for (const item of file.items) {
          insertItem.run(item.id, runId, file.id, file.filePath, item.ordinal, item.kind);
        }
      }
      for (const hash of blobHashes) insertBlob.run(runId, hash);
    });
    transaction();
    return receipt;
  }

  async publish(runId: string, reviewInput: unknown): Promise<GeneratedReview> {
    const run = await this.getRun(runId);
    const review = assertGeneratedReview(run.manifest, reviewInput);
    const reviewPath = join(this.runsPath, runId, "review.json");
    await atomicWrite(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
    const publishedAt = new Date().toISOString();
    const row = this.requireRunRow(runId);
    this.database.transaction(() => {
      this.database.prepare(`
        UPDATE runs
        SET status = 'ready', generator = ?, published_at = ?, chapter_count = ?, review_path = ?, review_title = ?
        WHERE run_id = ?
      `).run(
        review.generator ?? "agent",
        publishedAt,
        review.chapters.length,
        reviewPath,
        review.title ?? row.review_title,
        runId,
      );
    })();
    return review;
  }

  async validate(runId: string, reviewInput: unknown): Promise<GeneratedReview> {
    const run = await this.getRun(runId);
    return assertGeneratedReview(run.manifest, reviewInput);
  }

  listRuns(repositoryRoot?: string, includeArchived = false): RunSummary[] {
    return this.listRunsPage({ repositoryRoot, includeArchived, limit: MAX_LIST_LIMIT }).runs;
  }

  listRunsPage(options: ListRunsOptions = {}): RunPage {
    const limit = options.limit ?? DEFAULT_LIST_LIMIT;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
      throw new Error(`Run list limit must be between 1 and ${MAX_LIST_LIMIT}.`);
    }
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (options.repositoryRoot) {
      clauses.push("root_path = ?");
      parameters.push(options.repositoryRoot);
    }
    if (!options.includeArchived) clauses.push("archived_at IS NULL");
    if (options.cursor) {
      const cursor = decodeRunCursor(options.cursor);
      clauses.push("(created_at < ? OR (created_at = ? AND run_id < ?))");
      parameters.push(cursor.createdAt, cursor.createdAt, cursor.runId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database.prepare(`
      SELECT * FROM runs ${where}
      ORDER BY created_at DESC, run_id DESC
      LIMIT ?
    `).all(...parameters, limit + 1) as RunRow[];
    const hasMore = rows.length > limit;
    const visible = hasMore ? rows.slice(0, limit) : rows;
    const last = visible.at(-1);
    return {
      runs: visible.map(toRunSummary),
      nextCursor: hasMore && last ? encodeRunCursor(last.created_at, last.run_id) : null,
    };
  }

  setArchived(runId: string, archived: boolean): RunSummary {
    const archivedAt = archived ? new Date().toISOString() : null;
    const result = this.database.prepare("UPDATE runs SET archived_at = ? WHERE run_id = ?").run(archivedAt, runId);
    if (result.changes === 0) throw new Error(`Unknown Diffpanel run: ${runId}`);
    return toRunSummary(this.requireRunRow(runId));
  }

  setReviewTitle(runId: string, title: string | null): RunSummary {
    this.requireRunRow(runId);
    const reviewTitle = title === null ? null : parseReviewTitle(title);
    this.database.prepare("UPDATE runs SET review_title = ? WHERE run_id = ?").run(reviewTitle, runId);
    return toRunSummary(this.requireRunRow(runId));
  }

  async getRun(runId: string): Promise<StoredRun> {
    const row = this.database.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as RunRow | undefined;
    if (!row) throw new Error(`Unknown Diffpanel run: ${runId}`);
    const manifest = reviewManifestSchema.parse(JSON.parse(await readFile(row.manifest_path, "utf8")));
    const review = row.review_path
      ? assertGeneratedReview(manifest, JSON.parse(await readFile(row.review_path, "utf8")))
      : null;
    return { summary: toRunSummary(row), manifest, review };
  }

  async getFileContent(runId: string, fileId: string, side: "before" | "after"): Promise<Buffer | null> {
    const run = await this.getRun(runId);
    const file = run.manifest.files.find((candidate) => candidate.id === fileId);
    if (!file) throw new Error(`Unknown file ${fileId} in run ${runId}.`);
    const hash = side === "before" ? file.beforeBlob : file.afterBlob;
    return hash ? await this.getRunBlob(runId, hash) : null;
  }

  async getRunBlob(runId: string, hash: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid content hash.");
    const reference = this.database.prepare(
      "SELECT 1 FROM run_blobs WHERE run_id = ? AND blob_hash = ?",
    ).get(runId, hash);
    if (!reference) throw new Error(`Content ${hash} is not referenced by run ${runId}.`);
    const content = await readFile(this.blobPath(hash));
    if (sha256(content) !== hash) throw new Error(`Content ${hash} failed its integrity check.`);
    return content;
  }

  async applyRetention(policy: RetentionPolicy = {}): Promise<RetentionResult> {
    const keepLatest = policy.keepLatest ?? 50;
    if (!Number.isSafeInteger(keepLatest) || keepLatest < 0) throw new Error("keepLatest must be a non-negative integer.");
    const olderThan = policy.olderThan ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000);
    if (Number.isNaN(olderThan.getTime())) throw new Error("olderThan must be a valid date.");
    const rows = (policy.repositoryRoot
      ? this.database.prepare("SELECT * FROM runs WHERE root_path = ? ORDER BY created_at DESC, run_id DESC").all(policy.repositoryRoot)
      : this.database.prepare("SELECT * FROM runs ORDER BY created_at DESC, run_id DESC").all()) as RunRow[];
    const retainedPerRepository = new Map<string, number>();
    const deletedRunIds: string[] = [];
    for (const row of rows) {
      const retained = retainedPerRepository.get(row.repository_id) ?? 0;
      if (retained < keepLatest) {
        retainedPerRepository.set(row.repository_id, retained + 1);
        continue;
      }
      if ((policy.archivedOnly ?? true) && !row.archived_at) continue;
      if (Date.parse(row.created_at) >= olderThan.getTime()) continue;
      deletedRunIds.push(row.run_id);
    }
    if (deletedRunIds.length > 0) {
      const removeRun = this.database.prepare("DELETE FROM runs WHERE run_id = ?");
      this.database.transaction(() => {
        for (const runId of deletedRunIds) removeRun.run(runId);
      })();
      for (const runId of deletedRunIds) await rm(join(this.runsPath, runId), { recursive: true, force: true });
    }
    const deletedBlobCount = await this.garbageCollectBlobs();
    const retainedRunCount = (this.database.prepare("SELECT COUNT(*) AS count FROM runs").get() as { count: number }).count;
    return { deletedRunIds, deletedBlobCount, retainedRunCount };
  }

  async garbageCollectBlobs(): Promise<number> {
    const rows = this.database.prepare("SELECT run_id, manifest_path FROM runs").all() as Array<{ run_id: string; manifest_path: string }>;
    for (const row of rows) {
      try {
        const manifest = reviewManifestSchema.parse(JSON.parse(await readFile(row.manifest_path, "utf8")));
        this.backfillBlobReferences(row.run_id, manifest);
      } catch {
        throw new Error(`Cannot collect blobs while retained run ${row.run_id} has an unreadable manifest.`);
      }
    }
    const retained = new Set(
      (this.database.prepare("SELECT DISTINCT blob_hash FROM run_blobs").all() as Array<{ blob_hash: string }>)
        .map((row) => row.blob_hash),
    );
    let deleted = 0;
    for (const prefix of await safeReadDirectory(this.blobsPath)) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue;
      const prefixPath = join(this.blobsPath, prefix.name);
      for (const entry of await safeReadDirectory(prefixPath)) {
        if (!entry.isFile()) continue;
        const hash = `${prefix.name}${entry.name}`;
        if (!/^[a-f0-9]{64}$/.test(hash) || retained.has(hash)) continue;
        await unlink(join(prefixPath, entry.name));
        deleted += 1;
      }
    }
    return deleted;
  }

  async recover(): Promise<RecoveryReport> {
    const report: RecoveryReport = {
      recoveredRunIds: [],
      failedRunIds: [],
      removedOrphanRunIds: [],
      removedTemporaryFiles: 0,
      deletedBlobCount: 0,
    };
    report.removedTemporaryFiles += await removeTemporaryFiles(this.runsPath);
    report.removedTemporaryFiles += await removeTemporaryFiles(this.blobsPath);
    const rows = this.database.prepare("SELECT * FROM runs").all() as RunRow[];
    const knownRuns = new Set(rows.map((row) => row.run_id));

    for (const entry of await safeReadDirectory(this.runsPath)) {
      if (!entry.isDirectory() || knownRuns.has(entry.name)) continue;
      await rm(join(this.runsPath, entry.name), { recursive: true, force: true });
      report.removedOrphanRunIds.push(entry.name);
    }

    let safeToCollect = true;
    for (const row of rows) {
      try {
        const manifest = reviewManifestSchema.parse(JSON.parse(await readFile(row.manifest_path, "utf8")));
        this.backfillBlobReferences(row.run_id, manifest);
        await this.assertManifestBlobsExist(manifest);
        const candidateReviewPath = row.review_path ?? join(this.runsPath, row.run_id, "review.json");
        if (row.status === "prepared" && existsSync(candidateReviewPath)) {
          const review = assertGeneratedReview(manifest, JSON.parse(await readFile(candidateReviewPath, "utf8")));
          this.database.prepare(`
            UPDATE runs
            SET status = 'ready', generator = ?, published_at = ?, chapter_count = ?, review_path = ?, review_title = ?
            WHERE run_id = ?
          `).run(
            review.generator ?? "agent",
            new Date().toISOString(),
            review.chapters.length,
            candidateReviewPath,
            review.title ?? row.review_title,
            row.run_id,
          );
          report.recoveredRunIds.push(row.run_id);
        } else if (row.status === "ready") {
          if (!existsSync(candidateReviewPath)) {
            this.markRunFailed(row.run_id);
            report.failedRunIds.push(row.run_id);
          } else {
            assertGeneratedReview(manifest, JSON.parse(await readFile(candidateReviewPath, "utf8")));
          }
        }
      } catch {
        safeToCollect = false;
        this.markRunFailed(row.run_id);
        report.failedRunIds.push(row.run_id);
      }
    }
    if (safeToCollect) report.deletedBlobCount = await this.garbageCollectBlobs();
    return report;
  }

  async modifiedAt(): Promise<number> {
    return (await stat(this.databasePath)).mtimeMs;
  }

  private async putBlob(content: Buffer): Promise<string> {
    const hash = sha256(content);
    const path = this.blobPath(hash);
    try {
      await stat(path);
    } catch {
      await mkdir(dirname(path), { recursive: true });
      await atomicWrite(path, content);
    }
    return hash;
  }

  private blobPath(hash: string): string {
    return join(this.blobsPath, hash.slice(0, 2), hash.slice(2));
  }

  private requireRunRow(runId: string): RunRow {
    const row = this.database.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as RunRow | undefined;
    if (!row) throw new Error(`Unknown Diffpanel run: ${runId}`);
    return row;
  }

  private backfillBlobReferences(runId: string, manifest: ReviewManifest): void {
    const insert = this.database.prepare("INSERT OR IGNORE INTO run_blobs (run_id, blob_hash) VALUES (?, ?)");
    this.database.transaction(() => {
      for (const file of manifest.files) {
        if (file.beforeBlob) insert.run(runId, file.beforeBlob);
        if (file.afterBlob) insert.run(runId, file.afterBlob);
      }
    })();
  }

  private async assertManifestBlobsExist(manifest: ReviewManifest): Promise<void> {
    const hashes = new Set(manifest.files.flatMap((file) => [file.beforeBlob, file.afterBlob]).filter((hash): hash is string => hash !== null));
    for (const hash of hashes) {
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid content hash in run ${manifest.runId}.`);
      await stat(this.blobPath(hash));
    }
  }

  private markRunFailed(runId: string): void {
    this.database.prepare("UPDATE runs SET status = 'failed', review_path = NULL WHERE run_id = ?").run(runId);
  }
}

function resolveDatabasePath(home: string): string {
  const current = join(home, "diffpanel.sqlite3");
  const legacy = join(home, "conductor.sqlite3");
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    );
    INSERT INTO schema_version(version)
    SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version);

    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      root_path TEXT NOT NULL,
      repository_name TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      snapshot_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('prepared', 'ready', 'failed')),
      generator TEXT,
      created_at TEXT NOT NULL,
      published_at TEXT,
      archived_at TEXT,
      file_count INTEGER NOT NULL,
      item_count INTEGER NOT NULL,
      chapter_count INTEGER NOT NULL DEFAULT 0,
      manifest_path TEXT NOT NULL,
      review_path TEXT,
      review_title TEXT
    );
    CREATE INDEX IF NOT EXISTS runs_root_created ON runs(root_path, created_at DESC);

    CREATE TABLE IF NOT EXISTS items (
      item_id TEXT NOT NULL,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      file_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      kind TEXT NOT NULL,
      PRIMARY KEY (run_id, item_id)
    );

    CREATE TABLE IF NOT EXISTS run_blobs (
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      blob_hash TEXT NOT NULL,
      PRIMARY KEY (run_id, blob_hash)
    );
    CREATE INDEX IF NOT EXISTS run_blobs_hash ON run_blobs(blob_hash);
  `);
  const columns = database.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "archived_at")) {
    database.exec("ALTER TABLE runs ADD COLUMN archived_at TEXT");
  }
  if (!columns.some((column) => column.name === "review_title")) {
    database.exec("ALTER TABLE runs ADD COLUMN review_title TEXT");
  }
  database.exec("UPDATE schema_version SET version = 4");
}

function toRunSummary(row: RunRow): RunSummary {
  const scope = JSON.parse(row.scope_json) as ReviewManifest["scope"];
  return {
    runId: row.run_id,
    repositoryId: row.repository_id,
    repositoryRoot: row.root_path,
    repositoryName: row.repository_name,
    scope,
    snapshotHash: row.snapshot_hash,
    status: row.status,
    generator: row.generator,
    createdAt: row.created_at,
    publishedAt: row.published_at,
    archivedAt: row.archived_at,
    fileCount: row.file_count,
    itemCount: row.item_count,
    chapterCount: row.chapter_count,
    reviewTitle: displayReviewTitle(row.review_title, scope),
  };
}

async function atomicWrite(path: string, content: string | Buffer): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}

function encodeRunCursor(createdAt: string, runId: string): string {
  return Buffer.from(JSON.stringify({ createdAt, runId }), "utf8").toString("base64url");
}

function decodeRunCursor(cursor: string): { createdAt: string; runId: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!value || typeof value !== "object") throw new Error("not an object");
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.createdAt !== "string" || Number.isNaN(Date.parse(candidate.createdAt))) throw new Error("invalid date");
    if (typeof candidate.runId !== "string" || candidate.runId.length === 0) throw new Error("invalid run id");
    return { createdAt: candidate.createdAt, runId: candidate.runId };
  } catch {
    throw new Error("Invalid run-list cursor.");
  }
}

async function safeReadDirectory(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function removeTemporaryFiles(root: string): Promise<number> {
  let removed = 0;
  for (const entry of await safeReadDirectory(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) removed += await removeTemporaryFiles(path);
    else if (entry.isFile() && entry.name.endsWith(".tmp")) {
      await unlink(path);
      removed += 1;
    }
  }
  return removed;
}
