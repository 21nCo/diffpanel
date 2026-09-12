import { describe, expect, it } from "vitest";
import type { StoredRun } from "@diffpanel/storage";
import { buildDiagramDocument } from "./diagram-document.js";

function fixture(): StoredRun {
  return {
    summary: { runId: "run-1", reviewTitle: "Migration" },
    manifest: { files: [{ filePath: "hosts.ts", items: [{ id: "item-1", kind: "hunk", newStart: 4, newLines: 1 }] }] },
    review: {
      prologue: { motivation: "Separate responsibilities.", outcome: "Hosts are isolated.", keyChanges: [{ summary: "Move hosts", description: "Preserve initialization." }], diagram: "flowchart LR\nOld-->New", diagramItemRefs: ["item-1", "item-1"] },
      chapters: [{ id: "child", parentId: "parent", title: "Host initialization", summary: "Initialize hosts.", keyChanges: [{ content: "Keep ordering." }], diagram: "flowchart LR\nShell-->Hosts", diagramItemRefs: ["item-1"] }],
    },
  } as unknown as StoredRun;
}

describe("diagram editor documents", () => {
  it("pairs the overview diagram with its explanation and deduplicated saved evidence", () => {
    const document = buildDiagramDocument(fixture());
    expect(document.title).toBe("Migration");
    expect(document.markdown).toContain("Separate responsibilities.");
    expect(document.markdown).toContain("Preserve initialization.");
    expect(document.markdown).toContain("```mermaid\nflowchart LR\nOld-->New\n```");
    expect(document.evidence).toHaveLength(1);
    expect(document.evidence[0]).toMatchObject({ itemId: "item-1" });
    expect(document.markdown).toContain("hosts.ts");
  });

  it("uses a nested chapter's own explanation and source", () => {
    const document = buildDiagramDocument(fixture(), "child");
    expect(document.title).toBe("Host initialization");
    expect(document.markdown).toContain("Keep ordering.");
    expect(document.markdown).toContain("Shell-->Hosts");
    expect(document.markdown).not.toContain("Old-->New");
  });

  it("preserves source containing fences and supports older diagrams without references", () => {
    const run = fixture();
    run.review!.prologue.diagram = "flowchart LR\nA[\"```\"]-->B";
    delete run.review!.prologue.diagramItemRefs;
    const document = buildDiagramDocument(run);
    expect(document.markdown).toContain("````mermaid\n");
    expect(document.markdown).toContain("older review");
  });

  it("rejects missing selections and unresolved evidence instead of opening the wrong diagram", () => {
    const run = fixture();
    expect(() => buildDiagramDocument(run, "missing")).toThrow("Unknown diagram chapter");
    run.review!.prologue.diagramItemRefs = ["missing"];
    expect(() => buildDiagramDocument(run)).toThrow("Unknown diagram evidence");
    run.review!.prologue.diagram = null;
    expect(() => buildDiagramDocument(run)).toThrow("No diagram");
  });
});
