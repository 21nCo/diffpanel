<!-- Placed after a slot: logs what `element` shows whenever `versions` change, as the update renders, after the
     slot's markup updates and before any `$effect` runs. -->
<script lang="ts">
  let { element, versions, log }: { element?: HTMLElement; versions: object; log: string[] } = $props();

  $effect.pre(() => {
    void versions;
    log.push(`shows ${element?.textContent?.trim()}`);
  });
</script>
