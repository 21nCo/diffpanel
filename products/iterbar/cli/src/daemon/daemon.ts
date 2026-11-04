import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import {
  DAEMON_HOST,
  daemonInfoSchema,
  daemonPath,
  parseMessage,
  SCHEMA_VERSION,
  tokenFromAuthorization,
  tokenFromWebSocketProtocols,
  type DaemonInfo,
} from "iterbar";
import { openFeedbackStore, type FeedbackStore } from "../store/index.js";
import { authorize, authorizePreflight, isPreflight, OriginAllowList } from "./access.js";
import { removeDaemonFile, writeDaemonFile } from "./daemon-file.js";
import { EventHub } from "./events.js";
import { DaemonHttpError, rejectUpgrade, sendEmpty, sendError, toHttpError } from "./http.js";
import { handleRoute, KeyedSerializer, matchRoute, SlotRegistry } from "./routes.js";

/** How long in-flight requests get to finish on shutdown before their connections are closed. */
const HTTP_SHUTDOWN_GRACE_MS = 2000;

export interface StartDaemonOptions {
  /** Absolute path of the project whose `.iterbar/` store the daemon serves. It must exist. */
  readonly projectRoot: string;
  /** Receives unexpected errors, which clients only see as `internal`. Defaults to writing them to stderr. */
  readonly onError?: (error: unknown) => void;
  /** Wall clock in epoch milliseconds for the store's timestamps; defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface RunningDaemon {
  /** What `.iterbar/daemon.json` holds while the daemon runs. */
  readonly info: DaemonInfo;
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** Resolves once the daemon has shut down. */
  readonly closed: Promise<void>;
  /**
   * Shuts down: closes event streams, lets in-flight requests finish (briefly), removes `daemon.json`, then
   * releases the store. Idempotent.
   */
  close(): Promise<void>;
}

const shuttingDown = () => new DaemonHttpError(503, "internal", "The daemon is shutting down", { connection: "close" });

function defaultOnError(error: unknown): void {
  process.stderr.write(`iterbar daemon: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
}

/** The path of a request target; `null` for anything but an origin-form (`/path?query`) target. */
function requestUrl(request: IncomingMessage): URL | null {
  const target = request.url ?? "";
  if (!target.startsWith("/") || target.startsWith("//")) return null;
  try {
    return new URL(target, `http://${DAEMON_HOST}`);
  } catch {
    return null;
  }
}

class Daemon implements RunningDaemon {
  readonly info: DaemonInfo;
  readonly url: string;
  readonly closed: Promise<void>;
  readonly #server: Server;
  readonly #store: FeedbackStore;
  readonly #events: EventHub;
  readonly #upgrades: ReadonlySet<Duplex>;
  #closing: Promise<void> | undefined;
  #resolveClosed!: () => void;

