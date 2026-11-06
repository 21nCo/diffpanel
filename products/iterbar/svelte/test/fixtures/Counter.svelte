<script lang="ts">
  let count = $state(0);
</script>

<button type="button" onclick={() => (count += 1)}>clicked {count}</button>
