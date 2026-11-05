import { EventEmitter } from "node:events";
import type { Feedback, FeedbackListQuery } from "iterbar";
import type WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { baselineCursor, cursorAfter, decodeCursor, encodeCursor, MAX_CURSOR_SEEN, type FeedbackCursor } from "./cursor.js";
import type { DaemonClient } from "./daemon-client.js";
import { daemonUnavailable, IterbarToolError } from "./errors.js";
import { alreadyHandled } from "./test-support/delivery.js";
import { feedbackItem, type ReplySpec } from "./test-support/feedback.js";
import { MIN_WAIT_REQUEST_MS, waitForFeedback, type WaitOptions, type WaitResult } from "./wait.js";

/** An `/events` socket the test drives: `push` sends a daemon event, `emit("close")` ends the stream. */
class FakeSocket extends EventEmitter {
  terminated = false;
  push(feedback: Feedback): void {
    this.emit("message", Buffer.from(JSON.stringify({ schemaVersion: 1, type: "feedback.updated", feedback })));
  }
  terminate(): void {
    this.terminated = true;
  }
}

type Lister = (query: FeedbackListQuery, signal: AbortSignal) => Promise<Feedback[]>;
type Opener = (signal: AbortSignal) => Promise<FakeSocket>;

/** A daemon client whose listings and event streams the test supplies. */
function fakeClient(list: Lister, open: Opener = async () => new FakeSocket()): DaemonClient {
  return {
    listFeedback: (query: FeedbackListQuery, signal: AbortSignal) => list(query, signal),
    openEvents: async (signal: AbortSignal) => (await open(signal)) as unknown as WebSocket,
  } as unknown as DaemonClient;
}

