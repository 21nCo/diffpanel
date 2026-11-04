import { access, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { iterbarPaths } from "iterbar/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { temporaryProject } from "../store/test-support/helpers.js";
import { startDaemon, type RunningDaemon } from "./daemon.js";

/** One-shot file-system faults, injected below the daemon at the store's file helpers. */
const faults = vi.hoisted(() => ({
  /** Fail the next directory sync that runs while `daemon.json` exists: publication failing after the rename. */
  syncAfterPublication: false,
  /** Fail the next removal of `daemon.json`. */
  removeDaemonFile: false,
}));

vi.mock("../store/files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store/files.js")>();
  const exists = (path: string) => access(path).then(() => true, () => false);
  return {
    ...actual,
    async syncDirectory(directory: string) {
      if (faults.syncAfterPublication && await exists(join(directory, "daemon.json"))) {
        faults.syncAfterPublication = false;
        throw Object.assign(new Error("EIO: directory sync failed"), { code: "EIO" });
      }
      return actual.syncDirectory(directory);
    },
    async removeFile(path: string) {
      if (faults.removeDaemonFile && basename(path) === "daemon.json") {
        faults.removeDaemonFile = false;
        throw Object.assign(new Error("EACCES: cannot remove daemon.json"), { code: "EACCES" });
      }
      return actual.removeFile(path);
    },
  };
});

let root: string;
let cleanup: () => Promise<void>;
const running: RunningDaemon[] = [];
const reported: unknown[] = [];

beforeEach(async () => {
  ({ root, cleanup } = await temporaryProject());
  faults.syncAfterPublication = false;
  faults.removeDaemonFile = false;
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((daemon) => daemon.close()));
  await cleanup();
  reported.splice(0);
});

async function start(): Promise<RunningDaemon> {
  const daemon = await startDaemon({ projectRoot: root, onError: (error) => reported.push(error) });
  running.push(daemon);
  return daemon;
}

const daemonFile = () => iterbarPaths(root).daemonFile;

/** The token in `daemon.json`, or `null` when there is none. */
async function publishedToken(): Promise<string | null> {
  try {
    return (JSON.parse(await readFile(daemonFile(), "utf8")) as { token: string }).token;
  } catch {
    return null;
  }
}

describe("a start that fails after daemon.json is published", () => {
  it("removes the daemon.json it published and releases the store", async () => {
    faults.syncAfterPublication = true;
    await expect(start()).rejects.toThrow("EIO: directory sync failed");
    expect(faults.syncAfterPublication).toBe(false);

    // No client can discover credentials of a daemon that never started.
    expect(await publishedToken()).toBeNull();
    expect(reported).toEqual([]);

    const next = await start();
    expect(await publishedToken()).toBe(next.info.token);
    expect((await fetch(`${next.url}/feedback`, { headers: { authorization: `Bearer ${next.info.token}` } })).status).toBe(200);
  });

  it("still releases the store when removing daemon.json fails, reporting that failure", async () => {
    faults.syncAfterPublication = true;
    faults.removeDaemonFile = true;
    // The start's own failure is what the caller sees; the cleanup failure goes to onError.
    await expect(start()).rejects.toThrow("EIO: directory sync failed");
    expect(faults.removeDaemonFile).toBe(false);
    expect(reported).toHaveLength(1);
    expect(String(reported[0])).toContain("EACCES: cannot remove daemon.json");
    const leftover = await publishedToken();
    expect(leftover).not.toBeNull();

    // The lock was released, so the next daemon starts and replaces the leftover file.
    const next = await start();
    expect(await publishedToken()).toBe(next.info.token);
    expect(next.info.token).not.toBe(leftover);
  });
});
