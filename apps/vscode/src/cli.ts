import { spawn } from "node:child_process";
import * as vscode from "vscode";
import type { RunSummary, StoredRun } from "@diffpanel/storage";
import { resolveInvocation, type Invocation } from "./invocation.js";

export class DiffpanelCli {
  private readonly output = vscode.window.createOutputChannel("Diffpanel");

  constructor(private readonly extensionPath: string) {}

  dispose(): void {
    this.output.dispose();
  }

  async list(includeArchived = false): Promise<RunSummary[]> {
    return JSON.parse(await this.execute(["list", ...(includeArchived ? ["--include-archived"] : []), "--json"])) as RunSummary[];
  }

  async show(runId: string): Promise<StoredRun> {
    return JSON.parse(await this.execute(["show", runId, "--json"])) as StoredRun;
  }

  async content(runId: string, fileId: string, side: "before" | "after"): Promise<string> {
    return await this.execute(["content", runId, fileId, side]);
  }

  async setArchived(runId: string, archived: boolean): Promise<void> {
    await this.execute([archived ? "archive" : "unarchive", runId]);
  }

  private async execute(args: string[]): Promise<string> {
    const configuration = vscode.workspace.getConfiguration("diffpanel");
    const invocation = resolveInvocation({
      extensionPath: this.extensionPath,
      configuredCliPath: configuration.get<string>("cliPath", ""),
      configuredNodePath: configuration.get<string>("nodePath", ""),
    });
    const home = configuration.get<string>("home", "").trim();
    const commandArgs = [...invocation.leadingArgs, ...args];
    this.output.appendLine(`> ${invocation.command} ${commandArgs.join(" ")}`);

    return await new Promise((resolve, reject) => {
      const child = spawn(invocation.command, commandArgs, {
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.extensionPath,
        env: { ...process.env, ...(home ? { DIFFPANEL_HOME: home } : {}) },
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

  private commandError(invocation: Invocation, detail: string): Error {
    const message = `Could not run Diffpanel CLI (${invocation.displayPath}): ${detail}`;
    this.output.appendLine(message);
    return new Error(message);
  }
}
