# Iterbar agent skills

- `iterbar` teaches a coding agent (Claude Code, Codex, Cursor) the Iterbar feedback loop: create variants of a
  section in a slot, iterate on the comments users leave in the dev bar, and collapse a slot to the chosen version.
  It uses the tools of `iterbar mcp`; [iterbar/references/setup.md](iterbar/references/setup.md) shows how to put
  the command on `PATH` and register the server.

Install the skill by symlinking `products/iterbar/skills/iterbar` into the agent's skill directory, from the
monorepo root. For Codex:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
ln -s "$PWD/products/iterbar/skills/iterbar" "${CODEX_HOME:-$HOME/.codex}/skills/iterbar"
```

For Claude Code:

```bash
mkdir -p "$HOME/.claude/skills"
ln -s "$PWD/products/iterbar/skills/iterbar" "$HOME/.claude/skills/iterbar"
```

For Cursor (which also loads skills from `~/.claude/skills` and the default `~/.codex/skills`, not a custom
`CODEX_HOME`):

```bash
mkdir -p "$HOME/.cursor/skills"
ln -s "$PWD/products/iterbar/skills/iterbar" "$HOME/.cursor/skills/iterbar"
```

A symlink keeps the installed skill in step with the checkout.
