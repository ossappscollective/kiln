<!--
  AsoBar: the action bar of an ASO view. It stays below the top bar while the list scrolls, so "Add" and
  "Check now" are always in reach. Props: children (the controls, usually a row with a spacer).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let { children, label = 'Actions' }: { children: Snippet; label?: string | undefined } = $props();
</script>

<div class="asobar" role="toolbar" aria-label={label}>{@render children()}</div>

<style>
  .asobar {
    position: sticky;
    top: var(--topbar-height);
    z-index: calc(var(--z-sticky) - 1);
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
    padding: var(--space-2) 0;
    margin-bottom: var(--space-3);
    background: var(--ground);
    border-bottom: 1px solid var(--line);
  }
</style>
