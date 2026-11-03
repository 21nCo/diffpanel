import * as vscode from "vscode";
import type { Chapter } from "diffpanel";
import type { StoredRun } from "@diffpanel/storage";

export interface DetailsSelection {
  run: StoredRun;
  chapter?: Chapter;
}

export class DetailsProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private selection: DetailsSelection | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onOpenItem: (runId: string, itemId: string) => Promise<void>,
    private readonly onOpenDiagram: (runId: string, chapterId?: string) => Promise<void>,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: { type?: string; runId?: string; itemId?: string; chapterId?: string }) => {
      if (message.type === "openDiagram" && typeof message.runId === "string" && message.runId === this.selection?.run.summary.runId
        && (message.chapterId === undefined || typeof message.chapterId === "string")) {
        void this.onOpenDiagram(message.runId, message.chapterId).catch((error: unknown) => {
          void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        });
      }
      if (message.type === "openItem" && message.runId && message.itemId) {
        void this.onOpenItem(message.runId, message.itemId).catch((error: unknown) => {
          void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        });
      }
    });
    this.pushSelection();
  }

  show(selection: DetailsSelection): void {
    this.selection = selection;
    this.pushSelection();
  }

  private pushSelection(): void {
    if (!this.view) return;
    void this.view.webview.postMessage({ type: "selection", payload: this.selection ?? null });
  }

  private html(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview.css"));
    const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `<!doctype html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
          <link rel="stylesheet" href="${style}" />
          <title>Diffpanel Review Details</title>
        </head>
        <body>
          <div id="root"></div>
          <script nonce="${nonce}" src="${script}"></script>
        </body>
      </html>`;
  }
}
