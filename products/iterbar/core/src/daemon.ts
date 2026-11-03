import { z } from "zod";
import { parseMessage } from "./errors.js";
import { feedbackKindSchema, feedbackSchema, feedbackStatusSchema, replyAuthorSchema } from "./feedback.js";
import { slotReportSchema } from "./registry.js";
import {
  absolutePathSchema,
  assertSafeId,
  originSchema,
  pidSchema,
  schemaVersionSchema,
  timestampSchema,
  tokenSchema,
} from "./primitives.js";

/** The only interface the daemon binds to. */
export const DAEMON_HOST = "127.0.0.1";

/** Contents of `.iterbar/daemon.json`, written with mode 0600 while a daemon runs. */
export const daemonInfoSchema = z.object({
  schemaVersion: schemaVersionSchema,
  host: z.literal(DAEMON_HOST),
  port: z.number().int().min(1).max(65_535),
  token: tokenSchema,
  pid: pidSchema,
  /** Absolute project root the daemon serves; clients only reuse a daemon whose root matches theirs. */
  projectRoot: absolutePathSchema,
  startedAt: timestampSchema,
});

/** Contents of `.iterbar/store.lock`: the single writer that owns the store. */
export const storeLockSchema = z.object({
  schemaVersion: schemaVersionSchema,
  pid: pidSchema,
  /** When the owning process started, so a reused pid is not mistaken for the owner. */
  startedAt: timestampSchema,
});

/** HTTP endpoints served by the daemon. `:name` segments are filled by {@link daemonPath}. */
export const daemonEndpoints = Object.freeze({
  registerOrigins: { method: "POST", path: "/origins" },
  createFeedback: { method: "POST", path: "/feedback" },
  listFeedback: { method: "GET", path: "/feedback" },
  getFeedback: { method: "GET", path: "/feedback/:feedbackId" },
  getAttachment: { method: "GET", path: "/feedback/:feedbackId/attachments/:attachmentId" },
  reply: { method: "POST", path: "/feedback/:feedbackId/replies" },
  setStatus: { method: "POST", path: "/feedback/:feedbackId/status" },
  reportSlots: { method: "POST", path: "/slots" },
  listSlots: { method: "GET", path: "/slots" },
  /** WebSocket upgrade for {@link daemonEventSchema} messages. */
  events: { method: "GET", path: "/events" },
} as const);

export type DaemonEndpointName = keyof typeof daemonEndpoints;

/** Multipart part names of `POST /feedback`. */
export const FEEDBACK_MULTIPART_PARTS = Object.freeze({
  feedback: "feedback",
  screenshot: "screenshot",
  evidence: "evidence",
} as const);

/**
 * Fills the `:name` segments of an endpoint path. Every value must be a safe id; anything else
 * (including `..` or `/`) throws `invalid_path_segment` rather than producing another route.
 */
export function daemonPath(endpoint: DaemonEndpointName, params: Readonly<Record<string, string>> = {}): string {
  const template: string = daemonEndpoints[endpoint].path;
  const path = template.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new TypeError(`daemonPath(${endpoint}) needs the ${name} parameter`);
    }
    return assertSafeId(value, name);
  });
  return path;
}

/** `POST /origins`: the dev server origins browser requests may come from. */
export const registerOriginsRequestSchema = z.object({
  schemaVersion: schemaVersionSchema,
  origins: z.array(originSchema).min(1).max(32),
});

/** Response of `POST /origins`: every origin now allowed. */
export const registerOriginsResponseSchema = z.object({
  schemaVersion: schemaVersionSchema,
  origins: z.array(originSchema),
});

/** Query string of `GET /feedback`. Every filter is optional; `since` compares with `updatedAt`. */
export const feedbackListQuerySchema = z.object({
  status: feedbackStatusSchema.optional(),
  kind: feedbackKindSchema.optional(),
  since: timestampSchema.optional(),
});

export const feedbackListResponseSchema = z.object({
  schemaVersion: schemaVersionSchema,
  items: z.array(feedbackSchema),
});

/** `POST /feedback/:feedbackId/replies`. */
export const replyRequestSchema = z.object({
  schemaVersion: schemaVersionSchema,
  author: replyAuthorSchema,
  text: z.string().max(20_000).refine((text) => text.trim().length > 0, "must not be blank"),
});

/** `POST /feedback/:feedbackId/status`. */
export const statusRequestSchema = z.object({
  schemaVersion: schemaVersionSchema,
  status: feedbackStatusSchema,
});

