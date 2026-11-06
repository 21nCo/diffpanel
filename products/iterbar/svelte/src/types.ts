import type { Component, Snippet } from "svelte";

/** A Svelte component that needs no props, such as `PricingV2`, rendered as `<PricingV2 />`. */
export type VersionComponent = Component<Record<string, never>>;

/**
 * Markup for a version, such as `{ snippet: compact }` for `{#snippet compact()}<Pricing compact />{/snippet}`.
 * Svelte cannot tell a snippet from a component at runtime, so a snippet goes in an object.
 */
export interface VersionSnippet {
  readonly snippet: Snippet;
}

/** One version of a slot: a component that takes no props, or `{ snippet }` for any other markup. */
export type VersionContent = VersionComponent | VersionSnippet;

/** Props for `Variants`. */
export interface VariantsProps<Versions extends Readonly<Record<string, VersionContent>>> {
  /** The slot name shown in the bar and used in the `iterbar` URL parameter, such as `pricing`. */
  readonly slot: string;
  /** Each version, keyed by version name (1-64 letters, digits, `_`, `.` or `-`). */
  readonly versions: Versions;
  /** The version to render when nothing selects another, and the only one rendered in production. */
  readonly default: Extract<keyof Versions, string>;
}
