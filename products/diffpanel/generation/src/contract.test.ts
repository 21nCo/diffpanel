import { describe, expect, it } from "vitest";
import { generationContract, generationInstructionLines } from "./contract.js";

describe("generation contract", () => {
  it("exposes provider-neutral exact-coverage and evidence requirements", () => {
    expect(generationContract.ownership).toContain("exactly one");
    expect(generationContract.skippedPaths).toContain("not part");
    expect(generationInstructionLines()).toContain(generationContract.diagrams);
    expect(generationInstructionLines()).toContain(
      "Line and diagram evidence must reference files and immutable item IDs from the prepared manifest.",
    );
  });
});
