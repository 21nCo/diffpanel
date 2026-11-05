import { readdir, readFile, stat } from "node:fs/promises";
import { daemonInfoSchema, parseMessageJson } from "iterbar";
import { iterbarPaths } from "iterbar/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commentDraft, EVIDENCE, PNG, temporaryProject } from "../store/test-support/helpers.js";
import { startDaemon, type RunningDaemon } from "./daemon.js";
import { bearer, connectEvents, halfOpenUpgrade, json, multipart, send, type HalfOpenUpgrade } from "./test-support/client.js";

let root: string;
let cleanup: () => Promise<void>;
const running: RunningDaemon[] = [];
const unexpected: unknown[] = [];

beforeEach(async () => {
  ({ root, cleanup } = await temporaryProject());
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((daemon) => daemon.close()));
  await cleanup();
  expect(unexpected.splice(0)).toEqual([]);
});

async function start(): Promise<RunningDaemon> {
  const daemon = await startDaemon({ projectRoot: root, onError: (error) => unexpected.push(error) });
  running.push(daemon);
  return daemon;
}

const DEV_ORIGIN = "http://localhost:5173";
const EVIL_ORIGIN = "http://evil.example";
const OTHER_TOKEN = "0".repeat(64);

async function registerDevOrigin(daemon: RunningDaemon): Promise<void> {
  const response = await send(daemon.info, {
    method: "POST",
    path: "/origins",
    headers: { ...bearer(daemon.info.token), ...json },
    body: JSON.stringify({ schemaVersion: 1, origins: [DEV_ORIGIN] }),
  });
  expect(response.status).toBe(200);
}

async function createFeedback(daemon: RunningDaemon): Promise<string> {
  const form = await multipart({ feedback: commentDraft, screenshot: PNG, evidence: EVIDENCE });
  const response = await send(daemon.info, {
    method: "POST",
    path: "/feedback",
    headers: { ...bearer(daemon.info.token), ...form.headers },
    body: form.body,
  });
  expect(response.status).toBe(201);
  return (JSON.parse(response.text) as { id: string }).id;
}

async function storedItems(): Promise<string[]> {
  return readdir(iterbarPaths(root).feedbackDirectory);
}

function errorCode(text: string): string {
  return (JSON.parse(text) as { error: { code: string } }).error.code;
}

describe("a web page on another origin (CSRF and cross-site WebSocket hijacking)", () => {
  it("cannot create, read or register anything without the token, and gets no CORS grant", async () => {
    const daemon = await start();
    const page = { origin: EVIL_ORIGIN, "sec-fetch-site": "cross-site" };
    // A form post is a CORS "simple request": the browser sends it without a preflight.
    const form = await multipart({ feedback: commentDraft });
    const attempts = [
      { method: "POST", path: "/feedback", headers: { ...page, ...form.headers }, body: form.body },
      { method: "GET", path: "/feedback", headers: page },
      { method: "POST", path: "/origins", headers: { ...page, "content-type": "text/plain" }, body: JSON.stringify({ schemaVersion: 1, origins: [EVIL_ORIGIN] }) },
    ];
    for (const attempt of attempts) {
      const response = await send(daemon.info, attempt);
      expect(response.status).toBe(401);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    }
    expect(await storedItems()).toEqual([]);
    // The failed registration added nothing: the same page with the token is still refused.
    const withToken = await send(daemon.info, { path: "/feedback", headers: { ...page, ...bearer(daemon.info.token) } });
    expect(withToken.status).toBe(403);
  });

  it("is refused with 403 even with the token, while the registered dev server origin is allowed", async () => {
    const daemon = await start();
    await registerDevOrigin(daemon);
    const token = bearer(daemon.info.token);

    const evil = await send(daemon.info, { path: "/feedback", headers: { ...token, origin: EVIL_ORIGIN } });
    expect(evil.status).toBe(403);
    expect(errorCode(evil.text)).toBe("forbidden_origin");
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();

    const opaque = await send(daemon.info, { path: "/feedback", headers: { ...token, origin: "null" } });
    expect(opaque.status).toBe(403);

    // A browser request without Origin (Sec-Fetch-Site gives the browser away) is refused too.
    const noOrigin = await send(daemon.info, { path: "/feedback", headers: { ...token, "sec-fetch-site": "same-origin" } });
    expect(noOrigin.status).toBe(403);

    const form = await multipart({ feedback: commentDraft });
    const evilCreate = await send(daemon.info, {
      method: "POST", path: "/feedback", headers: { ...token, ...form.headers, origin: EVIL_ORIGIN }, body: form.body,
    });
    expect(evilCreate.status).toBe(403);
    expect(await storedItems()).toEqual([]);

    const dev = await send(daemon.info, { path: "/feedback", headers: { ...token, origin: DEV_ORIGIN, "sec-fetch-site": "cross-site" } });
    expect(dev.status).toBe(200);
    expect(dev.headers["access-control-allow-origin"]).toBe(DEV_ORIGIN);
  });

  it("fails the CORS preflight that a token-carrying request needs; the registered origin passes it", async () => {
    const daemon = await start();
    await registerDevOrigin(daemon);
    const preflight = (origin: string) => send(daemon.info, {
      method: "OPTIONS",
      path: "/feedback",
      headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization" },
    });

    const evil = await preflight(EVIL_ORIGIN);
    expect(evil.status).toBe(403);
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();

    const dev = await preflight(DEV_ORIGIN);
    expect(dev.status).toBe(204);
    expect(dev.headers["access-control-allow-origin"]).toBe(DEV_ORIGIN);
    expect(dev.headers["access-control-allow-headers"]).toContain("authorization");
  });

  it("cannot open the event stream, even with the token; the registered origin can", async () => {
    const daemon = await start();
    await registerDevOrigin(daemon);

    const evil = await connectEvents(daemon.info, { headers: { origin: EVIL_ORIGIN } });
    expect(evil).toMatchObject({ accepted: false, status: 403 });

    const dev = await connectEvents(daemon.info, { headers: { origin: DEV_ORIGIN } });
    expect(dev).toMatchObject({ accepted: true, protocol: "iterbar.v1" });
    if (dev.accepted) dev.client.close();
  });
});

