<script lang="ts">
  import { versionContent } from "./content.js";
  import type { VariantsProps, VersionContent } from "./types.js";
  import Version from "./Version.svelte";

  let props: VariantsProps<Readonly<Record<string, VersionContent>>> = $props();
</script>

<Version content={versionContent(props.versions, props.default)} />
