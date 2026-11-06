import { SLOT_ATTRIBUTE } from "iterbar";

/** Attributes for the element that wraps a slot's rendered version, such as `{ "data-iterbar-slot": "pricing" }`. */
export function slotRootAttributes(slot: string): { readonly [SLOT_ATTRIBUTE]: string } {
  return { [SLOT_ATTRIBUTE]: slot };
}

/** Marks `element` as the root of `slot`; returns a function that removes the mark it set. */
export function markSlotRoot(element: Element, slot: string): () => void {
  element.setAttribute(SLOT_ATTRIBUTE, slot);
  return () => {
    if (element.getAttribute(SLOT_ATTRIBUTE) === slot) element.removeAttribute(SLOT_ATTRIBUTE);
  };
}

const ELEMENT_NODE = 1;

/**
 * Attribute on the boundary nodes of a slot range, `start` or `end`. A range skips every node between a
 * nested range's boundaries, so each element belongs to the innermost slot whose range contains it.
 */
export const SLOT_BOUNDARY_ATTRIBUTE = "data-iterbar-slot-boundary";

/** Attributes for the first (`start`) or last (`end`) boundary node of a slot range. */
export function slotBoundaryAttributes(edge: "start" | "end"): { readonly [SLOT_BOUNDARY_ATTRIBUTE]: string } {
  return { [SLOT_BOUNDARY_ATTRIBUTE]: edge };
}

function boundaryEdge(node: Node): string | null {
  return node.nodeType === ELEMENT_NODE ? (node as Element).getAttribute(SLOT_BOUNDARY_ATTRIBUTE) : null;
}

/** The elements a range owns: its top-level elements outside nested ranges, without templates. */
function rangeElements(start: Node, end: Node): Set<Element> {
  const owned = new Set<Element>();
  if (!start.parentNode || start.parentNode !== end.parentNode) return owned;
  let depth = 0;
  for (let node = start.nextSibling; node && node !== end; node = node.nextSibling) {
    const edge = boundaryEdge(node);
    if (edge === "start") depth += 1;
    else if (edge === "end") depth = Math.max(0, depth - 1);
    else if (depth === 0 && node.nodeType === ELEMENT_NODE && (node as Element).localName !== "template") {
      owned.add(node as Element);
    }
  }
  return owned;
}

const DOCUMENT_NODE = 9;
const DOCUMENT_FRAGMENT_NODE = 11;

/** A document or shadow root: every later move of a range inside it is a mutation in its own tree. */
function isTreeRoot(node: Node): boolean {
  return node.nodeType === DOCUMENT_NODE || (node.nodeType === DOCUMENT_FRAGMENT_NODE && "host" in node);
}

/** Stops marking a slot range and removes the marks it set. */
export interface SlotRange {
  (): void;
  /**
   * Finds where the range lives now, observes that tree and marks the range again. Needed only after a
   * range whose boundaries were removed on their own is inserted into a shadow tree, which no observer sees.
   */
  refresh(): void;
}

/**
 * Marks every element between the sibling nodes `start` and `end` (exclusive) as a root of `slot`, and keeps
 * the marks current while elements in that range are added, removed or replaced. It observes the range's
 * root node (its document, a shadow root or a detached fragment) and follows the range into each tree it
 * moves to. While detached it also observes its document, so inserting it there is noticed; inserting a
 * range whose boundaries were removed on their own into a shadow root is not visible to any observer, so call
 * the returned function's `refresh()` afterwards. `<template>` elements are skipped, so the boundaries
 * themselves can be templates, which HTML and React allow inside `<p>`, `<ul>`, `<table>`, `<tbody>` and
 * `<tr>`. Text nodes cannot carry the attribute and are left unmarked.
 *
 * Ranges may nest: when `start` and `end` carry {@link slotBoundaryAttributes}, an enclosing range skips the
 * nodes between them, so the inner slot keeps its marks whichever range marks or updates first. Calling the
 * returned function stops observing and removes the marks it set.
 */
export function markSlotRange(start: Node, end: Node, slot: string): SlotRange {
  const marked = new Set<Element>();
  const unmark = (element: Element) => {
    if (element.getAttribute(SLOT_ATTRIBUTE) === slot) element.removeAttribute(SLOT_ATTRIBUTE);
    marked.delete(element);
  };
  let root: Node | null = null;
  let parent: ParentNode | null = null;
  let live = true;
  const Observer = (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
  const observer =
    typeof Observer === "function"
      ? new Observer((records) => {
          // Each callback costs one root lookup and a scan of its records; the range is re-marked only when
          // it moved to another tree or parent, or its parent's children changed.
          if (bind() || start.parentNode !== parent || records.some((record) => record.target === parent)) mark();
        })
      : null;
  /** Observes the tree the range is in now; returns whether that tree changed. */
  const bind = () => {
    const current = start.getRootNode();
    if (current === root) return false;
    root = current;
    if (observer) {
      observer.disconnect();
      observer.observe(current, { childList: true, subtree: true });
      const document = start.ownerDocument;
      if (!isTreeRoot(current) && document) observer.observe(document, { childList: true, subtree: true });
    }
    return true;
  };
  const mark = () => {
    parent = start.parentNode;
    const current = rangeElements(start, end);
    for (const element of marked) if (!current.has(element)) unmark(element);
    for (const element of current) {
      element.setAttribute(SLOT_ATTRIBUTE, slot);
      marked.add(element);
    }
  };
  bind();
  mark();
  const dispose = () => {
    live = false;
    observer?.disconnect();
    for (const element of marked) unmark(element);
  };
  return Object.assign(dispose, {
    refresh() {
      if (!live) return;
      bind();
      mark();
    },
  });
}
