import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { daemonInfoSchema, parseMessageJson, type DaemonInfo } from "iterbar";
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
const unhandled: unknown[] = [];
const recordUnhandled = (reason: unknown) => unhandled.push(reason);
const children: ChildProcessWithoutNullStreams[] = [];

beforeEach(async () => {
  unhandled.splice(0);
  process.on("unhandledRejection", recordUnhandled);
  ({ root, cleanup } = await temporaryProject());
  faults.syncAfterPublication = false;
  faults.removeDaemonFile = false;
  faults.writeRecord = false;
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((daemon) => daemon.close()));
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
  process.off("unhandledRejection", recordUnhandled);
  await cleanup();
  reported.splice(0);
});

/** How the test reporter fails after recording an error, if at all. */
type ReporterFailure = "none" | "throw" | "reject";

/** Starts a daemon whose reporter records each error, then fails as `failure` says. */
async function start(failure: ReporterFailure = "none"): Promise<RunningDaemon> {
  const onError = (error: unknown) => {
    reported.push(error);
    if (failure === "throw") throw new Error("reporter failed");
    if (failure === "reject") return Promise.reject(new Error("async reporter failed"));
    return undefined;
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
    await expect(start("throw")).rejects.toThrow("EIO: directory sync failed");
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
    const daemon = await start("throw");
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

/** Lets Node report any rejection left unhandled by what ran before: it does so once microtasks drain. */
async function settleRejections(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("an error reporter whose promise rejects", () => {
  it("cannot replace a failed start's own error, keep the store locked or leave an unhandled rejection", async () => {
    faults.syncAfterPublication = true;
    faults.removeDaemonFile = true;
    await expect(start("reject")).rejects.toThrow("EIO: directory sync failed");
    expect(faults.removeDaemonFile).toBe(false);
    expect(reported.map(String)).toEqual([expect.stringContaining("EACCES: cannot remove daemon.json")]);
    const leftover = await publishedToken();
    expect(leftover).not.toBeNull();

    const next = await start();
    expect(await publishedToken()).toBe(next.info.token);
    expect(next.info.token).not.toBe(leftover);
    await settleRejections();
    expect(unhandled).toEqual([]);
  });

  it("cannot stop a request that failed unexpectedly from getting its internal error, or leave an unhandled rejection", async () => {
    const daemon = await start("reject");
    const form = await multipart({ feedback: chooseVariantDraft });
    const request = { method: "POST", path: "/feedback", headers: { ...bearer(daemon.info.token), ...form.headers }, body: form.body };
    faults.writeRecord = true;
    const failed = await send(daemon.info, request);
    expect(failed.status).toBe(500);
    expect(JSON.parse(failed.text)).toMatchObject({ error: { code: "internal" } });
    expect(reported.map(String)).toEqual([expect.stringContaining("EIO: feedback record write failed")]);

    expect((await send(daemon.info, request)).status).toBe(201);
    await settleRejections();
    expect(unhandled).toEqual([]);
  });

  it("cannot crash a daemon process that runs with Node's default unhandled-rejection handling", { timeout: 30_000 }, async () => {
    // The built entry point, in a process of its own: no test runner listens for unhandled rejections there.
    const entry = new URL("../../dist/daemon.js", import.meta.url).href;
    const script = `
      import { startDaemon } from ${JSON.stringify(entry)};
      const onError = (error) => {
        process.stderr.write("reported: " + String(error) + "\\n");
        return Promise.reject(new Error("async reporter failed"));
      };
      const daemon = await startDaemon({ projectRoot: process.argv[1], onError });
      process.stdout.write(JSON.stringify(daemon.info) + "\\n");
    `;
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script, root], { env, stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const exited = new Promise<string>((resolve) => child.once("exit", (code, signal) => resolve(`exited ${code ?? signal}: ${stderr}`)));
    const info = await Promise.race([
      new Promise<DaemonInfo>((resolve) => {
        createInterface({ input: child.stdout }).once("line", (line) => resolve(parseMessageJson(daemonInfoSchema, line, "daemon info")));
      }),
      exited.then((reason) => Promise.reject(new Error(reason))),
    ]);

    // A real failure inside the request: the store's temporary directory is not a directory.
    const tmp = iterbarPaths(root).tmpDirectory;
    await rm(tmp, { recursive: true });
    await writeFile(tmp, "");
    const form = await multipart({ feedback: chooseVariantDraft });
    const request = { method: "POST", path: "/feedback", headers: { ...bearer(info.token), ...form.headers }, body: form.body };
    const failed = await send(info, request);
    expect(failed.status).toBe(500);
    expect(JSON.parse(failed.text)).toMatchObject({ error: { code: "internal" } });

    // Node would have terminated the process by now if the reporter's rejection had gone unhandled.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(child.exitCode, stderr).toBeNull();
    await rm(tmp);
    await mkdir(tmp);
    expect((await send(info, request)).status).toBe(201);
    expect(child.exitCode, stderr).toBeNull();
    expect(stderr).toContain("reported: ");
    expect(stderr).not.toContain("async reporter failed");
  });
});
