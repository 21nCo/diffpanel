import { basename, extname, isAbsolute, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import {
  type ReviewItem,
  type ReviewScope,
} from "diffpanel";
import { sha256, stableId } from "diffpanel/node";
import { gitBuffer, gitText, runProcess, type ProcessOptions } from "./process.js";
import { readWorktreeFile, WorktreeFileTooLargeError } from "./worktree-file.js";
import type { CaptureLimits, CaptureOptions, CaptureRequest, CapturedFile, CapturedReview } from "./types.js";

interface ChangedPath {
  status: CapturedFile["status"];
  filePath: string;
  oldPath: string | null;
}

type ChangedScope = Exclude<ReviewScope, { type: "repository" }>;

export const DEFAULT_CAPTURE_LIMITS: Readonly<CaptureLimits> = {
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxFiles: 10_000,
  maxProcessOutputBytes: 16 * 1024 * 1024,
  processTimeoutMs: 30_000,
};

const MAX_CAPTURE_ATTEMPTS = 2;

export async function captureReview(request: CaptureRequest, options: CaptureOptions = {}): Promise<CapturedReview> {
  const limits = resolveLimits(options.limits);
  const processOptions = toProcessOptions(options, limits);
  const repositoryRoot = await resolveRepositoryRoot(request.repository ?? process.cwd(), processOptions);
  const normalized = request.type === "auto"
    ? await detectDefaultRequest(repositoryRoot, processOptions)
    : request;

  if (normalized.type === "repository") {
    const requestedMaxFiles = normalized.maxFiles ?? 2_000;
    if (!Number.isSafeInteger(requestedMaxFiles) || requestedMaxFiles <= 0) {
      throw new Error("Repository maxFiles must be a positive integer.");
    }
    return await captureRepositorySnapshot(
      repositoryRoot,
      normalized.ref ?? "HEAD",
      Math.min(requestedMaxFiles, limits.maxFiles),
      limits,
      options,
      processOptions,
    );
  }

  let scope = await resolveScope(repositoryRoot, normalized, processOptions);
  for (let attempt = 1; attempt <= MAX_CAPTURE_ATTEMPTS; attempt += 1) {
    const liveIndex = scope.type === "staged" && !scope.indexSha;
    const indexBefore = liveIndex
      ? await indexSignature(repositoryRoot, processOptions)
      : null;
    let captured: Awaited<ReturnType<typeof captureChangedScope>>;
    let verified: Awaited<ReturnType<typeof captureChangedScope>>;
    try {
      captured = await captureChangedScope(repositoryRoot, scope, limits, options, processOptions);
      options.onProgress?.({ phase: "verify", current: attempt, total: MAX_CAPTURE_ATTEMPTS });
      if (scope.type === "range" || (scope.type === "staged" && scope.indexSha)) {
        return await buildCapturedReview(repositoryRoot, scope, captured.files, captured.skipped);
      }
      verified = await captureChangedScope(repositoryRoot, scope, limits, { signal: options.signal }, processOptions);
    } catch (error) {
      if (liveIndex && attempt < MAX_CAPTURE_ATTEMPTS && !options.signal?.aborted
        && indexBefore !== await indexSignature(repositoryRoot, processOptions)) {
        scope = await resolveScope(repositoryRoot, normalized, processOptions);
        continue;
      }
      throw error;
    }
    const indexAfter = liveIndex
      ? await indexSignature(repositoryRoot, processOptions)
      : null;
    if (captureFingerprint(captured) === captureFingerprint(verified)
      && (indexBefore === null || indexBefore === indexAfter)) {
      return await buildCapturedReview(repositoryRoot, scope, captured.files, captured.skipped);
    }
    if (attempt === MAX_CAPTURE_ATTEMPTS) {
      throw new Error("Repository files or index changed during capture. Retry after the working tree is stable.");
    }
    if (liveIndex) scope = await resolveScope(repositoryRoot, normalized, processOptions);
  }
  throw new Error("Capture failed before producing a stable snapshot.");
}

async function indexSignature(repositoryRoot: string, processOptions: ProcessOptions): Promise<string> {
  const indexPath = await gitText(repositoryRoot, ["rev-parse", "--git-path", "index"], processOptions);
  return await gitText(repositoryRoot, ["hash-object", "--no-filters", "--", indexPath], processOptions);
}

async function resolveRepositoryRoot(start: string, processOptions: ProcessOptions): Promise<string> {
  const absolute = resolve(start);
  const root = await gitText(absolute, ["rev-parse", "--show-toplevel"], processOptions);
  return await realpath(root);
}

async function detectDefaultRequest(repositoryRoot: string, processOptions: ProcessOptions): Promise<Exclude<CaptureRequest, { type: "auto" }>> {
  const status = await gitBuffer(repositoryRoot, ["status", "--porcelain=v1", "-z"], processOptions);
  if (status.length > 0) return { type: "worktree", repository: repositoryRoot };

  const baseRef = await detectBaseRef(repositoryRoot, processOptions);
  const currentSha = await gitText(repositoryRoot, ["rev-parse", "HEAD"], processOptions);
  const baseSha = await gitText(repositoryRoot, ["rev-parse", baseRef], processOptions);
  if (currentSha !== baseSha) {
    return { type: "range", repository: repositoryRoot, expression: `${baseRef}...HEAD` };
  }
  throw new Error("The working tree and current branch have no changes. Use --repo to review the repository snapshot.");
}

async function detectBaseRef(repositoryRoot: string, processOptions: ProcessOptions): Promise<string> {
  for (const candidate of ["main", "master", "origin/main", "origin/master"]) {
    try {
      await gitText(repositoryRoot, ["rev-parse", "--verify", candidate], processOptions);
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
  processOptions: ProcessOptions,
): Promise<ChangedScope> {
  if (request.type === "worktree" || request.type === "staged") {
    const baseRef = request.baseRef ?? "HEAD";
    validateRef(baseRef);
    const baseSha = await gitText(repositoryRoot, ["rev-parse", "--verify", baseRef], processOptions);
    if (request.type === "staged") {
      const unmerged = await gitBuffer(repositoryRoot, ["ls-files", "-u", "-z"], processOptions);
      if (unmerged.length > 0) return { type: request.type, baseRef, baseSha };
      const indexSha = await gitText(repositoryRoot, ["write-tree"], processOptions);
      return { type: request.type, baseRef, baseSha, indexSha };
    }
    return { type: request.type, baseRef, baseSha };
  }

  const match = request.expression.match(/^(.+?)(\.\.\.?)(.+)$/);
  if (!match) throw new Error(`Invalid range '${request.expression}'. Use base..compare or base...compare.`);
  const [, baseRef, operator, compareRef] = match;
  if (!baseRef || !compareRef || !operator) throw new Error(`Invalid range '${request.expression}'.`);
  validateRef(baseRef);
  validateRef(compareRef);
  const resolvedBase = operator === "..."
    ? await gitText(repositoryRoot, ["merge-base", baseRef, compareRef], processOptions)
    : await gitText(repositoryRoot, ["rev-parse", "--verify", baseRef], processOptions);
  const compareSha = await gitText(repositoryRoot, ["rev-parse", "--verify", compareRef], processOptions);
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

async function listChangedPaths(repositoryRoot: string, scope: ChangedScope, processOptions: ProcessOptions): Promise<ChangedPath[]> {
  const args = ["diff", "--name-status", "-z", "--find-renames"];
  if (scope.type === "staged") {
    if (scope.indexSha) args.push(scope.baseSha, scope.indexSha);
    else args.push("--cached", scope.baseSha);
  }
  else if (scope.type === "worktree") args.push(scope.baseSha);
  else if (scope.type === "range") args.push(scope.baseSha, scope.compareSha);

  const records = parseNameStatus(await gitBuffer(repositoryRoot, args, processOptions));
  if (scope.type === "worktree") {
    const untracked = splitNull(await gitBuffer(repositoryRoot, ["ls-files", "--others", "--exclude-standard", "-z"], processOptions));
    const existing = new Set(records.map((record) => record.filePath));
    for (const filePath of untracked) {
      assertSafeRepositoryPath(filePath);
      if (!existing.has(filePath)) records.push({ status: "added", filePath, oldPath: null });
    }
  }
  return records;
}

async function captureChangedScope(
  repositoryRoot: string,
  scope: ChangedScope,
  limits: CaptureLimits,
  options: CaptureOptions,
  processOptions: ProcessOptions,
): Promise<{
  files: CapturedFile[];
  skipped: Array<{ filePath: string; reason: string }>;
  changedPaths: ChangedPath[];
}> {
  options.onProgress?.({ phase: "discover", current: 0, total: 0 });
  const changedPaths = await listChangedPaths(repositoryRoot, scope, processOptions);
  const files: CapturedFile[] = [];
  const skipped: Array<{ filePath: string; reason: string }> = [];
  let totalBytes = 0;

  for (const [index, changedPath] of changedPaths.entries()) {
    if (options.signal?.aborted) throw new Error("Diffpanel capture was cancelled.");
    options.onProgress?.({ phase: "capture", current: index + 1, total: changedPaths.length, filePath: changedPath.filePath });
    if (files.length >= limits.maxFiles) {
      skipped.push({ filePath: changedPath.filePath, reason: `capture file limit ${limits.maxFiles} reached` });
      continue;
    }
    const captured = await captureChangedFile(repositoryRoot, scope, changedPath, limits, processOptions);
    if ("reason" in captured) {
      skipped.push({ filePath: changedPath.filePath, reason: captured.reason });
      continue;
    }
    const capturedBytes = (captured.beforeContent?.length ?? 0) + (captured.afterContent?.length ?? 0);
    if (totalBytes + capturedBytes > limits.maxTotalBytes) {
      skipped.push({ filePath: changedPath.filePath, reason: `capture content limit ${limits.maxTotalBytes} bytes reached` });
      continue;
    }
    totalBytes += capturedBytes;
    files.push(captured);
  }

  if (files.length === 0) {
    const detail = skipped.length > 0 ? ` (${skipped.length} unsupported files were skipped)` : "";
    throw new Error(`No reviewable changes found${detail}. Use --repo for a repository snapshot.`);
  }
  return { files, skipped, changedPaths };
}

function captureFingerprint(captured: Awaited<ReturnType<typeof captureChangedScope>>): string {
  return sha256(JSON.stringify({
    changedPaths: captured.changedPaths,
    skipped: captured.skipped,
    files: captured.files.map((file) => ({
      ...file,
      beforeContent: file.beforeContent?.toString("base64") ?? null,
      afterContent: file.afterContent?.toString("base64") ?? null,
    })),
  }));
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
      assertSafeRepositoryPath(oldPath);
      assertSafeRepositoryPath(filePath);
      records.push({ status: code === "R" ? "renamed" : "copied", oldPath, filePath });
      continue;
    }
    const filePath = fields[index++];
    if (!filePath) throw new Error("Malformed changed path record from Git.");
    assertSafeRepositoryPath(filePath);
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
  limits: CaptureLimits,
  processOptions: ProcessOptions,
): Promise<CapturedFile | { reason: string }> {
  const beforePath = changedPath.oldPath ?? changedPath.filePath;
  const beforeContent = await readBeforeContent(repositoryRoot, scope, beforePath, changedPath.status, processOptions);
  let afterContent: Buffer | null;
  try {
    afterContent = await readAfterContent(
      repositoryRoot,
      scope,
      changedPath.filePath,
      changedPath.status,
      limits.maxFileBytes,
      processOptions,
    );
  } catch (error) {
    if (error instanceof WorktreeFileTooLargeError) return { reason: `file exceeds ${limits.maxFileBytes} bytes` };
    throw error;
  }
  const largest = Math.max(beforeContent?.length ?? 0, afterContent?.length ?? 0);
  if (largest > limits.maxFileBytes) return { reason: `file exceeds ${limits.maxFileBytes} bytes` };
  if (isBinary(beforeContent) || isBinary(afterContent)) return { reason: "binary file" };

  const patch = await readPatch(repositoryRoot, scope, changedPath, beforeContent, afterContent, processOptions);
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
  processOptions: ProcessOptions,
): Promise<Buffer | null> {
  if (status === "added") return null;
  return await readGitObject(repositoryRoot, scope.baseSha, filePath, false, processOptions);
}

async function readAfterContent(
  repositoryRoot: string,
  scope: ChangedScope,
  filePath: string,
  status: CapturedFile["status"],
  maxFileBytes: number,
  processOptions: ProcessOptions,
): Promise<Buffer | null> {
  if (status === "deleted") return null;
  if (scope.type === "worktree") return await readWorktreeFile(repositoryRoot, filePath, maxFileBytes);
  if (scope.type === "staged") {
    return scope.indexSha
      ? await readGitObject(repositoryRoot, scope.indexSha, filePath, false, processOptions)
      : await readGitObject(repositoryRoot, "", filePath, true, processOptions);
  }
  if (scope.type === "range") return await readGitObject(repositoryRoot, scope.compareSha, filePath, false, processOptions);
  return null;
}

async function readGitObject(
  repositoryRoot: string,
  ref: string,
  filePath: string,
  index: boolean,
  processOptions: ProcessOptions,
): Promise<Buffer | null> {
  const spec = index ? `:${filePath}` : `${ref}:${filePath}`;
  const result = await runProcess("git", ["show", spec], repositoryRoot, {
    ...processOptions,
    acceptedExitCodes: [0, 128],
  });
  if (result.exitCode === 0) return result.stdout;
  const stderr = result.stderr.toString("utf8");
  if (/does not exist in|does not exist \(neither on disk nor in the index\)|exists on disk, but not in|path .* is in the index, but not at stage 0|invalid object name/.test(stderr)) return null;
  throw new Error(`git show ${spec} failed (${result.exitCode}): ${stderr.trim()}`);
}

async function readPatch(
  repositoryRoot: string,
  scope: ChangedScope,
  changedPath: ChangedPath,
  beforeContent: Buffer | null,
  afterContent: Buffer | null,
  processOptions: ProcessOptions,
): Promise<string> {
  if (changedPath.status === "added" && beforeContent === null && afterContent !== null) {
    return syntheticAdditionPatch(afterContent.toString("utf8"));
  }
  const args = ["diff", "--no-ext-diff", "--no-color", "--unified=3"];
  if (scope.type === "staged") {
    if (scope.indexSha) args.push(scope.baseSha, scope.indexSha);
    else args.push("--cached", scope.baseSha);
  }
  else if (scope.type === "worktree") args.push(scope.baseSha);
  else if (scope.type === "range") args.push(scope.baseSha, scope.compareSha);
  const paths = changedPath.oldPath
    ? [changedPath.oldPath, changedPath.filePath]
    : [changedPath.filePath];
  args.push("--", ...paths);
  return (await gitBuffer(repositoryRoot, args, processOptions)).toString("utf8");
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
  limits: CaptureLimits,
  options: CaptureOptions,
  processOptions: ProcessOptions,
): Promise<CapturedReview> {
  validateRef(ref);
  const sha = await gitText(repositoryRoot, ["rev-parse", "--verify", ref], processOptions);
  const allPaths = splitNull(await gitBuffer(repositoryRoot, ["ls-tree", "-r", "--name-only", "-z", sha], processOptions));
  const files: CapturedFile[] = [];
  const skipped: Array<{ filePath: string; reason: string }> = [];
  let totalBytes = 0;

  for (const [index, filePath] of allPaths.entries()) {
    if (options.signal?.aborted) throw new Error("Diffpanel capture was cancelled.");
    assertSafeRepositoryPath(filePath);
    options.onProgress?.({ phase: "capture", current: index + 1, total: allPaths.length, filePath });
    if (files.length >= maxFiles) {
      skipped.push({ filePath, reason: `repository file limit ${maxFiles} reached` });
      continue;
    }
    if (isGeneratedOrVendorPath(filePath)) {
      skipped.push({ filePath, reason: "generated, vendored, or lock file" });
      continue;
    }
    const content = await readGitObject(repositoryRoot, sha, filePath, false, processOptions);
    if (content === null) {
      skipped.push({ filePath, reason: "could not read Git object" });
      continue;
    }
    if (content.length > limits.maxFileBytes) {
      skipped.push({ filePath, reason: `file exceeds ${limits.maxFileBytes} bytes` });
      continue;
    }
    if (totalBytes + content.length > limits.maxTotalBytes) {
      skipped.push({ filePath, reason: `repository content limit ${limits.maxTotalBytes} bytes reached` });
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

function resolveLimits(overrides: Partial<CaptureLimits> | undefined): CaptureLimits {
  const limits = { ...DEFAULT_CAPTURE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Capture limit ${name} must be a positive integer.`);
  }
  return limits;
}

function toProcessOptions(options: CaptureOptions, limits: CaptureLimits): ProcessOptions {
  return {
    signal: options.signal,
    timeoutMs: limits.processTimeoutMs,
    maxOutputBytes: limits.maxProcessOutputBytes,
  };
}

function validateRef(ref: string): void {
  if (!ref || ref.startsWith("-") || /[\0-\x20\x7f]/.test(ref)) {
    throw new Error(`Unsafe Git ref: ${JSON.stringify(ref)}`);
  }
}

function assertSafeRepositoryPath(filePath: string): void {
  if (!filePath || isAbsolute(filePath) || filePath.includes("\\") || /[\0\r\n]/.test(filePath)) {
    throw new Error(`Unsafe repository path: ${JSON.stringify(filePath)}`);
  }
  const segments = filePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Unsafe repository path: ${JSON.stringify(filePath)}`);
  }
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
