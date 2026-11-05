import type { Feedback } from "iterbar";
import { z } from "zod";
import { IterbarToolError } from "./errors.js";

/**
 * How far behind the start of the listing it was taken from a cursor's watermark stays. The store gives a write its
 * timestamp before the write is visible to `GET /feedback`, so an event a listing did not observe can carry a timestamp
 * up to this long before the listing started; events in this window are remembered by key instead of by time. It
 * bounds only the time from a store write's timestamp to its commit, never how long a listing takes.
 */
export const CURSOR_GRACE_MS = 30_000;

/**
 * Something a user did that an agent waits for: a new feedback item (`created`) or a user reply in an existing
 * thread. Agent replies and status changes are not events, so an agent never wakes itself up.
 */
export interface FeedbackEvent {
  /** `feedback:<id>` or `reply:<id>`. */
  readonly key: string;
  readonly feedbackId: string;
  readonly at: number;
  readonly kind: "created" | "user_reply";
  readonly replyId?: string;
}

/** A position in the feedback history: events at or before `at` are seen unless they are newer than `watermark`. */
export interface FeedbackCursor {
  /** Epoch milliseconds; every event before it is seen. */
  readonly watermark: number;
  /** Keys of the events at or after `watermark` that are already seen. */
  readonly seen: ReadonlySet<string>;
}

const encodedCursorSchema = z.object({
  v: z.literal(1),
  w: z.number().int().nonnegative(),
  s: z.array(z.string().min(1).max(256)).max(10_000),
});

export function feedbackEvents(feedback: Feedback): FeedbackEvent[] {
  const events: FeedbackEvent[] = [
    { key: `feedback:${feedback.id}`, feedbackId: feedback.id, at: Date.parse(feedback.createdAt), kind: "created" },
  ];
  for (const reply of feedback.replies) {
    if (reply.author.kind !== "user") continue;
    events.push({
      key: `reply:${reply.id}`, feedbackId: feedback.id, at: Date.parse(reply.createdAt), kind: "user_reply", replyId: reply.id,
    });
  }
  return events;
}

/** The empty history: everything is new. */
export const ORIGIN_CURSOR: FeedbackCursor = Object.freeze({ watermark: 0, seen: new Set<string>() });

/** The events of `items` that `cursor` has not seen. */
export function unseenEvents(cursor: FeedbackCursor, items: readonly Feedback[]): FeedbackEvent[] {
  return items.flatMap(feedbackEvents).filter((event) => event.at >= cursor.watermark && !cursor.seen.has(event.key));
}

/**
 * A cursor for a wait that starts at `startedAt` (epoch milliseconds, taken before anything is listed or subscribed):
 * every event from before it is seen, every later one is new. The store's timestamps are at least the wall-clock time
 * of the write, so a write made after the call started never carries an earlier timestamp.
 */
export function cursorAt(startedAt: number): FeedbackCursor {
  return { watermark: Math.max(0, Math.floor(startedAt)), seen: new Set<string>() };
}

/**
 * The cursor after `cursor` has also seen every event of `items`, a listing that started at `listedAt` (epoch
 * milliseconds, taken before the request was sent). `items` must hold every item with an event at or after
 * `cursor.watermark` (a `GET /feedback?since=<watermark>` listing does).
 *
 * A listing is not a snapshot: the store reads one record after another, so an event committed while it ran may be
 * missing even though a newer one on another record is present. Every event it missed was committed after the
 * listing started, so its timestamp is at least `listedAt - CURSOR_GRACE_MS`. The watermark therefore never passes
 * that point, however new the listed events are; the events at or after it are acknowledged by key only.
 */
export function advanceCursor(cursor: FeedbackCursor, items: readonly Feedback[], listedAt: number): FeedbackCursor {
  const events = items.flatMap(feedbackEvents);
  const watermark = Math.max(cursor.watermark, Math.floor(listedAt) - CURSOR_GRACE_MS);
  const seen = new Set<string>(cursor.seen);
  for (const event of events) seen.add(event.key);
  // Keys older than the watermark are covered by it; only the grace window is kept by key.
  const atOf = new Map(events.map((event) => [event.key, event.at]));
  for (const key of seen) {
    const at = atOf.get(key);
    if (at !== undefined && at < watermark) seen.delete(key);
  }
  return { watermark, seen };
}

/** The `since` filter that lists every item that can have an event the cursor has not seen. */
export function cursorSince(cursor: FeedbackCursor): string | undefined {
  return cursor.watermark > 0 ? new Date(cursor.watermark).toISOString() : undefined;
}

/** An opaque string the agent passes back; base64url JSON so that it survives any tool-call transport. */
export function encodeCursor(cursor: FeedbackCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, w: cursor.watermark, s: [...cursor.seen].sort() })).toString("base64url");
}

export function decodeCursor(value: string): FeedbackCursor {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    json = undefined;
  }
  const parsed = encodedCursorSchema.safeParse(json);
  if (!parsed.success) {
    throw new IterbarToolError("invalid_request", "cursor is not a value returned by list_feedback or wait_for_feedback");
  }
  return { watermark: parsed.data.w, seen: new Set(parsed.data.s) };
}
