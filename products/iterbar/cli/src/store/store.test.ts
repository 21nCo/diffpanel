import { createHash } from "node:crypto";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { feedbackSchema, MAX_ATTACHMENT_BYTES, parseMessageJson, type AttachmentRef, type Feedback } from "iterbar";
import { attachmentPath, feedbackRecordPath, iterbarPaths } from "iterbar/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openFeedbackStore, type FeedbackStore, type OpenFeedbackStoreOptions } from "./store.js";
import { chooseVariantDraft, commentDraft, EVIDENCE, PNG, temporaryProject } from "./test-support/helpers.js";

let root: string;
let cleanup: () => Promise<void>;
const stores: FeedbackStore[] = [];

beforeEach(async () => {
  ({ root, cleanup } = await temporaryProject());
});

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await cleanup();
});

async function open(options?: OpenFeedbackStoreOptions): Promise<FeedbackStore> {
  const store = await openFeedbackStore(root, options);
  stores.push(store);
  return store;
}

async function reopen(store: FeedbackStore, options?: OpenFeedbackStoreOptions): Promise<FeedbackStore> {
  await store.close();
  return open(options);
}

/** A wall clock the test moves by hand. */
function manualClock(start: string) {
  let now = Date.parse(start);
  return { now: () => now, set: (time: string) => void (now = Date.parse(time)) };
}

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const agent = { kind: "agent", name: "Claude Code" } as const;

describe(".iterbar/ setup", () => {
  it("creates .iterbar/.gitignore containing * on first use", async () => {
    await open();
    expect(await readFile(iterbarPaths(root).gitignoreFile, "utf8")).toBe("*\n");
  });

  it("leaves an existing .iterbar/.gitignore as it is", async () => {
    await (await open()).close();
    stores.length = 0;
    await writeFile(iterbarPaths(root).gitignoreFile, "*\n!notes.md\n");
    await open();
    expect(await readFile(iterbarPaths(root).gitignoreFile, "utf8")).toBe("*\n!notes.md\n");
  });

  it("refuses a project root that does not exist instead of creating it", async () => {
    await expect(openFeedbackStore(join(root, "missing"))).rejects.toMatchObject({ code: "not_found" });
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses a relative project root", async () => {
    await expect(openFeedbackStore("relative/app")).rejects.toMatchObject({ code: "invalid_project_root" });
  });

  it("allows one writer per store, even within one process, until it closes", async () => {
    const first = await open();
    await expect(openFeedbackStore(root)).rejects.toMatchObject({ code: "store_locked", owner: { pid: process.pid } });
    await first.close();
    await open();
  });
});

