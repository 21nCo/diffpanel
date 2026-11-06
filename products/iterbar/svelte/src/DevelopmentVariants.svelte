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
  // The server's id while this instance hydrates the server's markup; a new one on a client mount.
  const instance = $props.id();
  // Whether to render the registry's selection rather than the default. The server runs no effects, so it
  // renders the default and never reaches the registry or `window`. In the browser this is set before the
  // template first renders: a client mount renders the selected version at once, as React's
  // useSyncExternalStore does; an instance whose server markup is on the page hydrates the default, and the
  // effect below switches right after hydration.
  let live = $state(false);
  $effect.pre(() => {
    live = !document.querySelector(`template[data-iterbar-instance="${instance}"]`);
  });
  // Counts registry changes, so `activeVersion` reads the registry's selection again after each one.
  let changes = $state(0);
  // Read while rendering: new versions without the active one render their default in the same update.
  const activeVersion = $derived.by(() => {
    void changes;
    const current = definition;
    return live ? (provided ?? getVariantsRegistry()).activeVersion(current) : current.defaultVersion;
  });
  let start = $state<HTMLTemplateElement>();
  let end = $state<HTMLTemplateElement>();

  // Runs only in the browser, after mount: registers the slot and follows the registry's selections.
  $effect(() => {
    const current = definition;
    const registry = provided ?? getVariantsRegistry();
    // Untracked: registering notifies at once, and this effect must not depend on the count it bumps.
    const unsubscribe = registry.subscribe(() => untrack(() => (changes += 1)));
    let unregister: () => void;
    try {
      unregister = registry.register(current);
    } catch (error) {
      unsubscribe();
      throw error;
    }
    live = true;
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

<template bind:this={start} data-iterbar-slot-boundary="start" data-iterbar-instance={instance}></template>
{#key activeVersion}
  <Version content={versionContent(versions, activeVersion)} />
{/key}
<template bind:this={end} data-iterbar-slot-boundary="end"></template>
