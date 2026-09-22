import { describe, expect, it } from "vitest";
import type { Chapter, ReviewFile, ReviewItem } from "diffpanel";
import {
  chapterItemRefs,
  chapterLabels,
  diagramSourceError,
  groupFiles,
  importRewrite,
  partitionChanges,
  type ItemMatch,
} from "./index.js";

function chapter(id: string, parentId: string | null, order: number, itemRefs: string[]): Chapter {
  return { id, parentId, order, title: id, summary: id, itemRefs, keyChanges: [] };
}

function match(id: string, source = "old", target = "new"): ItemMatch {
  const item: ReviewItem = {
    id,
    kind: "hunk",
    filePath: `${id}.ts`,
    oldPath: null,
    status: "modified",
    ordinal: 0,
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    patch: `@@ -1 +1 @@\n-import { value } from "@/${source}";\n+import { value } from "@/${target}";`,
    contentHash: id,
  };
  const file: ReviewFile = {
    id: `file-${id}`,
    filePath: item.filePath,
    oldPath: null,
    status: "modified",
    beforeBlob: `before-${id}`,
    afterBlob: `after-${id}`,
    additions: 1,
    deletions: 1,
    language: "typescript",
    size: 10,
    items: [item],
  };
  return { file, item };
}

describe("shared presentation contracts", () => {
  it("labels roots independently and aggregates descendant coverage", () => {
    const chapters = [
      chapter("root", null, 1, []),
      chapter("first", "root", 2, ["a"]),
      chapter("second", "root", 3, ["b"]),
      chapter("other", null, 4, ["c"]),
    ];
    expect(Object.fromEntries(chapterLabels(chapters))).toEqual({ root: "1", first: "a", second: "b", other: "2" });
    expect(chapterItemRefs(chapters, "root")).toEqual(["a", "b"]);
  });

  it("groups only repeated complete static import rewrites", () => {
    const first = match("a");
    const second = match("b");
    const mixed = match("mixed");
    mixed.item.patch += "\n-return 1;\n+return 2;";
    expect(importRewrite(mixed.item)).toBeNull();
    const result = partitionChanges([first, second, mixed]);
    expect(result.transformations).toHaveLength(1);
    expect(result.individual).toEqual([mixed]);
    expect(groupFiles([first, first])).toHaveLength(1);
  });

  it("rejects active Mermaid content while allowing plain diagrams", () => {
    expect(diagramSourceError('graph LR\nclick A "https://example.com"')).not.toBeNull();
    expect(diagramSourceError("sequenceDiagram\nA->>B: Review")).toBeNull();
  });
});
