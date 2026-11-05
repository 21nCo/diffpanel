import type { Feedback } from "iterbar";
import { describe, expect, it } from "vitest";
import { advanceCursor, CURSOR_GRACE_MS, cursorSince, decodeCursor, encodeCursor, ORIGIN_CURSOR, unseenEvents } from "./cursor.js";

const T0 = Date.parse("2026-11-05T10:00:00.000Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();

function item(id: string, createdMs: number, replies: Array<[string, "user" | "agent", number]> = []): Feedback {
  return {
    schemaVersion: 1, id, kind: "comment", text: "x", pageUrl: "http://localhost:5173/", target: null, activeVariants: [],
    screenshotUnavailableReason: null, screenshot: null, evidence: null, status: "open",
    replies: replies.map(([replyId, kind, at]) => ({ id: replyId, author: { kind, name: null }, text: "r", createdAt: iso(at) })),
    createdAt: iso(createdMs),
    updatedAt: iso(Math.max(createdMs, ...replies.map(([, , at]) => at))),
  };
}

describe("feedback cursor", () => {
  it("still finds an item that becomes visible late with a timestamp inside the grace window", () => {
    const cursor = advanceCursor(ORIGIN_CURSOR, [item("feedback-b", 10_000)]);
    // Written at 9 s but listed only after the item written at 10 s.
    const late = item("feedback-a", 9_000);
    expect(unseenEvents(cursor, [late, item("feedback-b", 10_000)]).map((event) => event.feedbackId)).toEqual(["feedback-a"]);
    expect(cursorSince(cursor)).toBe(iso(10_000 - CURSOR_GRACE_MS));
  });

  it("treats an item with the same millisecond as a seen one as new", () => {
    const cursor = advanceCursor(ORIGIN_CURSOR, [item("feedback-a", 1_000)]);
    expect(unseenEvents(cursor, [item("feedback-a", 1_000), item("feedback-b", 1_000)]).map((event) => event.key)).toEqual([
      "feedback:feedback-b",
    ]);
  });

  it("counts user replies and never agent replies", () => {
    const cursor = advanceCursor(ORIGIN_CURSOR, [item("feedback-a", 0)]);
    const updated = item("feedback-a", 0, [["reply-agent", "agent", 100], ["reply-user", "user", 200]]);
    expect(unseenEvents(cursor, [updated])).toEqual([
      { key: "reply:reply-user", feedbackId: "feedback-a", at: T0 + 200, kind: "user_reply", replyId: "reply-user" },
    ]);
  });

  it("survives encoding, keeps only the grace window by key, and refuses anything else", () => {
    const items = [item("feedback-old", 0), item("feedback-new", 60_000)];
    const cursor = advanceCursor(ORIGIN_CURSOR, items);
    expect([...cursor.seen]).toEqual(["feedback:feedback-new"]);
    const decoded = decodeCursor(encodeCursor(cursor));
    expect(decoded).toEqual(cursor);
    expect(unseenEvents(decoded, items)).toEqual([]);
    for (const value of ["", "not-a-cursor", Buffer.from(JSON.stringify({ v: 2, w: 0, s: [] })).toString("base64url")]) {
      expect(() => decodeCursor(value)).toThrow(expect.objectContaining({ code: "invalid_request" }));
    }
  });
});