  constructor(info: DaemonInfo, server: Server, store: FeedbackStore, events: EventHub, upgrades: ReadonlySet<Duplex>) {
    this.info = info;
    this.url = `http://${DAEMON_HOST}:${info.port}`;
    this.#server = server;
    this.#store = store;
    this.#events = events;
    this.#upgrades = upgrades;
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  get isClosing(): boolean {
    return this.#closing !== undefined;
  }

  close(): Promise<void> {
    this.#closing ??= this.#shutdown();
    return this.#closing;
  }

  async #shutdown(): Promise<void> {
    try {
      const serverClosed = new Promise<void>((resolve) => this.#server.close(() => resolve()));
      this.#server.closeIdleConnections();
      const force = setTimeout(() => this.#server.closeAllConnections(), HTTP_SHUTDOWN_GRACE_MS);
      await this.#events.close();
      // Upgrade sockets are outside the HTTP server's connection tracking; any still open (a refused upgrade
      // whose peer has not read the response) is destroyed, so that shutdown never waits on a peer.
      for (const socket of this.#upgrades) socket.destroy();
      await serverClosed;
      clearTimeout(force);
      // daemon.json goes before the lock, so a daemon that starts next never has its file removed by this one.
      await removeDaemonFile(this.#store.paths, this.info.token);
    } finally {
      await this.#store.close();
      this.#resolveClosed();
    }
  }
}

/**
 * Starts the Iterbar daemon for a project: takes the store lock (`store_locked` while another daemon serves the
 * project), listens on a random free port of 127.0.0.1 with a fresh 256-bit token, and writes
 * `.iterbar/daemon.json` (mode 0600), replacing one that an earlier daemon left behind.
 */
export async function startDaemon(options: StartDaemonOptions): Promise<RunningDaemon> {
  const onError = options.onError ?? defaultOnError;
  const store = await openFeedbackStore(options.projectRoot, options.now ? { now: options.now } : {});
  const token = randomBytes(32).toString("hex");
  const origins = new OriginAllowList();
  const slots = new SlotRegistry();
  const statusChanges = new KeyedSerializer();
  const events = new EventHub();
  // Every socket handed over by an upgrade, until it closes.
  const upgrades = new Set<Duplex>();
  // The port is known once the server listens; no request is handled before then.
  const policy: { port: number; token: string; origins: OriginAllowList } = { port: 0, token, origins };
  let daemon: Daemon | undefined;

  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    let cors = {};
    try {
      if (isPreflight(request.method, request.headers)) {
        const decision = authorizePreflight(request.headers, policy);
        if (!decision.allowed) throw decision.error;
        sendEmpty(response, 204, decision.headers);
        return;
      }
      const decision = authorize(request.headers, tokenFromAuthorization(request.headers.authorization), policy);
      cors = decision.headers;
      if (!decision.allowed) throw decision.error;
      if (daemon?.isClosing) throw shuttingDown();
      const url = requestUrl(request);
      const route = url ? matchRoute(request.method ?? "", url.pathname) : { kind: "not_found" as const };
      if (route.kind === "not_found") throw new DaemonHttpError(404, "not_found", "Not found");
      if (route.kind === "method_not_allowed") {
        throw new DaemonHttpError(405, "invalid_request", "Method not allowed", { allow: route.allow.join(", ") });
      }
      await handleRoute(route.name, {
        request, response, url: url as URL, params: route.params, headers: cors, store, origins, slots, events, statusChanges,
      });
    } catch (error) {
      const httpError = toHttpError(error);
      if (!httpError) onError(error);
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendError(response, httpError ?? new DaemonHttpError(500, "internal", "Internal error"), cors);
    }
  };

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    upgrades.add(socket);
    socket.once("close", () => upgrades.delete(socket));
    const decision = authorize(request.headers, tokenFromWebSocketProtocols(request.headers["sec-websocket-protocol"]), policy);
    if (!decision.allowed) return rejectUpgrade(socket, decision.error, decision.headers);
    if (daemon?.isClosing) return rejectUpgrade(socket, shuttingDown(), decision.headers);
    if (requestUrl(request)?.pathname !== daemonPath("events") || request.method !== "GET") {
      return rejectUpgrade(socket, new DaemonHttpError(404, "not_found", "Not found"), decision.headers);
    }
    events.accept(request, socket, head);
  };

  const server = createServer((request, response) => void handleRequest(request, response));
  server.on("upgrade", handleUpgrade);

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: DAEMON_HOST, port: 0, exclusive: true }, () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.on("error", onError);
    policy.port = (server.address() as AddressInfo).port;
    const info = parseMessage(daemonInfoSchema, {
      schemaVersion: SCHEMA_VERSION,
      host: DAEMON_HOST,
      port: policy.port,
      token,
      pid: process.pid,
      projectRoot: store.paths.projectRoot,
      startedAt: new Date().toISOString(),
    }, "daemon info");
    await writeDaemonFile(store.paths, info);
    daemon = new Daemon(info, server, store, events, upgrades);
    return daemon;
  } catch (error) {
    server.close();
    server.closeAllConnections();
    await events.close();
    for (const socket of upgrades) socket.destroy();
    try {
      // Publication can fail after the rename (syncing the directory); a daemon.json carrying this start's token
      // describes a daemon that never started, so it goes before the lock does. Another daemon's file stays.
      await removeDaemonFile(store.paths, token);
    } catch (cleanupError) {
      onError(cleanupError);
    } finally {
      await store.close();
    }
    throw error;
  }
}
