<!--
  ChartCard: one small multiple of the Analytics screen: a title, how fresh the data is (the source and its delay, in one
  quiet line), an "About this data" popover (per series: source, how many days have data, the coverage notes of the API), the
  panels (Chart), a ranked list by app version when the source has one, and the table twin when "Show data" is on.
  The panels of a card share one hover position, so their crosshairs move together.
  A card with money in several currencies (sales, proceeds) shows one currency at a time, the biggest first (tabs up to six, a list beyond): currencies are never added up.
  Props: card (ChartCard from lib/analytics-view.ts), today (UTC day), showData.
  Missing days are hatched, not zero: a caption says so when any day of the card is missing.
-->
<script lang="ts">
  import {
    type ChartCard,
    cardCurrencies,
    cardDates,
    cardFreshness,
    cardInfo,
    panelsForCurrency,
    tableFor,
  } from '../../lib/analytics/view.ts';
  import { browserLocale, chosenCurrency, defaultCurrency, offeredCurrencies, rememberCurrency } from '../../lib/analytics/currency.ts';
  import { t } from '../../lib/i18n/t.ts';
  import InfoTip from '../ui/InfoTip.svelte';
  import Section from '../ui/Section.svelte';
  import SegmentTabs, { segmentIds } from '../ui/SegmentTabs.svelte';
  import { type TimelineEntry, markersFor } from '../../lib/timeline/timeline.ts';
  import BarList from './BarList.svelte';
  import Chart from './Chart.svelte';
  import DataTable from './DataTable.svelte';

  let { card, today, showData = false, events }: { card: ChartCard; today: string; showData?: boolean | undefined; events?: TimelineEntry[] | undefined } = $props();

  const uid = $props.id();
  let hover = $state<number | null>(null);
  let chosen = $state<string | undefined>(undefined);

  // The order of the choices follows the default (not the pick of this visit), so the tabs do not jump when one is clicked.
  const chosenOrDefault = (list: readonly string[]) => defaultCurrency(list, chosenCurrency(), browserLocale());
  // A pick is kept in this browser, so every money chart opens on it next time.
  $effect(() => {
    if (chosen !== undefined) rememberCurrency(chosen);
  });

  // Money is never added across currencies. A card with several currencies shows one at a time instead of one chart each.
  const bySize = $derived(cardCurrencies(card));
  // It opens on the currency the person chose before, else the one of their locale, else the biggest; that one is offered first.
  const currency = $derived(
    chosen !== undefined && bySize.includes(chosen) ? chosen : defaultCurrency(bySize, chosenCurrency(), browserLocale()),
  );
  const currencies = $derived(offeredCurrencies(bySize, chosenOrDefault(bySize)));
  const choose = $derived(currencies.length > 1);
  // A handful fit as tabs; Apple can pay in twenty currencies, which would run off the card: those get a list.
  const asTabs = $derived(choose && currencies.length <= 6);
  const shown = $derived(choose ? panelsForCurrency(card, currency) : card.panels);

  const dates = $derived(cardDates(card));
  // Event markers (docs/adr/0053-timeline-and-reports.md): only when the page asked for them; one per day, capped.
  const marks = $derived(events ? markersFor(events, dates) : { markers: [], hidden: 0 });
  const fresh = $derived(cardFreshness(card));
  const info = $derived(cardInfo(card));
  const anyMissing = $derived(card.panels.some((p) => p.series.some((ps) => ps.series.points.some((pt) => pt.value === null))));
  const table = $derived(showData ? tableFor(card) : null);
</script>

<Section title={card.title} key="chart.{card.id}" summary={fresh[0] ?? ''} edge>
  {#snippet actions()}
    <InfoTip label={t('analytics:chart.aboutLabel', { title: card.title })} align="end" width="26rem">
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
        <p class="muted key-note">{t('analytics:chart.keyNote')}</p>
      </div>
    </InfoTip>
  {/snippet}
  <div class="chart-card">
    {#if fresh[0]}<p class="fresh">{fresh[0]}</p>{/if}
    {#if asTabs}
      <SegmentTabs tabs={currencies.map((c) => ({ id: c, label: c }))} bind:value={chosen} label={t('analytics:chart.currencyLabel', { title: card.title })} idPrefix="{uid}-cur" />
    {:else if choose}
      <div class="currency-pick row">
        <label for="{uid}-cur">{t('analytics:chart.currency')}</label>
        <select id="{uid}-cur" value={currency} onchange={(event) => (chosen = event.currentTarget.value)}>
          {#each currencies as c (c)}<option value={c}>{c}</option>{/each}
        </select>
        <span class="muted text-sm">{t('analytics:chart.currenciesNote', { count: currencies.length })}</span>
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
        <Chart {panel} cardTitle={card.title} {dates} {today} bind:hover markers={marks.markers} />
      {/each}
    </div>
    {#if marks.markers.length > 0}<p class="caption">{t('timeline:marker.caption')}{#if marks.hidden > 0} {t('timeline:marker.hidden', { count: marks.hidden })}{/if}</p>{/if}
    {#if anyMissing}<p class="caption">{t('analytics:chart.hatchedCaption')}</p>{/if}
    {#if fresh.length > 1}
      {#each fresh.slice(1) as line (line)}<p class="fresh">{line}</p>{/each}
    {/if}

    {#each card.versions as v (v.id)}
      <BarList bars={v} />
    {/each}

    {#if table}<DataTable model={table} caption={t('analytics:chart.tableCaption', { title: card.title })} />{/if}
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
