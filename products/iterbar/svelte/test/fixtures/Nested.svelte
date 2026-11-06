<!-- An inner slot at the top level of the outer slot's version: a component version or a snippet with a sibling. -->
<script lang="ts">
  import { Variants } from "../../src/index.js";
  import Inner from "./Inner.svelte";

  let { form }: { form: "component" | "snippet" } = $props();
</script>

{#snippet withSibling()}<Inner /><p>Outer one</p>{/snippet}
{#snippet two()}<p>Outer two</p>{/snippet}

<div>
  <Variants slot="outer" versions={{ v1: form === "component" ? Inner : { snippet: withSibling }, v2: { snippet: two } }} default="v1" />
</div>
