import type { ReviewFile, ReviewItem, ReviewManifest, GeneratedReview } from "diffpanel";

export interface ReviewSummary {
  runId: string;
  reviewTitle: string;
  repositoryName: string;
  snapshotHash: string;
  createdAt: string;
}
export interface OpenReview {
  summary: ReviewSummary;
  revision: string;
  manifest: ReviewManifest;
  review: GeneratedReview;
}
export interface SavedEvidence {
  runId: string;
  revision: string;
  file: ReviewFile;
  item: ReviewItem;
  before: string | null;
  after: string | null;
}
export const TOOLS = { panel: "diffpanel_panel", list: "diffpanel_list_reviews", open: "diffpanel_open_review", evidence: "diffpanel_read_evidence" } as const;
export const UI_URI = "ui://diffpanel/review.html";
export const MAX_REVIEW_BYTES = 2 * 1024 * 1024;
export const MAX_FILE_BYTES = 512 * 1024;
export const CONTEXT_CHARACTERS = 8000;
