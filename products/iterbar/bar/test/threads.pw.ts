import { SCHEMA_VERSION } from "iterbar";
import { comment, fakeDaemon } from "./support/fake-daemon.js";
import { expect, inBar, mountBar, PRICING, registerSlots, test } from "./support/fixtures.js";

test.describe("threads from the daemon", () => {
  test("lists threads, then follows created and updated events from the event stream", async ({ page, openFixture, fixtureServer }) => {
    const first = comment("Make the button bigger");
    const daemon = await fakeDaemon(page, fixtureServer.origin, [first]);
    await openFixture();
    await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });

    await expect(inBar(page, "[data-role=status]")).toHaveText("Connected");
    const threads = inBar(page, ".thread");
    await expect(threads).toHaveCount(1);
    await expect(threads.first().locator(".badge")).toHaveText("Open");
    await expect(threads.first().locator(".thread-text")).toHaveText("Make the button bigger");
    expect(daemon.requests.find((request) => request.path === "/feedback")?.authorization).toBe(`Bearer ${daemon.token}`);

    // The user opens the thread; updates must not close it or move it.
    await threads.first().locator("summary").click();
    await expect(threads.first().locator("details")).toHaveAttribute("open", "");

    daemon.send({
      schemaVersion: SCHEMA_VERSION,
      type: "feedback.updated",
      feedback: {
        ...first,
        status: "working",
        updatedAt: new Date(Date.parse(first.updatedAt) + 1000).toISOString(),
        replies: [{ id: "r1", author: { kind: "agent", name: "Codex" }, text: "On it.", createdAt: first.updatedAt }],
      },
    });
    await expect(threads.first().locator(".badge")).toHaveText("Working");
    await expect(threads.first().locator(".reply")).toHaveText("Agent (Codex)On it.");
    await expect(threads.first().locator(".thread-count")).toHaveText("1 reply");
    await expect(threads.first().locator("details")).toHaveAttribute("open", "");

    const second = comment("Typo in the heading");
    daemon.send({ schemaVersion: SCHEMA_VERSION, type: "feedback.created", feedback: second });
    await expect(threads).toHaveCount(2);
    await expect(threads.first().locator(".thread-text")).toHaveText("Typo in the heading");
    await expect(inBar(page, "[data-section=threads] h2")).toHaveText("Feedback (2)");
  });

  test("ignores malformed events, events from another schema version and stale copies", async ({ page, openFixture, fixtureServer }) => {
    const item = comment("Original", { status: "working" });
    const daemon = await fakeDaemon(page, fixtureServer.origin, [item]);
    await openFixture();
    await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
    await expect(inBar(page, ".thread .badge")).toHaveText("Working");

    daemon.send("not json");
    daemon.send({ schemaVersion: 2, type: "feedback.updated", feedback: { ...item, status: "done" } } as never);
    daemon.send({ schemaVersion: SCHEMA_VERSION, type: "feedback.updated", feedback: { ...item, status: "bogus" } } as never);
    daemon.send({
      schemaVersion: SCHEMA_VERSION, type: "feedback.updated",
      feedback: { ...item, status: "open", updatedAt: new Date(Date.parse(item.updatedAt) - 1000).toISOString() },
    });
    // A valid event after the bad ones proves they were processed (and skipped) before it.
    daemon.send({ schemaVersion: SCHEMA_VERSION, type: "feedback.created", feedback: comment("Marker") });
    await expect(inBar(page, ".thread")).toHaveCount(2);
    await expect(inBar(page, `[data-feedback-id=${item.id}] .badge`)).toHaveText("Working");
  });

  test("reconnects after the stream drops and lists again to catch up", async ({ page, openFixture, fixtureServer }) => {
    const item = comment("Before the drop");
    const daemon = await fakeDaemon(page, fixtureServer.origin, [item]);
    await openFixture();
    await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
    await expect(inBar(page, ".thread")).toHaveCount(1);

    // Published while the socket is down: only the next listing can deliver it.
    daemon.items = [{ ...item, status: "done", updatedAt: new Date(Date.parse(item.updatedAt) + 1000).toISOString() }];
    await daemon.sockets[0]!.close({ code: 1001, reason: "going away" });
    await expect(inBar(page, "[data-role=status]")).toHaveText("Reconnecting…");
    await expect(inBar(page, "[data-role=status]")).toHaveText("Connected", { timeout: 5000 });
    await expect(inBar(page, ".thread .badge")).toHaveText("Done");
    expect(daemon.requests.filter((request) => request.path === "/feedback")).toHaveLength(2);
  });

  test("stops for good when the daemon rejects the token", async ({ page, openFixture, fixtureServer }) => {
    const daemon = await fakeDaemon(page, fixtureServer.origin, [], { socket: false });
    daemon.rejectToken = true;
    await openFixture();
    await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
    await expect(inBar(page, "[data-role=status]")).toHaveText("Token rejected");
    await expect(inBar(page, "[data-role=status-detail]")).toContainText("rejected the token");
    const requests = daemon.requests.length;
    await page.waitForTimeout(2500);
    expect(daemon.requests.length).toBe(requests);
  });

  test("shows why it is offline without a configuration, and refuses a non-loopback daemon URL", async ({ page, openFixture }) => {
    await openFixture();
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await mountBar(page);
    await expect(inBar(page, "[data-role=status]")).toHaveText("Offline");
    await expect(inBar(page, "[data-role=status-detail]")).toContainText("No daemon URL and token");
    await page.evaluate(() => {
      const bar = document.querySelector("iterbar-bar")!;
      bar.daemonUrl = "http://example.com:4000";
      bar.token = "f".repeat(64);
    });
    await expect(inBar(page, "[data-role=status-detail]")).toContainText("must be http://127.0.0.1:<port>");
    expect(requests.filter((url) => !url.startsWith("http://127.0.0.1:"))).toEqual([]);
  });

  test("reports the page's slots, filed without the iterbar parameter, and again after a switch", async ({ page, openFixture, fixtureServer }) => {
    const daemon = await fakeDaemon(page, fixtureServer.origin);
    await openFixture("/shop?iterbar=pricing:v2#top");
    await registerSlots(page, [PRICING]);
    await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
    await expect.poll(() => daemon.slotReports.length).toBe(1);
    expect(daemon.slotReports[0]).toMatchObject({
      schemaVersion: 1,
      pageUrl: `${fixtureServer.origin}/shop`,
      slots: [{ slot: "pricing", versions: ["v1", "v2", "v3"], defaultVersion: "v1", activeVersion: "v2", mounts: 1 }],
    });
    await inBar(page, "[data-version=v3]").click();
    await expect.poll(() => daemon.slotReports.at(-1)?.slots[0]?.activeVersion).toBe("v3");
    expect(daemon.slotReports.at(-1)?.pageUrl).toBe(`${fixtureServer.origin}/shop`);
  });

  test("closes the stream and stops retrying when it is removed from the page", async ({ page, openFixture, fixtureServer }) => {
    const daemon = await fakeDaemon(page, fixtureServer.origin);
    await openFixture();
    await mountBar(page, { daemonUrl: daemon.url, token: daemon.token });
    await expect(inBar(page, "[data-role=status]")).toHaveText("Connected");
    await page.evaluate(() => document.querySelector("iterbar-bar")!.remove());
    await expect.poll(() => daemon.closedSockets.length).toBe(1);
    const requests = daemon.requests.length;
    await page.waitForTimeout(1500);
    expect(daemon.sockets).toHaveLength(0);
    expect(daemon.requests.length).toBe(requests);
  });
});
