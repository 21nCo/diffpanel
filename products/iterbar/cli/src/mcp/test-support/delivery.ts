import type { Feedback } from "iterbar";

/**
 * The documented rule for an event the agent already handled, applied to the item a tool returned with it: a `created`
 * event is handled once the thread has an agent reply, a `user_reply` event once an agent reply follows that reply.
 */
export function alreadyHandled(item: Feedback, event: { readonly kind: "created" | "user_reply"; readonly replyId?: string }): boolean {
  const agentReplies = item.replies.flatMap((reply, index) => (reply.author.kind === "agent" ? [index] : []));
  if (event.kind === "created") return agentReplies.length > 0;
  const answered = item.replies.findIndex((reply) => reply.id === event.replyId);
  return answered >= 0 && agentReplies.some((index) => index > answered);
}

/**
 * What an agent-facing text gets wrong about delivery: each missing statement of at-least-once delivery or of the
 * handled-event rule, and each exactly-once claim it makes. Empty when the text states the contract.
 */
export function deliveryContractProblems(text: string): string[] {
  const plain = text.replace(/`/g, "").replace(/\s+/g, " ");
  const required: [string, RegExp][] = [
    ["at-least-once delivery", /delivered at least once/i],
    ["an event can come back", /event you already got can come back|can be handed over again/i],
    ["skip a handled created event", /skip a created event when the thread already has an agent reply/i],
    ["skip a handled user_reply event", /user_reply event when an agent reply comes after the reply with that replyId/i],
    ["a newer user reply is new", /user reply that comes after your last reply is always new/i],
  ];
  const forbidden = [/exactly what is new/i, /handed to you twice/i, /(missed|returned) or (handed over|returned) twice/i, /exactly once/i];
  return [
    ...required.filter(([, pattern]) => !pattern.test(plain)).map(([name]) => `missing: ${name}`),
    ...forbidden.filter((pattern) => pattern.test(plain)).map((pattern) => `claims exactly-once: ${pattern.source}`),
  ];
}