describe("records", () => {
  it("round-trips a comment with screenshot and evidence, a variant choice, replies and status changes", async () => {
    const clock = manualClock("2026-11-04T10:00:00.000Z");
    let store = await open({ now: clock.now });

    const comment = await store.create(commentDraft, { screenshot: PNG, evidence: EVIDENCE });
    expect(comment).toMatchObject({
      kind: "comment",
      text: commentDraft.text,
      target: commentDraft.target,
      status: "open",
      replies: [],
      createdAt: "2026-11-04T10:00:00.000Z",
      updatedAt: "2026-11-04T10:00:00.000Z",
      screenshot: { kind: "screenshot", mediaType: "image/png", byteLength: PNG.byteLength, sha256: sha256(PNG) },
      evidence: {
        window: commentDraft.evidenceWindow,
        attachment: { kind: "evidence", mediaType: "application/json", byteLength: EVIDENCE.byteLength, sha256: sha256(EVIDENCE) },
      },
    });
    const choice = await store.create(chooseVariantDraft);
    expect(choice).toMatchObject({
      kind: "choose_variant",
      choice: { slot: "pricing", version: "v2" },
      screenshot: null,
      evidence: null,
      screenshotUnavailableReason: "Capture was blocked by the page",
    });

    clock.set("2026-11-04T10:01:00.000Z");
    await store.reply(comment.id, { author: agent, text: "Working on it." });
    await store.setStatus(comment.id, "working");
    clock.set("2026-11-04T10:02:00.000Z");
    await store.reply(comment.id, { author: { kind: "user", name: null }, text: "Thanks" });
    const updated = await store.setStatus(comment.id, "done");
    expect(updated.replies.map((reply) => [reply.author.kind, reply.text])).toEqual([["agent", "Working on it."], ["user", "Thanks"]]);
    expect(updated).toMatchObject({ status: "done", createdAt: comment.createdAt });

    store = await reopen(store);
    expect(await store.list()).toEqual([updated, choice]);
    expect(await store.get(comment.id)).toEqual(updated);
    expect(await store.attachments(comment.id)).toEqual([comment.screenshot, comment.evidence?.attachment]);
    expect(await store.attachments(choice.id)).toEqual([]);
    expect((await store.readAttachment(comment.id, comment.screenshot?.id as string)).data).toEqual(PNG);
    expect((await store.readAttachment(comment.id, comment.evidence?.attachment.id as string)).data).toEqual(EVIDENCE);

    // The file is the protocol record, so other Iterbar readers parse it with the shared schema.
    const onDisk = parseMessageJson(feedbackSchema, await readFile(feedbackRecordPath(root, comment.id), "utf8"));
    expect(onDisk).toEqual(updated);
  });

  it("does not rewrite an item when its status is set to the current one", async () => {
    const clock = manualClock("2026-11-04T10:00:00.000Z");
    const store = await open({ now: clock.now });
    const item = await store.create(chooseVariantDraft);
    clock.set("2026-11-04T11:00:00.000Z");
    expect(await store.setStatus(item.id, "open")).toEqual(item);
    expect(await store.get(item.id)).toEqual(item);
  });

  it("filters the list by status, kind and since (updatedAt at or after)", async () => {
    const clock = manualClock("2026-11-04T10:00:00.000Z");
    const store = await open({ now: clock.now });
    const first = await store.create(chooseVariantDraft);
    clock.set("2026-11-04T10:10:00.000Z");
    const second = await store.create(commentDraft, { evidence: EVIDENCE });
    clock.set("2026-11-04T10:20:00.000Z");
    await store.setStatus(first.id, "resolved");
    const ids = async (query: Parameters<FeedbackStore["list"]>[0]) => (await store.list(query)).map((item) => item.id);

    expect(await ids({})).toEqual([first.id, second.id]);
    expect(await ids({ status: "open" })).toEqual([second.id]);
    expect(await ids({ kind: "choose_variant" })).toEqual([first.id]);
    expect(await ids({ since: "2026-11-04T10:10:00.000Z" })).toEqual([first.id, second.id]);
    expect(await ids({ since: "2026-11-04T10:10:00.001Z" })).toEqual([first.id]);
    expect(await ids({ since: "2026-11-04T10:10:00.000Z", status: "open", kind: "comment" })).toEqual([second.id]);
    await expect(store.list({ status: "closed" as never })).rejects.toMatchObject({ code: "invalid_message" });
  });

  it("keeps a reply from every concurrent writer in one process", async () => {
    const store = await open();
    const item = await store.create(chooseVariantDraft);
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.reply(item.id, { author: agent, text: `reply ${index}` })));
    const { replies } = await store.get(item.id);
    expect(replies.map((reply) => reply.text).sort()).toEqual(Array.from({ length: 20 }, (_, index) => `reply ${index}`).sort());
    expect(new Set(replies.map((reply) => reply.id)).size).toBe(20);
  });
  it("applies concurrent replies and status changes in call order without losing any", async () => {
    const store = await open();
    const item = await store.create(chooseVariantDraft);
    const statuses = ["working", "needs-info", "done", "resolved"] as const;
    await Promise.all(statuses.flatMap((status, index) => [
      store.reply(item.id, { author: agent, text: `reply ${index}` }),
      store.setStatus(item.id, status),
    ]));
    const stored = await store.get(item.id);
    expect(stored.replies.map((reply) => reply.text)).toEqual(["reply 0", "reply 1", "reply 2", "reply 3"]);
    expect(stored.status).toBe("resolved");
  });

  it("finishes pending writes before close releases the lock", async () => {
    const store = await open();
    const item = await store.create(chooseVariantDraft);
    const pending = Array.from({ length: 5 }, (_, index) => store.reply(item.id, { author: agent, text: `reply ${index}` }));
    await store.close();
    await expect(Promise.all(pending)).resolves.toHaveLength(5);
    stores.length = 0;
    await expect((await open()).get(item.id)).resolves.toMatchObject({ replies: { length: 5 } });
  });

  it("makes every overlapping close wait for pending writes and the lock release", async () => {
    const store = await open();
    const item = await store.create(chooseVariantDraft);
    const pending = Array.from({ length: 5 }, (_, index) => store.reply(item.id, { author: agent, text: `reply ${index}` }));
    const first = store.close();
    await store.close();
    await expect(stat(iterbarPaths(root).lockFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(Promise.all(pending)).resolves.toHaveLength(5);
    await first;
    stores.length = 0;
    await expect((await open()).get(item.id)).resolves.toMatchObject({ replies: { length: 5 } });
  });

  it("stores the attachment bytes it was given, whatever the caller does to its buffers afterwards", async () => {
    let store = await open();
    // The first create holds the write queue, so the second is validated now and written later.
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => (resume = resolve));
    store = await reopen(store, { afterAttachmentsWritten: () => paused });
    const first = store.create(commentDraft, { evidence: EVIDENCE });
    const screenshot = Buffer.from(PNG);
    const evidence = Buffer.from(EVIDENCE);
    const second = store.create(commentDraft, { screenshot, evidence });
    screenshot.fill(0);
    evidence.write("{not json");
    resume();
    await first;
    const item = await second;
    expect(item.screenshot).toMatchObject({ byteLength: PNG.byteLength, sha256: sha256(PNG) });
    expect(item.evidence?.attachment).toMatchObject({ byteLength: EVIDENCE.byteLength, sha256: sha256(EVIDENCE) });
    store = await reopen(store);
    expect((await store.readAttachment(item.id, item.screenshot?.id as string)).data).toEqual(PNG);
    expect((await store.readAttachment(item.id, item.evidence?.attachment.id as string)).data).toEqual(EVIDENCE);
  });

  it("keeps fields it does not know, from a newer v1 writer, when it adds a reply or changes the status", async () => {
    let store = await open();
    const item = await store.create(commentDraft, { evidence: EVIDENCE });
    await store.reply(item.id, { author: agent, text: "First" });
    const recordPath = feedbackRecordPath(root, item.id);
    type Json = Record<string, unknown> & { target: Record<string, unknown>; replies: Array<Record<string, unknown>> };
    const extended = JSON.parse(await readFile(recordPath, "utf8")) as Json;
    extended.labels = ["ui"];
    extended.target.frame = { name: "checkout" };
    extended.replies[0] = { ...extended.replies[0], editedAt: "2026-11-04T10:05:00.000Z" };
    await writeFile(recordPath, JSON.stringify(extended));

    store = await reopen(store);
    await store.reply(item.id, { author: { ...agent, token: "not stored" }, text: "Second" } as never);
    const updated = await store.setStatus(item.id, "done");
    expect(updated).toEqual(await store.get(item.id));
    store = await reopen(store);
    const onDisk = JSON.parse(await readFile(recordPath, "utf8")) as Json;
    expect(onDisk).toMatchObject({ labels: ["ui"], target: { frame: { name: "checkout" } }, status: "done" });
    expect(onDisk.replies.map((reply) => [reply.text, reply.editedAt]))
      .toEqual([["First", "2026-11-04T10:05:00.000Z"], ["Second", undefined]]);
    expect(onDisk.replies[1]?.author).toEqual(agent);
    expect(await store.get(item.id)).toEqual(updated);
  });

  it("reports corrupt_store for a referenced attachment that is missing or altered", async () => {
    const store = await open();
    const item = await store.create(commentDraft, { screenshot: PNG, evidence: EVIDENCE });
    const screenshot = item.screenshot as AttachmentRef;
    const evidence = item.evidence?.attachment as AttachmentRef;
    await writeFile(attachmentPath(root, item.id, screenshot), Buffer.concat([PNG, Buffer.from([0])]));
    await rm(attachmentPath(root, item.id, evidence));
    await expect(store.readAttachment(item.id, screenshot.id)).rejects.toMatchObject({ code: "corrupt_store" });
    await expect(store.readAttachment(item.id, evidence.id)).rejects.toMatchObject({ code: "corrupt_store" });
  });
});

