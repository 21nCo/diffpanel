import { z } from "zod";

export const reviewScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("worktree"), baseRef: z.string(), baseSha: z.string() }),
  z.object({ type: z.literal("staged"), baseRef: z.string(), baseSha: z.string() }),
  z.object({
    type: z.literal("range"),
    expression: z.string(),
    baseRef: z.string(),
    compareRef: z.string(),
    baseSha: z.string(),
    compareSha: z.string(),
    mergeBase: z.boolean(),
  }),
  z.object({
    type: z.literal("repository"),
    ref: z.string(),
    sha: z.string(),
    maxFiles: z.number().int().positive(),
  }),
]);

export const fileStatusSchema = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "unmerged",
  "snapshot",
  "unknown",
]);

export const reviewItemSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["hunk", "file"]),
  filePath: z.string().min(1),
  oldPath: z.string().nullable().default(null),
  status: fileStatusSchema,
  ordinal: z.number().int().nonnegative(),
  oldStart: z.number().int().nonnegative().nullable(),
  oldLines: z.number().int().nonnegative().nullable(),
  newStart: z.number().int().nonnegative().nullable(),
  newLines: z.number().int().nonnegative().nullable(),
  patch: z.string(),
  contentHash: z.string().min(1),
});

export const reviewFileSchema = z.object({
  id: z.string().min(1),
  filePath: z.string().min(1),
  oldPath: z.string().nullable().default(null),
  status: fileStatusSchema,
  beforeBlob: z.string().nullable(),
  afterBlob: z.string().nullable(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  language: z.string().nullable(),
  size: z.number().int().nonnegative(),
  items: z.array(reviewItemSchema),
});

export const skippedEntrySchema = z.object({
  filePath: z.string(),
  reason: z.string(),
});

export const reviewManifestSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  repositoryId: z.string().min(1),
  repositoryRoot: z.string().min(1),
  repositoryName: z.string().min(1),
  createdAt: z.string().datetime(),
  snapshotHash: z.string().min(1),
  scope: reviewScopeSchema,
  files: z.array(reviewFileSchema),
  skipped: z.array(skippedEntrySchema),
});

export const lineReferenceSchema = z.object({
  filePath: z.string().min(1),
  side: z.enum(["before", "after"]),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
}).refine((value) => value.endLine >= value.startLine, {
  message: "endLine must be greater than or equal to startLine",
  path: ["endLine"],
});

export const keyChangeSchema = z.object({
  content: z.string().min(1),
  lineRefs: z.array(lineReferenceSchema).min(1),
});

export const chapterSchema = z.object({
  id: z.string().min(1),
  parentId: z.string().min(1).nullable().default(null),
  order: z.number().int().positive(),
  title: z.string().min(1).max(100),
  summary: z.string().min(1),
  itemRefs: z.array(z.string().min(1)).default([]),
  keyChanges: z.array(keyChangeSchema).default([]),
});

export const focusAreaSchema = z.object({
  type: z.enum([
    "security",
    "breaking-change",
    "high-complexity",
    "data-integrity",
    "new-pattern",
    "architecture",
    "performance",
    "testing-gap",
  ]),
  severity: z.enum(["critical", "high", "medium", "info"]),
  title: z.string().min(1),
  description: z.string().min(1),
  locations: z.array(z.string().min(1)).min(1),
});

export const prologueSchema = z.object({
  motivation: z.string().nullable(),
  outcome: z.string().nullable(),
  diagram: z.string().nullable(),
  keyChanges: z.array(z.object({
    summary: z.string().min(1),
    description: z.string().min(1),
  })).min(1).max(8),
  focusAreas: z.array(focusAreaSchema).min(1).max(8),
  complexity: z.object({
    level: z.enum(["low", "medium", "high", "very-high"]),
    reasoning: z.string().min(1),
  }),
});

export const generatedReviewSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  generator: z.string().min(1).optional(),
  chapters: z.array(chapterSchema).min(1),
  prologue: prologueSchema,
});

export type ReviewScope = z.infer<typeof reviewScopeSchema>;
export type ReviewItem = z.infer<typeof reviewItemSchema>;
export type ReviewFile = z.infer<typeof reviewFileSchema>;
export type ReviewManifest = z.infer<typeof reviewManifestSchema>;
export type Chapter = z.infer<typeof chapterSchema>;
export type GeneratedReview = z.infer<typeof generatedReviewSchema>;
export type Prologue = z.infer<typeof prologueSchema>;
