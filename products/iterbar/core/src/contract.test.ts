import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as api from "./index.js";
import {
  bearerAuthorization,
  absolutePathSchema,
  assertSafeId,
  daemonEventSchema,
  daemonInfoSchema,
  daemonPath,
  feedbackListResponseSchema,
  feedbackSchema,
  formatSourceLocation,
  formatVariantParam,
  InvalidMessageError,
  isAbsolutePath,
  isIterbarContractError,
  IterbarContractError,
  MAX_ATTACHMENT_BYTES,
  PAGE_API_GLOBAL,
  parseMessage,
  parseMessageJson,
  parseSourceLocation,
  parseVariantParam,
  readPageApi,
  safeParseMessage,
  sourceLocationSchema,
  statusRequestSchema,
  tokenFromAuthorization,
  tokenFromWebSocketProtocols,
  UnsupportedSchemaVersionError,
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

const warning = snapshot.warnings[0];
const draftChoice = { ...draft, kind: "choose_variant", text: "", choice: { slot: "pricing", version: "v2" } };

type SchemaName = Extract<keyof typeof api, `${string}Schema`>;

interface Case {
  /** The root-entry export under test. */
  readonly schema: SchemaName;
  /** Distinguishes several cases for one schema, such as union branches. */
  readonly variant?: string;
  readonly valid: unknown;
  readonly invalid: unknown;
  /** Dot-joined path every reported issue must sit on (or under); `""` is the value itself. */
  readonly path: string;
  /** Message of the issue at `path`, when the path alone does not pin the failing rule. */
  readonly message?: RegExp;
}

const cases: Case[] = [
  // primitives
  { schema: "schemaVersionSchema", valid: 1, invalid: "1", path: "" },
  { schema: "idSchema", valid: "fb_0001", invalid: "_fb_0001", path: "", message: /starting with a letter or digit/ },
  { schema: "slotNameSchema", valid: "pricing.hero", invalid: "pricing:v2", path: "", message: /1-64 letters/ },
  { schema: "versionNameSchema", valid: "v2-b", invalid: "v,2", path: "", message: /1-64 letters/ },
  { schema: "timestampSchema", valid: "2026-11-03T10:00:30+02:00", invalid: "2026-11-03 10:00:30", path: "" },
  { schema: "pageUrlSchema", valid: "https://app.localhost/pricing", invalid: "javascript:alert(1)", path: "" },
  { schema: "originSchema", valid: "http://localhost:5173", invalid: "http://localhost:5173/", path: "", message: /http\(s\) origin/ },
  { schema: "tokenSchema", valid: token, invalid: token.toUpperCase(), path: "", message: /lowercase hex/ },
  { schema: "sha256Schema", valid: digest, invalid: digest.slice(1), path: "", message: /SHA-256/ },
  { schema: "pidSchema", valid: 4242, invalid: 0, path: "" },
  { schema: "absolutePathSchema", valid: "C:\\Users\\dev\\app", invalid: "Users/dev/app", path: "", message: /absolute path/ },
  { schema: "absolutePathSchema", variant: "NUL", valid: "/Users/dev/app", invalid: "/Users/dev\0app", path: "", message: /absolute path/ },
  { schema: "absolutePathSchema", variant: "UNC", valid: "\\\\server\\share\\app", invalid: "\\\\server", path: "", message: /absolute path/ },
  // registry
  { schema: "activeVariantSchema", valid: { slot: "pricing", version: "v2" }, invalid: { slot: "pricing", version: "" }, path: "version" },
  {
    schema: "activeVariantsSchema",
    valid: comment.activeVariants,
    invalid: [{ slot: "pricing", version: "v1" }, { slot: "pricing", version: "v2" }],
    path: "",
    message: /each slot may appear only once/,
  },
  { schema: "slotStateSchema", valid: slotState, invalid: { ...slotState, activeVersion: "v3" }, path: "activeVersion" },
  { schema: "registryWarningSchema", valid: warning, invalid: { ...warning, source: "cookie" }, path: "source" },
  {
    schema: "registryWarningSchema",
    variant: "api selection",
    valid: { code: "unknown_slot", source: "api", value: "pricing", message: "No slot pricing on this page" },
    invalid: { code: "unknown_slot", source: "window", value: "pricing", message: "No slot pricing on this page" },
    path: "source",
  },
  {
    schema: "registrySnapshotSchema",
    valid: snapshot,
    invalid: { ...snapshot, slots: [slotState, slotState] },
    path: "slots",
    message: /slot names must be unique/,
  },
  {
    schema: "variantSelectionSchema",
    valid: { schemaVersion: 1, slot: "pricing", version: "v2" },
    invalid: { schemaVersion: 1, slot: "pricing:v2", version: "v2" },
    path: "slot",
  },
  { schema: "slotReportSchema", valid: slotReport, invalid: { ...slotReport, pageUrl: "javascript:alert(1)" }, path: "pageUrl" },
  // feedback
  { schema: "feedbackKindSchema", valid: "choose_variant", invalid: "vote", path: "" },
  { schema: "feedbackStatusSchema", valid: "needs-info", invalid: "closed", path: "" },
  { schema: "boundingBoxSchema", valid: boundingBox, invalid: { ...boundingBox, width: -1 }, path: "width" },
  {
    schema: "sourceLocationSchema",
    valid: sourceLocation,
    invalid: { ...sourceLocation, path: "src/../../etc/passwd" },
    path: "path",
    message: /project-relative/,
  },
  {
    schema: "sourceLocationSchema",
    variant: "line break",
    valid: { ...sourceLocation, path: "src/a:b c/ü.tsx" },
    invalid: { ...sourceLocation, path: "src/App\n.tsx" },
    path: "path",
    message: /control characters/,
  },
  { schema: "feedbackTargetSchema", valid: target, invalid: { ...target, selector: "" }, path: "selector" },
  { schema: "screenshotAttachmentSchema", valid: screenshot, invalid: { ...screenshot, mediaType: "image/jpeg" }, path: "mediaType" },
  {
    schema: "evidenceAttachmentSchema",
    valid: evidenceAttachment,
    invalid: { ...evidenceAttachment, byteLength: MAX_ATTACHMENT_BYTES + 1 },
    path: "byteLength",
  },
  {
    schema: "attachmentRefSchema",
    variant: "screenshot",
    valid: screenshot,
    invalid: { ...screenshot, mediaType: "application/json" },
    path: "mediaType",
  },
  {
    schema: "attachmentRefSchema",
    variant: "evidence",
    valid: evidenceAttachment,
    invalid: { ...evidenceAttachment, sha256: digest.toUpperCase() },
    path: "sha256",
  },
  {
    schema: "evidenceWindowSchema",
    valid: evidenceWindow,
    invalid: { ...evidenceWindow, end: "2026-11-03T09:59:59.000Z" },
    path: "end",
    message: /end must not precede start/,
  },
  {
    schema: "evidenceRefSchema",
    valid: { window: evidenceWindow, attachment: evidenceAttachment },
    invalid: { window: evidenceWindow, attachment: screenshot },
    path: "attachment",
  },
  { schema: "replyAuthorSchema", valid: reply.author, invalid: { kind: "bot", name: null }, path: "kind" },
  { schema: "replySchema", valid: reply, invalid: { ...reply, id: "../rp_0001" }, path: "id" },
  {
    schema: "feedbackDraftSchema",
    variant: "comment",
    valid: draft,
    invalid: { ...draft, target: { ...target, textExcerpt: "x".repeat(201) } },
    path: "target.textExcerpt",
  },
  {
    schema: "feedbackDraftSchema",
    variant: "comment, blank unavailable reason",
    valid: { ...draft, screenshotUnavailableReason: null },
    invalid: { ...draft, screenshotUnavailableReason: "   " },
    path: "screenshotUnavailableReason",
    message: /must not be blank/,
  },
  {
    schema: "feedbackDraftSchema",
    variant: "choose_variant",
    valid: draftChoice,
    invalid: { ...draftChoice, choice: { slot: "pricing" } },
    path: "choice.version",
  },
  {
    schema: "feedbackSchema",
    variant: "comment",
    valid: comment,
    invalid: { ...comment, text: "   " },
    path: "text",
    message: /must not be blank/,
  },
  {
    schema: "feedbackSchema",
    variant: "choose_variant",
    valid: chooseVariant,
    invalid: { ...chooseVariant, choice: undefined },
    path: "choice",
  },
  {
    schema: "feedbackSchema",
    variant: "choose_variant, blank unavailable reason",
    valid: { ...chooseVariant, screenshotUnavailableReason: "Page was hidden" },
    invalid: { ...chooseVariant, screenshotUnavailableReason: "\t\n" },
    path: "screenshotUnavailableReason",
    message: /must not be blank/,
  },
  // daemon
  { schema: "daemonInfoSchema", valid: daemonInfo, invalid: { ...daemonInfo, host: "0.0.0.0" }, path: "host" },
  {
    schema: "storeLockSchema",
    valid: { schemaVersion: 1, pid: 4242, startedAt: createdAt },
    invalid: { schemaVersion: 1, pid: 0, startedAt: createdAt },
    path: "pid",
  },
  {
    schema: "registerOriginsRequestSchema",
    valid: { schemaVersion: 1, origins: ["http://localhost:5173", "http://127.0.0.1:5173"] },
    invalid: { schemaVersion: 1, origins: ["http://localhost:5173", "http://localhost:5173/"] },
    path: "origins.1",
  },
  {
    schema: "registerOriginsResponseSchema",
    valid: { schemaVersion: 1, origins: ["https://app.localhost"] },
    invalid: { schemaVersion: 1, origins: ["file:///tmp"] },
    path: "origins.0",
  },
  {
    schema: "feedbackListQuerySchema",
    valid: { status: "needs-info", kind: "comment", since: createdAt },
    invalid: { kind: "comment", status: "closed" },
    path: "status",
  },
  {
    schema: "feedbackListResponseSchema",
    valid: { schemaVersion: 1, items: [comment, chooseVariant] },
    invalid: { schemaVersion: 1, items: [comment, { ...chooseVariant, status: "pending" }] },
    path: "items.1.status",
  },
  {
    schema: "replyRequestSchema",
    valid: { schemaVersion: 1, author: { kind: "user", name: null }, text: "Try v3." },
    invalid: { schemaVersion: 1, author: { kind: "user", name: null }, text: "\n" },
    path: "text",
    message: /must not be blank/,
  },
  {
    schema: "statusRequestSchema",
    valid: { schemaVersion: 1, status: "resolved" },
    invalid: { schemaVersion: 1, status: "closed" },
    path: "status",
  },
  {
    schema: "slotListResponseSchema",
    valid: { schemaVersion: 1, pages: [slotReport] },
    invalid: { schemaVersion: 1, pages: [{ ...slotReport, reportedAt: undefined }] },
    path: "pages.0.reportedAt",
  },
  {
    schema: "slotListResponseSchema",
    variant: "one report per page URL",
    valid: { schemaVersion: 1, pages: [slotReport, { ...slotReport, pageUrl: "http://localhost:5173/" }] },
    invalid: { schemaVersion: 1, pages: [slotReport, { ...slotReport, reportedAt: updatedAt }] },
    path: "pages",
    message: /page URLs must be unique/,
  },
  { schema: "daemonErrorCodeSchema", valid: "store_locked", invalid: "teapot", path: "" },
  {
    schema: "daemonErrorResponseSchema",
    valid: { schemaVersion: 1, error: { code: "forbidden_origin", message: "Origin not allowed" } },
    invalid: { schemaVersion: 1, error: { code: "teapot", message: "Origin not allowed" } },
    path: "error.code",
  },
  {
    schema: "daemonEventSchema",
    variant: "feedback.created",
    valid: { schemaVersion: 1, type: "feedback.created", feedback: chooseVariant },
    invalid: { schemaVersion: 1, type: "feedback.created", feedback: { ...chooseVariant, kind: "vote" } },
    path: "feedback.kind",
  },
  {
    schema: "daemonEventSchema",
    variant: "feedback.updated",
    valid: { schemaVersion: 1, type: "feedback.updated", feedback: comment },
    invalid: { schemaVersion: 1, type: "feedback.updated", report: slotReport },
    path: "feedback",
  },
  {
    schema: "daemonEventSchema",
    variant: "slots.reported",
    valid: { schemaVersion: 1, type: "slots.reported", report: slotReport },
    invalid: { schemaVersion: 1, type: "slots.reported", report: { ...slotReport, slots: [{ ...slotState, mounts: 0 }] } },
    path: "report.slots.0.mounts",
  },
];

const label = "msg";
const caseName = ({ schema, variant }: Case) => (variant ? `${schema} (${variant})` : schema);
const schemaOf = (name: SchemaName) => api[name] as z.ZodType;
const isVersioned = (value: unknown) => typeof value === "object" && value !== null && "schemaVersion" in value;

function issueOnPath(issue: string, path: string): boolean {
  const prefix = path ? `${label}.${path}` : label;
  return issue.startsWith(`${prefix}:`) || issue.startsWith(`${prefix}.`);
}

describe.each(cases.map((testCase) => ({ ...testCase, name: caseName(testCase) })))("$name", (testCase) => {
  const schema = schemaOf(testCase.schema);

  it("accepts the valid fixture", () => {
    expect(parseMessage(schema, testCase.valid, label)).toEqual(testCase.valid);
  });

  it("rejects the invalid fixture on the field it targets", () => {
    const result = safeParseMessage(schema, testCase.invalid, label);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(InvalidMessageError);
    const { issues } = result.error as InvalidMessageError;
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) expect(issueOnPath(issue, testCase.path), issue).toBe(true);
    if (testCase.message) expect(issues.some((issue) => testCase.message?.test(issue)), issues.join("\n")).toBe(true);
  });

  it.runIf(isVersioned(testCase.valid))("rejects an unknown major version before reading the shape", () => {
    for (const input of [{ ...(testCase.valid as object), schemaVersion: 2 }, { schemaVersion: 2, renamedEverything: true }]) {
      const result = safeParseMessage(schema, input, label);
      expect(result.success).toBe(false);
      if (result.success) continue;
      expect(result.error).toBeInstanceOf(UnsupportedSchemaVersionError);
      expect(result.error.code).toBe("unsupported_schema_version");
      expect((result.error as UnsupportedSchemaVersionError).receivedVersion).toBe(2);
    }
  });
});

