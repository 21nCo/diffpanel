import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  assertGeneratedReview,
  createRunId,
  displayReviewTitle,
  formatGenerationInput,
  parseReviewTitle,
  reviewManifestSchema,
  sha256,
  type GeneratedReview,
  type ReviewManifest,
} from "@diffpanel/core";
import type { CapturedReview } from "@diffpanel/git";
import { defaultDiffpanelHome } from "./paths.js";
import type { PreparedRunReceipt, RunSummary, StoredRun } from "./types.js";

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
    migrate(database);
    return new DiffpanelStore(home, databasePath, database);
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
    for (const file of captured.files) {
      const beforeBlob = file.beforeContent ? await this.putBlob(file.beforeContent) : null;
      const afterBlob = file.afterContent ? await this.putBlob(file.afterContent) : null;
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
    return review;
  }

  async validate(runId: string, reviewInput: unknown): Promise<GeneratedReview> {
    const run = await this.getRun(runId);
    return assertGeneratedReview(run.manifest, reviewInput);
  }

  listRuns(repositoryRoot?: string, includeArchived = false): RunSummary[] {
    const rows = repositoryRoot
      ? includeArchived
        ? this.database.prepare("SELECT * FROM runs WHERE root_path = ? ORDER BY created_at DESC").all(repositoryRoot) as RunRow[]
        : this.database.prepare("SELECT * FROM runs WHERE root_path = ? AND archived_at IS NULL ORDER BY created_at DESC").all(repositoryRoot) as RunRow[]
      : includeArchived
        ? this.database.prepare("SELECT * FROM runs ORDER BY created_at DESC").all() as RunRow[]
        : this.database.prepare("SELECT * FROM runs WHERE archived_at IS NULL ORDER BY created_at DESC").all() as RunRow[];
    return rows.map(toRunSummary);
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
      ? JSON.parse(await readFile(row.review_path, "utf8")) as GeneratedReview
      : null;
    return { summary: toRunSummary(row), manifest, review };
  }

  async getBlob(hash: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid content hash.");
    return await readFile(this.blobPath(hash));
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
      review_path TEXT
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
  `);
  const columns = database.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "archived_at")) {
    database.exec("ALTER TABLE runs ADD COLUMN archived_at TEXT");
  }
  if (!columns.some((column) => column.name === "review_title")) {
    database.exec("ALTER TABLE runs ADD COLUMN review_title TEXT");
  }
  database.exec("UPDATE schema_version SET version = 3");
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
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}
