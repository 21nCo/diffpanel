# Diffpanel

Diffpanel turns repository changes and snapshots into persistent, agent-generated review chapters. The monorepo keeps the review contract independent from its surfaces so the VS Code/Cursor extension, future web app, and future desktop app can consume the same runs.

## Workspace

- `apps/cli` prepares immutable review runs and publishes validated agent output.
- `apps/vscode` lists generated reviews and opens their items in native diff editors.
- `packages/core` owns the provider-neutral schemas and coverage rules.
- `packages/git` captures worktree, staged, ref-range, and repository snapshots.
- `packages/storage` persists runs in the local Diffpanel library.
- `skills/diffpanel-chapters` lets Codex, Claude, or Cursor Agent generate chapters.

## Development

Diffpanel uses Node.js 22.13 or newer. If you switch Node major versions after
installing dependencies, reinstall or rebuild `better-sqlite3` before running
the CLI because its native binding is tied to the active Node ABI:

```bash
pnpm --filter @diffpanel/storage rebuild better-sqlite3
```

```bash
nvm use
pnpm install
pnpm validate
pnpm diffpanel doctor
```

### Local installation

Build and link the CLI so agent skills and the extension share the same local review library:

```bash
pnpm build
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/apps/cli/dist/index.js" "$HOME/.local/bin/diffpanel"
diffpanel doctor
```

Install the skill by symlinking `skills/diffpanel-chapters` into the chosen agent's skill directory. For Codex:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
ln -s "$PWD/skills/diffpanel-chapters" "${CODEX_HOME:-$HOME/.codex}/skills/diffpanel-chapters"
```

Build and install the Cursor/VS Code surface:

```bash
pnpm --filter diffpanel package
cursor --install-extension apps/vscode/diffpanel-0.1.0.vsix
```

During extension development, press `F5` from the monorepo root. The development extension automatically discovers `apps/cli/dist/index.js`; packaged installations use `diffpanel` from `PATH` unless `diffpanel.cliPath` is configured.

The default data directory is `~/Library/Application Support/Diffpanel` on macOS. Set `DIFFPANEL_HOME` to use an isolated location. Existing installations automatically continue using the former data directory when it is the only store present.

Archive completed reviews without deleting their immutable snapshots:

```bash
diffpanel archive <run-id>
diffpanel list --include-archived
diffpanel unarchive <run-id>
```

Give a review a readable panel name instead of the git-range label:

```bash
diffpanel prep main...feature --title "PR 568 DataFn foundations"
diffpanel publish review.json --run <run-id> --title "PR 568 DataFn foundations"
diffpanel title <run-id> "PR 568 DataFn foundations"
diffpanel title <run-id> --clear
```

### Generate a review

Invoke `$diffpanel-chapters` from a supported coding agent. The skill prepares an immutable run, generates exact-coverage chapters, validates the JSON, and publishes it. Return to the Diffpanel activity-bar panel to browse the generated review and open its saved files in native diff editors.
