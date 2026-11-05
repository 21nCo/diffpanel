import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { iterbarPaths } from "iterbar/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { temporaryProject } from "../store/test-support/helpers.js";
import { DaemonClient } from "./daemon-client.js";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

let root: string;
let cleanup: () => Promise<void>;
let server: Server | undefined;

beforeEach(async () => {
  ({ root, cleanup } = await temporaryProject());
});

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
  server = undefined;
  await cleanup();
});

/** A stand-in daemon that answers every request with `handler`, recorded in the project's daemon.json. */
async function fakeDaemon(handler: Handler, requestTimeoutMs = 5_000): Promise<DaemonClient> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const { daemonFile, directory } = iterbarPaths(root);
  await mkdir(directory, { recursive: true });
  await writeFile(daemonFile, JSON.stringify({
    schemaVersion: 1, host: "127.0.0.1", port, token: "a".repeat(64), pid: process.pid, projectRoot: root,
    startedAt: "2026-11-05T10:00:00.000Z",
  }));
  return new DaemonClient({ projectRoot: root, requestTimeoutMs });
}

/** Sends the headers and part of a body that promises more, then drops the connection. */
const cutShort: Handler = (_request, response) => {
  response.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
  response.write('{"schemaVersion":1,"items":[', () => setTimeout(() => response.socket?.destroy(), 20));
};

/** Sends the headers and part of a body, then stops sending. */
const stall: Handler = (_request, response) => {
  response.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
  response.write('{"schemaVersion":1,"items":[');
};

const unavailable = expect.objectContaining({ code: "daemon_unavailable", message: expect.stringContaining("iterbar dev") });

describe("DaemonClient response bodies", () => {
  it("reports a connection dropped after the headers as daemon_unavailable, for every kind of call", async () => {
    const client = await fakeDaemon(cutShort);
    const calls: Array<() => Promise<unknown>> = [
      () => client.listFeedback(),
      () => client.getFeedback("feedback-1"),
      () => client.getAttachment("feedback-1", "attachment-1"),
      () => client.reply("feedback-1", { kind: "agent", name: null }, "On it."),
      () => client.setStatus("feedback-1", "working"),
      () => client.listSlots(),
    ];
    for (const run of calls) await expect(run()).rejects.toEqual(unavailable);
  });

  it("reports an error response cut short as daemon_unavailable", async () => {
    const client = await fakeDaemon((_request, response) => {
      response.writeHead(404, { "content-type": "application/json", "content-length": "1000" });
      response.write('{"schemaVersion":1,"error":', () => setTimeout(() => response.socket?.destroy(), 20));
    });
    await expect(client.getFeedback("feedback-1")).rejects.toEqual(unavailable);
  });

  it("reports a body that stops arriving as daemon_unavailable once the request timeout passes", async () => {
    const client = await fakeDaemon(stall, 300);
    await expect(client.listFeedback()).rejects.toEqual(unavailable);
    await expect(client.getAttachment("feedback-1", "attachment-1")).rejects.toEqual(unavailable);
  });

  it("passes the caller's abort through while a body is arriving", async () => {
    const client = await fakeDaemon(stall);
    const controller = new AbortController();
    const listing = client.listFeedback({}, controller.signal);
    setTimeout(() => controller.abort(new Error("cancelled by the caller")), 100);
    await expect(listing).rejects.toThrow("cancelled by the caller");
  });

  it("reports a complete body that is not JSON as internal", async () => {
    const client = await fakeDaemon((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{not json");
    });
    await expect(client.listFeedback()).rejects.toEqual(expect.objectContaining({ code: "internal", message: expect.stringContaining("not valid JSON") }));
  });
});
