import { constants, type Stats } from "node:fs";
import { lstat, open, readlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export class WorktreeFileTooLargeError extends Error {}

export interface WorktreeReadHooks {
  beforeOpen?: () => void | Promise<void>;
  afterOpen?: () => void | Promise<void>;
}

export async function readWorktreeFile(
  repositoryRoot: string,
  filePath: string,
  maxBytes: number,
  hooks: WorktreeReadHooks = {},
): Promise<Buffer> {
  const absolute = containedPath(repositoryRoot, filePath);
  const initial = await lstat(absolute);
  if (initial.isSymbolicLink()) return await readStableSymlink(repositoryRoot, filePath, absolute, initial);
  if (!initial.isFile()) throw new Error(`Review path is not a regular file: ${filePath}`);
  if (initial.size > maxBytes) throw new WorktreeFileTooLargeError();

  await hooks.beforeOpen?.();
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await hooks.afterOpen?.();
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error(`Review path is not a regular file: ${filePath}`);
    if (opened.size > maxBytes) throw new WorktreeFileTooLargeError();
    await assertDescriptorStillContained(repositoryRoot, filePath, absolute, opened);
    return await readBounded(handle, maxBytes);
  } finally {
    await handle.close();
  }
}

async function readStableSymlink(
  repositoryRoot: string,
  filePath: string,
  absolute: string,
  initial: Stats,
): Promise<Buffer> {
  const target = await readlink(absolute);
  await assertNoIntermediateSymlinks(repositoryRoot, filePath);
  const current = await lstat(absolute);
  if (!current.isSymbolicLink() || !sameFile(initial, current) || await readlink(absolute) !== target) {
    throw new Error(`Review path changed during capture: ${filePath}`);
  }
  return Buffer.from(target, "utf8");
}

async function assertDescriptorStillContained(
  repositoryRoot: string,
  filePath: string,
  absolute: string,
  opened: Stats,
): Promise<void> {
  await assertNoIntermediateSymlinks(repositoryRoot, filePath);
  const current = await lstat(absolute);
  if (!current.isFile() || !sameFile(opened, current)) {
    throw new Error(`Review path changed during capture: ${filePath}`);
  }
}

async function assertNoIntermediateSymlinks(repositoryRoot: string, filePath: string): Promise<void> {
  const segments = filePath.split("/");
  let current = repositoryRoot;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new Error(`Review path has a symbolic-link parent: ${filePath}`);
    if (!metadata.isDirectory()) throw new Error(`Review path parent is not a directory: ${filePath}`);
  }
}

async function readBounded(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) throw new WorktreeFileTooLargeError();
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

function containedPath(repositoryRoot: string, filePath: string): string {
  const absolute = resolve(repositoryRoot, filePath);
  const relation = relative(repositoryRoot, absolute);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`Unsafe repository path: ${filePath}`);
  }
  return absolute;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
