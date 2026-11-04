import { createHash } from "node:crypto";
import { link, readFile, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { InvalidMessageError, parseMessageJson, SCHEMA_VERSION, storeLockSchema, type StoreLock } from "iterbar";
import { errnoCode, IterbarStoreError, StoreLockedError } from "./errors.js";
import { removeFile, syncDirectory, temporaryPath, writeNewFile } from "./files.js";

/** Attempts before giving up when the lock keeps changing under this process. */
const MAX_ACQUIRE_ATTEMPTS = 8;

/** Claim generations followed before giving up: each one is a claimant that died during a takeover. */
const MAX_CLAIM_GENERATIONS = 64;

/** How long to wait while another live process is taking over the same stale lock. */
const TAKEOVER_BACKOFF_MS = 25;

/** When this process started, recorded in its lock so that a later process reusing the pid is not the owner. */
export const PROCESS_STARTED_AT = new Date(Math.round(performance.timeOrigin)).toISOString();

/** The lock this process writes. */
export function ownLock(): StoreLock {
  return { schemaVersion: SCHEMA_VERSION, pid: process.pid, startedAt: PROCESS_STARTED_AT };
}

/** False only when no process has `pid`: any other probe failure (EPERM, EIO, ...) proves nothing. */
function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) !== "ESRCH";
  }
}

/**
 * True when the lock's owner may still be running, so the lock must not be taken over. Only a lock whose pid
 * does not exist is stale, and a lock with this process's pid is stale unless it records this process's start
 * (the pid was then an earlier process's, which has exited).
 *
 * Any other running pid is presumed to be the owner, whatever start time the lock records: process start times
 * cannot be compared with `startedAt` reliably (Linux derives them from a boot time that moves when the wall
 * clock is stepped, and on any platform the clock can be stepped while a process starts), and a misjudged live
 * owner would let a second writer in. The cost is that when a dead owner's pid is reused by an unrelated
 * process, the store stays locked until that process exits; {@link StoreLockedError} names the pid so that a
 * user can check it and delete the lock file.
 *
 * Pids are only meaningful within one PID namespace, so every writer of a store must run in the same one (one
 * host and kernel, not two containers or a container and its host sharing the directory). Opening a store
 * from several namespaces, kernels or hosts at once is not supported (ROLL-20).
 */
export async function isOwnerAlive(lock: StoreLock): Promise<boolean> {
  if (!pidExists(lock.pid)) return false;
  return lock.pid !== process.pid || Date.parse(lock.startedAt) === Date.parse(PROCESS_STARTED_AT);
}

/** The file operations of the lock protocol. @internal Replaced in tests to force interleavings. */
export interface LockFileSystem {
  link(existing: string, target: string): Promise<void>;
  readFile(path: string): Promise<string>;
  rename(source: string, target: string): Promise<void>;
  remove(path: string): Promise<void>;
  identity(path: string): Promise<FileIdentity>;
  syncDirectory(path: string): Promise<void>;
}

export interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

const nodeLockFileSystem: LockFileSystem = {
  link,
  readFile: (path) => readFile(path, "utf8"),
  rename,
  remove: removeFile,
  identity: async (path) => {
    const { dev, ino } = await stat(path, { bigint: true });
    return { dev, ino };
  },
  syncDirectory,
};

/** @internal Who this process is to the lock protocol, and how it reaches the file system. */
export interface LockEnvironment {
  readonly lock: StoreLock;
  readonly isOwnerAlive: (lock: StoreLock) => Promise<boolean>;
  readonly fs: LockFileSystem;
}

function defaultEnvironment(): LockEnvironment {
  return { lock: ownLock(), isOwnerAlive: (lock) => isOwnerAlive(lock), fs: nodeLockFileSystem };
}

type Inspection = { readonly state: "missing" } | { readonly state: "live"; readonly lock: StoreLock }
  | { readonly state: "stale"; readonly text: string };

