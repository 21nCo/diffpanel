import { link, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { StoreLock } from "iterbar";
import { iterbarPaths } from "iterbar/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireStoreLock,
  isOwnerAlive,
  ownLock,
  parseUtcStartTime,
  platformStartTimes,
  processStartTime,
  PROCESS_STARTED_AT,
  START_TIME_TOLERANCE_MS,
  takeoverClaimPath,
  type LockEnvironment,
  type LockFileSystem,
  type ProcessStartTimes,
} from "./lock.js";
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

  it("takes over a lock whose pid now belongs to a process that started at another time, where start times are step-stable", async () => {
    const other = startProcess();
    const { pid } = await other.next("ready");
    const reused = { schemaVersion: 1, pid: pid as number, startedAt: "2020-01-01T00:00:00.000Z" } as const;
    await writeLock(reused);
    if (platformStartTimes().stepStable) {
      expect(await isOwnerAlive(reused)).toBe(false);
      await open();
      expect(await readLock()).toEqual(ownLock());
    } else {
      // Linux: a running pid is presumed to be the owner, so the store stays locked, naming the pid.
      expect(await isOwnerAlive(reused)).toBe(true);
      const error = await openFeedbackStore(root).then(() => null, (thrown: unknown) => thrown);
      expect(error).toMatchObject({ code: "store_locked", owner: reused });
      expect((error as Error).message).toContain(`If process ${pid} is not Iterbar`);
      expect(await readLock()).toEqual(reused);
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

describe("owner start time", () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it("reads ps lstart output as UTC whatever this process's time zone", () => {
    process.env.TZ = "America/New_York";
    // A daemon started at 01:30 EST on the day daylight saving time ends, the second 01:30 in New York.
    // Read as local time this is ambiguous, and Date.parse picks 01:30 EDT, an hour early.
    expect(parseUtcStartTime("Sun Nov  1 06:30:00 2026")).toBe(Date.parse("2026-11-01T06:30:00Z"));
    expect(parseUtcStartTime("Wed Nov 4 09:45:12 2026\n")).toBe(Date.parse("2026-11-04T09:45:12Z"));
    for (const text of ["", "garbage", "Sun Feb 30 06:30:00 2026", "Sun Foo  1 06:30:00 2026", "2026-11-01T06:30:00Z"]) {
      expect(parseUtcStartTime(text)).toBeUndefined();
    }
  });

  it("keeps a live owner whose recorded start time falls in the hour repeated when daylight saving time ends", async () => {
    process.env.TZ = "America/New_York";
    const owner = { schemaVersion: 1, pid: process.ppid, startedAt: "2026-11-01T06:30:00.400Z" } as const;
    // What `TZ=UTC0 ps -o lstart=` prints for a process started at 01:30:00 EST.
    const startTime = async () => parseUtcStartTime("Sun Nov  1 06:30:00 2026");
    const startTimes = { stepStable: true, read: startTime };
    expect(await isOwnerAlive(owner, startTimes)).toBe(true);
    expect(await isOwnerAlive({ ...owner, startedAt: "2026-11-01T05:30:00.400Z" }, startTimes)).toBe(false);
  });

  it("asks ps for the start time in UTC, so it matches the process's own clock in any time zone", async () => {
    for (const zone of ["America/New_York", "Asia/Kolkata", "Pacific/Kiritimati"]) {
      process.env.TZ = zone;
      // The kernel's start precedes Node's time origin by the start-up time; a time zone error would be 30 min or more.
      const gap = (await processStartTime(process.pid) as number) - Date.parse(PROCESS_STARTED_AT);
      expect(gap).toBeLessThanOrEqual(START_TIME_TOLERANCE_MS);
      expect(gap).toBeGreaterThan(-10 * 60_000);
    }
    expect(await processStartTime(await deadPid())).toBeNull();
  }, SPAWN_TIMEOUT_MS);

  it("presumes the owner alive when ps output cannot be read", async () => {
    const owner = { schemaVersion: 1, pid: process.ppid, startedAt: "2020-01-01T00:00:00.000Z" } as const;
    expect(await isOwnerAlive(owner, { stepStable: true, read: async () => undefined })).toBe(true);
    expect(await isOwnerAlive(owner, { stepStable: true, read: async () => null })).toBe(false);
  });

  it("judges a lock with this process's pid by this process's own start time", async () => {
    const neverRead: ProcessStartTimes = { stepStable: false, read: async () => { throw new Error("not read"); } };
    expect(await isOwnerAlive(ownLock(), neverRead)).toBe(true);
    expect(await isOwnerAlive({ ...ownLock(), startedAt: "2020-01-01T00:00:00.000Z" }, neverRead)).toBe(false);
  });
});

describe("owner start time when the wall clock is stepped", () => {
  // A live owner (this test's parent process) and the start time ps reports for it after the wall clock was
  // stepped by `step` since it started: on Linux procps moves lstart with the kernel's boot time.
  const owner = { schemaVersion: 1, pid: process.ppid, startedAt: "2026-11-04T09:00:00.000Z" } as const;
  const stepped = (platform: NodeJS.Platform, step: number): ProcessStartTimes => ({
    ...platformStartTimes(platform),
    read: async (pid) => (pid === owner.pid ? Date.parse(owner.startedAt) + step : null),
  });
  const steps = [60_000, -60_000, -3_600_000];

  it("only compares start times on macOS, where they are step-stable", () => {
    expect(platformStartTimes("darwin").stepStable).toBe(true);
    for (const platform of ["linux", "freebsd", "win32"] as const) expect(platformStartTimes(platform).stepStable).toBe(false);
  });

  it.each(steps)("keeps a live Linux owner after a %i ms step, and a second opener gets store_locked", async (step) => {
    expect(await isOwnerAlive(owner, stepped("linux", step))).toBe(true);
    await writeLock(owner);
    const { lockFile, tmpDirectory } = iterbarPaths(root);
    const opener = acquireStoreLock(lockFile, tmpDirectory, {
      isOwnerAlive: (lock) => isOwnerAlive(lock, stepped("linux", step)),
    });
    await expect(opener).rejects.toMatchObject({ name: "StoreLockedError", code: "store_locked", owner });
    expect(await readLock()).toEqual(owner);
    expect((await readdir(tmpDirectory)).filter((name) => name.endsWith(".claim"))).toEqual([]);
  });

  it("presumes a running Linux pid is the owner even when its start time cannot be read", async () => {
    expect(await isOwnerAlive(owner, { stepStable: false, read: async () => null })).toBe(true);
    expect(await isOwnerAlive({ ...owner, pid: await deadPid() }, stepped("linux", 0))).toBe(false);
  }, SPAWN_TIMEOUT_MS);

  it("still tells a reused pid from its owner by start time on macOS", async () => {
    // macOS start times do not move with the clock, so a later start is another process given the pid later.
    for (const later of [START_TIME_TOLERANCE_MS + 1_000, 60_000, 3_600_000]) {
      expect(await isOwnerAlive(owner, stepped("darwin", later))).toBe(false);
    }
    expect(await isOwnerAlive(owner, stepped("darwin", START_TIME_TOLERANCE_MS))).toBe(true);
  });

  it("keeps a macOS owner whose start-up took longer than the tolerance before Node recorded startedAt", async () => {
    // Under heavy load the kernel's start precedes performance.timeOrigin by seconds; a reused pid can only
    // have started after the owner exited, which is after its startedAt.
    for (const earlier of [-1_000, -(START_TIME_TOLERANCE_MS + 2_500), -60_000, -3_600_000]) {
      expect(await isOwnerAlive(owner, stepped("darwin", earlier))).toBe(true);
    }
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
