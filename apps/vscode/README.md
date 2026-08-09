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
