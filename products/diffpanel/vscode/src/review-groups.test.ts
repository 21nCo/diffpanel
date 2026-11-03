import { describe, expect, it } from "vitest";
import type { Chapter, ReviewFile, ReviewItem } from "diffpanel";
import { diagramSourceError, groupFiles, importRewrite, isExactMove, matchesRewrite, moveDescription, otherFileChapters, partitionChanges, prefixRewrite, type ItemMatch } from "@diffpanel/presentation";

function match(id: string, patch = '@@ -1 +1 @@\n-import { foo } from "@/old";\n+import { foo } from "@/new";'): ItemMatch {
  const item: ReviewItem = { id, kind: "hunk", filePath: `${id}.ts`, oldPath: null, status: "modified", ordinal: 0, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, patch, contentHash: id };
  const file: ReviewFile = { id: `file-${id}`, filePath: item.filePath, oldPath: null, status: "modified", beforeBlob: `before-${id}`, afterBlob: `after-${id}`, additions: 1, deletions: 1, language: "typescript", size: 100, items: [item] };
  return { file, item };
}

describe("review compression", () => {
  it("groups hundreds of edits while preserving exactly all item references", () => {
    const matches = Array.from({ length: 400 }, (_, i) => match(String(i)));
    const result = partitionChanges(matches);
    expect(result.transformations).toHaveLength(1);
    expect(result.individual).toHaveLength(0);
    expect(result.transformations[0]!.matches.map(({ item }) => item.id)).toEqual(matches.map(({ item }) => item.id));
  });

  it("keeps unrelated hunks in the same file individually visible", () => {
    const a = match("a");
    const b = match("b");
    const extra = match("extra", "@@ -5 +5 @@\n-return 1;\n+return 2;");
    extra.file = a.file;
    a.file.items.push(extra.item);
    const result = partitionChanges([a, b, extra]);
    expect(result.individual).toEqual([extra]);
    expect(result.transformations[0]!.matches).toEqual([a, b]);
    const rows = groupFiles([a, extra, a]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.items).toHaveLength(2);
    expect(rows[0]!.additions).toBe(2);
  });

  it.each([
    '@@ -1,2 +1,2 @@\n-import { foo } from "@/old";\n-return 1;\n+import { foo } from "@/new";\n+return 2;',
    '@@ -1 +1 @@\n-import { foo } from "@/old";\n+import { bar } from "@/new";',
    '@@ -1 +1 @@\n-import { foo } from "@/old";\n+import { foo } from "@/new"; // altered',
    '@@ -1 +1 @@\n-const x = require("@/old");\n+const x = require("@/new");',
    '@@ -0,0 +1 @@\n+import { foo } from "@/new";',
    '@@ -1 +1 @@\n-import { foo } from "@/old";\n+import { foo } from "@/old";',
  ])("leaves mixed, unsupported or ambiguous patches ungrouped: %s", (patch) => {
    expect(importRewrite(match("a", patch).item)).toBeNull();
  });

  it("checks each separated edit block and does not cross-pair imports through context", () => {
    const patch = '@@ -1,3 +1,3 @@\n-import { foo } from "@/old";\n context\n+import { foo } from "@/new";';
    expect(importRewrite(match("a", patch).item)).toBeNull();
  });

  it("groups equivalent source rewrites with different bindings, preserving each example", () => {
    const a = match("a");
    const b = match("b", a.item.patch.replaceAll("foo", "bar"));
    expect(partitionChanges([a, b]).transformations).toHaveLength(1);
    expect(partitionChanges([a]).individual).toEqual([a]);
  });

  it("requires identical non-null content hashes for exact moves", () => {
    const a = match("a");
    const b = match("b");
    for (const entry of [a, b]) Object.assign(entry.file, { status: "renamed", oldPath: `old/${entry.file.filePath}`, beforeBlob: entry.file.afterBlob });
    expect(partitionChanges([a, b]).transformations[0]!.kind).toBe("moves");
    b.file.afterBlob = "edited";
    expect(isExactMove(b.file)).toBe(false);
    a.file.beforeBlob = null;
    a.file.afterBlob = null;
    expect(isExactMove(a.file)).toBe(false);
  });

  it("links only other chapters that own a file's hunks", () => {
    const a = match("a");
    const chapter = (id: string, itemRefs: string[]): Chapter => ({ id, parentId: null, order: 1, title: id, summary: id, itemRefs, keyChanges: [] });
    expect(otherFileChapters(a.file, [chapter("first", ["a"]), chapter("second", ["a"]), chapter("unrelated", ["z"])], "first").map(({ id }) => id)).toEqual(["second"]);
  });

  it("groups renamed imports and keeps additional logic visible", () => {
    const a = match("a"); const b = match("b");
    for (const entry of [a, b]) {
      entry.file.status = entry.item.status = "renamed";
      entry.file.oldPath = `old/${entry.file.filePath}`;
    }
    expect(partitionChanges([a, b]).transformations).toHaveLength(1);
    expect(moveDescription(a.file)).toBe("Moved + import rewrite");
    const logic = match("logic", "@@ -5 +5 @@\n-return 1;\n+return 2;");
    logic.file = a.file; a.file.items.push(logic.item);
    expect(partitionChanges([a, b, logic]).individual).toEqual([logic]);
    expect(moveDescription(a.file)).toBe("Moved and edited");
  });

  it("groups a prefix migration across different modules and hunk lengths", () => {
    const a = match("a", '@@ -1 +1 @@\n-import { a } from "@old/utils/date";\n+import { a } from "@shared/utils/date";');
    const b = match("b", '@@ -1,2 +1,2 @@\n-import { b } from "@old/utils/time";\n-import { c } from "@old/utils/format";\n+import { b } from "@shared/utils/time";\n+import { c } from "@shared/utils/format";');
    const result = partitionChanges([a, b]);
    expect(result.individual).toHaveLength(0);
    expect(result.transformations).toHaveLength(1);
    const group = result.transformations[0]!;
    expect(group.mappings).toEqual([{ before: "@old/", after: "@shared/", prefix: true }]);
    for (const { item } of group.matches) for (const mapping of importRewrite(item)!) {
      expect(group.mappings.some((rule) => matchesRewrite(mapping, rule))).toBe(true);
    }
    expect(group.matches.map(({ item }) => item.id)).toEqual(["a", "b"]);
  });

  it("does not infer a prefix from one source or accept a changed suffix", () => {
    const a = match("a", '@@ -1 +1 @@\n-import { a } from "@old/date";\n+import { a } from "@new/date";');
    const b = match("b", a.item.patch);
    expect(partitionChanges([a, b]).transformations[0]!.mappings).toEqual([{ before: "@old/date", after: "@new/date" }]);
    expect(matchesRewrite({ before: "@old/date", after: "@new/time" }, { before: "@old/", after: "@new/", prefix: true })).toBe(false);
    expect(prefixRewrite({ before: "@old/../date", after: "@new/date" })).toBeNull();
  });
});