describe("ids and timestamps", () => {
  it("are strictly increasing when the clock stands still or goes back, including after a reopen", async () => {
    const clock = manualClock("2026-11-04T10:00:00.000Z");
    let store = await open({ now: clock.now });
    const items: Feedback[] = [];
    for (let index = 0; index < 3; index += 1) items.push(await store.create(chooseVariantDraft));
    clock.set("2026-11-04T09:00:00.000Z");
    items.push(await store.create(commentDraft, { screenshot: PNG, evidence: EVIDENCE }));
    const replied = await store.reply(items[0]?.id as string, { author: agent, text: "Seen" });

    store = await reopen(store, { now: clock.now });
    clock.set("2026-11-04T08:00:00.000Z");
    items.push(await store.create(chooseVariantDraft));
    const later = await store.reply(items[0]?.id as string, { author: agent, text: "Again" });

    const ids = [
      ...items.slice(0, 3).map((item) => item.id),
      items[3]?.id,
      items[3]?.screenshot?.id,
      items[3]?.evidence?.attachment.id,
      replied.replies[0]?.id,
      items[4]?.id,
      later.replies[1]?.id,
    ] as string[];
    const suffixes = ids.map((id) => id.slice(3));
    expect([...suffixes].sort()).toEqual(suffixes);
    expect(new Set(suffixes).size).toBe(suffixes.length);
    expect(ids.every((id) => /^(fb|rp|at)_[0-9a-z]{9}_[0-9a-z]{4}$/.test(id))).toBe(true);

    const times = items.map((item) => Date.parse(item.createdAt));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(Date.parse(later.updatedAt)).toBeGreaterThanOrEqual(Date.parse(replied.updatedAt));
    expect((await store.list()).map((item) => item.id)).toEqual(items.map((item) => item.id));
  });
});

