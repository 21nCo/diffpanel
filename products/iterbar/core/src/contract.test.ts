import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  activeVariantsSchema,
  attachmentRefSchema,
  bearerAuthorization,
  boundingBoxSchema,
  daemonErrorResponseSchema,
  daemonEventSchema,
  daemonInfoSchema,
  daemonPath,
  evidenceRefSchema,
  evidenceWindowSchema,
  feedbackDraftSchema,
  feedbackListQuerySchema,
  feedbackListResponseSchema,
  feedbackSchema,
  feedbackTargetSchema,
  formatSourceLocation,
  formatVariantParam,
  InvalidMessageError,
  isIterbarContractError,
  IterbarContractError,
  PAGE_API_GLOBAL,
  parseMessage,
  parseMessageJson,
  parseSourceLocation,
  parseVariantParam,
  readPageApi,
  registerOriginsRequestSchema,
  registerOriginsResponseSchema,
  registrySnapshotSchema,
  replyRequestSchema,
  replySchema,
  safeParseMessage,
  slotListResponseSchema,
  slotReportSchema,
  slotStateSchema,
  sourceLocationSchema,
  statusRequestSchema,
  storeLockSchema,
  tokenFromAuthorization,
  tokenFromWebSocketProtocols,
  UnsupportedSchemaVersionError,
  variantSelectionSchema,
  webSocketProtocols,
  WEBSOCKET_SUBPROTOCOL,
} from "./index.js";

const token = "0123456789abcdef".repeat(4);
const digest = "f".repeat(64);
const createdAt = "2026-11-03T10:00:30.000Z";
const updatedAt = "2026-11-03T10:05:00.000Z";
const screenshot = { id: "at_0001", kind: "screenshot", mediaType: "image/png", byteLength: 2048, sha256: digest } as const;
const evidenceAttachment = { id: "at_0002", kind: "evidence", mediaType: "application/json", byteLength: 512, sha256: digest } as const;
const evidenceWindow = { start: "2026-11-03T10:00:00.000Z", end: "2026-11-03T10:00:35.000Z", eventCount: 4 };
const sourceLocation = { path: "src/routes/Pricing.tsx", line: 12, column: 5 };
const boundingBox = { x: 16, y: -40, width: 320, height: 48 };
const target = { selector: "[data-testid=\"buy\"]", textExcerpt: "Buy now", boundingBox, sourceLocation };
const reply = { id: "rp_0001", author: { kind: "agent", name: "Claude Code" }, text: "Working on it.", createdAt: updatedAt };
const comment = {
  schemaVersion: 1,
  id: "fb_0001",
  kind: "comment",
  text: "Make the button larger.",
  pageUrl: "http://localhost:5173/pricing?iterbar=pricing:v2",
  target,
  activeVariants: [{ slot: "pricing", version: "v2" }],
  screenshot,
  screenshotUnavailableReason: null,
  evidence: { window: evidenceWindow, attachment: evidenceAttachment },
  replies: [reply],
  status: "working",
  createdAt,
  updatedAt,
};
const chooseVariant = {
  ...comment,
  id: "fb_0002",
  kind: "choose_variant",
  text: "",
  choice: { slot: "pricing", version: "v2" },
  target: null,
  screenshot: null,
  evidence: null,
  replies: [],
  status: "open",
  updatedAt: createdAt,
};
const draft = {
  schemaVersion: 1,
  kind: "comment",
  text: "Too much padding.",
  pageUrl: "http://localhost:5173/",
  target,
  activeVariants: [],
  screenshotUnavailableReason: "Screenshot exceeded 4 MP",
  evidenceWindow,
};
const slotState = { slot: "pricing", versions: ["v1", "v2"], defaultVersion: "v1", activeVersion: "v2", mounts: 2 };
const snapshot = {
  schemaVersion: 1,
  slots: [slotState],
  warnings: [{ code: "unknown_version", source: "url", value: "pricing:v9", message: "pricing has no version v9; using v1" }],
};
const slotReport = { schemaVersion: 1, pageUrl: "http://localhost:5173/pricing", reportedAt: createdAt, slots: [slotState] };
const daemonInfo = {
  schemaVersion: 1,
  host: "127.0.0.1",
  port: 47_123,
  token,
  pid: 4242,
  projectRoot: "/Users/dev/app",
  startedAt: createdAt,
};

