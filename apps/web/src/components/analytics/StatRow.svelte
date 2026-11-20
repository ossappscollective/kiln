<!--
  StatRow: the quiet row of figures at the top of a platform's analytics: impressions, product page views, downloads,
  conversion, crash rate, rating, each a StatChip with how it compares with the previous period underneath. A figure with no
  data is not drawn. A change is colored only by whether the direction is good for that measure, and always carries a sign, an
  arrow and words; a comparison that cannot be made says "Not enough data to compare" instead of a number.
  Props: chips (StatChipModel[]), days (the length of the period, for the sentence).
-->
<script lang="ts">
  import type { StatChipModel } from '../../lib/analytics/view.ts';
  import Icon from '../ui/Icon.svelte';
  import StatChip from '../ui/StatChip.svelte';

  let { chips, days }: { chips: StatChipModel[]; days: number } = $props();
</script>

{#if chips.length > 0}
  <ul class="stats" aria-label="Key figures">
    {#each chips as chip (chip.id)}
      <li title={chip.title}>
        <StatChip label={chip.label} value={chip.value} />
        {#if chip.line}
          <span class="delta {chip.tone}" aria-label={chip.spoken}>
            {#if chip.delta.kind === 'change'}<Icon name={chip.delta.direction === 'up' ? 'arrow-up' : 'arrow-down'} size={12} />{/if}
            <span aria-hidden="true">{chip.line}</span>
          </span>
        {/if}
      </li>
    {/each}
  </ul>
  <span class="visually-hidden">Compared with the previous {days} days.</span>
{/if}

<style>
  .stats {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3) var(--space-5);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  li {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    align-items: flex-start;
  }

  .delta {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
    padding-left: var(--space-3);
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .delta.ok {
    color: var(--ok-ink);
  }

  .delta.bad {
    color: var(--bad-ink);
  }
</style>