describe("a page that rebinds its DNS name to 127.0.0.1", () => {
  it("is refused over HTTP and WebSocket for any Host but 127.0.0.1:<port>, even with the token", async () => {
    const daemon = await start();
    await registerDevOrigin(daemon);
    const { port, token } = daemon.info;
    const hosts = [`evil.example:${port}`, `localhost:${port}`, "127.0.0.1", `127.0.0.1:${port + 1}`, `[::1]:${port}`];
    for (const host of hosts) {
      const response = await send(daemon.info, { path: "/feedback", headers: { ...bearer(token), host, origin: DEV_ORIGIN } });
      expect(response.status, host).toBe(403);
      expect(errorCode(response.text)).toBe("forbidden_origin");
      expect(response.text).not.toContain("items");

      const preflight = await send(daemon.info, {
        method: "OPTIONS", path: "/feedback", headers: { host, origin: DEV_ORIGIN, "access-control-request-method": "GET" },
      });
      expect(preflight.status, host).toBe(403);

      const events = await connectEvents(daemon.info, { headers: { host, origin: DEV_ORIGIN } });
      expect(events, host).toMatchObject({ accepted: false, status: 403 });
    }
    // A rebinding page has no token either, and still gets nothing.
    const form = await multipart({ feedback: commentDraft });
    const create = await send(daemon.info, {
      method: "POST", path: "/feedback", headers: { host: `evil.example:${port}`, ...form.headers }, body: form.body,
    });
    expect(create.status).toBe(403);
    expect(await storedItems()).toEqual([]);
  });
});

