/** The id the documented rule identifies an event by: its `feedbackId` for `created`, its `replyId` for `user_reply`. */
export function eventId(event: { readonly kind: "created" | "user_reply"; readonly feedbackId: string; readonly replyId?: string }): string {
  return event.kind === "created" ? `created:${event.feedbackId}` : `user_reply:${event.replyId ?? ""}`;
}

/**
 * What an agent-facing text gets wrong about delivery: each missing statement of at-least-once delivery or of the
 * handled-event rule, and each exactly-once claim or reply-order skip rule it makes. Empty when the text states the
 * contract.
 */
export function deliveryContractProblems(text: string): string[] {
  const plain = text.replace(/`/g, "").replace(/\s+/g, " ");
  const required: [string, RegExp][] = [
    ["at-least-once delivery", /delivered at least once/i],
    ["an event can come back", /event you already got can come back|can be handed over again/i],
    ["events are identified by id", /created event is identified by its feedbackId and a user_reply event by its replyId/i],
    ["skip only handled events", /skip an event you already handled/i],
    ["a reply sent while working is new", /user reply that arrived while you were working, even when your own reply now comes after it/i],
  ];
  const forbidden = [
    /exactly what is new/i, /handed to you twice/i, /(missed|returned) or (handed over|returned) twice/i, /exactly once/i,
    // A later agent reply does not prove an earlier user reply was read.
    /when an agent reply comes after/i, /already has an agent reply/i,
  ];
  return [
    ...required.filter(([, pattern]) => !pattern.test(plain)).map(([name]) => `missing: ${name}`),
    ...forbidden.filter((pattern) => pattern.test(plain)).map((pattern) => `wrong rule: ${pattern.source}`),
  ];
}
