import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WEBSOCKET_SUBPROTOCOL, type DaemonEvent } from "iterbar";
import { WebSocket, WebSocketServer } from "ws";

/** Largest message a client may send; clients send no application messages, so anything bigger is abuse. */
const MAX_CLIENT_MESSAGE_BYTES = 1024;

/** Most bytes buffered for one client; a client an event would take past it is disconnected instead. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/** How long clients get to answer the closing handshake on shutdown before their sockets are dropped. */
const CLOSE_GRACE_MS = 1000;

/** WebSocket close code for a server going away. */
const GOING_AWAY = 1001;

export interface EventHubOptions {
  /** Most bytes buffered for one client; defaults to {@link MAX_BUFFERED_BYTES}. */
  readonly maxBufferedBytes?: number;
}

/** The `/events` WebSocket clients and the daemon events pushed to them. */
export class EventHub {
  readonly #maxBufferedBytes: number;
  readonly #server = new WebSocketServer({
    noServer: true,
    clientTracking: true,
    perMessageDeflate: false,
    maxPayload: MAX_CLIENT_MESSAGE_BYTES,
    // Selects `iterbar.v1`; the token protocol a client also offers is never echoed back.
    handleProtocols: (protocols) => (protocols.has(WEBSOCKET_SUBPROTOCOL) ? WEBSOCKET_SUBPROTOCOL : false),
  });

  constructor(options: EventHubOptions = {}) {
    this.#maxBufferedBytes = options.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
  }

  /** Completes an already-authorized upgrade. */
  accept(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.#server.handleUpgrade(request, socket, head, (client) => {
      client.on("error", () => client.terminate());
      // Clients send no application messages; anything they send is ignored.
      client.on("message", () => undefined);
    });
  }

  /**
   * Sends an event to every connected client. A client whose buffered bytes plus this event would exceed the
   * limit is disconnected instead, so no client ever has more than the limit buffered; the others still get it.
   */
  publish(event: DaemonEvent): void {
    const data = JSON.stringify(event);
    const bytes = Buffer.byteLength(data);
    for (const client of this.#server.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.bufferedAmount + bytes > this.#maxBufferedBytes) {
        client.terminate();
        continue;
      }
      client.send(data);
    }
  }

  /** Closes every client with 1001 (going away), dropping those that do not finish the handshake in time. */
  async close(): Promise<void> {
    const clients = [...this.#server.clients];
    await Promise.all(clients.map((client) => new Promise<void>((resolve) => {
      if (client.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      const timer = setTimeout(() => client.terminate(), CLOSE_GRACE_MS);
      client.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      client.close(GOING_AWAY, "Iterbar daemon is shutting down");
    })));
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}
