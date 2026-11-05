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
 * Marks every element between the sibling nodes `start` and `end` (exclusive) as a root of `slot`, and keeps
 * the marks current while elements in that range are added, removed or replaced. `<template>` elements are
 * skipped, so the boundaries themselves can be templates, which HTML and React allow inside `<p>`, `<ul>`,
 * `<table>`, `<tbody>` and `<tr>`. Text nodes cannot carry the attribute and are left unmarked. Returns a
 * function that stops observing and removes the marks it set.
 */
export function markSlotRange(start: Node, end: Node, slot: string): () => void {
  const marked = new Set<Element>();
  const unmark = (element: Element) => {
    if (element.getAttribute(SLOT_ATTRIBUTE) === slot) element.removeAttribute(SLOT_ATTRIBUTE);
    marked.delete(element);
  };
  const update = () => {
    const current = new Set<Element>();
    if (start.parentNode && start.parentNode === end.parentNode) {
      for (let node = start.nextSibling; node && node !== end; node = node.nextSibling) {
        const element = node as Element;
        if (node.nodeType === ELEMENT_NODE && element.localName !== "template") current.add(element);
      }
    }
    for (const element of [...marked]) if (!current.has(element)) unmark(element);
    for (const element of current) {
      element.setAttribute(SLOT_ATTRIBUTE, slot);
      marked.add(element);
    }
  };
  update();
  const parent = start.parentNode;
  const Observer = (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
  let observer: MutationObserver | null = null;
  if (parent && typeof Observer === "function") {
    observer = new Observer(update);
    observer.observe(parent, { childList: true });
  }
  return () => {
    observer?.disconnect();
    for (const element of [...marked]) unmark(element);
  };
}
