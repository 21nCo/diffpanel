import type { Feedback } from "iterbar";

export type ReplySpec = readonly [id: string, kind: "user" | "agent", atMs: number];

/** A comment created at `createdMs` (epoch milliseconds) with the given replies. */
export function feedbackItem(id: string, createdMs: number, replies: readonly ReplySpec[] = []): Feedback {
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    schemaVersion: 1, id, kind: "comment", text: "x", pageUrl: "http://localhost:5173/", target: null, activeVariants: [],
    screenshotUnavailableReason: null, screenshot: null, evidence: null, status: "open",
    replies: replies.map(([replyId, kind, at]) => ({ id: replyId, author: { kind, name: null }, text: "r", createdAt: iso(at) })),
    createdAt: iso(createdMs),
    updatedAt: iso(Math.max(createdMs, ...replies.map(([, , at]) => at))),
  };
}
