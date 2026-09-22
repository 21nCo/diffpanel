import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ReviewFile } from "diffpanel";

export function repositoryFilePath(repositoryRoot: string, filePath: string): string {
  const root = resolve(repositoryRoot);
  const candidate = resolve(root, filePath);
  const relativePath = relative(root, candidate);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Review file path escapes its repository: ${filePath}`);
  }
  return candidate;
}

export function workingFileCandidates(repositoryRoot: string, file: ReviewFile): string[] {
  const candidates = [file.filePath, file.oldPath].filter((path): path is string => Boolean(path));
  return [...new Set(candidates.map((path) => repositoryFilePath(repositoryRoot, path)))];
}
