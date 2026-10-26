import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { DiffpanelStore } from "@diffpanel/storage";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ReviewAdapter } from "./adapter.js";
import { createServer } from "./server.js";
import { selectedContext } from "./context.js";
import { TOOLS, UI_URI, CONTEXT_CHARACTERS, MAX_FILE_BYTES } from "./contracts.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(after = Buffer.from("saved after\n")) {
  const home = await mkdtemp(join(tmpdir(), "diffpanel-chatgpt-"));
  const store = await DiffpanelStore.open(home);
  cleanups.push(async () => { store.close(); await rm(home, { recursive: true, force: true }); });
  const receipt = await store.createPreparedRun({
    repositoryId: "repo", repositoryRoot: home, repositoryName: "example",
    scope: { type: "worktree", baseRef: "HEAD", baseSha: "abc" }, skipped: [],
    files: [{ id: "file", filePath: "example.ts", oldPath: null, status: "modified", beforeContent: Buffer.from("saved before\n"), afterContent: after,
      additions: 1, deletions: 1, language: "typescript", size: after.length,
      items: [{ id: "item", kind: "hunk", filePath: "example.ts", oldPath: null, status: "modified", ordinal: 0, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, patch: "@@ -1 +1 @@\n-saved before\n+saved after\n", contentHash: "item-hash" }],
    }],
  });
  const review = {
    schemaVersion: 1 as const, runId: receipt.runId,
    diagramAssessment: { kind: "other" as const, reasoning: "Single value change.", overviewOmissionReason: "No architecture changes." },
    chapters: [{ id: "chapter", parentId: null, order: 1, title: "Saved value", summary: "The saved value changed.", itemRefs: ["item"], keyChanges: [] }],
    prologue: { motivation: "Inspect saved evidence.", outcome: "One value replaced.", diagram: null,
      keyChanges: [{ summary: "Value updated", description: "Saved before becomes saved after." }],
      focusAreas: [{ type: "testing-gap" as const, severity: "info" as const, title: "Check behavior", description: "Confirm the replacement.", locations: ["example.ts"] }],
      complexity: { level: "low" as const, reasoning: "Single file." } },
  };
  await store.publish(receipt.runId, review);
  return { store, receipt, review, home, adapter: new ReviewAdapter(store, new Set([receipt.runId])) };
}

describe("authorized immutable review adapter", () => {
  it("requires explicit authorization and hides unauthorized runs", async () => {
    const { store, receipt, adapter } = await fixture();
    expect(() => new ReviewAdapter(store, new Set())).toThrow(/authorization/);
    expect(adapter.list().runs.map((run) => run.runId)).toEqual([receipt.runId]);
    const other = new ReviewAdapter(store, new Set(["another-run"]));
    expect(other.list().runs).toEqual([]);
    await expect(other.open(receipt.runId)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(other.evidence(receipt.runId, "x", "item")).rejects.toMatchObject({ code: "unauthorized" });
  });
  it("reads saved blobs even after the working file changes", async () => {
    const { adapter, receipt, home } = await fixture();
    const run = await adapter.open(receipt.runId);
    await writeFile(join(home, "example.ts"), "LIVE CONTENT MUST NOT APPEAR");
    const evidence = await adapter.evidence(receipt.runId, run.revision, "item");
    expect(evidence.before).toBe("saved before\n");
    expect(evidence.after).toBe("saved after\n");
    await expect(adapter.evidence(receipt.runId, run.revision, "missing")).rejects.toMatchObject({ code: "missing_item" });
    await expect(adapter.evidence(receipt.runId, "wrong-revision", "item")).rejects.toMatchObject({ code: "revision_changed" });
  });
  it("pins review content across republishing and validates opaque pagination", async () => {
    const { store, adapter, receipt, review } = await fixture();
    const original = await adapter.open(receipt.runId);
    await store.publish(receipt.runId, { ...review, chapters: [{ ...review.chapters[0], summary: "A new explanation." }] });
    await expect(adapter.evidence(receipt.runId, original.revision, "item")).rejects.toMatchObject({ code: "revision_changed" });
    expect(() => adapter.list(20, "invalid-cursor")).toThrow(/invalid or expired/);
  });
  it.each([Buffer.from("binary\0file"), Buffer.from([0xff, 0xfe])])("rejects binary or invalid UTF-8 evidence", async (content) => {
    const { adapter, receipt } = await fixture(content);
    const run = await adapter.open(receipt.runId);
    await expect(adapter.evidence(receipt.runId, run.revision, "item")).rejects.toMatchObject({ code: "binary" });
  });
  it("bounds file evidence and never leaks server paths on missing data", async () => {
    const { adapter, receipt } = await fixture(Buffer.alloc(MAX_FILE_BYTES + 1, "a"));
    const run = await adapter.open(receipt.runId);
    await expect(adapter.evidence(receipt.runId, run.revision, "item")).rejects.toMatchObject({ code: "too_large" });
    const missing = new ReviewAdapter((await fixture()).store, new Set(["missing"]));
    await expect(missing.open("missing")).rejects.toMatchObject({ code: "unavailable", message: "This saved review is missing, malformed, or unavailable." });
  });
  it("bounds focused model context while preserving snapshot and revision identity", async () => {
    const { adapter, receipt } = await fixture();
    const run = await adapter.open(receipt.runId);
    run.review.chapters[0]!.summary = "x".repeat(20000);
    const context = selectedContext(run, "chapter");
    expect(context.content[0]!.text.length).toBeLessThanOrEqual(CONTEXT_CHARACTERS);
    expect(context.structuredContent).toMatchObject({ runId: receipt.runId, revision: run.revision, snapshotHash: run.manifest.snapshotHash, truncated: true });
    const evidence = await adapter.evidence(receipt.runId, run.revision, "item");
    expect(selectedContext(run, "chapter", evidence).content[0]!.text).toContain("saved after");
    expect(() => selectedContext(run, "chapter", { ...evidence, runId: "other" })).toThrow(/another saved review/);
  });
});

it("advertises a thread entrypoint and exercises tools/resources over MCP", async () => {
  const { adapter, receipt } = await fixture();
  const server = createServer(adapter, "<!doctype html><h1>Diffpanel</h1>");
  const client = new Client({ name: "viewer-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(async () => { await client.close(); await server.close(); });
  const tools = await client.listTools();
  expect(tools.tools).toHaveLength(4);
  expect(tools.tools.find((tool) => tool.name === TOOLS.panel)?._meta?.["openai/ui"]).toMatchObject({ entrypoints: [{ type: "thread" }] });
  expect(tools.tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);
  const resource = await client.readResource({ uri: UI_URI });
  expect(resource.contents[0]).toMatchObject({ mimeType: "text/html;profile=mcp-app" });
  const opened = await client.callTool({ name: TOOLS.open, arguments: { runId: receipt.runId } });
  const data = opened._meta?.diffpanel as Awaited<ReturnType<ReviewAdapter["open"]>>;
  expect(data.manifest.runId).toBe(receipt.runId);
  expect(JSON.stringify(opened.content)).not.toContain("saved before");
  const evidence = await client.callTool({ name: TOOLS.evidence, arguments: { runId: receipt.runId, revision: data.revision, itemId: "item" } });
  expect(evidence._meta?.diffpanel).toMatchObject({ before: "saved before\n", after: "saved after\n" });
  const denied = await client.callTool({ name: TOOLS.open, arguments: { runId: "unauthorized" } });
  expect(denied.isError).toBe(true);
  expect(denied.structuredContent).toMatchObject({ error: { code: "unauthorized" } });
});
