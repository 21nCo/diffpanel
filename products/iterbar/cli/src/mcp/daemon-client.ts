import { readFile } from "node:fs/promises";
import {
  bearerAuthorization,
  daemonEndpoints,
  daemonErrorResponseSchema,
  daemonInfoSchema,
  daemonPath,
  feedbackListResponseSchema,
  feedbackSchema,
  isIterbarContractError,
  parseMessage,
  safeParseMessage,
  SCHEMA_VERSION,
  slotListResponseSchema,
  webSocketProtocols,
  type DaemonEndpointName,
  type DaemonInfo,
  type Feedback,
  type FeedbackListQuery,
  type FeedbackStatus,
  type ReplyAuthor,
  type SlotReport,
} from "iterbar";
import { iterbarPaths, type IterbarPaths } from "iterbar/node";
import WebSocket from "ws";
import { errnoCode } from "../store/errors.js";
import { daemonUnavailable, IterbarToolError } from "./errors.js";

/** How long one daemon request may take before the daemon counts as unavailable. */
export const DAEMON_REQUEST_TIMEOUT_MS = 30_000;

/** Connection failures that mean nothing (or nothing that answers) listens at the address in `daemon.json`. */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED", "ECONNRESET", "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CLOSED",
]);

export interface DaemonClientOptions {
  /** Absolute, real path of the project whose daemon is used. */
  readonly projectRoot: string;
  /** Defaults to {@link DAEMON_REQUEST_TIMEOUT_MS}. */
  readonly requestTimeoutMs?: number;
}

interface RequestOptions {
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly json?: unknown;
  readonly signal?: AbortSignal;
}

/** False only when no process has `pid`; a process owned by another user still counts as alive. */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) !== "ESRCH";
  }
}

