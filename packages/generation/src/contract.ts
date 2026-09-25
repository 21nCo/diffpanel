export const generationContract = {
  version: 1,
  ownership: "Every captured review item ID must appear in exactly one chapter itemRefs array.",
  skippedPaths: "Skipped paths are reported separately and are not part of captured coverage.",
  evidence: "Line and diagram evidence must reference files and immutable item IDs from the prepared manifest.",
  diagrams: "Architectural changes require grounded overview and focused diagrams, or concrete omission reasons.",
  hierarchy: "Order foundations before dependent behavior and use structural parents only when child chapters form one review story.",
  summaries: "Summaries describe concrete behavior, paths, contracts, and review-order dependencies for an unfamiliar reviewer.",
} as const;

export type GenerationContract = typeof generationContract;

export function generationInstructionLines(): string[] {
  return Object.values(generationContract).flatMap((value) =>
    typeof value === "string" ? [value] : [],
  );
}
