import type { Feedback } from "iterbar";
import { z } from "zod";
import { IterbarToolError } from "./errors.js";

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

/**
 * A position in the feedback history.
 *
 * It relies only on the order in which the store commits: the daemon's store has one writer, runs its writes one at a
 * time and stamps each one inside that turn with a strictly increasing clock, so writes commit in timestamp order. A
 * committed `updatedAt` that a listing observed therefore proves that every event timestamped before it was already
 * committed, and a later listing (which starts after that observation) contains all of them. No write or listing
 * duration is assumed.
 */
export interface FeedbackCursor {
  /** Epoch milliseconds; every event timestamped before it is seen. */
  readonly watermark: number;
  /** Keys of the events at or after `watermark` that are seen. */
  readonly seen: ReadonlySet<string>;
  /**
   * Epoch milliseconds: the newest committed `updatedAt` this cursor's listings observed. The next listing starts after
   * that observation, so once it is processed the watermark can move up to here.
   */
  readonly committed: number;
}

const encodedCursorSchema = z.object({
  v: z.literal(1),
  w: z.number().int().nonnegative(),
  c: z.number().int().nonnegative(),
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
export const ORIGIN_CURSOR: FeedbackCursor = Object.freeze({ watermark: 0, seen: new Set<string>(), committed: 0 });

/** The events of `items` that `cursor` has not seen. */
export function unseenEvents(cursor: FeedbackCursor, items: readonly Feedback[]): FeedbackEvent[] {
  return items.flatMap(feedbackEvents).filter((event) => event.at >= cursor.watermark && !cursor.seen.has(event.key));
}

/** The newest committed write a listing observed, or `since` when it observed none newer. */
function newestCommit(items: readonly Feedback[], since: number): number {
  return items.reduce((newest, item) => Math.max(newest, Date.parse(item.updatedAt)), since);
}

/**
 * The cursor after `cursor` has also seen every event of `items`: a listing that was sent after `cursor` was made and
 * holds every item with an event at or after `cursor.watermark` (as `GET /feedback?since=<cursorSince(cursor)>` or a
 * complete listing does). Every event of `items` must have been handed to the agent, or be one it may skip.
 *
 * A listing is not a snapshot: the store reads one record after another, so a write committed while it ran may be
 * missing even though a newer write on another record is present. The watermark therefore moves only up to what an
 * earlier observation proved committed (`cursor.committed`), never to what this listing shows; the events at or
 * after it are remembered by key, and this listing's newest write becomes the proof for the next one.
 */
export function observeListing(cursor: FeedbackCursor, items: readonly Feedback[]): FeedbackCursor {
  const events = items.flatMap(feedbackEvents);
  const watermark = Math.max(cursor.watermark, cursor.committed);
  const seen = new Set<string>(cursor.seen);
  for (const event of events) seen.add(event.key);
  // An event older than the watermark is covered by it. Every seen key is on an item updated at or after the old
  // watermark, so the listing holds it and its time is known.
  const atOf = new Map(events.map((event) => [event.key, event.at]));
  for (const key of seen) {
    const at = atOf.get(key);
    if (at !== undefined && at < watermark) seen.delete(key);
  }
  return { watermark, seen, committed: newestCommit(items, cursor.committed) };
}

/**
 * A cursor for which everything in `items`, a complete listing, is seen and everything else is new. Its seen set
 * holds every listed event, so it is meant for one call; the first {@link observeListing} after it compacts it.
 */
export function baselineCursor(items: readonly Feedback[]): FeedbackCursor {
  return {
    watermark: 0,
    seen: new Set(items.flatMap(feedbackEvents).map((event) => event.key)),
    committed: newestCommit(items, 0),
  };
}

/**
 * A cursor that has seen `items`, a complete listing sent after `earlier` (another complete listing) returned. Only
 * the newest events are kept by key: everything before `earlier`'s newest write is covered by the watermark.
 */
export function cursorAfter(earlier: readonly Feedback[], items: readonly Feedback[]): FeedbackCursor {
  return observeListing({ ...ORIGIN_CURSOR, committed: newestCommit(earlier, 0) }, items);
}

/** The `since` filter that lists every item that can have an event the cursor has not seen. */
export function cursorSince(cursor: FeedbackCursor): string | undefined {
  return cursor.watermark > 0 ? new Date(cursor.watermark).toISOString() : undefined;
}

/** An opaque string the agent passes back; base64url JSON so that it survives any tool-call transport. */
export function encodeCursor(cursor: FeedbackCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, w: cursor.watermark, c: cursor.committed, s: [...cursor.seen].sort() })).toString("base64url");
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
  if (parsed.data.c < parsed.data.w) {
    throw new IterbarToolError("invalid_request", "cursor is not a value returned by list_feedback or wait_for_feedback");
  }
  return { watermark: parsed.data.w, seen: new Set(parsed.data.s), committed: parsed.data.c };
}