function causeCode(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * A client of the project's running daemon. It never touches the store: every call reads `.iterbar/daemon.json`
 * afresh (so a restarted daemon is picked up) and goes through the daemon's HTTP API with its token.
 */
export class DaemonClient {
  readonly paths: IterbarPaths;
  readonly #timeoutMs: number;

  constructor(options: DaemonClientOptions) {
    this.paths = iterbarPaths(options.projectRoot);
    this.#timeoutMs = options.requestTimeoutMs ?? DAEMON_REQUEST_TIMEOUT_MS;
  }

  /** The daemon described by `daemon.json`, or `daemon_unavailable` when there is none that can still be running. */
  async info(): Promise<DaemonInfo> {
    const { daemonFile, projectRoot } = this.paths;
    let text: string;
    try {
      text = await readFile(daemonFile, "utf8");
    } catch (error) {
      if (errnoCode(error) === "ENOENT") {
        throw daemonUnavailable(`No Iterbar daemon is running for ${projectRoot} (${daemonFile} does not exist).`);
      }
      throw daemonUnavailable(`${daemonFile} could not be read (${errnoCode(error) ?? "error"}).`, { cause: error });
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw daemonUnavailable(`${daemonFile} is not valid JSON.`);
    }
    const parsed = safeParseMessage(daemonInfoSchema, json, "daemon.json");
    if (!parsed.success) throw daemonUnavailable(`${daemonFile} is not a valid daemon description.`);
    const info = parsed.data;
    if (info.projectRoot !== projectRoot) {
      throw daemonUnavailable(`${daemonFile} describes a daemon for ${info.projectRoot}, not ${projectRoot}.`);
    }
    if (!processExists(info.pid)) {
      throw daemonUnavailable(`The Iterbar daemon in ${daemonFile} (pid ${info.pid}) is no longer running.`);
    }
    return info;
  }

  /**
   * Sends a request and reads its whole body with `read`. A daemon that cannot be reached, stops answering within the
   * request timeout, or drops the connection before the body is complete is `daemon_unavailable`; an abort of
   * `options.signal` is passed through as it is.
   */
  async #request<T>(
    endpoint: DaemonEndpointName,
    params: Record<string, string>,
    read: (response: Response) => Promise<T>,
    options: RequestOptions = {},
  ): Promise<T> {
    const info = await this.info();
    const { method } = daemonEndpoints[endpoint];
    let path: string;
    try {
      path = daemonPath(endpoint, params);
    } catch (error) {
      // An id the daemon could never route names no resource, as the daemon itself would answer.
      if (isIterbarContractError(error)) throw new IterbarToolError("not_found", error.message);
      throw error;
    }
    const url = new URL(path, `http://${info.host}:${info.port}`);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, value);
    }
    const signals = [AbortSignal.timeout(this.#timeoutMs), ...(options.signal ? [options.signal] : [])];
    let response: Response;
    let body: T;
    try {
      response = await fetch(url, {
        method,
        headers: {
          authorization: bearerAuthorization(info.token),
          ...(options.json === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) }),
        signal: AbortSignal.any(signals),
        redirect: "error",
      });
      if (!response.ok) await this.#throwFor(response, info);
      body = await read(response);
    } catch (error) {
      if (error instanceof IterbarToolError || options.signal?.aborted) throw error;
      throw this.#transportError(error, info);
    }
    return body;
  }

  /** A failure to exchange bytes with the daemon at `info`, before or while the response arrived. */
  #transportError(error: unknown, info: DaemonInfo): unknown {
    if ((error as Error | undefined)?.name === "TimeoutError") {
      return daemonUnavailable(`The Iterbar daemon at ${info.host}:${info.port} did not answer within ${this.#timeoutMs} ms.`, { cause: error });
    }
    const code = causeCode(error);
    if (code === undefined || UNREACHABLE_CODES.has(code)) {
      return daemonUnavailable(`The Iterbar daemon at ${info.host}:${info.port} could not be reached (${code ?? "fetch failed"}).`, { cause: error });
    }
    return error;
  }

  async #throwFor(response: Response, info: DaemonInfo): Promise<never> {
    // A body cut short is a transport failure, not an unreadable answer.
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    const parsed = safeParseMessage(daemonErrorResponseSchema, body, "daemon error");
    const message = parsed.success ? parsed.data.error.message : `The daemon answered HTTP ${response.status}`;
    // 401: whatever listens at that address does not hold the token in daemon.json, so the file is stale.
    if (response.status === 401) {
      throw daemonUnavailable(`The daemon at ${info.host}:${info.port} does not accept the token in ${this.paths.daemonFile}; that file is stale.`);
    }
    // 503: the daemon is shutting down or has lost its store.
    if (response.status === 503) throw daemonUnavailable(`The Iterbar daemon cannot serve requests: ${message}.`);
    throw new IterbarToolError(parsed.success ? parsed.data.error.code : "internal", message);
  }

  /** Sends a request and parses its complete JSON body with `parse`. */
  async #json<T>(
    endpoint: DaemonEndpointName,
    params: Record<string, string>,
    parse: (json: unknown) => T,
    options: RequestOptions = {},
  ): Promise<T> {
    // The whole body is read as part of the request, so a connection lost halfway is daemon_unavailable; only a
    // complete body that is not JSON is the daemon's fault.
    const text = await this.#request(endpoint, params, (response) => response.text(), options);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new IterbarToolError("internal", "The daemon sent a response that is not valid JSON", { cause: error });
    }
    try {
      return parse(json);
    } catch (error) {
      if (isIterbarContractError(error)) {
        throw new IterbarToolError(error.code === "unsupported_schema_version" ? "unsupported_schema_version" : "internal", error.message);
      }
      throw error;
    }
  }

  listFeedback(query: FeedbackListQuery = {}, signal?: AbortSignal): Promise<Feedback[]> {
    return this.#json("listFeedback", {}, (json) => parseMessage(feedbackListResponseSchema, json, "feedback list").items, {
      query,
      ...(signal ? { signal } : {}),
    });
  }

  getFeedback(feedbackId: string): Promise<Feedback> {
    return this.#json("getFeedback", { feedbackId }, (json) => parseMessage(feedbackSchema, json, "feedback"));
  }

  async getAttachment(feedbackId: string, attachmentId: string): Promise<Uint8Array> {
    return new Uint8Array(await this.#request("getAttachment", { feedbackId, attachmentId }, (response) => response.arrayBuffer()));
  }

  reply(feedbackId: string, author: ReplyAuthor, text: string): Promise<Feedback> {
    return this.#json("reply", { feedbackId }, (json) => parseMessage(feedbackSchema, json, "feedback"), {
      json: { schemaVersion: SCHEMA_VERSION, author, text },
    });
  }

  setStatus(feedbackId: string, status: FeedbackStatus): Promise<Feedback> {
    return this.#json("setStatus", { feedbackId }, (json) => parseMessage(feedbackSchema, json, "feedback"), {
      json: { schemaVersion: SCHEMA_VERSION, status },
    });
  }

  listSlots(): Promise<SlotReport[]> {
    return this.#json("listSlots", {}, (json) => parseMessage(slotListResponseSchema, json, "slot list").pages);
  }

  /**
   * Opens the daemon's `/events` stream. Resolves once it is open; a daemon that cannot be reached or refuses the
   * token is `daemon_unavailable`.
   */
  async openEvents(signal?: AbortSignal): Promise<WebSocket> {
    const info = await this.info();
    const socket = new WebSocket(`ws://${info.host}:${info.port}${daemonPath("events")}`, webSocketProtocols(info.token), {
      perMessageDeflate: false,
      handshakeTimeout: this.#timeoutMs,
      followRedirects: false,
    });
    return new Promise<WebSocket>((resolve, reject) => {
      const cleanup = () => {
        socket.off("open", onOpen);
        socket.off("error", onError);
        socket.off("unexpected-response", onUnexpected);
        signal?.removeEventListener("abort", onAbort);
      };
      const onOpen = () => {
        cleanup();
        resolve(socket);
      };
      const fail = (error: Error) => {
        cleanup();
        socket.on("error", () => undefined);
        socket.terminate();
        reject(error);
      };
      const onError = (error: Error) => {
        fail(daemonUnavailable(`The Iterbar daemon's event stream at ${info.host}:${info.port} could not be opened (${causeCode(error) ?? error.message}).`, { cause: error }));
      };
      const onUnexpected = (_request: unknown, response: { statusCode?: number }) => {
        fail(daemonUnavailable(`The Iterbar daemon at ${info.host}:${info.port} refused the event stream (HTTP ${response.statusCode ?? "error"}).`));
      };
      const onAbort = () => fail(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
      socket.once("open", onOpen);
      socket.once("error", onError);
      socket.once("unexpected-response", onUnexpected);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
