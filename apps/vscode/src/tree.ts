import * as vscode from "vscode";
import { titleForScope } from "@diffpanel/core";
import type { StoredRun } from "@diffpanel/storage";
import { DiffpanelCli } from "./cli.js";
import type { ChapterNode, ItemNode, RepositoryNode, ReviewTreeNode, RunNode } from "./model.js";
import { chapterItemRefs, chapterLabels } from "./presentation.js";
import { repositoryFilePath } from "./repository-file.js";

export class ReviewTreeProvider implements vscode.TreeDataProvider<ReviewTreeNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<ReviewTreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private repositories: RepositoryNode[] = [];
  private readonly runCache = new Map<string, StoredRun>();
  private fingerprint = "";
  private refreshTimer: NodeJS.Timeout | undefined;
  private includeArchived = false;

  constructor(private readonly cli: DiffpanelCli) {}

  startPolling(): void {
    const seconds = vscode.workspace.getConfiguration("diffpanel").get<number>("refreshIntervalSeconds", 4);
    this.refreshTimer = setInterval(() => void this.refresh(false), Math.max(2, seconds) * 1_000);
  }

  dispose(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.changed.dispose();
  }

  async refresh(showErrors = true): Promise<void> {
    try {
      const runs = await this.cli.list(this.includeArchived);
      const fingerprint = JSON.stringify(runs.map((run) => [run.runId, run.status, run.publishedAt, run.archivedAt, run.chapterCount, run.reviewTitle]));
      if (!showErrors && fingerprint === this.fingerprint) return;
      this.fingerprint = fingerprint;
      this.runCache.clear();
      const groups = new Map<string, RepositoryNode>();
      for (const run of runs) {
        const current = groups.get(run.repositoryId) ?? {
          type: "repository" as const,
          repositoryId: run.repositoryId,
          repositoryName: run.repositoryName,
          repositoryRoot: run.repositoryRoot,
          runs: [],
        };
        current.runs.push(run);
        groups.set(run.repositoryId, current);
      }
      this.repositories = [...groups.values()].sort((a, b) => a.repositoryName.localeCompare(b.repositoryName));
      this.changed.fire(undefined);
    } catch (error) {
      if (showErrors) void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async showArchived(show: boolean): Promise<void> {
    if (this.includeArchived === show) return;
    this.includeArchived = show;
    this.fingerprint = "";
    await this.refresh();
  }

  async setArchived(runId: string, archived: boolean): Promise<void> {
    await this.cli.setArchived(runId, archived);
    this.runCache.delete(runId);
    this.fingerprint = "";
    await this.refresh();
  }

  async setTitle(runId: string, title: string): Promise<void> {
    await this.cli.setTitle(runId, title);
    this.runCache.delete(runId);
    this.fingerprint = "";
    await this.refresh();
  }

  async getStoredRun(runId: string): Promise<StoredRun> {
    const cached = this.runCache.get(runId);
    if (cached) return cached;
    const run = await this.cli.show(runId);
    this.runCache.set(runId, run);
    return run;
  }

  getTreeItem(element: ReviewTreeNode): vscode.TreeItem {
    if (element.type === "repository") {
      const item = new vscode.TreeItem(element.repositoryName, vscode.TreeItemCollapsibleState.Expanded);
      item.description = `${element.runs.length} review${element.runs.length === 1 ? "" : "s"}`;
      item.tooltip = element.repositoryRoot;
      item.iconPath = new vscode.ThemeIcon("repo");
      return item;
    }
    if (element.type === "run") {
      const item = new vscode.TreeItem(
        element.run.reviewTitle,
        element.run.status === "ready" ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      );
      item.description = element.run.status === "ready"
        ? `${element.run.archivedAt ? "archived · " : ""}${element.run.chapterCount} chapters`
        : "awaiting generation";
      item.tooltip = [element.run.reviewTitle, titleForScope(element.run.scope), `${element.run.createdAt}\n${element.run.fileCount} files · ${element.run.itemCount} items`]
        .filter((value, index, values) => values.indexOf(value) === index)
        .join("\n");
      item.iconPath = new vscode.ThemeIcon(element.run.archivedAt ? "archive" : element.run.status === "ready" ? "book" : "loading~spin");
      item.contextValue = element.run.archivedAt ? "diffpanelArchivedRun" : "diffpanelRun";
      item.command = { command: "diffpanel.openRun", title: "Open Review", arguments: [element] };
      return item;
    }
    if (element.type === "chapter") {
      const item = new vscode.TreeItem(
        `${element.displayLabel}. ${element.chapter.title}`,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.description = `${element.itemCount} item${element.itemCount === 1 ? "" : "s"}`
        + (element.subtopicCount > 0 ? ` · ${element.subtopicCount} subtopic${element.subtopicCount === 1 ? "" : "s"}` : "");
      item.tooltip = element.chapter.summary;
      item.iconPath = new vscode.ThemeIcon("symbol-namespace");
      item.contextValue = "diffpanelChapter";
      item.command = { command: "diffpanel.openRun", title: "Open Chapter", arguments: [element] };
      return item;
    }
    const item = new vscode.TreeItem(element.file.filePath, vscode.TreeItemCollapsibleState.None);
    item.description = lineDescription(element.item);
    item.tooltip = element.item.patch;
    item.resourceUri = vscode.Uri.file(repositoryFilePath(element.run.repositoryRoot, element.file.filePath));
    item.contextValue = "diffpanelItem";
    item.command = { command: "diffpanel.openItem", title: "Open Review Item", arguments: [element] };
    return item;
  }

  async getChildren(element?: ReviewTreeNode): Promise<ReviewTreeNode[]> {
    if (!element) return this.repositories;
    if (element.type === "repository") return element.runs.map((run): RunNode => ({ type: "run", run }));
    if (element.type === "run") {
      if (element.run.status !== "ready") return [];
      const stored = await this.getStoredRun(element.run.runId);
      const labels = chapterLabels(stored.review?.chapters ?? []);
      return (stored.review?.chapters ?? [])
        .filter((chapter) => chapter.parentId === null)
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((chapter): ChapterNode => ({
          type: "chapter",
          run: element.run,
          chapter,
          displayLabel: labels.get(chapter.id) ?? String(chapter.order),
          itemCount: chapterItemRefs(stored.review?.chapters ?? [], chapter.id).length,
          subtopicCount: (stored.review?.chapters ?? []).filter((candidate) => candidate.parentId === chapter.id).length,
        }));
    }
    if (element.type === "chapter") {
      const stored = await this.getStoredRun(element.run.runId);
      const labels = chapterLabels(stored.review?.chapters ?? []);
      const filesByItem = new Map(stored.manifest.files.flatMap((file) => file.items.map((item) => [item.id, { file, item }] as const)));
      const childChapters = (stored.review?.chapters ?? [])
        .filter((chapter) => chapter.parentId === element.chapter.id)
        .sort((a, b) => a.order - b.order)
        .map((chapter): ChapterNode => ({
          type: "chapter",
          run: element.run,
          chapter,
          displayLabel: labels.get(chapter.id) ?? String(chapter.order),
          itemCount: chapterItemRefs(stored.review?.chapters ?? [], chapter.id).length,
          subtopicCount: (stored.review?.chapters ?? []).filter((candidate) => candidate.parentId === chapter.id).length,
        }));
      const items = element.chapter.itemRefs.flatMap((itemRef): ItemNode[] => {
        const match = filesByItem.get(itemRef);
        return match ? [{ type: "item", run: element.run, chapter: element.chapter, ...match }] : [];
      });
      return [...childChapters, ...items];
    }
    return [];
  }
}

function lineDescription(item: ItemNode["item"]): string {
  if (item.kind === "file") return "snapshot";
  const old = item.oldStart === null ? "-" : String(item.oldStart);
  const next = item.newStart === null ? "-" : String(item.newStart);
  return `${old} → ${next}`;
}