interface Case {
  readonly name: string;
  readonly schema: z.ZodType;
  readonly valid: unknown;
  readonly invalid: unknown;
  /** Top-level messages carry schemaVersion and get the unknown-version check. */
  readonly versioned: boolean;
}

const cases: Case[] = [
  { name: "feedback (comment)", schema: feedbackSchema, valid: comment, invalid: { ...comment, text: "   " }, versioned: true },
  {
    name: "feedback (choose_variant)",
    schema: feedbackSchema,
    valid: chooseVariant,
    invalid: { ...chooseVariant, choice: undefined },
    versioned: true,
  },
  {
    name: "feedback draft",
    schema: feedbackDraftSchema,
    valid: draft,
    invalid: { ...draft, target: { ...target, textExcerpt: "x".repeat(201) } },
    versioned: true,
  },
  { name: "feedback target", schema: feedbackTargetSchema, valid: target, invalid: { ...target, selector: "" }, versioned: false },
  {
    name: "source location",
    schema: sourceLocationSchema,
    valid: sourceLocation,
    invalid: { ...sourceLocation, path: "src/../../etc/passwd" },
    versioned: false,
  },
  { name: "bounding box", schema: boundingBoxSchema, valid: boundingBox, invalid: { ...boundingBox, width: -1 }, versioned: false },
  {
    name: "attachment reference",
    schema: attachmentRefSchema,
    valid: screenshot,
    invalid: { ...screenshot, mediaType: "application/json" },
    versioned: false,
  },
  {
    name: "evidence window",
    schema: evidenceWindowSchema,
    valid: evidenceWindow,
    invalid: { ...evidenceWindow, end: "2026-11-03T09:59:59.000Z" },
    versioned: false,
  },
  {
    name: "evidence reference",
    schema: evidenceRefSchema,
    valid: { window: evidenceWindow, attachment: evidenceAttachment },
    invalid: { window: evidenceWindow, attachment: screenshot },
    versioned: false,
  },
  { name: "reply", schema: replySchema, valid: reply, invalid: { ...reply, id: "../rp_0001" }, versioned: false },
  {
    name: "active variants",
    schema: activeVariantsSchema,
    valid: comment.activeVariants,
    invalid: [{ slot: "pricing", version: "v1" }, { slot: "pricing", version: "v2" }],
    versioned: false,
  },
  { name: "slot state", schema: slotStateSchema, valid: slotState, invalid: { ...slotState, activeVersion: "v3" }, versioned: false },
  {
    name: "registry snapshot",
    schema: registrySnapshotSchema,
    valid: snapshot,
    invalid: { ...snapshot, slots: [slotState, slotState] },
    versioned: true,
  },
  {
    name: "variant selection",
    schema: variantSelectionSchema,
    valid: { schemaVersion: 1, slot: "pricing", version: "v2" },
    invalid: { schemaVersion: 1, slot: "pricing:v2", version: "v2" },
    versioned: true,
  },
  {
    name: "slot report",
    schema: slotReportSchema,
    valid: slotReport,
    invalid: { ...slotReport, pageUrl: "javascript:alert(1)" },
    versioned: true,
  },
  { name: "daemon.json", schema: daemonInfoSchema, valid: daemonInfo, invalid: { ...daemonInfo, host: "0.0.0.0" }, versioned: true },
  {
    name: "store lock",
    schema: storeLockSchema,
    valid: { schemaVersion: 1, pid: 4242, startedAt: createdAt },
    invalid: { schemaVersion: 1, pid: 0, startedAt: createdAt },
    versioned: true,
  },
  {
    name: "register origins request",
    schema: registerOriginsRequestSchema,
    valid: { schemaVersion: 1, origins: ["http://localhost:5173", "http://127.0.0.1:5173"] },
    invalid: { schemaVersion: 1, origins: ["http://localhost:5173/"] },
    versioned: true,
  },
  {
    name: "register origins response",
    schema: registerOriginsResponseSchema,
    valid: { schemaVersion: 1, origins: ["https://app.localhost"] },
    invalid: { schemaVersion: 1, origins: ["file:///tmp"] },
    versioned: true,
  },
  {
    name: "feedback list query",
    schema: feedbackListQuerySchema,
    valid: { status: "needs-info", kind: "comment", since: createdAt },
    invalid: { status: "closed" },
    versioned: false,
  },
  {
    name: "feedback list response",
    schema: feedbackListResponseSchema,
    valid: { schemaVersion: 1, items: [comment, chooseVariant] },
    invalid: { schemaVersion: 1, items: [{ ...comment, status: "pending" }] },
    versioned: true,
  },
  {
    name: "reply request",
    schema: replyRequestSchema,
    valid: { schemaVersion: 1, author: { kind: "user", name: null }, text: "Try v3." },
    invalid: { schemaVersion: 1, author: { kind: "user", name: null }, text: "\n" },
    versioned: true,
  },
  {
    name: "status request",
    schema: statusRequestSchema,
    valid: { schemaVersion: 1, status: "resolved" },
    invalid: { schemaVersion: 1, status: "closed" },
    versioned: true,
  },
  {
    name: "slot list response",
    schema: slotListResponseSchema,
    valid: { schemaVersion: 1, pages: [slotReport] },
    invalid: { schemaVersion: 1, pages: [{ ...slotReport, reportedAt: undefined }] },
    versioned: true,
  },
  {
    name: "daemon error response",
    schema: daemonErrorResponseSchema,
    valid: { schemaVersion: 1, error: { code: "forbidden_origin", message: "Origin not allowed" } },
    invalid: { schemaVersion: 1, error: { code: "teapot", message: "" } },
    versioned: true,
  },
  {
    name: "daemon event",
    schema: daemonEventSchema,
    valid: { schemaVersion: 1, type: "feedback.updated", feedback: comment },
    invalid: { schemaVersion: 1, type: "feedback.deleted", feedback: comment },
    versioned: true,
  },
];

