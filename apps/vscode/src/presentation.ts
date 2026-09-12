import type { Chapter, ReviewFile, ReviewItem } from "@diffpanel/core";

export function chapterLabels(chapters: Chapter[]): Map<string, string> {
  const labels = new Map<string, string>();
  const children = new Map<string | null, Chapter[]>();
  for (const chapter of chapters) {
    const siblings = children.get(chapter.parentId) ?? [];
    siblings.push(chapter);
    children.set(chapter.parentId, siblings);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => a.order - b.order);

  const visit = (parentId: string | null, depth: number): void => {
    for (const [index, chapter] of (children.get(parentId) ?? []).entries()) {
      labels.set(chapter.id, depth === 0 ? String(index + 1) : alphabetic(index));
      visit(chapter.id, depth + 1);
    }
  };
  visit(null, 0);
  return labels;
}

export function chapterItemRefs(chapters: Chapter[], chapterId: string): string[] {
  const byParent = new Map<string, Chapter[]>();
  for (const chapter of chapters) {
    if (chapter.parentId === null) continue;
    const children = byParent.get(chapter.parentId) ?? [];
    children.push(chapter);
    byParent.set(chapter.parentId, children);
  }
  const byId = new Map(chapters.map((chapter) => [chapter.id, chapter] as const));
  const refs: string[] = [];
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const chapter = byId.get(id);
    if (!chapter) return;
    refs.push(...chapter.itemRefs);
    for (const child of byParent.get(id) ?? []) visit(child.id);
  };
  visit(chapterId);
  return refs;
}

export function childChapters(chapters: Chapter[], chapterId: string): Chapter[] {
  return chapters
    .filter((chapter) => chapter.parentId === chapterId)
    .slice()
    .sort((a, b) => a.order - b.order);
}

export function uniqueFileCount(files: ReviewFile[], itemRefs: string[]): number {
  const wanted = new Set(itemRefs);
  return files.filter((file) => file.items.some((item) => wanted.has(item.id))).length;
}

export function diffCounts(file: ReviewFile, item: ReviewItem): { additions: number; deletions: number } {
  if (item.kind === "file") return { additions: file.additions, deletions: file.deletions };
  let additions = 0;
  let deletions = 0;
  for (const line of item.patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

export function itemLocationLabel(item: ReviewItem): string {
  if (item.kind === "file") return item.status === "snapshot" ? "snapshot" : item.status === "renamed" ? "path change" : "file change";
  if (item.status === "deleted") return "deleted";
  const line = item.newStart && item.newStart > 0 ? item.newStart : item.oldStart ?? 1;
  return `line ${line}`;
}

function alphabetic(index: number): string {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(97 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}
