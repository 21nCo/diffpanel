import { describe, expect, it } from "vitest";
import {
  baselineCursor,
  cursorAfter,
  cursorSince,
  decodeCursor,
  encodeCursor,
  MAX_CURSOR_SEEN,
  MAX_CURSOR_TIME_MS,
  observe,
  observeListing,
  ORIGIN_CURSOR,
  unseenEvents,
  type FeedbackCursor,
} from "./cursor.js";
import { feedbackItem, type ReplySpec } from "./test-support/feedback.js";

const T0 = Date.parse("2026-11-05T10:00:00.000Z");
const MINUTE = 60_000;
const item = (id: string, createdMs: number, replies: ReplySpec[] = []) =>
  feedbackItem(id, T0 + createdMs, replies.map(([replyId, kind, at]) => [replyId, kind, T0 + at] as const));
const keys = (cursor: FeedbackCursor, items: ReturnType<typeof item>[]) => unseenEvents(cursor, items).map((event) => event.key);

describe("feedback cursor", () => {
  it("moves its watermark only up to a commit an earlier listing observed, never to what the current one shows", () => {
    // The listing reads feedback-a before its user reply is committed and reaches feedback-b, written later, only
    // afterwards. However new feedback-b is, the listing does not prove the reply was committed when it started.
    const listing = [item("feedback-a", -MINUTE), item("feedback-b", 7_000)];
    const cursor = observeListing(ORIGIN_CURSOR, listing);
    expect(cursor.watermark).toBe(0);
    expect(cursor.committed).toBe(T0 + 7_000);
    const next = [item("feedback-a", -MINUTE, [["reply-user", "user", 1_000]]), item("feedback-b", 7_000)];
    expect(keys(cursor, next)).toEqual(["reply:reply-user"]);
    // The next listing started after feedback-b was observed, so it holds everything written before it.
    const after = observeListing(cursor, next);
    expect(after.watermark).toBe(T0 + 7_000);
    expect([...after.seen]).toEqual(["feedback:feedback-b"]);
    expect(cursorSince(after)).toBe(new Date(T0 + 7_000).toISOString());
  });

  it("keeps an item written long before it was committed, whatever the delay", () => {
    // feedback-late is stamped at 0 s, but its write is still running when a listing an hour later returns.
    const busy = [item("feedback-a", -MINUTE)];
    let cursor = observeListing(observeListing(ORIGIN_CURSOR, busy), busy);
    const late = item("feedback-late", 0);
    expect(cursor.watermark).toBeLessThanOrEqual(T0);
    // Committed afterwards, it is the newest write, and the next listing returns it.
    expect(keys(cursor, [busy[0]!, late])).toEqual(["feedback:feedback-late"]);
    cursor = observeListing(cursor, [busy[0]!, late]);
    expect(keys(cursor, [busy[0]!, late])).toEqual([]);
  });

  it("from a baseline, counts exactly what the baseline listing did not hold as new", () => {
    const baseline = baselineCursor([item("feedback-old", -MINUTE, [["reply-old", "user", -1_000]])]);
    const later = [
      item("feedback-old", -MINUTE, [["reply-old", "user", -1_000], ["reply-new", "user", -500]]),
      item("feedback-early", -30_000),
    ];
    // Both new events carry times before the baseline's newest commit: they were committed after it was listed.
    expect(keys(baseline, later)).toEqual(["reply:reply-new", "feedback:feedback-early"]);
  });

  it("after two listings, covers the first one's history by its watermark and keeps only newer events by key", () => {
    const first = [item("feedback-a", 0), item("feedback-b", MINUTE)];
    const second = [...first, item("feedback-c", 2 * MINUTE)];
    const cursor = cursorAfter(first, second);
    expect(cursor.watermark).toBe(T0 + MINUTE);
    expect([...cursor.seen].sort()).toEqual(["feedback:feedback-b", "feedback:feedback-c"]);
    expect(keys(cursor, second)).toEqual([]);
  });

  it("treats an event in the same millisecond as a seen one as new", () => {
    const cursor = observeListing({ ...ORIGIN_CURSOR, committed: T0 + 1_000 }, [item("feedback-a", 1_000)]);
    expect(keys(cursor, [item("feedback-a", 1_000), item("feedback-b", 1_000)])).toEqual(["feedback:feedback-b"]);
  });

  it("counts user replies and never agent replies", () => {
    const cursor = observeListing(ORIGIN_CURSOR, [item("feedback-a", 0)]);
    const updated = item("feedback-a", 0, [["reply-agent", "agent", 100], ["reply-user", "user", 200]]);
    expect(unseenEvents(cursor, [updated])).toEqual([
      { key: "reply:reply-user", feedbackId: "feedback-a", at: T0 + 200, kind: "user_reply", replyId: "reply-user" },
    ]);
  });

  it("survives encoding and refuses anything else", () => {
    const items = [item("feedback-old", 0), item("feedback-new", MINUTE)];
    const cursor = cursorAfter(items, items);
    expect([...cursor.seen]).toEqual(["feedback:feedback-new"]);
    const decoded = decodeCursor(encodeCursor(cursor));
    expect(decoded).toEqual(cursor);
    expect(unseenEvents(decoded, items)).toEqual([]);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const value of [
      "",
      "not-a-cursor",
      encode({ v: 2, w: 0, c: 0, s: [] }),
      encode({ v: 1, w: 0, s: [] }),
      // A watermark past the newest observed commit was never produced.
      encode({ v: 1, w: 10, c: 5, s: [] }),
    ]) {
      expect(() => decodeCursor(value)).toThrow(expect.objectContaining({ code: "invalid_request" }));
    }
  });

  it("accepts times up to the end of year 9999 and refuses any later one before it is turned into a since filter", () => {
    const encode = (w: number, c: number) => Buffer.from(JSON.stringify({ v: 1, w, c, s: [] })).toString("base64url");
    const latest = decodeCursor(encode(MAX_CURSOR_TIME_MS, MAX_CURSOR_TIME_MS));
    expect(latest).toEqual({ watermark: MAX_CURSOR_TIME_MS, committed: MAX_CURSOR_TIME_MS, seen: new Set() });
    expect(cursorSince(latest)).toBe("9999-12-31T23:59:59.999Z");
    for (const [w, c] of [[0, MAX_CURSOR_TIME_MS + 1], [MAX_CURSOR_TIME_MS + 1, MAX_CURSOR_TIME_MS + 1]]) {
      expect(() => decodeCursor(encode(w!, c!))).toThrow(expect.objectContaining({ code: "invalid_request" }));
    }
  });

  it("issues a cursor that fits the decode limit and the tools' 1,000,000-character input with the longest keys", () => {
    const id = (index: number) => `f${String(index).padStart(127, "0")}`;
    const cursor: FeedbackCursor = {
      watermark: T0, committed: T0, seen: new Set(Array.from({ length: MAX_CURSOR_SEEN }, (_, index) => `feedback:${id(index)}`)),
    };
    const encoded = encodeCursor(cursor);
    expect(encoded.length).toBeLessThan(1_000_000);
    expect(decodeCursor(encoded)).toEqual(cursor);
    expect(() => encodeCursor({ ...cursor, seen: new Set([...cursor.seen, "feedback:one-more"]) })).toThrow();
  });
});

