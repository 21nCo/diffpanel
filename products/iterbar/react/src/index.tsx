"use client";

import {
  getVariantsRegistry,
  markSlotRange,
  SLOT_BOUNDARY_ATTRIBUTE,
  validateSlotDefinition,
  type VariantsRegistry,
} from "@iterbar/variants";
import {
  createContext,
  createElement,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ComponentType,
  type JSX,
  type ReactNode,
} from "react";

export type { VariantsRegistry } from "@iterbar/variants";

/**
 * One version of a slot: a component that takes no props (`PricingV2`), rendered as `<PricingV2 />`, or any
 * React node (`<PricingV2 compact />`, text, `null`).
 */
export type VersionContent = ComponentType | ReactNode;

/** Props for {@link Variants}. */
export interface VariantsProps<Versions extends Readonly<Record<string, VersionContent>>> {
  /** The slot name shown in the bar and used in the `iterbar` URL parameter, such as `pricing`. */
  readonly slot: string;
  /** Each version, keyed by version name (1-64 letters, digits, `_`, `.` or `-`). */
  readonly versions: Versions;
  /** The version to render when nothing selects another, and the only one rendered in production. */
  readonly default: Extract<keyof Versions, string>;
}

const RegistryContext = /* @__PURE__ */ createContext<VariantsRegistry | null>(null);

/**
 * Makes every {@link Variants} below it use `registry` instead of the page's shared registry, for example in
 * tests or in a second React root that must not appear in `window.__ITERBAR__`.
 */
export function VariantsProvider({ registry, children }: {
  readonly registry: VariantsRegistry;
  readonly children?: ReactNode;
}): JSX.Element {
  return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>;
}

/** `memo`, `forwardRef` and `lazy` components are objects rather than functions. */
const COMPONENT_OBJECT_TYPES = new Set<unknown>([
  Symbol.for("react.memo"),
  Symbol.for("react.forward_ref"),
  Symbol.for("react.lazy"),
]);

function isComponentType(content: VersionContent): content is ComponentType {
  if (typeof content === "function") return true;
  return typeof content === "object" && content !== null
    && COMPONENT_OBJECT_TYPES.has((content as { $$typeof?: unknown }).$$typeof);
}

function renderVersion(versions: Readonly<Record<string, VersionContent>>, version: string): ReactNode {
  if (!Object.hasOwn(versions, version)) return null;
  const content = versions[version];
  return isComponentType(content) ? createElement(content) : content;
}

/**
 * Renders one version of a slot. In development the version comes from the `iterbar` URL parameter
 * (`?iterbar=pricing:v2`), then local storage, then `default`, and the bar can switch it in place through
 * `window.__ITERBAR__`. The version's top-level elements are marked with `data-iterbar-slot`; empty
 * `<template>` elements before and after it delimit the slot, so it adds no wrapper and stays valid inside
 * `<p>`, `<ul>` and `<tbody>`. A slot rendered at the top level of another slot's version keeps its own marks:
 * each element is marked with the innermost slot that renders it.
 *
 * Development means `process.env.NODE_ENV === "development"`; any other value, or none, renders `default`
 * only, with no markers and no registry; so does a page without a `process` global when nothing replaced
 * `process.env.NODE_ENV`. The condition is written inline, so a bundler that replaces it needs no `process`
 * global and drops the development code from other builds.
 */
export function Variants<Versions extends Readonly<Record<string, VersionContent>>>(
  props: VariantsProps<Versions>,
): JSX.Element {
  // The bare check folds to a literal once a bundler replaces `process.env.NODE_ENV`, even inside `try`, so
  // other builds drop DevelopmentVariants and a development build needs no `process` global. Without that
  // replacement, a page with no `process` (or no `process.env`) is not development.
  try {
    if (process.env.NODE_ENV === "development") return <DevelopmentVariants {...props} />;
  } catch {
    // Not development.
  }
  return <>{renderVersion(props.versions, props.default)}</>;
}

function DevelopmentVariants<Versions extends Readonly<Record<string, VersionContent>>>({
  slot,
  versions,
  default: defaultVersion,
}: VariantsProps<Versions>): JSX.Element {
  const providedRegistry = useContext(RegistryContext);
  const versionNames = JSON.stringify(Object.keys(versions));
  // Throws `invalid_message` during render for an invalid slot, version name or default.
  const definition = useMemo(
    () => validateSlotDefinition({ slot, versions: JSON.parse(versionNames) as string[], defaultVersion }),
    [slot, versionNames, defaultVersion],
  );
  const registry = useCallback(() => providedRegistry ?? getVariantsRegistry(), [providedRegistry]);
  const subscribe = useCallback((onChange: () => void) => registry().subscribe(onChange), [registry]);
  const getSnapshot = useCallback(() => registry().activeVersion(definition), [registry, definition]);
  const getServerSnapshot = useCallback(() => definition.defaultVersion, [definition]);
  const activeVersion = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const start = useRef<HTMLTemplateElement>(null);
  const end = useRef<HTMLTemplateElement>(null);

  useEffect(() => registry().register(definition), [registry, definition]);

  // Re-run on every switch so the new version's elements are marked as soon as it commits; between
  // switches, the range observer follows elements the version itself adds or replaces.
  useEffect(() => {
    if (!start.current || !end.current) return undefined;
    return markSlotRange(start.current, end.current, definition.slot);
  }, [definition.slot, activeVersion]);

  return (
    <>
      <template ref={start} {...{ [SLOT_BOUNDARY_ATTRIBUTE]: "start" }} />
      <Fragment key={activeVersion}>{renderVersion(versions, activeVersion)}</Fragment>
      <template ref={end} {...{ [SLOT_BOUNDARY_ATTRIBUTE]: "end" }} />
    </>
  );
}
