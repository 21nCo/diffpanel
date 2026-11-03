import { describe, expect, it } from "vitest";
import type { ReviewFile } from "diffpanel";
import { repositoryFilePath, workingFileCandidates } from "./repository-file.js";

describe("repository file paths", () => {
  it("resolves current and renamed paths inside the review repository", () => {
    expect(workingFileCandidates("/tmp/repository", reviewFile())).toEqual([
      "/tmp/repository/src/current.ts",
      "/tmp/repository/src/previous.ts",
    ]);
  });

  it("rejects paths that escape the review repository", () => {
    expect(() => repositoryFilePath("/tmp/repository", "../secret.ts")).toThrow("escapes its repository");
  });
});

function reviewFile(): ReviewFile {
  return {
    id: "file-1",
    filePath: "src/current.ts",
    oldPath: "src/previous.ts",
    status: "renamed",
    beforeBlob: "before",
    afterBlob: "after",
    additions: 1,
    deletions: 1,
    language: "typescript",
    size: 10,
    items: [],
  };
}
