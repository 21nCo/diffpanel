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

/**
 * Marks every element between the sibling nodes `start` and `end` (exclusive) as a root of `slot`, and keeps
 * the marks current while elements in that range are added, removed or replaced, also after the range moves
 * to another parent. `<template>` elements are
 * skipped, so the boundaries themselves can be templates, which HTML and React allow inside `<p>`, `<ul>`,
 * `<table>`, `<tbody>` and `<tr>`. Text nodes cannot carry the attribute and are left unmarked.
 *
 * Ranges may nest: when `start` and `end` carry {@link slotBoundaryAttributes}, an enclosing range skips the
 * nodes between them, so the inner slot keeps its marks whichever range marks or updates first. Returns a
 * function that stops observing and removes the marks it set.
 */
export function markSlotRange(start: Node, end: Node, slot: string): () => void {
  const marked = new Set<Element>();
  const unmark = (element: Element) => {
    if (element.getAttribute(SLOT_ATTRIBUTE) === slot) element.removeAttribute(SLOT_ATTRIBUTE);
    marked.delete(element);
  };
  const Observer = (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
  const observer = typeof Observer === "function" ? new Observer(() => update()) : null;
  let observed: Node | null = null;
  const update = () => {
    // Follow the range when it moves to another parent, such as when its DocumentFragment is inserted.
    const parent = start.parentNode;
    if (observer && parent && parent !== observed) {
      observer.disconnect();
      observer.observe(parent, { childList: true });
      observed = parent;
    }
    const current = rangeElements(start, end);
    for (const element of marked) if (!current.has(element)) unmark(element);
    for (const element of current) {
      element.setAttribute(SLOT_ATTRIBUTE, slot);
      marked.add(element);
    }
  };
  update();
  return () => {
    observer?.disconnect();
    for (const element of marked) unmark(element);
  };
}
