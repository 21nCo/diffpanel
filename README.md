# Conductor

Conductor turns repository changes and snapshots into persistent, agent-generated review chapters. The monorepo keeps the review contract independent from its surfaces so the VS Code/Cursor extension, future web app, and future desktop app can consume the same runs.

## Workspace

- `apps/cli` prepares immutable review runs and publishes validated agent output.
- `apps/vscode` lists generated reviews and opens their items in native diff editors.
- `packages/core` owns the provider-neutral schemas and coverage rules.
- `packages/git` captures worktree, staged, ref-range, and repository snapshots.
- `packages/storage` persists runs in the local Conductor library.
- `skills/conductor-chapters` lets Codex, Claude, or Cursor Agent generate chapters.

## Development

```bash
pnpm install
pnpm validate
pnpm conductor doctor
```

### Local installation

Build and link the CLI so agent skills and the extension share the same local review library:

```bash
pnpm build
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/apps/cli/dist/index.js" "$HOME/.local/bin/conductor"
conductor doctor
```

Install the skill by symlinking `skills/conductor-chapters` into the chosen agent's skill directory. For Codex:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
ln -s "$PWD/skills/conductor-chapters" "${CODEX_HOME:-$HOME/.codex}/skills/conductor-chapters"
```

Build and install the Cursor/VS Code surface:

```bash
pnpm --filter conductor-vscode package
cursor --install-extension apps/vscode/conductor-vscode-0.0.1.vsix
```

During extension development, press `F5` from the monorepo root. The development extension automatically discovers `apps/cli/dist/index.js`; packaged installations use `conductor` from `PATH` unless `conductor.cliPath` is configured.

The default data directory is `~/Library/Application Support/Conductor` on macOS. Set `CONDUCTOR_HOME` to use an isolated location.

### Generate a review

Invoke `$conductor-chapters` from a supported coding agent. The skill prepares an immutable run, generates exact-coverage chapters, validates the JSON, and publishes it. Return to the Conductor activity-bar panel to browse the generated review and open its saved files in native diff editors.
