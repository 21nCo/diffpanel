<!-- A slot of logged versions with the given names, followed by a log of what it shows as each update renders. -->
<script lang="ts">
  import { Variants } from "../../src/index.js";
  import AfterSlot from "./AfterSlot.svelte";
  import Logged from "./Logged.svelte";

  let { names, log }: { names: ("a" | "b" | "c")[]; log: string[] } = $props();
  let element = $state<HTMLElement>();
  const all = { a: { snippet: a }, b: { snippet: b }, c: { snippet: c } };
  const versions = $derived(Object.fromEntries(names.map((name) => [name, all[name]])));
</script>

{#snippet a()}<Logged name="a" {log} />{/snippet}
{#snippet b()}<Logged name="b" {log} />{/snippet}
{#snippet c()}<Logged name="c" {log} />{/snippet}

<div bind:this={element}><Variants slot="probe" {versions} default="a" /></div>
<AfterSlot {element} {versions} {log} />
