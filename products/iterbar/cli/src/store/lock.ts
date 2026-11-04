import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { link, readFile, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { InvalidMessageError, parseMessageJson, SCHEMA_VERSION, storeLockSchema, type StoreLock } from "iterbar";
import { errnoCode, IterbarStoreError, StoreLockedError } from "./errors.js";
import { removeFile, syncDirectory, temporaryPath, writeNewFile } from "./files.js";

/**
 * How far a live process's observed start time may be from the lock's `startedAt` and still be the owner.
 * `ps` reports whole seconds, and the kernel's start time and Node's time origin differ by the process
 * start-up time. A larger gap means the pid was reused by another process, so the lock is stale.
 */
export const START_TIME_TOLERANCE_MS = 5_000;

/** Attempts before giving up when the lock keeps changing under this process. */
const MAX_ACQUIRE_ATTEMPTS = 8;

/** How long to wait while another live process is taking over the same stale lock. */
const TAKEOVER_BACKOFF_MS = 25;

/** When this process started, recorded in its lock so that a later process reusing the pid is not the owner. */
export const PROCESS_STARTED_AT = new Date(Math.round(performance.timeOrigin)).toISOString();

/** The lock this process writes. */
export function ownLock(): StoreLock {
  return { schemaVersion: SCHEMA_VERSION, pid: process.pid, startedAt: PROCESS_STARTED_AT };
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return errnoCode(error) === "EPERM";
  }
}

/**
 * When process `pid` started, in epoch milliseconds; `null` when it does not exist and `undefined` when the
 * start time cannot be determined (no `ps`, or output this reader does not understand).
 */
export function processStartTime(pid: number): Promise<number | null | undefined> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-o", "lstart=", "-p", String(pid)],
      { env: { ...process.env, LC_ALL: "C", LANG: "C" }, timeout: 5_000 },
      (error, stdout) => {
        const text = String(stdout).trim();
        if (error) {
          // `ps -p` exits 1 with no output when the process does not exist.
          resolve((error as { code?: unknown }).code === 1 && text === "" ? null : undefined);
          return;
        }
        // `Wed Nov  4 09:45:12 2026` in local time, on macOS and procps alike.
        const ms = Date.parse(text);
        resolve(text !== "" && Number.isFinite(ms) ? ms : undefined);
      },
    );
  });
}

/**
 * True when the lock's owner is still running. The pid must exist, and its start time must match the lock's
 * `startedAt`; when the start time cannot be read the owner is presumed alive, so a live owner is never
 * taken over.
 */
export async function isOwnerAlive(lock: StoreLock): Promise<boolean> {
  if (!pidExists(lock.pid)) return false;
  const recorded = Date.parse(lock.startedAt);
  const observed = lock.pid === process.pid ? Date.parse(PROCESS_STARTED_AT) : await processStartTime(lock.pid);
  if (observed === null) return false;
  if (observed === undefined) return true;
  return Math.abs(observed - recorded) <= START_TIME_TOLERANCE_MS;
}

type Inspection = { readonly state: "missing" } | { readonly state: "live"; readonly lock: StoreLock }
  | { readonly state: "stale"; readonly text: string };

/** Reads and judges a lock file: missing, held by a live owner, or stale (dead owner or malformed). */
async function inspect(path: string): Promise<Inspection> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { state: "missing" };
    throw error;
  }
  let lock: StoreLock;
  try {
    // A lock from a newer major version throws UnsupportedSchemaVersionError: never take over a writer we
    // cannot read.
    lock = parseMessageJson(storeLockSchema, text, "store lock");
  } catch (error) {
    // Locks are linked or renamed into place complete, so a malformed lock is not from a running Iterbar.
    if (error instanceof InvalidMessageError) return { state: "stale", text };
    throw error;
  }
  return await isOwnerAlive(lock) ? { state: "live", lock } : { state: "stale", text };
}

/**
 * The claim on replacing one particular stale lock, in `tmp/`: named after the stale lock's contents, which are
 * unique to its (dead) owner, and holding the claimant's own lock so an abandoned claim can be recognised.
 */
export function takeoverClaimPath(tmpDirectory: string, staleText: string): string {
  return join(tmpDirectory, `takeover-${createHash("sha256").update(staleText).digest("hex").slice(0, 32)}.claim`);
}

