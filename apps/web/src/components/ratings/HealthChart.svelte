<!--
  HealthChart: one titled line chart of the Ratings and health tab (a rating average, a crash rate, low-star reviews per day). A thin card around
  components/analytics/Chart.svelte, which draws gaps as gaps (never zero) and gives the keyboard and screen reader their reading of every point.
  Props: panel (ChartPanel from lib/ratings/ratings.ts panelOf), title, today (UTC day, the end of the range).
-->
<script lang="ts">
  import type { ChartPanel } from '../../lib/analytics/view.ts';
  import Chart from '../analytics/Chart.svelte';

  let { panel, title, today }: { panel: ChartPanel; title: string; today: string } = $props();

  let hover = $state<number | null>(null);
  const dates = $derived(panel.series[0]?.series.points.map((p) => p.date) ?? []);
</script>

<section class="card chart" aria-label={title}>
  <h4>{title}</h4>
  <Chart {panel} cardTitle={title} {dates} {today} bind:hover />
</section>

<style>
  .chart {
    padding: var(--space-4) var(--space-5);
  }

  h4 {
    margin: 0 0 var(--space-3);
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
  }
</style>
