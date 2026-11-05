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