describe("a local process without the token", () => {
  it("gets the same 401 for existing, missing and unknown resources, and changes nothing", async () => {
    const daemon = await start();
    const id = await createFeedback(daemon);
    const { token } = daemon.info;
    const credentials: Array<Record<string, string>> = [
      {},
      bearer(OTHER_TOKEN),
      { authorization: `Bearer ${token.toUpperCase()}` },
      { authorization: `Bearer ${token.slice(0, 63)}` },
      { authorization: token },
      { authorization: `Basic ${Buffer.from(`iterbar:${token}`).toString("base64")}` },
      { "x-iterbar-token": token },
    ];
    const targets = [
      { method: "GET", path: `/feedback/${id}` },
      { method: "GET", path: "/feedback/feedback-missing" },
      { method: "GET", path: `/feedback/${id}/attachments/attachment-missing` },
      { method: "GET", path: "/no-such-endpoint" },
      { method: "DELETE", path: `/feedback/${id}` },
      { method: "POST", path: `/feedback/${id}/replies`, body: JSON.stringify({ schemaVersion: 1, author: { kind: "agent", name: null }, text: "hi" }) },
      { method: "POST", path: `/feedback/${id}/status`, body: JSON.stringify({ schemaVersion: 1, status: "done" }) },
      { method: "POST", path: "/origins", body: JSON.stringify({ schemaVersion: 1, origins: [DEV_ORIGIN] }) },
    ];
    const bodies = new Set<string>();
    for (const headers of credentials) {
      for (const target of targets) {
        const response = await send(daemon.info, { ...target, headers: { ...headers, ...json } });
        expect(response.status, `${target.method} ${target.path}`).toBe(401);
        bodies.add(response.text);
      }
    }
    expect([...bodies]).toEqual([JSON.stringify({ schemaVersion: 1, error: { code: "unauthorized", message: "A valid daemon token is required" } })]);

    const current = await send(daemon.info, { path: `/feedback/${id}`, headers: bearer(token) });
    expect(JSON.parse(current.text)).toMatchObject({ status: "open", replies: [] });
    // The refused registration added nothing.
    const browser = await send(daemon.info, { path: "/feedback", headers: { ...bearer(token), origin: DEV_ORIGIN } });
    expect(browser.status).toBe(403);
  });

  it("cannot open the event stream without the token", async () => {
    const daemon = await start();
    for (const protocols of [[], ["iterbar.v1"], ["iterbar.v1", `iterbar.token.${OTHER_TOKEN}`], [`iterbar.token.${daemon.info.token}`]]) {
      const result = await connectEvents(daemon.info, { protocols });
      expect(result, protocols.join(",")).toMatchObject({ accepted: false, status: 401 });
    }
  });
});

describe("a refused upgrade that its client never closes", () => {
  /** Resolves with `true` when `promise` settles within `ms`. */
  const within = (promise: Promise<unknown>, ms: number) =>
    Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);

  it("is closed by the daemon and cannot hold up shutdown, daemon.json removal or the next start", async () => {
    const daemon = await start();
    await registerDevOrigin(daemon);
    const { port, token } = daemon.info;
    const held: HalfOpenUpgrade[] = [];
    try {
      for (const [headers, status] of [
        [{}, "401"],
        [{ "sec-websocket-protocol": `iterbar.v1, iterbar.token.${token}`, host: `localhost:${port}` }, "403"],
        [{ "sec-websocket-protocol": `iterbar.v1, iterbar.token.${token}`, origin: EVIL_ORIGIN }, "403"],
      ] as const) {
        const upgrade = await halfOpenUpgrade(daemon.info, headers);
        held.push(upgrade);
        expect(upgrade.statusLine, JSON.stringify(headers)).toBe(`HTTP/1.1 ${status} ${status === "401" ? "Unauthorized" : "Forbidden"}`);
      }
      // The daemon drops each refused connection itself, while it keeps running.
      for (const upgrade of held) expect(await within(upgrade.closedByDaemon, 1500)).toBe(true);

      // A refusal that is still pending at shutdown does not hold it up either.
      held.push(await halfOpenUpgrade(daemon.info, {}));
      expect(await within(daemon.close(), 1500)).toBe(true);
      await expect(stat(iterbarPaths(root).daemonFile)).rejects.toMatchObject({ code: "ENOENT" });
      const next = await start();
      expect((await send(next.info, { path: "/feedback", headers: bearer(next.info.token) })).status).toBe(200);
    } finally {
      for (const upgrade of held) upgrade.socket.destroy();
    }
  });
});

describe("a client of a restarted daemon", () => {
  it("finds its old token refused: every start has a new token, and daemon.json describes only the running daemon", async () => {
    const first = await start();
    const firstFile = await readFile(iterbarPaths(root).daemonFile, "utf8");
    expect(parseMessageJson(daemonInfoSchema, firstFile, "daemon.json").token).toBe(first.info.token);
    await first.close();
    await expect(readFile(iterbarPaths(root).daemonFile)).rejects.toMatchObject({ code: "ENOENT" });

    const second = await start();
    expect(second.info.token).not.toBe(first.info.token);
    const file = parseMessageJson(daemonInfoSchema, await readFile(iterbarPaths(root).daemonFile, "utf8"), "daemon.json");
    expect(file).toEqual(second.info);

    const stale = await send(second.info, { path: "/feedback", headers: bearer(first.info.token) });
    expect(stale.status).toBe(401);
    const staleEvents = await connectEvents({ port: second.info.port, token: first.info.token });
    expect(staleEvents).toMatchObject({ accepted: false, status: 401 });
    const fresh = await send(second.info, { path: "/feedback", headers: bearer(second.info.token) });
    expect(fresh.status).toBe(200);
  });
});
