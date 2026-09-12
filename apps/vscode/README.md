# Diffpanel

Diffpanel turns repository changes and snapshots into persistent, agent-generated review chapters inside VS Code and Cursor.

Use the Diffpanel activity-bar view to browse generated reviews, inspect their chapter hierarchy, and open saved review items in the editor's native diff view.

## Requirements

This preview requires the Diffpanel CLI to be available as `diffpanel` on `PATH`, or configured with the `diffpanel.cliPath` setting. If the CLI is a JavaScript file or symlink, Diffpanel locates Node.js automatically; you can override it with `diffpanel.nodePath`.

The CLI and extension must use the same local review library. Override its location with `diffpanel.home` or the `DIFFPANEL_HOME` environment variable when needed.

## Using Diffpanel

1. Open a Git repository in VS Code or Cursor.
2. Generate and publish a review with the `diffpanel-chapters` agent skill.
3. Open the Diffpanel activity-bar view.
4. Select a review, then open any item in the native diff editor.

The extension refreshes automatically. You can also run **Diffpanel: Refresh Reviews** from the Command Palette.

## Settings

- `diffpanel.cliPath`: path to the Diffpanel CLI executable or built `index.js`.
- `diffpanel.nodePath`: optional Node.js executable for a JavaScript CLI.
- `diffpanel.home`: optional Diffpanel data directory.
- `diffpanel.refreshIntervalSeconds`: review-library polling interval.

## Current status

Diffpanel is an early preview. Its package is currently distributed as `UNLICENSED`.

## Reviewing large migrations

Review Details shows one row per file. Single-hunk files open directly; multi-hunk files have a compact change-count button beside the filename to expand hunk navigation. Chapter wording and navigation appear only for files whose changes span multiple chapters. Use **All review files** for a globally deduplicated list, or follow a file's other-chapter links to review its remaining changes. File and hunk lists show 30 entries at a time; file buttons open the saved immutable diff.

Repeated complete static import-source text rewrites across two or more files, including renamed files, collapse into transformation groups with mappings, representative diffs, examples, and complete membership. Exact-content renames are grouped using saved content hashes. Mixed edits, changed bindings, dynamic imports, and unsupported syntax stay individually visible. Grouping does not verify behavior or mark anything reviewed.

Observed path maps open supporting saved diffs. Optional generated Mermaid diagrams explain chapter or review flows, with source fallback and evidence links. Diagram evidence is validated against the snapshot and chapter scope; it does not replace exact chapter coverage.

### Browser verification

After building workspace dependencies, run `pnpm --dir apps/vscode test:browser`. Install Playwright Chromium first (`pnpm --dir apps/vscode exec playwright install chromium`), or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an existing Chromium/Chrome executable. Tests use an isolated profile and exercise the bundled webview with a simulated VS Code messaging bridge and content security policy. They do not install or launch the extension itself.


Pure moves and metadata-only changes are now captured as file review items. Historical reviews retain their original snapshots: prepare a fresh review to recover paths skipped by older versions. The Snapshot coverage section separates captured files/items from excluded paths and lists the exclusion reasons.

Import grouping can infer segment-aligned prefix migrations across different module paths. A rule requires multiple distinct sources in multiple files, and every observed suffix must be unchanged. A moved file with only supported import edits is labeled “Moved + import rewrite”; additional behavior edits remain visible. Compression counts report grouped and individual changes separately.

The Diagrams directory appears only when the entire review overview is selected. It lists overview and chapter visuals, including deeply nested chapters, and explains absent overviews. Diagram buttons open only the rendered diagram in an editor tab, with expandable Mermaid source and saved evidence references. Chapters and subchapters with their own diagram show an Open chapter diagram button that opens the same diagram editor; diagrams are not rendered inside detail panels. Newly prepared reviews require a diagram assessment: architectural changes normally include a before/after overview and focused chapter visuals, with evidence references. Explicit omission reasons are required when those views are not appropriate. Older reviews without assessments remain readable.

Replay grouping against a saved review without changing it:

```sh
node apps/vscode/scripts/measure-review.mjs /absolute/path/manifest.json /absolute/path/review.json
```

The recorded TIDY-477 fixture contains selected real renamed imports and a mixed edit from `b598ae69..ce01fcd0`. Git capture tests additionally exercise pure moves, empty-file moves, and mode-only changes in temporary repositories. The replay helper verifies item coverage while measuring compression in the original chapter scopes.
