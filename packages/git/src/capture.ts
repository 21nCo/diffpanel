import { basename, extname, join, resolve } from "node:path";
import { readFile, realpath } from "node:fs/promises";
import {
  sha256,
  stableId,
  type ReviewItem,
  type ReviewScope,
} from "@diffpanel/core";
import { gitBuffer, gitText } from "./process.js";
import type { CaptureRequest, CapturedFile, CapturedReview } from "./types.js";

interface ChangedPath {
  status: CapturedFile["status"];
  filePath: string;
  oldPath: string | null;
}

type ChangedScope = Exclude<ReviewScope, { type: "repository" }>;

const MAX_FILE_SIZE = 2 * 1024 * 1024;
const MAX_REPOSITORY_BYTES = 64 * 1024 * 1024;

export async function captureReview(request: CaptureRequest): Promise<CapturedReview> {
  const repositoryRoot = await resolveRepositoryRoot(request.repository ?? process.cwd());
  const normalized = request.type === "auto"
    ? await detectDefaultRequest(repositoryRoot)
    : request;

  if (normalized.type === "repository") {
    return await captureRepositorySnapshot(repositoryRoot, normalized.ref ?? "HEAD", normalized.maxFiles ?? 2_000);
  }

  const scope = await resolveScope(repositoryRoot, normalized);
  const changedPaths = await listChangedPaths(repositoryRoot, scope);
  const files: CapturedFile[] = [];
  const skipped: Array<{ filePath: string; reason: string }> = [];

  for (const changedPath of changedPaths) {
    const captured = await captureChangedFile(repositoryRoot, scope, changedPath);
    if ("reason" in captured) {
      skipped.push({ filePath: changedPath.filePath, reason: captured.reason });
    } else {
      files.push(captured);
    }
  }

  if (files.length === 0) {
    const detail = skipped.length > 0 ? ` (${skipped.length} unsupported files were skipped)` : "";
    throw new Error(`No reviewable changes found${detail}. Use --repo for a repository snapshot.`);
  }

  return await buildCapturedReview(repositoryRoot, scope, files, skipped);
}

async function resolveRepositoryRoot(start: string): Promise<string> {
  const absolute = resolve(start);
  const root = await gitText(absolute, ["rev-parse", "--show-toplevel"]);
  return await realpath(root);
}

async function detectDefaultRequest(repositoryRoot: string): Promise<Exclude<CaptureRequest, { type: "auto" }>> {
  const status = await gitBuffer(repositoryRoot, ["status", "--porcelain=v1", "-z"]);
  if (status.length > 0) return { type: "worktree", repository: repositoryRoot };

  const baseRef = await detectBaseRef(repositoryRoot);
  const currentSha = await gitText(repositoryRoot, ["rev-parse", "HEAD"]);
  const baseSha = await gitText(repositoryRoot, ["rev-parse", baseRef]);
  if (currentSha !== baseSha) {
    return { type: "range", repository: repositoryRoot, expression: `${baseRef}...HEAD` };
  }
  throw new Error("The working tree and current branch have no changes. Use --repo to review the repository snapshot.");
}

async function detectBaseRef(repositoryRoot: string): Promise<string> {
  for (const candidate of ["main", "master", "origin/main", "origin/master"]) {
    try {
      await gitText(repositoryRoot, ["rev-parse", "--verify", candidate]);
      return candidate;
    } catch {
      // Continue to the next conventional base ref.
    }
  }
  return "HEAD";
}

async function resolveScope(
  repositoryRoot: string,
  request: Exclude<CaptureRequest, { type: "auto" | "repository" }>,
): Promise<ChangedScope> {
  if (request.type === "worktree" || request.type === "staged") {
    const baseRef = request.baseRef ?? "HEAD";
    const baseSha = await gitText(repositoryRoot, ["rev-parse", baseRef]);
    return { type: request.type, baseRef, baseSha };
  }

  const match = request.expression.match(/^(.+?)(\.\.\.?)(.+)$/);
  if (!match) throw new Error(`Invalid range '${request.expression}'. Use base..compare or base...compare.`);
  const [, baseRef, operator, compareRef] = match;
  if (!baseRef || !compareRef || !operator) throw new Error(`Invalid range '${request.expression}'.`);
  const resolvedBase = operator === "..."
    ? await gitText(repositoryRoot, ["merge-base", baseRef, compareRef])
    : await gitText(repositoryRoot, ["rev-parse", baseRef]);
  const compareSha = await gitText(repositoryRoot, ["rev-parse", compareRef]);
  return {
    type: "range",
    expression: request.expression,
    baseRef,
    compareRef,
    baseSha: resolvedBase,
    compareSha,
    mergeBase: operator === "...",
  };
}

