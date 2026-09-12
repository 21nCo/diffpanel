#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import { captureReview, type CaptureRequest } from "@diffpanel/git";
import { DiffpanelStore, defaultDiffpanelHome } from "@diffpanel/storage";

const program = new Command();
program
  .name("diffpanel")
  .description("Prepare, publish, and inspect persistent Diffpanel review runs.")
  .version("0.0.0");

program
  .command("prep")
  .description("Capture an immutable review snapshot and print its receipt path.")
  .argument("[range]", "Git range such as main..feature or main...feature")
  .option("--repository <path>", "Repository path", process.cwd())
  .option("--worktree", "Capture staged, unstaged, and untracked changes")
  .option("--staged", "Capture only staged changes")
  .option("--repo [ref]", "Capture a repository-wide snapshot", false)
  .option("--base <ref>", "Base ref for worktree or staged capture", "HEAD")
  .option("--max-files <count>", "Repository snapshot file limit", parseInteger, 2_000)
  .option("--title <title>", "Display name for this review in the Diffpanel panel")
  .option("--json", "Print the full receipt as JSON")
  .action(async (range: string | undefined, options) => {
    const selected = [Boolean(range), options.worktree, options.staged, Boolean(options.repo)].filter(Boolean);
    if (selected.length > 1) throw new Error("Choose only one of a range, --worktree, --staged, or --repo.");
    const request = toCaptureRequest(range, options);
    const captured = await captureReview(request);
    const store = await DiffpanelStore.open();
    try {
      const receipt = await store.createPreparedRun(captured, { title: options.title });
      process.stdout.write(options.json ? `${JSON.stringify(receipt, null, 2)}\n` : `${receipt.receiptPath}\n`);
    } finally {
      store.close();
    }
  });

program
  .command("publish")
  .description("Validate and persist generated chapters for a prepared run.")
  .argument("<review-file>", "Generated review JSON file")
  .requiredOption("--run <run-id>", "Prepared run ID")
  .option("--title <title>", "Display name for this review in the Diffpanel panel")
  .option("--json", "Print the published review as JSON")
  .action(async (reviewFile: string, options) => {
    const review = JSON.parse(await readFile(resolve(reviewFile), "utf8"));
    if (options.title) review.title = options.title;
    const store = await DiffpanelStore.open();
    try {
      const published = await store.publish(options.run, review);
      process.stdout.write(options.json
        ? `${JSON.stringify(published, null, 2)}\n`
        : `Published ${published.chapters.length} chapters for ${published.runId}.\n`);
    } finally {
      store.close();
    }
  });

program
  .command("validate")
  .description("Validate generated chapters without publishing them.")
  .argument("<review-file>", "Generated review JSON file")
  .requiredOption("--run <run-id>", "Prepared run ID")
  .action(async (reviewFile: string, options) => {
    const review = JSON.parse(await readFile(resolve(reviewFile), "utf8"));
    const store = await DiffpanelStore.open();
    try {
      const validated = await store.validate(options.run, review);
      const { manifest } = await store.getRun(options.run);
      process.stdout.write(`Valid review: ${validated.chapters.length} chapters cover every item exactly once; ${manifest.files.length} captured files, ${manifest.skipped.length} skipped paths outside coverage.\n`);
    } finally {
      store.close();
    }
  });

