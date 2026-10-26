import { createHash, randomUUID } from "node:crypto";
import type { DiffpanelStore } from "@diffpanel/storage";
import type { OpenReview, SavedEvidence } from "./contracts.js";
import { MAX_FILE_BYTES, MAX_REVIEW_BYTES } from "./contracts.js";

export class ViewerError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export class ReviewAdapter {
  private readonly cursors = new Map<string, string>();
  constructor(private readonly store: DiffpanelStore, private readonly allowedRuns: ReadonlySet<string>) {
    if (allowedRuns.size === 0) throw new Error("Explicit DIFFPANEL_RUN_IDS authorization is required.");
  }

  list(limit = 20, cursor?: string) {
    const storedCursor = cursor ? this.cursors.get(cursor) : undefined;
    if (cursor && !storedCursor) throw new ViewerError("invalid_cursor", "This page cursor is invalid or expired. Refresh the review library.");
    const page = this.store.listRunsPage({ limit, cursor: storedCursor, includeArchived: true });
    let nextCursor: string | null = null;
    if (page.nextCursor) {
      nextCursor = randomUUID();
      this.cursors.set(nextCursor, page.nextCursor);
      if (this.cursors.size > 1000) this.cursors.delete(this.cursors.keys().next().value!);
    }
    return {
      runs: page.runs.filter((run) => this.allowedRuns.has(run.runId) && run.status === "ready").map((run) => ({
        runId: run.runId, reviewTitle: run.reviewTitle, repositoryName: run.repositoryName,
        snapshotHash: run.snapshotHash, createdAt: run.createdAt,
      })),
      nextCursor,
    };
  }

  async open(runId: string): Promise<OpenReview> {
    this.authorize(runId);
    try {
      const run = await this.store.getRun(runId);
      if (run.summary.status !== "ready" || !run.review) throw new ViewerError("unavailable", "This review is not published or is unavailable.");
      if (runId.length > 200 || !/^[a-f0-9]{64}$/.test(run.manifest.snapshotHash) || run.review.chapters.some((chapter) => chapter.id.length > 200) || run.manifest.files.some((file) => file.items.some((item) => item.id.length > 200))) throw new ViewerError("unavailable", "This review has unsupported saved identifiers.");
      const saved = JSON.stringify({ manifest: run.manifest, review: run.review });
      if (Buffer.byteLength(saved) > MAX_REVIEW_BYTES) throw new ViewerError("too_large", "This review exceeds the 2 MiB viewer limit. Open it in Diffpanel's editor surface.");
      return {
        summary: { runId, reviewTitle: run.summary.reviewTitle, repositoryName: run.summary.repositoryName, snapshotHash: run.manifest.snapshotHash, createdAt: run.summary.createdAt },
        revision: createHash("sha256").update(saved).digest("hex"),
        manifest: run.manifest, review: run.review,
      };
    } catch (error) {
      if (error instanceof ViewerError) throw error;
      throw new ViewerError("unavailable", "This saved review is missing, malformed, or unavailable.");
    }
  }

  async evidence(runId: string, revision: string, itemId: string): Promise<SavedEvidence> {
    const run = await this.open(runId);
    if (run.revision !== revision) throw new ViewerError("revision_changed", "The saved review changed. Reopen it explicitly before continuing.");
    const file = run.manifest.files.find((candidate) => candidate.items.some((item) => item.id === itemId));
    const item = file?.items.find((candidate) => candidate.id === itemId);
    if (!file || !item) throw new ViewerError("missing_item", "This item does not belong to the selected review.");
    try {
      const read = async (hash: string | null) => {
        if (!hash) return null;
        const bytes = await this.store.getRunBlob(runId, hash);
        if (bytes.length > MAX_FILE_BYTES) throw new ViewerError("too_large", "Saved file exceeds the 512 KiB viewer limit. The saved patch remains available.");
        const text = bytes.toString("utf8");
        if (text.includes("\0") || !Buffer.from(text).equals(bytes)) throw new ViewerError("binary", "This saved file is binary or is not UTF-8. View its metadata and patch instead.");
        return text;
      };
      const [before, after] = await Promise.all([read(file.beforeBlob), read(file.afterBlob)]);
      return { runId, revision, file, item, before, after };
    } catch (error) {
      if (error instanceof ViewerError) throw error;
      throw new ViewerError("unavailable", "Saved evidence is missing or failed its integrity check.");
    }
  }

  private authorize(runId: string) {
    if (!this.allowedRuns.has(runId)) throw new ViewerError("unauthorized", "This run is not authorized for this service connection.");
  }
}