async function listChangedPaths(repositoryRoot: string, scope: ChangedScope): Promise<ChangedPath[]> {
  const args = ["diff", "--name-status", "-z", "--find-renames"];
  if (scope.type === "staged") args.push("--cached", scope.baseSha);
  else if (scope.type === "worktree") args.push(scope.baseSha);
  else if (scope.type === "range") args.push(scope.baseSha, scope.compareSha);

  const records = parseNameStatus(await gitBuffer(repositoryRoot, args));
  if (scope.type === "worktree") {
    const untracked = splitNull(await gitBuffer(repositoryRoot, ["ls-files", "--others", "--exclude-standard", "-z"]));
    const existing = new Set(records.map((record) => record.filePath));
    for (const filePath of untracked) {
      if (!existing.has(filePath)) records.push({ status: "added", filePath, oldPath: null });
    }
  }
  return records;
}

export function parseNameStatus(buffer: Buffer): ChangedPath[] {
  const fields = splitNull(buffer);
  const records: ChangedPath[] = [];
  let index = 0;
  while (index < fields.length) {
    const statusCode = fields[index++];
    if (!statusCode) continue;
    const code = statusCode[0];
    if (code === "R" || code === "C") {
      const oldPath = fields[index++];
      const filePath = fields[index++];
      if (!oldPath || !filePath) throw new Error("Malformed renamed/copied path record from Git.");
      records.push({ status: code === "R" ? "renamed" : "copied", oldPath, filePath });
      continue;
    }
    const filePath = fields[index++];
    if (!filePath) throw new Error("Malformed changed path record from Git.");
    records.push({ status: mapStatus(code), oldPath: null, filePath });
  }
  return records;
}

function splitNull(buffer: Buffer): string[] {
  return buffer.toString("utf8").split("\0").filter(Boolean);
}

function mapStatus(code: string | undefined): CapturedFile["status"] {
  if (code === "A") return "added";
  if (code === "M" || code === "T") return "modified";
  if (code === "D") return "deleted";
  if (code === "U") return "unmerged";
  return "unknown";
}

async function captureChangedFile(
  repositoryRoot: string,
  scope: ChangedScope,
  changedPath: ChangedPath,
): Promise<CapturedFile | { reason: string }> {
  const beforePath = changedPath.oldPath ?? changedPath.filePath;
  const beforeContent = await readBeforeContent(repositoryRoot, scope, beforePath, changedPath.status);
  const afterContent = await readAfterContent(repositoryRoot, scope, changedPath.filePath, changedPath.status);
  const largest = Math.max(beforeContent?.length ?? 0, afterContent?.length ?? 0);
  if (largest > MAX_FILE_SIZE) return { reason: `file exceeds ${MAX_FILE_SIZE} bytes` };
  if (isBinary(beforeContent) || isBinary(afterContent)) return { reason: "binary file" };

  const patch = await readPatch(repositoryRoot, scope, changedPath, beforeContent, afterContent);
  const items = parseHunks(patch, changedPath);
  // Git can report a real path/mode change without producing a textual hunk.
  // Keep its metadata as review evidence, including an empty file rename.
  if (items.length === 0) {
    const contentHash = sha256(patch || JSON.stringify(changedPath));
    items.push({
      id: stableId("item", changedPath.filePath, changedPath.oldPath, contentHash),
      kind: "file",
      ...changedPath,
      ordinal: 0,
      oldStart: null, oldLines: null, newStart: null, newLines: null,
      patch,
      contentHash,
    });
  }
  const additions = items.reduce((total, item) => total + countPatchLines(item.patch, "+"), 0);
  const deletions = items.reduce((total, item) => total + countPatchLines(item.patch, "-"), 0);
  return {
    id: stableId("file", changedPath.filePath, changedPath.oldPath, changedPath.status),
    ...changedPath,
    beforeContent,
    afterContent,
    additions,
    deletions,
    language: languageForPath(changedPath.filePath),
    size: afterContent?.length ?? beforeContent?.length ?? 0,
    items,
  };
}

