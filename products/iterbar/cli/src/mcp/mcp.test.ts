import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Feedback, FeedbackDraft } from "iterbar";
import { attachmentPath, iterbarPaths } from "iterbar/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startDaemon, type RunningDaemon } from "../daemon/index.js";
import { bearer, json, multipart, send } from "../daemon/test-support/client.js";
import { chooseVariantDraft, commentDraft, deadPid, EVIDENCE, PNG, temporaryProject } from "../store/test-support/helpers.js";
import { createIterbarMcpServer } from "./server.js";

/** The built command line; the package's test script builds it first. */
const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const CLIENT_INFO = { name: "iterbar-protocol-test", version: "1.0.0" };
const TOOL_NAMES = ["get_feedback", "list_feedback", "list_slots", "reply", "set_status", "wait_for_feedback"];

let root: string;
let cleanup: () => Promise<void>;
const daemons: RunningDaemon[] = [];
const clients: Client[] = [];
const unexpected: unknown[] = [];

beforeEach(async () => {
  ({ root, cleanup } = await temporaryProject());
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
  await cleanup();
  expect(unexpected.splice(0)).toEqual([]);
});

async function start(): Promise<RunningDaemon> {
  const daemon = await startDaemon({ projectRoot: root, onError: (error) => unexpected.push(error) });
  daemons.push(daemon);
  return daemon;
}

/** The official SDK client, connected over stdio to `iterbar mcp` for the test project. */
async function connect(): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--root", root], stderr: "pipe" });
  const client = new Client(CLIENT_INFO);
  await client.connect(transport);
  clients.push(client);
  return { client, transport };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as CallToolResult;
}

/** The structured result of a successful call. */
async function ok<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await call(client, name, args);
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.structuredContent as T;
}

function errorOf(result: CallToolResult): { code: string; message: string } {
  expect(result.isError).toBe(true);
  return (result.structuredContent as { error: { code: string; message: string } }).error;
}

/** Sends feedback the way the dev bar does. */
async function sendFeedback(daemon: RunningDaemon, draft: FeedbackDraft = commentDraft, files = true): Promise<Feedback> {
  const form = await multipart({ feedback: draft, ...(files ? { screenshot: PNG, evidence: EVIDENCE } : {}) });
  const response = await send(daemon.info, {
    method: "POST", path: "/feedback", headers: { ...bearer(daemon.info.token), ...form.headers }, body: form.body,
  });
  expect(response.status, response.text).toBe(201);
  return JSON.parse(response.text) as Feedback;
}

async function userReply(daemon: RunningDaemon, feedbackId: string, text: string): Promise<Feedback> {
  const response = await send(daemon.info, {
    method: "POST",
    path: `/feedback/${feedbackId}/replies`,
    headers: { ...bearer(daemon.info.token), ...json },
    body: JSON.stringify({ schemaVersion: 1, author: { kind: "user", name: null }, text }),
  });
  expect(response.status, response.text).toBe(200);
  return JSON.parse(response.text) as Feedback;
}

interface WaitOutput {
  outcome: "feedback" | "timeout";
  items: Feedback[];
  events: Array<{ feedbackId: string; kind: string; replyId?: string }>;
  cursor: string;
}

