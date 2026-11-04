import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { daemonInfoSchema, parseMessageJson, type DaemonInfo } from "iterbar";
import { iterbarPaths } from "iterbar/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { temporaryProject } from "../store/test-support/helpers.js";
import { bearer, send } from "./test-support/client.js";

/** The built command line; the package's test script builds it first. */
const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

let root: string;
let cleanup: () => Promise<void>;
const children: ChildProcessWithoutNullStreams[] = [];

beforeEach(async () => {
  ({ root, cleanup } = await temporaryProject());
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
  await cleanup();
});

interface DevProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>;
}

function run(...args: string[]): DevProcess {
  const child = spawn(process.execPath, [cli, ...args], { stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>(
    (resolve) => child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr })),
  );
  return { child, exited };
}

/** Starts `iterbar dev` and waits until it reports that it is listening. */
async function startDev(): Promise<DevProcess & { info: DaemonInfo }> {
  const dev = run("dev", "--root", root);
  const listening = new Promise<void>((resolve, reject) => {
    createInterface({ input: dev.child.stdout }).on("line", (line) => {
      if (line.startsWith("Iterbar daemon listening on ")) resolve();
    });
    void dev.exited.then((result) => reject(new Error(`iterbar dev exited: ${JSON.stringify(result)}`)));
  });
  await listening;
  const info = parseMessageJson(daemonInfoSchema, await readFile(iterbarPaths(root).daemonFile, "utf8"), "daemon.json");
  expect(info.pid).toBe(dev.child.pid);
  return { ...dev, info };
}

// Each test spawns the built CLI, which a loaded machine can take seconds to start.
describe.skipIf(process.platform === "win32")("iterbar dev", { timeout: 30_000 }, () => {
  it("serves the project until SIGTERM, then removes daemon.json and exits 0", async () => {
    const dev = await startDev();
    expect((await send(dev.info, { path: "/feedback", headers: bearer(dev.info.token) })).status).toBe(200);

    dev.child.kill("SIGTERM");
    const result = await dev.exited;
    expect(result).toMatchObject({ code: 0, signal: null });
    expect(result.stdout).not.toContain(dev.info.token);
    await expect(stat(iterbarPaths(root).daemonFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("after a daemon is killed, replaces its daemon.json and refuses its token", async () => {
    const killed = await startDev();
    killed.child.kill("SIGKILL");
    await killed.exited;
    // A killed daemon cannot clean up: its file is left behind, stale.
    expect(parseMessageJson(daemonInfoSchema, await readFile(iterbarPaths(root).daemonFile, "utf8"), "daemon.json"))
      .toEqual(killed.info);

    const restarted = await startDev();
    expect(restarted.info.token).not.toBe(killed.info.token);
    expect((await stat(iterbarPaths(root).daemonFile)).mode & 0o777).toBe(0o600);
    expect((await send(restarted.info, { path: "/feedback", headers: bearer(killed.info.token) })).status).toBe(401);
    expect((await send(restarted.info, { path: "/feedback", headers: bearer(restarted.info.token) })).status).toBe(200);

    restarted.child.kill("SIGINT");
    expect(await restarted.exited).toMatchObject({ code: 0 });
  });

  it("exits 1 without touching daemon.json while another daemon serves the project", async () => {
    const first = await startDev();
    const second = await run("dev", "--root", root).exited;
    expect(second.code).toBe(1);
    expect(second.stderr).toContain(`held by process ${first.child.pid}`);
    expect(parseMessageJson(daemonInfoSchema, await readFile(iterbarPaths(root).daemonFile, "utf8"), "daemon.json"))
      .toEqual(first.info);
  });

  it("rejects unknown arguments with usage and exit code 2", async () => {
    const result = await run("dev", "--port", "1234").exited;
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Usage: iterbar dev");
  });
});
