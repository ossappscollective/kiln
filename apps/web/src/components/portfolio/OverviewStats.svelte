<!--
  OverviewStats: the counts above the all-apps table as one row of small chips: how many apps, what
  is in review or rolling out, what needs a look and the new reviews. Counts of what the table shows;
  a zero is dimmed so the numbers that matter stand out.
  Props: stats (from overviewStats).
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
  import type { OverviewStats } from '../../lib/app-overview.ts';
  import StatChip from '../ui/StatChip.svelte';

  let { stats }: { stats: OverviewStats } = $props();
</script>

<ul class="strip" aria-label={t('portfolio:overview.summary')}>
  <li><StatChip label={t('portfolio:overview.apps')} value={stats.apps} /></li>
  <li><StatChip label={t('portfolio:overview.inReview')} value={stats.inReview} tone="info" /></li>
  <li><StatChip label={t('portfolio:overview.rollingOut')} value={stats.rollingOut} tone="info" /></li>
  <li><StatChip label={t('portfolio:overview.needLook')} value={stats.problems} tone="warn" /></li>
  <li><StatChip label={t('portfolio:overview.unfinished')} value={stats.unfinished} tone="warn" hideZero /></li>
  <li>
    <StatChip label={t('portfolio:overview.newReviews')} value={stats.newReviews === null ? '–' : stats.newReviews} tone="info" dim={stats.newReviews === null} />
  </li>
</ul>

<style>
  .strip {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    padding: 0;
    margin: 0;
    list-style: none;
  }
</style>
