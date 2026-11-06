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

  // Without a bundler's replacement, reading `process.env.NODE_ENV` throws in a page with no `process` (or no
  // `process.env`), which is not development; so it is read inside `try` first.
  const readable = (() => {
    try {
      return process.env.NODE_ENV === "development";
    } catch {
      return false;
    }
  })();
  // The bare check, repeated outside `try`, folds to a literal once a bundler replaces `process.env.NODE_ENV`,
  // so Rollup (which keeps everything inside `try` by default) and esbuild both drop DevelopmentVariants from
  // other builds, and a development build needs no `process` global.
  const Implementation =
    readable && process.env.NODE_ENV === "development" ? DevelopmentVariants : ProductionVariants;
</script>

<Implementation {...props} />