describe("rejected requests", () => {
  it("throws typed errors and writes nothing for invalid drafts and attachments", async () => {
    const store = await open();
    const rejects = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ code });

    await rejects(store.create({ ...commentDraft, text: "  " }), "invalid_message");
    await rejects(store.create({ ...commentDraft, schemaVersion: 2 } as never), "unsupported_schema_version");
    await rejects(store.create(commentDraft, { screenshot: PNG }), "invalid_request");
    await rejects(store.create(chooseVariantDraft, { evidence: EVIDENCE }), "invalid_request");
    await rejects(store.create(chooseVariantDraft, { screenshot: PNG }), "invalid_request");
    await rejects(store.create(commentDraft, { screenshot: Buffer.from("GIF89a"), evidence: EVIDENCE }), "invalid_request");
    // A PNG signature alone, a truncated image, a bad chunk CRC, a missing IHDR, IDAT or IEND, a second IHDR,
    // a nonempty IEND (with a valid CRC) and trailing bytes.
    const chunks = (bytes: Buffer) => [bytes.subarray(0, 33), bytes.subarray(33, 58), bytes.subarray(58)] as const;
    const [head, idat, iend] = chunks(PNG);
    const chunk = (type: string, data: Buffer) => {
      const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(body));
      const length = Buffer.alloc(4);
      length.writeUInt32BE(data.byteLength);
      return Buffer.concat([length, body, crc]);
    };
    expect(chunk("IEND", Buffer.alloc(0))).toEqual(iend);
    const badCrc = Buffer.from(PNG);
    badCrc.writeUInt8(badCrc.readUInt8(PNG.byteLength - 13) ^ 0xff, PNG.byteLength - 13);
    for (const screenshot of [
      PNG.subarray(0, 8),
      PNG.subarray(0, 29),
      PNG.subarray(0, PNG.byteLength - 1),
      badCrc,
      Buffer.concat([PNG.subarray(0, 8), idat, iend]),
      Buffer.concat([head, iend]),
      Buffer.concat([head, idat]),
      Buffer.concat([head, head.subarray(8), idat, iend]),
      Buffer.concat([head, idat, chunk("IEND", Buffer.from("x"))]),
      Buffer.concat([PNG, Buffer.from([0])]),
    ]) {
      await rejects(store.create(commentDraft, { screenshot, evidence: EVIDENCE }), "invalid_request");
    }
    await rejects(store.create(commentDraft, { evidence: Buffer.from("{not json") }), "invalid_request");
    await rejects(store.create(commentDraft, { evidence: new Uint8Array(0) }), "invalid_request");
    const tooLarge = Buffer.concat([PNG, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1 - PNG.byteLength)]);
    await rejects(store.create(commentDraft, { screenshot: tooLarge, evidence: EVIDENCE }), "payload_too_large");

    expect(await readdir(iterbarPaths(root).feedbackDirectory)).toEqual([]);
    expect(await readdir(iterbarPaths(root).tmpDirectory)).toEqual([]);
  });

  it("throws not_found for unknown items and attachments, and invalid_path_segment for unsafe ids", async () => {
    const store = await open();
    const item = await store.create(chooseVariantDraft);
    const rejects = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ code });

    await rejects(store.get("fb_missing"), "not_found");
    await rejects(store.attachments("fb_missing"), "not_found");
    await rejects(store.reply("fb_missing", { author: agent, text: "Hi" }), "not_found");
    await rejects(store.setStatus("fb_missing", "done"), "not_found");
    await rejects(store.readAttachment(item.id, "at_missing"), "not_found");
    await rejects(store.get("../outside"), "invalid_path_segment");
    await rejects(store.reply("../outside", { author: agent, text: "Hi" }), "invalid_path_segment");
    await rejects(store.reply(item.id, { author: agent, text: " " }), "invalid_message");
    await rejects(store.setStatus(item.id, "closed" as never), "invalid_message");
    expect(await store.get(item.id)).toEqual(item);
  });

  it("throws store_closed after close", async () => {
    const store = await open();
    const item = await store.create(chooseVariantDraft);
    await store.close();
    await expect(store.get(item.id)).rejects.toMatchObject({ code: "store_closed" });
    await expect(store.setStatus(item.id, "done")).rejects.toMatchObject({ code: "store_closed" });
    await expect(store.close()).resolves.toBeUndefined();
  });

  it("stops writing with lock_lost once its lock file has been replaced", async () => {
    const store = await open();
    const item = await store.create(chooseVariantDraft);
    const { lockFile } = iterbarPaths(root);
    await rename(lockFile, `${lockFile}.moved`);
    await writeFile(lockFile, await readFile(`${lockFile}.moved`));

    await expect(store.setStatus(item.id, "done")).rejects.toMatchObject({ code: "lock_lost" });
    expect((await store.get(item.id)).status).toBe("open");
    await store.close();
    // The replacement is not this store's lock, so close leaves it.
    expect(await readFile(lockFile, "utf8")).toContain(`"pid":${process.pid}`);
  });
});
