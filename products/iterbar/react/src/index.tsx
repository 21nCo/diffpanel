import {
  getVariantsRegistry,
  slotRootAttributes,
  validateSlotDefinition,
  type VariantsRegistry,
} from "@iterbar/variants";
import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type JSX,
  type ReactNode,
} from "react";

export type { VariantsRegistry } from "@iterbar/variants";

/** Props for {@link Variants}. */
export interface VariantsProps<Versions extends Readonly<Record<string, ReactNode>>> {
  /** The slot name shown in the bar and used in the `iterbar` URL parameter, such as `pricing`. */
  readonly slot: string;
  /** Each version's content, keyed by version name (1-64 letters, digits, `_`, `.` or `-`). */
  readonly versions: Versions;
  /** The version to render when nothing selects another, and the only one rendered in production. */
  readonly default: Extract<keyof Versions, string>;
}

const RegistryContext = createContext<VariantsRegistry | null>(null);

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

/**
 * Bundlers replace `process.env.NODE_ENV` with a literal, as they must for React itself. Without that
 * replacement and without a `process` global, the component assumes production.
 */
function isDevelopment(): boolean {
  try {
    return process.env.NODE_ENV !== "production";
  } catch {
    return false;
  }
}

function versionContent(versions: Readonly<Record<string, ReactNode>>, version: string): ReactNode {
  return Object.hasOwn(versions, version) ? versions[version] : null;
}

/**
 * Renders one version of a slot. In development the version comes from the `iterbar` URL parameter
 * (`?iterbar=pricing:v2`), then local storage, then `default`, and the bar can switch it in place through
 * `window.__ITERBAR__`; the content is wrapped in a `display: contents` element marked with
 * `data-iterbar-slot`. In production it renders `default` only, with no wrapper and no registry.
 */
export function Variants<Versions extends Readonly<Record<string, ReactNode>>>(
  props: VariantsProps<Versions>,
): JSX.Element {
  if (!isDevelopment()) return <>{versionContent(props.versions, props.default)}</>;
  return <DevelopmentVariants {...props} />;
}

function DevelopmentVariants<Versions extends Readonly<Record<string, ReactNode>>>({
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

  useEffect(() => registry().register(definition), [registry, definition]);

  return (
    <div {...slotRootAttributes(definition.slot)} style={{ display: "contents" }}>
      <Fragment key={activeVersion}>{versionContent(versions, activeVersion)}</Fragment>
    </div>
  );
}
