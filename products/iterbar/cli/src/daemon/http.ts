import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { STATUS_CODES } from "node:http";
import type { Duplex } from "node:stream";
import {
  isIterbarContractError,
  parseMessageJson,
  SCHEMA_VERSION,
  type DaemonErrorCode,
  type DaemonErrorResponse,
} from "iterbar";
import { isIterbarStoreError } from "../store/index.js";

/** Largest JSON request body (origins, replies, status changes and slot reports), in bytes. */
export const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024;

/** Headers on every daemon response: nothing is cached, and nothing is sniffed as another type. */
const BASE_HEADERS: OutgoingHttpHeaders = Object.freeze({
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  vary: "Origin",
});

/** A request that ends with a daemon error response. */
export class DaemonHttpError extends Error {
  readonly status: number;
  readonly code: DaemonErrorCode;
  readonly headers: OutgoingHttpHeaders;

  constructor(status: number, code: DaemonErrorCode, message: string, headers: OutgoingHttpHeaders = {}) {
    super(message);
    this.name = "DaemonHttpError";
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export const unauthorized = () => new DaemonHttpError(401, "unauthorized", "A valid daemon token is required");
export const notFound = () => new DaemonHttpError(404, "not_found", "Not found");
export const invalidRequest = (message: string, status = 400) => new DaemonHttpError(status, "invalid_request", message);
export const payloadTooLarge = (message: string) =>
  new DaemonHttpError(413, "payload_too_large", message, { connection: "close" });

export function errorBody(code: DaemonErrorCode, message: string): DaemonErrorResponse {
  return { schemaVersion: SCHEMA_VERSION, error: { code, message: message.slice(0, 2000) } };
}

/**
 * The HTTP error for a failure while handling an authorized request, or `null` for an unexpected failure.
 * Contract and store errors keep their codes; an unsafe path id is a resource that does not exist.
 */
export function toHttpError(error: unknown): DaemonHttpError | null {
  if (error instanceof DaemonHttpError) return error;
  if (isIterbarContractError(error)) {
    switch (error.code) {
      case "unsupported_schema_version":
        return new DaemonHttpError(400, "unsupported_schema_version", error.message);
      case "invalid_message":
        return invalidRequest(error.message);
      case "invalid_path_segment":
        return notFound();
      default:
        return null;
    }
  }
  if (isIterbarStoreError(error)) {
    switch (error.code) {
      case "not_found":
        return new DaemonHttpError(404, "not_found", error.message);
      case "invalid_request":
        return invalidRequest(error.message);
      case "payload_too_large":
        return payloadTooLarge(error.message);
      case "store_locked":
      case "lock_lost":
        return new DaemonHttpError(503, "store_locked", error.message);
      case "store_closed":
        return new DaemonHttpError(503, "internal", "The daemon is shutting down");
      default:
        return null;
    }
  }
  return null;
}

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: OutgoingHttpHeaders = {},
): void {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    ...BASE_HEADERS,
    ...headers,
    "content-type": "application/json; charset=utf-8",
    "content-length": data.byteLength,
  });
  response.end(data);
}

export function sendBytes(
  response: ServerResponse,
  mediaType: string,
  data: Uint8Array,
  headers: OutgoingHttpHeaders = {},
): void {
  response.writeHead(200, {
    ...BASE_HEADERS,
    ...headers,
    "content-type": mediaType,
    "content-length": data.byteLength,
    // Attachments are data, never a document that runs in the daemon's origin.
    "content-security-policy": "default-src 'none'; sandbox",
    "content-disposition": "attachment",
  });
  response.end(data);
}

export function sendEmpty(response: ServerResponse, status: number, headers: OutgoingHttpHeaders = {}): void {
  response.writeHead(status, { ...BASE_HEADERS, ...headers });
  response.end();
}

export function sendError(response: ServerResponse, error: DaemonHttpError, headers: OutgoingHttpHeaders = {}): void {
  sendJson(response, error.status, errorBody(error.code, error.message), { ...headers, ...error.headers });
}

/** How long a refused upgrade's peer gets to take the error response before its socket is destroyed. */
export const REJECTED_UPGRADE_LINGER_MS = 1000;

/**
 * Answers a refused WebSocket upgrade on the raw socket with a JSON error, then destroys the socket once the
 * response is flushed (or after a short linger for a peer that does not read). An upgraded socket is outside the
 * HTTP server's connection tracking, so it must never depend on the peer closing its side.
 */
export function rejectUpgrade(socket: Duplex, error: DaemonHttpError, headers: OutgoingHttpHeaders = {}): void {
  const data = JSON.stringify(errorBody(error.code, error.message));
  const lines = Object.entries({
    ...BASE_HEADERS,
    ...headers,
    connection: "close",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
  }).map(([name, value]) => `${name}: ${String(value)}`);
  socket.on("error", () => socket.destroy());
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const linger = setTimeout(() => socket.destroy(), REJECTED_UPGRADE_LINGER_MS);
  socket.once("close", () => clearTimeout(linger));
  socket.once("finish", () => socket.destroy());
  socket.end(`HTTP/1.1 ${error.status} ${STATUS_CODES[error.status] ?? ""}\r\n${lines.join("\r\n")}\r\n\r\n${data}`);
}

/** The lowercase media type of a request's `Content-Type`, without parameters. */
export function mediaType(request: IncomingMessage): string {
  return (request.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * Reads a whole request body of at most `limit` bytes. A larger declared `Content-Length` is refused before
 * anything is read, and a body that grows past the limit stops being buffered; both are `payload_too_large`.
 */
export function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const tooLarge = () => payloadTooLarge(`The request body is larger than ${limit} bytes`);
  const declared = request.headers["content-length"];
  if (declared !== undefined && Number(declared) > limit) return Promise.reject(tooLarge());
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onIncomplete);
      request.off("close", onClose);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > limit) {
        cleanup();
        chunks.length = 0;
        // Keep draining so that the client can finish sending and read the response; nothing is buffered.
        request.resume();
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    // The client went away mid-body: a client failure, not a daemon one.
    const onIncomplete = () => {
      cleanup();
      reject(invalidRequest("The request body was not received completely"));
    };
    const onClose = () => {
      if (!request.complete) onIncomplete();
    };
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onIncomplete);
    request.on("close", onClose);
  });
}

/** Decodes UTF-8 text, rejecting invalid byte sequences instead of replacing them. */
export function decodeUtf8(data: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw invalidRequest(`${label} is not valid UTF-8`);
  }
}

type ProtocolSchema = Parameters<typeof parseMessageJson>[0];

/** Reads and validates an `application/json` request body against a versioned protocol schema. */
export async function readJson<S extends ProtocolSchema>(
  request: IncomingMessage,
  schema: S,
  label: string,
): Promise<ReturnType<typeof parseMessageJson<S>>> {
  if (mediaType(request) !== "application/json") {
    throw invalidRequest("The request body must be application/json", 415);
  }
  const body = await readBody(request, MAX_JSON_BODY_BYTES);
  return parseMessageJson(schema, decodeUtf8(body, label), label);
}
