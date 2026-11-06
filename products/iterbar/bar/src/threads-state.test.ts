import type { Feedback } from "iterbar";
import { describe, expect, it } from "vitest";
import { mergeFeedback, threadOrder } from "./threads-state.js";

function feedback(id: string, createdAt: string, updatedAt: string, status: Feedback["status"] = "open"): Feedback {
  return {
    schemaVersion: 1, id, kind: "comment", text: id, pageUrl: "http://localhost:5173/", target: null, activeVariants: [],
    screenshotUnavailableReason: null, screenshot: null, evidence: null, replies: [], status, createdAt, updatedAt,
  };
}

describe("mergeFeedback", () => {
  it("keeps the newer copy whichever order a listing and an event arrive in", () => {
    const older = feedback("a", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "open");
    const newer = feedback("a", "2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z", "working");
    const eventFirst = new Map<string, Feedback>();
    expect(mergeFeedback(eventFirst, [newer])).toBe(true);
    expect(mergeFeedback(eventFirst, [older])).toBe(false);
    expect(eventFirst.get("a")?.status).toBe("working");

    const listFirst = new Map<string, Feedback>();
    mergeFeedback(listFirst, [older]);
    expect(mergeFeedback(listFirst, [newer])).toBe(true);
    expect(listFirst.get("a")?.status).toBe("working");
  });

  it("applies a change that shares the held copy's timestamp, and reports an identical copy as no change", () => {
    const held = feedback("a", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "open");
    const map = new Map([["a", held]]);
    expect(mergeFeedback(map, [{ ...held }])).toBe(false);
    expect(mergeFeedback(map, [{ ...held, status: "done" }])).toBe(true);
    expect(map.get("a")?.status).toBe("done");
  });
});

it("orders threads newest first by creation, independent of updates", () => {
  const items = [
    feedback("b", "2026-01-01T00:00:00Z", "2026-01-03T00:00:00Z"),
    feedback("a", "2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z"),
    feedback("c", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
  ];
  expect(threadOrder(items).map((item) => item.id)).toEqual(["a", "b", "c"]);
});
