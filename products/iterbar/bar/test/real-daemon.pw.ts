import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type RunningDaemon } from "@iterbar/cli/daemon";
import { bearerAuthorization, SCHEMA_VERSION, type Feedback } from "iterbar";
import { expect, inBar, mountBar, PRICING, registerSlots, test } from "./support/fixtures.js";

// The bar against the real daemon from @iterbar/cli: its token check, origin allow-list, CORS preflights and
// WebSocket subprotocols, as Chromium enforces them. The test plays the agent with Node.js fetch.

let root: string;
let daemon: RunningDaemon;

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "iterbar-bar-")));
  daemon = await startDaemon({ projectRoot: root });
});

test.afterEach(async () => {
  await daemon.close();
  await rm(root, { recursive: true, force: true });
});

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { authorization: bearerAuthorization(daemon.info.token) };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${daemon.url}${path}`, { method, headers, body: payload });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return (response.status === 204 ? undefined : await response.json()) as T;
}

test("connects once its origin is registered, reports slots and follows an agent's work live", async ({ page, openFixture, fixtureServer }) => {
  await openFixture("/shop?iterbar=pricing:v2");
  await registerSlots(page, [PRICING]);
  await mountBar(page, { daemonUrl: daemon.url, token: daemon.info.token });

  // The daemon refuses pages from origins nobody registered; the bar keeps retrying.
  await expect(inBar(page, "[data-role=status]")).toHaveText("Reconnecting…");
  await expect(inBar(page, "[data-role=status-detail]")).toContainText("is this origin registered?");

  await call("POST", "/origins", { schemaVersion: SCHEMA_VERSION, origins: [fixtureServer.origin] });
  await expect(inBar(page, "[data-role=status]")).toHaveText("Connected", { timeout: 10_000 });

  await expect.poll(async () => (await call<{ pages: unknown[] }>("GET", "/slots")).pages).toEqual([
    expect.objectContaining({
      pageUrl: `${fixtureServer.origin}/shop`,
      slots: [{ slot: "pricing", versions: ["v1", "v2", "v3"], defaultVersion: "v1", activeVersion: "v2", mounts: 1 }],
    }),
  ]);

  const form = new FormData();
  form.append("feedback", JSON.stringify({
    schemaVersion: SCHEMA_VERSION, kind: "comment", text: "The price is unreadable", pageUrl: `${fixtureServer.origin}/shop`,
    target: null, activeVariants: [{ slot: "pricing", version: "v2" }], screenshotUnavailableReason: null, evidenceWindow: null,
  }));
  const created = await call<Feedback>("POST", "/feedback", form);
  const thread = inBar(page, `[data-feedback-id="${created.id}"]`);
  await expect(thread.locator(".thread-text")).toHaveText("The price is unreadable");
  await expect(thread.locator(".badge")).toHaveText("Open");

  await call("POST", `/feedback/${created.id}/status`, { schemaVersion: SCHEMA_VERSION, status: "working" });
  await expect(thread.locator(".badge")).toHaveText("Working");
  await call("POST", `/feedback/${created.id}/replies`, {
    schemaVersion: SCHEMA_VERSION, author: { kind: "agent", name: "Codex" }, text: "Raised the contrast.",
  });
  await call("POST", `/feedback/${created.id}/status`, { schemaVersion: SCHEMA_VERSION, status: "done" });
  await expect(thread.locator(".badge")).toHaveText("Done");
  await expect(thread.locator(".thread-count")).toHaveText("1 reply");
  await thread.locator("summary").click();
  await expect(thread.locator(".reply")).toHaveText("Agent (Codex)Raised the contrast.");

  // Switching a version reaches the daemon too.
  await inBar(page, "[data-version=v3]").click();
  await expect.poll(async () => {
    const { pages } = await call<{ pages: { slots: { activeVersion: string }[] }[] }>("GET", "/slots");
    return pages[0]?.slots[0]?.activeVersion;
  }).toBe("v3");
});

test("shows a rejected token from the real daemon", async ({ page, openFixture, fixtureServer }) => {
  await call("POST", "/origins", { schemaVersion: SCHEMA_VERSION, origins: [fixtureServer.origin] });
  await openFixture();
  await mountBar(page, { daemonUrl: daemon.url, token: "f".repeat(64) });
  await expect(inBar(page, "[data-role=status]")).toHaveText("Token rejected");
});
