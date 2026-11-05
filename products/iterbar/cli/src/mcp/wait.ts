import { daemonEventSchema, safeParseMessage, type Feedback } from "iterbar";
import type WebSocket from "ws";
import {
  advanceCursor,
  cursorSince,
  ORIGIN_CURSOR,
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

export interface WaitOptions {
  /** Where to resume; without one, everything that exists when the wait starts counts as seen. */
  readonly cursor?: FeedbackCursor;
  readonly timeoutMs: number;
  /** Aborts the wait (the tool call was cancelled or the server is closing). */
  readonly signal: AbortSignal;
  /** Called about every `heartbeatMs` while nothing has arrived, with the milliseconds waited so far. */
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
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        this.#notify = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
      this.#notify = done;
    });
  }

  close(): void {
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.terminate();
  }
}

/**
 * Waits until a user sends new feedback or replies in a thread, or the timeout passes. The event stream is open
 * before the first listing, so nothing that arrives during the wait is missed; the listing decides what is new.
 * A stream that closes is reopened when the daemon is still there (or was restarted); when it is gone, the wait
 * fails with `daemon_unavailable`.
 */
export async function waitForFeedback(client: DaemonClient, options: WaitOptions): Promise<WaitResult> {
  const { signal, timeoutMs } = options;
  const heartbeatMs = options.heartbeatMs ?? Number.POSITIVE_INFINITY;
  const started = Date.now();
  const deadline = started + timeoutMs;
  const wakeups = new Wakeups();
  try {
    wakeups.attach(await client.openEvents(signal));
    let cursor = options.cursor;
    const check = async (): Promise<WaitResult | null> => {
      const base = cursor ?? ORIGIN_CURSOR;
      const since = cursorSince(base);
      const items = await client.listFeedback(since === undefined ? {} : { since }, signal);
      const events = cursor ? unseenEvents(cursor, items) : [];
      cursor = advanceCursor(base, items);
      if (!events.length) return null;
      const ids = new Set(events.map((event) => event.feedbackId));
      return { outcome: "feedback", items: items.filter((item) => ids.has(item.id)), events, cursor };
    };

    let result = await check();
    let lastBeat = started;
    while (!result) {
      if (signal.aborted) throw cancelled();
      if (wakeups.takePending()) {
        result = await check();
        continue;
      }
      const now = Date.now();
      if (now >= deadline) return { outcome: "timeout", items: [], events: [], cursor: cursor as FeedbackCursor };
      if (wakeups.closed) {
        // Fails with daemon_unavailable when the daemon is gone; picks up a restarted daemon from daemon.json.
        await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
        wakeups.attach(await client.openEvents(signal));
        result = await check();
        continue;
      }
      if (now - lastBeat >= heartbeatMs) {
        lastBeat = now;
        options.onHeartbeat?.(now - started);
      }
      await wakeups.sleep(Math.min(deadline - now, heartbeatMs - (now - lastBeat)), signal);
    }
    return result;
  } catch (error) {
    // Aborting fails whichever request was in flight; that is a cancellation, not a daemon failure.
    if (signal.aborted) throw cancelled();
    throw error;
  } finally {
    wakeups.close();
  }
}
