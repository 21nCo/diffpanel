import type { Chapter, ReviewFile, ReviewItem } from "@conductor/core";
import type { RunSummary } from "@conductor/storage";

export type ReviewTreeNode = RepositoryNode | RunNode | ChapterNode | ItemNode;

export interface RepositoryNode {
  type: "repository";
  repositoryId: string;
  repositoryName: string;
  repositoryRoot: string;
  runs: RunSummary[];
}

export interface RunNode {
  type: "run";
  run: RunSummary;
}

export interface ChapterNode {
  type: "chapter";
  run: RunSummary;
  chapter: Chapter;
}

export interface ItemNode {
  type: "item";
  run: RunSummary;
  chapter: Chapter;
  item: ReviewItem;
  file: ReviewFile;
}

