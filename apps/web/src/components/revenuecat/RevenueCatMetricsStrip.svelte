<!--
  RevenueCatMetricsStrip: the compact row at the top of the Products page with RevenueCat's own overview figures of the linked project:
  active subscriptions, active trials, MRR and revenue (28 days), the time they were read ("As of ...") and, always, whose numbers they
  are ("RevenueCat figures, all stores": every app and store of the RevenueCat project, not this app alone, not the store consoles).
  From the STORED copy only (`GET .../revenuecat/metrics`, docs/adr/0043-revenuecat-metrics.md). Money carries RevenueCat's currency and is
  never converted; a figure RevenueCat did not report is not drawn (never a zero). A failed read is said beside the older figures.
  Drawn for a linked app that has figures or a reason; hidden otherwise. Every member who can read the app sees it, revenue included.
  Props: read (RevenueCatMetricsRead | null), now (epoch ms, for "As of").
-->
<script lang="ts">
  import {
    asOf,
    type RevenueCatMetricsRead,
    STRIP_SCOPE,
    STRIP_SCOPE_DETAIL,
    stripProblem,
    stripTiles,
    stripVisible,
  } from '../../lib/revenuecat/metrics.ts';
  import InfoTip from '../ui/InfoTip.svelte';

  let { read, now }: { read: RevenueCatMetricsRead | null; now: number } = $props();

  const tiles = $derived(stripTiles(read));
  const problem = $derived(stripProblem(read));
</script>

{#if stripVisible(read)}
  <section class="strip" aria-label="RevenueCat figures" data-testid="revenuecat-metrics">
    {#if tiles.length > 0}
      <ul class="tiles">
        {#each tiles as tile (tile.id)}
          <li title={tile.title} data-testid="revenuecat-metric-{tile.id}">
            <span class="value tabular">{tile.value}</span>
            <span class="label">{tile.label}</span>
          </li>
        {/each}
      </ul>
    {/if}
    <p class="scope text-sm muted">
      <span>{STRIP_SCOPE}</span>
      {#if tiles.length > 0}<span aria-hidden="true">·</span> <span data-testid="revenuecat-metrics-asof">{asOf(read, now)}</span>{/if}
      <InfoTip label="About the RevenueCat figures" text={STRIP_SCOPE_DETAIL} align="end" width="24rem" />
    </p>
    {#if problem !== ''}<p class="problem text-sm" role="status" data-testid="revenuecat-metrics-problem">{problem}</p>{/if}
  </section>
{/if}

<style>
  .strip {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-5);
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-card);
  }

  .tiles {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-6);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  li {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .value {
    font-family: var(--font-display);
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    color: var(--text);
  }

  .label {
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .scope {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    align-items: center;
    margin: 0;
  }

  .problem {
    flex-basis: 100%;
    margin: 0;
    color: var(--warn-ink);
  }
</style>
