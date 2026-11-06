import {
  bearerAuthorization,
  DAEMON_HOST,
  daemonEventSchema,
  daemonPath,
  feedbackListResponseSchema,
  safeParseMessage,
  SCHEMA_VERSION,
  slotReportSchema,
  tokenSchema,
  webSocketProtocols,
  type Feedback,
  type SlotState,
} from "iterbar";

/** Where the daemon listens and the token that authorizes this page; see {@link parseDaemonConfig}. */
export interface DaemonConfig {
  /** `http://127.0.0.1:<port>`, with no path, query or fragment. */
  readonly url: string;
  readonly token: string;
}

export type ConnectionStatus =
  | { readonly kind: "unconfigured" }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "connecting" }
  | { readonly kind: "connected" }
  | { readonly kind: "retrying"; readonly message: string }
  | { readonly kind: "unauthorized"; readonly message: string };

/**
 * Validates what the bar was given. The daemon only listens on {@link DAEMON_HOST}, so any other host is refused
 * here rather than sending the token somewhere else.
 */
export function parseDaemonConfig(
  url: string | null | undefined,
  token: string | null | undefined,
): { readonly ok: true; readonly config: DaemonConfig } | { readonly ok: false; readonly status: ConnectionStatus } {
  if (!url && !token) return { ok: false, status: { kind: "unconfigured" } };
  let parsed: URL | null;
  try {
    parsed = new URL(url ?? "");
  } catch {
    parsed = null;
  }
  const valid = parsed !== null && parsed.protocol === "http:" && parsed.hostname === DAEMON_HOST && parsed.port !== ""
    && !parsed.username && !parsed.password && parsed.pathname === "/" && !parsed.search && !parsed.hash;
  if (!valid || parsed === null) {
    return { ok: false, status: { kind: "invalid", message: `The daemon URL must be http://${DAEMON_HOST}:<port>.` } };
  }
  if (!tokenSchema.safeParse(token).success) {
    return { ok: false, status: { kind: "invalid", message: "The daemon token must be 64 lowercase hex characters." } };
  }
  return { ok: true, config: { url: parsed.origin, token: token as string } };
}

/** Reconnect delays in milliseconds; the last one repeats. */
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15_000, 30_000];

export interface ConnectionCallbacks {
  onStatus(status: ConnectionStatus): void;
  /** A feedback item from an event, to be merged into what the bar shows. */
  onFeedback(items: readonly Feedback[]): void;
  /**
   * The daemon's complete feedback listing, which replaces what the bar shows. `touched` holds the ids of items that
   * events delivered while the listing was in flight; those events may be newer than the listing.
   */
  onListing(items: readonly Feedback[], touched: ReadonlySet<string>): void;
}

class UnauthorizedError extends Error {}

/**
 * The bar's link to the daemon: the `/events` WebSocket, a `GET /feedback` listing every time the socket opens (so
 * nothing published while it was closed is missed), and `POST /slots` reports. A socket that closes is reopened
 * with backoff, which resets only once a listing succeeds. A `401` stops everything: the token is wrong and retrying
 * will not fix it.
 */
export class DaemonConnection {
  readonly #config: DaemonConfig;
  readonly #callbacks: ConnectionCallbacks;
  readonly #abort = new AbortController();
  #socket: WebSocket | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #attempt = 0;
  #connected = false;
  #stopped = false;
  #pendingReport: { pageUrl: string; slots: readonly SlotState[]; generation: number } | null = null;
  /** Counts {@link reportSlots} calls, so a failed report that something newer superseded is never retried. */
  #reportGeneration = 0;
  /** Ids delivered by events since the in-flight listing was requested; `null` when no listing is in flight. */
  #touched: Set<string> | null = null;

  constructor(config: DaemonConfig, callbacks: ConnectionCallbacks) {
    this.#config = config;
    this.#callbacks = callbacks;
  }