describe("iterbar mcp", { timeout: 60_000 }, () => {
  it("offers the feedback-loop tools with a bounded wait timeout", async () => {
    const { client } = await connect();
    expect(client.getServerVersion()?.name).toBe("iterbar");
    expect(client.getInstructions()).toContain("iterbar dev");
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES);
    const wait = tools.find((tool) => tool.name === "wait_for_feedback");
    expect(wait?.inputSchema.properties?.timeoutSeconds).toMatchObject({ default: 300, maximum: 1800 });
    const status = tools.find((tool) => tool.name === "set_status");
    expect(status?.inputSchema.properties?.status).toMatchObject({ enum: ["working", "needs-info", "done", "resolved"] });
  });

  it("lists, reads with attachments, replies to and sets the status of feedback through the daemon", async () => {
    const daemon = await start();
    const { client } = await connect();
    const comment = await sendFeedback(daemon);
    const choice = await sendFeedback(daemon, chooseVariantDraft, false);

    const all = await ok<{ items: Feedback[]; cursor: string }>(client, "list_feedback");
    expect(all.items.map((item) => item.id)).toEqual([comment.id, choice.id]);
    expect(all.cursor).toEqual(expect.any(String));
    const choices = await ok<{ items: Feedback[] }>(client, "list_feedback", { kind: "choose_variant" });
    expect(choices.items).toMatchObject([{ id: choice.id, choice: { slot: "pricing", version: "v2" } }]);

    const read = await call(client, "get_feedback", { feedbackId: comment.id });
    expect(read.isError).toBeFalsy();
    const screenshotPath = attachmentPath(root, comment.id, comment.screenshot as NonNullable<Feedback["screenshot"]>);
    const evidencePath = attachmentPath(root, comment.id, (comment.evidence as NonNullable<Feedback["evidence"]>).attachment);
    expect(read.structuredContent).toMatchObject({
      feedback: { id: comment.id, text: commentDraft.text, target: { sourceLocation: { path: "src/routes/Pricing.tsx" } } },
      attachments: [
        { kind: "screenshot", mediaType: "image/png", path: screenshotPath, inlined: true },
        { kind: "evidence", mediaType: "application/json", path: evidencePath, inlined: true },
      ],
    });
    const image = read.content.find((block) => block.type === "image");
    expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(Buffer.from((image as { data: string }).data, "base64")).toEqual(PNG);
    const resource = read.content.find((block) => block.type === "resource");
    expect(resource).toMatchObject({
      resource: { uri: pathToFileURL(evidencePath).href, mimeType: "application/json", text: EVIDENCE.toString("utf8") },
    });
    const bare = await call(client, "get_feedback", { feedbackId: comment.id, includeAttachments: false });
    expect(bare.content.map((block) => block.type)).toEqual(["text"]);

    for (const status of ["working", "needs-info", "done", "resolved"]) {
      const { feedback } = await ok<{ feedback: Feedback }>(client, "set_status", { feedbackId: comment.id, status });
      expect(feedback.status).toBe(status);
    }
    const { feedback: replied } = await ok<{ feedback: Feedback }>(client, "reply", { feedbackId: comment.id, text: "Made it larger." });
    expect(replied.replies).toMatchObject([{ text: "Made it larger.", author: { kind: "agent", name: CLIENT_INFO.name } }]);

    // The daemon, the only writer, holds what the tools did.
    const stored = await send(daemon.info, { path: `/feedback/${comment.id}`, headers: bearer(daemon.info.token) });
    expect(JSON.parse(stored.text)).toMatchObject({ status: "resolved", replies: [{ text: "Made it larger." }] });
    const resolved = await ok<{ items: Feedback[] }>(client, "list_feedback", { status: "resolved" });
    expect(resolved.items.map((item) => item.id)).toEqual([comment.id]);
  });

  it("lists the slots and versions that pages reported", async () => {
    const daemon = await start();
    const { client } = await connect();
    expect(await ok(client, "list_slots")).toEqual({ pages: [] });
    const report = {
      schemaVersion: 1,
      pageUrl: "http://localhost:5173/pricing",
      reportedAt: "2026-11-05T10:00:00.000Z",
      slots: [{ slot: "pricing", versions: ["v1", "v2", "v3"], defaultVersion: "v1", activeVersion: "v2", mounts: 1 }],
    };
    const posted = await send(daemon.info, {
      method: "POST", path: "/slots", headers: { ...bearer(daemon.info.token), ...json }, body: JSON.stringify(report),
    });
    expect(posted.status).toBe(204);
    expect(await ok(client, "list_slots")).toEqual({ pages: [report] });
  });

  it("passes the daemon's typed errors through and refuses statuses an agent does not post", async () => {
    await start();
    const { client } = await connect();
    expect(errorOf(await call(client, "get_feedback", { feedbackId: "feedback-missing" })).code).toBe("not_found");
    expect(errorOf(await call(client, "reply", { feedbackId: "feedback-missing", text: "hi" })).code).toBe("not_found");
    for (const args of [{ feedbackId: "feedback-missing", status: "open" }, { feedbackId: "../x", status: "done" }]) {
      const result = await call(client, "set_status", args);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("Input validation error");
    }
    expect(errorOf(await call(client, "wait_for_feedback", { cursor: "not-a-cursor", timeoutSeconds: 0 })).code).toBe("invalid_request");
    const tooLong = await call(client, "wait_for_feedback", { timeoutSeconds: 1801 });
    expect(tooLong.isError).toBe(true);
    expect(JSON.stringify(tooLong.content)).toContain("timeoutSeconds");
  });
});

