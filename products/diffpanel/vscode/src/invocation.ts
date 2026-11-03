import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export interface Invocation {
  command: string;
  leadingArgs: string[];
  displayPath: string;
}

interface InvocationOptions {
  extensionPath: string;
  configuredCliPath?: string;
  configuredNodePath?: string;
  homeDirectory?: string;
  environmentPath?: string;
  nodeCandidates?: string[];
}

export function resolveInvocation(options: InvocationOptions): Invocation {
  const homeDirectory = options.homeDirectory ?? homedir();
  const developmentCli = join(options.extensionPath, "..", "cli", "dist", "index.js");
  const cliPath = options.configuredCliPath?.trim() || firstExisting([
    developmentCli,
    join(homeDirectory, ".local", "bin", "diffpanel"),
    join(homeDirectory, "Library", "pnpm", "bin", "diffpanel"),
    "/opt/homebrew/bin/diffpanel",
    "/usr/local/bin/diffpanel",
    join(homeDirectory, ".local", "bin", "conductor"),
    join(homeDirectory, "Library", "pnpm", "bin", "conductor"),
    "/opt/homebrew/bin/conductor",
    "/usr/local/bin/conductor",
  ]) || "diffpanel";

  if (isJavaScriptCli(cliPath)) {
    const nodePath = options.configuredNodePath?.trim()
      || firstOnPath("node", options.environmentPath ?? process.env.PATH)
      || firstExisting(
        options.nodeCandidates ?? ["/opt/homebrew/bin/node", "/usr/local/bin/node"],
      )
      || "node";
    return { command: nodePath, leadingArgs: [cliPath], displayPath: cliPath };
  }

  return { command: cliPath, leadingArgs: [], displayPath: cliPath };
}

function isJavaScriptCli(path: string): boolean {
  let resolvedPath = path;
  try {
    resolvedPath = realpathSync(path);
  } catch {
    // PATH-only commands and missing configured paths should still be spawned so
    // the caller receives the operating system's normal execution error.
  }
  return /\.(?:c|m)?js$/i.test(resolvedPath);
}

function firstExisting(candidates: string[]): string | undefined {
  return candidates.find((candidate) => existsSync(candidate));
}

function firstOnPath(command: string, pathValue: string | undefined): string | undefined {
  if (!pathValue) return undefined;
  return firstExisting(pathValue.split(delimiter).map((directory) => join(directory, command)));
}
