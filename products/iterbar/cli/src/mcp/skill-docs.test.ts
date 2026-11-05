import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deliveryContractProblems } from "./test-support/delivery.js";

const skill = (path: string) => fileURLToPath(new URL(`../../../skills/iterbar/${path}`, import.meta.url));

describe("the shipped Iterbar skill", () => {
  it.each(["SKILL.md", "references/tools.md"])("%s states at-least-once delivery and how to skip a handled event", async (path) => {
    expect(deliveryContractProblems(await readFile(skill(path), "utf8"))).toEqual([]);
  });

  it("applies the skip rule to every tool, not only to filtered lookups", async () => {
    const text = (await readFile(skill("SKILL.md"), "utf8")).replace(/`/g, "").replace(/\s+/g, " ");
    expect(text).toContain("an event you already got can come back, from either tool");
    expect(text).not.toMatch(/if you did act on an item it showed, skip that event/);
  });
});
