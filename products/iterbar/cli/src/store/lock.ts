import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { link, readFile, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { InvalidMessageError, parseMessageJson, SCHEMA_VERSION, storeLockSchema, type StoreLock } from "iterbar";
import { errnoCode, IterbarStoreError, StoreLockedError } from "./errors.js";
import { removeFile, syncDirectory, temporaryPath, writeNewFile } from "./files.js";

/**
 * How much later than the lock's `startedAt` a live process at the lock's pid may have started and still be the
 * owner, where start times are step-stable. A process that started later was given the pid after the owner
 * exited. The owner itself starts before its `startedAt` (Node's time origin), by seconds on a loaded host, and
 * `ps` truncates to whole seconds, so it normally reads earlier; the allowance covers the clock being stepped
 * back while the owner started.
 */
export const START_TIME_TOLERANCE_MS = 5_000;

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

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return errnoCode(error) === "EPERM";
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LSTART = /^[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/;

/**
 * Parses `ps -o lstart=` output (`Wed Nov  4 09:45:12 2026`, the same on macOS and procps in the C locale)
 * as UTC; `undefined` for anything else. `ps` must run with `TZ=UTC0`: a local wall time cannot be read back
 * without its zone (the hour repeated when daylight saving time ends is ambiguous), and `ps` and V8 may read a
 * `TZ` value differently.
 */
export function parseUtcStartTime(text: string): number | undefined {
  const match = LSTART.exec(text.trim());
  if (!match) return undefined;
  const [, month, day, hours, minutes, seconds, year] = match;
  const monthIndex = MONTHS.indexOf(month as string);
  if (monthIndex < 0) return undefined;
  const ms = Date.UTC(Number(year), monthIndex, Number(day), Number(hours), Number(minutes), Number(seconds));
  const date = new Date(ms);
  // Reject what Date.UTC would silently roll over, such as Feb 30.
  return date.getUTCMonth() === monthIndex && date.getUTCDate() === Number(day) ? ms : undefined;
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
      { env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC0" }, timeout: 5_000 },
      (error, stdout) => {
        const text = String(stdout).trim();
        if (error) {
          // `ps -p` exits 1 with no output when the process does not exist.
          resolve((error as { code?: unknown }).code === 1 && text === "" ? null : undefined);
          return;
        }
        resolve(parseUtcStartTime(text));
      },
    );
  });
}

/** Where the lock protocol learns when a process started. @internal Replaced in tests to simulate platforms. */
export interface ProcessStartTimes {
  /**
   * True when a process's observed start time is the wall-clock time it was recorded at, and stays so when the
   * wall clock is later stepped. Only then can it be compared with a lock's `startedAt`.
   */
  readonly stepStable: boolean;
  readonly read: (pid: number) => Promise<number | null | undefined>;
}

/**
 * This platform's process start times. macOS records each process's start as a wall-clock time at fork and
 * never moves it. Linux procps instead derives `lstart` from the kernel's boot time, which the kernel moves
 * whenever the wall clock is stepped (NTP or timesyncd stepping, resuming a VM or WSL, setting the date), and
 * no step-independent reference relates a process's boot-relative start to the wall-clock `startedAt` in its
 * lock. So only macOS start times are step-stable; elsewhere they are not used.
 */
export function platformStartTimes(platform: NodeJS.Platform = process.platform): ProcessStartTimes {
  return { stepStable: platform === "darwin", read: processStartTime };
}

/**
 * True when the lock's owner may still be running, so the lock must not be taken over. A lock whose pid does
 * not exist is stale. A lock with this process's pid is stale unless it records this process's start.
 *
 * Any other running pid is checked against the lock's `startedAt` only where start times are step-stable
 * ({@link platformStartTimes}). The owner held its pid from its start until at least `startedAt`, so a process
 * at that pid now that started before `startedAt` is the owner, however long before: start-up takes seconds on
 * a loaded host. One that started more than {@link START_TIME_TOLERANCE_MS} after it was given the pid after
 * the owner exited, so the lock is stale. Where they are not step-stable, or the start time cannot be
 * read, a running pid is presumed to be the owner: a stepped clock must never let a second writer take over a
 * live owner. The cost is that when a dead owner's pid is reused by an unrelated process, the store stays
 * locked until that process exits; {@link StoreLockedError} names the pid so that a user can check it and
 * delete the lock file.
 */
export async function isOwnerAlive(lock: StoreLock, startTimes: ProcessStartTimes = platformStartTimes()): Promise<boolean> {
  if (!pidExists(lock.pid)) return false;
  const recorded = Date.parse(lock.startedAt);
  if (lock.pid === process.pid) return Math.abs(Date.parse(PROCESS_STARTED_AT) - recorded) <= START_TIME_TOLERANCE_MS;
  if (!startTimes.stepStable) return true;
  const observed = await startTimes.read(lock.pid);
  if (observed === null) return false;
  if (observed === undefined) return true;
  return observed - recorded <= START_TIME_TOLERANCE_MS;
}

/** The file operations of the lock protocol. @internal Replaced in tests to force interleavings. */
export interface LockFileSystem {
  link(existing: string, target: string): Promise<void>;
  readFile(path: string): Promise<string>;
  rename(source: string, target: string): Promise<void>;
  remove(path: string): Promise<void>;
  identity(path: string): Promise<FileIdentity>;
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
    try {
      await writeNewFile(candidate, text);
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
      await removeFile(candidate);
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

/** The handle of a lock this process has just placed, after checking that it is still in place. */
async function confirmed(env: LockEnvironment, lockFile: string, identity: FileIdentity, text: string): Promise<StoreLockHandle> {
  const handle = await acquired(env, lockFile, identity, text);
  await handle.confirmAcquired();
  return handle;
}

/**
 * A handle on the lock file this process placed with contents `text` at `identity`. The lock is this handle's
 * only while the file has that identity, still reads `text` and no newer handle of this process replaced it.
 * The identity alone is not enough: Linux file systems reuse a freed inode number at once, so a lock that was
 * removed and recreated by another process can have this handle's (dev, ino). The text names this process
 * (pid and start), which no other running process shares.
 */
async function acquired(env: LockEnvironment, lockFile: string, identity: FileIdentity, text: string): Promise<StoreLockHandle> {
  await syncDirectory(dirname(lockFile));
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
        await syncDirectory(dirname(lockFile));
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
