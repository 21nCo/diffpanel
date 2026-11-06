<script lang="ts">
  import { Variants } from "../../src/index.js";
</script>

{#snippet a()}<p>Inner A</p>{/snippet}
{#snippet b()}<p>Inner B</p>{/snippet}

<Variants slot="inner" versions={{ a: { snippet: a }, b: { snippet: b } }} default="a" />
