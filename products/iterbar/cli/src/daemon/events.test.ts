import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WEBSOCKET_SUBPROTOCOL, type DaemonEvent } from "iterbar";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { EventHub } from "./events.js";

const KIB = 1024;

let hub: EventHub;
let server: Server;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await hub.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** An event hub with a small buffer limit behind a bare loopback HTTP server; returns the server's port. */
async function listen(maxBufferedBytes: number): Promise<number> {
  hub = new EventHub({ maxBufferedBytes });
  server = createServer();
  server.on("upgrade", (request, socket, head) => hub.accept(request, socket, head));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

interface Client {
  readonly socket: WebSocket;
  readonly received: DaemonEvent[];
  readonly closed: Promise<number>;
}

async function connect(port: number): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/events`, [WEBSOCKET_SUBPROTOCOL]);
  sockets.push(socket);
  const received: DaemonEvent[] = [];
  socket.on("message", (data) => received.push(JSON.parse(String(data)) as DaemonEvent));
  const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, received, closed };
}

/** A `slots.reported` event whose JSON is about `bytes` long, tagged with `sequence`. */
function event(sequence: number, bytes: number): DaemonEvent {
  const pageUrl = `http://localhost:5173/${sequence}?pad=`;
  return {
    schemaVersion: 1,
    type: "slots.reported",
    report: { schemaVersion: 1, pageUrl: pageUrl + "x".repeat(Math.max(0, bytes - 150)), reportedAt: "2026-11-03T10:00:00.000Z", slots: [] },
  };
}

const sequenceOf = (received: DaemonEvent) =>
  received.type === "slots.reported" ? Number(new URL(received.report.pageUrl).pathname.slice(1)) : NaN;

describe("event backpressure", () => {
  it("disconnects a client instead of buffering one event larger than the limit", async () => {
    const port = await listen(64 * KIB);
    const client = await connect(port);

    hub.publish(event(1, KIB));
    await expect.poll(() => client.received.length).toBe(1);

    const oversized = event(2, 128 * KIB);
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(64 * KIB);
    hub.publish(oversized);
    // Terminated without a closing handshake, and the oversized event was never queued for it.
    expect(await client.closed).toBe(1006);
    expect(client.received.map(sequenceOf)).toEqual([1]);

    // The hub keeps serving: a client that connects next gets the next event.
    const next = await connect(port);
    hub.publish(event(3, KIB));
    await expect.poll(() => next.received.map(sequenceOf)).toEqual([3]);
  });

  it("disconnects a client that stops reading once an event would take it past the limit, while others keep receiving", { timeout: 30_000 }, async () => {
    const port = await listen(256 * KIB);
    const stalled = await connect(port);
    const healthy = await connect(port);
    // The stalled client stops reading, so the daemon's kernel buffers and then its own buffer fill up.
    stalled.socket.pause();

    const count = 1024;
    for (let sequence = 1; sequence <= count; sequence += 1) {
      hub.publish(event(sequence, 16 * KIB));
      await expect.poll(() => healthy.received.length, { interval: 1 }).toBe(sequence);
    }
    expect(healthy.received.map(sequenceOf)).toEqual(Array.from({ length: count }, (_, index) => index + 1));

    stalled.socket.resume();
    expect(await stalled.closed).toBe(1006);
    // It got what had reached the kernel before it was dropped, in order, and never the rest.
    const got = stalled.received.map(sequenceOf);
    expect(got.length).toBeLessThan(count);
    expect(got).toEqual(Array.from({ length: got.length }, (_, index) => index + 1));
    expect(healthy.socket.readyState).toBe(WebSocket.OPEN);
  });
});
