import type { ReviewManifest } from "./schemas.js";

const PREVIEW_LIMIT = 24_000;

export function formatGenerationInput(manifest: ReviewManifest): string {
  const lines: string[] = [
    "# Diffpanel review generation input",
    "",
    `Run ID: ${manifest.runId}`,
    `Repository: ${manifest.repositoryName}`,
    `Root: ${manifest.repositoryRoot}`,
    `Scope: ${JSON.stringify(manifest.scope)}`,
    `Snapshot: ${manifest.snapshotHash}`,
    `Files: ${manifest.files.length}`,
    `Review items: ${manifest.files.reduce((total, file) => total + file.items.length, 0)}`,
    "",
    "Every item ID below must appear in exactly one chapter itemRefs array.",
    "Use repository inspection when the preview is insufficient.",
    "",
  ];

  for (const file of manifest.files) {
    lines.push(
      `=== File: ${file.filePath} | status: ${file.status} | +${file.additions} -${file.deletions} ===`,
    );
    for (const item of file.items) {
      lines.push(
        `--- Item: ${item.id} | kind: ${item.kind} | old: ${item.oldStart ?? "-"},${item.oldLines ?? "-"} | new: ${item.newStart ?? "-"},${item.newLines ?? "-"} ---`,
      );
      const patch = item.patch.length > PREVIEW_LIMIT
        ? `${item.patch.slice(0, PREVIEW_LIMIT)}\n[preview truncated]`
        : item.patch;
      lines.push(patch, "");
    }
  }

  if (manifest.skipped.length > 0) {
    lines.push("=== Skipped entries ===");
    for (const entry of manifest.skipped) lines.push(`${entry.filePath}: ${entry.reason}`);
    lines.push("");
  }

  return lines.join("\n");
}

