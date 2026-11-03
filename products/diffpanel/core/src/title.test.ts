import { describe, expect, it } from "vitest";
import { displayReviewTitle, parseReviewTitle, titleForScope } from "./title.js";

describe("review titles", () => {
  it("trims and accepts a custom title", () => {
    expect(parseReviewTitle("  PR 567 retired surfaces  ")).toBe("PR 567 retired surfaces");
  });

  it("rejects an empty or oversized title", () => {
    expect(() => parseReviewTitle("   ")).toThrow(/1 to 80/);
    expect(() => parseReviewTitle("x".repeat(81))).toThrow(/1 to 80/);
  });

  it("falls back to the git scope label", () => {
    expect(titleForScope({ type: "worktree", baseRef: "HEAD", baseSha: "abc" })).toBe("Working tree");
    expect(titleForScope({
      type: "range",
      expression: "41a8f8db..c33a9b59",
      baseRef: "41a8f8db",
      compareRef: "c33a9b59",
      baseSha: "abc",
      compareSha: "def",
      mergeBase: false,
    })).toBe("41a8f8db..c33a9b59");
    expect(displayReviewTitle(null, { type: "staged", baseRef: "HEAD", baseSha: "abc" })).toBe("Staged changes");
    expect(displayReviewTitle("Account runtime", { type: "staged", baseRef: "HEAD", baseSha: "abc" })).toBe("Account runtime");
  });
});