async function readBeforeContent(
  repositoryRoot: string,
  scope: ChangedScope,
  filePath: string,
  status: CapturedFile["status"],
): Promise<Buffer | null> {
  if (status === "added") return null;
  return await readGitObject(repositoryRoot, scope.baseSha, filePath);
}

async function readAfterContent(
  repositoryRoot: string,
  scope: ChangedScope,
  filePath: string,
  status: CapturedFile["status"],
): Promise<Buffer | null> {
  if (status === "deleted") return null;
  if (scope.type === "worktree") return await readFile(join(repositoryRoot, filePath));
  if (scope.type === "staged") return await readGitObject(repositoryRoot, "", filePath, true);
  if (scope.type === "range") return await readGitObject(repositoryRoot, scope.compareSha, filePath);
  return null;
}

async function readGitObject(
  repositoryRoot: string,
  ref: string,
  filePath: string,
  index = false,
): Promise<Buffer | null> {
  const spec = index ? `:${filePath}` : `${ref}:${filePath}`;
  try {
    return await gitBuffer(repositoryRoot, ["show", spec]);
  } catch {
    return null;
  }
}

async function readPatch(
  repositoryRoot: string,
  scope: ChangedScope,
  changedPath: ChangedPath,
  beforeContent: Buffer | null,
  afterContent: Buffer | null,
): Promise<string> {
  if (changedPath.status === "added" && beforeContent === null && afterContent !== null) {
    return syntheticAdditionPatch(afterContent.toString("utf8"));
  }
  const args = ["diff", "--no-ext-diff", "--no-color", "--unified=3"];
  if (scope.type === "staged") args.push("--cached", scope.baseSha);
  else if (scope.type === "worktree") args.push(scope.baseSha);
  else if (scope.type === "range") args.push(scope.baseSha, scope.compareSha);
  const paths = changedPath.oldPath
    ? [changedPath.oldPath, changedPath.filePath]
    : [changedPath.filePath];
  args.push("--", ...paths);
  return (await gitBuffer(repositoryRoot, args)).toString("utf8");
}

function syntheticAdditionPatch(content: string): string {
  const sourceLines = content === "" ? [] : content.replace(/\n$/, "").split("\n");
  const count = sourceLines.length;
  return [`@@ -0,0 +1,${count} @@`, ...sourceLines.map((line) => `+${line}`)].join("\n");
}

