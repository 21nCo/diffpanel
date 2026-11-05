import { EventEmitter } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Feedback, FeedbackListQuery } from "iterbar";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_CURSOR_SEEN, MAX_CURSOR_TIME_MS } from "./cursor.js";
import type { DaemonClient } from "./daemon-client.js";
import { feedbackItem } from "./test-support/feedback.js";
import { registerTools } from "./tools.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** The official SDK client connected in memory to the Iterbar tools over a daemon client whose listings the test supplies. */
async function connect(list: (query: FeedbackListQuery, signal?: AbortSignal) => Feedback[] | Promise<Feedback[]>): Promise<Client> {
  const daemon = {
    listFeedback: async (query: FeedbackListQuery = {}, signal?: AbortSignal) => list(query, signal),
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

describe("wait_for_feedback at its deadline", { timeout: 30_000 }, () => {
  it("returns no cursor when its second baseline listing stalls, and an unfiltered listing then shows what arrived once", async () => {
    const base = Date.now() - 60_000;
    const a = feedbackItem("feedback-a", base);
    const b = feedbackItem("feedback-b", base + 10);
    let listings = 0;
    const client = await connect(async (_query, signal) => {
      listings += 1;
      if (listings === 1) return [a];
      if (listings === 2) {
        // feedback-b commits while the second baseline listing stalls far past the deadline.
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 4_000);
          signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason as Error)), { once: true });
        });
      }
      return [a, b];
    });
    const started = Date.now();
    const first = await ok(client, "wait_for_feedback", { timeoutSeconds: 1 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(first).toEqual({ outcome: "timeout", items: [], events: [] });
    // The documented recovery: an unfiltered listing shows every item, and its cursor counts them as seen.
    const listed = await ok(client, "list_feedback", {});
    expect((listed.items as Feedback[]).map((item) => item.id)).toEqual(["feedback-a", "feedback-b"]);
    const quiet = await ok(client, "wait_for_feedback", { cursor: listed.cursor, timeoutSeconds: 0 });
    expect(quiet).toMatchObject({ outcome: "timeout", events: [] });
  });
});

describe("a cursor whose times a Date cannot hold", () => {
  it("is refused as invalid_request by list_feedback and wait_for_feedback, not reported as internal", async () => {
    const client = await connect(() => []);
    const encode = (w: number, c: number) => Buffer.from(JSON.stringify({ v: 1, w, c, s: [] })).toString("base64url");
    for (const name of ["list_feedback", "wait_for_feedback"]) {
      const args = (cursor: string) => (name === "wait_for_feedback" ? { cursor, timeoutSeconds: 0 } : { cursor });
      const latest = await ok(client, name, args(encode(MAX_CURSOR_TIME_MS, MAX_CURSOR_TIME_MS)));
      expect(latest.cursor).toEqual(expect.any(String));
      for (const cursor of [encode(0, MAX_CURSOR_TIME_MS + 1), encode(MAX_CURSOR_TIME_MS + 1, MAX_CURSOR_TIME_MS + 1)]) {
        const result = (await client.callTool({ name, arguments: args(cursor) })) as CallToolResult;
        expect([name, result.isError, result.structuredContent]).toEqual([
          name, true, { error: expect.objectContaining({ code: "invalid_request" }) },
        ]);
      }
    }
  });
});
