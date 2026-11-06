<script lang="ts">
  import type { VersionContent } from "./types.js";

  let { content }: { content: VersionContent | undefined } = $props();
</script>

{#if typeof content === "function"}
  {@const Content = content}
  <Content />
{:else if content}
  {@render content.snippet()}
{/if}
