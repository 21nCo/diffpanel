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

/**
 * The most event keys an issued cursor holds. A key is at most 137 characters (`feedback:` and a 128-character id), so
 * an encoded cursor stays under 950,000 characters, inside the tools' 1,000,000-character cursor input.
 */
export const MAX_CURSOR_SEEN = 5_000;

/** Extra listings {@link observe} makes to compact a cursor before it falls back to forgetting keys. */
export const MAX_COMPACTIONS = 3;

const encodedCursorSchema = z.object({
  v: z.literal(1),
  w: z.number().int().nonnegative(),
  c: z.number().int().nonnegative(),
  s: z.array(z.string().min(1).max(256)).max(MAX_CURSOR_SEEN),
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

/** Orders strings by UTF-16 code unit, the same on every host and locale, so an encoded cursor is stable. */
function compareText(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
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
 * A cursor that has seen nothing yet but holds `earlier`'s newest commit as its proof: observing a later complete
 * listing with it keeps by key only the events at or after that commit.
 */
export function cursorProvenBy(earlier: readonly Feedback[]): FeedbackCursor {
  return { ...ORIGIN_CURSOR, committed: newestCommit(earlier, 0) };
}

/**
 * A cursor that has seen `items`, a complete listing sent after `earlier` (another complete listing) returned. Only
 * the newest events are kept by key: everything before `earlier`'s newest write is covered by the watermark.
 */
export function cursorAfter(earlier: readonly Feedback[], items: readonly Feedback[]): FeedbackCursor {
  return observeListing(cursorProvenBy(earlier), items);
}

/** What {@link observe} found. */
export interface Observation {
  /** Every listed item, each in its newest listed version, in the daemon's order (oldest first). */
  readonly items: Feedback[];
  /** The events `from` had not seen, each once. */
  readonly events: FeedbackEvent[];
  /** A cursor that has seen all of them and that {@link encodeCursor} can always issue. */
  readonly cursor: FeedbackCursor;
}

/**
 * Observes `items`, a listing sent after `from` was made (as for {@link observeListing}), and makes the resulting
 * cursor small enough to issue.
 *
 * A cursor keeps by key every event at or after its previous listing's newest commit, so a burst of more than
 * {@link MAX_CURSOR_SEEN} events between two listings would make it too large. Each extra listing, from `relist`
 * (which must list every item updated at or after the `since` it is given), raises the watermark to the previous
 * listing's newest commit and leaves by key only what was committed after that; whatever new events it finds are
 * returned too. When `relist` gives `undefined` (no time is left for it), or after {@link MAX_COMPACTIONS} listings
 * that still leave too many keys (events committed faster than the daemon lists them), the cursor forgets the keys it
 * cannot hold, so those events may be handed over again but are never skipped.
 */
export async function observe(
  from: FeedbackCursor,
  items: readonly Feedback[],
  relist: (since: string | undefined) => Promise<Feedback[] | undefined>,
): Promise<Observation> {
  const events = unseenEvents(from, items);
  const latest = new Map(items.map((item) => [item.id, item]));
  let cursor = observeListing(from, items);
  for (let round = 0; cursor.seen.size > MAX_CURSOR_SEEN && round < MAX_COMPACTIONS; round += 1) {
    // Each relist depends on the cursor the previous one left, so they run one after another.
    const more = await relist(cursorSince(cursor));
    if (!more) break;
    events.push(...unseenEvents(cursor, more));
    for (const item of more) latest.set(item.id, item);
    cursor = observeListing(cursor, more);
  }
  if (cursor.seen.size > MAX_CURSOR_SEEN) {
    // Forgetting a key keeps the watermark, so the event comes back as new: a duplicate, never a loss.
    cursor = { ...cursor, seen: new Set([...cursor.seen].sort(compareText).slice(0, MAX_CURSOR_SEEN)) };
  }
  const ordered = [...latest.values()].sort((left, right) =>
    Date.parse(left.createdAt) - Date.parse(right.createdAt) || compareText(left.id, right.id));
  return { items: ordered, events, cursor };
}

/** The `since` filter that lists every item that can have an event the cursor has not seen. */
export function cursorSince(cursor: FeedbackCursor): string | undefined {
  return cursor.watermark > 0 ? new Date(cursor.watermark).toISOString() : undefined;
}

/** An opaque string the agent passes back; base64url JSON so that it survives any tool-call transport. */
export function encodeCursor(cursor: FeedbackCursor): string {
  // An issued cursor must decode on the next call; observe() keeps every cursor the tools issue within the limit.
  if (cursor.seen.size > MAX_CURSOR_SEEN) throw new Error(`A cursor holds ${cursor.seen.size} event keys`);
  return Buffer.from(JSON.stringify({ v: 1, w: cursor.watermark, c: cursor.committed, s: [...cursor.seen].sort(compareText) })).toString("base64url");
}

/**
 * The cursor an agent passed back. Validation is structural: anything that is not a well-formed cursor within the
 * issued size limits is refused as `invalid_request`. It does not prove that a tool issued the value; a hand-made
 * cursor only changes what that agent's own calls report as new.
 */
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