/**
 * Replaces the stale lock whose contents were `staleText` with `candidate` (this process's complete lock file).
 * Returns `true` when this process now owns the lock.
 *
 * `store.lock` is never removed during a takeover, so no other process can link a lock into a gap. Instead the
 * contenders that judged the same lock stale race to hard-link a claim named after it, which exactly one wins.
 * Only a claimant may replace that lock, so the winner re-reads `store.lock`: if it is still the stale lock it
 * renames its candidate over it, atomically; if not, another contender already took over and it backs off. A
 * claim whose claimant died is removed, so a crash during a takeover does not block the store for good.
 *
 * Residual: if a claimant dies holding a claim and two processes then remove that abandoned claim at the same
 * moment, both may claim and replace the lock; the one replaced first fails its next write with `lock_lost`.
 */
async function takeOver(lockFile: string, candidate: string, staleText: string): Promise<boolean> {
  const claim = takeoverClaimPath(dirname(candidate), staleText);
  try {
    await link(candidate, claim);
  } catch (error) {
    if (errnoCode(error) !== "EEXIST") throw error;
    const claimant = await inspect(claim);
    if (claimant.state === "stale") await removeFile(claim);
    else if (claimant.state === "live") await delay(TAKEOVER_BACKOFF_MS);
    return false;
  }
  try {
    if ((await readFile(lockFile, "utf8").catch(() => null)) !== staleText) return false;
    await rename(candidate, lockFile);
    return true;
  } finally {
    await removeFile(claim);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ownership of `.iterbar/store.lock` by this process. */
export interface StoreLockHandle {
  readonly lock: StoreLock;
  /** Throws `lock_lost` unless the lock file is still the one this handle created. */
  assertHeld(): Promise<void>;
  /** Removes the lock file if this handle still owns it. Idempotent. */
  release(): Promise<void>;
}

/**
 * Takes `.iterbar/store.lock` for this process. A lock whose owner is dead (or whose pid now belongs to a
 * process that started at another time) is taken over; a live owner makes this throw {@link StoreLockedError}.
 *
 * The lock is written completely to `tmpDirectory`, then hard-linked into place, which fails if a lock exists,
 * or renamed over a stale lock under a takeover claim (see {@link takeOver}). Either way readers never see a
 * partial lock, and of any number of racing processes exactly one acquires it.
 */
export async function acquireStoreLock(lockFile: string, tmpDirectory: string): Promise<StoreLockHandle> {
  const lock = ownLock();
  const text = `${JSON.stringify(lock)}\n`;
  let owner: StoreLock | null = null;
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    const candidate = temporaryPath(tmpDirectory, "lock");
    try {
      await writeNewFile(candidate, text);
      const identity = await stat(candidate, { bigint: true });
      if (await linkNew(candidate, lockFile)) return await acquired(lockFile, lock, identity);
      const found = await inspect(lockFile);
      if (found.state === "live") {
        owner = found.lock;
        break;
      }
      if (found.state === "stale" && await takeOver(lockFile, candidate, found.text)) {
        return await acquired(lockFile, lock, identity);
      }
    } catch (error) {
      // ENOENT: the current owner swept `tmp/` while the candidate was in it; try again.
      if (errnoCode(error) !== "ENOENT") throw error;
    } finally {
      await removeFile(candidate);
    }
  }
  throw new StoreLockedError(lockFile, owner);
}

/** Hard-links `source` to `target`; `false` when `target` exists. */
async function linkNew(source: string, target: string): Promise<boolean> {
  try {
    await link(source, target);
    return true;
  } catch (error) {
    if (errnoCode(error) === "EEXIST") return false;
    throw error;
  }
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

async function acquired(lockFile: string, lock: StoreLock, identity: FileIdentity): Promise<StoreLockHandle> {
  await syncDirectory(dirname(lockFile));
  let released = false;

  async function holds(): Promise<boolean> {
    try {
      const current = await stat(lockFile, { bigint: true });
      return current.dev === identity.dev && current.ino === identity.ino;
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return false;
      throw error;
    }
  }

  return Object.freeze({
    lock,
    async assertHeld() {
      if (released || !(await holds())) {
        throw new IterbarStoreError("lock_lost", `${lockFile} is no longer held by this process`);
      }
    },
    async release() {
      if (released) return;
      released = true;
      if (await holds()) {
        await removeFile(lockFile);
        await syncDirectory(dirname(lockFile));
      }
    },
  });
}
