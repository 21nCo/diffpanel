import type { GeneratedReview, ReviewManifest } from "@diffpanel/core";

export interface PreparedRunReceipt {
  runId: string;
  receiptPath: string;
  manifestPath: string;
  generationInputPath: string;
  repositoryRoot: string;
  scope: ReviewManifest["scope"];
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
