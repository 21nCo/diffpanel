import { describe, expect, it, vi } from "vitest";
import { listRunsWithCompatibility } from "./cli-list.js";

const run = (runId: string) => ({ runId });

describe("listRunsWithCompatibility", () => {
  it("follows page cursors until the current CLI is exhausted", async () => {
    const execute = vi.fn(async (args: string[]) => JSON.stringify(args.includes("cursor-2")
      ? { runs: [run("third")], nextCursor: null }
      : { runs: [run("first"), run("second")], nextCursor: "cursor-2" }));

    await expect(listRunsWithCompatibility(execute)).resolves.toEqual([run("first"), run("second"), run("third")]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("falls back to the legacy exhaustive array protocol only for unsupported pagination flags", async () => {
    const execute = vi.fn(async (args: string[]) => {
      if (args.includes("--page")) throw new Error("error: unknown option '--limit'");
      return JSON.stringify([run("legacy")]);
    });

    await expect(listRunsWithCompatibility(execute, true)).resolves.toEqual([run("legacy")]);
    expect(execute).toHaveBeenLastCalledWith(["list", "--include-archived", "--json"]);
  });

  it("does not hide unrelated current-CLI failures behind the legacy fallback", async () => {
    const execute = vi.fn(async () => { throw new Error("database is locked"); });
    await expect(listRunsWithCompatibility(execute)).rejects.toThrow(/database is locked/);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