/** Reads and judges a lock or claim file: missing, held by a live owner, or stale (dead owner or malformed). */
async function inspect(env: LockEnvironment, path: string): Promise<Inspection> {
  let text: string;
  try {
    text = await env.fs.readFile(path);
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
  return await env.isOwnerAlive(lock) ? { state: "live", lock } : { state: "stale", text };
}

function digest(...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${Buffer.byteLength(part)}:${part}`);
  return hash.digest("hex");
}

/**
 * The claim on replacing one particular stale lock, in `tmp/`. Generation 0 is named after the stale lock's
 * contents, which are unique to its (dead) owner. When a claimant dies holding generation `n`, generation
 * `n + 1` is named after generation `n`'s name and the dead claimant's lock (`abandonedClaims[n]`), so every
 * generation is a fresh file that a contender wins by an exclusive link; an abandoned claim is never removed.
 */
export function takeoverClaimPath(tmpDirectory: string, staleText: string, abandonedClaims: readonly string[] = []): string {
  let key = digest("store.lock", staleText);
  for (const claimText of abandonedClaims) key = digest(key, claimText);
  return join(tmpDirectory, `takeover-${key.slice(0, 32)}.claim`);
}

/**
 * Replaces the stale lock whose contents were `staleText` with `candidate` (this process's complete lock file).
 * Returns `true` when this process now owns the lock.
 *
 * `store.lock` is never removed during a takeover, so no other process can link a lock into a gap. Instead the
 * contenders that judged the same lock stale race to hard-link a claim on it, which exactly one wins. Only a
 * claimant may replace that lock, so the winner re-reads `store.lock`: if it is still the stale lock it renames
 * its candidate over it, atomically; if not, another contender already took over and it backs off.
 *
 * A claimant that dies leaves its claim behind. Its claim is never unlinked by a contender, which could delete
 * a live claim linked at the same path after the inspection; contenders instead race for the next generation
 * of the claim ({@link takeoverClaimPath}), which only exists once the previous claimant is dead. So at most
 * one live claimant exists per stale lock. The claims are removed only after the stale lock is gone, when a
 * claim on it can no longer replace anything.
 */
async function takeOver(env: LockEnvironment, lockFile: string, candidate: string, staleText: string): Promise<boolean> {
  const tmpDirectory = dirname(candidate);
  const abandoned: string[] = [];
  let claim = takeoverClaimPath(tmpDirectory, staleText);
  for (;;) {
    try {
      await env.fs.link(candidate, claim);
      break;
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
    }
    const claimant = await inspect(env, claim);
    if (claimant.state === "live") {
      await delay(TAKEOVER_BACKOFF_MS);
      return false;
    }
    // Missing: its claimant gave up or finished, so start over from store.lock.
    if (claimant.state === "missing" || abandoned.length + 1 >= MAX_CLAIM_GENERATIONS) return false;
    abandoned.push(claimant.text);
    claim = takeoverClaimPath(tmpDirectory, staleText, abandoned);
  }
  let replaced = false;
  try {
    if ((await env.fs.readFile(lockFile).catch(() => null)) !== staleText) return false;
    await env.fs.rename(candidate, lockFile);
    replaced = true;
    return true;
  } finally {
    // This process's own claim always goes. The abandoned generations go only once the stale lock is gone:
    // while it is in place they keep the next contender on the chain past them.
    await env.fs.remove(claim);
    if (replaced) {
      for (let generation = 0; generation < abandoned.length; generation += 1) {
        await env.fs.remove(takeoverClaimPath(tmpDirectory, staleText, abandoned.slice(0, generation)));
      }
    }
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
  /**
   * Throws {@link StoreLockedError} naming the current owner unless the lock file is still the one this handle
   * created. For the end of acquisition, when losing the lock means another process owns the store.
   */
  confirmAcquired(): Promise<void>;
  /**
   * Removes the lock file if this handle still owns it. Idempotent: every call returns the same promise, which
   * settles once the lock file is removed (or found not to be this handle's). The handle stops holding the lock
   * as soon as the first call is made.
   */
  release(): Promise<void>;
}

/**
 * Takes `.iterbar/store.lock` for this process. A lock whose owner is dead (see {@link isOwnerAlive}) is taken
 * over; a live owner makes this throw {@link StoreLockedError}.
 *
 * The lock is written completely to `tmpDirectory`, then hard-linked into place, which fails if a lock exists,
 * or renamed over a stale lock under a takeover claim (see {@link takeOver}). Either way readers never see a
 * partial lock, and of any number of racing processes exactly one acquires it. The lock file is checked to
 * still be this process's before this returns.
 *
 * `environment` is a test seam (@internal) whose parts replace the defaults; callers leave it out.
 */
export async function acquireStoreLock(
  lockFile: string,
  tmpDirectory: string,
  environment?: Partial<LockEnvironment>,
): Promise<StoreLockHandle> {
  const env: LockEnvironment = { ...defaultEnvironment(), ...environment };
  const text = `${JSON.stringify(env.lock)}\n`;
  let owner: StoreLock | null = null;
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    const candidate = temporaryPath(tmpDirectory, "lock");
    let written = false;
    try {
      await writeNewFile(candidate, text);
      written = true;
      const identity = await env.fs.identity(candidate);
      if (await linkNew(env, candidate, lockFile)) return await confirmed(env, lockFile, identity, text);
      const found = await inspect(env, lockFile);
      if (found.state === "live") {
        owner = found.lock;
        break;
      }
      if (found.state === "stale" && await takeOver(env, lockFile, candidate, found.text)) {
        return await confirmed(env, lockFile, identity, text);
      }
    } catch (error) {
      // ENOENT: the current owner swept `tmp/` while the candidate was in it; try again.
      if (errnoCode(error) !== "ENOENT") throw error;
    } finally {
      // A candidate that could not be created exclusively is not this process's file.
      if (written) await removeFile(candidate);
    }
  }
  throw new StoreLockedError(lockFile, owner);
}

/** Hard-links `source` to `target`; `false` when `target` exists. */
async function linkNew(env: LockEnvironment, source: string, target: string): Promise<boolean> {
  try {
    await env.fs.link(source, target);
    return true;
  } catch (error) {
    if (errnoCode(error) === "EEXIST") return false;
    throw error;
  }
}

/** The current owner of the lock file, when it is a readable lock. */
async function currentOwner(env: LockEnvironment, lockFile: string): Promise<StoreLock | null> {
  try {
    return parseMessageJson(storeLockSchema, await env.fs.readFile(lockFile), "store lock");
  } catch {
    return null;
  }
}

/**
 * The newest handle of this process for each lock file and lock text. Two handles in one process write the
 * same lock text, so the text alone cannot tell them apart: a newer acquisition of the same lock file (possible
 * only after the older one's lock was removed) supersedes the older handle.
 */
const currentHandles = new Map<string, symbol>();

/**
 * The handle of a lock this process has just placed, once it is flushed and checked to be still in place.
 * If either fails, the lock is released (only if it is still this handle's) before the error is rethrown, so
 * it does not keep the store locked with no handle left to release it.
 */
async function confirmed(env: LockEnvironment, lockFile: string, identity: FileIdentity, text: string): Promise<StoreLockHandle> {
  const handle = acquired(env, lockFile, identity, text);
  try {
    await env.fs.syncDirectory(dirname(lockFile));
    await handle.confirmAcquired();
    return handle;
  } catch (error) {
    await handle.release().catch(() => undefined);
    throw error;
  }
}

/**
 * A handle on the lock file this process placed with contents `text` at `identity`. The lock is this handle's
 * only while the file has that identity, still reads `text` and no newer handle of this process replaced it.
 * The identity alone is not enough: Linux file systems reuse a freed inode number at once, so a lock that was
 * removed and recreated by another process can have this handle's (dev, ino). The text names this process
 * (pid and start), which no other running process shares.
 */
function acquired(env: LockEnvironment, lockFile: string, identity: FileIdentity, text: string): StoreLockHandle {
  const key = `${lockFile}\0${text}`;
  const token = Symbol(lockFile);
  currentHandles.set(key, token);
  let releasing: Promise<void> | null = null;

  /** Whether the lock file is still the one this handle placed (see above), ignoring any release. */
  async function inPlace(): Promise<boolean> {
    if (currentHandles.get(key) !== token) return false;
    try {
      const current = await env.fs.identity(lockFile);
      if (current.dev !== identity.dev || current.ino !== identity.ino) return false;
      return (await env.fs.readFile(lockFile)) === text;
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return false;
      throw error;
    }
  }

  /** Whether this handle holds the lock: in place, and no release has begun before or during the check. */
  async function holds(): Promise<boolean> {
    if (releasing !== null) return false;
    const inPlaceNow = await inPlace();
    return inPlaceNow && releasing === null;
  }

  /**
   * The one release of this handle. Every release() call shares it, so no call can act on an earlier
   * observation after another call removed the lock and a successor took it. The handle stays this process's
   * current one until the file is removed, so a newer handle of this process placed meanwhile is never removed.
   */
  async function releaseOnce(): Promise<void> {
    try {
      if (await inPlace()) {
        await env.fs.remove(lockFile);
        await env.fs.syncDirectory(dirname(lockFile));
      }
    } finally {
      if (currentHandles.get(key) === token) currentHandles.delete(key);
    }
  }

  return Object.freeze({
    lock: env.lock,
    async assertHeld() {
      if (!(await holds())) {
        throw new IterbarStoreError("lock_lost", `${lockFile} is no longer held by this process`);
      }
    },
    async confirmAcquired() {
      if (!(await holds())) throw new StoreLockedError(lockFile, await currentOwner(env, lockFile));
    },
    release() {
      releasing ??= releaseOnce();
      return releasing;
    },
  });
}
