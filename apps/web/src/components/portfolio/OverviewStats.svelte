<!--
  OverviewStats: the strip above the all-apps table: how many apps, what is in review or rolling
  out, what needs a look and the new reviews. Counts of what the table shows.
  Props: stats (from overviewStats).
-->
<script lang="ts">
  import type { OverviewStats } from '../../lib/app-overview.ts';

  let { stats }: { stats: OverviewStats } = $props();

  const tiles = $derived([
    { label: 'Apps', value: String(stats.apps) },
    { label: 'In review', value: String(stats.inReview) },
    { label: 'Rolling out', value: String(stats.rollingOut) },
    { label: 'Need a look', value: String(stats.problems) },
    { label: 'New reviews', value: stats.newReviews === null ? '–' : String(stats.newReviews) },
  ]);
</script>

<dl class="strip" aria-label="Summary of all apps">
  {#each tiles as t (t.label)}
    <div class="tile">
      <dt>{t.label}</dt>
      <dd>{t.value}</dd>
    </div>
  {/each}
</dl>

<style>
  .strip {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: var(--space-3);
    margin: 0 0 var(--space-5);
  }

  .tile {
    padding: var(--space-3) var(--space-4);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  dt {
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    color: var(--muted);
  }

  dd {
    margin: var(--space-1) 0 0;
    font-size: var(--text-xl, 1.5rem);
    font-weight: var(--weight-semibold);
  }
</style>
