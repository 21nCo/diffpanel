import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DaemonClient } from "./daemon-client.js";
import { HANDLED_EVENT_RULE, registerTools } from "./tools.js";

/** The MCP server's name and version as it reports them to clients. */
export const ITERBAR_MCP_SERVER_INFO = Object.freeze({ name: "iterbar", version: "0.0.0" });

/** How often a waiting `wait_for_feedback` sends a progress notification to a client that asked for progress. */
export const DEFAULT_HEARTBEAT_MS = 15_000;

/**
 * What every MCP client receives at initialize, with or without the Iterbar skill. It prescribes the same loop as the
 * skill: work comes only from an unfiltered `list_feedback` with the latest cursor or from `wait_for_feedback`, since a
 * filtered listing hands the cursor back unchanged and the next wait would return its items again. Delivery is at
 * least once (a cursor compacted after a large burst, or cut short by a wait's timeout, can hand an event over again),
 * so it also gives the rule for recognising an event the agent already handled.
 */
export const ITERBAR_MCP_INSTRUCTIONS = `Iterbar collects UI feedback that users leave on a running dev page (comments on elements and choices between
variants) and shows your replies and statuses in its dev bar. Every tool talks to the project's Iterbar daemon; when it
is not running, tools fail with error code daemon_unavailable and you should ask the user to run \`iterbar dev\`.
Loop: start with list_feedback without filters and keep its cursor; handle its open items, working items an earlier
session left, and unresolved threads whose last reply is from the user. After that, take new work only from
list_feedback without filters and with your latest cursor (its events are what arrived since that cursor, and its
cursor moves past them) or from wait_for_feedback with your latest cursor. For each item: get_feedback, set_status
"working", change the code, reply with what you did, set_status "done" (or reply with a question and set_status
"needs-info"). Always continue with the newest cursor, including one that a failed wait_for_feedback returns next to
its error. A filtered list_feedback (status, kind or since) hands your cursor back unchanged, so use it only to look
things up, never to pick up work.
${HANDLED_EVENT_RULE}`;

export interface IterbarMcpServerOptions {
  /** Absolute, real path of the project whose daemon the tools use. */
  readonly projectRoot: string;
  /** Defaults to {@link DEFAULT_HEARTBEAT_MS}. */
  readonly heartbeatMs?: number;
  /** Per daemon request; see {@link DaemonClient}. */
  readonly requestTimeoutMs?: number;
  /** Receives unexpected errors, which agents only see as `internal`. Defaults to writing them to stderr. */
  readonly onError?: (error: unknown) => void;
}

export interface IterbarMcpServer {
  readonly server: McpServer;
  /** Ends every pending wait and closes the transport. Idempotent. */
  close(): Promise<void>;
}

function defaultOnError(error: unknown): void {
  process.stderr.write(`iterbar mcp: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
}

/** An MCP server whose tools are clients of the project's Iterbar daemon; connect it to a transport to serve. */
export function createIterbarMcpServer(options: IterbarMcpServerOptions): IterbarMcpServer {
  const client = new DaemonClient({
    projectRoot: options.projectRoot,
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
  });
  const server = new McpServer(ITERBAR_MCP_SERVER_INFO, { instructions: ITERBAR_MCP_INSTRUCTIONS });
  const closing = new AbortController();
  server.server.onclose = () => closing.abort(new Error("The MCP server closed"));
  registerTools({
    server,
    client,
    closing: closing.signal,
    heartbeatMs: options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    onError: options.onError ?? defaultOnError,
  });
  let closed: Promise<void> | undefined;
  return {
    server,
    close() {
      closing.abort(new Error("The MCP server closed"));
      closed ??= server.close();
      return closed;
    },
  };
}
