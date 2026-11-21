<!--
  EarningsCard: "Earnings (net, monthly)" of an Android app, from Google Play's Earnings report (docs/adr/0042-earnings-and-subscription-metrics.md).
  The report is a monthly statement, so every point of the chart is a MONTH ("Oct 2026"), the card says "monthly" in its title and in its
  freshness line, and it follows its own twelve-month range, not the date range of the page. Net is after Google's fees and taxes; the
  charges (what buyers paid) are a second line of the same currency and month. Money is shown one currency at a time, like the sales cards:
  tabs up to six currencies, a select beyond, the currency of the person's locale (or the one they chose last) first, never added together.
  A month without a report is hatched, not zero.
  Props: card (ChartCard from lib/analytics/extras.ts), today (UTC day), showData (the table twin).
-->
<script lang="ts">
  import { browserLocale, chosenCurrency, defaultCurrency, offeredCurrencies, rememberCurrency } from '../../lib/analytics/currency.ts';
  import { type ChartCard, cardCurrencies, cardDates, cardFreshness, cardInfo, panelsForCurrency, tableFor } from '../../lib/analytics/view.ts';
  import InfoTip from '../ui/InfoTip.svelte';
  import Section from '../ui/Section.svelte';
  import SegmentTabs, { segmentIds } from '../ui/SegmentTabs.svelte';
  import Chart from './Chart.svelte';
  import DataTable from './DataTable.svelte';

  let { card, today, showData = false }: { card: ChartCard; today: string; showData?: boolean | undefined } = $props();

  const uid = $props.id();
  let hover = $state<number | null>(null);
  let chosen = $state<string | undefined>(undefined);

  $effect(() => {
    if (chosen !== undefined) rememberCurrency(chosen);
  });

  const bySize = $derived(cardCurrencies(card));
  const currency = $derived(chosen !== undefined && bySize.includes(chosen) ? chosen : defaultCurrency(bySize, chosenCurrency(), browserLocale()));
  const currencies = $derived(offeredCurrencies(bySize, defaultCurrency(bySize, chosenCurrency(), browserLocale())));
  const choose = $derived(currencies.length > 1);
  const asTabs = $derived(choose && currencies.length <= 6);
  const shown = $derived(choose ? panelsForCurrency(card, currency) : card.panels);

  const dates = $derived(cardDates(card));
  const fresh = $derived(cardFreshness(card));
  const info = $derived(cardInfo(card));
  const anyMissing = $derived(card.panels.some((p) => p.series.some((ps) => ps.series.points.some((pt) => pt.value === null))));
  const table = $derived(showData ? tableFor(card) : null);
</script>

<Section title={card.title} key="chart.{card.id}" summary={fresh[0] ?? ''} edge>
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
        <p class="muted key-note">Each point is a whole month. A hatched month has no report yet; it is not zero.</p>
      </div>
    </InfoTip>
  {/snippet}
  <div class="chart-card" data-testid="earnings-card">
    {#if fresh[0]}<p class="fresh">{fresh[0]}</p>{/if}
    {#if asTabs}
      <SegmentTabs tabs={currencies.map((c) => ({ id: c, label: c }))} bind:value={chosen} label="Currency of {card.title}" idPrefix="{uid}-cur" />
    {:else if choose}
      <div class="currency-pick row">
        <label for="{uid}-cur">Currency</label>
        <select id="{uid}-cur" value={currency} onchange={(event) => (chosen = event.currentTarget.value)}>
          {#each currencies as c (c)}<option value={c}>{c}</option>{/each}
        </select>
        <span class="muted text-sm">{currencies.length} currencies: yours first, then the biggest. They are never added together.</span>
      </div>
    {/if}
    <div
      class="panels"
      class:multi={shown.length > 1}
      role={asTabs ? 'tabpanel' : undefined}
      id={asTabs ? segmentIds(`${uid}-cur`, currency).panel : undefined}
      aria-labelledby={asTabs ? segmentIds(`${uid}-cur`, currency).tab : undefined}
    >
      {#each shown as panel (panel.id)}
        <Chart {panel} cardTitle={card.title} {dates} {today} bind:hover />
      {/each}
    </div>
    {#if anyMissing}<p class="caption">Hatched months have no report. They are not zero.</p>{/if}
    {#if fresh.length > 1}
      {#each fresh.slice(1) as line (line)}<p class="fresh">{line}</p>{/each}
    {/if}
    {#if table}<DataTable model={table} caption="{card.title}, one row per month" />{/if}
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

  .currency-pick {
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
  }

  .currency-pick select {
    min-width: 6rem;
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
