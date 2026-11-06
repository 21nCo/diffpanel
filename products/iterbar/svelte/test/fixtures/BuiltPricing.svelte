<!-- The pricing slot from the built package, as a consumer imports it. -->
<script>
  import { Variants } from "../../dist/index.js";
  import PlanOne from "./PlanOne.svelte";
  import PlanTwo from "./PlanTwo.svelte";
</script>

<Variants slot="pricing" versions={{ v1: PlanOne, v2: PlanTwo }} default="v1" />
