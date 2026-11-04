import { readFile, writeFile } from "node:fs/promises";
import { iterbarPaths } from "iterbar/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isOwnerAlive, ownLock, PROCESS_STARTED_AT, takeoverClaimPath } from "./lock.js";
import { openFeedbackStore, type FeedbackStore } from "./store.js";
import { deadPid, StoreProcess, temporaryProject } from "./test-support/helpers.js";

let root: string;
let cleanup: () => Promise<void>;
const processes: StoreProcess[] = [];
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
});

describe("stale locks", () => {
  it("takes over a lock whose pid is not running", async () => {
    await writeLock({ schemaVersion: 1, pid: await deadPid(), startedAt: PROCESS_STARTED_AT });
    await open();
    expect(await readLock()).toEqual(ownLock());
  });

  it("takes over a lock whose pid now belongs to a process that started at another time", async () => {
    const other = startProcess();
    const { pid } = await other.next("ready");
    const reused = { schemaVersion: 1, pid: pid as number, startedAt: "2020-01-01T00:00:00.000Z" } as const;
    expect(await isOwnerAlive(reused)).toBe(false);
    await writeLock(reused);
    await open();
    expect(await readLock()).toEqual(ownLock());
  });

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
  });

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
  });
});
