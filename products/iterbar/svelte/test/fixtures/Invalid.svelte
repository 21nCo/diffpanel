<script lang="ts">
  import { Variants } from "../../src/index.js";
  import PlanOne from "./PlanOne.svelte";

  let { onerror }: { onerror: (error: unknown) => void } = $props();
</script>

<svelte:boundary {onerror}>
  <Variants slot="bad slot" versions={{ v1: PlanOne }} default="v1" />
  {#snippet failed()}<p>failed</p>{/snippet}
</svelte:boundary>
