import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import {
  daemonInfoSchema,
  feedbackSchema,
  MAX_ATTACHMENT_BYTES,
  parseMessageJson,
  webSocketProtocols,
  type DaemonEvent,
  type Feedback,
} from "iterbar";
import { iterbarPaths } from "iterbar/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chooseVariantDraft, commentDraft, deadPid, EVIDENCE, PNG, temporaryProject } from "../store/test-support/helpers.js";
import { startDaemon, type RunningDaemon } from "./daemon.js";
import { MAX_FEEDBACK_BODY_BYTES } from "./routes.js";
import { bearer, connectEvents, json, multipart, send, type EventClient } from "./test-support/client.js";

let root: string;
let cleanup: () => Promise<void>;
const running: RunningDaemon[] = [];
const clients: EventClient[] = [];
const unexpected: unknown[] = [];

beforeEach(async () => {
  ({ root, cleanup } = await temporaryProject());
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Promise.all(running.splice(0).map((daemon) => daemon.close()));
  await cleanup();
  expect(unexpected.splice(0)).toEqual([]);
});

async function start(now?: () => number): Promise<RunningDaemon> {
  const daemon = await startDaemon({ projectRoot: root, onError: (error) => unexpected.push(error), ...(now ? { now } : {}) });
  running.push(daemon);
  return daemon;
}

async function events(daemon: RunningDaemon): Promise<EventClient> {
  const result = await connectEvents(daemon.info);
  if (!result.accepted) throw new Error(`events refused: ${result.status} ${result.text}`);
  clients.push(result.client);
  return result.client;
}

