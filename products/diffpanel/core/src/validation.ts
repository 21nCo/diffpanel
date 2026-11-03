import type { GeneratedReview, ReviewManifest } from "./schemas.js";
import { generatedReviewSchema, reviewManifestSchema } from "./schemas.js";

export interface ReviewValidationResult {
  valid: boolean;
  errors: string[];
  missingItemRefs: string[];
  duplicateItemRefs: string[];
  extraItemRefs: string[];
}

export function validateGeneratedReview(
  manifestInput: unknown,
  reviewInput: unknown,
): ReviewValidationResult {
  const manifestResult = reviewManifestSchema.safeParse(manifestInput);
  const reviewResult = generatedReviewSchema.safeParse(reviewInput);
  const errors: string[] = [];

  if (!manifestResult.success) {
    errors.push(...manifestResult.error.issues.map((issue) =>
      `manifest.${issue.path.join(".")}: ${issue.message}`,
    ));
  }
  if (!reviewResult.success) {
    errors.push(...reviewResult.error.issues.map((issue) =>
      `review.${issue.path.join(".")}: ${issue.message}`,
    ));
  }

  if (!manifestResult.success || !reviewResult.success) {
    return {
      valid: false,
      errors,
      missingItemRefs: [],
      duplicateItemRefs: [],
      extraItemRefs: [],
    };
  }

  const manifest = manifestResult.data;
  const review = reviewResult.data;
  const visualAssessment = review.diagramAssessment;
  const enforceVisuals = !!manifest.requirements?.diagramAssessment || !!visualAssessment;
  const hasOverview = !!review.prologue.diagram?.trim();
  const hasChapterDiagrams = review.chapters.some((chapter) => !!chapter.diagram?.trim());
  if (enforceVisuals) {
    if (!visualAssessment) errors.push("review requires diagramAssessment for this snapshot");
    else {
      if (!hasOverview && !visualAssessment.overviewOmissionReason) errors.push("provide an overview diagram or overviewOmissionReason");
      if (hasOverview && visualAssessment.overviewOmissionReason) errors.push("overview diagram and overviewOmissionReason are mutually exclusive");
      if (visualAssessment.kind === "architectural" && !hasChapterDiagrams && !visualAssessment.chapterDiagramOmissionReason) {
        errors.push("architectural reviews require focused chapter diagrams or chapterDiagramOmissionReason");
      }
      if (hasChapterDiagrams && visualAssessment.chapterDiagramOmissionReason) errors.push("chapter diagrams and chapterDiagramOmissionReason are mutually exclusive");
    }
    if (hasOverview && !review.prologue.diagramItemRefs?.length) errors.push("prologue diagram requires evidence item refs");
  }
  if (manifest.runId !== review.runId) {
    errors.push(`review.runId ${review.runId} does not match manifest runId ${manifest.runId}`);
  }

  const chapterIds = new Set<string>();
  const chapterOrders = new Set<number>();
  for (const chapter of review.chapters) {
    if (chapterIds.has(chapter.id)) errors.push(`duplicate chapter id: ${chapter.id}`);
    if (chapterOrders.has(chapter.order)) errors.push(`duplicate chapter order: ${chapter.order}`);
    chapterIds.add(chapter.id);
    chapterOrders.add(chapter.order);
  }
  for (const chapter of review.chapters) {
    if (chapter.parentId === chapter.id) errors.push(`chapter ${chapter.id} cannot be its own parent`);
    if (chapter.parentId && !chapterIds.has(chapter.parentId)) {
      errors.push(`chapter ${chapter.id} has unknown parent ${chapter.parentId}`);
    }
    const ancestry = new Set([chapter.id]);
    let parentId = chapter.parentId;
    while (parentId) {
      if (ancestry.has(parentId)) {
        errors.push(`chapter hierarchy contains a cycle at ${parentId}`);
        break;
      }
      ancestry.add(parentId);
      parentId = review.chapters.find((candidate) => candidate.id === parentId)?.parentId ?? null;
    }
    const hasChildren = review.chapters.some((candidate) => candidate.parentId === chapter.id);
    if (chapter.itemRefs.length === 0 && !hasChildren) {
      errors.push(`chapter ${chapter.id} has no review items or child chapters`);
    }
  }

  const expected = new Set(manifest.files.flatMap((file) => file.items.map((item) => item.id)));
  const checkDiagramRefs = (label: string, refs: string[] | undefined, allowed: Set<string>): void => {
    const seen = new Set<string>();
    for (const ref of refs ?? []) {
      if (!allowed.has(ref)) errors.push(`${label} diagram references out-of-scope item ${ref}`);
      if (seen.has(ref)) errors.push(`${label} diagram repeats item ${ref}`);
      seen.add(ref);
    }
  };
  checkDiagramRefs("prologue", review.prologue.diagramItemRefs, expected);
  for (const chapter of review.chapters) {
    const allowed = new Set<string>();
    const visited = new Set<string>();
    const collect = (id: string): void => {
      if (visited.has(id)) return;
      visited.add(id);
      for (const candidate of review.chapters) {
        if (candidate.id === id) for (const ref of candidate.itemRefs) if (expected.has(ref)) allowed.add(ref);
        if (candidate.parentId === id) collect(candidate.id);
      }
    };
    collect(chapter.id);
    checkDiagramRefs(`chapter ${chapter.id}`, chapter.diagramItemRefs, allowed);
    if (chapter.diagram && !chapter.diagramItemRefs?.length) {
      errors.push(`chapter ${chapter.id} diagram requires evidence item refs`);
    }
  }
  const observed = new Map<string, number>();
  for (const itemRef of review.chapters.flatMap((chapter) => chapter.itemRefs)) {
    observed.set(itemRef, (observed.get(itemRef) ?? 0) + 1);
  }

  const missingItemRefs = [...expected].filter((id) => !observed.has(id)).sort();
  const duplicateItemRefs = [...observed.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort();
  const extraItemRefs = [...observed.keys()].filter((id) => !expected.has(id)).sort();

  if (missingItemRefs.length > 0) errors.push(`missing item refs: ${missingItemRefs.join(", ")}`);
  if (duplicateItemRefs.length > 0) errors.push(`duplicate item refs: ${duplicateItemRefs.join(", ")}`);
  if (extraItemRefs.length > 0) errors.push(`unknown item refs: ${extraItemRefs.join(", ")}`);

  const files = new Set(manifest.files.map((file) => file.filePath));
  for (const chapter of review.chapters) {
    for (const change of chapter.keyChanges) {
      for (const ref of change.lineRefs) {
        if (!files.has(ref.filePath)) {
          errors.push(`chapter ${chapter.id} references unknown file ${ref.filePath}`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    missingItemRefs,
    duplicateItemRefs,
    extraItemRefs,
  };
}

export function assertGeneratedReview(
  manifest: ReviewManifest,
  reviewInput: unknown,
): GeneratedReview {
  const result = validateGeneratedReview(manifest, reviewInput);
  if (!result.valid) {
    throw new Error(`Generated review validation failed:\n${result.errors.join("\n")}`);
  }
  return generatedReviewSchema.parse(reviewInput);
}
