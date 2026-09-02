import { REVIEW_TITLE_MAX_LENGTH, reviewTitleSchema, type ReviewScope } from "./schemas.js";

export function parseReviewTitle(value: string): string {
  const result = reviewTitleSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Review title must be 1 to ${REVIEW_TITLE_MAX_LENGTH} characters.`);
  }
  return result.data;
}

export function titleForScope(scope: ReviewScope): string {
  if (scope.type === "worktree") return "Working tree";
  if (scope.type === "staged") return "Staged changes";
  if (scope.type === "range") return scope.expression;
  return `Repository at ${scope.ref}`;
}

export function displayReviewTitle(title: string | null | undefined, scope: ReviewScope): string {
  return title?.trim() || titleForScope(scope);
}
