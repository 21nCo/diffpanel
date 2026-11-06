<!-- An outer slot whose version mounts and unmounts an inner slot. -->
<script lang="ts">
  import Inner from "./Inner.svelte";

  let shown = $state(false);
</script>

{#if shown}<Inner />{/if}
<button type="button" onclick={() => (shown = !shown)}>toggle</button>
