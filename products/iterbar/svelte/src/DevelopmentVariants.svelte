<script lang="ts">
  import {
    getVariantsRegistry,
    markSlotRange,
    validateSlotDefinition,
  } from "@iterbar/variants";
  import { versionContent } from "./content.js";
  import { providedRegistry } from "./context.js";
  import type { VariantsProps, VersionContent } from "./types.js";
  import { untrack } from "svelte";
  import Version from "./Version.svelte";

  let { slot, versions, default: defaultVersion }: VariantsProps<Readonly<Record<string, VersionContent>>> = $props();

  const readProvided = providedRegistry();
  // Derived, so the effect below re-registers only when the provided registry itself changes.
  const provided = $derived(readProvided());
  // A string, so new props with the same slot, version names and default do not register the slot again.
  const key = $derived(JSON.stringify([slot, Object.keys(versions), defaultVersion]));
  // Throws `invalid_message` for an invalid slot, version name or default.
  const definition = $derived.by(() => {
    const [name, names, initial] = JSON.parse(key) as [string, string[], string];
    return validateSlotDefinition({ slot: name, versions: names, defaultVersion: initial });
  });
  // The server and the hydrating client both render the default; the effect below switches after mount.
  let activeVersion = $state(untrack(() => definition.defaultVersion));
  let start = $state<HTMLTemplateElement>();
  let end = $state<HTMLTemplateElement>();

  // Runs only in the browser, after mount: the server never reaches the registry or `window`.
  $effect(() => {
    const current = definition;
    const registry = provided ?? getVariantsRegistry();
    const unregister = registry.register(current);
    const update = () => {
      activeVersion = registry.activeVersion(current);
    };
    const unsubscribe = registry.subscribe(update);
    update();
    return () => {
      unsubscribe();
      unregister();
    };
  });

  // Re-run on every switch so the new version's elements are marked as soon as it renders; between switches,
  // the range observer follows elements the version itself adds or replaces.
  $effect(() => {
    void activeVersion;
    if (!start || !end) return undefined;
    return markSlotRange(start, end, definition.slot);
  });
</script>

<template bind:this={start} data-iterbar-slot-boundary="start"></template>
{#key activeVersion}
  <Version content={versionContent(versions, activeVersion)} />
{/key}
<template bind:this={end} data-iterbar-slot-boundary="end"></template>