/** `fetch` from Node.js, as the MCP server and CLI call the daemon: token only, no Origin. */
function call(daemon: RunningDaemon, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${daemon.url}${path}`, { ...init, headers: { ...bearer(daemon.info.token), ...init.headers } });
}

function postJson(daemon: RunningDaemon, path: string, body: unknown): Promise<Response> {
  return call(daemon, path, { method: "POST", headers: json, body: JSON.stringify(body) });
}

async function create(daemon: RunningDaemon, parts: Parameters<typeof multipart>[0]) {
  const form = await multipart(parts);
  return send(daemon.info, {
    method: "POST", path: "/feedback", headers: { ...bearer(daemon.info.token), ...form.headers }, body: form.body,
  });
}

async function storedItems(): Promise<string[]> {
  return readdir(iterbarPaths(root).feedbackDirectory);
}

async function errorOf(response: { json(): Promise<unknown> } | { text: string }) {
  const body = "text" in response ? JSON.parse(response.text) : await response.json();
  return (body as { error: { code: string } }).error.code;
}

describe("daemon.json", () => {
  it("describes the running daemon with mode 0600 and is removed on shutdown", async () => {
    const daemon = await start();
    const { daemonFile } = iterbarPaths(root);
    const info = parseMessageJson(daemonInfoSchema, await readFile(daemonFile, "utf8"), "daemon.json");
    expect(info).toEqual(daemon.info);
    expect(info).toMatchObject({ host: "127.0.0.1", pid: process.pid, projectRoot: root });
    expect(info.token).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== "win32") expect((await stat(daemonFile)).mode & 0o777).toBe(0o600);
    expect((await call(daemon, "/feedback")).status).toBe(200);

    await daemon.close();
    await expect(stat(daemonFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fetch(`${daemon.url}/feedback`)).rejects.toThrow();
  });

  it("replaces a daemon.json that a daemon which did not shut down left behind", async () => {
    const { daemonFile, directory } = iterbarPaths(root);
    await (await start()).close();
    running.length = 0;
    const leftover = {
      schemaVersion: 1, host: "127.0.0.1", port: 9, token: "f".repeat(64), pid: await deadPid(), projectRoot: root,
      startedAt: "2026-11-01T00:00:00.000Z",
    };
    await writeFile(daemonFile, JSON.stringify(leftover), { mode: 0o644 });

    const daemon = await start();
    const info = parseMessageJson(daemonInfoSchema, await readFile(daemonFile, "utf8"), "daemon.json");
    expect(info).toEqual(daemon.info);
    if (process.platform !== "win32") expect((await stat(daemonFile)).mode & 0o777).toBe(0o600);
    expect((await readdir(iterbarPaths(root).tmpDirectory))).toEqual([]);
    expect(await readdir(directory)).toContain("daemon.json");
  });

  it("refuses a second daemon for the same project and leaves the first one's daemon.json alone", async () => {
    const first = await start();
    await expect(startDaemon({ projectRoot: root })).rejects.toMatchObject({ code: "store_locked" });
    const info = parseMessageJson(daemonInfoSchema, await readFile(iterbarPaths(root).daemonFile, "utf8"), "daemon.json");
    expect(info.token).toBe(first.info.token);
    expect((await call(first, "/feedback")).status).toBe(200);
  });
});

describe("feedback API", () => {
  it("creates, lists, reads, replies to and changes the status of feedback for a token-only client", async () => {
    const daemon = await start();
    const form = new FormData();
    form.append("feedback", JSON.stringify(commentDraft));
    form.append("screenshot", new Blob([PNG], { type: "image/png" }), "screenshot.png");
    form.append("evidence", new Blob([EVIDENCE], { type: "application/json" }), "evidence.json");
    const created = await call(daemon, "/feedback", { method: "POST", body: form });
    expect(created.status).toBe(201);
    const feedback = parseMessageJson(feedbackSchema, await created.text(), "feedback");
    expect(feedback).toMatchObject({ kind: "comment", status: "open", text: commentDraft.text, replies: [] });

    const screenshot = await call(daemon, `/feedback/${feedback.id}/attachments/${feedback.screenshot?.id}`);
    expect(screenshot.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await screenshot.arrayBuffer())).toEqual(PNG);
    const evidence = await call(daemon, `/feedback/${feedback.id}/attachments/${feedback.evidence?.attachment.id}`);
    expect(evidence.headers.get("content-type")).toBe("application/json");
    expect(Buffer.from(await evidence.arrayBuffer())).toEqual(EVIDENCE);

    const replied = await postJson(daemon, `/feedback/${feedback.id}/replies`, {
      schemaVersion: 1, author: { kind: "agent", name: "Claude Code" }, text: "Made it larger.",
    });
    expect(replied.status).toBe(200);
    expect(((await replied.json()) as Feedback).replies).toMatchObject([{ text: "Made it larger.", author: { kind: "agent" } }]);

    const status = await postJson(daemon, `/feedback/${feedback.id}/status`, { schemaVersion: 1, status: "done" });
    expect(((await status.json()) as Feedback).status).toBe("done");

    const chosen = await create(daemon, { feedback: chooseVariantDraft });
    expect(chosen.status).toBe(201);

    const all = (await (await call(daemon, "/feedback")).json()) as { items: Feedback[] };
    expect(all.items.map((item) => item.kind)).toEqual(["comment", "choose_variant"]);
    const done = (await (await call(daemon, "/feedback?status=done")).json()) as { items: Feedback[] };
    expect(done.items.map((item) => item.id)).toEqual([feedback.id]);
    const one = (await (await call(daemon, `/feedback/${feedback.id}`)).json()) as Feedback;
    expect(one).toMatchObject({ id: feedback.id, status: "done", replies: [{ text: "Made it larger." }] });
  });

  // Moves tens of MiB through the daemon.
  it("refuses an attachment over 10 MiB with payload_too_large and stores nothing", { timeout: 30_000 }, async () => {
    const daemon = await start();
    const atCap = Buffer.from(`"${"a".repeat(MAX_ATTACHMENT_BYTES - 2)}"`);
    expect(atCap.byteLength).toBe(MAX_ATTACHMENT_BYTES);
    const overCap = Buffer.concat([atCap, Buffer.from(" ")]);
    const window = { start: "2026-11-03T10:00:00.000Z", end: "2026-11-03T10:00:35.000Z", eventCount: 1 };

    for (const parts of [{ screenshot: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1) }, { evidence: overCap }]) {
      const response = await create(daemon, { feedback: { ...commentDraft, evidenceWindow: window }, evidence: EVIDENCE, ...parts });
      expect(response.status).toBe(413);
      expect(await errorOf(response)).toBe("payload_too_large");
    }
    expect(await storedItems()).toEqual([]);

    // Exactly at the cap is accepted.
    const accepted = await create(daemon, { feedback: { ...commentDraft, evidenceWindow: window }, evidence: atCap });
    expect(accepted.status).toBe(201);
    const { evidence } = JSON.parse(accepted.text) as Feedback;
    expect(evidence?.attachment.byteLength).toBe(MAX_ATTACHMENT_BYTES);
  });

  // Moves tens of MiB through the daemon.
  it("refuses a body declared larger than the request cap before reading it", { timeout: 30_000 }, async () => {
    const daemon = await start();
    const response = await send(daemon.info, {
      method: "POST",
      path: "/feedback",
      headers: {
        ...bearer(daemon.info.token),
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(MAX_FEEDBACK_BODY_BYTES + 1),
      },
    });
    expect(response.status).toBe(413);
    expect(await errorOf(response)).toBe("payload_too_large");
    expect(await storedItems()).toEqual([]);
  });

  it("treats a client that disconnects mid-body as a client failure and keeps serving", async () => {
    const daemon = await start();
    await new Promise<void>((resolve) => {
      const partial = request({
        host: "127.0.0.1",
        port: daemon.info.port,
        method: "POST",
        path: "/feedback/feedback-missing/replies",
        agent: false,
        headers: { ...bearer(daemon.info.token), ...json, "content-length": "1000" },
      });
      partial.on("error", () => resolve());
      partial.write("{\"schemaVersion\":1,", () => setTimeout(() => partial.destroy(), 50));
      partial.on("close", () => resolve());
    });
    expect((await call(daemon, "/feedback")).status).toBe(200);
    // afterEach checks that nothing was reported as an unexpected daemon error.
  });

  it("answers malformed requests with typed errors", async () => {
    const daemon = await start();
    const { id } = JSON.parse((await create(daemon, { feedback: commentDraft, evidence: EVIDENCE })).text) as Feedback;
    const token = bearer(daemon.info.token);
    const reply = { schemaVersion: 1, author: { kind: "user", name: null }, text: "ok" };
    const cases: Array<[string, Parameters<typeof send>[1], number, string]> = [
      ["invalid JSON", { method: "POST", path: `/feedback/${id}/replies`, headers: { ...token, ...json }, body: "{" }, 400, "invalid_request"],
      ["blank reply", { method: "POST", path: `/feedback/${id}/replies`, headers: { ...token, ...json }, body: JSON.stringify({ ...reply, text: " " }) }, 400, "invalid_request"],
      ["newer major version", { method: "POST", path: `/feedback/${id}/replies`, headers: { ...token, ...json }, body: JSON.stringify({ ...reply, schemaVersion: 2 }) }, 400, "unsupported_schema_version"],
      ["not JSON content", { method: "POST", path: `/feedback/${id}/status`, headers: { ...token, "content-type": "text/plain" }, body: JSON.stringify({ schemaVersion: 1, status: "done" }) }, 415, "invalid_request"],
      ["unknown status", { method: "POST", path: `/feedback/${id}/status`, headers: { ...token, ...json }, body: JSON.stringify({ schemaVersion: 1, status: "closed" }) }, 400, "invalid_request"],
      ["missing item", { path: "/feedback/feedback-missing", headers: token }, 404, "not_found"],
      ["reply to a missing item", { method: "POST", path: "/feedback/feedback-missing/replies", headers: { ...token, ...json }, body: JSON.stringify(reply) }, 404, "not_found"],
      ["unsafe id", { path: "/feedback/..%2Fstore.lock", headers: token }, 404, "not_found"],
      ["uppercase id", { path: `/feedback/${id.toUpperCase()}`, headers: token }, 404, "not_found"],
      ["missing attachment", { path: `/feedback/${id}/attachments/attachment-missing`, headers: token }, 404, "not_found"],
      ["unknown endpoint", { path: "/feedback/", headers: token }, 404, "not_found"],
      ["wrong method", { method: "DELETE", path: `/feedback/${id}`, headers: token }, 405, "invalid_request"],
      ["repeated filter", { path: "/feedback?status=open&status=done", headers: token }, 400, "invalid_request"],
      ["bad filter", { path: "/feedback?since=yesterday", headers: token }, 400, "invalid_request"],
      ["events without upgrade", { path: "/events", headers: token }, 426, "invalid_request"],
    ];
    for (const [label, request, status, code] of cases) {
      const response = await send(daemon.info, request);
      expect(response.status, label).toBe(status);
      expect(await errorOf(response), label).toBe(code);
    }

    const multipartCases: Array<[string, Parameters<typeof multipart>[0], number, string]> = [
      ["no feedback part", { screenshot: PNG }, 400, "invalid_request"],
      ["unknown part", { feedback: commentDraft, evidence: EVIDENCE, extra: { notes: "x" } }, 400, "invalid_request"],
      ["draft without schemaVersion", { feedback: { ...commentDraft, schemaVersion: undefined } }, 400, "invalid_request"],
      ["evidence without its window", { feedback: { ...commentDraft, evidenceWindow: null }, evidence: EVIDENCE }, 400, "invalid_request"],
      ["screenshot that is not a PNG", { feedback: { ...commentDraft, evidenceWindow: null }, screenshot: Buffer.from("GIF89a") }, 400, "invalid_request"],
    ];
    for (const [label, parts, status, code] of multipartCases) {
      const response = await create(daemon, parts);
      expect(response.status, label).toBe(status);
      expect(await errorOf(response), label).toBe(code);
    }
    const notMultipart = await send(daemon.info, {
      method: "POST", path: "/feedback", headers: { ...token, ...json }, body: JSON.stringify(commentDraft),
    });
    expect(notMultipart.status).toBe(415);
    const garbled = await send(daemon.info, {
      method: "POST", path: "/feedback", headers: { ...token, "content-type": "multipart/form-data; boundary=zz" }, body: "--zz\r\nnonsense",
    });
    expect(garbled.status).toBe(400);
    expect(await storedItems()).toEqual([id]);
  });
});

describe("slots", () => {
  it("keeps the latest report per page URL", async () => {
    const daemon = await start();
    const slot = { slot: "pricing", versions: ["v1", "v2"], defaultVersion: "v1", activeVersion: "v1", mounts: 1 };
    const report = (pageUrl: string, activeVersion: string, reportedAt: string) =>
      ({ schemaVersion: 1, pageUrl, reportedAt, slots: [{ ...slot, activeVersion }] });

    expect((await (await call(daemon, "/slots")).json())).toEqual({ schemaVersion: 1, pages: [] });
    for (const body of [
      report("http://localhost:5173/pricing", "v1", "2026-11-03T10:00:00.000Z"),
      report("http://localhost:5173/", "v1", "2026-11-03T10:00:01.000Z"),
      report("http://localhost:5173/pricing", "v2", "2026-11-03T10:00:02.000Z"),
    ]) {
      expect((await postJson(daemon, "/slots", body)).status).toBe(204);
    }
    const { pages } = (await (await call(daemon, "/slots")).json()) as { pages: Array<{ pageUrl: string; slots: Array<{ activeVersion: string }> }> };
    expect(pages.map((page) => [page.pageUrl, page.slots[0]?.activeVersion])).toEqual([
      ["http://localhost:5173/", "v1"],
      ["http://localhost:5173/pricing", "v2"],
    ]);
  });
});

describe("event stream", () => {
  it("delivers a reply made by one client to a second client", async () => {
    const daemon = await start();
    const bar = await events(daemon);
    // The agent side connects with Node.js's own WebSocket, offering the token as a subprotocol.
    const agent = new WebSocket(`ws://127.0.0.1:${daemon.info.port}/events`, webSocketProtocols(daemon.info.token));
    const agentEvents: DaemonEvent[] = [];
    agent.addEventListener("message", (message) => agentEvents.push(JSON.parse(String(message.data)) as DaemonEvent));
    await new Promise((resolve, reject) => {
      agent.addEventListener("open", resolve);
      agent.addEventListener("error", reject);
    });
    expect(agent.protocol).toBe("iterbar.v1");

    const created = JSON.parse((await create(daemon, { feedback: commentDraft, evidence: EVIDENCE })).text) as Feedback;
    expect(await bar.next()).toMatchObject({ type: "feedback.created", feedback: { id: created.id } });

    const reply = { schemaVersion: 1, author: { kind: "agent", name: "Codex" }, text: "Done; take a look." };
    expect((await postJson(daemon, `/feedback/${created.id}/replies`, reply)).status).toBe(200);
    const update = await bar.next();
    expect(update).toMatchObject({ type: "feedback.updated", feedback: { id: created.id, replies: [{ text: reply.text }] } });

    // Setting the current status is not an update; the next event is the real change.
    await postJson(daemon, `/feedback/${created.id}/status`, { schemaVersion: 1, status: "open" });
    await postJson(daemon, `/feedback/${created.id}/status`, { schemaVersion: 1, status: "needs-info" });
    expect(await bar.next()).toMatchObject({ type: "feedback.updated", feedback: { status: "needs-info" } });

    const report = { schemaVersion: 1, pageUrl: "http://localhost:5173/", reportedAt: "2026-11-03T10:00:00.000Z", slots: [] };
    await postJson(daemon, "/slots", report);
    expect(await bar.next()).toMatchObject({ type: "slots.reported", report });

    await expect.poll(() => agentEvents.length).toBe(4);
    expect(agentEvents.map((event) => event.type)).toEqual(["feedback.created", "feedback.updated", "feedback.updated", "slots.reported"]);
    expect(agentEvents[1]).toEqual(update);
    agent.close();
  });

  /** Every event up to a sentinel slot report published after the operations under test. */
  async function eventsUntilSentinel(daemon: RunningDaemon, client: EventClient): Promise<DaemonEvent[]> {
    const pageUrl = "http://localhost:5173/sentinel";
    await postJson(daemon, "/slots", { schemaVersion: 1, pageUrl, reportedAt: "2026-11-03T10:00:00.000Z", slots: [] });
    const received: DaemonEvent[] = [];
    for (;;) {
      const event = await client.next();
      if (event.type === "slots.reported" && event.report.pageUrl === pageUrl) return received;
      received.push(event);
    }
  }

  it("pushes a status change whose timestamp equals the previous one", async () => {
    // A wall clock that does not advance: every write lands in the same millisecond.
    const frozen = Date.parse("2026-11-03T10:00:00.000Z");
    const daemon = await start(() => frozen);
    const bar = await events(daemon);
    const created = JSON.parse((await create(daemon, { feedback: commentDraft, evidence: EVIDENCE })).text) as Feedback;
    const changed = await postJson(daemon, `/feedback/${created.id}/status`, { schemaVersion: 1, status: "done" });
    const feedback = (await changed.json()) as Feedback;
    expect(feedback).toMatchObject({ status: "done", updatedAt: created.updatedAt });

    const received = await eventsUntilSentinel(daemon, bar);
    expect(received.map((event) => event.type)).toEqual(["feedback.created", "feedback.updated"]);
    expect(received[1]).toMatchObject({ feedback: { id: created.id, status: "done" } });
  });

  it("pushes one update per committed status change under concurrent requests", async () => {
    let now = Date.parse("2026-11-03T10:00:00.000Z");
    const daemon = await start(() => (now += 1));
    const bar = await events(daemon);
    const created = JSON.parse((await create(daemon, { feedback: commentDraft, evidence: EVIDENCE })).text) as Feedback;
    expect((await bar.next()).type).toBe("feedback.created");
    const status = (value: string) => postJson(daemon, `/feedback/${created.id}/status`, { schemaVersion: 1, status: value });
    const reply = { schemaVersion: 1, author: { kind: "agent", name: "Codex" }, text: "Looking." };

    // Replies overlap requests that set the current status: only the replies are updates.
    const overlapping = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      index % 2 ? status("open") : postJson(daemon, `/feedback/${created.id}/replies`, reply)));
    expect(overlapping.map((response) => response.status)).toEqual(Array(8).fill(200));
    const afterReplies = await eventsUntilSentinel(daemon, bar);
    expect(afterReplies).toHaveLength(4);
    expect(afterReplies.every((event) => event.type === "feedback.updated" && event.feedback.status === "open")).toBe(true);

    // Concurrent requests for the same new status commit one change, so exactly one update is pushed.
    const same = await Promise.all(Array.from({ length: 6 }, () => status("done")));
    expect(same.map((response) => response.status)).toEqual(Array(6).fill(200));
    const afterStatus = await eventsUntilSentinel(daemon, bar);
    expect(afterStatus.map((event) => event.type === "feedback.updated" && event.feedback.status)).toEqual(["done"]);
  });

  it("closes event streams with 1001 on shutdown", async () => {
    const daemon = await start();
    const client = await events(daemon);
    await daemon.close();
    expect(await client.closed).toMatchObject({ code: 1001 });
  });
});
