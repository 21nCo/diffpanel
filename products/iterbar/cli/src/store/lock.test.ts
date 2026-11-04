import { link, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { StoreLock } from "iterbar";
import { iterbarPaths } from "iterbar/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireStoreLock,
  isOwnerAlive,
  ownLock,
  PROCESS_STARTED_AT,
  takeoverClaimPath,
  type LockEnvironment,
  type LockFileSystem,
} from "./lock.js";
import { syncDirectory } from "./files.js";
import { openFeedbackStore, type FeedbackStore } from "./store.js";
import { deadPid, StoreProcess, temporaryProject } from "./test-support/helpers.js";

let root: string;
let cleanup: () => Promise<void>;
const processes: StoreProcess[] = [];
/** For tests that spawn processes, which take seconds on a loaded host. */
const SPAWN_TIMEOUT_MS = 30_000;
const stores: FeedbackStore[] = [];

beforeEach(async () => {
  ({ root, cleanup } = await temporaryProject());
});

afterEach(async () => {
  await Promise.all(processes.splice(0).map((child) => child.kill()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await cleanup();
});

function startProcess(): StoreProcess {
  const child = new StoreProcess("hold", root);
  processes.push(child);
  return child;
}

async function open(): Promise<FeedbackStore> {
  const store = await openFeedbackStore(root);
  stores.push(store);
  return store;
}

async function readLock(): Promise<unknown> {
  return JSON.parse(await readFile(iterbarPaths(root).lockFile, "utf8"));
}

async function writeLock(lock: unknown): Promise<void> {
  // Create .iterbar/ first, as a previous run would have.
  await (await openFeedbackStore(root)).close();
  await writeFile(iterbarPaths(root).lockFile, typeof lock === "string" ? lock : JSON.stringify(lock));
}

/** Starts `count` processes, releases them together, and returns what each one reported. */
async function race(count: number) {
  const contenders = Array.from({ length: count }, () => startProcess());
  await Promise.all(contenders.map((child) => child.next("ready")));
  for (const child of contenders) child.go();
  const results = await Promise.all(contenders.map((child) => child.next("acquired", "error")));
  return { contenders, results };
}

describe("store lock between processes", () => {
  it("lets exactly one of several racing processes write; the others get store_locked naming the winner", async () => {
    for (let round = 0; round < 3; round += 1) {
      const { contenders, results } = await race(4);
      const winners = results.filter((result) => result.event === "acquired");
      expect(winners).toHaveLength(1);
      const losers = results.filter((result) => result.event === "error");
      expect(losers.map((result) => [result.code, result.ownerPid])).toEqual(
        Array.from({ length: 3 }, () => ["store_locked", winners[0]?.pid]),
      );
      expect(await readLock()).toMatchObject({ schemaVersion: 1, pid: winners[0]?.pid });
      await Promise.all(contenders.map((child) => child.finish()));
      processes.length = 0;
    }
  }, 60_000);

  it("refuses this process while another live process holds the store, and takes over once it is killed", async () => {
    const owner = startProcess();
    await owner.next("ready");
    owner.go();
    const acquired = await owner.next("acquired");

    const error = await openFeedbackStore(root).then(() => null, (thrown: unknown) => thrown);
    expect(error).toMatchObject({ name: "StoreLockedError", code: "store_locked", owner: { pid: acquired.pid } });

    // SIGKILL: the owner never removes its lock, so the lock is stale.
    await owner.kill();
    await open();
    expect(await readLock()).toEqual(ownLock());
  }, 30_000);

  it("lets exactly one of several processes racing for a stale lock take it over", async () => {
    for (let round = 0; round < 3; round += 1) {
      await writeLock({ schemaVersion: 1, pid: await deadPid(), startedAt: "2026-11-01T00:00:00.000Z" });
      const { contenders, results } = await race(4);
      const winners = results.filter((result) => result.event === "acquired");
      expect(winners).toHaveLength(1);
      expect(results.filter((result) => result.event === "error").map((result) => result.code))
        .toEqual(["store_locked", "store_locked", "store_locked"]);
      expect(await readLock()).toMatchObject({ pid: winners[0]?.pid });
      await Promise.all(contenders.map((child) => child.finish()));
      processes.length = 0;
    }
  }, 60_000);

  it("lets exactly one of several processes take over a stale lock whose takeover claims were abandoned", async () => {
    for (let round = 0; round < 3; round += 1) {
      const stale = JSON.stringify({ schemaVersion: 1, pid: await deadPid(), startedAt: "2026-11-01T00:00:00.000Z" });
      await writeLock(stale);
      // Round 0: one claimant died mid-takeover; later rounds: two, one after the other.
      const abandoned: string[] = [];
      for (let generation = 0; generation <= Math.min(round, 1); generation += 1) {
        const claim = JSON.stringify({ schemaVersion: 1, pid: await deadPid(), startedAt: PROCESS_STARTED_AT });
        await writeFile(takeoverClaimPath(iterbarPaths(root).tmpDirectory, stale, abandoned), claim);
        abandoned.push(claim);
      }
      const { contenders, results } = await race(4);
      const winners = results.filter((result) => result.event === "acquired");
      expect(winners).toHaveLength(1);
      expect(results.filter((result) => result.event === "error").map((result) => result.code))
        .toEqual(["store_locked", "store_locked", "store_locked"]);
      expect(await readLock()).toMatchObject({ pid: winners[0]?.pid });
      await Promise.all(contenders.map((child) => child.finish()));
      processes.length = 0;
    }
  }, 60_000);
});

describe("stale locks", () => {
  it("takes over a lock whose pid is not running", async () => {
    await writeLock({ schemaVersion: 1, pid: await deadPid(), startedAt: PROCESS_STARTED_AT });
    await open();
    expect(await readLock()).toEqual(ownLock());
  }, SPAWN_TIMEOUT_MS);

  it("presumes a running pid is the owner whatever start time its lock records, and names it", async () => {
    const other = startProcess();
    const { pid } = await other.next("ready");
    // A start well before, a few seconds after (a clock stepped back during start-up) and long after the
    // process's real start: none of them may let a second writer in while the pid runs.
    for (const startedAt of ["2020-01-01T00:00:00.000Z", new Date(Date.now() + 6_000).toISOString(), "2099-01-01T00:00:00.000Z"]) {
      const owner = { schemaVersion: 1, pid: pid as number, startedAt } as const;
      await writeLock(owner);
      const before = await readFile(iterbarPaths(root).lockFile, "utf8");
      expect(await isOwnerAlive(owner)).toBe(true);
      const error = await openFeedbackStore(root).then(() => null, (thrown: unknown) => thrown);
      expect(error).toMatchObject({ code: "store_locked", owner });
      expect((error as Error).message).toContain(`If process ${pid} is not Iterbar`);
      expect(await readFile(iterbarPaths(root).lockFile, "utf8")).toBe(before);
      await rm(iterbarPaths(root).lockFile);
    }
  }, SPAWN_TIMEOUT_MS);

  it("clears a takeover claim abandoned by a dead process, and waits for one held by a live process", async () => {
    const stale = JSON.stringify({ schemaVersion: 1, pid: await deadPid(), startedAt: PROCESS_STARTED_AT });
    await writeLock(stale);
    const claim = takeoverClaimPath(iterbarPaths(root).tmpDirectory, stale);

    await writeFile(claim, JSON.stringify(ownLock()));
    await expect(openFeedbackStore(root)).rejects.toMatchObject({ code: "store_locked", owner: null });
    expect(await readFile(iterbarPaths(root).lockFile, "utf8")).toBe(stale);

    await writeFile(claim, JSON.stringify({ schemaVersion: 1, pid: await deadPid(), startedAt: PROCESS_STARTED_AT }));
    await open();
    expect(await readLock()).toEqual(ownLock());
  }, SPAWN_TIMEOUT_MS);

  it("takes over a malformed lock", async () => {
    await writeLock("{\"schemaVersion\":1,\"pid\":");
    await open();
    expect(await readLock()).toEqual(ownLock());
  });

  it("refuses a lock from a newer major version without touching it", async () => {
    const newer = { schemaVersion: 2, pid: await deadPid(), startedAt: PROCESS_STARTED_AT };
    await writeLock(newer);
    await expect(openFeedbackStore(root)).rejects.toMatchObject({ code: "unsupported_schema_version" });
    expect(await readLock()).toEqual(newer);
  }, SPAWN_TIMEOUT_MS);
});

/** A promise and the function that resolves it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("takeover claims between two contenders", () => {
  it("lets one of two contenders that both found the same abandoned claim take over; the other gets store_locked", async () => {
    // Both contenders run in this process against the real file system, as two processes with their own locks;
    // the test decides which file operations each one may make, and when.
    const { lockFile, tmpDirectory } = iterbarPaths(root);
    await writeLock(JSON.stringify({ schemaVersion: 1, pid: 900_001, startedAt: PROCESS_STARTED_AT }));
    const stale = await readFile(lockFile, "utf8");
    const abandonedClaim = JSON.stringify({ schemaVersion: 1, pid: 900_002, startedAt: PROCESS_STARTED_AT });
    const firstClaim = takeoverClaimPath(tmpDirectory, stale);
    await writeFile(firstClaim, abandonedClaim);

    const alive = new Set<number>();
    const bothSawAbandonedClaim = deferred();
    let sawAbandonedClaim = 0;
    const bMayContinue = deferred();
    const bSettled = deferred();

    // A runs freely except that it stops just before renaming over store.lock until B has finished.
    // B stops at its first file operation after reading the abandoned claim until A is about to rename.
    function environment(name: "A" | "B", pid: number): LockEnvironment {
      let readAbandonedClaim = false;
      const gate = async (operation: string, path: string) => {
        if (name === "A" && operation === "rename" && path === lockFile) {
          bMayContinue.resolve();
          await bSettled.promise;
        }
        if (name === "B" && readAbandonedClaim) await bMayContinue.promise;
      };
      const fs: LockFileSystem = {
        link: async (existing, target) => {
          await gate("link", target);
          await link(existing, target);
        },
        readFile: async (path) => {
          await gate("readFile", path);
          const text = await readFile(path, "utf8");
          if (path === firstClaim && text === abandonedClaim && !readAbandonedClaim) {
            readAbandonedClaim = true;
            sawAbandonedClaim += 1;
            if (sawAbandonedClaim === 2) bothSawAbandonedClaim.resolve();
            await bothSawAbandonedClaim.promise;
          }
          return text;
        },
        rename: async (source, target) => {
          await gate("rename", target);
          await rename(source, target);
        },
        remove: async (path) => {
          await gate("remove", path);
          await rm(path, { force: true });
        },
        identity: async (path) => {
          await gate("identity", path);
          const { dev, ino } = await stat(path, { bigint: true });
          return { dev, ino };
        },
        syncDirectory,
      };
      alive.add(pid);
      return {
        lock: { schemaVersion: 1, pid, startedAt: PROCESS_STARTED_AT },
        isOwnerAlive: async (lock: StoreLock) => alive.has(lock.pid),
        fs,
      };
    }

    const a = acquireStoreLock(lockFile, tmpDirectory, environment("A", 900_010));
    const b = acquireStoreLock(lockFile, tmpDirectory, environment("B", 900_020));
    const bResult = await b.then(() => "acquired", (error: unknown) => error);
    bSettled.resolve();
    const aHandle = await a;

    expect(bResult).toMatchObject({ code: "store_locked" });
    expect(aHandle.lock.pid).toBe(900_010);
    expect(JSON.parse(await readFile(lockFile, "utf8"))).toMatchObject({ pid: 900_010 });
    // The spent claims, abandoned generation included, are gone once the stale lock is.
    expect((await readdir(tmpDirectory)).filter((name) => name.endsWith(".claim"))).toEqual([]);
    await aHandle.release();
  });
});

describe("owner liveness probe", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Makes `process.kill(pid, 0)` for the lock's pid fail with `code`. */
  function probeFails(code: string): void {
    const kill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === process.ppid && signal === 0) throw Object.assign(new Error(code), { code });
      return kill(pid, signal);
    });
  }

  const owner = { schemaVersion: 1, pid: process.ppid, startedAt: "2026-11-04T09:00:00.000Z" } as const;

  it.each(["EPERM", "EIO", "EINVAL"])("keeps the owner when the probe fails with %s, and a second opener gets store_locked", async (code) => {
    await writeLock(owner);
    const before = await readFile(iterbarPaths(root).lockFile, "utf8");
    probeFails(code);
    expect(await isOwnerAlive(owner)).toBe(true);
    await expect(openFeedbackStore(root)).rejects.toMatchObject({ code: "store_locked", owner });
    expect(await readFile(iterbarPaths(root).lockFile, "utf8")).toBe(before);
  });

  it("takes over only when the probe reports ESRCH, no such process", async () => {
    await writeLock(owner);
    probeFails("ESRCH");
    expect(await isOwnerAlive(owner)).toBe(false);
    await open();
    expect(await readLock()).toEqual(ownLock());
  });

  it("judges a lock with this process's pid by this process's own start time", async () => {
    expect(await isOwnerAlive(ownLock())).toBe(true);
    expect(await isOwnerAlive({ ...ownLock(), startedAt: "2020-01-01T00:00:00.000Z" })).toBe(false);
    expect(await isOwnerAlive({ ...ownLock(), startedAt: new Date(Date.parse(PROCESS_STARTED_AT) + 1_000).toISOString() })).toBe(false);
  });
});

