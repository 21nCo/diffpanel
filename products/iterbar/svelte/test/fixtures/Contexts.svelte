<!-- A slot inside markup that only allows certain children: inline text in a <p>, <tr> in a <tbody>, <li> in a <ul>. -->
<script lang="ts">
  import { Variants } from "../../src/index.js";

  let { where }: { where: "paragraph" | "table" | "list" } = $props();
</script>

{#snippet ten()}<strong>ten</strong>{/snippet}
{#snippet twelve()}<em>twelve</em>{/snippet}
{#snippet rowA()}<tr><td>Row A</td></tr>{/snippet}
{#snippet rowB()}<tr><td>Row B</td></tr>{/snippet}
{#snippet itemA()}<li>Item A</li>{/snippet}
{#snippet itemB()}<li>Item B</li>{/snippet}

{#if where === "paragraph"}
  <p>Price: <Variants slot="demo" versions={{ a: { snippet: ten }, b: { snippet: twelve } }} default="a" /> per month</p>
{:else if where === "table"}
  <table><tbody><Variants slot="demo" versions={{ a: { snippet: rowA }, b: { snippet: rowB } }} default="a" /></tbody></table>
{:else}
  <ul><Variants slot="demo" versions={{ a: { snippet: itemA }, b: { snippet: itemB } }} default="a" /></ul>
{/if}
