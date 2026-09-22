import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { runProcess } from "./process.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workingDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "diffpanel-process-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("runProcess", () => {
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
});
