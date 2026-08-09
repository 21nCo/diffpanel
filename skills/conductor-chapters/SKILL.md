---
name: conductor-chapters
description: Generate and publish persistent Conductor review chapters for local Git worktrees, staged changes, branch or commit ranges, and repository-wide snapshots. Use when a user asks to organize code into review chapters, create a repo-wide review plan, review current changes through Conductor, or populate the Conductor VS Code/Cursor extension.
---

# Conductor Chapters

Prepare one immutable Conductor run, organize every review item into a coherent chapter hierarchy, validate exact coverage, and publish it to the local review library. Keep the repository read-only throughout generation.

## Prerequisites

Run both checks before preparing a review:

```bash
command -v conductor
git rev-parse --is-inside-work-tree
```

If `conductor` is unavailable, stop and ask the user to install or locally link the Conductor CLI. If the Git check does not print `true`, stop because Conductor requires a repository.

## Prepare the snapshot

Choose the narrowest scope matching the request:

```bash
# Auto: working tree when dirty, otherwise current branch against main/master
conductor prep

conductor prep --worktree
conductor prep --staged
conductor prep main...feature
conductor prep HEAD~5..HEAD
conductor prep --repo HEAD
conductor prep --repo HEAD --max-files 4000
```

Capture stdout as `RECEIPT_PATH`, then read that JSON file. Read its `generationInputPath` completely, in chunks when necessary. The receipt also provides the `runId` used for validation and publication.

Preparation stores immutable file blobs. The user may continue editing after this point. When a preview is insufficient, read the saved content rather than the mutable working tree:

```bash
conductor content <run-id> <file-id> before
conductor content <run-id> <file-id> after
```

## Build the review

Read [references/output-schema.md](references/output-schema.md) before writing the JSON.

Group items by causal and architectural relationship:

- Put foundations before behavior that depends on them.
- Keep tests with the behavior they verify.
- Treat moves and their replacements as one story.
- Split changes only when a reviewer can understand them independently.
- For repository snapshots, use nested chapters for systems, then ordered child chapters for modules or flows.
- Keep items from one file together within a chapter and in source order.
- Use deterministic item IDs exactly as provided; never invent or recalculate them.

Every review item must appear in exactly one chapter. Structural parent chapters may have no direct items when their child chapters own the coverage.

Write summaries for a reviewer unfamiliar with the code. Lead with impact and explain dependencies between chapters. Key changes must be human judgment questions, not lint, type, formatting, or test reminders. Empty `keyChanges` arrays are valid.

## Validate and publish

Write the generated object to a temporary JSON file outside the repository. Validate before publishing:

```bash
conductor validate "$OUTPUT_PATH" --run "$RUN_ID"
conductor publish "$OUTPUT_PATH" --run "$RUN_ID"
```

If validation reports missing, duplicate, or unknown item IDs, repair the JSON and validate again. Do not publish partial coverage.

After publication, report the run ID, chapter count, scope, and that the review is available in the Conductor extension panel.

