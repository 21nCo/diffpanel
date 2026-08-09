import { describe, expect, it } from "vitest";
import type { Chapter, ReviewFile } from "@diffpanel/core";
import { chapterItemRefs, chapterLabels, diffCounts, uniqueFileCount } from "./presentation.js";

const chapters: Chapter[] = [
  chapter("foundation", null, 1, ["foundation-item"]),
  chapter("cutover", null, 2, []),
  chapter("keys", "cutover", 3, ["key-item"]),
  chapter("auth", "cutover", 4, ["auth-item"]),
  chapter("metrics", null, 9, ["metrics-item"]),
  chapter("handoff", null, 12, ["handoff-item"]),
];

describe("review presentation", () => {
  it("numbers root chapters independently and letters their subtopics", () => {
    expect(Object.fromEntries(chapterLabels(chapters))).toEqual({
      foundation: "1",
      cutover: "2",
      keys: "a",
      auth: "b",
      metrics: "3",
      handoff: "4",
    });
  });

  it("aggregates descendant items for structural chapter metrics", () => {
    expect(chapterItemRefs(chapters, "cutover")).toEqual(["key-item", "auth-item"]);
    expect(uniqueFileCount([reviewFile()], ["key-item", "auth-item"])).toBe(1);
  });

  it("derives additions and deletions from an individual hunk", () => {
    const file = reviewFile();
    expect(diffCounts(file, file.items[0]!)).toEqual({ additions: 2, deletions: 1 });
  });
});

function chapter(id: string, parentId: string | null, order: number, itemRefs: string[]): Chapter {
  return { id, parentId, order, title: id, summary: `${id} summary`, itemRefs, keyChanges: [] };
}

function reviewFile(): ReviewFile {
  return {
    id: "file-1",
    filePath: "src/example.ts",
    oldPath: null,
    status: "modified",
    beforeBlob: "before",
    afterBlob: "after",
    additions: 2,
    deletions: 1,
    language: "typescript",
    size: 10,
    items: [{
      id: "key-item",
      kind: "hunk",
      filePath: "src/example.ts",
      oldPath: null,
      status: "modified",
      ordinal: 0,
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 2,
      patch: "@@ -1 +1,2 @@\n-old\n+new\n+next",
      contentHash: "hash",
    }, {
      id: "auth-item",
      kind: "hunk",
      filePath: "src/example.ts",
      oldPath: null,
      status: "modified",
      ordinal: 1,
      oldStart: 5,
      oldLines: 1,
      newStart: 6,
      newLines: 1,
      patch: "@@ -5 +6 @@\n-a\n+b",
      contentHash: "hash-2",
    }],
  };
}