describe("observe", () => {
  const burst = (count: number, from: number) => Array.from({ length: count }, (_, index) => item(`feedback-${from + index}`, from + index));

  it("compacts a cursor after a burst of more events than it can hold, with one more listing", () => {
    const start = cursorAfter([item("feedback-a", 0)], [item("feedback-a", 0)]);
    const listing = [item("feedback-a", 0), ...burst(MAX_CURSOR_SEEN * 2 + 1, 10)];
    const sinces: (string | undefined)[] = [];
    return observe(start, listing, async (since) => {
      sinces.push(since);
      return listing;
    }).then((observed) => {
      expect(sinces).toEqual([cursorSince(observeListing(start, listing))]);
      expect(observed.events).toHaveLength(MAX_CURSOR_SEEN * 2 + 1);
      expect(observed.items).toEqual(listing);
      expect(observed.cursor.seen.size).toBeLessThanOrEqual(1);
      expect(keys(decodeCursor(encodeCursor(observed.cursor)), listing)).toEqual([]);
    });
  });

  it("returns what the compacting listings find, each event once", async () => {
    const first = burst(MAX_CURSOR_SEEN + 1, 10);
    const late = item("feedback-late", 20 * MINUTE, [["reply-late", "user", 20 * MINUTE + 1]]);
    const observed = await observe(ORIGIN_CURSOR, first, async () => [...first, late]);
    expect(observed.events.map((event) => event.key).slice(-2)).toEqual(["feedback:feedback-late", "reply:reply-late"]);
    expect(new Set(observed.events.map((event) => event.key)).size).toBe(MAX_CURSOR_SEEN + 3);
    expect(observed.items.at(-1)).toEqual(late);
    expect(keys(observed.cursor, [...first, late])).toEqual([]);
  });

  it("forgets keys rather than skip events when bursts outpace every compacting listing", async () => {
    let next = 10;
    const all: ReturnType<typeof item>[] = [];
    const grow = () => {
      all.push(...burst(MAX_CURSOR_SEEN + 1, next));
      next += MAX_CURSOR_SEEN + 1;
      return [...all];
    };
    const observed = await observe(ORIGIN_CURSOR, grow(), async () => grow());
    expect(observed.cursor.seen.size).toBe(MAX_CURSOR_SEEN);
    const cursor = decodeCursor(encodeCursor(observed.cursor));
    // Nothing is skipped: every event was handed over now, and whatever the cursor does not cover comes back as new.
    expect(new Set(observed.events.map((event) => event.key)).size).toBe(all.length);
    const again = keys(cursor, all);
    expect(again.length).toBeGreaterThan(0);
    expect(again.length).toBeLessThan(all.length);
  });
});