describe("fixture coverage", () => {
  it("has a case for every schema the root entry exports", () => {
    const exported = Object.keys(api).filter((name) => name.endsWith("Schema")).sort();
    const covered = new Set(cases.map((testCase) => testCase.schema));
    expect(exported.filter((name) => !covered.has(name as SchemaName))).toEqual([]);
    expect(exported.length).toBeGreaterThanOrEqual(43);
  });

  it("has a valid and an invalid fixture for every discriminated-union branch", () => {
    const unions = Object.entries(api).flatMap(([name, value]): [string, z.ZodDiscriminatedUnion][] =>
      value instanceof z.ZodDiscriminatedUnion ? [[name, value]] : []);
    expect(unions.map(([name]) => name).sort())
      .toEqual(["attachmentRefSchema", "daemonEventSchema", "feedbackDraftSchema", "feedbackSchema"]);
    for (const [name, union] of unions) {
      const key = union.def.discriminator;
      const unionCases = cases.filter((testCase) => testCase.schema === name);
      for (const option of union.options as z.ZodObject[]) {
        const tag = (option.shape[key] as z.ZodLiteral).value;
        const branch = unionCases.filter((testCase) => (testCase.valid as Record<string, unknown>)[key] === tag);
        expect(branch.map((testCase) => option.safeParse(testCase.valid).success), `${name} ${String(tag)} valid`)
          .toContain(true);
        expect(branch.map((testCase) => (testCase.invalid as Record<string, unknown>)[key]), `${name} ${String(tag)} invalid`)
          .toContain(tag);
      }
    }
  });
});

