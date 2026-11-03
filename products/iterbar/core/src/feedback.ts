import { z } from "zod";
import { activeVariantSchema, activeVariantsSchema } from "./registry.js";
import { idSchema, pageUrlSchema, schemaVersionSchema, sha256Schema, timestampSchema } from "./primitives.js";

/** Attribute stamped on rendered elements in dev: `data-iterbar-src="src/App.tsx:12:5"`. */
export const SOURCE_ATTRIBUTE = "data-iterbar-src";

/** Largest attachment the daemon accepts, in bytes (10 MiB). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Longest element text excerpt carried by a feedback target. */
export const MAX_TEXT_EXCERPT_LENGTH = 200;

/** Default evidence window around the moment feedback is sent. */
export const EVIDENCE_WINDOW_BEFORE_MS = 30_000;
export const EVIDENCE_WINDOW_AFTER_MS = 5_000;

export const feedbackKindSchema = z.enum(["comment", "choose_variant"]);

/** `open` until an agent picks it up; `resolved` closes the thread. */
export const feedbackStatusSchema = z.enum(["open", "working", "needs-info", "done", "resolved"]);

/** Element bounds in CSS pixels, relative to the top-left corner of the document. */
export const boundingBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});

function isRepoRelativePath(value: string): boolean {
  if (value.startsWith("/") || value.includes("\\") || /^[A-Za-z]:/.test(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Where an element was written. Line and column are 1-based; the path is relative to the project root, with `/` separators. */
export const sourceLocationSchema = z.object({
  path: z.string().min(1).max(1024).refine(isRepoRelativePath, "must be a project-relative path without '.' or '..' segments"),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
});

/** The element a piece of feedback is about. */
export const feedbackTargetSchema = z.object({
  selector: z.string().min(1).max(2048),
  textExcerpt: z.string().max(MAX_TEXT_EXCERPT_LENGTH),
  boundingBox: boundingBoxSchema,
  sourceLocation: sourceLocationSchema.nullable(),
});

const attachmentFields = {
  id: idSchema,
  byteLength: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
  sha256: sha256Schema,
};

export const screenshotAttachmentSchema = z.object({
  ...attachmentFields,
  kind: z.literal("screenshot"),
  mediaType: z.literal("image/png"),
});

export const evidenceAttachmentSchema = z.object({
  ...attachmentFields,
  kind: z.literal("evidence"),
  mediaType: z.literal("application/json"),
});

/** A stored file attached to a feedback item. The file lives under the item's `attachments/` directory. */
export const attachmentRefSchema = z.discriminatedUnion("kind", [screenshotAttachmentSchema, evidenceAttachmentSchema]);

/** The time span of runtime evidence captured around a piece of feedback. */
export const evidenceWindowSchema = z.object({
  start: timestampSchema,
  end: timestampSchema,
  eventCount: z.number().int().nonnegative(),
}).refine((window) => Date.parse(window.start) <= Date.parse(window.end), {
  path: ["end"],
  message: "end must not precede start",
});

/** Stored evidence: the window plus the attachment holding its events. */
export const evidenceRefSchema = z.object({
  window: evidenceWindowSchema,
  attachment: evidenceAttachmentSchema,
});

export const replyAuthorSchema = z.object({
  kind: z.enum(["user", "agent"]),
  name: z.string().min(1).max(100).nullable(),
});

const nonBlankText = z.string().max(20_000).refine((text) => text.trim().length > 0, "must not be blank");

export const replySchema = z.object({
  id: idSchema,
  author: replyAuthorSchema,
  text: nonBlankText,
  createdAt: timestampSchema,
});

const screenshotUnavailableReasonSchema = z.string().min(1).max(500).nullable();

/** Fields shared by a feedback draft and a stored feedback record. */
const contentFields = {
  schemaVersion: schemaVersionSchema,
  pageUrl: pageUrlSchema,
  target: feedbackTargetSchema.nullable(),
  activeVariants: activeVariantsSchema,
  /** Why no screenshot was captured; `null` when one was, or none was attempted. */
  screenshotUnavailableReason: screenshotUnavailableReasonSchema,
};

const commentFields = { kind: z.literal("comment"), text: nonBlankText };
/** `choice` is the winning version; `text` is an optional note. */
const chooseVariantFields = {
  kind: z.literal("choose_variant"),
  text: z.string().max(20_000),
  choice: activeVariantSchema,
};

/**
 * Bar -> daemon: a new feedback item before the daemon assigns ids and status. Sent as the
 * `feedback` part of a multipart `POST /feedback`, with optional `screenshot` (image/png) and
 * `evidence` (application/json) file parts. `evidenceWindow` describes the `evidence` part.
 */
export const feedbackDraftSchema = z.discriminatedUnion("kind", [
  z.object({ ...contentFields, ...commentFields, evidenceWindow: evidenceWindowSchema.nullable() }),
  z.object({ ...contentFields, ...chooseVariantFields, evidenceWindow: evidenceWindowSchema.nullable() }),
]);

const recordFields = {
  id: idSchema,
  screenshot: screenshotAttachmentSchema.nullable(),
  evidence: evidenceRefSchema.nullable(),
  replies: z.array(replySchema),
  status: feedbackStatusSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
};

/** A stored feedback item with its thread: `.iterbar/feedback/<id>/feedback.json` and daemon responses. */
export const feedbackSchema = z.discriminatedUnion("kind", [
  z.object({ ...contentFields, ...commentFields, ...recordFields }),
  z.object({ ...contentFields, ...chooseVariantFields, ...recordFields }),
]).superRefine((feedback, context) => {
  if (feedback.screenshot && feedback.screenshotUnavailableReason !== null) {
    context.addIssue({
      code: "custom",
      path: ["screenshotUnavailableReason"],
      message: "must be null when a screenshot is attached",
    });
  }
  if (Date.parse(feedback.updatedAt) < Date.parse(feedback.createdAt)) {
    context.addIssue({ code: "custom", path: ["updatedAt"], message: "must not precede createdAt" });
  }
  const ids = [feedback.screenshot?.id, feedback.evidence?.attachment.id].filter(Boolean);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["evidence", "attachment", "id"], message: "attachment ids must be unique" });
  }
  if (new Set(feedback.replies.map((reply) => reply.id)).size !== feedback.replies.length) {
    context.addIssue({ code: "custom", path: ["replies"], message: "reply ids must be unique" });
  }
});

