<!-- A counter beside the pricing slot, and as many pricing instances as `copies` asks for. -->
<script lang="ts">
  import Counter from "./Counter.svelte";
  import Pricing from "./Pricing.svelte";

  let { copies = 1 }: { copies?: number } = $props();
</script>

<Counter />
{#each { length: copies }, index (index)}
  <Pricing />
{/each}
