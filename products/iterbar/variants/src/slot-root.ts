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

/** A live range as its tree's shared observer sees it. */
interface TrackedRange {
  readonly start: Node;
  /** The parent the range is indexed under in its tree. */
  parent: Node | null;
  /** The tree the range is in; `null` once disposed. */
  tree: Tree | null;
  /** Moves the range to the tree it is in now and marks it again. */
  update(): void;
}

/**
 * One document, shadow root or detached root node, observed once for every range in it. A batch reaches a
 * range only when it changes the range's parent's children or moves the range to another tree.
 */
interface Tree {
  readonly root: Node;
  readonly ranges: Set<TrackedRange>;
  readonly byParent: Map<Node, Set<TrackedRange>>;
  /** For a document: its detached trees with ranges, re-checked on each of its batches. */
  readonly detached: Set<Tree>;
  /** For a detached tree: its document's tree, which observes the document on its behalf. */
  document: Tree | null;
  observer: MutationObserver | null;
}

const trees = new Map<Node, Tree>();

function treeFor(root: Node): Tree {
  const existing = trees.get(root);
  if (existing) return existing;
  const tree: Tree = { root, ranges: new Set(), byParent: new Map(), detached: new Set(), document: null, observer: null };
  trees.set(root, tree);
  const Observer = (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
  if (typeof Observer === "function") {
    tree.observer = new Observer((records) => dispatch(tree, records));
    tree.observer.observe(root, { childList: true, subtree: true });
  }
  const document = root.ownerDocument;
  if (!isTreeRoot(root) && document) {
    tree.document = treeFor(document);
    tree.document.detached.add(tree);
  }
  return tree;
}

/** Stops observing a tree that no range and no detached tree depends on. */
function release(tree: Tree): void {
  if (tree.ranges.size > 0 || tree.detached.size > 0) return;
  tree.observer?.disconnect();
  trees.delete(tree.root);
  if (tree.document) {
    tree.document.detached.delete(tree);
    release(tree.document);
  }
}

/**
 * Updates only the ranges a batch can affect. A batch costs one step per record plus one per range under
 * each changed parent; a range leaves its tree only when it or an ancestor is removed, so only a batch that
 * removes a node with descendants checks the tree's ranges. Every batch of a document checks the ranges of
 * its detached trees, which can be inserted or reassembled elsewhere by its insertions or removals.
 */
function dispatch(tree: Tree, records: readonly MutationRecord[]): void {
  const targets = new Set<Node>();
  let removedSubtree = false;
  for (const record of records) {
    targets.add(record.target);
    removedSubtree ||= [...record.removedNodes].some((node) => node.hasChildNodes());
  }
  const affected = new Set<TrackedRange>();
  for (const target of targets) for (const range of tree.byParent.get(target) ?? []) affected.add(range);
  if (removedSubtree) for (const range of tree.ranges) if (range.start.getRootNode() !== tree.root) affected.add(range);
  for (const detached of tree.detached) {
    for (const range of detached.ranges) if (range.start.getRootNode() !== detached.root) affected.add(range);
  }
  for (const range of affected) range.update();
}

function join(range: TrackedRange, root: Node): void {
  range.tree = treeFor(root);
  range.tree.ranges.add(range);
}

/** Indexes the range under `parent` in its tree, replacing the previous parent. */
function reindex(range: TrackedRange, parent: Node | null): void {
  const { tree } = range;
  if (!tree) return;
  const previous = range.parent ? tree.byParent.get(range.parent) : undefined;
  previous?.delete(range);
  if (previous?.size === 0 && range.parent) tree.byParent.delete(range.parent);
  range.parent = parent;
  if (!parent) return;
  const ranges = tree.byParent.get(parent) ?? new Set<TrackedRange>();
  ranges.add(range);
  tree.byParent.set(parent, ranges);
}

function leave(range: TrackedRange): void {
  const { tree } = range;
  if (!tree) return;
  reindex(range, null);
  tree.ranges.delete(range);
  range.tree = null;
  release(tree);
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
 * the marks current while elements in that range are added, removed or replaced. Every range in one tree
 * (a document, a shadow root or a detached fragment) shares one observer of that tree, which updates only
 * the ranges a change reaches, and a range follows each tree it moves to. While detached, a range is also
 * noticed when it is inserted into its document; inserting a range whose boundaries were removed on their
 * own into a shadow root is not visible to any observer, so call the returned function's `refresh()`
 * afterwards. `<template>` elements are skipped, so the boundaries themselves can be templates, which HTML
 * and React allow inside `<p>`, `<ul>`, `<table>`, `<tbody>` and `<tr>`. Text nodes cannot carry the
 * attribute and are left unmarked.
 *
 * Ranges may nest: when `start` and `end` carry {@link slotBoundaryAttributes}, an enclosing range skips the
 * nodes between them, so the inner slot keeps its marks whichever range marks or updates first. Calling the
 * returned function stops observing and removes the marks it set; call it once the range is no longer
 * needed, because a live range keeps its tree observed and its nodes reachable.
 */
export function markSlotRange(start: Node, end: Node, slot: string): SlotRange {
  const marked = new Set<Element>();
  const unmark = (element: Element) => {
    if (element.getAttribute(SLOT_ATTRIBUTE) === slot) element.removeAttribute(SLOT_ATTRIBUTE);
    marked.delete(element);
  };
  const range: TrackedRange = {
    start,
    parent: null,
    tree: null,
    update() {
      const previous = range.tree;
      if (!previous) return;
      const root = start.getRootNode();
      if (root !== previous.root) {
        reindex(range, null);
        previous.ranges.delete(range);
        join(range, root);
        release(previous);
      }
      if (start.parentNode !== range.parent) reindex(range, start.parentNode);
      const current = rangeElements(start, end);
      for (const element of marked) if (!current.has(element)) unmark(element);
      for (const element of current) {
        element.setAttribute(SLOT_ATTRIBUTE, slot);
        marked.add(element);
      }
    },
  };
  join(range, start.getRootNode());
  range.update();
  const dispose = () => {
    leave(range);
    for (const element of marked) unmark(element);
  };
  return Object.assign(dispose, { refresh: () => range.update() });
}
