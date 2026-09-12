import type { Chapter, ReviewFile, ReviewItem } from "@diffpanel/core";
import { diffCounts } from "./presentation.js";

export interface ItemMatch { file: ReviewFile; item: ReviewItem }
export interface FileGroup {
  file: ReviewFile;
  items: ReviewItem[];
  additions: number;
  deletions: number;
}
export interface Transformation {
  key: string;
  kind: "imports" | "moves";
  mappings: Array<{ before: string; after: string; prefix?: boolean }>;
  matches: ItemMatch[];
}

export function groupFiles(matches: ItemMatch[]): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  const seen = new Set<string>();
  for (const { file, item } of matches) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const group = groups.get(file.id) ?? { file, items: [], additions: 0, deletions: 0 };
    group.items.push(item);
    const counts = diffCounts(file, item);
    group.additions += counts.additions;
    group.deletions += counts.deletions;
    groups.set(file.id, group);
  }
  return [...groups.values()].map((group) => ({
    ...group, items: group.items.sort((a, b) => a.ordinal - b.ordinal),
  }));
}

export function otherFileChapters(file: ReviewFile, chapters: Chapter[], currentId?: string): Chapter[] {
  const refs = new Set(file.items.map((item) => item.id));
  return chapters.filter((chapter) => chapter.id !== currentId && chapter.itemRefs.some((ref) => refs.has(ref)));
}

// Deliberately a textual classifier, not a claim about module resolution or runtime behavior.
// Only complete, single-line static imports/re-exports with unchanged syntax qualify.
function importLine(line: string): { source: string; shape: string } | null {
  const match = /^(\s*(?:import\s+(?:type\s+)?[\w$*{},\s]+\s+from\s*|export\s+(?:type\s+)?(?:\*|\{[\w$,\s]*\})\s+from\s*|import\s*))(["'])([^"'\\\r\n]+)\2(\s*;?\s*)$/.exec(line);
  if (!match) return null;
  return { source: match[3]!, shape: `${match[1]}${match[2]}SOURCE${match[2]}${match[4]}` };
}

export function importRewrite(item: ReviewItem): Transformation["mappings"] | null {
  if (item.kind !== "hunk" || !["modified", "renamed"].includes(item.status)) return null;
  const mappings = new Map<string, { before: string; after: string }>();
  let removed: string[] = [];
  let added: string[] = [];
  let valid = true;
  const flush = (): void => {
    if (removed.length !== added.length) valid = false;
    for (let i = 0; i < removed.length; i += 1) {
      const before = importLine(removed[i]!);
      const after = importLine(added[i] ?? "");
      if (!before || !after || before.shape !== after.shape || before.source === after.source) {
        valid = false;
      } else {
        const mapping = { before: before.source, after: after.source };
        mappings.set(JSON.stringify(mapping), mapping);
      }
    }
    removed = [];
    added = [];
  };
  for (const line of item.patch.split("\n")) {
    if (line.startsWith("@@") || line.startsWith("\\")) { flush(); continue; }
    if (line.startsWith("-")) removed.push(line.slice(1));
    else if (line.startsWith("+")) added.push(line.slice(1));
    else flush();
  }
  flush();
  return valid && mappings.size > 0
    ? [...mappings.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    : null;
}

export function isExactMove(file: ReviewFile): boolean {
  return file.status === "renamed" && !!file.oldPath && file.oldPath !== file.filePath
    && file.beforeBlob !== null && file.beforeBlob === file.afterBlob;
}

/** Infer a segment-aligned prefix rule; every concrete suffix must remain identical. */
export function prefixRewrite(mapping: { before: string; after: string }): Transformation["mappings"][number] | null {
  const before = mapping.before.split("/");
  const after = mapping.after.split("/");
  let common = 0;
  while (common < Math.min(before.length, after.length) - 1
    && before[before.length - common - 1] === after[after.length - common - 1]) common += 1;
  if (common === 0) return null;
  const from = `${before.slice(0, -common).join("/")}/`;
  const to = `${after.slice(0, -common).join("/")}/`;
  // Literal wildcard paths and dot-segment paths do not support an unambiguous rule.
  if (from === to || [...before, ...after].some((part) => !part || part === "." || part === ".." || part.includes("*"))) return null;
  return { before: from, after: to, prefix: true };
}

export function matchesRewrite(mapping: { before: string; after: string }, rule: Transformation["mappings"][number]): boolean {
  return rule.prefix
    ? mapping.before.startsWith(rule.before) && mapping.before.length > rule.before.length
      && mapping.after === rule.after + mapping.before.slice(rule.before.length)
    : mapping.before === rule.before && mapping.after === rule.after;
}

export function moveDescription(file: ReviewFile): string {
  if (isExactMove(file)) return "Identical content";
  return file.items.length > 0 && file.items.every((item) => importRewrite(item) !== null)
    ? "Moved + import rewrite" : "Moved and edited";
}

export function partitionChanges(matches: ItemMatch[]): { transformations: Transformation[]; individual: ItemMatch[] } {
  const candidates = new Map<string, Transformation>();
  const unique = [...new Map(matches.map((match) => [match.item.id, match])).values()];
  const rewrites = new Map(unique.map(({ item }) => [item.id, importRewrite(item)]));
  const prefixes = new Map<string, { rule: Transformation["mappings"][number]; sources: Set<string>; files: Set<string> }>();
  for (const { file, item } of unique) {
    for (const mapping of rewrites.get(item.id) ?? []) {
      const rule = prefixRewrite(mapping);
      if (!rule) continue;
      const key = JSON.stringify(rule);
      const entry = prefixes.get(key) ?? { rule, sources: new Set<string>(), files: new Set<string>() };
      entry.sources.add(mapping.before);
      entry.files.add(file.id);
      prefixes.set(key, entry);
    }
  }
  // A repeated edit of one module is an exact mapping, not evidence of a prefix migration.
  const supported = new Set([...prefixes].filter(([, entry]) => entry.sources.size >= 2 && entry.files.size >= 2).map(([key]) => key));
  for (const match of unique) {
    const move = isExactMove(match.file);
    const concrete = move ? [] : rewrites.get(match.item.id);
    if (concrete == null) continue;
    const rules = concrete.map((mapping) => {
      const prefix = prefixRewrite(mapping);
      return prefix && supported.has(JSON.stringify(prefix)) && matchesRewrite(mapping, prefix) ? prefix : mapping;
    });
    const mappings = [...new Map(rules.map((rule) => [JSON.stringify(rule), rule])).values()]
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const key = move ? "exact-moves" : JSON.stringify(mappings);
    const group = candidates.get(key) ?? { key, kind: move ? "moves" : "imports", mappings, matches: [] };
    group.matches.push(match);
    candidates.set(key, group);
  }
  const transformations = [...candidates.values()].filter((group) => new Set(group.matches.map(({ file }) => file.id)).size >= 2);
  const grouped = new Set(transformations.flatMap((group) => group.matches.map(({ item }) => item.id)));
  return { transformations, individual: unique.filter(({ item }) => !grouped.has(item.id)) };
}
