import type { VariantsRegistry } from "@iterbar/variants";
import { getContext, hasContext, setContext } from "svelte";

/** Shared by every copy of this package on the page, like the registry itself. */
const REGISTRY_CONTEXT = Symbol.for("iterbar.svelte.registry.v1");

interface RegistryContext {
  readonly registry: VariantsRegistry;
}

/** Makes `Variants` below the calling component read `registry` whenever they need it. */
export function provideRegistry(context: RegistryContext): void {
  setContext(REGISTRY_CONTEXT, context);
}

/** The registry a `VariantsProvider` above supplies, read when called; `null` without a provider. */
export function providedRegistry(): () => VariantsRegistry | null {
  const context = hasContext(REGISTRY_CONTEXT) ? getContext<RegistryContext>(REGISTRY_CONTEXT) : null;
  return () => context?.registry ?? null;
}
