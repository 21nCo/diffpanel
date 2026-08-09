import { basename } from "node:path";
import * as vscode from "vscode";
import type { ReviewFile, ReviewItem } from "@diffpanel/core";
import { DiffpanelCli } from "./cli.js";
import { DiffpanelContentProvider } from "./content.js";
import { DetailsProvider } from "./details.js";
import type { ChapterNode, ItemNode, ReviewTreeNode, RunNode } from "./model.js";
import { workingFileCandidates } from "./repository-file.js";
import { ReviewTreeProvider } from "./tree.js";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const cli = new DiffpanelCli(context.extensionPath);
  const content = new DiffpanelContentProvider(cli);
  const tree = new ReviewTreeProvider(cli);
  const details = new DetailsProvider(context.extensionUri, async (runId, itemId) => {
    await openItemById(tree, runId, itemId);
  });
  const treeView = vscode.window.createTreeView("diffpanel.reviews", {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  await vscode.commands.executeCommand("setContext", "diffpanel.showingArchived", false);

  context.subscriptions.push(
    cli,
    tree,
    treeView,
    vscode.workspace.registerTextDocumentContentProvider("diffpanel", content),
    vscode.window.registerWebviewViewProvider("diffpanel.details", details),
    vscode.commands.registerCommand("diffpanel.refresh", async () => {
      content.clear();
      await tree.refresh();
    }),
    vscode.commands.registerCommand("diffpanel.showArchivedReviews", async () => {
      await tree.showArchived(true);
      await vscode.commands.executeCommand("setContext", "diffpanel.showingArchived", true);
    }),
    vscode.commands.registerCommand("diffpanel.hideArchivedReviews", async () => {
      await tree.showArchived(false);
      await vscode.commands.executeCommand("setContext", "diffpanel.showingArchived", false);
    }),
    vscode.commands.registerCommand("diffpanel.archiveReview", async (node: RunNode | undefined) => {
      if (!node) {
        void vscode.window.showInformationMessage("Use the archive action on a review in the Diffpanel panel.");
        return;
      }
      await tree.setArchived(node.run.runId, true);
    }),
    vscode.commands.registerCommand("diffpanel.unarchiveReview", async (node: RunNode | undefined) => {
      if (!node) {
        void vscode.window.showInformationMessage("Show archived reviews, then use the restore action on a review.");
        return;
      }
      await tree.setArchived(node.run.runId, false);
    }),
    vscode.commands.registerCommand("diffpanel.openRun", async (node: RunNode | ChapterNode) => {
      const stored = await tree.getStoredRun(node.run.runId);
      details.show({ run: stored, ...(node.type === "chapter" ? { chapter: node.chapter } : {}) });
    }),
    vscode.commands.registerCommand("diffpanel.openItem", async (node: ItemNode) => {
      await openReviewItem(node.run.runId, node.file, node.item);
      const stored = await tree.getStoredRun(node.run.runId);
      details.show({ run: stored, chapter: node.chapter });
    }),
    vscode.commands.registerCommand("diffpanel.openWorkingFile", async (node: ItemNode | undefined) => {
      if (!node) {
        void vscode.window.showInformationMessage("Use the open-file action on a review item in the Diffpanel panel.");
        return;
      }
      try {
        await openWorkingFile(node);
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    }),
    vscode.commands.registerCommand("diffpanel.copySkillPrompt", async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const prompt = root
        ? `Use $diffpanel-chapters to generate and publish a Diffpanel review for ${root}.`
        : "Use $diffpanel-chapters to generate and publish a Diffpanel review for the current repository.";
      await vscode.env.clipboard.writeText(prompt);
      void vscode.window.showInformationMessage("Diffpanel skill prompt copied.");
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

async function openWorkingFile(node: ItemNode): Promise<void> {
  for (const path of workingFileCandidates(node.run.repositoryRoot, node.file)) {
    const uri = vscode.Uri.file(path);
    try {
      await vscode.workspace.fs.stat(uri);
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, {
        preview: false,
        selection: selectionFor(node.item, node.item.newStart ? "after" : "before"),
      });
      return;
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") continue;
      throw error;
    }
  }
  throw new Error(`Working file no longer exists: ${node.file.filePath}`);
}

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
    `${basename(file.filePath)} — Diffpanel`,
    { preview: true, selection: selectionFor(item, item.newStart ? "after" : "before") },
  );
}

function contentUri(runId: string, file: ReviewFile, side: "before" | "after"): vscode.Uri {
  const path = `/${side}/${file.filePath}`;
  return vscode.Uri.from({
    scheme: "diffpanel",
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
