<!-- A version that logs when it mounts and unmounts. -->
<script lang="ts">
  import { onDestroy } from "svelte";

  let { name, log }: { name: string; log: string[] } = $props();
  const record = (event: string) => log.push(`${event} ${name}`);
  record("mount");
  onDestroy(() => record("unmount"));
</script>

<p>{name}</p>
