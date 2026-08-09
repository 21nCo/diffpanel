import { describe, expect, it } from "vitest";
import { validateGeneratedReview } from "./validation.js";

const manifest = {
  schemaVersion: 1 as const,
  runId: "run-1",
  repositoryId: "repo-1",
  repositoryRoot: "/tmp/repo",
  repositoryName: "repo",
  createdAt: "2026-08-08T00:00:00.000Z",
  snapshotHash: "snapshot",
  scope: { type: "worktree" as const, baseRef: "HEAD", baseSha: "abc" },
  files: [{
    id: "file-1",
    filePath: "src/a.ts",
    oldPath: null,
    status: "modified" as const,
    beforeBlob: "before",
    afterBlob: "after",
    additions: 1,
    deletions: 1,
    language: "typescript",
    size: 20,
    items: [
      { id: "item-1", kind: "hunk" as const, filePath: "src/a.ts", oldPath: null, status: "modified" as const, ordinal: 0, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, patch: "patch", contentHash: "h1" },
      { id: "item-2", kind: "hunk" as const, filePath: "src/a.ts", oldPath: null, status: "modified" as const, ordinal: 1, oldStart: 5, oldLines: 1, newStart: 5, newLines: 1, patch: "patch", contentHash: "h2" },
    ],
  }],
  skipped: [],
};

const review = {
  schemaVersion: 1 as const,
  runId: "run-1",
  chapters: [{ id: "chapter-1", order: 1, title: "Explain the change", summary: "The behavior changes coherently.", itemRefs: ["item-1", "item-2"], keyChanges: [] }],
  prologue: {
    motivation: null,
    outcome: null,
    diagram: null,
    keyChanges: [{ summary: "Behavior follows the new path", description: "Both related hunks now share one review chapter." }],
    focusAreas: [{ type: "architecture" as const, severity: "info" as const, title: "Shared control path", description: "The related behavior moved together; confirm the boundary remains appropriate.", locations: ["src/a.ts"] }],
    complexity: { level: "low" as const, reasoning: "One file with two related hunks." },
  },
};

describe("validateGeneratedReview", () => {
  it("accepts exact item coverage", () => {
    expect(validateGeneratedReview(manifest, review)).toMatchObject({ valid: true });
  });

  it("reports missing and duplicate items", () => {
    const invalid = structuredClone(review);
    invalid.chapters[0]!.itemRefs = ["item-1", "item-1"];
    const result = validateGeneratedReview(manifest, invalid);
    expect(result.valid).toBe(false);
    expect(result.missingItemRefs).toEqual(["item-2"]);
    expect(result.duplicateItemRefs).toEqual(["item-1"]);
  });
});

