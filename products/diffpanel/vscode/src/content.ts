import * as vscode from "vscode";
import { DiffpanelCli } from "./cli.js";

export class DiffpanelContentProvider implements vscode.TextDocumentContentProvider {
  private readonly cache = new Map<string, string>();

  constructor(private readonly cli: DiffpanelCli) {}

  clear(): void {
    this.cache.clear();
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const cached = this.cache.get(uri.toString());
    if (cached !== undefined) return cached;
    const query = new URLSearchParams(uri.query);
    const runId = required(query, "run");
    const fileId = required(query, "file");
    const side = required(query, "side");
    if (side !== "before" && side !== "after") throw new Error(`Invalid Diffpanel content side: ${side}`);
    const content = await this.cli.content(runId, fileId, side);
    this.cache.set(uri.toString(), content);
    return content;
  }
}

function required(query: URLSearchParams, key: string): string {
  const value = query.get(key);
  if (!value) throw new Error(`Missing Diffpanel URI parameter: ${key}`);
  return value;
}