describe("nested records", () => {
  it("rejects a v1 envelope holding a record from another major version as an invalid message", () => {
    const event = { schemaVersion: 1, type: "feedback.created", feedback: { ...comment, schemaVersion: 2 } };
    const list = { schemaVersion: 1, items: [comment, { ...chooseVariant, schemaVersion: 2 }] };
    for (const [schema, input, path] of [
      [daemonEventSchema, event, "feedback.schemaVersion"],
      [feedbackListResponseSchema, list, "items.1.schemaVersion"],
    ] as const) {
      const result = safeParseMessage(schema, input, label);
      expect(result.success).toBe(false);
      if (result.success) continue;
      expect(result.error).toBeInstanceOf(InvalidMessageError);
      expect(result.error.code).toBe("invalid_message");
      const { issues } = result.error as InvalidMessageError;
      expect(issues.length).toBeGreaterThan(0);
      for (const issue of issues) expect(issueOnPath(issue, path), issue).toBe(true);
    }
  });

  it("rejects an unknown daemon event type on the discriminator", () => {
    const result = safeParseMessage(daemonEventSchema, { schemaVersion: 1, type: "feedback.deleted", feedback: comment }, label);
    expect(result.success).toBe(false);
    if (!result.success) {
      for (const issue of (result.error as InvalidMessageError).issues) expect(issueOnPath(issue, "type"), issue).toBe(true);
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

  it("reads an inherited schemaVersion the same way the schema does", () => {
    const inheriting = (schemaVersion: unknown) => Object.assign(Object.create({ schemaVersion }), { status: "open" });
    const future = safeParseMessage(statusRequestSchema, inheriting(2), label);
    expect(future.success || future.error.code).toBe("unsupported_schema_version");
    expect(parseMessage(statusRequestSchema, inheriting(1))).toEqual({ schemaVersion: 1, status: "open" });
    const malformed = safeParseMessage(statusRequestSchema, inheriting("1"), label);
    expect(malformed.success || malformed.error.code).toBe("invalid_message");
    class FutureRegistry {
      get schemaVersion() { return 2; }
    }
    expect(() => readPageApi({ [PAGE_API_GLOBAL]: new FutureRegistry() })).toThrow(UnsupportedSchemaVersionError);
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

  it("round-trips every source location the schema accepts", () => {
    const codePoints = [...Array.from({ length: 0xa0 }, (_, index) => index), 0x2028, 0x2029, 0xfeff, 0x1f600];
    for (const codePoint of codePoints) {
      const location = { path: `src/a${String.fromCodePoint(codePoint)}b.tsx`, line: 7, column: 3 };
      if (!sourceLocationSchema.safeParse(location).success) continue;
      expect(parseSourceLocation(formatSourceLocation(location)), `U+${codePoint.toString(16)}`).toEqual(location);
    }
    for (const character of ["\r", "\n", "\u2028", "\u2029", "\0"]) {
      expect(sourceLocationSchema.safeParse({ ...sourceLocation, path: `src/a${character}b.tsx` }).success).toBe(false);
    }
  });

  it("rejects a blank screenshotUnavailableReason on every feedback shape, keeping null and real reasons", () => {
    for (const [schema, base] of [
      [feedbackSchema, chooseVariant],
      [api.feedbackDraftSchema, draft],
      [api.feedbackDraftSchema, draftChoice],
    ] as const) {
      expect(safeParseMessage(schema, { ...base, screenshotUnavailableReason: " " }).success).toBe(false);
      expect(safeParseMessage(schema, { ...base, screenshotUnavailableReason: null }).success).toBe(true);
      expect(safeParseMessage(schema, { ...base, screenshotUnavailableReason: "Capture timed out" }).success).toBe(true);
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

  it("keeps malformed entries verbatim and ignores blank ones", () => {
    expect(parseVariantParam(" bad , \t,hero: b ,pricing:v2 ")).toEqual({
      selections: [{ slot: "pricing", version: "v2" }],
      invalid: [" bad ", "hero: b "],
    });
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

describe("portable ids", () => {
  const unportable = ["fb_A", "FB_0001", "con", "CON", "nul", "aux", "prn", "com1", "lpt9", "com0"];

  it("rejects ids that alias on case-insensitive filesystems or name a Windows device", () => {
    for (const id of unportable) {
      expect(safeParseMessage(api.idSchema, id).success, id).toBe(false);
      expect(() => assertSafeId(id), id).toThrow(expect.objectContaining({ code: "invalid_path_segment" }));
      expect(() => daemonPath("getFeedback", { feedbackId: id }), id).toThrow(IterbarContractError);
      expect(() => api.attachmentFileName({ id, kind: "screenshot" }), id).toThrow(IterbarContractError);
      expect(safeParseMessage(feedbackSchema, { ...comment, id }).success, id).toBe(false);
    }
    for (const id of ["console", "com10", "nul_1", "lpt", "fb_0001"]) expect(assertSafeId(id)).toBe(id);
  });

  it("accepts only project roots that name the same directory in every process", () => {
    const accepted = [
      "/", "/Users/dev/app", "C:\\", "C:\\Users\\dev\\app", "c:/Users/dev/app",
      "\\\\server\\share", "\\\\server\\share\\", "\\\\server\\share\\app", "//server/share/app",
      "//server/share/x", "\\\\server/share", "//server\\share", "\\\\my-server.local\\share$\\app",
    ];
    const rejected = [
      // relative or drive-relative on Windows
      "Users/dev/app", "\\Users\\dev", "C:Users", "C:",
      // UNC without both a server and a share
      "\\\\", "\\\\server", "\\\\server\\", "//server", "//server/", "/\\server", "\\\\\\server\\share", "///Users/dev",
      "\\\\..\\share", "\\\\server\\..\\app",
      // device namespace: use the equivalent drive or UNC path
      "\\\\?\\C:\\app", "\\\\?\\UNC\\server\\share", "\\\\.\\C:\\app", "\\\\.\\pipe\\iterbar", "//./pipe/iterbar",
      // a UNC server or share name containing a character Windows forbids in names, or a control character
      ...[..."<>:\"|?*", "\u0001", "\u001f"].flatMap((bad) => [
        `\\\\ser${bad}ver\\share`, `\\\\server\\sh${bad}are\\app`, `//server${bad}/share`, `//server/share${bad}`,
      ]),
    ];
    for (const root of accepted) {
      expect(safeParseMessage(absolutePathSchema, root).success, root).toBe(true);
      expect(safeParseMessage(daemonInfoSchema, { ...daemonInfo, projectRoot: root }, label).success, root).toBe(true);
    }
    for (const root of rejected) {
      expect(safeParseMessage(absolutePathSchema, root).success, root).toBe(false);
      const result = safeParseMessage(daemonInfoSchema, { ...daemonInfo, projectRoot: root }, label);
      expect(result.success, root).toBe(false);
      if (!result.success) {
        for (const issue of (result.error as InvalidMessageError).issues) expect(issueOnPath(issue, "projectRoot"), issue).toBe(true);
      }
    }
    expect(isAbsolutePath("C:\\app", "posix")).toBe(false);
    expect(isAbsolutePath("/app", "win32")).toBe(false);
    expect([isAbsolutePath("/app", "posix"), isAbsolutePath("C:\\app", "win32"), isAbsolutePath("\\\\s\\sh", "win32")])
      .toEqual([true, true, true]);
  });

  it("rejects a daemon project root containing NUL", () => {
    expect(safeParseMessage(absolutePathSchema, "C:\\app\0x").success).toBe(false);
    const result = safeParseMessage(daemonInfoSchema, { ...daemonInfo, projectRoot: "/Users/dev\0/app" }, label);
    expect(result.success).toBe(false);
    if (!result.success) {
      for (const issue of (result.error as InvalidMessageError).issues) expect(issueOnPath(issue, "projectRoot"), issue).toBe(true);
    }
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
