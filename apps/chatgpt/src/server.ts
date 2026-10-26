import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { OpenAIExtensions } from "@openai/mcp-extensions/server";
import type { OpenAIUiResourceMetadata, OpenAIUiToolMetadata } from "@openai/mcp-extensions/server";
import { DiffpanelStore } from "@diffpanel/storage";
import { z } from "zod";
import { ReviewAdapter, ViewerError } from "./adapter.js";
import { TOOLS, UI_URI } from "./contracts.js";

export function createServer(adapter: ReviewAdapter, html: string) {
  const server = new McpServer({ name: "diffpanel", version: "0.1.0" });
  new OpenAIExtensions(server);
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const handle = async (operation: () => Promise<object> | object, privateData = false) => {
    try {
      const data = await operation();
      return privateData
        ? { content: [{ type: "text" as const, text: "Saved Diffpanel review loaded. Use the panel to select a chapter or item; all evidence belongs to this immutable run." }], _meta: { diffpanel: data } }
        : { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data as Record<string, unknown> };
    } catch (error) {
      const failure = error instanceof ViewerError ? { code: error.code, message: error.message } : { code: "unavailable", message: "The Diffpanel service could not complete this request." };
      return { isError: true, content: [{ type: "text" as const, text: failure.message }], structuredContent: { error: failure } };
    }
  };
  registerAppResource(server, "diffpanel-review", UI_URI, {}, async () => ({ contents: [{
    uri: UI_URI, mimeType: RESOURCE_MIME_TYPE, text: html,
    _meta: {
      ui: { csp: { connectDomains: [], resourceDomains: [] } },
      "openai/ui": { preferredDisplayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] } satisfies OpenAIUiResourceMetadata,
    },
  }] }));
  registerAppTool(server, TOOLS.panel, {
    title: "Open Diffpanel review panel", description: "Open the read-only Diffpanel saved-review library beside this conversation.",
    inputSchema: { runId: z.string().min(1).max(200).optional() }, annotations,
    _meta: { ui: { resourceUri: UI_URI }, "openai/ui": { entrypoints: [{ type: "thread" }] } satisfies OpenAIUiToolMetadata },
  }, ({ runId }) => handle(() => runId ? adapter.open(runId) : { library: adapter.list() }, true));
  registerAppTool(server, TOOLS.list, {
    title: "List authorized saved reviews", description: "List explicitly authorized immutable Diffpanel reviews. Empty pages may have a nextCursor; continue pagination.",
    inputSchema: { limit: z.number().int().min(1).max(50).default(20), cursor: z.string().max(4096).optional() }, annotations,
    _meta: { ui: { resourceUri: UI_URI } },
  }, ({ limit, cursor }) => handle(() => adapter.list(limit, cursor)));
  registerAppTool(server, TOOLS.open, {
    title: "Open saved Diffpanel review", description: "Open one authorized saved run. UI receives chapters and manifest; select evidence in the panel to share focused context.",
    inputSchema: { runId: z.string().min(1).max(200) }, annotations,
    _meta: { ui: { resourceUri: UI_URI } },
  }, ({ runId }) => handle(() => adapter.open(runId), true));
  registerAppTool(server, TOOLS.evidence, {
    title: "Read saved item evidence", description: "Read saved before/after file contents for an item in the exact selected run and revision. Never reads current repository files.",
    inputSchema: { runId: z.string().min(1).max(200), revision: z.string().regex(/^[a-f0-9]{64}$/), itemId: z.string().min(1).max(200) }, annotations,
    _meta: { ui: { visibility: ["app"] } },
  }, ({ runId, revision, itemId }) => handle(() => adapter.evidence(runId, revision, itemId), true));
  return server;
}

async function main() {
  const home = process.env.DIFFPANEL_HOME;
  const allowedRuns = new Set((process.env.DIFFPANEL_RUN_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean));
  if (!home || allowedRuns.size === 0) throw new Error("Set DIFFPANEL_HOME and explicitly authorize runs with DIFFPANEL_RUN_IDS.");
  const store = await DiffpanelStore.open(home, { recover: false });
  const html = await readFile(new URL("./review.html", import.meta.url), "utf8");
  const server = createServer(new ReviewAdapter(store, allowedRuns), html);
  server.server.onclose = () => store.close();
  await server.connect(new StdioServerTransport());
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((error) => { console.error(error instanceof Error ? error.message : "Diffpanel failed to start."); process.exitCode = 1; });
}