describe.each(cases)("$name", ({ name, schema, valid, invalid, versioned }) => {
  it("accepts the valid fixture", () => {
    expect(parseMessage(schema, valid, name)).toEqual(valid);
  });

  it("rejects the invalid fixture with a typed error", () => {
    expect(() => parseMessage(schema, invalid, name)).toThrow(InvalidMessageError);
  });

  it.runIf(versioned)("rejects an unknown major version before reading the shape", () => {
    for (const input of [{ ...(valid as object), schemaVersion: 2 }, { schemaVersion: 2, renamedEverything: true }]) {
      const result = safeParseMessage(schema, input, name);
      expect(result.success).toBe(false);
      if (result.success) continue;
      expect(result.error).toBeInstanceOf(UnsupportedSchemaVersionError);
      expect(result.error.code).toBe("unsupported_schema_version");
      expect((result.error as UnsupportedSchemaVersionError).receivedVersion).toBe(2);
    }
  });
});

describe("schema versions", () => {
  it("treats a missing or malformed version as an invalid message, not an unknown version", () => {
    for (const schemaVersion of [undefined, "1", 1.5, 0, -1]) {
      const result = safeParseMessage(statusRequestSchema, { schemaVersion, status: "open" });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("invalid_message");
    }
  });

  it("drops unknown v1 properties so additive fields are tolerated", () => {
    const parsed = parseMessage(statusRequestSchema, { schemaVersion: 1, status: "done", note: "later field" });
    expect(parsed).toEqual({ schemaVersion: 1, status: "done" });
  });

  it("reports malformed JSON as an invalid message", () => {
    expect(() => parseMessageJson(daemonEventSchema, "{\"schemaVersion\":1,", "event")).toThrow(InvalidMessageError);
    expect(() => parseMessageJson(daemonEventSchema, JSON.stringify({ schemaVersion: 3, type: "x" }), "event"))
      .toThrow(UnsupportedSchemaVersionError);
  });

  it("recognizes contract errors from another bundle by code", () => {
    const foreign = Object.assign(new Error("copy"), { code: "unsupported_schema_version" });
    expect(isIterbarContractError(foreign)).toBe(true);
    expect(isIterbarContractError(Object.assign(new Error("other"), { code: "ENOENT" }))).toBe(false);
  });
});

