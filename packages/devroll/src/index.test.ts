import { describe, expect, it } from "vitest";
import { findTool, tools } from "./index.js";

describe("devroll catalog", () => {
  it("lists each tool once with a matching products directory id", () => {
    const ids = tools.map((tool) => tool.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["diffpanel", "iterbar"]);
  });

  it("finds tools by id and returns undefined for unknown ids", () => {
    expect(findTool("diffpanel")?.packageName).toBe("diffpanel");
    expect(findTool("missing")).toBeUndefined();
  });

  it("freezes the catalog", () => {
    expect(Object.isFrozen(tools)).toBe(true);
    for (const tool of tools) expect(Object.isFrozen(tool)).toBe(true);
  });
});
