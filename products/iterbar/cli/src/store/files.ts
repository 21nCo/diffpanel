import { randomBytes } from "node:crypto";
import { link, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errnoCode } from "./errors.js";

let temporaryCounter = 0;

/** A fresh file name in `.iterbar/tmp/`, unique across processes. */
export function temporaryPath(tmpDirectory: string, label: string): string {
  temporaryCounter += 1;
  return join(tmpDirectory, `${label}-${process.pid}-${temporaryCounter}-${randomBytes(6).toString("hex")}.tmp`);
}

/** Flushes a directory entry change (a rename, link or unlink) to disk where the platform supports it. */
export async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    // Some platforms and file systems cannot open or fsync a directory; the rename itself is still atomic.
    if (!["EISDIR", "EPERM", "EACCES", "EINVAL", "ENOTSUP", "EBADF"].includes(errnoCode(error) ?? "")) throw error;
  } finally {
    await handle?.close();
  }
}

/**
 * Creates a new file that must not exist yet, writes all of `data`, flushes it to disk and closes it. Throws
 * `EEXIST`, leaving the existing file alone, when `path` exists. A file this call created but could not finish,
 * closing included, is removed and the original error rethrown.
 */
export async function writeNewFile(path: string, data: string | Uint8Array, mode = 0o644): Promise<void> {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
  } catch (error) {
    // Closes the handle after a failed write or flush; after a failed close, the handle is closed already.
    await handle.close().catch(() => undefined);
    await removeFile(path).catch(() => undefined);
    throw error;
  }
}

/** Removes a file, ignoring one that is already gone. */
export async function removeFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

/**
 * Atomically replaces `target`: writes a temporary file in `tmpDirectory` (same file system as `.iterbar/`),
 * flushes it, then renames it into place. Readers see the old or the new contents, never a partial file.
 */
export async function writeFileAtomic(tmpDirectory: string, target: string, data: string | Uint8Array): Promise<void> {
  const temporary = temporaryPath(tmpDirectory, "write");
  await writeNewFile(temporary, data);
  try {
    await rename(temporary, target);
  } catch (error) {
    await removeFile(temporary);
    throw error;
  }
  await syncDirectory(dirname(target));
}

/**
 * Atomically creates `target` only if it does not exist: the complete file is hard-linked into place, so
 * readers never see it partially written. Returns `false` when `target` already exists. A temporary name that
 * is already taken throws `EEXIST` instead: it says nothing about `target`.
 */
export async function createFileAtomic(tmpDirectory: string, target: string, data: string | Uint8Array): Promise<boolean> {
  const temporary = temporaryPath(tmpDirectory, "create");
  await writeNewFile(temporary, data);
  try {
    await link(temporary, target);
  } catch (error) {
    if (errnoCode(error) === "EEXIST") return false;
    throw error;
  } finally {
    await removeFile(temporary);
  }
  await syncDirectory(dirname(target));
  return true;
}