describe("feedback invariants", () => {
  it("rejects a screenshot together with a reason it is unavailable", () => {
    expect(() => parseMessage(feedbackSchema, { ...comment, screenshotUnavailableReason: "failed" })).toThrow(InvalidMessageError);
  });

  it("rejects an update earlier than creation and duplicated reply ids", () => {
    expect(() => parseMessage(feedbackSchema, { ...comment, updatedAt: "2026-11-03T09:00:00.000Z" })).toThrow(/updatedAt/);
    expect(() => parseMessage(feedbackSchema, { ...comment, replies: [reply, reply] })).toThrow(/reply ids/);
  });

  it("round-trips the source location attribute and refuses paths outside the project", () => {
    expect(parseSourceLocation(formatSourceLocation(sourceLocation))).toEqual(sourceLocation);
    expect(parseSourceLocation("src/a:b.tsx:3:9")).toEqual({ path: "src/a:b.tsx", line: 3, column: 9 });
    for (const value of ["/abs/App.tsx:1:1", "../App.tsx:1:1", "src/App.tsx:0:1", "src/App.tsx:1", null]) {
      expect(parseSourceLocation(value)).toBeNull();
    }
  });
});

describe("variant URL parameter", () => {
  it("parses selections, lets a later entry win and keeps malformed entries aside", () => {
    expect(parseVariantParam(" pricing:v1,hero:b,,pricing:v2,bad,x:y:z,:v1")).toEqual({
      selections: [{ slot: "hero", version: "b" }, { slot: "pricing", version: "v2" }],
      invalid: ["bad", "x:y:z", ":v1"],
    });
    expect(parseVariantParam(null)).toEqual({ selections: [], invalid: [] });
  });

  it("formats selections and refuses names that would break the format", () => {
    expect(formatVariantParam([{ slot: "hero", version: "b" }, { slot: "pricing", version: "v2" }])).toBe("hero:b,pricing:v2");
    expect(() => formatVariantParam([{ slot: "a,b", version: "v1" }])).toThrow(InvalidMessageError);
    expect(() => formatVariantParam([{ slot: "a", version: "v1" }, { slot: "a", version: "v2" }])).toThrow(InvalidMessageError);
  });
});

describe("page API", () => {
  const api = { schemaVersion: 1, getSnapshot: () => snapshot, select: () => undefined, subscribe: () => () => undefined };

  it("returns null without a registry and the API when one is installed", () => {
    expect(readPageApi({})).toBeNull();
    expect(readPageApi({ [PAGE_API_GLOBAL]: api })).toBe(api);
  });

  it("rejects a registry from another major version or without the v1 methods", () => {
    expect(() => readPageApi({ [PAGE_API_GLOBAL]: { ...api, schemaVersion: 2 } })).toThrow(UnsupportedSchemaVersionError);
    expect(() => readPageApi({ [PAGE_API_GLOBAL]: { ...api, subscribe: undefined } })).toThrow(/subscribe/);
  });
});

describe("daemon transport", () => {
  it("fills endpoint paths with safe ids only", () => {
    expect(daemonPath("getAttachment", { feedbackId: "fb_0001", attachmentId: "at_0001" }))
      .toBe("/feedback/fb_0001/attachments/at_0001");
    expect(daemonPath("listFeedback")).toBe("/feedback");
    expect(() => daemonPath("getFeedback", { feedbackId: ".." })).toThrow(IterbarContractError);
    expect(() => daemonPath("reply", { feedbackId: "fb/../x" })).toThrow(/not a safe Iterbar id/);
    expect(() => daemonPath("setStatus")).toThrow(TypeError);
  });

  it("carries the token in an Authorization header", () => {
    expect(tokenFromAuthorization(bearerAuthorization(token))).toBe(token);
    for (const header of [undefined, `Basic ${token}`, `Bearer ${token.toUpperCase()}`, `Bearer ${token} `]) {
      expect(tokenFromAuthorization(header)).toBeNull();
    }
    expect(() => bearerAuthorization("short")).toThrow(InvalidMessageError);
  });

  it("carries the token in the WebSocket subprotocol offer", () => {
    const protocols = webSocketProtocols(token);
    expect(protocols[0]).toBe(WEBSOCKET_SUBPROTOCOL);
    expect(tokenFromWebSocketProtocols(protocols.join(", "))).toBe(token);
    expect(tokenFromWebSocketProtocols(protocols[1])).toBeNull();
    expect(tokenFromWebSocketProtocols(`${protocols.join(",")},${webSocketProtocols("1".repeat(64))[1]}`)).toBeNull();
    expect(tokenFromWebSocketProtocols(`${WEBSOCKET_SUBPROTOCOL}, iterbar.token.nothex`)).toBeNull();
  });
});