describe("diagram policy", () => {
  it.each(['%%{init: {"securityLevel":"loose"}}%%\ngraph LR\nA-->B', '---\nconfig: {}\n---\ngraph LR\nA-->B', 'graph LR\nclick A "javascript:alert(1)"', 'graph LR\nA["<img src=x onerror=alert(1)>"]', "x".repeat(20_001)])("rejects active content and oversized source", (source) => {
    expect(diagramSourceError(source)).not.toBeNull();
  });
  it("allows plain flow and sequence explanations", () => {
    expect(diagramSourceError('flowchart LR\nA["src/utils"] --> B["packages/shared"]')).toBeNull();
    expect(diagramSourceError('sequenceDiagram\nClient->>Server: Request')).toBeNull();
  });
});

describe("TIDY-477 recorded migration", () => {
  it("groups distinct renamed import migrations and preserves the mixed hunk", async () => {
    const { default: fixture } = await import("./fixtures/tidy-477.json");
    const matches = fixture.matches as ItemMatch[];
    const result = partitionChanges(matches);
    const grouped = result.transformations.flatMap((group) => group.matches.map(({ item }) => item.id));
    expect(grouped.sort()).toEqual([...fixture.expectedGroupedItemIds].sort());
    expect(result.transformations.some((group) => group.mappings.some((rule) => rule.prefix))).toBe(true);
    expect(result.individual.map(({ file }) => file.filePath)).toEqual(["client/application/debug/DexieConsole.svelte"]);
    expect([...grouped, ...result.individual.map(({ item }) => item.id)].sort()).toEqual(matches.map(({ item }) => item.id).sort());
  });
});
