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
  // Every other pair keeps its exact text: the daemon files reports by the exact URL.
  expect(reportPageUrl("http://localhost:5173/a?q=a%20b&flag&iterbar=pricing:v2&x=1&x=2&q=c+d"))
    .toBe("http://localhost:5173/a?q=a%20b&flag&x=1&x=2&q=c+d");
  expect(reportPageUrl("http://localhost:5173/a?%69terbar=hero:b&iterbar&flag=")).toBe("http://localhost:5173/a?flag=");
  expect(reportPageUrl("http://localhost:5173/a?iterbar=pricing:v2#top")).toBe("http://localhost:5173/a");
  for (const unchanged of ["/a?x=1&&y=2", "/a?&x=1&", "/a??tenant=acme", "/a?q=%3F"]) {
    expect(reportPageUrl(`http://localhost:5173${unchanged}#frag`)).toBe(`http://localhost:5173${unchanged}`);
  }
  expect(reportPageUrl("http://localhost:5173/a?iterbar=x:y&?tenant=acme")).toBe("http://localhost:5173/a??tenant=acme");
  // A bare "?" files like no query, as the URL after switching a version there and removing iterbar does.
  for (const same of ["/a?", "/a?iterbar=pricing:v2", "/a?iterbar=pricing:v2&"]) {
    expect(reportPageUrl(`http://localhost:5173${same}`)).toBe("http://localhost:5173/a");
  }
});
