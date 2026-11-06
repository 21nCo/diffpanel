import { describe, expect, it } from "vitest";
import { DEFAULT_BAR_STATE, edgeForKey, formatBarState, parseBarState, placementForDrop } from "./position.js";

describe("stored bar state", () => {
  it("round-trips a valid state", () => {
    const state = { edge: "left", offset: 0.25, collapsed: true } as const;
    expect(parseBarState(formatBarState(state))).toEqual(state);
  });

  it("falls back field by field for malformed values", () => {
    expect(parseBarState(null)).toEqual(DEFAULT_BAR_STATE);
    expect(parseBarState("{not json")).toEqual(DEFAULT_BAR_STATE);
    expect(parseBarState("[]")).toEqual(DEFAULT_BAR_STATE);
    expect(parseBarState(JSON.stringify({ edge: "middle", offset: "0.5", collapsed: 1 }))).toEqual(DEFAULT_BAR_STATE);
    expect(parseBarState(JSON.stringify({ edge: "top", offset: 7 }))).toEqual({ edge: "top", offset: 1, collapsed: false });
    expect(parseBarState(JSON.stringify({ offset: -3, collapsed: true }))).toEqual({ edge: "bottom", offset: 0, collapsed: true });
  });
});

describe("placementForDrop", () => {
  const viewport = { width: 1000, height: 800 };
  const box = (left: number, top: number) => ({ left, top, width: 200, height: 100 });

  it("docks to the nearest edge with the position along it", () => {
    expect(placementForDrop(box(400, 10), viewport)).toEqual({ edge: "top", offset: 0.5 });
    expect(placementForDrop(box(800, 690), viewport)).toEqual({ edge: "bottom", offset: 1 });
    expect(placementForDrop(box(0, 350), viewport)).toEqual({ edge: "left", offset: 0.5 });
    expect(placementForDrop(box(800, 350), viewport)).toEqual({ edge: "right", offset: 0.5 });
  });

  it("clamps a box dragged past the viewport and handles a box wider than it", () => {
    expect(placementForDrop(box(-100, 760), viewport)).toEqual({ edge: "bottom", offset: 0 });
    expect(placementForDrop({ left: 0, top: 0, width: 1200, height: 50 }, viewport)).toEqual({ edge: "top", offset: 0 });
  });
});

it("maps arrow keys to edges", () => {
  expect(["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft", "Enter"].map(edgeForKey))
    .toEqual(["top", "right", "bottom", "left", null]);
});
