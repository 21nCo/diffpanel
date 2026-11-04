import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import {
  daemonEndpoints,
  FEEDBACK_MULTIPART_PARTS,
  feedbackDraftSchema,
  feedbackListQuerySchema,
  isSafeId,
  MAX_ATTACHMENT_BYTES,
  parseMessage,
  parseMessageJson,
  registerOriginsRequestSchema,
  replyRequestSchema,
  SCHEMA_VERSION,
  slotReportSchema,
  statusRequestSchema,
  type DaemonEndpointName,
  type FeedbackListResponse,
  type RegisterOriginsResponse,
  type SlotListResponse,
  type SlotReport,
} from "iterbar";
import type { FeedbackFiles, FeedbackStore } from "../store/index.js";
import type { OriginAllowList } from "./access.js";
import type { EventHub } from "./events.js";
import {
  DaemonHttpError,
  decodeUtf8,
  invalidRequest,
  mediaType,
  notFound,
  payloadTooLarge,
  readBody,
  readJson,
  sendBytes,
  sendEmpty,
  sendJson,
} from "./http.js";

/** Largest `POST /feedback` body: both attachments at their cap plus room for the draft and multipart framing. */
export const MAX_FEEDBACK_BODY_BYTES = 2 * MAX_ATTACHMENT_BYTES + 1024 * 1024;

/** Most pages whose slot reports are kept; the least recently reported page is dropped first. */
export const MAX_SLOT_PAGES = 256;

/** The latest slot report of each page URL, most recently reported last. */
export class SlotRegistry {
  readonly #pages = new Map<string, SlotReport>();

  report(report: SlotReport): void {
    this.#pages.delete(report.pageUrl);
    this.#pages.set(report.pageUrl, report);
    for (const pageUrl of this.#pages.keys()) {
      if (this.#pages.size <= MAX_SLOT_PAGES) break;
      this.#pages.delete(pageUrl);
    }
  }

  list(): SlotReport[] {
    return [...this.#pages.values()];
  }
}

/** Everything a route handler works with. */
export interface RouteContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
  /** CORS headers for the response. */
  readonly headers: OutgoingHttpHeaders;
  readonly store: FeedbackStore;
  readonly origins: OriginAllowList;
  readonly slots: SlotRegistry;
  readonly events: EventHub;
}

type RouteHandler = (context: RouteContext) => Promise<void>;

interface CompiledRoute {
  readonly name: DaemonEndpointName;
  readonly method: string;
  readonly pattern: RegExp;
  readonly params: readonly string[];
}

const routes: readonly CompiledRoute[] = Object.entries(daemonEndpoints).map(([name, endpoint]) => {
  const params: string[] = [];
  const source = endpoint.path.replace(/:([A-Za-z]+)/g, (_, param: string) => {
    params.push(param);
    return "([^/]+)";
  });
  return { name: name as DaemonEndpointName, method: endpoint.method, pattern: new RegExp(`^${source}$`), params };
});

export type RouteMatch =
  | { readonly kind: "found"; readonly name: DaemonEndpointName; readonly params: Record<string, string> }
  | { readonly kind: "method_not_allowed"; readonly allow: readonly string[] }
  | { readonly kind: "not_found" };

/**
 * Finds the endpoint for a method and path. Every path parameter must be a safe id: anything else names no
 * resource, so it is `not_found`, never another route.
 */
export function matchRoute(method: string, pathname: string): RouteMatch {
  const allow: string[] = [];
  for (const route of routes) {
    const match = route.pattern.exec(pathname);
    if (!match) continue;
    const values = match.slice(1);
    if (!values.every((value) => value !== undefined && isSafeId(value))) return { kind: "not_found" };
    if (route.method !== method) {
      allow.push(route.method);
      continue;
    }
    return { kind: "found", name: route.name, params: Object.fromEntries(route.params.map((param, index) => [param, values[index] ?? ""])) };
  }
  return allow.length ? { kind: "method_not_allowed", allow } : { kind: "not_found" };
}

function param(context: RouteContext, name: string): string {
  const value = context.params[name];
  if (value === undefined) throw notFound();
  return value;
}

const PART_NAMES: ReadonlySet<string> = new Set(Object.values(FEEDBACK_MULTIPART_PARTS));

/** The single value of a multipart part, or `null` when it was not sent. */
function singlePart(form: FormData, name: string): FormDataEntryValue | null {
  const values = form.getAll(name);
  if (values.length > 1) throw invalidRequest(`The ${name} part was sent more than once`);
  return values[0] ?? null;
}

/** An attachment file part's bytes, refused with `payload_too_large` above the cap before being copied. */
async function filePart(form: FormData, name: string): Promise<Uint8Array | null> {
  const value = singlePart(form, name);
  if (value === null) return null;
  if (typeof value === "string") throw invalidRequest(`The ${name} part must be a file`);
  if (value.size > MAX_ATTACHMENT_BYTES) {
    throw payloadTooLarge(`The ${name} attachment is ${value.size} bytes; the limit is ${MAX_ATTACHMENT_BYTES}`);
  }
  return new Uint8Array(await value.arrayBuffer());
}

/** Reads the multipart `POST /feedback` body: the `feedback` draft and the optional attachment files. */
async function readFeedbackForm(request: IncomingMessage) {
  if (mediaType(request) !== "multipart/form-data") {
    throw invalidRequest("The request body must be multipart/form-data", 415);
  }
  const body = await readBody(request, MAX_FEEDBACK_BODY_BYTES);
  let form: FormData;
  try {
    // A view of the same bytes; Node never backs a Buffer with a SharedArrayBuffer.
    const bytes = new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength);
    form = await new Response(bytes, { headers: { "content-type": request.headers["content-type"] ?? "" } }).formData();
  } catch {
    throw invalidRequest("The multipart body is malformed");
  }
  for (const name of new Set(form.keys())) {
    if (!PART_NAMES.has(name)) throw invalidRequest(`Unknown multipart part ${JSON.stringify(name.slice(0, 64))}`);
  }
  const feedbackPart = singlePart(form, FEEDBACK_MULTIPART_PARTS.feedback);
  if (feedbackPart === null) throw invalidRequest("The feedback part is required");
  const text = typeof feedbackPart === "string"
    ? feedbackPart
    : decodeUtf8(new Uint8Array(await feedbackPart.arrayBuffer()), "feedback");
  const draft = parseMessageJson(feedbackDraftSchema, text, "feedback");
  const files: FeedbackFiles = {
    screenshot: await filePart(form, FEEDBACK_MULTIPART_PARTS.screenshot),
    evidence: await filePart(form, FEEDBACK_MULTIPART_PARTS.evidence),
  };
  return { draft, files };
}