export function parseHunks(patch: string, changedPath: ChangedPath): ReviewItem[] {
  const lines = patch.split("\n");
  const hunks: ReviewItem[] = [];
  let current: string[] | null = null;
  let coordinates: RegExpMatchArray | null = null;

  const flush = () => {
    if (!current || !coordinates) return;
    const oldStart = Number(coordinates[1]);
    const oldLines = Number(coordinates[2] ?? 1);
    const newStart = Number(coordinates[3]);
    const newLines = Number(coordinates[4] ?? 1);
    const hunkPatch = current.join("\n");
    const ordinal = hunks.length;
    hunks.push({
      id: stableId("item", changedPath.filePath, oldStart, newStart, sha256(hunkPatch)),
      kind: "hunk",
      filePath: changedPath.filePath,
      oldPath: changedPath.oldPath,
      status: changedPath.status,
      ordinal,
      oldStart,
      oldLines,
      newStart,
      newLines,
      patch: hunkPatch,
      contentHash: sha256(hunkPatch),
    });
  };

  for (const line of lines) {
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (match) {
      flush();
      coordinates = match;
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  flush();
  return hunks;
}

function countPatchLines(patch: string, prefix: "+" | "-"): number {
  return patch.split("\n").filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`)).length;
}

function isBinary(content: Buffer | null): boolean {
  return content?.includes(0) ?? false;
}

function languageForPath(filePath: string): string | null {
  const extension = extname(filePath).slice(1).toLowerCase();
  const languages: Record<string, string> = {
    c: "c", cc: "cpp", cpp: "cpp", cs: "csharp", css: "css", go: "go", html: "html",
    java: "java", js: "javascript", json: "json", jsx: "javascriptreact", kt: "kotlin",
    md: "markdown", php: "php", py: "python", rb: "ruby", rs: "rust", sh: "shellscript",
    sql: "sql", svelte: "svelte", swift: "swift", ts: "typescript", tsx: "typescriptreact",
    vue: "vue", yaml: "yaml", yml: "yaml",
  };
  return languages[extension] ?? (extension || null);
}

async function captureRepositorySnapshot(
  repositoryRoot: string,
  ref: string,
  maxFiles: number,
): Promise<CapturedReview> {
  const sha = await gitText(repositoryRoot, ["rev-parse", ref]);
  const allPaths = splitNull(await gitBuffer(repositoryRoot, ["ls-tree", "-r", "--name-only", "-z", sha]));
  const files: CapturedFile[] = [];
  const skipped: Array<{ filePath: string; reason: string }> = [];
  let totalBytes = 0;

  for (const filePath of allPaths) {
    if (files.length >= maxFiles) {
      skipped.push({ filePath, reason: `repository file limit ${maxFiles} reached` });
      continue;
    }
    if (isGeneratedOrVendorPath(filePath)) {
      skipped.push({ filePath, reason: "generated, vendored, or lock file" });
      continue;
    }
    const content = await readGitObject(repositoryRoot, sha, filePath);
    if (content === null) {
      skipped.push({ filePath, reason: "could not read Git object" });
      continue;
    }
    if (content.length > MAX_FILE_SIZE) {
      skipped.push({ filePath, reason: `file exceeds ${MAX_FILE_SIZE} bytes` });
      continue;
    }
    if (totalBytes + content.length > MAX_REPOSITORY_BYTES) {
      skipped.push({ filePath, reason: `repository content limit ${MAX_REPOSITORY_BYTES} bytes reached` });
      continue;
    }
    if (isBinary(content)) {
      skipped.push({ filePath, reason: "binary file" });
      continue;
    }
    totalBytes += content.length;
    const source = content.toString("utf8");
    const previewLines = source.split("\n").slice(0, 240);
    const truncated = source.split("\n").length > previewLines.length;
    const patch = [
      ...previewLines.map((line, index) => `${String(index + 1).padStart(5)} | ${line}`),
      ...(truncated ? ["[file preview truncated; inspect the repository for the full source]"] : []),
    ].join("\n");
    const itemId = stableId("item", sha, filePath, sha256(content));
    files.push({
      id: stableId("file", sha, filePath),
      filePath,
      oldPath: null,
      status: "snapshot",
      beforeContent: null,
      afterContent: content,
      additions: 0,
      deletions: 0,
      language: languageForPath(filePath),
      size: content.length,
      items: [{
        id: itemId,
        kind: "file",
        filePath,
        oldPath: null,
        status: "snapshot",
        ordinal: 0,
        oldStart: null,
        oldLines: null,
        newStart: 1,
        newLines: source === "" ? 0 : source.split("\n").length,
        patch,
        contentHash: sha256(content),
      }],
    });
  }

  if (files.length === 0) throw new Error("The repository snapshot contains no reviewable text files.");
  const scope: ReviewScope = { type: "repository", ref, sha, maxFiles };
  return await buildCapturedReview(repositoryRoot, scope, files, skipped);
}

function isGeneratedOrVendorPath(filePath: string): boolean {
  const path = `/${filePath.toLowerCase()}/`;
  if (["/node_modules/", "/vendor/", "/dist/", "/build/", "/.next/", "/.turbo/", "/coverage/"].some((part) => path.includes(part))) {
    return true;
  }
  return /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|cargo\.lock|composer\.lock)$/.test(filePath.toLowerCase());
}

async function buildCapturedReview(
  repositoryRoot: string,
  scope: ReviewScope,
  files: CapturedFile[],
  skipped: Array<{ filePath: string; reason: string }>,
): Promise<CapturedReview> {
  return {
    repositoryId: stableId("repo", repositoryRoot),
    repositoryRoot,
    repositoryName: basename(repositoryRoot),
    scope,
    files,
    skipped,
  };
}
