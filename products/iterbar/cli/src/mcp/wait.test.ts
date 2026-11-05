import { EventEmitter } from "node:events";
import type { Feedback, FeedbackListQuery } from "iterbar";
import type WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { cursorAt, type FeedbackCursor } from "./cursor.js";
import type { DaemonClient } from "./daemon-client.js";
import { feedbackItem } from "./test-support/feedback.js";
import { MIN_WAIT_REQUEST_MS, waitForFeedback, type WaitOptions } from "./wait.js";

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

/** A request that never answers; it fails only when its signal aborts, as `fetch` does. */
const hang = (signal: AbortSignal) => new Promise<never>((_, reject) => {
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
    const cursor: FeedbackCursor = cursorAt(Date.now() - 1000);
    setTimeout(() => socket.push(feedbackItem("feedback-a", Date.now())), 50);
    const started = Date.now();
    const result = await wait(client, { cursor, timeoutMs: 1200 });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(listings).toBe(2);
    expect(result.outcome).toBe("timeout");
    // Nothing the cut-short listing would have found is acknowledged.
    expect(result.cursor.watermark).toBe(cursor.watermark);
    expect(result.cursor.seen.size).toBe(0);
  });

  it("gives a wait with no time left one bounded listing, so a timeout of 0 polls", async () => {
    const client = fakeClient(async (_query, signal) => hang(signal));
    const started = Date.now();
    const result = await wait(client, { cursor: cursorAt(started), timeoutMs: 0 });
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
    let listedAt = 0;
    let listing: () => Feedback[] = () => [
      // The listing read feedback-a before its user reply was committed, half a second after the listing started,
      // and reached feedback-b, created more than six seconds after that, only later.
      feedbackItem("feedback-a", old),
      feedbackItem("feedback-b", listedAt + 6_500),
    ];
    const client = fakeClient(async () => {
      listedAt = Date.now();
      return listing();
    });
    const first = await wait(client, { timeoutMs: 1000 });
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
});
