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
  // The port must be explicit and not 80: `URL` drops `:80`, browsers then omit it from `Host`, and the daemon only
  // answers requests whose `Host` names its port.
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

/** The `reportedAt` of the last slot report any connection on this page made, in epoch milliseconds. */
let lastReportedAt = 0;

/**
 * A `reportedAt` strictly later than every earlier report from this page, even within one millisecond or across a
 * replaced connection. The daemon keeps the last-arriving report on a tie, so two reports that shared a timestamp
 * could leave a superseded one current when they arrive out of order.
 */
function nextReportedAt(): string {
  lastReportedAt = Math.max(Date.now(), lastReportedAt + 1);
  return new Date(lastReportedAt).toISOString();
}

/** Longest a daemon request may take, body included, before it fails like any other transient error. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** Reconnect delays in milliseconds; the last one repeats. */
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15_000, 30_000];

export interface ConnectionCallbacks {
  onStatus(status: ConnectionStatus): void;
  /**
   * A feedback item from an event, to be merged into what the bar shows. Returns whether the event's copy is current
   * (not older than the one shown), so that it may take precedence over a listing in flight.
   */
  onFeedback(item: Feedback): boolean;
  /**
   * The daemon's complete feedback listing, which replaces what the bar shows. `touched` holds the ids of items that
   * current events delivered while the listing was in flight; those events may be newer than the listing.
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
  /** Resends the latest slot report after a transient failure, independently of the socket. */
  #reportRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #reportAttempt = 0;
  #connected = false;
  #stopped = false;
  #pendingReport: { pageUrl: string; slots: readonly SlotState[]; generation: number } | null = null;
  /** Counts {@link reportSlots} calls, so a failed report that something newer superseded is never retried. */
  #reportGeneration = 0;
  /** Ids of current events since the in-flight listing was requested; `null` when no listing is in flight. */
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
    this.#cancelReportRetry();
    const socket = this.#socket;
    this.#socket = null;
    socket?.close(1000);
  }

  /**
   * Tells the daemon which slots `pageUrl` shows. Only the latest report is kept; it is sent now when connected, or
   * once the connection opens, and resent with backoff until the daemon accepts it or a newer report replaces it. A
   * URL the contract does not accept (such as a `file:` page) is not reported.
   */
  reportSlots(pageUrl: string, slots: readonly SlotState[]): void {
    if (this.#stopped) return;
    this.#reportGeneration += 1;
    this.#pendingReport = { pageUrl, slots, generation: this.#reportGeneration };
    this.#reportAttempt = 0;
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
        if (this.#callbacks.onFeedback(parsed.data.feedback)) this.#touched?.add(parsed.data.feedback.id);
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
      const body = safeParseMessage(feedbackListResponseSchema, await this.#request("listFeedback"), "feedback list");
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
    this.#cancelReportRetry();
    this.#pendingReport = null;
    const report = slotReportSchema.safeParse({
      schemaVersion: SCHEMA_VERSION,
      pageUrl: pending.pageUrl,
      reportedAt: nextReportedAt(),
      slots: pending.slots,
    });
    if (!report.success) return;
    this.#request("reportSlots", JSON.stringify(report.data)).then(() => {
      if (pending.generation === this.#reportGeneration) this.#reportAttempt = 0;
    }, (error: unknown) => {
      if (error instanceof UnauthorizedError) {
        this.#reject();
        return;
      }
      // A report that a newer one has replaced since is dropped; the latest one is resent with backoff, now if the
      // socket is open or else as soon as it opens again.
      if (this.#stopped || this.#pendingReport !== null || pending.generation !== this.#reportGeneration) return;
      this.#pendingReport = pending;
      this.#scheduleReportRetry();
    });
  }

  #scheduleReportRetry(): void {
    if (this.#stopped || this.#reportRetryTimer) return;
    const delay = RETRY_DELAYS_MS[Math.min(this.#reportAttempt, RETRY_DELAYS_MS.length - 1)] ?? 30_000;
    this.#reportAttempt += 1;
    this.#reportRetryTimer = setTimeout(() => {
      this.#reportRetryTimer = null;
      // While disconnected the report stays pending, and the next open sends it.
      if (!this.#stopped && this.#connected) this.#flushReport();
    }, delay);
  }

  #cancelReportRetry(): void {
    if (this.#reportRetryTimer) clearTimeout(this.#reportRetryTimer);
    this.#reportRetryTimer = null;
  }

  /**
   * Sends a request and resolves with the parsed JSON body of a `GET`. The whole exchange, body included, must finish
   * within {@link REQUEST_TIMEOUT_MS}, so a daemon that stops answering leads to the usual retry instead of a hang.
   */
  async #request(endpoint: "listFeedback" | "reportSlots", body?: string): Promise<unknown> {
    const deadline = new AbortController();
    const cancel = (): void => deadline.abort();
    if (this.#abort.signal.aborted) cancel();
    this.#abort.signal.addEventListener("abort", cancel, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        deadline.abort();
        reject(new Error("The daemon did not answer in time."));
      }, REQUEST_TIMEOUT_MS);
    });
    const exchange = async (): Promise<unknown> => {
      const headers: Record<string, string> = { authorization: bearerAuthorization(this.#config.token) };
      if (body !== undefined) headers["content-type"] = "application/json";
      const response = await fetch(`${this.#config.url}${daemonPath(endpoint)}`, {
        method: body === undefined ? "GET" : "POST",
        headers,
        body,
        cache: "no-store",
        credentials: "omit",
        signal: deadline.signal,
      });
      if (response.status === 401) throw new UnauthorizedError("unauthorized");
      if (!response.ok) throw new Error(`The daemon answered ${response.status}`);
      return body === undefined ? await response.json() : undefined;
    };
    try {
      return await Promise.race([exchange(), timeout]);
    } finally {
      clearTimeout(timer);
      this.#abort.signal.removeEventListener("abort", cancel);
    }
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
