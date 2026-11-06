<!--
  Makes every `Variants` below it use `registry` instead of the page's shared registry, for example in tests
  or in a second app that must not appear in `window.__ITERBAR__`.
-->
<script lang="ts">
  import type { VariantsRegistry } from "@iterbar/variants";
  import type { Snippet } from "svelte";
  import { provideRegistry } from "./context.js";

  let { registry, children }: { registry: VariantsRegistry; children?: Snippet } = $props();

  provideRegistry({
    get registry() {
      return registry;
    },
  });
</script>

{@render children?.()}
