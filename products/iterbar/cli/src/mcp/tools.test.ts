import { EventEmitter } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Feedback } from "iterbar";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_CURSOR_SEEN } from "./cursor.js";
import type { DaemonClient } from "./daemon-client.js";
import { feedbackItem } from "./test-support/feedback.js";
import { registerTools } from "./tools.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** The official SDK client connected in memory to the Iterbar tools over a daemon client whose listings the test supplies. */
async function connect(list: () => Feedback[]): Promise<Client> {
  const daemon = {
    listFeedback: async () => list(),
    openEvents: async () => Object.assign(new EventEmitter(), { terminate: () => undefined }),
  } as unknown as DaemonClient;
  const server = new McpServer({ name: "iterbar", version: "0.0.0" });
  registerTools({ server, client: daemon, closing: new AbortController().signal, heartbeatMs: 60_000, onError: (error) => { throw error; } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "iterbar-tools-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(() => client.close(), () => server.close());
  return client;
}

async function ok(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 })) as CallToolResult;
  expect(result.isError, JSON.stringify(result.content).slice(0, 500)).toBeFalsy();
  return result.structuredContent as Record<string, unknown>;
}

describe("list_feedback cursors after a burst", { timeout: 60_000 }, () => {
  const base = Date.now() - 600_000;
  const count = 2 * MAX_CURSOR_SEEN + 1;
  /** feedback-a with `replies` user replies, one millisecond apart. */
  const answered = (replies: number) => feedbackItem("feedback-a", base, Array.from({ length: replies }, (_, index) =>
    [`reply-${String(index).padStart(5, "0")}`, "user", base + 1_000 + index] as const));
  const keyOf = (index: number) => `reply-${String(index).padStart(5, "0")}`;

  it("reports more events than a cursor holds through an unfiltered listing, and the next call accepts its cursor", async () => {
    let items = [answered(0)];
    const client = await connect(() => items);
    const start = await ok(client, "list_feedback", {});
    items = [answered(count)];
    const burst = await ok(client, "list_feedback", { cursor: start.cursor });
    expect(burst.events).toHaveLength(count);
    const again = await ok(client, "list_feedback", { cursor: burst.cursor });
    expect(again.events).toEqual([]);
    items = [answered(count + 1)];
    const waited = await ok(client, "wait_for_feedback", { cursor: again.cursor, timeoutSeconds: 1 });
    expect(waited).toMatchObject({ outcome: "feedback", events: [{ kind: "user_reply", replyId: keyOf(count) }] });
    const quiet = await ok(client, "wait_for_feedback", { cursor: waited.cursor, timeoutSeconds: 0 });
    expect(quiet).toMatchObject({ outcome: "timeout", events: [] });
  });

  it("issues an accepted cursor without one, filtered or not, when a burst lands between its listings", async () => {
    for (const filters of [{}, { status: "open" }]) {
      let listings = 0;
      const client = await connect(() => (++listings === 1 ? [answered(0)] : [answered(count)]));
      const listed = await ok(client, "list_feedback", filters);
      const next = await ok(client, "list_feedback", { cursor: listed.cursor });
      expect(next.events).toEqual([]);
    }
  });
});
