import { daemonEventSchema, safeParseMessage, type Feedback } from "iterbar";
import type WebSocket from "ws";
import {
  baselineCursor,
  cursorSince,
  encodeCursor,
  observe,
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
  /** Where to resume; without one, everything the wait's first listing holds counts as seen. */
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
  /**
   * Pass this to the next wait so that nothing in between is missed; an event may come back again (delivery is at
   * least once, see `observe`). Missing only when a wait without a cursor timed out before its baseline listings
   * completed, so that nothing was handed over.
   */
  readonly cursor: FeedbackCursor | undefined;
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
 * Waits until a user sends new feedback or replies in a thread, or the timeout passes. The listings, not the events,
 * decide what is new; the event stream, opened before the next listing, only says when to list again, so nothing that
 * arrives later is missed.
 *
 * Without a cursor, the wait first takes a baseline: one listing whose events count as seen, then a second complete
 * listing that returns whatever was committed after the first and makes the cursor compact (an earlier observed commit
 * covers everything before it). Once the second listing completes, every exit hands back a cursor that resumes from it:
 * the deadline, an event stream that cannot be reopened, and a failure, which carries it in its details. When the
 * deadline or a failure ends the wait before the second listing completes, nothing was handed to the agent and there is
 * no cursor: the agent recovers with an unfiltered `list_feedback`, which shows everything.
 *
 * A stream that closes is reopened when the daemon is still there (or was restarted); when it is gone, the wait fails
 * with `daemon_unavailable`. The deadline bounds every daemon request the wait makes: it is checked on every turn of the
 * loop, however many events keep arriving, and it aborts the request in flight. A listing it cuts short returns the
 * cursor of the last complete one, so nothing the cut-short listing would have found is lost; extra listings that
 * compact a cursor stop at the deadline instead (see {@link checkFrom}).
 */
export async function waitForFeedback(client: DaemonClient, options: WaitOptions): Promise<WaitResult> {
  const wait = new FeedbackWait(client, options);
  const heartbeat = startHeartbeat(options, wait.started);
  try {
    return await wait.run();
  } catch (error) {
    if (wait.expired.aborted && !options.signal.aborted && !(error instanceof IterbarToolError)) return wait.timedOut();
    throw waitFailure(error, options.signal, wait.cursor);
  } finally {
    clearInterval(heartbeat);
    wait.wakeups.close();
  }
}

/** The state of one wait: its deadline, its event stream, and the cursor of its last complete listing. */
class FeedbackWait {
  readonly started = Date.now();
  readonly deadline: number;
  readonly signal: AbortSignal;
  /** Aborts at the deadline (at least {@link MIN_WAIT_REQUEST_MS} after the start). */
  readonly expired: AbortSignal;
  /** Bounds the daemon requests that obey the deadline. */
  readonly requests: AbortSignal;
  readonly wakeups = new Wakeups();
  cursor: FeedbackCursor | undefined;

  constructor(private readonly client: DaemonClient, options: WaitOptions) {
    this.deadline = this.started + options.timeoutMs;
    this.signal = options.signal;
    this.expired = AbortSignal.timeout(Math.max(options.timeoutMs, MIN_WAIT_REQUEST_MS));
    this.requests = AbortSignal.any([this.signal, this.expired]);
    this.cursor = options.cursor;
  }

  timedOut(): WaitResult {
    return { outcome: "timeout", items: [], events: [], cursor: this.cursor };
  }

  async run(): Promise<WaitResult> {
    if (!this.cursor) {
      // Listed before subscribing: whatever the baseline misses is committed later and found by a later listing.
      const baseline = baselineCursor(await this.client.listFeedback({}, this.requests));
      const arrived = await this.check(baseline);
      if (arrived) return arrived;
    }
    this.wakeups.attach(await this.client.openEvents(this.requests));
    let result = await this.recheck();
    while (!result) {
      if (this.signal.aborted) throw cancelled();
      const now = Date.now();
      if (now >= this.deadline) return this.timedOut();
      result = await this.next(now);
    }
    return result;
  }

  /** One turn of the loop: list again after an event or a reopened stream, else sleep until something happens. */
  private async next(now: number): Promise<WaitResult | null> {
    if (this.wakeups.takePending()) return this.recheck();
    if (!this.wakeups.closed) {
      await this.wakeups.sleep(this.deadline - now, this.signal);
      return null;
    }
    // Fails with daemon_unavailable when the daemon is gone; picks up a restarted daemon from daemon.json.
    await delay(Math.min(RECONNECT_DELAY_MS, this.deadline - now), this.requests);
    if (this.requests.aborted || Date.now() >= this.deadline) return null;
    this.wakeups.attach(await this.client.openEvents(this.requests));
    return this.recheck();
  }

  /** Lists what can be new after `from` (see {@link checkFrom}); the cursor then covers this listing too. */
  private async check(from: FeedbackCursor): Promise<WaitResult | null> {
    const checked = await checkFrom(this.client, from, this.requests, this.signal);
    this.cursor = checked.cursor;
    return checked.result;
  }

  /** Lists again from wherever the wait has got to; a cursor always exists once the baseline is taken. */
  private recheck(): Promise<WaitResult | null> {
    if (!this.cursor) throw new Error("waitForFeedback listed again before it had a baseline");
    return this.check(this.cursor);
  }
}

/** Calls `onHeartbeat` every `heartbeatMs` from now on, with the milliseconds since `started`. */
function startHeartbeat(options: WaitOptions, started: number): ReturnType<typeof setInterval> | undefined {
  const { onHeartbeat, heartbeatMs } = options;
  if (!onHeartbeat || heartbeatMs === undefined || !Number.isFinite(heartbeatMs)) return undefined;
  return setInterval(() => onHeartbeat(Date.now() - started), heartbeatMs);
}

/**
 * Lists what can be new after `from`, bounded by `requests` (cancellation and the deadline), and observes it. A listing
 * that needs compacting found new events (an issued cursor is small, and only new events grow it), so the wait is about
 * to return them. The extra listings that compact the cursor obey the deadline too: one that it cuts short ends the
 * compaction, and {@link observe} then forgets the keys the cursor cannot hold, so the events found so far are
 * returned with a cursor that may hand some of them over again but skips none. A daemon failure among them throws
 * before any cursor is returned, which leaves the wait at `from` and acknowledges none of them.
 */
async function checkFrom(
  client: DaemonClient,
  from: FeedbackCursor,
  requests: AbortSignal,
  signal: AbortSignal,
): Promise<{ result: WaitResult | null; cursor: FeedbackCursor }> {
  const list = (since: string | undefined) => client.listFeedback(since === undefined ? {} : { since }, requests);
  const relist = async (since: string | undefined): Promise<Feedback[] | undefined> => {
    try {
      return await list(since);
    } catch (error) {
      // Only the deadline stops compacting; a cancellation or a daemon failure fails the wait.
      if (signal.aborted || !requests.aborted || error instanceof IterbarToolError) throw error;
      return undefined;
    }
  };
  const observed = await observe(from, await list(cursorSince(from)), relist);
  const { events, cursor } = observed;
  if (!events.length) return { result: null, cursor };
  const ids = new Set(events.map((event) => event.feedbackId));
  return { result: { outcome: "feedback", items: observed.items.filter((item) => ids.has(item.id)), events, cursor }, cursor };
}

/**
 * What a wait that did not time out throws. Aborting fails whichever request was in flight; that is a cancellation,
 * not a daemon failure. A tool error carries the wait's cursor so that the agent resumes from here once the daemon is
 * back, instead of starting over past what arrived meanwhile.
 */
function waitFailure(error: unknown, signal: AbortSignal, cursor: FeedbackCursor | undefined): unknown {
  if (signal.aborted) return cancelled();
  if (!(error instanceof IterbarToolError) || !cursor) return error;
  return new IterbarToolError(error.code, error.message, { cause: error, details: { cursor: encodeCursor(cursor) } });
}
