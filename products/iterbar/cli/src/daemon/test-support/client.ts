import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect, type Socket } from "node:net";
import { daemonEventSchema, parseMessageJson, webSocketProtocols, type DaemonEvent, type DaemonInfo } from "iterbar";
import WebSocket from "ws";

export interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
  readonly text: string;
}

export interface RawRequest {
  readonly method?: string;
  readonly path: string;
  /** Sent as given; `host` defaults to the daemon's own `127.0.0.1:<port>`. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array | string;
}

/**
 * Sends one request with exactly the given headers, including `Host` and `Origin`, which `fetch` would not
 * let a test set the way a browser or a rebinding page does.
 */
export function send(info: Pick<DaemonInfo, "port">, options: RawRequest): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: info.port,
      method: options.method ?? "GET",
      path: options.path,
      agent: false,
      headers: { host: `127.0.0.1:${info.port}`, ...options.headers },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks);
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body, text: body.toString("utf8") });
      });
      response.on("error", reject);
    });
    // The daemon may answer and close before a refused body is fully sent.
    request.on("error", (error) => reject(error));
    request.end(options.body);
  });
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
export const json = { "content-type": "application/json" };

export interface MultipartParts {
  readonly feedback?: unknown;
  readonly screenshot?: Uint8Array<ArrayBuffer>;
  readonly evidence?: Uint8Array<ArrayBuffer>;
  readonly extra?: Readonly<Record<string, string>>;
}

/** A `POST /feedback` multipart body, encoded the way a browser's `FormData` is. */
export async function multipart(parts: MultipartParts): Promise<{ body: Buffer; headers: Record<string, string> }> {
  const form = new FormData();
  if (parts.feedback !== undefined) {
    form.append("feedback", typeof parts.feedback === "string" ? parts.feedback : JSON.stringify(parts.feedback));
  }
  if (parts.screenshot) form.append("screenshot", new Blob([parts.screenshot], { type: "image/png" }), "screenshot.png");
  if (parts.evidence) form.append("evidence", new Blob([parts.evidence], { type: "application/json" }), "evidence.json");
  for (const [name, value] of Object.entries(parts.extra ?? {})) form.append(name, value);
  const encoded = new Request("http://127.0.0.1/", { method: "POST", body: form });
  return {
    body: Buffer.from(await encoded.arrayBuffer()),
    headers: { "content-type": encoded.headers.get("content-type") as string },
  };
}

/** A connected `/events` client that queues the events it receives. */
export class EventClient {
  readonly socket: WebSocket;
  readonly #events: DaemonEvent[] = [];
  readonly #waiters: Array<() => void> = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (data) => {
      this.#events.push(parseMessageJson(daemonEventSchema, String(data), "daemon event"));
      for (const waiter of this.#waiters.splice(0)) waiter();
    });
    this.closed = new Promise((resolve) => socket.once("close", (code, reason) => resolve({ code, reason: String(reason) })));
  }

  /** The next event, failing after `timeoutMs`. */
  async next(timeoutMs = 2000): Promise<DaemonEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const event = this.#events.shift();
      if (event) return event;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("No daemon event arrived");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.#waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  close(): void {
    this.socket.terminate();
  }
}

export interface ConnectOptions {
  readonly protocols?: readonly string[];
  readonly headers?: Readonly<Record<string, string>>;
}

export type ConnectResult =
  | { readonly accepted: true; readonly client: EventClient; readonly protocol: string }
  | { readonly accepted: false; readonly status: number; readonly text: string };

/** Opens `/events` (or `path`), reporting a refused upgrade's status and body instead of throwing. */
export function connectEvents(info: Pick<DaemonInfo, "port" | "token">, options: ConnectOptions = {}, path = "/events"): Promise<ConnectResult> {
  const protocols = options.protocols ?? webSocketProtocols(info.token);
  const socket = new WebSocket(`ws://127.0.0.1:${info.port}${path}`, [...protocols], {
    headers: { host: `127.0.0.1:${info.port}`, ...options.headers },
  });
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve({ accepted: true, client: new EventClient(socket), protocol: socket.protocol }));
    socket.once("unexpected-response", (_request, response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        socket.terminate();
        resolve({ accepted: false, status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") });
      });
    });
    socket.once("error", reject);
  });
}

export interface HalfOpenUpgrade {
  readonly socket: Socket;
  /** The status line of the daemon's answer. */
  readonly statusLine: string;
  /**
   * Resolves once the daemon has closed the connection completely: its socket is gone, so data the client
   * keeps sending after the daemon's FIN is reset. A daemon that only ended its side would accept it forever.
   */
  readonly closedByDaemon: Promise<void>;
}

/**
 * Sends a WebSocket upgrade on a raw socket that never ends its side (`allowHalfOpen`), the way a careless or
 * hostile local client holds a refused upgrade open, and waits for the daemon's status line.
 */
export async function halfOpenUpgrade(info: Pick<DaemonInfo, "port">, headers: Readonly<Record<string, string>>): Promise<HalfOpenUpgrade> {
  const socket = connect({ host: "127.0.0.1", port: info.port, allowHalfOpen: true });
  const closedByDaemon = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.on("error", () => undefined);
  socket.once("end", () => {
    const probe = setInterval(() => socket.write("x"), 25);
    socket.once("close", () => clearInterval(probe));
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const lines = Object.entries({
    host: `127.0.0.1:${info.port}`,
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-version": "13",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    "sec-websocket-protocol": "iterbar.v1",
    ...headers,
  }).map(([name, value]) => `${name}: ${value}`);
  socket.write(`GET /events HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
  const statusLine = await new Promise<string>((resolve, reject) => {
    let received = "";
    const onData = (chunk: Buffer) => {
      received += chunk.toString("latin1");
      const end = received.indexOf("\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      // Keep reading, so that nothing the daemon sends is left unread in the kernel.
      socket.resume();
      resolve(received.slice(0, end));
    };
    socket.on("data", onData);
    socket.once("close", () => reject(new Error(`Closed before a status line: ${JSON.stringify(received)}`)));
  });
  return { socket, statusLine, closedByDaemon };
}
