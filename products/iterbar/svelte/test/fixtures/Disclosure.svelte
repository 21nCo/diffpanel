<!-- A version that replaces its own root element. -->
<script lang="ts">
  let open = $state(false);
</script>

{#if open}
  <section>Details</section>
{:else}
  <button type="button" onclick={() => (open = true)}>More</button>
{/if}
