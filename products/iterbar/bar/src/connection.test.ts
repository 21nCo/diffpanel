import { describe, expect, it } from "vitest";
import { parseDaemonConfig } from "./connection.js";

const token = "a".repeat(64);

describe("parseDaemonConfig", () => {
  it("accepts the daemon's loopback origin and normalizes a trailing slash", () => {
    expect(parseDaemonConfig("http://127.0.0.1:4555/", token)).toEqual({ ok: true, config: { url: "http://127.0.0.1:4555", token } });
  });

  it("reports nothing configured separately from a bad configuration", () => {
    expect(parseDaemonConfig(null, null)).toEqual({ ok: false, status: { kind: "unconfigured" } });
    expect(parseDaemonConfig("", "")).toEqual({ ok: false, status: { kind: "unconfigured" } });
  });

  it("never sends the token anywhere but 127.0.0.1", () => {
    for (const url of [
      "http://localhost:4555", "https://127.0.0.1:4555", "http://127.0.0.1", "http://127.0.0.1:4555/events",
      "http://127.0.0.1:4555/?x=1", "http://user:pw@127.0.0.1:4555", "http://evil.example:4555", "nonsense",
    ]) {
      expect(parseDaemonConfig(url, token)).toMatchObject({ ok: false, status: { kind: "invalid" } });
    }
  });

  it("refuses a malformed token", () => {
    expect(parseDaemonConfig("http://127.0.0.1:4555", "A".repeat(64))).toMatchObject({ ok: false, status: { kind: "invalid" } });
    expect(parseDaemonConfig("http://127.0.0.1:4555", null)).toMatchObject({ ok: false, status: { kind: "invalid" } });
  });
});
