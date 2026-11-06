<!-- Snippet versions beside component versions; a snippet can pass props, which a version component cannot. -->
<script lang="ts">
  import { Variants } from "../../src/index.js";
  import PlanOne from "./PlanOne.svelte";
  import Plan from "./Plan.svelte";
</script>

{#snippet compact()}<Plan name="compact" />{/snippet}
{#snippet text()}Plan as text{/snippet}

<Variants slot="pricing" versions={{ v1: PlanOne, v2: { snippet: compact }, v3: { snippet: text } }} default="v1" />
