import { test, expect, chromium } from "@playwright/test";
import { DiffpanelStore } from "@diffpanel/storage";
import { ReviewAdapter } from "../src/adapter.js";

// Opt-in live acceptance test. Use a dedicated signed-in test conversation with
// Diffpanel installed and its panel already open. Selectors are explicit because
// ChatGPT's composer/transcript markup varies by rollout and client version.
test("live ChatGPT panel and selected-context follow-up", async () => {
  const { CHATGPT_CDP_URL, CHATGPT_TEST_URL, CHATGPT_COMPOSER_SELECTOR, CHATGPT_ASSISTANT_SELECTOR, DIFFPANEL_HOME, DIFFPANEL_TEST_RUN_ID } = process.env;
  test.skip(!CHATGPT_CDP_URL || !CHATGPT_TEST_URL || !CHATGPT_COMPOSER_SELECTOR || !CHATGPT_ASSISTANT_SELECTOR || !DIFFPANEL_HOME || !DIFFPANEL_TEST_RUN_ID, "Requires an installed test plugin, authorized run, signed-in CDP browser, and explicit test conversation/selectors.");
  test.setTimeout(120000);
  const store = await DiffpanelStore.open(DIFFPANEL_HOME, { recover: false });
  try {
    const adapter = new ReviewAdapter(store, new Set([DIFFPANEL_TEST_RUN_ID!]));
    const run = await adapter.open(DIFFPANEL_TEST_RUN_ID!);
    const match = run.manifest.files.flatMap((file) => file.items.map((item) => ({ file, item }))).find(({ file }) => file.beforeBlob && file.afterBlob);
    if (!match) throw new Error("Choose a test run with saved before/after evidence.");
    const evidence = await adapter.evidence(run.summary.runId, run.revision, match.item.id);
    const browser = await chromium.connectOverCDP(CHATGPT_CDP_URL!);
    const page = browser.contexts().flatMap((context) => context.pages()).find((page) => page.url() === CHATGPT_TEST_URL);
    if (!page) throw new Error("Open the exact dedicated test conversation in the signed-in CDP browser first.");
    const panel = page.frames().find((frame) => frame !== page.mainFrame() && frame.url().includes("diffpanel"))
      ?? await (async () => {
        for (const frame of page.frames()) {
          if (frame !== page.mainFrame() && await frame.getByRole("heading", { name: run.summary.reviewTitle, exact: true }).count()) return frame;
        }
        throw new Error("Open the installed Diffpanel panel on the chosen saved review first.");
      })();
    await expect(panel.getByRole("heading", { name: run.summary.reviewTitle, exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Overview / all files", exact: true }).click();
    await panel.getByRole("button", { name: "Browse all files", exact: true }).click();
    await panel.getByRole("button", { name: `Open saved diff for ${match.file.filePath}`, exact: true }).click();
    await expect(panel.getByText("Selected saved evidence shared with ChatGPT.", { exact: true })).toBeVisible();
    for (const side of ["before", "after"] as const) {
      await panel.getByRole("button", { name: `Saved ${side}`, exact: true }).click();
      const firstLine = evidence[side]?.split("\n").find((line) => line.trim());
      if (firstLine) await expect(panel.getByLabel(`Saved ${side} contents`)).toContainText(firstLine);
    }
    const responses = page.locator(CHATGPT_ASSISTANT_SELECTOR!);
    const count = await responses.count();
    const marker = `DIFFPANEL-CONTEXT-CHECK-${Date.now()}`;
    const composer = page.locator(CHATGPT_COMPOSER_SELECTOR!);
    await composer.fill(`Reply with ${marker} and the exact runId, snapshotHash, review revision, and itemId currently selected in the Diffpanel panel. Use only the active panel context; if unavailable, say unavailable. Do not call tools or infer identifiers.`);
    await composer.press("Enter");
    await expect.poll(() => responses.count(), { timeout: 90000 }).toBeGreaterThan(count);
    const reply = responses.nth(count);
    await expect(reply).toContainText(marker, { timeout: 90000 });
    await expect(reply).toContainText(run.summary.runId);
    await expect(reply).toContainText(run.manifest.snapshotHash);
    await expect(reply).toContainText(run.revision);
    await expect(reply).toContainText(match.item.id);
    // The test owns neither the browser nor the conversation; leave them open.
  } finally { store.close(); }
});
