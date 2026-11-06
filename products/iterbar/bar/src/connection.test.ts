import { SCHEMA_VERSION, type Feedback, type SlotReport, type SlotState } from "iterbar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonConnection, parseDaemonConfig, REQUEST_TIMEOUT_MS } from "./connection.js";
import { applyListing, mergeFeedback } from "./threads-state.js";

const token = "a".repeat(64);

describe("parseDaemonConfig", () => {
  it("accepts the daemon's loopback origin and normalizes a trailing slash", () => {
    expect(parseDaemonConfig("http://127.0.0.1:4555/", token)).toEqual({ ok: true, config: { url: "http://127.0.0.1:4555", token } });
  });

  it("accepts the default HTTP port, which URL normalizes away", () => {
    for (const url of ["http://127.0.0.1:80", "http://127.0.0.1"]) {
      expect(parseDaemonConfig(url, token)).toEqual({ ok: true, config: { url: "http://127.0.0.1", token } });
    }
  });

  it("reports nothing configured separately from a bad configuration", () => {
    expect(parseDaemonConfig(null, null)).toEqual({ ok: false, status: { kind: "unconfigured" } });
    expect(parseDaemonConfig("", "")).toEqual({ ok: false, status: { kind: "unconfigured" } });
  });

  it("never sends the token anywhere but 127.0.0.1", () => {
    for (const url of [
      "http://localhost:4555", "https://127.0.0.1:4555", "https://127.0.0.1:80", "http://127.0.0.1:4555/events",
      "http://127.0.0.1:4555/?x=1", "http://user:pw@127.0.0.1:4555", "http://evil.example:4555", "nonsense",
    ]) {
      expect(parseDaemonConfig(url, token)).toMatchObject({ ok: false, status: { kind: "invalid" } });
    }
  });

  it("refuses a malformed token", () => {
    expect(parseDaemonConfig("http://127.0.0.1:4555", "A".repeat(64))).toMatchObject({ ok: false, status: { kind: "invalid" } });
    expect(parseDaemonConfig("http://127.0.0.1:4555", null)).toMatchObject({ ok: false, status: { kind: "invalid" } });
  });
});

/** A WebSocket the test opens, feeds and closes by hand. */
class FakeSocket extends EventTarget {
  static instances: FakeSocket[] = [];
  closed = false;
  constructor(readonly url: string, readonly protocols: string[]) {
    super();
    FakeSocket.instances.push(this);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }
  open(): void {
    this.dispatchEvent(new Event("open"));
  }
  receive(event: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
  }
}

interface PendingRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  respond(status: number, body?: unknown): void;
}

function feedback(id: string, status: Feedback["status"], updatedAt = "2026-01-01T00:00:00.000Z"): Feedback {
  return {
    schemaVersion: SCHEMA_VERSION, id, kind: "comment", text: id, pageUrl: "http://localhost:5173/", target: null,
    activeVariants: [], screenshotUnavailableReason: null, screenshot: null, evidence: null, replies: [], status,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt,
  } as Feedback;
}

const slot = (activeVersion: string): SlotState => ({
  slot: "pricing", versions: ["v1", "v2"], defaultVersion: "v1", activeVersion, mounts: 1,
});

