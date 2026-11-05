import { pathToFileURL } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import {
  feedbackKindSchema,
  feedbackStatusSchema,
  idSchema,
  timestampSchema,
  type AttachmentRef,
  type Feedback,
  type ReplyAuthor,
} from "iterbar";
import { attachmentPath } from "iterbar/node";
import { z } from "zod";
import {
  cursorAfter,
  decodeCursor,
  encodeCursor,
  observeListing,
  unseenEvents,
  type FeedbackCursor,
  type FeedbackEvent,
} from "./cursor.js";
import type { DaemonClient } from "./daemon-client.js";
import { IterbarToolError } from "./errors.js";
import { DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS, waitForFeedback } from "./wait.js";

/** Largest evidence attachment returned inline by `get_feedback`; a larger one is referenced by its file path. */
export const MAX_INLINE_EVIDENCE_BYTES = 1024 * 1024;

/** Statuses an agent posts. `open` is where new feedback starts; agents never reopen a thread. */
export const AGENT_STATUSES = ["working", "needs-info", "done", "resolved"] as const;

export interface ToolContext {
  readonly server: McpServer;
  readonly client: DaemonClient;
  /** Aborted when the MCP server closes, which ends every wait. */
  readonly closing: AbortSignal;
  /** How often a waiting `wait_for_feedback` sends a progress notification, when the client asked for progress. */
  readonly heartbeatMs: number;
  readonly onError: (error: unknown) => void;
}

function success(structured: Record<string, unknown>, extra: readonly ContentBlock[] = []): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(structured, null, 2) }, ...extra], structuredContent: structured };
}

function failure(error: IterbarToolError): CallToolResult {
  const body = { error: { code: error.code, message: error.message } };
  return { isError: true, content: [{ type: "text", text: `${error.code}: ${error.message}` }], structuredContent: body };
}

/** Runs a tool body, turning every failure into a typed tool error; unexpected ones are also reported. */
async function run(context: ToolContext, body: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof IterbarToolError) return failure(error);
    context.onError(error);
    return failure(new IterbarToolError("internal", `Unexpected error: ${error instanceof Error ? error.message : String(error)}`));
  }
}

/** The reply author for this connection: the agent, named after the MCP client when it says who it is. */
function agentAuthor(server: McpServer): ReplyAuthor {
  const name = server.server.getClientVersion()?.name?.trim().slice(0, 100);
  return { kind: "agent", name: name ? name : null };
}

function attachmentsOf(feedback: Feedback): AttachmentRef[] {
  return [feedback.screenshot, feedback.evidence?.attachment].filter((ref): ref is AttachmentRef => Boolean(ref));
}

function describeEvents(events: readonly FeedbackEvent[]) {
  return events.map((event) => ({
    feedbackId: event.feedbackId,
    kind: event.kind,
    at: new Date(event.at).toISOString(),
    ...(event.replyId ? { replyId: event.replyId } : {}),
  }));
}

const cursorInput = z.string().max(1_000_000).optional();

const feedbackId = idSchema.describe("The feedback item's id, as returned by list_feedback or wait_for_feedback.");

