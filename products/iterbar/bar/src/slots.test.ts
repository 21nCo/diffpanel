import { describe, expect, it } from "vitest";
import { reportPageUrl, searchWithSelection } from "./slots.js";

describe("searchWithSelection", () => {
  it("adds the slot when the URL does not name it, keeping every other parameter verbatim", () => {
    expect(searchWithSelection("?q=a%20b&x", "pricing", "v2")).toBe("?q=a%20b&x&iterbar=pricing:v2");
    expect(searchWithSelection("", "pricing", "v2")).toBe("?iterbar=pricing:v2");
  });

  it("replaces the slot's entry in place and keeps other slots", () => {
    expect(searchWithSelection("?iterbar=hero:b,pricing:v1&q=1", "pricing", "v2")).toBe("?iterbar=hero:b,pricing:v2&q=1");
    expect(searchWithSelection("?iterbar=hero:b", "pricing", "v2")).toBe("?iterbar=hero:b,pricing:v2");
  });

  it("drops malformed entries as the registry does", () => {
    expect(searchWithSelection("?iterbar=bad,pricing:v1", "pricing", "v3")).toBe("?iterbar=pricing:v3");
  });
});

it("files slot reports without the fragment or the iterbar parameter", () => {
  expect(reportPageUrl("http://localhost:5173/a?q=1&iterbar=pricing:v2#top")).toBe("http://localhost:5173/a?q=1");
  expect(reportPageUrl("not a url")).toBeNull();
});
