import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultDiffpanelHome } from "./paths.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("defaultDiffpanelHome", () => {
  it("uses the Diffpanel data directory for new installations", async () => {
    const home = await temporaryDirectory();
    expect(defaultDiffpanelHome({}, "darwin", home)).toBe(join(home, "Library", "Application Support", "Diffpanel"));
  });

  it("continues using an existing legacy data directory", async () => {
    const home = await temporaryDirectory();
    const legacy = join(home, "Library", "Application Support", "Conductor");
    await mkdir(legacy, { recursive: true });
    expect(defaultDiffpanelHome({}, "darwin", home)).toBe(legacy);
  });

  it("prefers the new environment override while accepting the legacy override", () => {
    expect(defaultDiffpanelHome({ DIFFPANEL_HOME: "/new", CONDUCTOR_HOME: "/old" })).toBe("/new");
    expect(defaultDiffpanelHome({ CONDUCTOR_HOME: "/old" })).toBe("/old");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "diffpanel-paths-"));
  temporaryDirectories.push(directory);
  return directory;
}
