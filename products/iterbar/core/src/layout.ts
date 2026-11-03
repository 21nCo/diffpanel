import type { AttachmentRef } from "./feedback.js";
import { assertSafeId } from "./primitives.js";

/**
 * The `.iterbar/` directory in a project root. All names are single path segments:
 *
 * ```text
 * .iterbar/
 *   .gitignore            "*", so Iterbar never edits the project's own .gitignore
 *   daemon.json           DaemonInfo, mode 0600, present while a daemon runs
 *   store.lock            StoreLock of the single writer
 *   tmp/                  temporary files, renamed into place for atomic writes
 *   feedback/
 *     <feedbackId>/
 *       feedback.json     Feedback, including its replies
 *       attachments/
 *         <attachmentId>.png    screenshot
 *         <attachmentId>.json   evidence
 * ```
 */
export const iterbarLayout = Object.freeze({
  directory: ".iterbar",
  gitignoreFile: ".gitignore",
  gitignoreContents: "*\n",
  daemonFile: "daemon.json",
  /** File mode of `daemon.json`, which holds the token. */
  daemonFileMode: 0o600,
  lockFile: "store.lock",
  tmpDirectory: "tmp",
  feedbackDirectory: "feedback",
  feedbackRecordFile: "feedback.json",
  attachmentsDirectory: "attachments",
} as const);

const attachmentExtensions = Object.freeze({ screenshot: ".png", evidence: ".json" } as const);

/** File name of an attachment inside its feedback item's `attachments/` directory. */
export function attachmentFileName(attachment: Pick<AttachmentRef, "id" | "kind">): string {
  const extension = attachmentExtensions[attachment.kind];
  if (!extension) throw new TypeError(`Unknown attachment kind ${JSON.stringify(attachment.kind)}`);
  return `${assertSafeId(attachment.id, "attachment id")}${extension}`;
}

/** Path segments of a feedback item's directory, relative to the project root. */
export function feedbackDirectorySegments(feedbackId: string): string[] {
  return [iterbarLayout.directory, iterbarLayout.feedbackDirectory, assertSafeId(feedbackId, "feedback id")];
}
