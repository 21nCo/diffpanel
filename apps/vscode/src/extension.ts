import { basename } from "node:path";
import * as vscode from "vscode";
import type { ReviewFile, ReviewItem } from "@conductor/core";
import { ConductorCli } from "./cli.js";
import { ConductorContentProvider } from "./content.js";
import { DetailsProvider } from "./details.js";
import type { ChapterNode, ItemNode, ReviewTreeNode, RunNode } from "./model.js";
import { ReviewTreeProvider } from "./tree.js";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const cli = new ConductorCli(context.extensionPath);
  const content = new ConductorContentProvider(cli);
  const tree = new ReviewTreeProvider(cli);
  const details = new DetailsProvider(context.extensionUri, async (runId, itemId) => {
    await openItemById(tree, runId, itemId);
  });
  const treeView = vscode.window.createTreeView("conductor.reviews", {
    treeDataProvider: tree,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    cli,
    tree,
    treeView,
    vscode.workspace.registerTextDocumentContentProvider("conductor", content),
    vscode.window.registerWebviewViewProvider("conductor.details", details),
    vscode.commands.registerCommand("conductor.refresh", async () => {
      content.clear();
      await tree.refresh();
    }),
    vscode.commands.registerCommand("conductor.openRun", async (node: RunNode | ChapterNode) => {
      const stored = await tree.getStoredRun(node.run.runId);
      details.show({ run: stored, ...(node.type === "chapter" ? { chapter: node.chapter } : {}) });
    }),
    vscode.commands.registerCommand("conductor.openItem", async (node: ItemNode) => {
      await openReviewItem(node.run.runId, node.file, node.item);
      const stored = await tree.getStoredRun(node.run.runId);
      details.show({ run: stored, chapter: node.chapter });
    }),
    vscode.commands.registerCommand("conductor.copySkillPrompt", async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const prompt = root
        ? `Use $conductor-chapters to generate and publish a Conductor review for ${root}.`
        : "Use $conductor-chapters to generate and publish a Conductor review for the current repository.";
      await vscode.env.clipboard.writeText(prompt);
      void vscode.window.showInformationMessage("Conductor skill prompt copied.");
    }),
    treeView.onDidChangeSelection(async (event) => {
      const node: ReviewTreeNode | undefined = event.selection[0];
      if (!node || (node.type !== "run" && node.type !== "chapter")) return;
      const stored = await tree.getStoredRun(node.run.runId);
      details.show({ run: stored, ...(node.type === "chapter" ? { chapter: node.chapter } : {}) });
    }),
  );

  await tree.refresh(false);
  tree.startPolling();
}

export function deactivate(): void {}

async function openItemById(tree: ReviewTreeProvider, runId: string, itemId: string): Promise<void> {
  const stored = await tree.getStoredRun(runId);
  for (const file of stored.manifest.files) {
    const item = file.items.find((candidate) => candidate.id === itemId);
    if (item) {
      await openReviewItem(runId, file, item);
      return;
    }
  }
  throw new Error(`Unknown review item ${itemId}.`);
}

async function openReviewItem(
  runId: string,
  file: ReviewFile,
  item: ReviewItem,
): Promise<void> {
  const after = contentUri(runId, file, "after");
  if (file.status === "snapshot") {
    const document = await vscode.workspace.openTextDocument(after);
    await vscode.window.showTextDocument(document, {
      preview: true,
      selection: selectionFor(item, "after"),
    });
    return;
  }
  const before = contentUri(runId, file, "before");
  await vscode.commands.executeCommand(
    "vscode.diff",
    before,
    after,
    `${basename(file.filePath)} — Conductor`,
    { preview: true, selection: selectionFor(item, item.newStart ? "after" : "before") },
  );
}

function contentUri(runId: string, file: ReviewFile, side: "before" | "after"): vscode.Uri {
  const path = `/${side}/${file.filePath}`;
  return vscode.Uri.from({
    scheme: "conductor",
    path,
    query: new URLSearchParams({ run: runId, file: file.id, side }).toString(),
  });
}

function selectionFor(item: ReviewItem, side: "before" | "after"): vscode.Range {
  const start = side === "after" ? item.newStart : item.oldStart;
  const lines = side === "after" ? item.newLines : item.oldLines;
  const zeroBasedStart = Math.max(0, (start ?? 1) - 1);
  const zeroBasedEnd = Math.max(zeroBasedStart, zeroBasedStart + Math.max(1, lines ?? 1) - 1);
  return new vscode.Range(zeroBasedStart, 0, zeroBasedEnd, Number.MAX_SAFE_INTEGER);
}