describe("DaemonConnection", () => {
  let requests: PendingRequest[];
  let threads: Map<string, Feedback>;
  let statuses: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    requests = [];
    threads = new Map();
    statuses = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => new Promise<Response>((resolve) => {
      requests.push({
        method: init.method ?? "GET",
        path: new URL(url).pathname,
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
        respond: (status, body) => resolve(new Response(body === undefined ? null : JSON.stringify(body), { status })),
      });
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function connect(): DaemonConnection {
    const connection = new DaemonConnection({ url: "http://127.0.0.1:4555", token }, {
      onStatus: (status) => statuses.push(status.kind),
      onFeedback: (item) => mergeFeedback(threads, [item]),
      onListing: (items, touched) => applyListing(threads, items, touched),
    });
    connection.start();
    return connection;
  }

  const socket = (index = -1) => FakeSocket.instances.at(index)!;
  const pending = (path: string) => requests.filter((request) => request.path === path);
  const list = (items: Feedback[]) => ({ schemaVersion: SCHEMA_VERSION, items });
  const settle = () => vi.advanceTimersByTimeAsync(0);
  const versions = () => pending("/slots").map((request) => (request.body as SlotReport).slots[0]?.activeVersion);

  it("never lets a listing in flight undo an event with the same updatedAt, and still applies later events", async () => {
    connect();
    socket().open();
    const [listing] = pending("/feedback");
    // The daemon stored and published the update after it answered the listing; both carry the same timestamp.
    socket().receive({ schemaVersion: SCHEMA_VERSION, type: "feedback.updated", feedback: feedback("a", "working") });
    socket().receive({ schemaVersion: SCHEMA_VERSION, type: "feedback.created", feedback: feedback("b", "open") });
    listing!.respond(200, list([feedback("a", "open")]));
    await settle();
    expect(threads.get("a")?.status).toBe("working");
    expect(threads.get("b")?.status).toBe("open");

    socket().receive({ schemaVersion: SCHEMA_VERSION, type: "feedback.updated", feedback: feedback("a", "done") });
    expect(threads.get("a")?.status).toBe("done");
  });

  it("gives no precedence to a rejected stale or unchanged event over a newer or omitting listing", async () => {
    connect();
    socket().open();
    pending("/feedback")[0]!.respond(200, list([feedback("a", "done", "2026-01-01T00:02:00.000Z"), feedback("b", "open")]));
    await settle();
    socket().close();
    await vi.advanceTimersByTimeAsync(1000);
    socket().open();
    socket().receive({ schemaVersion: SCHEMA_VERSION, type: "feedback.updated", feedback: feedback("a", "open") });
    socket().receive({ schemaVersion: SCHEMA_VERSION, type: "feedback.updated", feedback: feedback("b", "open") });
    pending("/feedback")[1]!.respond(200, list([feedback("a", "working", "2026-01-01T00:03:00.000Z")]));
    await settle();
    expect([...threads.values()].map((item) => [item.id, item.status])).toEqual([["a", "working"]]);
  });

  it("fails a stalled listing, diagnosis or slot report after the deadline, with the socket open", async () => {
    const connection = connect();
    socket().open();
    connection.reportSlots("http://localhost:5173/", [slot("v1")]);
    // Neither the listing nor the report is ever answered.
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(socket().closed).toBe(true);
    expect(statuses.at(-1)).toBe("retrying");
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.instances).toHaveLength(2);
    socket().open();
    pending("/feedback")[1]!.respond(200, list([]));
    await settle();
    // The pending report goes out again, and this time it is accepted.
    expect(versions()).toEqual(["v1", "v1"]);
    pending("/slots")[1]!.respond(204);
    await settle();

    // A refused upgrade is diagnosed over HTTP; a diagnosis that hangs ends in a retry too.
    socket().close();
    await vi.advanceTimersByTimeAsync(1000);
    socket().close();
    const before = FakeSocket.instances.length;
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 2000);
    expect(FakeSocket.instances.length).toBeGreaterThan(before);
    expect(versions()).toEqual(["v1", "v1"]);
  });

  it("drops threads that a new listing no longer includes", async () => {
    connect();
    socket().open();
    pending("/feedback")[0]!.respond(200, list([feedback("a", "open"), feedback("b", "open")]));
    await settle();
    socket().close();
    await vi.advanceTimersByTimeAsync(1000);
    socket().open();
    pending("/feedback")[1]!.respond(200, list([feedback("b", "done")]));
    await settle();
    expect([...threads.keys()]).toEqual(["b"]);
    expect(threads.get("b")?.status).toBe("done");
  });

  it("never retries a slot report that a newer one superseded, even when it fails last", async () => {
    const connection = connect();
    socket().open();
    pending("/feedback")[0]!.respond(200, list([]));
    connection.reportSlots("http://localhost:5173/", [slot("v1")]);
    connection.reportSlots("http://localhost:5173/", [slot("v2")]);
    const [first, second] = pending("/slots");
    second!.respond(204);
    await settle();
    first!.respond(500);
    await settle();

    socket().close();
    await vi.advanceTimersByTimeAsync(1000);
    socket().open();
    await settle();
    expect(pending("/slots").map((request) => (request.body as SlotReport).slots[0]?.activeVersion)).toEqual(["v1", "v2"]);
  });

  it("retries the latest slot report after it fails", async () => {
    const connection = connect();
    socket().open();
    connection.reportSlots("http://localhost:5173/", [slot("v2")]);
    pending("/slots")[0]!.respond(503);
    await settle();
    socket().close();
    await vi.advanceTimersByTimeAsync(1000);
    socket().open();
    await settle();
    expect(pending("/slots").map((request) => (request.body as SlotReport).slots[0]?.activeVersion)).toEqual(["v2", "v2"]);
  });

  it("resends the latest slot report with backoff while the socket stays open", async () => {
    const connection = connect();
    socket().open();
    pending("/feedback")[0]!.respond(200, list([]));
    connection.reportSlots("http://localhost:5173/", [slot("v1")]);
    connection.reportSlots("http://localhost:5173/", [slot("v2")]);
    const [first, second] = pending("/slots");
    second!.respond(503);
    await settle();
    first!.respond(500);
    await settle();

    await vi.advanceTimersByTimeAsync(999);
    expect(versions()).toEqual(["v1", "v2"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(versions()).toEqual(["v1", "v2", "v2"]);
    pending("/slots")[2]!.respond(500);
    await settle();
    await vi.advanceTimersByTimeAsync(1999);
    expect(versions()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(versions()).toEqual(["v1", "v2", "v2", "v2"]);
    pending("/slots")[3]!.respond(204);
    await settle();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(versions()).toEqual(["v1", "v2", "v2", "v2"]);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("resends the latest slot report when it fails after a reconnect has already completed", async () => {
    const connection = connect();
    socket().open();
    pending("/feedback")[0]!.respond(200, list([]));
    connection.reportSlots("http://localhost:5173/", [slot("v1")]);
    connection.reportSlots("http://localhost:5173/", [slot("v2")]);
    const [superseded, latest] = pending("/slots");
    socket().close();
    await vi.advanceTimersByTimeAsync(1000);
    socket().open();
    pending("/feedback")[1]!.respond(200, list([]));
    await settle();
    // Both reports were already sent, so the reconnect had nothing to flush.
    expect(versions()).toEqual(["v1", "v2"]);

    latest!.respond(503);
    await settle();
    superseded!.respond(500);
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(versions()).toEqual(["v1", "v2", "v2"]);
    pending("/slots")[2]!.respond(204);
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(versions()).toEqual(["v1", "v2", "v2"]);
  });

  it("gives a resend and a newer report made in the same millisecond strictly increasing reportedAt", async () => {
    vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
    const connection = connect();
    socket().open();
    pending("/feedback")[0]!.respond(200, list([]));
    connection.reportSlots("http://localhost:5173/", [slot("v1")]);
    pending("/slots")[0]!.respond(503);
    await settle();
    // The resend fires, and the element's debounced report of a newer snapshot lands in the same millisecond.
    await vi.advanceTimersByTimeAsync(1000);
    connection.reportSlots("http://localhost:5173/", [slot("v2")]);
    const [, resend, newer] = pending("/slots") as [PendingRequest, PendingRequest, PendingRequest];
    expect(versions()).toEqual(["v1", "v1", "v2"]);
    const stamp = (request: PendingRequest) => Date.parse((request.body as SlotReport).reportedAt);
    expect(stamp(newer)).toBeGreaterThan(stamp(resend));

    // The daemon keeps the last-arriving report on a tie; the newer report arrives first and must still win.
    const current = new Map<string, SlotReport>();
    for (const report of [newer.body, resend.body] as SlotReport[]) {
      const held = current.get(report.pageUrl);
      if (!held || Date.parse(held.reportedAt) <= Date.parse(report.reportedAt)) current.set(report.pageUrl, report);
    }
    expect(current.get("http://localhost:5173/")?.slots[0]?.activeVersion).toBe("v2");

    // A connection that replaces this one for the same daemon, still in the same millisecond, stays later too.
    connection.stop();
    const replacement = connect();
    socket().open();
    pending("/feedback")[1]!.respond(200, list([]));
    replacement.reportSlots("http://localhost:5173/", [slot("v1")]);
    expect(stamp(pending("/slots").at(-1)!)).toBeGreaterThan(stamp(newer));
  });

  it("stops resending a slot report once the connection stops or the token is rejected", async () => {
    const connection = connect();
    socket().open();
    pending("/feedback")[0]!.respond(200, list([]));
    connection.reportSlots("http://localhost:5173/", [slot("v1")]);
    pending("/slots")[0]!.respond(503);
    await settle();
    connection.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(versions()).toEqual(["v1"]);

    const rejected = connect();
    socket().open();
    pending("/feedback")[1]!.respond(200, list([]));
    rejected.reportSlots("http://localhost:5173/", [slot("v2")]);
    pending("/slots")[1]!.respond(401);
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(versions()).toEqual(["v1", "v2"]);
    expect(statuses.at(-1)).toBe("unauthorized");
  });

  it("keeps backing off while the socket opens but the listing fails, and resets once a listing succeeds", async () => {
    connect();
    const delays: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      socket().open();
      pending("/feedback").at(-1)!.respond(500);
      await settle();
      const before = FakeSocket.instances.length;
      let waited = 0;
      while (FakeSocket.instances.length === before) {
        await vi.advanceTimersByTimeAsync(500);
        waited += 500;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([1000, 2000, 4000]);

    socket().open();
    pending("/feedback").at(-1)!.respond(200, list([]));
    await settle();
    socket().close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.instances).toHaveLength(5);
    expect(statuses.at(-1)).toBe("retrying");
  });
});