describe("daemon_unavailable", { timeout: 60_000 }, () => {
  const everyTool: Array<[string, Record<string, unknown>]> = [
    ["list_feedback", {}],
    ["get_feedback", { feedbackId: "feedback-1" }],
    ["reply", { feedbackId: "feedback-1", text: "On it." }],
    ["set_status", { feedbackId: "feedback-1", status: "working" }],
    ["list_slots", {}],
    ["wait_for_feedback", { timeoutSeconds: 5 }],
  ];

  async function expectUnavailable(client: Client): Promise<string[]> {
    const messages: string[] = [];
    for (const [name, args] of everyTool) {
      const error = errorOf(await call(client, name, args));
      expect(error.code, name).toBe("daemon_unavailable");
      expect(error.message, name).toContain("iterbar dev");
      messages.push(error.message);
    }
    return messages;
  }

  it("is what every tool returns while no daemon runs, until one starts", async () => {
    const { client } = await connect();
    const messages = await expectUnavailable(client);
    expect(messages[0]).toContain("does not exist");

    const daemon = await start();
    expect(await ok(client, "list_feedback")).toMatchObject({ items: [] });
    await daemon.close();
    await expectUnavailable(client);
  });

  it("is returned for a daemon.json left by a daemon that is gone or describes another project", async () => {
    const { client } = await connect();
    const { daemonFile, directory } = iterbarPaths(root);
    await mkdir(directory, { recursive: true });
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const freePort = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const leftover = {
      schemaVersion: 1, host: "127.0.0.1", port: freePort, token: "f".repeat(64), pid: await deadPid(), projectRoot: root,
      startedAt: "2026-11-01T00:00:00.000Z",
    };
    const cases: Array<[Record<string, unknown> | string, string]> = [
      [leftover, "no longer running"],
      // A live pid (this process) whose port nothing listens on.
      [{ ...leftover, pid: process.pid }, "could not be reached"],
      [{ ...leftover, pid: process.pid, projectRoot: "/elsewhere" }, "/elsewhere"],
      ["{", "not valid JSON"],
    ];
    for (const [contents, reason] of cases) {
      await writeFile(daemonFile, typeof contents === "string" ? contents : JSON.stringify(contents));
      const messages = await expectUnavailable(client);
      expect(messages[0]).toContain(reason);
    }
  });

  it("is returned when the daemon at the recorded address does not accept the recorded token", async () => {
    const daemon = await start();
    const { client } = await connect();
    await writeFile(iterbarPaths(root).daemonFile, JSON.stringify({ ...daemon.info, token: "e".repeat(64) }));
    const error = errorOf(await call(client, "list_feedback"));
    expect(error).toMatchObject({ code: "daemon_unavailable", message: expect.stringContaining("stale") });
  });
});

