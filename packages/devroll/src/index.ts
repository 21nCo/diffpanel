/** Release status of a Devroll tool. */
export type DevrollToolStatus = "preview" | "planned";

/** One developer tool in the Devroll family. */
export interface DevrollTool {
  /** Stable identifier, also the tool's directory under `products/`. */
  readonly id: string;
  /** Display name. */
  readonly name: string;
  /** One-sentence summary of what the tool does. */
  readonly summary: string;
  /** Primary npm package name. */
  readonly packageName: string;
  /** Current release status. */
  readonly status: DevrollToolStatus;
}

/** The tools that live in the Devroll repository. */
export const tools: readonly DevrollTool[] = Object.freeze([
  Object.freeze({
    id: "diffpanel",
    name: "Diffpanel",
    summary: "Local-first, agent-generated code review chapters across editor surfaces.",
    packageName: "diffpanel",
    status: "preview",
  }),
  Object.freeze({
    id: "iterbar",
    name: "Iterbar",
    summary:
      "Dev-mode bar for switching design variants, annotating UI and sending feedback with runtime evidence to local coding agents.",
    packageName: "iterbar",
    status: "planned",
  }),
]);

/** Returns the tool with the given identifier, or `undefined` when none matches. */
export function findTool(id: string): DevrollTool | undefined {
  return tools.find((tool) => tool.id === id);
}
