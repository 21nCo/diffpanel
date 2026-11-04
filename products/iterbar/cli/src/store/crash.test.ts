import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { attachmentPath, attachmentsDirectoryPath, feedbackDirectoryPath, feedbackRecordPath, iterbarPaths } from "iterbar/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openFeedbackStore } from "./store.js";
import { commentDraft, EVIDENCE, PNG, StoreProcess, temporaryProject } from "./test-support/helpers.js";

let root: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ root, cleanup } = await temporaryProject());
});

afterEach(async () => {
  await cleanup();
});

async function present(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

describe("interrupted writes", () => {
  it("never exposes a record for an item whose writer was killed before its record, and sweeps its files on next open", async () => {
    const before = await openFeedbackStore(root);
    const kept = await before.create(commentDraft, { screenshot: PNG, evidence: EVIDENCE });
    await before.close();

    const writer = new StoreProcess("crash-after-attachments", root, commentDraft);
    await writer.next("ready");
    writer.go();
    const { feedbackId } = await writer.next("attachments-written");
    const orphan = feedbackId as string;
    // The attachments are on disk and the record is not.
    expect(await readdir(attachmentsDirectoryPath(root, orphan))).toHaveLength(2);
    expect(await present(feedbackRecordPath(root, orphan))).toBe(false);
    await writer.kill();

    const store = await openFeedbackStore(root);
    try {
      expect(await present(feedbackDirectoryPath(root, orphan))).toBe(false);
      expect((await store.list()).map((item) => item.id)).toEqual([kept.id]);
      await expect(store.get(orphan)).rejects.toMatchObject({ code: "not_found" });
      for (const item of await store.list()) {
        for (const attachment of await store.attachments(item.id)) {
          expect((await store.readAttachment(item.id, attachment.id)).data.byteLength).toBe(attachment.byteLength);
        }
      }
    } finally {
      await store.close();
    }
  }, 30_000);

  it("sweeps temporary files and unreferenced attachment files, and keeps referenced ones", async () => {
    const first = await openFeedbackStore(root);
    const item = await first.create(commentDraft, { screenshot: PNG, evidence: EVIDENCE });
    await first.close();
    const paths = iterbarPaths(root);
    // A write interrupted before its rename, and an attachment file no record references.
    await writeFile(join(paths.tmpDirectory, "write-1-1-abc.tmp"), "{\"partial\":");
    await mkdir(join(paths.tmpDirectory, "nested"));
    const stray = attachmentPath(root, item.id, { id: "at_stray", kind: "screenshot" });
    await writeFile(stray, PNG);

    const store = await openFeedbackStore(root);
    try {
      expect(await readdir(paths.tmpDirectory)).toEqual([]);
      expect(await present(stray)).toBe(false);
      expect(await store.get(item.id)).toEqual(item);
      const screenshot = await store.readAttachment(item.id, item.screenshot?.id as string);
      expect(screenshot.data).toEqual(PNG);
      expect(await readFile(feedbackRecordPath(root, item.id), "utf8")).toContain(item.id);
    } finally {
      await store.close();
    }
  });

  it("leaves an unreadable record and its attachments in place", async () => {
    const first = await openFeedbackStore(root);
    const item = await first.create(commentDraft, { screenshot: PNG, evidence: EVIDENCE });
    await first.close();
    await writeFile(feedbackRecordPath(root, item.id), "{");

    const store = await openFeedbackStore(root);
    try {
      expect(await readdir(attachmentsDirectoryPath(root, item.id))).toHaveLength(2);
      await expect(store.get(item.id)).rejects.toMatchObject({ code: "corrupt_store" });
    } finally {
      await store.close();
    }
  });
});
