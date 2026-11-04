import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import {
  assertSafeId,
  attachmentFileName,
  feedbackDraftSchema,
  feedbackListQuerySchema,
  feedbackSchema,
  feedbackStatusSchema,
  InvalidMessageError,
  isSafeId,
  iterbarLayout,
  MAX_ATTACHMENT_BYTES,
  parseMessage,
  parseMessageJson,
  replySchema,
  type AttachmentRef,
  type EvidenceAttachment,
  type Feedback,
  type FeedbackDraft,
  type FeedbackListQuery,
  type FeedbackStatus,
  type ReplyAuthor,
  type ScreenshotAttachment,
} from "iterbar";
import {
  attachmentPath,
  attachmentsDirectoryPath,
  feedbackDirectoryPath,
  feedbackRecordPath,
  iterbarPaths,
  type IterbarPaths,
} from "iterbar/node";
import { errnoCode, IterbarStoreError } from "./errors.js";
import { createFileAtomic, syncDirectory, writeFileAtomic } from "./files.js";
import { formatId, formatTimestamp, StoreClock } from "./ids.js";
import { acquireStoreLock, type StoreLockHandle } from "./lock.js";

/** The bytes of the files sent with a new feedback item. */
export interface FeedbackFiles {
  /** A PNG image. Requires `screenshotUnavailableReason: null` in the draft. */
  readonly screenshot?: Uint8Array | null;
  /** UTF-8 JSON. Required exactly when the draft has an `evidenceWindow`. */
  readonly evidence?: Uint8Array | null;
}

/** A new reply: the `POST /feedback/:feedbackId/replies` body without `schemaVersion`. */
export interface ReplyInput {
  readonly author: ReplyAuthor;
  readonly text: string;
}

/**
 * A record as read: the feedback, and the JSON object it was parsed from, which also holds any fields this
 * version does not know (additive v1 fields from a newer writer), so that rewriting the record keeps them.
 */
interface StoredRecord {
  readonly feedback: Feedback;
  readonly json: Record<string, unknown>;
}

/** An attachment's stored reference and its verified contents. */
export interface AttachmentContent {
  readonly attachment: AttachmentRef;
  readonly data: Buffer;
}

export interface OpenFeedbackStoreOptions {
  /** Wall clock in epoch milliseconds; defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * @internal Test seam: runs after a new item's attachments are on disk and before its record is written.
   */
  readonly afterAttachmentsWritten?: (feedbackId: string) => Promise<void> | void;
}

/** Feedback, replies, status changes and attachments under a project's `.iterbar/`, owned by this process. */
export interface FeedbackStore {
  readonly paths: IterbarPaths;
  /** Items matching every given filter, oldest first. `since` keeps items with `updatedAt >= since`. */
  list(query?: FeedbackListQuery): Promise<Feedback[]>;
  /** One item; throws `not_found` when it does not exist. */
  get(feedbackId: string): Promise<Feedback>;
  /** References to an item's attachments: the screenshot, then the evidence. */
  attachments(feedbackId: string): Promise<AttachmentRef[]>;
  /** An attachment's contents, checked against the size and SHA-256 in its record. */
  readAttachment(feedbackId: string, attachmentId: string): Promise<AttachmentContent>;
  /** Stores a new `open` item with its attachments. */
  create(draft: FeedbackDraft, files?: FeedbackFiles): Promise<Feedback>;
  /** Appends a reply. */
  reply(feedbackId: string, input: ReplyInput): Promise<Feedback>;
  /** Changes an item's status; setting the current status changes nothing. */
  setStatus(feedbackId: string, status: FeedbackStatus): Promise<Feedback>;
  /** Waits for pending writes, then releases the lock. Idempotent. */
  close(): Promise<void>;
}

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if (errnoCode(error) !== "EEXIST") throw error;
  }
}

/** Creates `.iterbar/.gitignore` (`*`) unless it exists; an existing file is left as the user keeps it. */
async function ensureGitignore(paths: IterbarPaths): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await createFileAtomic(paths.tmpDirectory, paths.gitignoreFile, iterbarLayout.gitignoreContents);
      return;
    } catch (error) {
      // ENOENT: the store's owner swept `tmp/` while the temporary file was in it.
      if (errnoCode(error) !== "ENOENT" || attempt >= 3) throw error;
    }
  }
}

