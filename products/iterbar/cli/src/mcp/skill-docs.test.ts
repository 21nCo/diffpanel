import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deliveryContractProblems } from "./test-support/delivery.js";
import { HANDLED_EVENT_RULE, SESSION_RULE } from "./tools.js";

const skill = (path: string) => fileURLToPath(new URL(`../../../skills/iterbar/${path}`, import.meta.url));

describe("the shipped Iterbar skill", () => {
  it.each(["SKILL.md", "references/tools.md"])("%s states at-least-once delivery and how to skip a handled event", async (path) => {
    expect(deliveryContractProblems(await readFile(skill(path), "utf8"))).toEqual([]);
  });

  it("applies the skip rule to every tool, not only to filtered lookups", async () => {
    const text = (await readFile(skill("SKILL.md"), "utf8")).replaceAll("`", "").replace(/\s+/g, " ");
    expect(text).toContain("an event you already got can come back, from either tool");
  });

  it.each([
    // The round-4 startup rule: it skips a user reply on a resolved thread.
    "at the start of a session read every item that is not resolved with get_feedback, done ones included",
    "read every unresolved thread at the start of a session",
    "handle each item that is not resolved",
    // Reply-order selectors, in any wording.
    "handle the threads whose last reply is from the user",
    "a thread needs you when the last reply came from the user",
    "a thread needs you when the last reply was from the user",
    "a thread needs you if its last reply comes from the user",
  ])("rejects a status-bounded or reply-order startup rule: %s", (wrong) => {
    expect(deliveryContractProblems(`${SESSION_RULE} ${HANDLED_EVENT_RULE}`)).toEqual([]);
    const problems = deliveryContractProblems(`${SESSION_RULE} ${HANDLED_EVENT_RULE} ${wrong}`);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((problem) => problem.startsWith("wrong rule: "))).toBe(true);
  });

  it("requires the startup check over every status, the reopening of a resolved thread and attachment-free detail reads", () => {
    const without = (part: string) => deliveryContractProblems(`${SESSION_RULE.replace(part, "")} ${HANDLED_EVENT_RULE}`);
    expect(without("whatever its status, resolved and done ones included, ")).toEqual(["missing: a session starts by checking every item of every status"]);
    expect(without("Such a reply on a resolved or done thread reopens it: ")).toEqual(["missing: an unanswered reply reopens a resolved or done thread"]);
    expect(without(", with includeAttachments: false unless you need its screenshot or evidence")).toEqual(["missing: detail is read without attachments unless needed"]);
  });
});
