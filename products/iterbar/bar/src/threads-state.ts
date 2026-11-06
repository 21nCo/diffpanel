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

/**
 * Applies a complete listing from the daemon. The listing is the daemon's whole state, so an item it does not include
 * is dropped, unless an event delivered it while the listing was in flight (`touched`): that item, and any listed copy
 * of it, may be older than what the event showed, even with an equal `updatedAt`, so the held copy wins. Returns
 * whether anything changed.
 */
export function applyListing(current: Map<string, Feedback>, listed: readonly Feedback[], touched: ReadonlySet<string>): boolean {
  const next = new Map<string, Feedback>();
  for (const item of listed) {
    const held = current.get(item.id);
    const keepHeld = held !== undefined
      && (touched.has(item.id) || Date.parse(held.updatedAt) > Date.parse(item.updatedAt));
    next.set(item.id, keepHeld ? held : item);
  }
  for (const id of touched) {
    const held = current.get(id);
    if (held && !next.has(id)) next.set(id, held);
  }
  let changed = next.size !== current.size;
  for (const [id, item] of next) {
    if (!changed && JSON.stringify(current.get(id)) !== JSON.stringify(item)) changed = true;
  }
  current.clear();
  for (const [id, item] of next) current.set(id, item);
  return changed;
}

/** Newest first by creation, so an item's place never changes once it is shown; ties by id. */
export function threadOrder(items: Iterable<Feedback>): Feedback[] {
  return [...items].sort((left, right) =>
    Date.parse(right.createdAt) - Date.parse(left.createdAt) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}
