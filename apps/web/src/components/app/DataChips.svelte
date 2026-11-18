<!--
  DataChips: where the data of this app lives (docs/ux-ia.md section 3): Repository, Store live and
  Store draft. Store draft is a placeholder until a connector reads it.
  Props: chips (from dataChips).
-->
<script lang="ts">
  import type { DataChip } from '../../lib/app-chips.ts';
  import Badge from '../ui/Badge.svelte';

  let { chips }: { chips: DataChip[] } = $props();
</script>

<ul class="chips" aria-label="Where the data lives">
  {#each chips as c (c.id)}
    <li title={c.title}>
      <span class="label">{c.label}</span>
      <Badge tone={c.tone} dot>{c.value}</Badge>
    </li>
  {/each}
</ul>

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  li {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
  }

  .label {
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    color: var(--muted);
  }
</style>
