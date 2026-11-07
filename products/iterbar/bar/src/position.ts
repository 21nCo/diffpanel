/** Local storage key, per origin, holding where the bar sits and whether it is collapsed. */
export const BAR_STATE_STORAGE_KEY = "iterbar:bar";

export type Edge = "top" | "right" | "bottom" | "left";

const EDGES: readonly Edge[] = ["top", "right", "bottom", "left"];

/** Where the bar sits: the screen edge it is docked to and how far along that edge, from 0 (start) to 1 (end). */
export interface BarPlacement {
  readonly edge: Edge;
  readonly offset: number;
}

export interface BarState extends BarPlacement {
  readonly collapsed: boolean;
}

/** Gap, in CSS pixels, the bar keeps from the screen edges; the stylesheet's `--ib-margin`. */
export const BAR_MARGIN_PX = 12;

/** Bottom right, expanded. */
export const DEFAULT_BAR_STATE: BarState = Object.freeze({ edge: "bottom", offset: 1, collapsed: false });

function clampOffset(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Reads a stored state; anything malformed falls back field by field to {@link DEFAULT_BAR_STATE}. Never throws. */
export function parseBarState(text: string | null | undefined): BarState {
  let value: unknown;
  try {
    value = JSON.parse(text ?? "null");
  } catch {
    return DEFAULT_BAR_STATE;
  }
  if (typeof value !== "object" || value === null) return DEFAULT_BAR_STATE;
  const { edge, offset, collapsed } = value as Record<string, unknown>;
  return {
    edge: EDGES.includes(edge as Edge) ? edge as Edge : DEFAULT_BAR_STATE.edge,
    offset: typeof offset === "number" && Number.isFinite(offset) ? clampOffset(offset) : DEFAULT_BAR_STATE.offset,
    collapsed: typeof collapsed === "boolean" ? collapsed : DEFAULT_BAR_STATE.collapsed,
  };
}

export function formatBarState(state: BarState): string {
  return JSON.stringify({ edge: state.edge, offset: clampOffset(state.offset), collapsed: state.collapsed });
}

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where a bar dropped with its box at `box` docks in a `viewport` of the given size: the edge nearest to the box's
 * centre, and the box's position along that edge as a fraction of the room it can move in between the
 * {@link BAR_MARGIN_PX} margins, which is how the stylesheet turns the offset back into a position.
 */
export function placementForDrop(box: Rect, viewport: { readonly width: number; readonly height: number }): BarPlacement {
  const centerX = box.left + box.width / 2;
  const centerY = box.top + box.height / 2;
  const distances: Record<Edge, number> = {
    top: centerY,
    bottom: viewport.height - centerY,
    left: centerX,
    right: viewport.width - centerX,
  };
  const edge = EDGES.reduce((best, candidate) => (distances[candidate] < distances[best] ? candidate : best));
  const horizontal = edge === "top" || edge === "bottom";
  const room = (horizontal ? viewport.width - box.width : viewport.height - box.height) - 2 * BAR_MARGIN_PX;
  const position = (horizontal ? box.left : box.top) - BAR_MARGIN_PX;
  return { edge, offset: room > 0 ? clampOffset(position / room) : 0 };
}

/** The edge an arrow key moves the bar to, or `null` for any other key. */
export function edgeForKey(key: string): Edge | null {
  switch (key) {
    case "ArrowUp": return "top";
    case "ArrowRight": return "right";
    case "ArrowDown": return "bottom";
    case "ArrowLeft": return "left";
    default: return null;
  }
}