export type FeedbackKind = z.infer<typeof feedbackKindSchema>;
export type FeedbackStatus = z.infer<typeof feedbackStatusSchema>;
export type BoundingBox = z.infer<typeof boundingBoxSchema>;
export type SourceLocation = z.infer<typeof sourceLocationSchema>;
export type FeedbackTarget = z.infer<typeof feedbackTargetSchema>;
export type ScreenshotAttachment = z.infer<typeof screenshotAttachmentSchema>;
export type EvidenceAttachment = z.infer<typeof evidenceAttachmentSchema>;
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;
export type EvidenceWindow = z.infer<typeof evidenceWindowSchema>;
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;
export type ReplyAuthor = z.infer<typeof replyAuthorSchema>;
export type Reply = z.infer<typeof replySchema>;
export type FeedbackDraft = z.infer<typeof feedbackDraftSchema>;
export type Feedback = z.infer<typeof feedbackSchema>;

/** Formats a {@link SOURCE_ATTRIBUTE} value. */
export function formatSourceLocation(location: SourceLocation): string {
  return `${location.path}:${location.line}:${location.column}`;
}

/** Parses a {@link SOURCE_ATTRIBUTE} value; returns `null` for anything that is not `path:line:column`. */
export function parseSourceLocation(value: string | null | undefined): SourceLocation | null {
  const match = /^(.+):(\d+):(\d+)$/.exec(value ?? "");
  if (!match) return null;
  const result = sourceLocationSchema.safeParse({ path: match[1], line: Number(match[2]), column: Number(match[3]) });
  return result.success ? result.data : null;
}
