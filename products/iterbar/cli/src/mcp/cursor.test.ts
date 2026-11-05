import { describe, expect, it } from "vitest";
import {
  advanceCursor,
  CURSOR_GRACE_MS,
  cursorAt,
  cursorSince,
  decodeCursor,
  encodeCursor,
  ORIGIN_CURSOR,
  unseenEvents,
} from "./cursor.js";
import { feedbackItem, type ReplySpec } from "./test-support/feedback.js";

const T0 = Date.parse("2026-11-05T10:00:00.000Z");
const item = (id: string, createdMs: number, replies: ReplySpec[] = []) =>
  feedbackItem(id, T0 + createdMs, replies.map(([replyId, kind, at]) => [replyId, kind, T0 + at] as const));

describe("feedback cursor", () => {
  it("never acknowledges history a listing may not have observed, however new the listed events are", () => {
    // The listing starts at 0 s and reads feedback-a before its user reply is committed at 1 s; it reaches
    // feedback-b, created at 7 s, only later. A watermark taken from the newest listed event would pass 1 s.
    const listing = [item("feedback-a", -60_000), item("feedback-b", 7_000)];
    const cursor = advanceCursor(ORIGIN_CURSOR, listing, T0);
    expect(cursor.watermark).toBe(T0 - CURSOR_GRACE_MS);
    const next = [item("feedback-a", -60_000, [["reply-user", "user", 1_000]]), item("feedback-b", 7_000)];
    expect(unseenEvents(cursor, next).map((event) => event.key)).toEqual(["reply:reply-user"]);
    expect(cursorSince(cursor)).toBe(new Date(T0 - CURSOR_GRACE_MS).toISOString());
  });

  it("starting at a time, counts only what is timestamped at or after it", () => {
    const cursor = cursorAt(T0);
    const items = [item("feedback-old", -1), item("feedback-new", 0, [["reply-user", "user", 5]])];
    expect(unseenEvents(cursor, items).map((event) => event.key)).toEqual(["feedback:feedback-new", "reply:reply-user"]);
    // A listing made right after the start does not move the watermark back.
    expect(advanceCursor(cursor, items, T0 + 10).watermark).toBe(T0);
  });

  it("treats an item with the same millisecond as a seen one as new", () => {
    const cursor = advanceCursor(ORIGIN_CURSOR, [item("feedback-a", 1_000)], T0 + 1_000);
    expect(unseenEvents(cursor, [item("feedback-a", 1_000), item("feedback-b", 1_000)]).map((event) => event.key)).toEqual([
      "feedback:feedback-b",
    ]);
  });

  it("counts user replies and never agent replies", () => {
    const cursor = advanceCursor(ORIGIN_CURSOR, [item("feedback-a", 0)], T0);
    const updated = item("feedback-a", 0, [["reply-agent", "agent", 100], ["reply-user", "user", 200]]);
    expect(unseenEvents(cursor, [updated])).toEqual([
      { key: "reply:reply-user", feedbackId: "feedback-a", at: T0 + 200, kind: "user_reply", replyId: "reply-user" },
    ]);
  });

  it("survives encoding, keeps only the grace window by key, and refuses anything else", () => {
    const items = [item("feedback-old", 0), item("feedback-new", 60_000)];
    const cursor = advanceCursor(ORIGIN_CURSOR, items, T0 + 60_000);
    expect([...cursor.seen]).toEqual(["feedback:feedback-new"]);
    const decoded = decodeCursor(encodeCursor(cursor));
    expect(decoded).toEqual(cursor);
    expect(unseenEvents(decoded, items)).toEqual([]);
    for (const value of ["", "not-a-cursor", Buffer.from(JSON.stringify({ v: 2, w: 0, s: [] })).toString("base64url")]) {
      expect(() => decodeCursor(value)).toThrow(expect.objectContaining({ code: "invalid_request" }));
    }
  });
});
