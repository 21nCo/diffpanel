import { daemonEventSchema, safeParseMessage, type Feedback } from "iterbar";
import type WebSocket from "ws";
import {
  advanceCursor,
  cursorAt,
  cursorSince,
  unseenEvents,
  type FeedbackCursor,
  type FeedbackEvent,
} from "./cursor.js";
import type { DaemonClient } from "./daemon-client.js";
import { IterbarToolError } from "./errors.js";

/** `wait_for_feedback` timeout bounds, in seconds. */
export const DEFAULT_WAIT_SECONDS = 300;
export const MAX_WAIT_SECONDS = 1800;

/** Pause before reopening an event stream that closed while the daemon kept running. */
const RECONNECT_DELAY_MS = 250;

/**
 * The least time a wait gives its daemon requests, so that a wait with a timeout of 0 still lists once (a poll).
 * A wait with a longer timeout aborts whatever request is in flight at its deadline.
 */
export const MIN_WAIT_REQUEST_MS = 1_000;

export interface WaitOptions {
  /** Where to resume; without one, every event from before the wait started counts as seen. */
  readonly cursor?: FeedbackCursor;
  readonly timeoutMs: number;
  /** Aborts the wait (the tool call was cancelled or the server is closing). */
  readonly signal: AbortSignal;
  /** Called every `heartbeatMs` until the wait ends, with the milliseconds waited so far. */
  readonly onHeartbeat?: (elapsedMs: number) => void;
  readonly heartbeatMs?: number;
}

export interface WaitResult {
  readonly outcome: "feedback" | "timeout";
  /** Items with at least one new event, in the daemon's order (oldest first). */
  readonly items: readonly Feedback[];
  readonly events: readonly FeedbackEvent[];
  /** Pass this to the next wait so that nothing in between is missed or returned twice. */
  readonly cursor: FeedbackCursor;
}

/** A wait that ended because its call was cancelled or the server closed; nobody reads the result. */
const cancelled = () => new IterbarToolError("internal", "The wait was cancelled");

/** The event stream of one wait: remembers whether a feedback event arrived and whether the stream closed. */
class Wakeups {
  #socket: WebSocket | undefined;
  #pending = false;
  #closed = false;
  #notify: (() => void) | undefined;

  attach(socket: WebSocket): void {
    this.#socket = socket;
    this.#closed = false;
    socket.on("error", () => undefined);
    socket.on("message", (data) => {
      let json: unknown;
      try {
        json = JSON.parse(String(data));
      } catch {
        return;
      }
      const event = safeParseMessage(daemonEventSchema, json, "daemon event");
      // Any feedback event may carry one: the listing, not the event, decides what is new.
      if (!event.success || event.data.type === "slots.reported") return;
      this.#pending = true;
      this.#notify?.();
    });
    socket.once("close", () => {
      if (this.#socket !== socket) return;
      this.#closed = true;
      this.#notify?.();
    });
  }

  /** Whether a feedback event arrived since the last call. */
  takePending(): boolean {
    const pending = this.#pending;
    this.#pending = false;
    return pending;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Resolves on an event, the stream closing, the signal, or after `ms`. */
  sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (this.#pending || this.#closed || signal.aborted) return Promise.resolve();
    return delay(ms, signal, (wake) => (this.#notify = wake)).finally(() => (this.#notify = undefined));
  }

  close(): void {
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.terminate();
  }
}

/** Resolves after `ms`, on the signal, or when `register`'s callback is called; never rejects. */
function delay(ms: number, signal: AbortSignal, register?: (wake: () => void) => void): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    signal.addEventListener("abort", done, { once: true });
    register?.(done);
  });
}

/**
 * Waits until a user sends new feedback or replies in a thread, or the timeout passes. The event stream is open
 * before the first listing, so nothing that arrives during the wait is missed; the listing decides what is new.
 * A stream that closes is reopened when the daemon is still there (or was restarted); when it is gone, the wait
 * fails with `daemon_unavailable`.
 *
 * The deadline holds whatever happens meanwhile: it is checked on every turn of the loop, however many events keep
 * arriving, and it aborts the daemon request in flight. A wait that ends at its deadline returns the cursor of its
 * last complete listing, so nothing a cut-short listing would have found is lost.
 */
export async function waitForFeedback(client: DaemonClient, options: WaitOptions): Promise<WaitResult> {
  const { signal, timeoutMs } = options;
  // Taken before anything is subscribed or listed: without a cursor, what arrives from here on is new.
  const started = Date.now();
  const deadline = started + timeoutMs;
  const expired = AbortSignal.timeout(Math.max(timeoutMs, MIN_WAIT_REQUEST_MS));
  const requests = AbortSignal.any([signal, expired]);
  const wakeups = new Wakeups();
  let cursor = options.cursor ?? cursorAt(started);
  const timedOut = (): WaitResult => ({ outcome: "timeout", items: [], events: [], cursor });
  const heartbeatMs = options.heartbeatMs ?? Number.POSITIVE_INFINITY;
  const onHeartbeat = options.onHeartbeat;
  const heartbeat = onHeartbeat && Number.isFinite(heartbeatMs)
    ? setInterval(() => onHeartbeat(Date.now() - started), heartbeatMs)
    : undefined;

  const check = async (): Promise<WaitResult | null> => {
    const since = cursorSince(cursor);
    const listedAt = Date.now();
    const items = await client.listFeedback(since === undefined ? {} : { since }, requests);
    const events = unseenEvents(cursor, items);
    cursor = advanceCursor(cursor, items, listedAt);
    if (!events.length) return null;
    const ids = new Set(events.map((event) => event.feedbackId));
    return { outcome: "feedback", items: items.filter((item) => ids.has(item.id)), events, cursor };
  };

  try {
    wakeups.attach(await client.openEvents(requests));
    let result = await check();
    while (!result) {
      if (signal.aborted) throw cancelled();
      const now = Date.now();
      if (now >= deadline) return timedOut();
      if (wakeups.takePending()) {
        result = await check();
      } else if (wakeups.closed) {
        // Fails with daemon_unavailable when the daemon is gone; picks up a restarted daemon from daemon.json.
        await delay(Math.min(RECONNECT_DELAY_MS, deadline - now), requests);
        if (requests.aborted || Date.now() >= deadline) continue;
        wakeups.attach(await client.openEvents(requests));
        result = await check();
      } else {
        await wakeups.sleep(deadline - now, signal);
      }
    }
    return result;
  } catch (error) {
    // Aborting fails whichever request was in flight; that is a cancellation or the deadline, not a daemon failure.
    if (signal.aborted) throw cancelled();
    if (expired.aborted) return timedOut();
    throw error;
  } finally {
    clearInterval(heartbeat);
    wakeups.close();
  }
}