/** Response of `GET /slots`: the latest report per page URL. */
export const slotListResponseSchema = z.object({
  schemaVersion: schemaVersionSchema,
  pages: z.array(slotReportSchema).refine(
    (pages) => new Set(pages.map((page) => page.pageUrl)).size === pages.length,
    "page URLs must be unique",
  ),
});

export const daemonErrorCodeSchema = z.enum([
  "unauthorized",
  "forbidden_origin",
  "not_found",
  "invalid_request",
  "unsupported_schema_version",
  "payload_too_large",
  "store_locked",
  "internal",
]);

/** Body of every non-2xx daemon response. */
export const daemonErrorResponseSchema = z.object({
  schemaVersion: schemaVersionSchema,
  error: z.object({
    code: daemonErrorCodeSchema,
    message: z.string().max(2000),
  }),
});

/** Daemon -> client messages on the `/events` WebSocket. Clients send no application messages. */
export const daemonEventSchema = z.discriminatedUnion("type", [
  z.object({ schemaVersion: schemaVersionSchema, type: z.literal("feedback.created"), feedback: feedbackSchema }),
  z.object({ schemaVersion: schemaVersionSchema, type: z.literal("feedback.updated"), feedback: feedbackSchema }),
  z.object({ schemaVersion: schemaVersionSchema, type: z.literal("slots.reported"), report: slotReportSchema }),
]);

export type DaemonInfo = z.infer<typeof daemonInfoSchema>;
export type StoreLock = z.infer<typeof storeLockSchema>;
export type RegisterOriginsRequest = z.infer<typeof registerOriginsRequestSchema>;
export type RegisterOriginsResponse = z.infer<typeof registerOriginsResponseSchema>;
export type FeedbackListQuery = z.infer<typeof feedbackListQuerySchema>;
export type FeedbackListResponse = z.infer<typeof feedbackListResponseSchema>;
export type ReplyRequest = z.infer<typeof replyRequestSchema>;
export type StatusRequest = z.infer<typeof statusRequestSchema>;
export type SlotListResponse = z.infer<typeof slotListResponseSchema>;
export type DaemonErrorCode = z.infer<typeof daemonErrorCodeSchema>;
export type DaemonErrorResponse = z.infer<typeof daemonErrorResponseSchema>;
export type DaemonEvent = z.infer<typeof daemonEventSchema>;

/** WebSocket subprotocol the daemon selects for v1 event streams. */
export const WEBSOCKET_SUBPROTOCOL = "iterbar.v1";

/** Prefix of the second offered subprotocol, which carries the token (browsers cannot set headers on WebSockets). */
export const WEBSOCKET_TOKEN_PROTOCOL_PREFIX = "iterbar.token.";

/** `Authorization` header value for HTTP requests. */
export function bearerAuthorization(token: string): string {
  return `Bearer ${parseMessage(tokenSchema, token, "token")}`;
}

/** The token from an `Authorization: Bearer <token>` header, or `null` when absent or malformed. */
export function tokenFromAuthorization(header: string | null | undefined): string | null {
  const match = /^Bearer ([0-9a-f]{64})$/.exec(header ?? "");
  return match?.[1] ?? null;
}

/** Subprotocols a client offers: `new WebSocket(url, webSocketProtocols(token))`. */
export function webSocketProtocols(token: string): [string, string] {
  return [WEBSOCKET_SUBPROTOCOL, `${WEBSOCKET_TOKEN_PROTOCOL_PREFIX}${parseMessage(tokenSchema, token, "token")}`];
}

/**
 * The token from a `Sec-WebSocket-Protocol` request header, or `null` unless the header offers
 * {@link WEBSOCKET_SUBPROTOCOL} and exactly one well-formed token protocol.
 */
export function tokenFromWebSocketProtocols(header: string | null | undefined): string | null {
  const offered = (header ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!offered.includes(WEBSOCKET_SUBPROTOCOL)) return null;
  const tokens = offered
    .filter((value) => value.startsWith(WEBSOCKET_TOKEN_PROTOCOL_PREFIX))
    .map((value) => value.slice(WEBSOCKET_TOKEN_PROTOCOL_PREFIX.length));
  if (tokens.length !== 1) return null;
  const [token] = tokens;
  return token !== undefined && tokenSchema.safeParse(token).success ? token : null;
}