export function registerTools(context: ToolContext): void {
  const { server, client } = context;

  server.registerTool("list_feedback", {
    title: "List Iterbar feedback",
    description:
      "List feedback items (comments and variant choices) that users sent from the Iterbar dev bar, oldest first, each " +
      "with its thread of replies, status and attachment references. Filters are optional. Also returns a cursor for " +
      "wait_for_feedback. Pass your latest cursor in: without filters, the result says what is new since that cursor " +
      "and the cursor moves past it; with filters, your cursor comes back unchanged, so nothing the filters hid is " +
      "skipped. Without a cursor, the returned one counts everything sent so far as seen.",
    inputSchema: {
      status: feedbackStatusSchema.optional().describe("Only items with this status, e.g. \"open\" for unhandled feedback."),
      kind: feedbackKindSchema.optional().describe("\"comment\" or \"choose_variant\"."),
      since: timestampSchema.optional().describe("Only items updated at or after this ISO 8601 timestamp."),
      cursor: cursorInput.describe("Your latest cursor from list_feedback or wait_for_feedback."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (input) => run(context, async () => {
    const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const filtered = input.status !== undefined || input.kind !== undefined || input.since !== undefined;
    if (!filtered) {
      const items = await client.listFeedback();
      if (cursor) {
        // Every listed event is shown to the agent, so the cursor may move past all of them.
        const events = unseenEvents(cursor, items);
        return success({ items, events: describeEvents(events), cursor: encodeCursor(observeListing(cursor, items)) });
      }
      // A second listing proves when the first was committed, so the cursor keeps only the newest events by key.
      const shown = await client.listFeedback();
      return success({ items: shown, cursor: encodeCursor(cursorAfter(items, shown)) });
    }
    // The agent sees only the filtered items, so the cursor must not count anything else as seen: an agent's cursor
    // comes back unchanged. Without one, the cursor starts now; it is taken before the filtered listing, so an item
    // that arrives in between is handed over again by the next wait, never skipped.
    const next: FeedbackCursor = cursor ?? cursorAfter(await client.listFeedback(), await client.listFeedback());
    const items = await client.listFeedback({
      ...(input.status ? { status: input.status } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.since ? { since: input.since } : {}),
    });
    return success({ items, cursor: encodeCursor(next) });
  }));

  server.registerTool("get_feedback", {
    title: "Read Iterbar feedback",
    description:
      "Read one feedback item with its thread, target element, source location and active variants. By default its " +
      "attachments are included: the screenshot as an image and the runtime evidence (console, network and errors " +
      "around the moment it was sent) as JSON. Each attachment's file path is also given.",
    inputSchema: {
      feedbackId,
      includeAttachments: z.boolean().default(true).describe("Return the screenshot and evidence contents (default true)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (input) => run(context, async () => {
    const feedback = await client.getFeedback(input.feedbackId);
    const blocks: ContentBlock[] = [];
    const attachments = [];
    for (const ref of attachmentsOf(feedback)) {
      const path = attachmentPath(client.paths.projectRoot, feedback.id, ref);
      let inlined = false;
      if (input.includeAttachments && (ref.kind === "screenshot" || ref.byteLength <= MAX_INLINE_EVIDENCE_BYTES)) {
        const data = Buffer.from(await client.getAttachment(feedback.id, ref.id));
        blocks.push(ref.kind === "screenshot"
          ? { type: "image", data: data.toString("base64"), mimeType: ref.mediaType }
          : { type: "resource", resource: { uri: pathToFileURL(path).href, mimeType: ref.mediaType, text: data.toString("utf8") } });
        inlined = true;
      }
      attachments.push({ id: ref.id, kind: ref.kind, mediaType: ref.mediaType, byteLength: ref.byteLength, path, inlined });
    }
    return success({ feedback, attachments }, blocks);
  }));

  server.registerTool("reply", {
    title: "Reply to Iterbar feedback",
    description:
      "Post a reply in a feedback item's thread, shown to the user in the dev bar. Use it to say what you changed, or " +
      "to ask a question (then set the status to needs-info).",
    inputSchema: {
      feedbackId,
      text: z.string().max(20_000).refine((text) => text.trim().length > 0, "must not be blank").describe("The reply, plain text."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (input) => run(context, async () => {
    const feedback = await client.reply(input.feedbackId, agentAuthor(server), input.text);
    return success({ feedback });
  }));

  server.registerTool("set_status", {
    title: "Set Iterbar feedback status",
    description:
      "Post a feedback item's status, shown live in the dev bar: \"working\" when you start on it, \"needs-info\" when " +
      "you asked a question, \"done\" when the change is made, \"resolved\" to close the thread.",
    inputSchema: {
      feedbackId,
      status: z.enum(AGENT_STATUSES).describe("working, needs-info, done or resolved."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => run(context, async () => {
    const feedback = await client.setStatus(input.feedbackId, input.status);
    return success({ feedback });
  }));

  server.registerTool("list_slots", {
    title: "List Iterbar slots",
    description:
      "List the variant slots that dev-bar pages reported, per page URL: each slot's versions, default version, the " +
      "version currently shown and how many times it is mounted.",
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => run(context, async () => success({ pages: await client.listSlots() })));

  server.registerTool("wait_for_feedback", {
    title: "Wait for Iterbar feedback",
    description:
      "Block until a user sends new feedback or replies in a thread, or until the timeout passes. Returns the items with " +
      "something new, what is new in each, and a cursor. Pass the cursor from the previous list_feedback or " +
      "wait_for_feedback call so nothing in between is missed; without one, only what arrives after the call counts. " +
      "Your own replies and status changes never end the wait.",
    inputSchema: {
      cursor: cursorInput.describe("The cursor from the previous list_feedback or wait_for_feedback result."),
      timeoutSeconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).default(DEFAULT_WAIT_SECONDS)
        .describe(`How long to wait, in seconds (default ${DEFAULT_WAIT_SECONDS}, at most ${MAX_WAIT_SECONDS}).`),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (input, extra) => run(context, async () => {
    const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const progressToken = extra._meta?.progressToken;
    const result = await waitForFeedback(client, {
      ...(cursor ? { cursor } : {}),
      timeoutMs: input.timeoutSeconds * 1000,
      signal: AbortSignal.any([extra.signal, context.closing]),
      heartbeatMs: context.heartbeatMs,
      // Progress keeps clients that reset their request timeout on progress waiting for the whole timeout.
      ...(progressToken === undefined ? {} : {
        onHeartbeat: (elapsedMs: number) => {
          void extra.sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              // Seconds waited; strictly increasing, as progress must be.
              progress: elapsedMs / 1000,
              total: input.timeoutSeconds,
              message: "Waiting for feedback",
            },
          }).catch(() => undefined);
        },
      }),
    });
    return success({
      outcome: result.outcome,
      items: result.items,
      events: describeEvents(result.events),
      // Missing only when a wait without a cursor ended before its first listing; wait again without one.
      ...(result.cursor ? { cursor: encodeCursor(result.cursor) } : {}),
    });
  }));
}
