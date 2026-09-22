import type { GeneratedReview, ReviewManifest } from "diffpanel";

export interface PreparedRunReceipt {
  runId: string;
  receiptPath: string;
  manifestPath: string;
  generationInputPath: string;
  repositoryRoot: string;
  scope: ReviewManifest["scope"];
  title: string | null;
  reviewTitle: string;
  fileCount: number;
  itemCount: number;
  skippedCount: number;
}

export interface RunSummary {
  runId: string;
  repositoryId: string;
  repositoryRoot: string;
  repositoryName: string;
  scope: ReviewManifest["scope"];
  snapshotHash: string;
  status: "prepared" | "ready" | "failed";
  generator: string | null;
  createdAt: string;
  publishedAt: string | null;
  archivedAt: string | null;
  fileCount: number;
  itemCount: number;
  chapterCount: number;
  reviewTitle: string;
}

export interface StoredRun {
  summary: RunSummary;
  manifest: ReviewManifest;
  review: GeneratedReview | null;
}

export interface ListRunsOptions {
  repositoryRoot?: string;
  includeArchived?: boolean;
  limit?: number;
  cursor?: string;
}

export interface RunPage {
  runs: RunSummary[];
  nextCursor: string | null;
}

export interface RetentionPolicy {
  repositoryRoot?: string;
  olderThan?: Date;
  keepLatest?: number;
  archivedOnly?: boolean;
}

export interface RetentionResult {
  deletedRunIds: string[];
  deletedBlobCount: number;
  retainedRunCount: number;
}

export interface RecoveryReport {
  recoveredRunIds: string[];
  failedRunIds: string[];
  removedOrphanRunIds: string[];
  removedTemporaryFiles: number;
  deletedBlobCount: number;
}
