<!-- Variants with every prop from the test, optionally under a VariantsProvider. -->
<script lang="ts">
  import type { VariantsRegistry } from "@iterbar/variants";
  import { Variants, VariantsProvider, type VersionContent } from "../../src/index.js";

  let {
    slot,
    versions,
    default: defaultVersion,
    registry,
  }: { slot: string; versions: Record<string, VersionContent>; default: string; registry?: VariantsRegistry } = $props();
</script>

{#if registry}
  <VariantsProvider {registry}>
    <div><Variants {slot} {versions} default={defaultVersion} /></div>
  </VariantsProvider>
{:else}
  <Variants {slot} {versions} default={defaultVersion} />
{/if}
