<!--
  StatRow: the quiet row of figures at the top of a platform's analytics: impressions, product page views, downloads,
  conversion, crash rate, rating, each a StatChip with how it compares with the previous period underneath. A figure with no
  data is not drawn. A change is colored only by whether the direction is good for that measure, and always carries a sign, an
  arrow and words; a comparison that cannot be made says "Not enough data to compare" instead of a number.
  The tiles sit in a uniform grid (equal width and height). Props: chips (StatChipModel[]), days (the length of the period, for the sentence).
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
  import type { StatChipModel } from '../../lib/analytics/view.ts';
  import Icon from '../ui/Icon.svelte';
  import StatChip from '../ui/StatChip.svelte';

  let { chips, days }: { chips: StatChipModel[]; days: number } = $props();
</script>

{#if chips.length > 0}
  <ul class="stats" aria-label={t('analytics:stat.label')}>
    {#each chips as chip (chip.id)}
      <li class="accent-edge" title={chip.title}>
        <StatChip label={chip.label} value={chip.value} />
        <span class="delta {chip.tone}" aria-label={chip.line ? chip.spoken : undefined}>
          {#if chip.delta.kind === 'change'}<Icon name={chip.delta.direction === 'up' ? 'arrow-up' : 'arrow-down'} size={12} />{/if}
          <span aria-hidden="true">{chip.line || '\u00a0'}</span>
        </span>
      </li>
    {/each}
  </ul>
  <span class="visually-hidden">{t('analytics:stat.compared', { count: days })}</span>
{/if}

<style>
  /* A uniform grid: every tile the same width and (the row stretches them) the same height, so there are no ragged holes. */
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
    gap: var(--space-3);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  /* Each figure is a small summary card with the gradient edge (.accent-edge, styles/accents.css). */
  li {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    align-items: flex-start;
    justify-content: space-between;
    min-width: 0;
    padding: var(--space-3) var(--space-4);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-card);
  }

  /* The figure sits straight on the card: no second pill border inside it (a box in a box). */
  li :global(.statchip) {
    min-height: 0;
    padding: 0;
    line-height: var(--leading-snug);
    background: transparent;
    border: 0;
  }

  li :global(.statchip .v) {
    font-size: var(--text-xl);
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
