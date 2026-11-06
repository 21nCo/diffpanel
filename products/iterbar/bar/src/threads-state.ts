import type { Feedback } from "iterbar";

/**
 * Adds or replaces items by id. A listing and an event can arrive in either order, so an item only replaces the one
 * held when it is at least as recent (`updatedAt`); an older copy of an item is dropped. Returns whether anything
 * changed.
 */
export function mergeFeedback(current: Map<string, Feedback>, incoming: readonly Feedback[]): boolean {
  let changed = false;
  for (const item of incoming) {
    const held = current.get(item.id);
    if (held && Date.parse(held.updatedAt) > Date.parse(item.updatedAt)) continue;
    if (held && JSON.stringify(held) === JSON.stringify(item)) continue;
    current.set(item.id, item);
    changed = true;
  }
  return changed;
}

/** Newest first by creation, so an item's place never changes once it is shown; ties by id. */
export function threadOrder(items: Iterable<Feedback>): Feedback[] {
  return [...items].sort((left, right) =>
    Date.parse(right.createdAt) - Date.parse(left.createdAt) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}
