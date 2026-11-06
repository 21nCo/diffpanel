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
  // Set before the template first renders, and only in the browser: the server runs no effects, so it renders
  // the default and never reaches the registry or `window`.
  let browser = $state(false);
  $effect.pre(() => {
    browser = true;
  });
  // Counts registry changes, so `activeVersion` reads the registry's selection again after each one.
  let changes = $state(0);
  // Read while rendering, as React's useSyncExternalStore does: a client mount renders the selected version at
  // once, and new versions without the active one render their default at once.
  const activeVersion = $derived.by(() => {
    void changes;
    const current = definition;
    return browser ? (provided ?? getVariantsRegistry()).activeVersion(current) : current.defaultVersion;
  });
  let start = $state<HTMLTemplateElement>();
  let end = $state<HTMLTemplateElement>();

  // Runs only in the browser, after mount: registers the slot and follows the registry's selections.
  $effect(() => {
    const current = definition;
    const registry = provided ?? getVariantsRegistry();
    // Untracked: registering notifies at once, and this effect must not depend on the count it bumps.
    const unsubscribe = registry.subscribe(() => untrack(() => (changes += 1)));
    const unregister = registry.register(current);
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
<!-- The server renders the default branch. A client that selects another version takes the other branch, so
     hydration replaces the server's default instead of mounting it first. -->
{#if activeVersion === definition.defaultVersion}
  <Version content={versionContent(versions, activeVersion)} />
{:else}
  {#key activeVersion}
    <Version content={versionContent(versions, activeVersion)} />
  {/key}
{/if}
<template bind:this={end} data-iterbar-slot-boundary="end"></template>