/** The `GET /feedback` filters; a filter given more than once is refused rather than guessed. */
function listQuery(url: URL) {
  const query: Record<string, string> = {};
  for (const name of ["status", "kind", "since"] as const) {
    const values = url.searchParams.getAll(name);
    if (values.length > 1) throw invalidRequest(`The ${name} filter was given more than once`);
    if (values[0] !== undefined) query[name] = values[0];
  }
  return parseMessage(feedbackListQuerySchema, query, "feedback list query");
}

const handlers: Readonly<Record<DaemonEndpointName, RouteHandler>> = {
  async registerOrigins(context) {
    const { origins } = await readJson(context.request, registerOriginsRequestSchema, "origins request");
    const body: RegisterOriginsResponse = { schemaVersion: SCHEMA_VERSION, origins: context.origins.add(origins) };
    sendJson(context.response, 200, body, context.headers);
  },

  async createFeedback(context) {
    const { draft, files } = await readFeedbackForm(context.request);
    const feedback = await context.store.create(draft, files);
    context.events.publish({ schemaVersion: SCHEMA_VERSION, type: "feedback.created", feedback });
    sendJson(context.response, 201, feedback, context.headers);
  },

  async listFeedback(context) {
    const body: FeedbackListResponse = { schemaVersion: SCHEMA_VERSION, items: await context.store.list(listQuery(context.url)) };
    sendJson(context.response, 200, body, context.headers);
  },

  async getFeedback(context) {
    sendJson(context.response, 200, await context.store.get(param(context, "feedbackId")), context.headers);
  },

  async getAttachment(context) {
    const { attachment, data } = await context.store.readAttachment(param(context, "feedbackId"), param(context, "attachmentId"));
    sendBytes(context.response, attachment.mediaType, data, context.headers);
  },

  async reply(context) {
    const { author, text } = await readJson(context.request, replyRequestSchema, "reply request");
    const feedback = await context.store.reply(param(context, "feedbackId"), { author, text });
    context.events.publish({ schemaVersion: SCHEMA_VERSION, type: "feedback.updated", feedback });
    sendJson(context.response, 200, feedback, context.headers);
  },

  async setStatus(context) {
    const { status } = await readJson(context.request, statusRequestSchema, "status request");
    const feedbackId = param(context, "feedbackId");
    const before = await context.store.get(feedbackId);
    const feedback = await context.store.setStatus(feedbackId, status);
    // Setting the current status changes nothing, so it is not an update.
    if (feedback.updatedAt !== before.updatedAt) {
      context.events.publish({ schemaVersion: SCHEMA_VERSION, type: "feedback.updated", feedback });
    }
    sendJson(context.response, 200, feedback, context.headers);
  },

  async reportSlots(context) {
    const report = await readJson(context.request, slotReportSchema, "slot report");
    context.slots.report(report);
    context.events.publish({ schemaVersion: SCHEMA_VERSION, type: "slots.reported", report });
    sendEmpty(context.response, 204, context.headers);
  },

  async listSlots(context) {
    const body: SlotListResponse = { schemaVersion: SCHEMA_VERSION, pages: context.slots.list() };
    sendJson(context.response, 200, body, context.headers);
  },

  async events() {
    throw new DaemonHttpError(426, "invalid_request", "GET /events must be a WebSocket upgrade", { upgrade: "websocket" });
  },
};

export function handleRoute(name: DaemonEndpointName, context: RouteContext): Promise<void> {
  return handlers[name](context);
}
