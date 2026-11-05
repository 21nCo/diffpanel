/** The id the documented rule identifies an event by: its `feedbackId` for `created`, its `replyId` for `user_reply`. */
export function eventId(event: { readonly kind: "created" | "user_reply"; readonly feedbackId: string; readonly replyId?: string }): string {
  return event.kind === "created" ? `created:${event.feedbackId}` : `user_reply:${event.replyId ?? ""}`;
}

/**
 * What an agent-facing text gets wrong about delivery: each missing statement of at-least-once delivery, of the
 * handled-event rule or of the session rule (what to read at the start of a session, before finishing a thread and
 * before stopping), and each exactly-once claim, reply-order rule or filtered-only skip rule it makes. Empty when the
 * text states the contract.
 */
export function deliveryContractProblems(text: string): string[] {
  const plain = text.replaceAll("`", "").replace(/\s+/g, " ");
  const required: [string, RegExp][] = [
    ["at-least-once delivery", /delivered at least once/i],
    ["an event can come back", /event you already got can come back|can be handed over again/i],
    ["events are identified by id", /created event is identified by its feedbackId and a user_reply event by its replyId/i],
    ["skip only handled events", /skip an event you already handled/i],
    ["a reply sent while working is new", /user reply that arrived while you were working, even when your own reply now comes after it/i],
    ["a session starts by reading every unresolved thread", /at the start of a session read every item that is not resolved with get_feedback, done ones included/i],
    ["an unanswered user reply is found by content", /answer any user reply that no later agent reply answers, judged by what the replies say, not by who wrote last/i],
    ["a thread is re-read before it is finished", /right before you reply and set a thread done or needs-info, read it again with get_feedback/i],
    ["a final unfiltered cursor call before stopping", /before you stop, call list_feedback without filters and with your latest cursor once more/i],
  ];
  const forbidden = [
    /exactly what is new/i, /handed to you twice/i, /(missed|returned) or (handed over|returned) twice/i, /exactly once/i,
    // A later agent reply does not prove an earlier user reply was read.
    /when an agent reply comes after/i, /already has an agent reply/i, /last reply is from the user/i,
    // Replays come from either tool, not only after a filtered lookup.
    /if you did act on an item it showed, skip that event/i,
  ];
  return [
    ...required.filter(([, pattern]) => !pattern.test(plain)).map(([name]) => `missing: ${name}`),
    ...forbidden.filter((pattern) => pattern.test(plain)).map((pattern) => `wrong rule: ${pattern.source}`),
  ];
}
