import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { StoredRun } from "@diffpanel/storage";
import { buildDiagramDocument, type DiagramDocument } from "./diagram-document.js";

export class DiagramEditor implements vscode.Disposable {
  private readonly panels = new Map<string, { panel: vscode.WebviewPanel; document: DiagramDocument }>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onOpenItem: (runId: string, itemId: string) => Promise<void>,
  ) {}

  async open(run: StoredRun, chapterId?: string): Promise<void> {
    const document = buildDiagramDocument(run, chapterId);
    const key = JSON.stringify([run.summary.runId, chapterId ?? null]);
    const existing = this.panels.get(key);
    if (existing) {
      existing.document = document;
      existing.panel.reveal(existing.panel.viewColumn);
      void existing.panel.webview.postMessage({ type: "diagram", payload: document });
      return;
    }
    const panel = vscode.window.createWebviewPanel("diffpanel.diagram", `${document.title} — Diagram`, vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    });
    const entry = { panel, document };
    this.panels.set(key, entry);
    panel.webview.onDidReceiveMessage((message: { type?: string; itemId?: string }) => {
      if (message.type === "ready") void panel.webview.postMessage({ type: "diagram", payload: entry.document });
      if (message.type === "openItem" && entry.document.evidence.some((item) => item.itemId === message.itemId)) {
        void this.onOpenItem(run.summary.runId, message.itemId!).catch((error: unknown) => {
          void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        });
      }
    });
    panel.onDidDispose(() => this.panels.delete(key));
    const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "diagram-editor.js"));
    const style = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "diagram-editor.css"));
    const nonce = randomUUID();
    panel.webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"><title>Diffpanel diagram</title></head><body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }

  dispose(): void {
    for (const { panel } of this.panels.values()) panel.dispose();
    this.panels.clear();
  }
}
