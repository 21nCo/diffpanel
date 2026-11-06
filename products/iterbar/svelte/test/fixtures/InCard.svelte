<!-- As a direct child of a component, `slot="pricing"` would make Svelte treat Variants as legacy slot content. -->
<script lang="ts">
  import { Variants } from "../../src/index.js";
  import Card from "./Card.svelte";
  import PlanOne from "./PlanOne.svelte";
  import PlanTwo from "./PlanTwo.svelte";
</script>

<Card>
  <Variants {...{ slot: "pricing" }} versions={{ v1: PlanOne, v2: PlanTwo }} default="v1" />
</Card>
