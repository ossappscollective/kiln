<!--
  ChartCard: one small multiple of the Analytics screen: a title, how fresh the data is (the source and its delay, in one
  quiet line), an "About this data" popover (per series: source, how many days have data, the coverage notes of the API), the
  panels (Chart), a ranked list by app version when the source has one, and the table twin when "Show data" is on.
  The panels of a card share one hover position, so their crosshairs move together.
  Props: card (ChartCard from lib/analytics-view.ts), today (UTC day), showData.
  Missing days are hatched, not zero: a caption says so when any day of the card is missing.
-->
<script lang="ts">
  import { type ChartCard, cardDates, cardFreshness, cardInfo, tableFor } from '../../lib/analytics-view.ts';
  import InfoTip from '../ui/InfoTip.svelte';
  import Section from '../ui/Section.svelte';
  import BarList from './BarList.svelte';
  import Chart from './Chart.svelte';
  import DataTable from './DataTable.svelte';

  let { card, today, showData = false }: { card: ChartCard; today: string; showData?: boolean } = $props();

  let hover = $state<number | null>(null);

  const dates = $derived(cardDates(card));
  const fresh = $derived(cardFreshness(card));
  const info = $derived(cardInfo(card));
  const anyMissing = $derived(card.panels.some((p) => p.series.some((ps) => ps.series.points.some((pt) => pt.value === null))));
  const table = $derived(showData ? tableFor(card) : null);
</script>

<Section title={card.title} key="chart.{card.id}" summary={fresh[0] ?? ''}>
  {#snippet actions()}
    <InfoTip label="About the data of {card.title}" align="end" width="26rem">
      <div class="about">
        {#each info as s (s.id)}
          <div class="series">
            <strong>{s.label}</strong>
            <p class="muted">{s.source}. {s.coverage}.</p>
            <p class="muted">{s.freshness}</p>
            {#if s.notes.length > 0}
              <ul>
                {#each s.notes as n (n)}<li>{n}</li>{/each}
              </ul>
            {/if}
          </div>
        {/each}
        <p class="muted key-note">Hatched days have no data from the store; they are not zero. Shaded days at the right edge may still change.</p>
      </div>
    </InfoTip>
  {/snippet}
  <div class="chart-card">
    {#if fresh[0]}<p class="fresh">{fresh[0]}</p>{/if}
    <div class="panels" class:multi={card.panels.length > 1}>
      {#each card.panels as panel (panel.id)}
        <Chart {panel} cardTitle={card.title} {dates} {today} bind:hover />
      {/each}
    </div>
    {#if anyMissing}<p class="caption">Hatched days have no data from the store. They are not zero.</p>{/if}
    {#if fresh.length > 1}
      {#each fresh.slice(1) as line (line)}<p class="fresh">{line}</p>{/each}
    {/if}

    {#each card.versions as v (v.id)}
      <BarList bars={v} />
    {/each}

    {#if table}<DataTable model={table} caption="{card.title}, one row per day" />{/if}
  </div>
</Section>

<style>
  .chart-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }

  .fresh,
  .caption {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .panels {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .about {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .series p {
    margin: 0;
  }

  .series ul {
    padding-left: var(--space-4);
    margin: var(--space-1) 0 0;
  }

  .key-note {
    margin: 0;
    font-size: var(--text-xs);
  }
</style>
