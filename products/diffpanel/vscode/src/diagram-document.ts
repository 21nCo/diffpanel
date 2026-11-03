import type { StoredRun } from "@diffpanel/storage";
import { itemLocationLabel } from "@diffpanel/presentation";

export interface DiagramDocument {
  title: string;
  source: string;
  markdown: string;
  evidence: Array<{ itemId: string; label: string }>;
}

export function buildDiagramDocument(run: StoredRun, chapterId?: string): DiagramDocument {
  if (!run.review) throw new Error("This review has not been generated yet.");
  const chapter = chapterId === undefined ? undefined : run.review.chapters.find((candidate) => candidate.id === chapterId);
  if (chapterId !== undefined && !chapter) throw new Error(`Unknown diagram chapter ${chapterId}.`);
  const source = chapter ? chapter.diagram : run.review.prologue.diagram;
  if (!source?.trim()) throw new Error("No diagram was generated for this selection.");
  const title = chapter?.title ?? run.summary.reviewTitle;
  const refs = chapter ? chapter.diagramItemRefs ?? [] : run.review.prologue.diagramItemRefs ?? [];
  const items = new Map(run.manifest.files.flatMap((file) => file.items.map((item) => [item.id, { file, item }] as const)));
  const evidence = [...new Set(refs)].map((ref) => {
    const match = items.get(ref);
    if (!match) throw new Error(`Unknown diagram evidence ${ref}.`);
    return { itemId: ref, label: `${match.file.filePath} — ${itemLocationLabel(match.item)}` };
  });
  const explanation = chapter
    ? [chapter.summary, ...chapter.keyChanges.map((change) => change.content)]
    : [run.review.prologue.motivation, run.review.prologue.outcome, ...run.review.prologue.keyChanges.map((change) => `${change.summary}\n\n${change.description}`)].filter((text): text is string => !!text);
  // A longer fence preserves author source even if it itself contains backticks.
  const fence = "`".repeat(Math.max(3, ...[...source.matchAll(/`+/g)].map((match) => match[0].length + 1)));
  const markdown = [
    `# ${title}`, "", ...explanation.flatMap((text) => [text, ""]),
    "## Diagram", "", `${fence}mermaid`, source, fence, "",
    "## Saved evidence", "", ...evidence.map((entry) => `- ${entry.label} (${entry.itemId})`),
    ...(evidence.length ? [] : ["No explicit evidence references were recorded in this older review."]),
    "", `Review: ${run.summary.runId}`, "", "Generated explanation; verify its claims against the saved evidence.", "",
  ].join("\n");
  return { title, source, markdown, evidence };
}
