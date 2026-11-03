import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInvocation } from "./invocation.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("resolveInvocation", () => {
  it("runs an extensionless symlink to a JavaScript CLI through Node", () => {
    const directory = temporaryDirectory();
    const cliDirectory = join(directory, "cli");
    const binDirectory = join(directory, ".local", "bin");
    mkdirSync(cliDirectory, { recursive: true });
    mkdirSync(binDirectory, { recursive: true });
    const target = join(cliDirectory, "index.js");
    const link = join(binDirectory, "diffpanel");
    writeFileSync(target, "#!/usr/bin/env node\n");
    symlinkSync(target, link);

    expect(resolveInvocation({
      extensionPath: join(directory, "extension"),
      configuredNodePath: "/pinned/node",
      homeDirectory: directory,
    })).toEqual({
      command: "/pinned/node",
      leadingArgs: [link],
      displayPath: link,
    });
  });

  it("executes a native CLI directly", () => {
    const directory = temporaryDirectory();
    const cliPath = join(directory, "diffpanel");
    writeFileSync(cliPath, "native executable placeholder");

    expect(resolveInvocation({
      extensionPath: join(directory, "extension"),
      configuredCliPath: cliPath,
      configuredNodePath: "/pinned/node",
    })).toEqual({
      command: cliPath,
      leadingArgs: [],
      displayPath: cliPath,
    });
  });

  it("prefers the Node executable inherited through PATH", () => {
    const directory = temporaryDirectory();
    const cliPath = join(directory, "diffpanel.js");
    const nodeDirectory = join(directory, "node-bin");
    const nodePath = join(nodeDirectory, "node");
    mkdirSync(nodeDirectory);
    writeFileSync(cliPath, "#!/usr/bin/env node\n");
    writeFileSync(nodePath, "node executable placeholder");

    expect(resolveInvocation({
      extensionPath: join(directory, "extension"),
      configuredCliPath: cliPath,
      environmentPath: nodeDirectory,
      nodeCandidates: [],
    })).toEqual({
      command: nodePath,
      leadingArgs: [cliPath],
      displayPath: cliPath,
    });
  });

  it("accepts the legacy CLI name when Diffpanel is not linked yet", () => {
    const directory = temporaryDirectory();
    const binDirectory = join(directory, ".local", "bin");
    mkdirSync(binDirectory, { recursive: true });
    const legacyCli = join(binDirectory, "conductor");
    writeFileSync(legacyCli, "native executable placeholder");

    expect(resolveInvocation({
      extensionPath: join(directory, "extension"),
      homeDirectory: directory,
    })).toEqual({
      command: legacyCli,
      leadingArgs: [],
      displayPath: legacyCli,
    });
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "diffpanel-invocation-"));
  temporaryDirectories.push(directory);
  return directory;
}