async function listDirectory(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw error;
  }
}

function referencedAttachments(feedback: Feedback): AttachmentRef[] {
  return [feedback.screenshot, feedback.evidence?.attachment].filter((ref): ref is AttachmentRef => Boolean(ref));
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * A private copy of an attachment, checked for size. The copy is what is validated, hashed and written: the
 * caller keeps its buffer and may change it while the write waits for earlier ones.
 */
function checkAttachmentBytes(name: string, data: unknown): Buffer {
  if (!(data instanceof Uint8Array)) throw new IterbarStoreError("invalid_request", `${name} must be a Uint8Array`);
  const tooLarge = (byteLength: number) =>
    new IterbarStoreError("payload_too_large", `${name} is ${byteLength} bytes; the limit is ${MAX_ATTACHMENT_BYTES}`);
  if (data.byteLength > MAX_ATTACHMENT_BYTES) throw tooLarge(data.byteLength);
  const bytes = Buffer.from(data);
  if (bytes.byteLength === 0) throw new IterbarStoreError("invalid_request", `${name} is empty`);
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw tooLarge(bytes.byteLength);
  return bytes;
}

interface PngChunk {
  readonly type: string;
  readonly data: Buffer;
  /** The offset just past the chunk's CRC. */
  readonly end: number;
}

/** The chunk at `offset` of `bytes`, or `null` when it does not fit in `bytes` or its CRC does not match. */
function pngChunkAt(bytes: Buffer, offset: number): PngChunk | null {
  if (offset + 12 > bytes.byteLength) return null;
  const length = bytes.readUInt32BE(offset);
  const end = offset + 12 + length;
  if (length > 0x7fffffff || end > bytes.byteLength) return null;
  if (bytes.readUInt32BE(end - 4) !== crc32(bytes.subarray(offset + 4, end - 4))) return null;
  return { type: bytes.toString("latin1", offset + 4, offset + 8), data: bytes.subarray(offset + 8, end - 4), end };
}

/** A 13-byte IHDR of a non-empty image. */
function isPngHeader(chunk: PngChunk): boolean {
  return chunk.type === "IHDR" && chunk.data.byteLength === 13 && chunk.data.readUInt32BE(0) !== 0
    && chunk.data.readUInt32BE(4) !== 0;
}

/**
 * True when `bytes` is a structurally complete PNG: the signature, then chunks whose lengths fit and whose
 * CRCs match, starting with a 13-byte IHDR of a non-empty image (the only IHDR), with at least one IDAT, and
 * ending with an empty IEND exactly at the end of the data. The image data itself is not decoded.
 */
function isPng(bytes: Buffer): boolean {
  if (bytes.byteLength < PNG_SIGNATURE.length || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) return false;
  const header = pngChunkAt(bytes, PNG_SIGNATURE.length);
  if (header === null || !isPngHeader(header)) return false;
  let sawData = false;
  for (let chunk = pngChunkAt(bytes, header.end); chunk !== null; chunk = pngChunkAt(bytes, chunk.end)) {
    if (chunk.type === "IHDR") return false;
    if (chunk.type === "IEND") return chunk.data.byteLength === 0 && sawData && chunk.end === bytes.byteLength;
    sawData ||= chunk.type === "IDAT";
  }
  return false;
}

function checkScreenshot(data: unknown): Buffer {
  const bytes = checkAttachmentBytes("screenshot", data);
  if (!isPng(bytes)) throw new IterbarStoreError("invalid_request", "screenshot is not a complete PNG image");
  return bytes;
}

function checkEvidence(data: unknown): Buffer {
  const bytes = checkAttachmentBytes("evidence", data);
  try {
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new IterbarStoreError("invalid_request", "evidence is not UTF-8 JSON");
  }
  return bytes;
}

class FileFeedbackStore implements FeedbackStore {
  readonly paths: IterbarPaths;
  readonly #lock: StoreLockHandle;
  readonly #clock: StoreClock;
  readonly #afterAttachmentsWritten: OpenFeedbackStoreOptions["afterAttachmentsWritten"];
  #writes: Promise<unknown> = Promise.resolve();
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(paths: IterbarPaths, lock: StoreLockHandle, clock: StoreClock, options: OpenFeedbackStoreOptions) {
    this.paths = paths;
    this.#lock = lock;
    this.#clock = clock;
    this.#afterAttachmentsWritten = options.afterAttachmentsWritten;
  }

  get #root(): string {
    return this.paths.projectRoot;
  }

  #assertOpen(): void {
    if (this.#closed) throw new IterbarStoreError("store_closed", "The feedback store is closed");
  }

  /** Runs `write` after every earlier write, while this process still holds the lock. */
  #exclusive<T>(write: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    const run = this.#writes.then(async () => {
      await this.#lock.assertHeld();
      return write();
    });
    this.#writes = run.catch(() => undefined);
    return run;
  }

  /** Reads a record; `null` when its directory or `feedback.json` does not exist (yet). */
  async #read(feedbackId: string): Promise<StoredRecord | null> {
    const path = feedbackRecordPath(this.#root, feedbackId);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return null;
      throw error;
    }
    let feedback: Feedback;
    let json: Record<string, unknown>;
    try {
      feedback = parseMessageJson(feedbackSchema, text, "feedback");
      // A valid record is a JSON object.
      json = JSON.parse(text) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof InvalidMessageError) {
        throw new IterbarStoreError("corrupt_store", `${path} is not a valid feedback record: ${error.message}`, { cause: error });
      }
      throw error;
    }
    if (feedback.id !== feedbackId) {
      throw new IterbarStoreError("corrupt_store", `${path} holds feedback ${JSON.stringify(feedback.id)}`);
    }
    return { feedback, json };
  }

  async #require(feedbackId: string): Promise<StoredRecord> {
    const record = await this.#read(feedbackId);
    if (!record) throw new IterbarStoreError("not_found", `Feedback ${feedbackId} does not exist`);
    return record;
  }

  async #writeRecord(id: string, record: object): Promise<void> {
    await writeFileAtomic(this.paths.tmpDirectory, feedbackRecordPath(this.#root, id), `${JSON.stringify(record, null, 2)}\n`);
  }

  /**
   * Rewrites a record with `changes` applied to the JSON it was read from, so fields this version does not
   * know, at any depth, are kept. Returns the changed feedback as this version reads it.
   */
  async #update(current: StoredRecord, changes: Partial<Record<keyof Feedback, unknown>>): Promise<Feedback> {
    const json = { ...current.json, ...changes };
    const feedback = parseMessage(feedbackSchema, json, "feedback");
    await this.#writeRecord(feedback.id, json);
    return feedback;
  }

  async list(query: FeedbackListQuery = {}): Promise<Feedback[]> {
    this.#assertOpen();
    const filter = parseMessage(feedbackListQuerySchema, query, "feedback list query");
    const since = filter.since === undefined ? undefined : Date.parse(filter.since);
    const items: Feedback[] = [];
    for (const entry of await listDirectory(this.paths.feedbackDirectory)) {
      if (!entry.isDirectory() || !isSafeId(entry.name)) continue;
      const feedback = (await this.#read(entry.name))?.feedback;
      if (!feedback) continue;
      if (filter.status !== undefined && feedback.status !== filter.status) continue;
      if (filter.kind !== undefined && feedback.kind !== filter.kind) continue;
      if (since !== undefined && Date.parse(feedback.updatedAt) < since) continue;
      items.push(feedback);
    }
    return items.sort((left, right) =>
      Date.parse(left.createdAt) - Date.parse(right.createdAt) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }

  async get(feedbackId: string): Promise<Feedback> {
    this.#assertOpen();
    return (await this.#require(feedbackId)).feedback;
  }

  async attachments(feedbackId: string): Promise<AttachmentRef[]> {
    this.#assertOpen();
    return referencedAttachments((await this.#require(feedbackId)).feedback);
  }

  async readAttachment(feedbackId: string, attachmentId: string): Promise<AttachmentContent> {
    this.#assertOpen();
    const attachment = referencedAttachments((await this.#require(feedbackId)).feedback).find((ref) => ref.id === attachmentId);
    if (!attachment) {
      throw new IterbarStoreError("not_found", `Feedback ${feedbackId} has no attachment ${attachmentId}`);
    }
    const path = attachmentPath(this.#root, feedbackId, attachment);
    let data: Buffer;
    try {
      data = await readFile(path);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") throw new IterbarStoreError("corrupt_store", `${path} is missing`, { cause: error });
      throw error;
    }
    if (data.byteLength !== attachment.byteLength || sha256(data) !== attachment.sha256) {
      throw new IterbarStoreError("corrupt_store", `${path} does not match its recorded size and SHA-256`);
    }
    return { attachment, data };
  }

  async create(draft: FeedbackDraft, files: FeedbackFiles = {}): Promise<Feedback> {
    this.#assertOpen();
    const { evidenceWindow, ...content } = parseMessage(feedbackDraftSchema, draft, "feedback draft");
    const screenshotData = files.screenshot == null ? null : checkScreenshot(files.screenshot);
    const evidenceData = files.evidence == null ? null : checkEvidence(files.evidence);
    if (screenshotData && content.screenshotUnavailableReason !== null) {
      throw new IterbarStoreError("invalid_request", "A screenshot was sent with a screenshotUnavailableReason");
    }
    if ((evidenceData === null) !== (evidenceWindow === null)) {
      throw new IterbarStoreError("invalid_request", "evidence and evidenceWindow must be sent together");
    }

    return this.#exclusive(async () => {
      const created = this.#clock.tick();
      const id = formatId("feedback", created);
      const timestamp = formatTimestamp(created);
      const screenshot: ScreenshotAttachment | null = screenshotData && {
        id: formatId("attachment", this.#clock.tick()),
        kind: "screenshot",
        mediaType: "image/png",
        byteLength: screenshotData.byteLength,
        sha256: sha256(screenshotData),
      };
      const evidenceAttachment: EvidenceAttachment | null = evidenceData && {
        id: formatId("attachment", this.#clock.tick()),
        kind: "evidence",
        mediaType: "application/json",
        byteLength: evidenceData.byteLength,
        sha256: sha256(evidenceData),
      };
      const feedback = parseMessage(feedbackSchema, {
        ...content,
        id,
        screenshot,
        evidence: evidenceAttachment && evidenceWindow ? { window: evidenceWindow, attachment: evidenceAttachment } : null,
        replies: [],
        status: "open",
        createdAt: timestamp,
        updatedAt: timestamp,
      }, "feedback");

      const directory = feedbackDirectoryPath(this.#root, id);
      // Not recursive: an existing directory would be an id collision, which must never overwrite an item.
      await mkdir(directory);
      try {
        await mkdir(attachmentsDirectoryPath(this.#root, id));
        // Attachments first, record last: a record never points at a missing attachment, and a crash before the
        // record leaves a directory without feedback.json, which the next open sweeps.
        if (screenshot && screenshotData) await this.#writeAttachment(id, screenshot, screenshotData);
        if (evidenceAttachment && evidenceData) await this.#writeAttachment(id, evidenceAttachment, evidenceData);
        await this.#afterAttachmentsWritten?.(id);
        await this.#writeRecord(id, feedback);
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
      await syncDirectory(this.paths.feedbackDirectory);
      return feedback;
    });
  }

  async #writeAttachment(feedbackId: string, attachment: AttachmentRef, data: Uint8Array): Promise<void> {
    await writeFileAtomic(this.paths.tmpDirectory, attachmentPath(this.#root, feedbackId, attachment), data);
  }

  async reply(feedbackId: string, input: ReplyInput): Promise<Feedback> {
    this.#assertOpen();
    assertSafeId(feedbackId, "feedback id");
    return this.#exclusive(async () => {
      const current = await this.#require(feedbackId);
      const tick = this.#clock.tick();
      const timestamp = formatTimestamp(tick);
      // Parsed on its own, so that only reply fields are stored, never other properties of the caller's input.
      const reply = parseMessage(
        replySchema,
        { id: formatId("reply", tick), author: input?.author, text: input?.text, createdAt: timestamp },
        "reply",
      );
      // The schema has checked that the stored replies are an array.
      return this.#update(current, { replies: [...(current.json.replies as unknown[]), reply], updatedAt: timestamp });
    });
  }

  async setStatus(feedbackId: string, status: FeedbackStatus): Promise<Feedback> {
    this.#assertOpen();
    assertSafeId(feedbackId, "feedback id");
    const next = parseMessage(feedbackStatusSchema, status, "status");
    return this.#exclusive(async () => {
      const current = await this.#require(feedbackId);
      if (current.feedback.status === next) return current.feedback;
      return this.#update(current, { status: next, updatedAt: formatTimestamp(this.#clock.tick()) });
    });
  }

  close(): Promise<void> {
    // Every call shares one shutdown, so none resolves before the writes drain and the lock is released.
    this.#closed = true;
    this.#closing ??= this.#writes.then(() => this.#lock.release());
    return this.#closing;
  }
}

/**
 * Removes what an interrupted writer left behind: every temporary file, every feedback directory without a
 * `feedback.json` (a crash between its attachments and its record), and every attachment file its record does
 * not reference. Directories whose record cannot be read are left untouched. Advances the clock past every
 * existing id and timestamp.
 */
async function sweep(paths: IterbarPaths, clock: StoreClock): Promise<void> {
  for (const entry of await listDirectory(paths.tmpDirectory)) {
    await rm(join(paths.tmpDirectory, entry.name), { recursive: true, force: true });
  }
  for (const entry of await listDirectory(paths.feedbackDirectory)) {
    if (!entry.isDirectory() || !isSafeId(entry.name)) continue;
    const feedbackId = entry.name;
    clock.observeId(feedbackId);
    const directory = feedbackDirectoryPath(paths.projectRoot, feedbackId);
    let text: string;
    try {
      text = await readFile(feedbackRecordPath(paths.projectRoot, feedbackId), "utf8");
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
      await rm(directory, { recursive: true, force: true });
      continue;
    }
    let feedback: Feedback;
    try {
      feedback = parseMessageJson(feedbackSchema, text, "feedback");
    } catch {
      continue;
    }
    if (feedback.id !== feedbackId) continue;
    clock.observeTimestamp(feedback.createdAt);
    clock.observeTimestamp(feedback.updatedAt);
    for (const reply of feedback.replies) {
      clock.observeId(reply.id);
      clock.observeTimestamp(reply.createdAt);
    }
    const keep = new Set(referencedAttachments(feedback).map((ref) => {
      clock.observeId(ref.id);
      return attachmentFileName(ref);
    }));
    const attachments = attachmentsDirectoryPath(paths.projectRoot, feedbackId);
    for (const file of await listDirectory(attachments)) {
      if (!keep.has(file.name)) await rm(join(attachments, file.name), { recursive: true, force: true });
    }
  }
  await syncDirectory(paths.feedbackDirectory);
}

/**
 * Opens the feedback store of an absolute project root, creating `.iterbar/` and its `.gitignore` on first
 * use, and takes the single-writer lock. Throws `store_locked` ({@link StoreLockedError}) while another live
 * process owns the store. The project root must exist.
 */
export async function openFeedbackStore(projectRoot: string, options: OpenFeedbackStoreOptions = {}): Promise<FeedbackStore> {
  const paths = iterbarPaths(projectRoot);
  try {
    await ensureDirectory(paths.directory);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      throw new IterbarStoreError("not_found", `Project root ${paths.projectRoot} does not exist`, { cause: error });
    }
    throw error;
  }
  await ensureDirectory(paths.tmpDirectory);
  await ensureGitignore(paths);
  await ensureDirectory(paths.feedbackDirectory);
  // Acquisition ends by checking that store.lock is still this process's, so the sweep runs as the owner.
  const lock = await acquireStoreLock(paths.lockFile, paths.tmpDirectory);
  try {
    const clock = new StoreClock(options.now);
    await sweep(paths, clock);
    await lock.confirmAcquired();
    return new FileFeedbackStore(paths, lock, clock, options);
  } catch (error) {
    await lock.release();
    throw error;
  }
}
