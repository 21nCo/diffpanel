import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
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

function checkAttachmentBytes(name: string, data: unknown): Uint8Array {
  if (!(data instanceof Uint8Array)) throw new IterbarStoreError("invalid_request", `${name} must be a Uint8Array`);
  if (data.byteLength === 0) throw new IterbarStoreError("invalid_request", `${name} is empty`);
  if (data.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new IterbarStoreError("payload_too_large", `${name} is ${data.byteLength} bytes; the limit is ${MAX_ATTACHMENT_BYTES}`);
  }
  return data;
}

function checkScreenshot(data: unknown): Uint8Array {
  const bytes = checkAttachmentBytes("screenshot", data);
  if (bytes.byteLength < PNG_SIGNATURE.length || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    throw new IterbarStoreError("invalid_request", "screenshot is not a PNG image");
  }
  return bytes;
}

function checkEvidence(data: unknown): Uint8Array {
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
  async #read(feedbackId: string): Promise<Feedback | null> {
    const path = feedbackRecordPath(this.#root, feedbackId);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return null;
      throw error;
    }
    let feedback: Feedback;
    try {
      feedback = parseMessageJson(feedbackSchema, text, "feedback");
    } catch (error) {
      if (error instanceof InvalidMessageError) {
        throw new IterbarStoreError("corrupt_store", `${path} is not a valid feedback record: ${error.message}`, { cause: error });
      }
      throw error;
    }
    if (feedback.id !== feedbackId) {
      throw new IterbarStoreError("corrupt_store", `${path} holds feedback ${JSON.stringify(feedback.id)}`);
    }
    return feedback;
  }

  async #require(feedbackId: string): Promise<Feedback> {
    const feedback = await this.#read(feedbackId);
    if (!feedback) throw new IterbarStoreError("not_found", `Feedback ${feedbackId} does not exist`);
    return feedback;
  }

  async #writeRecord(feedback: Feedback): Promise<void> {
    await writeFileAtomic(this.paths.tmpDirectory, feedbackRecordPath(this.#root, feedback.id), `${JSON.stringify(feedback, null, 2)}\n`);
  }

  async list(query: FeedbackListQuery = {}): Promise<Feedback[]> {
    this.#assertOpen();
    const filter = parseMessage(feedbackListQuerySchema, query, "feedback list query");
    const since = filter.since === undefined ? undefined : Date.parse(filter.since);
    const items: Feedback[] = [];
    for (const entry of await listDirectory(this.paths.feedbackDirectory)) {
      if (!entry.isDirectory() || !isSafeId(entry.name)) continue;
      const feedback = await this.#read(entry.name);
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
    return this.#require(feedbackId);
  }

  async attachments(feedbackId: string): Promise<AttachmentRef[]> {
    this.#assertOpen();
    return referencedAttachments(await this.#require(feedbackId));
  }

  async readAttachment(feedbackId: string, attachmentId: string): Promise<AttachmentContent> {
    this.#assertOpen();
    const attachment = referencedAttachments(await this.#require(feedbackId)).find((ref) => ref.id === attachmentId);
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
        await this.#writeRecord(feedback);
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
      const reply = { id: formatId("reply", tick), author: input?.author, text: input?.text, createdAt: timestamp };
      const feedback = parseMessage(
        feedbackSchema,
        { ...current, replies: [...current.replies, reply], updatedAt: timestamp },
        "feedback",
      );
      await this.#writeRecord(feedback);
      return feedback;
    });
  }

  async setStatus(feedbackId: string, status: FeedbackStatus): Promise<Feedback> {
    this.#assertOpen();
    assertSafeId(feedbackId, "feedback id");
    const next = parseMessage(feedbackStatusSchema, status, "status");
    return this.#exclusive(async () => {
      const current = await this.#require(feedbackId);
      if (current.status === next) return current;
      const feedback = parseMessage(
        feedbackSchema,
        { ...current, status: next, updatedAt: formatTimestamp(this.#clock.tick()) },
        "feedback",
      );
      await this.#writeRecord(feedback);
      return feedback;
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
