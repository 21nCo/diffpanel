import type { ReviewItem, ReviewScope } from "diffpanel";

export interface CapturedFile {
  id: string;
  filePath: string;
  oldPath: string | null;
  status: ReviewItem["status"];
  beforeContent: Buffer | null;
  afterContent: Buffer | null;
  additions: number;
  deletions: number;
  language: string | null;
  size: number;
  items: ReviewItem[];
}

export interface CapturedReview {
  repositoryId: string;
  repositoryRoot: string;
  repositoryName: string;
  scope: ReviewScope;
  files: CapturedFile[];
  skipped: Array<{ filePath: string; reason: string }>;
}

export interface CaptureLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
  maxProcessOutputBytes: number;
  processTimeoutMs: number;
}

export interface CaptureProgress {
  phase: "discover" | "capture" | "verify";
  current: number;
  total: number;
  filePath?: string;
}

export interface CaptureOptions {
  signal?: AbortSignal;
  limits?: Partial<CaptureLimits>;
  onProgress?: (progress: CaptureProgress) => void;
}

export type CaptureRequest =
  | { type: "auto"; repository?: string }
  | { type: "worktree"; repository?: string; baseRef?: string }
  | { type: "staged"; repository?: string; baseRef?: string }
  | { type: "range"; repository?: string; expression: string }
  | { type: "repository"; repository?: string; ref?: string; maxFiles?: number };