  start(): void {
    if (this.#stopped || this.#socket || this.#retryTimer) return;
    this.#callbacks.onStatus({ kind: "connecting" });
    this.#open();
  }

  /** Closes the socket, cancels retries and in-flight requests; the connection cannot be restarted. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#connected = false;
    this.#abort.abort();
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    const socket = this.#socket;
    this.#socket = null;
    socket?.close(1000);
  }

  /**
   * Tells the daemon which slots `pageUrl` shows. Only the latest report is kept; it is sent now when connected, or
   * once the connection opens. A URL the contract does not accept (such as a `file:` page) is not reported.
   */
  reportSlots(pageUrl: string, slots: readonly SlotState[]): void {
    this.#reportGeneration += 1;
    this.#pendingReport = { pageUrl, slots, generation: this.#reportGeneration };
    if (this.#connected) this.#flushReport();
  }

  #open(): void {
    let socket: WebSocket;
    try {
      const url = `${this.#config.url.replace(/^http:/, "ws:")}${daemonPath("events")}`;
      socket = new WebSocket(url, webSocketProtocols(this.#config.token));
    } catch (error) {
      this.#retry(`Could not open the event stream: ${(error as Error).message}`);
      return;
    }
    this.#socket = socket;
    let opened = false;
    socket.addEventListener("open", () => {
      if (this.#socket !== socket) return;
      opened = true;
      this.#connected = true;
      this.#callbacks.onStatus({ kind: "connected" });
      void this.#list(socket);
      this.#flushReport();
    });
    socket.addEventListener("message", (event) => {
      if (this.#socket !== socket || typeof event.data !== "string") return;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      const parsed = safeParseMessage(daemonEventSchema, message, "daemon event");
      // Events from another protocol version, or that do not match v1, are ignored rather than half-read.
      if (!parsed.success) return;
      if (parsed.data.type === "feedback.created" || parsed.data.type === "feedback.updated") {
        this.#touched?.add(parsed.data.feedback.id);
        this.#callbacks.onFeedback([parsed.data.feedback]);
      }
    });
    socket.addEventListener("close", () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#connected = false;
      if (opened) this.#retry("The connection to the daemon was lost.");
      // A refused upgrade looks like any other failure to a page, so ask over HTTP why.
      else void this.#diagnose();
    });
  }

  /** Lists every feedback item. A failure closes the socket, so the next open lists again. */
  async #list(socket: WebSocket): Promise<void> {
    const touched = new Set<string>();
    this.#touched = touched;
    try {
      const response = await this.#request("listFeedback");
      const body = safeParseMessage(feedbackListResponseSchema, await response.json(), "feedback list");
      if (!body.success) throw body.error;
      if (this.#socket !== socket) return;
      this.#attempt = 0;
      this.#callbacks.onListing(body.data.items, touched);
    } catch (error) {
      if (this.#stopped || this.#socket !== socket) return;
      if (error instanceof UnauthorizedError) this.#reject();
      else socket.close();
    } finally {
      if (this.#touched === touched) this.#touched = null;
    }
  }

  async #diagnose(): Promise<void> {
    try {
      await this.#request("listFeedback");
      this.#retry("The daemon refused the event stream.");
    } catch (error) {
      if (this.#stopped) return;
      if (error instanceof UnauthorizedError) this.#reject();
      else this.#retry(`Cannot reach the daemon at ${this.#config.url}. Is it running, and is this origin registered?`);
    }
  }

  #flushReport(): void {
    const pending = this.#pendingReport;
    if (!pending) return;
    this.#pendingReport = null;
    const report = slotReportSchema.safeParse({
      schemaVersion: SCHEMA_VERSION,
      pageUrl: pending.pageUrl,
      reportedAt: new Date().toISOString(),
      slots: pending.slots,
    });
    if (!report.success) return;
    this.#request("reportSlots", JSON.stringify(report.data)).catch((error: unknown) => {
      if (error instanceof UnauthorizedError) this.#reject();
      // Any other failure is retried on the next reconnect, unless a newer report has replaced this one since.
      else if (!this.#stopped && this.#pendingReport === null && pending.generation === this.#reportGeneration) {
        this.#pendingReport = pending;
      }
    });
  }

  async #request(endpoint: "listFeedback" | "reportSlots", body?: string): Promise<Response> {
    const headers: Record<string, string> = { authorization: bearerAuthorization(this.#config.token) };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${this.#config.url}${daemonPath(endpoint)}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body,
      cache: "no-store",
      credentials: "omit",
      signal: this.#abort.signal,
    });
    if (response.status === 401) throw new UnauthorizedError("unauthorized");
    if (!response.ok) throw new Error(`The daemon answered ${response.status}`);
    return response;
  }

  #retry(message: string): void {
    if (this.#stopped || this.#retryTimer) return;
    const delay = RETRY_DELAYS_MS[Math.min(this.#attempt, RETRY_DELAYS_MS.length - 1)] ?? 30_000;
    this.#attempt += 1;
    this.#callbacks.onStatus({ kind: "retrying", message });
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (!this.#stopped) this.#open();
    }, delay);
  }

  #reject(): void {
    if (this.#stopped) return;
    this.stop();
    this.#callbacks.onStatus({ kind: "unauthorized", message: "The daemon rejected the token. Restart the dev server to get a new one." });
  }
}
