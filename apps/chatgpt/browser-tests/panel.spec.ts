import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { OpenReview } from "../src/contracts.js";

const files = ["first", "second"].map((name) => ({
  id: name, filePath: `${name}.ts`, oldPath: null, status: "modified" as const, beforeBlob: "a".repeat(64), afterBlob: "b".repeat(64), additions: 1, deletions: 1, language: "typescript", size: 12,
  items: [{ id: `${name}-item`, kind: "hunk" as const, filePath: `${name}.ts`, oldPath: null, status: "modified" as const, ordinal: 0, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, patch: `@@ -1 +1 @@\n-before ${name}\n+after ${name}\n`, contentHash: "hash" }],
}));
const run: OpenReview = {
  summary: { runId: "saved-run", repositoryName: "fixture", reviewTitle: "Saved review fixture", snapshotHash: "c".repeat(64), createdAt: "2026-10-01T00:00:00.000Z" }, revision: "d".repeat(64),
  manifest: { schemaVersion: 1, runId: "saved-run", repositoryId: "fixture", repositoryRoot: "/fixture", repositoryName: "fixture", createdAt: "2026-10-01T00:00:00.000Z", snapshotHash: "c".repeat(64), scope: { type: "worktree", baseRef: "HEAD", baseSha: "abc" }, files, skipped: [] },
  review: { schemaVersion: 1, runId: "saved-run", chapters: [
    { id: "chapter", parentId: null, order: 1, title: "Saved behavior", summary: "Inspect both saved values.", itemRefs: ["first-item", "second-item"], keyChanges: [] },
  ], prologue: { motivation: "Saved evidence", outcome: "Two changed values", diagram: "flowchart LR\n Before --> After", keyChanges: [{ summary: "Values changed", description: "Two replacements" }], focusAreas: [{ type: "testing-gap", severity: "info", title: "Verify values", description: "Confirm saved evidence", locations: ["first.ts"] }], complexity: { level: "low", reasoning: "Two edits" } } },
};

let server: ReturnType<typeof createServer>;
let base: string;
test.beforeAll(async () => {
  const ui = await readFile(new URL("../dist/review.html", import.meta.url));
  server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    if (request.url === "/panel") { response.end(ui); return; }
    const supported = request.url !== "/fallback";
    response.end(`<!doctype html><script>
      const run = ${JSON.stringify(run)};
      window.contexts=[];
      window.addEventListener('message',async(event)=>{
        const message=event.data;if(!message || message.jsonrpc!=='2.0')return;
        const reply=(result)=>event.source.postMessage({jsonrpc:'2.0',id:message.id,result},event.origin);
        if(message.method==='ui/initialize')reply({protocolVersion:message.params.protocolVersion,hostInfo:{name:'test-host',version:'1'},hostCapabilities:{serverTools:{},${supported ? "updateModelContext:{text:{}}" : ""}},hostContext:{theme:'light'}});
        else if(message.method==='ui/notifications/initialized')event.source.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{content:[],_meta:{diffpanel:run}}},event.origin);
        else if(message.method==='ui/update-model-context'){window.contexts.push(message.params);reply({});}
        else if(message.method==='tools/call'){
          const args=message.params.arguments;const file=run.manifest.files.find(f=>f.items[0].id===args.itemId);
          if(message.params.name==='diffpanel_read_evidence'){
            await new Promise(r=>setTimeout(r,file.id==='first'?250:10));
            reply({content:[],_meta:{diffpanel:{runId:run.summary.runId,revision:run.revision,file,item:file.items[0],before:'before '+file.id+'\\n',after:'after '+file.id+'\\n'}}});
          }else reply({content:[],structuredContent:{runs:[run.summary],nextCursor:null}});
        }else if(message.id!==undefined)reply({});
      });
    </script><iframe title="Diffpanel test panel" src="/panel" style="width:100%;height:850px;border:0"></iframe>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });

test("renders chapters/diagrams/saved diffs and shares immutable item context", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  const panel = page.frameLocator("iframe");
  await expect(panel.getByRole("heading", { name: "Saved review fixture" })).toBeVisible();
  await expect(panel.locator(".diagram-canvas svg")).toBeVisible();
  await panel.getByRole("combobox").selectOption("chapter");
  await panel.getByRole("button", { name: "Open saved diff for second.ts" }).click();
  await expect(panel.getByLabel("Saved diff contents")).toContainText("after second");
  await panel.getByRole("button", { name: "Saved before", exact: true }).click();
  await expect(panel.getByLabel("Saved before contents")).toContainText("before second");
  await panel.getByRole("button", { name: "Saved after", exact: true }).click();
  await expect(panel.getByLabel("Saved after contents")).toContainText("after second");
  await expect.poll(() => page.evaluate(() => (window as unknown as { contexts: { structuredContent: object }[] }).contexts.at(-1)?.structuredContent)).toMatchObject({ runId: "saved-run", revision: run.revision, chapterId: "chapter", itemId: "second-item" });
  expect(errors).toEqual([]);
});

test("ignores stale evidence and clears context when returning to the library", async ({ page }) => {
  await page.goto(base);
  const panel = page.frameLocator("iframe");
  await panel.getByRole("button", { name: "Open saved diff for first.ts" }).click();
  await panel.getByRole("button", { name: "Open saved diff for second.ts" }).click();
  await expect(panel.getByLabel("Saved diff contents")).toContainText("after second");
  await page.waitForTimeout(350);
  await expect(panel.getByLabel("Saved diff contents")).not.toContainText("after first");
  await panel.getByRole("button", { name: "Review library", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { contexts: { structuredContent: object }[] }).contexts.at(-1)?.structuredContent)).toMatchObject({ runId: null });
});

test("provides manual selected-context fallback on unsupported hosts", async ({ page }) => {
  await page.goto(`${base}/fallback`);
  const panel = page.frameLocator("iframe");
  await panel.getByRole("combobox").selectOption("chapter");
  await expect(panel.getByText("This host cannot share context.", { exact: false })).toBeVisible();
  await panel.getByText("Selected context / manual fallback", { exact: true }).click();
  await expect(panel.getByLabel("Selected review context")).toHaveValue(/saved-run[\s\S]*Saved behavior/);
});