describe("acquisition", () => {
  // Every file reports the same (dev, ino), as a removed lock and its replacement can on ext4.
  const reusedInode: LockFileSystem = {
    link,
    readFile: (path) => readFile(path, "utf8"),
    rename,
    remove: (path) => rm(path, { force: true }),
    identity: async () => ({ dev: 1n, ino: 1n }),
    syncDirectory,
  };

  it("confirms the lock is still this handle's, and names the owner that replaced it", async () => {
    await (await openFeedbackStore(root)).close();
    const { lockFile, tmpDirectory } = iterbarPaths(root);
    const handle = await acquireStoreLock(lockFile, tmpDirectory);
    await expect(handle.confirmAcquired()).resolves.toBeUndefined();
    const other = { schemaVersion: 1, pid: process.ppid, startedAt: "2026-11-04T00:00:00.000Z" };
    await rm(lockFile);
    await writeFile(lockFile, JSON.stringify(other));
    await expect(handle.confirmAcquired()).rejects.toMatchObject({ code: "store_locked", owner: other });
    await handle.release();
    expect(JSON.parse(await readFile(lockFile, "utf8"))).toEqual(other);
  });

  it("is not fooled when another owner's lock reuses its inode number, as Linux file systems do", async () => {
    await (await openFeedbackStore(root)).close();
    const { lockFile, tmpDirectory } = iterbarPaths(root);
    const handle = await acquireStoreLock(lockFile, tmpDirectory, { fs: reusedInode });
    await expect(handle.assertHeld()).resolves.toBeUndefined();
    const other = { schemaVersion: 1, pid: process.ppid, startedAt: "2026-11-04T00:00:00.000Z" };
    await rm(lockFile);
    await writeFile(lockFile, `${JSON.stringify(other)}\n`);
    await expect(handle.assertHeld()).rejects.toMatchObject({ code: "lock_lost" });
    await expect(handle.confirmAcquired()).rejects.toMatchObject({ code: "store_locked", owner: other });
    await handle.release();
    expect(JSON.parse(await readFile(lockFile, "utf8"))).toEqual(other);
  });

  it("releases once however many release() calls overlap, never removing a successor's lock", async () => {
    await (await openFeedbackStore(root)).close();
    const { lockFile, tmpDirectory } = iterbarPaths(root);
    // The next read of the lock file, once armed, completes and then waits for the test to let it return.
    let armed = false;
    let paused!: () => void;
    const reached = new Promise<void>((resolve) => (paused = resolve));
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => (resume = resolve));
    const fs: LockFileSystem = {
      ...reusedInode,
      identity: async (path) => {
        const { dev, ino } = await stat(path, { bigint: true });
        return { dev, ino };
      },
      readFile: async (path) => {
        const text = await readFile(path, "utf8");
        if (armed && path === lockFile) {
          armed = false;
          paused();
          await gate;
        }
        return text;
      },
    };
    const handle = await acquireStoreLock(lockFile, tmpDirectory, { fs });
    armed = true;
    const first = handle.release();
    await reached; // The first call has read this handle's lock and is about to act on it.
    const second = handle.release();
    const secondSettledEarly = await Promise.race([
      second.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    await expect(handle.assertHeld()).rejects.toMatchObject({ code: "lock_lost" });
    // Had a call removed the lock already, another process would take it now.
    const successor = `${JSON.stringify({ schemaVersion: 1, pid: process.ppid, startedAt: "2026-11-04T00:00:00.000Z" })}\n`;
    const successorPlaced = await stat(lockFile).then(() => false, async () => {
      await writeFile(lockFile, successor);
      return true;
    });
    resume();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    if (successorPlaced) expect(await readFile(lockFile, "utf8").catch(() => "(store.lock missing)")).toBe(successor);
    else await expect(stat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
    // Every call settles only once the lock is released, so no successor could take it any earlier.
    expect(secondSettledEarly).toBe(false);
    expect(successorPlaced).toBe(false);
  });

  it.each([
    ["a fresh lock", "fsync"],
    ["a fresh lock", "confirmation"],
    ["a stale lock taken over", "fsync"],
    ["a stale lock taken over", "confirmation"],
  ] as const)("removes %s it placed when its %s fails, so the next acquisition succeeds", async (path, failure) => {
    if (path === "a fresh lock") await (await openFeedbackStore(root)).close();
    else await writeLock({ schemaVersion: 1, pid: await deadPid(), startedAt: PROCESS_STARTED_AT });
    const { lockFile, tmpDirectory } = iterbarPaths(root);
    const injected = Object.assign(new Error(`injected ${failure} failure`), { code: "EIO" });
    // Fails once, at the first fsync of .iterbar/ or the first read of store.lock after this lock is in place.
    let published = false;
    let failed = false;
    const failOnce = (operation: "fsync" | "confirmation") => {
      if (published && !failed && operation === failure) {
        failed = true;
        throw injected;
      }
    };
    const fs: LockFileSystem = {
      ...reusedInode,
      identity: async (target) => {
        const { dev, ino } = await stat(target, { bigint: true });
        return { dev, ino };
      },
      link: async (existing, target) => {
        await link(existing, target);
        if (target === lockFile) published = true;
      },
      rename: async (source, target) => {
        await rename(source, target);
        if (target === lockFile) published = true;
      },
      readFile: async (target) => {
        if (target === lockFile) failOnce("confirmation");
        return readFile(target, "utf8");
      },
      syncDirectory: async () => failOnce("fsync"),
    };
    await expect(acquireStoreLock(lockFile, tmpDirectory, { fs })).rejects.toBe(injected);
    expect(failed).toBe(true);
    await expect(stat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
    const next = await acquireStoreLock(lockFile, tmpDirectory);
    expect(await readLock()).toEqual(ownLock());
    await next.release();
  }, SPAWN_TIMEOUT_MS);

  it("lets a newer handle of this process supersede one whose lock was removed", async () => {
    await (await openFeedbackStore(root)).close();
    const { lockFile, tmpDirectory } = iterbarPaths(root);
    const older = await acquireStoreLock(lockFile, tmpDirectory, { fs: reusedInode });
    await rm(lockFile);
    // Same pid and start, so the same lock text, and here the same inode, as Linux may give it.
    const newer = await acquireStoreLock(lockFile, tmpDirectory, { fs: reusedInode });
    await expect(older.assertHeld()).rejects.toMatchObject({ code: "lock_lost" });
    await older.release();
    await expect(newer.assertHeld()).resolves.toBeUndefined();
    expect(await readLock()).toEqual(ownLock());
    await newer.release();
    await expect(stat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
