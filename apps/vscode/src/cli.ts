import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import type { RunSummary, StoredRun } from "@conductor/storage";

interface Invocation {
  command: string;
  leadingArgs: string[];
}

export class ConductorCli {
  private readonly output = vscode.window.createOutputChannel("Conductor");

  constructor(private readonly extensionPath: string) {}

  dispose(): void {
    this.output.dispose();
  }

  async list(): Promise<RunSummary[]> {
    return JSON.parse(await this.execute(["list", "--json"])) as RunSummary[];
  }

  async show(runId: string): Promise<StoredRun> {
    return JSON.parse(await this.execute(["show", runId, "--json"])) as StoredRun;
  }

  async content(runId: string, fileId: string, side: "before" | "after"): Promise<string> {
    return await this.execute(["content", runId, fileId, side]);
  }

  private async execute(args: string[]): Promise<string> {
    const invocation = this.resolveInvocation();
    const configuration = vscode.workspace.getConfiguration("conductor");
    const home = configuration.get<string>("home", "").trim();
    const commandArgs = [...invocation.leadingArgs, ...args];
    this.output.appendLine(`> ${invocation.command} ${commandArgs.join(" ")}`);

    return await new Promise((resolve, reject) => {
      const child = spawn(invocation.command, commandArgs, {
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.extensionPath,
        env: { ...process.env, ...(home ? { CONDUCTOR_HOME: home } : {}) },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error) => reject(this.commandError(invocation, error.message)));
      child.on("close", (code) => {
        const output = Buffer.concat(stdout).toString("utf8");
        const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
        if (errorOutput) this.output.appendLine(errorOutput);
        if (code !== 0) {
          reject(this.commandError(invocation, errorOutput || `Exited with code ${code}.`));
          return;
        }
        resolve(output);
      });
    });
  }

  private resolveInvocation(): Invocation {
    const configuration = vscode.workspace.getConfiguration("conductor");
    const configured = configuration.get<string>("cliPath", "").trim();
    const developmentCli = join(this.extensionPath, "..", "cli", "dist", "index.js");
    const path = configured || firstExisting([
      developmentCli,
      join(homedir(), ".local", "bin", "conductor"),
      join(homedir(), "Library", "pnpm", "bin", "conductor"),
      "/opt/homebrew/bin/conductor",
      "/usr/local/bin/conductor",
    ]) || "conductor";
    if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) {
      return {
        command: configuration.get<string>("nodePath", "").trim() || firstExisting([
          "/opt/homebrew/bin/node",
          "/usr/local/bin/node",
        ]) || "node",
        leadingArgs: [path],
      };
    }
    return { command: path, leadingArgs: [] };
  }

  private commandError(invocation: Invocation, detail: string): Error {
    const message = `Could not run Conductor CLI (${invocation.command}): ${detail}`;
    this.output.appendLine(message);
    return new Error(message);
  }
}

function firstExisting(candidates: string[]): string | undefined {
  return candidates.find((candidate) => existsSync(candidate));
}
