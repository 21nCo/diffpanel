import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { runProcess } from "./process.js";
import { runTaskkill } from "./windows-process.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workingDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "diffpanel-process-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await delay(10);
  }
  throw new Error(`Process ${pid} remained visible after ${timeoutMs}ms.`);
}

describe("runProcess", () => {
  it("bounds a hung tree-kill helper and terminates that helper", async () => {
    const script = "setInterval(() => {}, 1000)";
    let helperPid: number | undefined;
    const startedAt = Date.now();
    try {
      expect(await runTaskkill(process.execPath, ["--eval", script], 25, (pid) => { helperPid = pid; })).toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(2_500);
      expect(helperPid).toBeTypeOf("number");
      await waitForProcessExit(helperPid!, 500);
    } finally {
      if (helperPid !== undefined) {
        try { process.kill(helperPid, "SIGKILL"); } catch { /* Already terminated. */ }
      }
    }
  });

  it("bounds combined process output", async () => {
    await expect(runProcess(
      process.execPath,
      ["--eval", "process.stdout.write('x'.repeat(4096))"],
      await workingDirectory(),
      { maxOutputBytes: 1_024 },
    )).rejects.toThrow(/output limit/);
  });

  it("terminates a timed out process", async () => {
    await expect(runProcess(
      process.execPath,
      ["--eval", "setInterval(() => {}, 1000)"],
      await workingDirectory(),
      { timeoutMs: 25 },
    )).rejects.toThrow(/timed out/);
  });

  it("terminates a process when its signal is aborted", async () => {
    const controller = new AbortController();
    const running = runProcess(
      process.execPath,
      ["--eval", "setInterval(() => {}, 1000)"],
      await workingDirectory(),
      { signal: controller.signal },
    );
    controller.abort();
    await expect(running).rejects.toThrow(/cancelled/);
  });

  it.skipIf(process.platform === "win32")("terminates descendants that keep inherited pipes open after the leader exits", async () => {
    const directory = await workingDirectory();
    const pidFile = join(directory, "descendant.pid");
    const script = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });",
      "writeFileSync(process.argv[1], String(child.pid));",
    ].join("\n");
    const cleanup = setTimeout(() => {
      if (!existsSync(pidFile)) return;
      try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* Already terminated. */ }
    }, 1_500);
    const startedAt = Date.now();
    try {
      await expect(runProcess(process.execPath, ["--eval", script, pidFile], directory, { timeoutMs: 250 })).rejects.toThrow(/timed out/);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      const descendantPid = Number(readFileSync(pidFile, "utf8"));
      await waitForProcessExit(descendantPid, 500);
    } finally {
      clearTimeout(cleanup);
    }
  });
});
