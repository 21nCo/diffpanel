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

  it("accepts an optional review title", () => {
    expect(validateGeneratedReview(manifest, { ...review, title: "PR 568 DataFn foundations" })).toMatchObject({ valid: true });
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


describe("diagram evidence", () => {
  it("accepts supporting refs without counting them as duplicate ownership", () => {
    const input = { ...review, chapters: [{ ...review.chapters[0], diagram: "flowchart LR\nA-->B", diagramItemRefs: ["item-1"] }] };
    expect(validateGeneratedReview(manifest, input).valid).toBe(true);
  });
  it("requires evidence for new chapter diagrams", () => {
    expect(validateGeneratedReview(manifest, { ...review, chapters: [{ ...review.chapters[0], diagram: "flowchart LR\nA-->B" }] }).errors).toContain("chapter chapter-1 diagram requires evidence item refs");
  });
  it("rejects unknown and duplicate prologue evidence", () => {
    const input = { ...review, prologue: { ...review.prologue, diagramItemRefs: ["missing", "item-1", "item-1"] } };
    expect(validateGeneratedReview(manifest, input).errors).toEqual(expect.arrayContaining(["prologue diagram references out-of-scope item missing", "prologue diagram repeats item item-1"]));
  });
  it("allows descendant evidence but rejects sibling evidence", () => {
    const input = { ...review, chapters: [
      { ...review.chapters[0], id: "parent", itemRefs: [], diagram: "flowchart LR\nA-->B", diagramItemRefs: ["item-1"] },
      { ...review.chapters[0], id: "child", parentId: "parent", order: 2, itemRefs: ["item-1"] },
      { ...review.chapters[0], id: "sibling", order: 3, itemRefs: ["item-2"] },
    ] };
    expect(validateGeneratedReview(manifest, input).valid).toBe(true);
    const invalid = { ...input, chapters: input.chapters.map((chapter, index) => index === 0 ? { ...chapter, diagramItemRefs: ["item-2"] } : chapter) };
    expect(validateGeneratedReview(manifest, invalid).errors).toContain("chapter parent diagram references out-of-scope item item-2");
  });
});

describe("required visual assessment for new snapshots", () => {
  const currentManifest = { ...manifest, requirements: { diagramAssessment: true as const } };
  const assessment = { kind: "architectural" as const, reasoning: "Ownership and host initialization move across packages." };

  it("keeps historical reviews valid but rejects an absent decision for new captures", () => {
    expect(validateGeneratedReview(manifest, review).valid).toBe(true);
    expect(validateGeneratedReview(currentManifest, review).errors).toContain("review requires diagramAssessment for this snapshot");
  });
  it("requires an overview and focused diagrams, or explicit omission reasons", () => {
    const result = validateGeneratedReview(currentManifest, { ...review, diagramAssessment: assessment });
    expect(result.errors).toContain("provide an overview diagram or overviewOmissionReason");
    expect(result.errors).toContain("architectural reviews require focused chapter diagrams or chapterDiagramOmissionReason");
    expect(validateGeneratedReview(currentManifest, { ...review, diagramAssessment: { ...assessment,
      overviewOmissionReason: "The captured subset does not contain enough dependency evidence for a truthful overview.",
      chapterDiagramOmissionReason: "These chapters contain declarations only; no flow is established by this snapshot.",
    } }).valid).toBe(true);
  });
  it("requires evidence for new overview diagrams, and rejects contradictory omissions", () => {
    const input = { ...review, diagramAssessment: { kind: "other", reasoning: "Show a simple transition." },
      prologue: { ...review.prologue, diagram: "flowchart LR\nA-->B" } };
    expect(validateGeneratedReview(currentManifest, input).errors).toContain("prologue diagram requires evidence item refs");
    expect(validateGeneratedReview(currentManifest, { ...input, prologue: { ...input.prologue, diagramItemRefs: ["item-1"] } }).valid).toBe(true);
    expect(validateGeneratedReview(currentManifest, { ...input, diagramAssessment: { ...input.diagramAssessment, overviewOmissionReason: "omitted" } }).errors).toContain("overview diagram and overviewOmissionReason are mutually exclusive");
  });
  it("accepts an evidenced overview and chapter diagram without duplicate ownership", () => {
    const input = { ...review, diagramAssessment: assessment,
      prologue: { ...review.prologue, diagram: "flowchart LR\nA-->B", diagramItemRefs: ["item-1"] },
      chapters: [{ ...review.chapters[0], diagram: "flowchart LR\nB-->C", diagramItemRefs: ["item-2"] }],
    };
    expect(validateGeneratedReview(currentManifest, input)).toMatchObject({ valid: true, duplicateItemRefs: [] });
  });
});
