<!--
  Spinner: an indeterminate progress ring.
  Props: size = 16 (px), label = 'Loading' (read aloud; pass '' when text nearby already says it).
-->
<script lang="ts">
  let { size = 16, label = 'Loading' }: { size?: number; label?: string } = $props();
</script>

<span class="spinner" style:width="{size}px" style:height="{size}px" role={label ? 'status' : undefined} aria-hidden={label ? undefined : 'true'}>
  {#if label}<span class="visually-hidden">{label}</span>{/if}
</span>