program
  .command("list")
  .description("List generated and prepared review runs.")
  .option("--repository <path>", "Only runs for this repository")
  .option("--include-archived", "Include archived review runs")
  .option("--json", "Print JSON")
  .action(async (options) => {
    const store = await DiffpanelStore.open();
    try {
      const runs = store.listRuns(options.repository ? resolve(options.repository) : undefined, options.includeArchived);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(runs, null, 2)}\n`);
        return;
      }
      for (const run of runs) {
        process.stdout.write(`${run.runId}\t${run.status}\t${run.repositoryName}\t${run.reviewTitle}\t${run.chapterCount} chapters\n`);
      }
    } finally {
      store.close();
    }
  });

program
  .command("title")
  .description("Set or clear the display name for a review run.")
  .argument("<run-id>", "Review run ID")
  .argument("[title]", "Display name shown in the Diffpanel panel")
  .option("--clear", "Revert to the default git-scope label")
  .action(async (runId: string, title: string | undefined, options) => {
    if (Boolean(options.clear) === Boolean(title)) {
      throw new Error("Pass a title or --clear.");
    }
    const store = await DiffpanelStore.open();
    try {
      const summary = store.setReviewTitle(runId, options.clear ? null : title!);
      process.stdout.write(options.clear
        ? `Cleared title for ${runId}; now ${summary.reviewTitle}.\n`
        : `Renamed ${runId} to ${summary.reviewTitle}.\n`);
    } finally {
      store.close();
    }
  });

program
  .command("archive")
  .description("Archive a review run so it is hidden from default listings.")
  .argument("<run-id>", "Review run ID")
  .action(async (runId: string) => {
    const store = await DiffpanelStore.open();
    try {
      store.setArchived(runId, true);
      process.stdout.write(`Archived ${runId}.\n`);
    } finally {
      store.close();
    }
  });

program
  .command("unarchive")
  .description("Restore an archived review run to default listings.")
  .argument("<run-id>", "Review run ID")
  .action(async (runId: string) => {
    const store = await DiffpanelStore.open();
    try {
      store.setArchived(runId, false);
      process.stdout.write(`Restored ${runId}.\n`);
    } finally {
      store.close();
    }
  });

program
  .command("show")
  .description("Read a complete review run.")
  .argument("<run-id>", "Review run ID")
  .option("--json", "Print JSON", true)
  .action(async (runId: string) => {
    const store = await DiffpanelStore.open();
    try {
      process.stdout.write(`${JSON.stringify(await store.getRun(runId), null, 2)}\n`);
    } finally {
      store.close();
    }
  });

program
  .command("content")
  .description("Read immutable file content for an editor diff.")
  .argument("<run-id>", "Review run ID")
  .argument("<file-id>", "Manifest file ID")
  .argument("<side>", "before or after")
  .action(async (runId: string, fileId: string, side: string) => {
    if (side !== "before" && side !== "after") throw new Error("Content side must be before or after.");
    const store = await DiffpanelStore.open();
    try {
      const run = await store.getRun(runId);
      const file = run.manifest.files.find((candidate) => candidate.id === fileId);
      if (!file) throw new Error(`Unknown file ${fileId} in run ${runId}.`);
      const hash = side === "before" ? file.beforeBlob : file.afterBlob;
      if (hash) process.stdout.write(await store.getBlob(hash));
    } finally {
      store.close();
    }
  });

program
  .command("doctor")
  .description("Print the local Diffpanel installation and storage configuration.")
  .option("--json", "Print JSON")
  .action(async (options) => {
    const store = await DiffpanelStore.open();
    try {
      const report = {
        ok: true,
        node: process.version,
        platform: process.platform,
        home: defaultDiffpanelHome(),
        databasePath: store.databasePath,
        runs: store.listRuns(undefined, true).length,
      };
      process.stdout.write(options.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : Object.entries(report).map(([key, value]) => `${key}: ${value}`).join("\n") + "\n");
    } finally {
      store.close();
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`diffpanel: ${message}\n`);
  process.exitCode = 1;
});

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Expected a positive integer, received '${value}'.`);
  return parsed;
}

function toCaptureRequest(range: string | undefined, options: {
  repository: string;
  worktree?: boolean;
  staged?: boolean;
  repo?: boolean | string;
  base: string;
  maxFiles: number;
}): CaptureRequest {
  const repository = resolve(options.repository);
  if (range) return { type: "range", repository, expression: range };
  if (options.worktree) return { type: "worktree", repository, baseRef: options.base };
  if (options.staged) return { type: "staged", repository, baseRef: options.base };
  if (options.repo) {
    return {
      type: "repository",
      repository,
      ref: typeof options.repo === "string" ? options.repo : "HEAD",
      maxFiles: options.maxFiles,
    };
  }
  return { type: "auto", repository };
}
