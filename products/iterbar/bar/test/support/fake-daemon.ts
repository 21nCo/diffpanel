import type { Page, WebSocketRoute } from "@playwright/test";
import { SCHEMA_VERSION, type DaemonEvent, type Feedback, type SlotReport } from "iterbar";

export const FAKE_TOKEN = "0123456789abcdef".repeat(4);

let nextPort = 47_100;

export interface FakeDaemon {
  readonly url: string;
  readonly token: string;
  /** What `GET /feedback` returns. */
  items: Feedback[];
  /** `401` makes every request (and the socket) fail as with a wrong token. */
  rejectToken: boolean;
  readonly requests: { method: string; path: string; authorization: string | undefined }[];
  readonly slotReports: SlotReport[];
  readonly sockets: WebSocketRoute[];
  readonly closedSockets: WebSocketRoute[];
  send(event: DaemonEvent | string): void;
}

/** A daemon answered by Playwright routes: `GET /feedback`, `POST /slots` and the `/events` WebSocket. */
export async function fakeDaemon(
  page: Page,
  origin: string,
  items: Feedback[] = [],
  options: { readonly socket?: boolean } = {},
): Promise<FakeDaemon> {
  const port = nextPort++;
  const url = `http://127.0.0.1:${port}`;
  const cors = { "access-control-allow-origin": origin };
  const daemon: FakeDaemon = {
    url,
    token: FAKE_TOKEN,
    items,
    rejectToken: false,
    requests: [],
    slotReports: [],
    sockets: [],
    closedSockets: [],
    send(event) {
      const data = typeof event === "string" ? event : JSON.stringify(event);
      for (const socket of daemon.sockets) socket.send(data);
    },
  };
  await page.route(`${url}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: { ...cors, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "authorization, content-type" },
      });
      return;
    }
    const authorization = await request.headerValue("authorization") ?? undefined;
    daemon.requests.push({ method: request.method(), path, authorization });
    if (daemon.rejectToken || authorization !== `Bearer ${FAKE_TOKEN}`) {
      await route.fulfill({
        status: 401, headers: cors, contentType: "application/json",
        body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, error: { code: "unauthorized", message: "bad token" } }),
      });
      return;
    }
    if (request.method() === "GET" && path === "/feedback") {
      await route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, items: daemon.items }) });
      return;
    }
    if (request.method() === "POST" && path === "/slots") {
      daemon.slotReports.push(JSON.parse(request.postData() ?? "null") as SlotReport);
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    await route.fulfill({ status: 404, headers: cors });
  });
  // Without a socket route the browser connects for real, finds nothing listening, and the socket never opens.
  if (options.socket === false) return daemon;
  await page.routeWebSocket(`ws://127.0.0.1:${port}/events`, (socket) => {
    daemon.sockets.push(socket);
    socket.onClose(() => {
      daemon.sockets.splice(daemon.sockets.indexOf(socket), 1);
      daemon.closedSockets.push(socket);
    });
  });
  return daemon;
}

let sequence = 0;

/** A stored comment, valid against the v1 feedback schema. */
export function comment(text: string, overrides: Partial<Feedback> = {}): Feedback {
  sequence += 1;
  const at = new Date(Date.UTC(2026, 0, 1, 0, sequence)).toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: `fb-${sequence}`,
    kind: "comment",
    text,
    pageUrl: "http://127.0.0.1/page",
    target: null,
    activeVariants: [],
    screenshotUnavailableReason: null,
    screenshot: null,
    evidence: null,
    replies: [],
    status: "open",
    createdAt: at,
    updatedAt: at,
    ...overrides,
  } as Feedback;
}
