import { join, normalize, sep } from "node:path";
import { IterbarContractError } from "./errors.js";
import type { AttachmentRef } from "./feedback.js";
import { attachmentFileName, feedbackDirectorySegments, iterbarLayout } from "./layout.js";
import { isAbsolutePath } from "./primitives.js";

/** Absolute paths of the fixed entries in a project's `.iterbar/` directory. */
export interface IterbarPaths {
  readonly projectRoot: string;
  readonly directory: string;
  readonly gitignoreFile: string;
  readonly daemonFile: string;
  readonly lockFile: string;
  readonly tmpDirectory: string;
  readonly feedbackDirectory: string;
}

const platform = sep === "\\" ? "win32" : "posix";

/**
 * Applies the same root rule as `absolutePathSchema` (see `isAbsolutePath`), limited to this platform's forms,
 * before and after normalization: on Windows only drive-qualified (`C:\`) and full UNC (`\\server\share`) roots
 * name the same directory in every process, so the returned paths never depend on the current drive.
 */
function checkedRoot(projectRoot: string): string {
  if (isAbsolutePath(projectRoot, platform)) {
    const root = normalize(projectRoot);
    if (isAbsolutePath(root, platform)) return root;
  }
  throw new IterbarContractError(
    "invalid_project_root",
    `Project root ${JSON.stringify(projectRoot)} must be an absolute path (drive-qualified or \\\\server\\share on Windows)`,
  );
}

/** Paths of `.iterbar/` and its fixed entries for an absolute project root. */
export function iterbarPaths(projectRoot: string): IterbarPaths {
  const root = checkedRoot(projectRoot);
  const directory = join(root, iterbarLayout.directory);
  return Object.freeze({
    projectRoot: root,
    directory,
    gitignoreFile: join(directory, iterbarLayout.gitignoreFile),
    daemonFile: join(directory, iterbarLayout.daemonFile),
    lockFile: join(directory, iterbarLayout.lockFile),
    tmpDirectory: join(directory, iterbarLayout.tmpDirectory),
    feedbackDirectory: join(directory, iterbarLayout.feedbackDirectory),
  });
}

/** `.iterbar/feedback/<feedbackId>/`. Throws `invalid_path_segment` for an unsafe id. */
export function feedbackDirectoryPath(projectRoot: string, feedbackId: string): string {
  return join(checkedRoot(projectRoot), ...feedbackDirectorySegments(feedbackId));
}

/** `.iterbar/feedback/<feedbackId>/feedback.json`. */
export function feedbackRecordPath(projectRoot: string, feedbackId: string): string {
  return join(feedbackDirectoryPath(projectRoot, feedbackId), iterbarLayout.feedbackRecordFile);
}

/** `.iterbar/feedback/<feedbackId>/attachments/`. */
export function attachmentsDirectoryPath(projectRoot: string, feedbackId: string): string {
  return join(feedbackDirectoryPath(projectRoot, feedbackId), iterbarLayout.attachmentsDirectory);
}

/** `.iterbar/feedback/<feedbackId>/attachments/<attachmentId>.<png|json>`. */
export function attachmentPath(
  projectRoot: string,
  feedbackId: string,
  attachment: Pick<AttachmentRef, "id" | "kind">,
): string {
  return join(attachmentsDirectoryPath(projectRoot, feedbackId), attachmentFileName(attachment));
}