describe("wait_for_feedback", { timeout: 60_000 }, () => {
  it("resolves when new feedback arrives after the cursor", async () => {
    const daemon = await start();
    const { client } = await connect();
    const earlier = await sendFeedback(daemon);
    const { cursor } = await ok<{ cursor: string }>(client, "list_feedback");

    const waiting = ok<WaitOutput>(client, "wait_for_feedback", { cursor, timeoutSeconds: 30 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const fresh = await sendFeedback(daemon, chooseVariantDraft, false);
    const result = await waiting;
    expect(result.outcome).toBe("feedback");
    expect(result.items.map((item) => item.id)).toEqual([fresh.id]);
    expect(result.events).toEqual([expect.objectContaining({ feedbackId: fresh.id, kind: "created" })]);
    expect(result.items.map((item) => item.id)).not.toContain(earlier.id);
  });

  it("times out with no items and a cursor when nothing arrives", async () => {
    const daemon = await start();
    const { client } = await connect();
    await sendFeedback(daemon);
    const started = Date.now();
    const result = await ok<WaitOutput>(client, "wait_for_feedback", { timeoutSeconds: 1 });
    const elapsed = Date.now() - started;
    expect(result).toMatchObject({ outcome: "timeout", items: [], events: [] });
    expect(result.cursor).toEqual(expect.any(String));
    expect(elapsed).toBeGreaterThanOrEqual(1000);
    expect(elapsed).toBeLessThan(10_000);
  });

  it("without a cursor, counts only what arrives after the call", async () => {
    const daemon = await start();
    const { client } = await connect();
    const before = await sendFeedback(daemon);
    const waiting = ok<WaitOutput>(client, "wait_for_feedback", { timeoutSeconds: 30 });
    // Exactly one arrival once the call has reached the server, whether or not its event stream is open yet.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = await sendFeedback(daemon, chooseVariantDraft, false);
    const result = await waiting;
    expect(result.outcome).toBe("feedback");
    expect(result.items.map((item) => item.id)).toEqual([after.id]);
    expect(result.items.map((item) => item.id)).not.toContain(before.id);
  });

  it("never misses feedback sent between waits and never returns it twice", async () => {
    const daemon = await start();
    const { client } = await connect();
    const first = await ok<WaitOutput>(client, "wait_for_feedback", { timeoutSeconds: 0 });
    expect(first.outcome).toBe("timeout");

    // Arrives while the agent is busy, with no wait pending.
    const between = await sendFeedback(daemon);
    const second = await ok<WaitOutput>(client, "wait_for_feedback", { cursor: first.cursor, timeoutSeconds: 30 });
    expect(second).toMatchObject({ outcome: "feedback", items: [{ id: between.id }] });

    const third = await ok<WaitOutput>(client, "wait_for_feedback", { cursor: second.cursor, timeoutSeconds: 1 });
    expect(third).toMatchObject({ outcome: "timeout", items: [] });
  });

  it("is not woken by the agent's own reply or status, and is woken by the user's reply", async () => {
    const daemon = await start();
    const { client } = await connect();
    const feedback = await sendFeedback(daemon);
    const { cursor } = await ok<{ cursor: string }>(client, "list_feedback");

    const agentOnly = ok<WaitOutput>(client, "wait_for_feedback", { cursor, timeoutSeconds: 2 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await ok(client, "set_status", { feedbackId: feedback.id, status: "needs-info" });
    await ok(client, "reply", { feedbackId: feedback.id, text: "Which button?" });
    const quiet = await agentOnly;
    expect(quiet.outcome).toBe("timeout");

    const answered = ok<WaitOutput>(client, "wait_for_feedback", { cursor: quiet.cursor, timeoutSeconds: 30 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const withReply = await userReply(daemon, feedback.id, "The Buy now button.");
    const result = await answered;
    expect(result.outcome).toBe("feedback");
    expect(result.items).toMatchObject([{ id: feedback.id, status: "needs-info" }]);
    const userReplyId = withReply.replies.find((reply) => reply.author.kind === "user")?.id;
    expect(result.events).toEqual([expect.objectContaining({ feedbackId: feedback.id, kind: "user_reply", replyId: userReplyId })]);
  });

  it("hands over a user's answer on a needs-info thread after a filtered re-list, exactly once", async () => {
    const daemon = await start();
    const { client } = await connect();
    const feedback = await sendFeedback(daemon);
    // The skill's loop: list the open items, ask a question, then come back to the open items.
    const open = await ok<{ items: Feedback[]; cursor: string }>(client, "list_feedback", { status: "open" });
    expect(open.items.map((item) => item.id)).toEqual([feedback.id]);
    await ok(client, "set_status", { feedbackId: feedback.id, status: "needs-info" });
    await ok(client, "reply", { feedbackId: feedback.id, text: "Which button?" });
    const answered = await userReply(daemon, feedback.id, "The Buy now button.");
    const answerId = answered.replies.find((reply) => reply.author.kind === "user")?.id;

    // The thread stays needs-info, so the filter hides it; the cursor must not count its answer as seen.
    const relisted = await ok<{ items: Feedback[]; cursor: string }>(client, "list_feedback", { status: "open", cursor: open.cursor });
    expect(relisted).toEqual({ items: [], cursor: open.cursor });
    const result = await ok<WaitOutput>(client, "wait_for_feedback", { cursor: relisted.cursor, timeoutSeconds: 5 });
    expect(result.outcome).toBe("feedback");
    expect(result.events).toEqual([expect.objectContaining({ feedbackId: feedback.id, kind: "user_reply", replyId: answerId })]);

    // An unfiltered listing with the cursor says what is new and moves past it; nothing is handed over twice.
    const again = await userReply(daemon, feedback.id, "The one in the header.");
    const secondId = again.replies.at(-1)?.id;
    const full = await ok<{ items: Feedback[]; events: WaitOutput["events"]; cursor: string }>(client, "list_feedback", {
      cursor: result.cursor,
    });
    expect(full.events).toEqual([expect.objectContaining({ feedbackId: feedback.id, kind: "user_reply", replyId: secondId })]);
    const quiet = await ok<WaitOutput>(client, "wait_for_feedback", { cursor: full.cursor, timeoutSeconds: 1 });
    expect(quiet).toMatchObject({ outcome: "timeout", items: [] });
  });

  it("follows the skill's loop without handing over handled work again, unlike a filtered listing", async () => {
    const daemon = await start();
    const { client } = await connect();
    const session = await ok<{ cursor: string }>(client, "list_feedback");
    const arrived = await sendFeedback(daemon);

    // A filtered listing shows the new item but hands the cursor back unchanged: the next wait returns it again.
    const filtered = await ok<{ items: Feedback[]; cursor: string }>(client, "list_feedback", { status: "open", cursor: session.cursor });
    expect(filtered).toEqual({ items: [expect.objectContaining({ id: arrived.id })], cursor: session.cursor });

    // The skill takes work from an unfiltered listing with the cursor, whose events say what is new.
    const pickup = await ok<{ items: Feedback[]; events: WaitOutput["events"]; cursor: string }>(client, "list_feedback", {
      cursor: session.cursor,
    });
    expect(pickup.events).toEqual([expect.objectContaining({ feedbackId: arrived.id, kind: "created" })]);
    await ok(client, "set_status", { feedbackId: arrived.id, status: "working" });
    await ok(client, "reply", { feedbackId: arrived.id, text: "Made the button larger." });
    await ok(client, "set_status", { feedbackId: arrived.id, status: "done" });

    const quiet = await ok<WaitOutput>(client, "wait_for_feedback", { cursor: pickup.cursor, timeoutSeconds: 1 });
    expect(quiet).toMatchObject({ outcome: "timeout", items: [], events: [] });
    const repeated = await ok<WaitOutput>(client, "wait_for_feedback", { cursor: filtered.cursor, timeoutSeconds: 0 });
    expect(repeated.events).toEqual([expect.objectContaining({ feedbackId: arrived.id, kind: "created" })]);
  });

  it("fails with daemon_unavailable when the daemon stops during the wait", async () => {
    const daemon = await start();
    const { client } = await connect();
    const waiting = call(client, "wait_for_feedback", { timeoutSeconds: 30 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await daemon.close();
    const failed = await waiting;
    expect(errorOf(failed).code).toBe("daemon_unavailable");
    // The failure carries the cursor of the wait's baseline, so the agent resumes from it once the daemon is back.
    const { cursor } = failed.structuredContent as { cursor?: unknown };
    expect(typeof cursor).toBe("string");
    const restarted = await start();
    const feedback = await sendFeedback(restarted);
    const resumed = await ok<WaitOutput>(client, "wait_for_feedback", { cursor, timeoutSeconds: 10 });
    expect(resumed).toMatchObject({ outcome: "feedback", events: [{ feedbackId: feedback.id, kind: "created" }] });
  });

  it("ends with the server when the client disconnects mid-wait", { timeout: 30_000 }, async () => {
    await start();
    const { client, transport } = await connect();
    const pid = transport.pid as number;
    const exited = new Promise<number>((resolve) => {
      const started = Date.now();
      const poll = setInterval(() => {
        try {
          process.kill(pid, 0);
        } catch {
          clearInterval(poll);
          resolve(Date.now() - started);
        }
      }, 25);
    });
    void call(client, "wait_for_feedback", { timeoutSeconds: 1800 }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 500));
    clients.splice(clients.indexOf(client), 1);
    // close() ends stdin and only signals the process if it is still running two seconds later.
    await client.close();
    expect(await exited).toBeLessThan(2000);
  });

  it("treats a cancelled wait as a cancellation, not as an unexpected failure", async () => {
    await start();
    const mcp = createIterbarMcpServer({ projectRoot: root, onError: (error) => unexpected.push(error) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcp.server.connect(serverTransport);
    const client = new Client(CLIENT_INFO);
    await client.connect(clientTransport);
    clients.push(client);
    const controller = new AbortController();
    const waiting = client.callTool({ name: "wait_for_feedback", arguments: { timeoutSeconds: 30 } }, undefined, {
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();
    await expect(waiting).rejects.toThrow();
    // The server sees the cancellation and ends the wait; afterEach checks that nothing was reported.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await mcp.close();
  });

  it("times out on schedule and keeps sending progress while status changes keep arriving", async () => {
    const daemon = await start();
    const feedback = await sendFeedback(daemon);
    const mcp = createIterbarMcpServer({ projectRoot: root, heartbeatMs: 100, onError: (error) => unexpected.push(error) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcp.server.connect(serverTransport);
    const client = new Client(CLIENT_INFO);
    await client.connect(clientTransport);
    clients.push(client);
    const { cursor } = await ok<{ cursor: string }>(client, "list_feedback");

    const progress: number[] = [];
    const started = Date.now();
    let settled = false;
    const waiting = client.callTool({ name: "wait_for_feedback", arguments: { cursor, timeoutSeconds: 2 } }, undefined, {
      onprogress: (update) => progress.push(update.progress),
      timeout: 1000,
      resetTimeoutOnProgress: true,
    }).finally(() => (settled = true));
    // Status changes from another agent, as fast as the daemon takes them, until the wait ends.
    let changes = 0;
    while (!settled) {
      const status = changes++ % 2 ? "working" : "needs-info";
      const response = await send(daemon.info, {
        method: "POST",
        path: `/feedback/${feedback.id}/status`,
        headers: { ...bearer(daemon.info.token), ...json },
        body: JSON.stringify({ schemaVersion: 1, status }),
      });
      expect(response.status, response.text).toBe(200);
    }
    const result = await waiting;
    const elapsed = Date.now() - started;
    expect((result.structuredContent as WaitOutput).outcome).toBe("timeout");
    expect(elapsed).toBeGreaterThanOrEqual(2000);
    expect(elapsed).toBeLessThan(3500);
    expect(changes).toBeGreaterThan(10);
    expect(progress.length).toBeGreaterThanOrEqual(10);
    await mcp.close();
  });

  it("sends progress while waiting to a client that asked for it", async () => {
    await start();
    const mcp = createIterbarMcpServer({ projectRoot: root, heartbeatMs: 100, onError: (error) => unexpected.push(error) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcp.server.connect(serverTransport);
    const client = new Client(CLIENT_INFO);
    await client.connect(clientTransport);
    clients.push(client);
    const progress: number[] = [];
    const result = await client.callTool({ name: "wait_for_feedback", arguments: { timeoutSeconds: 1 } }, undefined, {
      onprogress: (update) => progress.push(update.progress),
      timeout: 300,
      resetTimeoutOnProgress: true,
    });
    expect((result.structuredContent as WaitOutput).outcome).toBe("timeout");
    expect(progress.length).toBeGreaterThanOrEqual(3);
    await mcp.close();
  });
});
