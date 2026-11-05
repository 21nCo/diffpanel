import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createIterbarMcpServer } from "./server.js";

export const MCP_USAGE = `Usage: iterbar mcp [--root <directory>]

Runs the Iterbar MCP server on stdin and stdout for a coding agent. Its tools read and answer the feedback
that users send from the dev bar, through the daemon that "iterbar dev" runs for the same project.

Options:
  --root <directory>  Project root (default: the current directory)
  -h, --help          Show this help
`;

const STOP_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

export interface McpCommandIo {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: Pick<NodeJS.WritableStream, "write">;
}

type ParsedArgs = { readonly help: true } | { readonly help: false; readonly root: string | undefined };

function parseArgs(args: readonly string[]): ParsedArgs {
  let root: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "-h" || arg === "--help") return { help: true };
    let value: string | undefined;
    if (arg === "--root") {
      index += 1;
      value = args[index];
    } else if (arg.startsWith("--root=")) {
      value = arg.slice("--root=".length);
    } else {
      throw new Error(`Unknown argument ${JSON.stringify(arg)}`);
    }
    if (!value) throw new Error("--root needs a directory");
    if (root !== undefined) throw new Error("--root was given more than once");
    root = value;
  }
  return { help: false, root };
}

/**
 * `iterbar mcp`: serves MCP over stdio until the client closes stdin or a stop signal arrives. Resolves with the
 * process exit code. The server starts whether or not a daemon runs; its tools report `daemon_unavailable` until
 * one does.
 */
export async function runMcp(args: readonly string[], io: McpCommandIo = process): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    io.stderr.write(`iterbar mcp: ${(error as Error).message}\n\n${MCP_USAGE}`);
    return 2;
  }
  if (parsed.help) {
    io.stdout.write(MCP_USAGE);
    return 0;
  }

  let projectRoot: string;
  try {
    // The real path, the same root `iterbar dev` writes into daemon.json.
    projectRoot = await realpath(resolve(parsed.root ?? process.cwd()));
  } catch (error) {
    io.stderr.write(`iterbar mcp: the project root cannot be used: ${(error as Error).message}\n`);
    return 1;
  }

  const mcp = createIterbarMcpServer({ projectRoot, onError: (error) => {
    io.stderr.write(`iterbar mcp: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  } });
  const transport = new StdioServerTransport(io.stdin as NodeJS.ReadStream, io.stdout as NodeJS.WriteStream);
  await new Promise<void>((done) => {
    const stop = () => {
      for (const signal of STOP_SIGNALS) process.off(signal, stop);
      io.stdin.off("end", stop);
      io.stdin.off("close", stop);
      done();
    };
    for (const signal of STOP_SIGNALS) process.once(signal, stop);
    // The client went away: end pending waits instead of keeping the process alive until they time out.
    io.stdin.once("end", stop);
    io.stdin.once("close", stop);
    transport.onclose = stop;
    void mcp.server.connect(transport).catch((error: unknown) => {
      io.stderr.write(`iterbar mcp: ${(error as Error)?.message ?? String(error)}\n`);
      stop();
    });
  });
  await mcp.close();
  return 0;
}
