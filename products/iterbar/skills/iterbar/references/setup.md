# Setting up the Iterbar MCP server

The agent needs two things: the `iterbar` command on `PATH`, and its MCP server registered with the agent CLI.
These steps are for the user (or for you, when the user asks you to set it up).

## The `iterbar` command

From a checkout of the Devroll monorepo:

```bash
pnpm install
pnpm --filter @iterbar/cli... build
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/products/iterbar/cli/dist/cli.js" "$HOME/.local/bin/iterbar"
iterbar --help
```

If `iterbar --help` reports that the command is not found, `$HOME/.local/bin` is not on `PATH`: add
`export PATH="$HOME/.local/bin:$PATH"` to your shell profile (`~/.zshrc` or `~/.bashrc`) and open a new shell. An
agent CLI started some other way may not read that profile; then register the server with the symlink's absolute
path (`$HOME/.local/bin/iterbar`, expanded) as its command instead of `iterbar`.

`iterbar dev --root <project>` runs the daemon for a project; `iterbar mcp --root <project>` runs the MCP server
for the same project. Both default to the current directory. The MCP server starts even when no daemon runs; its
tools report `daemon_unavailable` until one does.

## Registering the server

Pass `--root` with the project's absolute path whenever the agent might start the server from another directory.

Claude Code, from the project root, registering it only for you:

```bash
claude mcp add iterbar -- iterbar mcp --root "$PWD"
```

To share the server with everyone on the project through `.mcp.json`, leave out `--root`: an absolute path from your
machine does not exist on theirs. `iterbar mcp` then serves the directory Claude Code starts it in, the one you run
`claude` from, so start `claude` in the project root.

```bash
claude mcp add --scope project iterbar -- iterbar mcp
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.iterbar]
command = "iterbar"
args = ["mcp", "--root", "/absolute/path/to/project"]
# Long enough for the longest wait_for_feedback you use (at most 1,800 seconds).
tool_timeout_sec = 1900
```

Cursor, in the project's `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "iterbar": { "command": "iterbar", "args": ["mcp", "--root", "${workspaceFolder}"] }
  }
}
```

An agent CLI may end tool calls that take longer than its own timeout. Raise it to cover `wait_for_feedback`'s
timeout, or use a shorter `timeoutSeconds` and wait in a loop.