/** A request that never answers; it fails only when its signal aborts (or already has), as `fetch` does. */
const hang = (signal: AbortSignal) => new Promise<never>((_, reject) => {
  if (signal.aborted) reject(signal.reason as Error);
  signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const timers: NodeJS.Timeout[] = [];
afterEach(() => timers.splice(0).forEach(clearInterval));

function wait(client: DaemonClient, options: Partial<WaitOptions> & { timeoutMs: number }) {
  return waitForFeedback(client, { signal: new AbortController().signal, ...options });
}

describe("waitForFeedback", { timeout: 10_000 }, () => {
  it("ends at its deadline and keeps sending progress while non-qualifying events keep arriving", async () => {
    const socket = new FakeSocket();
    const thread = feedbackItem("feedback-a", Date.now() - 60_000, [["reply-agent", "agent", Date.now() - 1]]);
    // An agent posts status and replies faster than a listing completes, so an event is always pending.
    timers.push(setInterval(() => socket.push(thread), 5));
    const client = fakeClient(async () => {
      await pause(15);
      return [thread];
    }, async () => socket);
    const beats: number[] = [];
    const started = Date.now();
    const result = await wait(client, { timeoutMs: 500, heartbeatMs: 50, onHeartbeat: (elapsed) => beats.push(elapsed) });
    const elapsed = Date.now() - started;
    expect(result).toMatchObject({ outcome: "timeout", items: [], events: [] });
    expect(elapsed).toBeGreaterThanOrEqual(500);
    expect(elapsed).toBeLessThan(800);
    expect(beats.length).toBeGreaterThanOrEqual(6);
    expect(beats).toEqual([...beats].sort((left, right) => left - right));
  });

  it("aborts a listing still in flight at the deadline and returns the cursor of the last complete one", async () => {
    const socket = new FakeSocket();
    let listings = 0;
    const client = fakeClient(async (_query, signal) => (++listings === 1 ? [] : hang(signal)), async () => socket);
    const at = Date.now() - 1000;
    const cursor: FeedbackCursor = { watermark: at, seen: new Set(), committed: at };
    setTimeout(() => socket.push(feedbackItem("feedback-a", Date.now())), 50);
    const started = Date.now();
    const result = await wait(client, { cursor, timeoutMs: 1200 });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(listings).toBe(2);
    expect(result.outcome).toBe("timeout");
    // Nothing the cut-short listing would have found is acknowledged.
    expect(result.cursor).toEqual(cursor);
  });

  it("gives a wait with no time left one bounded listing, so a timeout of 0 polls", async () => {
    const client = fakeClient(async (_query, signal) => hang(signal));
    const started = Date.now();
    const result = await wait(client, { cursor: baselineCursor([]), timeoutMs: 0 });
    expect(result.outcome).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(MIN_WAIT_REQUEST_MS + 300);
  });

  it("aborts reopening a closed event stream at the deadline", async () => {
    let opened = 0;
    const first = new FakeSocket();
    const client = fakeClient(async () => [], async (signal) => (++opened === 1 ? first : hang(signal)));
    setTimeout(() => first.emit("close"), 50);
    const started = Date.now();
    const result = await wait(client, { timeoutMs: 1200 });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(opened).toBe(2);
    expect(result.outcome).toBe("timeout");
  });

  it("without a cursor, returns what arrives between subscribing and the first listing", async () => {
    let arrived: Feedback | undefined;
    const before = feedbackItem("feedback-before", Date.now() - 60_000);
    const client = fakeClient(async () => [before, ...(arrived ? [arrived] : [])], async () => {
      // Sent after the call started, while the stream was opening, so no event for it reaches the wait; only the
      // first listing shows it.
      arrived = feedbackItem("feedback-arrived", Date.now());
      await pause(5);
      return new FakeSocket();
    });
    const result = await wait(client, { timeoutMs: 1000 });
    expect(result.outcome).toBe("feedback");
    expect(result.items.map((item) => item.id)).toEqual(["feedback-arrived"]);
    expect(result.events).toMatchObject([{ key: "feedback:feedback-arrived", kind: "created" }]);
  });

  it("returns a user reply that a listing missed while it listed a newer item, on the next wait", async () => {
    const old = Date.now() - 60_000;
    const a = feedbackItem("feedback-a", old);
    let listedAt = 0;
    let listing: () => Feedback[] = () => [
      // The listing read feedback-a before its user reply was committed, half a second after the listing started,
      // and reached feedback-b, created more than six seconds after that, only later.
      a,
      feedbackItem("feedback-b", listedAt + 6_500),
    ];
    const client = fakeClient(async () => {
      listedAt = Date.now();
      return listing();
    });
    const first = await wait(client, { cursor: baselineCursor([a]), timeoutMs: 1000 });
    expect(first.items.map((item) => item.id)).toEqual(["feedback-b"]);

    const replyAt = listedAt + 500;
    const createdB = listedAt + 6_500;
    listing = () => [
      feedbackItem("feedback-a", old, [["reply-user", "user", replyAt]]),
      feedbackItem("feedback-b", createdB),
    ];
    const second = await wait(client, { cursor: first.cursor, timeoutMs: 1000 });
    expect(second.outcome).toBe("feedback");
    expect(second.events).toMatchObject([{ key: "reply:reply-user", kind: "user_reply", feedbackId: "feedback-a" }]);
  });

  it("returns an item whose write committed long after its timestamp, after listings that did not show it", async () => {
    // feedback-slow is stamped a minute ago, but its write (attachments, fsync, rename) is still running while the
    // agent lists and waits; nothing bounds how long that takes. The store writes one at a time, so the newest commit
    // anyone sees meanwhile is older than its stamp.
    const stamped = Date.now() - 60_000;
    const other = feedbackItem("feedback-other", stamped - 1_000);
    let committed = false;
    const client = fakeClient(async () => [other, ...(committed ? [feedbackItem("feedback-slow", stamped)] : [])]);
    const quiet = await wait(client, { cursor: baselineCursor([other]), timeoutMs: 0 });
    const idle = await wait(client, { cursor: quiet.cursor, timeoutMs: 0 });
    expect([quiet.outcome, idle.outcome]).toEqual(["timeout", "timeout"]);
    committed = true;
    const next = await wait(client, { cursor: idle.cursor, timeoutMs: 1000 });
    expect(next.outcome).toBe("feedback");
    expect(next.events).toMatchObject([{ key: "feedback:feedback-slow", kind: "created" }]);
  });

  it("without a cursor, returns a write stamped before the call that commits after it subscribed", async () => {
    const before = feedbackItem("feedback-before", Date.now() - 60_000);
    let subscribed = false;
    const stamped = Date.now() - 1_000;
    const client = fakeClient(
      async () => [before, ...(subscribed ? [feedbackItem("feedback-stamped-earlier", stamped)] : [])],
      async () => {
        subscribed = true;
        return new FakeSocket();
      },
    );
    const result = await wait(client, { timeoutMs: 1000 });
    expect(result.outcome).toBe("feedback");
    expect(result.events).toMatchObject([{ key: "feedback:feedback-stamped-earlier", kind: "created" }]);
  });

  it("hands each event over exactly once across repeated waits", async () => {
    const base = Date.now() - 60_000;
    let items: Feedback[] = [feedbackItem("feedback-a", base)];
    const client = fakeClient(async () => items);
    const start = await wait(client, { timeoutMs: 0 });
    expect(start.outcome).toBe("timeout");

    const delivered: string[] = [];
    let cursor = start.cursor;
    const step = async (next: Feedback[]) => {
      items = next;
      const result = await wait(client, { ...(cursor ? { cursor } : {}), timeoutMs: 0 });
      delivered.push(...result.events.map((event) => event.key));
      cursor = result.cursor;
    };
    // Same-millisecond writes, an agent reply and a status change in between, and quiet turns.
    await step([feedbackItem("feedback-a", base), feedbackItem("feedback-b", base + 10)]);
    await step([feedbackItem("feedback-a", base), feedbackItem("feedback-b", base + 10), feedbackItem("feedback-c", base + 10)]);
    await step([
      feedbackItem("feedback-a", base, [["reply-agent", "agent", base + 20]]),
      feedbackItem("feedback-b", base + 10, [], base + 25),
      feedbackItem("feedback-c", base + 10),
    ]);
    await step([
      feedbackItem("feedback-a", base, [["reply-agent", "agent", base + 20], ["reply-user", "user", base + 30]]),
      feedbackItem("feedback-b", base + 10, [], base + 25),
      feedbackItem("feedback-c", base + 10),
    ]);
    await step(items);
    await step(items);
    expect(delivered).toEqual(["feedback:feedback-b", "feedback:feedback-c", "reply:reply-user"]);
  });
});

describe("waitForFeedback without a cursor", { timeout: 10_000 }, () => {
  const base = Date.now() - 60_000;
  const a = feedbackItem("feedback-a", base);

  /**
   * A store holding feedback-a, where feedback-b commits at the moment `commitB` names; `stall` makes the matching
   * request hang until the wait's deadline aborts it.
   */
  function store(commitB: "open" | "third-listing", stall: "open" | "third-listing") {
    const state = { listings: 0, opened: 0, b: false };
    const client = fakeClient(async (_query, signal) => {
      state.listings += 1;
      if (commitB === "third-listing" && state.listings === 3) state.b = true;
      if (stall === "third-listing" && state.listings === 3) return hang(signal);
      return [a, ...(state.b ? [feedbackItem("feedback-b", base + 10)] : [])];
    }, async (signal) => {
      state.opened += 1;
      if (commitB === "open" && state.opened === 1) state.b = true;
      return stall === "open" && state.opened === 1 ? hang(signal) : new FakeSocket();
    });
    return { client, state };
  }

  /** Waits with `cursor` until nothing more arrives; returns every event key handed over. */
  async function drain(client: DaemonClient, cursor: FeedbackCursor | undefined): Promise<string[]> {
    const delivered: string[] = [];
    let current = cursor;
    for (;;) {
      const result = await wait(client, { ...(current ? { cursor: current } : {}), timeoutMs: 0 });
      delivered.push(...result.events.map((event) => event.key));
      current = result.cursor;
      if (result.outcome === "timeout") return delivered;
    }
  }

  it("returns a cursor when the deadline cuts the event stream short, and that cursor delivers what arrived", async () => {
    const { client, state } = store("open", "open");
    const first = await wait(client, { timeoutMs: 300 });
    expect(state).toMatchObject({ listings: 2, opened: 1, b: true });
    expect(first.outcome).toBe("timeout");
    expect(first.cursor).toBeDefined();
    expect(await drain(client, first.cursor)).toEqual(["feedback:feedback-b"]);
  });

  it("returns a cursor when the deadline cuts its first listing after subscribing short", async () => {
    const { client, state } = store("third-listing", "third-listing");
    const first = await wait(client, { timeoutMs: 300 });
    expect(state).toMatchObject({ listings: 3, b: true });
    expect(first.outcome).toBe("timeout");
    expect(first.cursor).toBeDefined();
    expect(await drain(client, first.cursor)).toEqual(["feedback:feedback-b"]);
  });

  it("returns at once what was committed between its two baseline listings", async () => {
    let listings = 0;
    let opened = 0;
    const client = fakeClient(async () => {
      listings += 1;
      return [a, ...(listings >= 2 ? [feedbackItem("feedback-b", base + 10)] : [])];
    }, async () => {
      opened += 1;
      return new FakeSocket();
    });
    const result = await wait(client, { timeoutMs: 1000 });
    expect([listings, opened]).toEqual([2, 0]);
    expect(result.outcome).toBe("feedback");
    expect(result.events).toMatchObject([{ key: "feedback:feedback-b", kind: "created" }]);
    expect(await drain(client, result.cursor)).toEqual([]);
  });

  it("returns a compact cursor that decodes after a baseline of more than 10,000 events", async () => {
    const many = Array.from({ length: 10_001 }, (_, index) => feedbackItem(`feedback-${index}`, base + index));
    let opened = 0;
    const client = fakeClient(
      async () => [...many, ...(opened ? [feedbackItem("feedback-late", base + 20_000)] : [])],
      async (signal) => (++opened === 1 ? hang(signal) : new FakeSocket()),
    );
    const first = await wait(client, { timeoutMs: 300 });
    expect(first.outcome).toBe("timeout");
    const decoded = decodeCursor(encodeCursor(first.cursor!));
    expect(decoded.seen.size).toBeLessThanOrEqual(1);
    expect(await drain(client, decoded)).toEqual(["feedback:feedback-late"]);
  });

  it("carries its cursor in a daemon_unavailable failure after the baseline", async () => {
    let b = false;
    let up = true;
    const client = fakeClient(async () => [a, ...(b ? [feedbackItem("feedback-b", base + 10)] : [])], async () => {
      if (!up) return new FakeSocket();
      // feedback-b commits, then the daemon stops before the stream opens.
      b = true;
      up = false;
      throw daemonUnavailable("The daemon is gone.");
    });
    const failure = await wait(client, { timeoutMs: 1000 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IterbarToolError);
    expect((failure as IterbarToolError).code).toBe("daemon_unavailable");
    const { cursor } = (failure as IterbarToolError).details;
    expect(typeof cursor).toBe("string");
    expect(await drain(client, decodeCursor(cursor as string))).toEqual(["feedback:feedback-b"]);
  });

  it("cuts its second baseline listing short at the deadline and returns no cursor, having handed nothing over", async () => {
    let listings = 0;
    const client = fakeClient(async (_query, signal) => {
      listings += 1;
      // The second listing stalls far past the deadline (a wait of 0 gives its requests a second); feedback-b commits.
      if (listings === 2) {
        await Promise.race([pause(4_000), hang(signal)]);
        return [a, feedbackItem("feedback-b", base + 10)];
      }
      return [a];
    }, async (signal) => hang(signal));
    const started = Date.now();
    const result = await wait(client, { timeoutMs: 0 });
    expect(Date.now() - started).toBeLessThan(MIN_WAIT_REQUEST_MS + 500);
    expect([listings, result]).toEqual([2, { outcome: "timeout", items: [], events: [], cursor: undefined }]);
  });

  it("returns no cursor when the deadline cuts its first listing short, so nothing is acknowledged", async () => {
    const client = fakeClient(async (_query, signal) => hang(signal));
    const result = await wait(client, { timeoutMs: 0 });
    expect(result).toEqual({ outcome: "timeout", items: [], events: [], cursor: undefined });
  });
});

describe("waitForFeedback after a burst", { timeout: 30_000 }, () => {
  /** The failure of a wait that must fail. */
  const failed = (pending: Promise<unknown>) => pending.then(
    () => expect.unreachable("the wait succeeded"),
    (error: unknown) => {
      expect(error).toBeInstanceOf(IterbarToolError);
      return error as IterbarToolError;
    },
  );
  const base = Date.now() - 600_000;
  const a = feedbackItem("feedback-a", base);
  /** feedback-a with `count` user replies committed one millisecond apart after the cursor was issued. */
  const answered = (count: number) => feedbackItem("feedback-a", base, Array.from({ length: count }, (_, index) =>
    [`reply-${String(index).padStart(5, "0")}`, "user", base + 1_000 + index] as const));
  const count = 2 * MAX_CURSOR_SEEN + 1;

  it("returns more events than a cursor holds and issues a cursor that resumes without duplicates", async () => {
    let items: Feedback[] = [a];
    const client = fakeClient(async () => items);
    const start = cursorAfter([a], [a]);
    items = [answered(count)];
    const burst = await wait(client, { cursor: decodeCursor(encodeCursor(start)), timeoutMs: 1000 });
    expect(burst.outcome).toBe("feedback");
    expect(new Set(burst.events.map((event) => event.key)).size).toBe(count);
    const resumed = decodeCursor(encodeCursor(burst.cursor!));
    const next = await wait(client, { cursor: resumed, timeoutMs: 0 });
    expect(next).toMatchObject({ outcome: "timeout", events: [] });
    items = [answered(count + 1)];
    const last = await wait(client, { cursor: decodeCursor(encodeCursor(next.cursor!)), timeoutMs: 1000 });
    expect(last.events.map((event) => event.key)).toEqual([`reply:reply-${String(count).padStart(5, "0")}`]);
  });

  it("carries a cursor that decodes in a failure after such a wait", async () => {
    let items: Feedback[] = [answered(count)];
    let opened = 0;
    let listings = 0;
    const client = fakeClient(async () => {
      listings += 1;
      return items;
    }, async () => {
      opened += 1;
      if (opened === 3) throw daemonUnavailable("The daemon is gone.");
      const socket = new FakeSocket();
      // In the second wait, the daemon stops after that wait listed: the stream closes and cannot be reopened.
      if (opened === 2) setTimeout(() => socket.emit("close"), 50);
      return socket;
    });
    const burst = await wait(client, { cursor: cursorAfter([a], [a]), timeoutMs: 1000 });
    expect(burst.events).toHaveLength(count);
    const before = listings;
    const failure = await failed(wait(client, { cursor: decodeCursor(encodeCursor(burst.cursor!)), timeoutMs: 1000 }));
    expect([failure.code, opened, listings - before]).toEqual(["daemon_unavailable", 3, 1]);
    const cursor = decodeCursor(failure.details.cursor as string);
    items = [answered(count + 1)];
    const resumed = await wait(client, { cursor, timeoutMs: 1000 });
    expect(resumed.events.map((event) => event.key)).toEqual([`reply:reply-${String(count).padStart(5, "0")}`]);
  });

  /**
   * A store holding the burst. Its first listing answers at once; a later one (the compaction) answers at once if
   * `answering.now` is set when it starts, and otherwise stalls for 4 seconds or until its signal aborts.
   */
  function stalling(answering: { now: boolean }) {
    let listings = 0;
    return fakeClient(async (_query, signal) => {
      if (++listings === 1 || answering.now) return [answered(count)];
      await Promise.race([pause(4_000), hang(signal)]);
      return [answered(count)];
    });
  }

  it("stops compacting at its deadline, returns the burst with a cursor that decodes, and skips nothing", async () => {
    const answering = { now: false };
    const client = stalling(answering);
    const start = cursorAfter([a], [a]);
    const started = Date.now();
    const burst = await wait(client, { cursor: start, timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(MIN_WAIT_REQUEST_MS + 500);
    expect(burst.outcome).toBe("feedback");
    const delivered = new Set(burst.events.map((event) => event.key));
    expect(delivered.size).toBe(count);
    // The cursor may hand some of the burst over again but holds no more than it can issue.
    let cursor = decodeCursor(encodeCursor(burst.cursor!));
    answering.now = true;
    let quiet = false;
    for (let turn = 0; turn < 3 && !quiet; turn += 1) {
      const next = await wait(client, { cursor, timeoutMs: 0 });
      next.events.forEach((event) => expect(delivered.has(event.key)).toBe(true));
      cursor = decodeCursor(encodeCursor(next.cursor!));
      quiet = next.outcome === "timeout";
    }
    expect(quiet).toBe(true);
  });

  it("hands over a deadline-cut burst again, and the documented rule acts on none of it but on a newer user reply", async () => {
    const replies = (extra: ReplySpec[]) => feedbackItem("feedback-a", base, [
      ...Array.from({ length: count }, (_, index) => [`reply-${String(index).padStart(5, "0")}`, "user", base + 1_000 + index] as const),
      ...extra,
    ]);
    let items = [replies([])];
    let listings = 0;
    const answering = { now: false };
    // The first listing answers at once; the compaction listings stall past the deadline until `answering` is set.
    const client = fakeClient(async (_query, signal) => {
      if (++listings > 1 && !answering.now) await Promise.race([pause(4_000), hang(signal)]);
      return items;
    });
    /** The events of a result an agent following the documented rule acts on. */
    const actOn = (result: WaitResult) => result.events.filter((event) =>
      !alreadyHandled(result.items.find((item) => item.id === event.feedbackId)!, event));

    const burst = await wait(client, { cursor: cursorAfter([a], [a]), timeoutMs: 300 });
    const delivered = new Set(burst.events.map((event) => event.key));
    expect([delivered.size, actOn(burst).length]).toEqual([count, count]);
    // The agent answers the burst, then follows the documented loop with the cursors the waits return.
    items = [replies([["reply-agent", "agent", base + 1_000 + count]])];
    answering.now = true;
    let cursor = decodeCursor(encodeCursor(burst.cursor!));
    let replayed = 0;
    for (let turn = 0; turn < 3; turn += 1) {
      const next = await wait(client, { cursor, timeoutMs: 0 });
      next.events.forEach((event) => expect(delivered.has(event.key)).toBe(true));
      replayed += next.events.length;
      expect(actOn(next)).toEqual([]);
      cursor = decodeCursor(encodeCursor(next.cursor!));
      if (next.outcome === "timeout") break;
    }
    expect(replayed).toBeGreaterThan(0);
    // A user reply after the agent's is new on the same thread, and the rule acts on it.
    items = [replies([["reply-agent", "agent", base + 1_000 + count], ["reply-later", "user", base + 2_000 + count]])];
    const later = await wait(client, { cursor, timeoutMs: 1_000 });
    expect(actOn(later).map((event) => event.key)).toEqual(["reply:reply-later"]);
  });

  it("is cancelled, not timed out, when its call is cancelled while it compacts", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("cancelled")), 100);
    const failure = await failed(wait(stalling({ now: false }), { cursor: cursorAfter([a], [a]), timeoutMs: 5_000, signal: controller.signal }));
    expect([failure.code, failure.message]).toEqual(["internal", "The wait was cancelled"]);
  });

  it("acknowledges none of a burst when the daemon fails while it compacts the cursor", async () => {
    let listings = 0;
    const client = fakeClient(async () => {
      listings += 1;
      if (listings === 2) throw daemonUnavailable("The daemon is gone.");
      return [answered(count)];
    });
    const start = cursorAfter([a], [a]);
    const failure = await failed(wait(client, { cursor: start, timeoutMs: 1000 }));
    expect(failure.code).toBe("daemon_unavailable");
    const cursor = decodeCursor(failure.details.cursor as string);
    expect(cursor).toEqual(start);
    const resumed = await wait(client, { cursor, timeoutMs: 1000 });
    expect(resumed.events).toHaveLength(count);
  });
});
