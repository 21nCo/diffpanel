import { access, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { iterbarPaths } from "iterbar/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chooseVariantDraft, temporaryProject } from "../store/test-support/helpers.js";
import { startDaemon, type RunningDaemon } from "./daemon.js";
import { bearer, multipart, send } from "./test-support/client.js";

/** One-shot file-system faults, injected below the daemon at the store's file helpers. */
const faults = vi.hoisted(() => ({
  /** Fail the next directory sync that runs while `daemon.json` exists: publication failing after the rename. */
  syncAfterPublication: false,
  /** Fail the next removal of `daemon.json`. */
  removeDaemonFile: false,
  /** Fail the next feedback record write: an unexpected error inside a request. */
  writeRecord: false,
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
    async writeFileAtomic(...args: Parameters<typeof actual.writeFileAtomic>) {
      if (faults.writeRecord) {
        faults.writeRecord = false;
        throw Object.assign(new Error("EIO: feedback record write failed"), { code: "EIO" });
      }
      return actual.writeFileAtomic(...args);
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
  faults.writeRecord = false;
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((daemon) => daemon.close()));
  await cleanup();
  reported.splice(0);
});

/** Starts a daemon whose reporter records each error, then throws when `throwing` is set. */
async function start(throwing = false): Promise<RunningDaemon> {
  const onError = (error: unknown) => {
    reported.push(error);
    if (throwing) throw new Error("reporter failed");
  };
  const daemon = await startDaemon({ projectRoot: root, onError });
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

describe("an error reporter that throws", () => {
  it("cannot replace a failed start's own error or keep the store locked", async () => {
    faults.syncAfterPublication = true;
    faults.removeDaemonFile = true;
    await expect(start(true)).rejects.toThrow("EIO: directory sync failed");
    expect(faults.removeDaemonFile).toBe(false);
    expect(reported).toHaveLength(1);
    expect(String(reported[0])).toContain("EACCES: cannot remove daemon.json");
    const leftover = await publishedToken();
    expect(leftover).not.toBeNull();

    const next = await start();
    expect(await publishedToken()).toBe(next.info.token);
    expect(next.info.token).not.toBe(leftover);
  });

  it("cannot stop a request that failed unexpectedly from getting its internal error", async () => {
    const daemon = await start(true);
    const form = await multipart({ feedback: chooseVariantDraft });
    const request = { method: "POST", path: "/feedback", headers: { ...bearer(daemon.info.token), ...form.headers }, body: form.body };
    faults.writeRecord = true;
    const failed = await send(daemon.info, request);
    expect(failed.status).toBe(500);
    expect(JSON.parse(failed.text)).toMatchObject({ error: { code: "internal" } });
    expect(faults.writeRecord).toBe(false);
    expect(reported.map(String)).toEqual([expect.stringContaining("EIO: feedback record write failed")]);

    // The daemon keeps serving.
    expect((await send(daemon.info, request)).status).toBe(201);
  });
});
