<!--
  Renders one version of a slot. In development the version comes from the `iterbar` URL parameter
  (`?iterbar=pricing:v2`), then local storage, then `default`, and the bar can switch it in place through
  `window.__ITERBAR__`. Development means `process.env.NODE_ENV === "development"`; anything else renders
  `default` only, with no markers and no registry.
-->
<script lang="ts" generics="Versions extends Readonly<Record<string, VersionContent>>">
  import DevelopmentVariants from "./DevelopmentVariants.svelte";
  import ProductionVariants from "./ProductionVariants.svelte";
  import type { VariantsProps, VersionContent } from "./types.js";

  let props: VariantsProps<Versions> = $props();

  // The bare check folds to a literal once a bundler replaces `process.env.NODE_ENV`, even inside `try`, so
  // other builds drop DevelopmentVariants and a development build needs no `process` global. Without that
  // replacement, a page with no `process` (or no `process.env`) is not development.
  const Implementation = (() => {
    try {
      if (process.env.NODE_ENV === "development") return DevelopmentVariants;
    } catch {
      // Not development.
    }
    return ProductionVariants;
  })();
</script>

<Implementation {...props} />
