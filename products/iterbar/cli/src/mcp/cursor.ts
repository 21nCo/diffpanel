import type { Feedback } from "iterbar";
import { z } from "zod";
import { IterbarToolError } from "./errors.js";

/**
 * How far behind the newest event a cursor's watermark stays. Items become visible to `GET /feedback` after their
 * timestamps are taken, so two near-simultaneous writes can appear out of order; events this close to the newest
 * one are remembered by key instead of being assumed seen by time.
 */
export const CURSOR_GRACE_MS = 5_000;

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
 * The cursor after `cursor` has also seen every event of `items`. `items` must hold every item with an event at
 * or after `cursor.watermark` (a `GET /feedback?since=<watermark>` listing does), so that nothing between the old
 * and the new watermark is skipped.
 */
export function advanceCursor(cursor: FeedbackCursor, items: readonly Feedback[]): FeedbackCursor {
  const events = items.flatMap(feedbackEvents);
  const newest = events.reduce((latest, event) => Math.max(latest, event.at), cursor.watermark);
  const watermark = Math.max(cursor.watermark, newest - CURSOR_GRACE_MS);
  const seen = new Set<string>();
  for (const key of cursor.seen) seen.add(key);
  for (const event of events) seen.add(event.key);
  // Keys older than the watermark are covered by it; only the grace window is kept by key.
  const atOrAfter = new Map(events.map((event) => [event.key, event.at]));
  for (const key of seen) {
    const at = atOrAfter.get(key);
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
