<!--
  AdsOverviewSection: the Overview of the Ads tab: the totals of the range against the period of the same length before it, and the days. Money is
  in the ONE currency of the ad account; a figure with nothing to divide by (cost per install with no installs) is a dash, never 0.
  A range with no data says so and points to the sync. Reads stored data only (docs/api/apple-ads.md).
  Props: api, workspaceId, appId, window, refreshKey (changes when a sync ended).
-->
<script lang="ts">
  import type { Api } from '../../lib/api.ts';
  import {
    type AdsOverview,
    type AdsTotals,
    adsErrorText,
    changeOf,
    dailyBars,
    deltaText,
    formatCount,
    formatMicros,
    formatRatio,
  } from '../../lib/ads/ads.ts';
  import { formatDay } from '../../lib/analytics/analytics.ts';
  import { t } from '../../lib/i18n/t.ts';
  import Alert from '../ui/Alert.svelte';
  import Skeleton from '../ui/Skeleton.svelte';

  let { api, workspaceId, appId, window, refreshKey = 0 }: { api: Api; workspaceId: string; appId: string; window: { from: string; to: string }; refreshKey?: number | undefined } = $props();

  let data = $state<AdsOverview | null>(null);
  let error = $state('');
  let loading = $state(true);
  let metric = $state<'impressions' | 'taps' | 'installs' | 'spendMicros'>('spendMicros');
  let generation = 0;

  $effect(() => {
    void refreshKey;
    const query = new URLSearchParams({ from: window.from, to: window.to }).toString();
    const mine = ++generation;
    loading = true;
    api
      .adsOverview(workspaceId, appId, query)
      .then((r) => {
        if (mine !== generation) return;
        data = r.overview;
        error = '';
      })
      .catch((e: unknown) => {
        if (mine !== generation) return;
        error = adsErrorText(e);
      })
      .finally(() => {
        if (mine === generation) loading = false;
      });
  });

  type Tile = { key: string; label: string; value: string; change: number | null; previous: string };
  const tiles = $derived.by((): Tile[] => {
    if (!data) return [];
    const cur: AdsTotals = data.totals;
    const prev: AdsTotals = data.previous;
    const money = (v: number | null) => formatMicros(v, data?.currency ?? null);
    return [
      { key: 'impressions', label: t('ads:col.impressions'), value: formatCount(cur.impressions), change: changeOf(cur.impressions, prev.impressions), previous: formatCount(prev.impressions) },
      { key: 'taps', label: t('ads:col.taps'), value: formatCount(cur.taps), change: changeOf(cur.taps, prev.taps), previous: formatCount(prev.taps) },
      { key: 'installs', label: t('ads:col.installs'), value: formatCount(cur.installs), change: changeOf(cur.installs, prev.installs), previous: formatCount(prev.installs) },
      { key: 'spend', label: t('ads:col.spend'), value: money(cur.spendMicros), change: changeOf(cur.spendMicros, prev.spendMicros), previous: money(prev.spendMicros) },
      { key: 'cpt', label: t('ads:col.cpt'), value: money(cur.cptMicros), change: changeOf(cur.cptMicros, prev.cptMicros), previous: money(prev.cptMicros) },
      { key: 'cpi', label: t('ads:col.cpi'), value: money(cur.cpiMicros), change: changeOf(cur.cpiMicros, prev.cpiMicros), previous: money(prev.cpiMicros) },
      { key: 'ttr', label: t('ads:col.ttr'), value: formatRatio(cur.ttr), change: changeOf(cur.ttr, prev.ttr), previous: formatRatio(prev.ttr) },
      { key: 'conversion', label: t('ads:col.conversion'), value: formatRatio(cur.conversion), change: changeOf(cur.conversion, prev.conversion), previous: formatRatio(prev.conversion) },
    ];
  });

  const bars = $derived(data ? dailyBars(data.daily, metric) : []);
  const valueOf = (d: { impressions: number; taps: number; installs: number; spendMicros: number }): string =>
    metric === 'spendMicros' ? formatMicros(d.spendMicros, data?.currency ?? null) : formatCount(d[metric]);
  const metricLabel = $derived(metric === 'spendMicros' ? t('ads:col.spend') : metric === 'impressions' ? t('ads:col.impressions') : metric === 'taps' ? t('ads:col.taps') : t('ads:col.installs'));
</script>

<div class="stack" data-testid="ads-overview">
  {#if error}
    <Alert tone="error">{error}</Alert>
  {:else if loading && data === null}
    <Skeleton height="8rem" />
  {:else if data}
    {#if data.daysWithData === 0}
      <p class="muted" data-testid="ads-empty">{t('ads:overview.empty', { from: formatDay(data.window.from, true), to: formatDay(data.window.to, true) })}</p>
    {:else}
      <p class="muted text-sm">
        {t('ads:overview.coverage', { days: data.daysWithData, campaigns: data.campaigns, currency: data.currency ?? t('ads:none') })}
        {t('ads:overview.compare', { from: formatDay(data.previousWindow.from, true), to: formatDay(data.previousWindow.to, true) })}
      </p>
      <ul class="tiles" aria-label={t('ads:overview.totals')}>
        {#each tiles as tile (tile.key)}
          {@const delta = deltaText(tile.change)}
          <li>
            <span class="label muted">{tile.label}</span>
            <strong class="value">{tile.value}</strong>
            <span class="delta text-sm muted">
              {#if delta}
                <span aria-hidden="true">{delta.tone === 'up' ? '▲' : delta.tone === 'down' ? '▼' : '▬'}</span>
                {delta.text}
                <span class="visually-hidden">{t('ads:overview.deltaAria', { previous: tile.previous })}</span>
              {:else}
                {t('ads:overview.noCompare')}
              {/if}
            </span>
          </li>
        {/each}
      </ul>

      <section class="stack tight" aria-label={t('ads:overview.daily')}>
        <div class="row">
          <label for="ads-metric" class="muted text-sm">{t('ads:overview.dailyOf')}</label>
          <select id="ads-metric" bind:value={metric}>
            <option value="spendMicros">{t('ads:col.spend')}</option>
            <option value="impressions">{t('ads:col.impressions')}</option>
            <option value="taps">{t('ads:col.taps')}</option>
            <option value="installs">{t('ads:col.installs')}</option>
          </select>
        </div>
        <div class="bars" role="img" aria-label={t('ads:overview.dailyAria', { metric: metricLabel, days: data.daily.length })}>
          {#each data.daily as d, i (d.day)}
            <span class="bar" style:height="{Math.max(2, Math.round((bars[i] ?? 0) * 100))}%" title="{formatDay(d.day, true)}: {valueOf(d)}"></span>
          {/each}
        </div>
        <details>
          <summary class="text-sm">{t('ads:overview.table')}</summary>
          <table class="fit compact">
            <colgroup><col style="width: 30%" /><col style="width: 17%" /><col style="width: 17%" /><col style="width: 17%" /><col style="width: 19%" /></colgroup>
            <thead>
              <tr>
                <th scope="col">{t('ads:col.day')}</th>
                <th scope="col">{t('ads:col.impressions')}</th>
                <th scope="col">{t('ads:col.taps')}</th>
                <th scope="col">{t('ads:col.installs')}</th>
                <th scope="col">{t('ads:col.spend')}</th>
              </tr>
            </thead>
            <tbody>
              {#each data.daily as d (d.day)}
                <tr>
                  <th scope="row" data-label={t('ads:col.day')}>{formatDay(d.day, true)}</th>
                  <td data-label={t('ads:col.impressions')}>{formatCount(d.impressions)}</td>
                  <td data-label={t('ads:col.taps')}>{formatCount(d.taps)}</td>
                  <td data-label={t('ads:col.installs')}>{formatCount(d.installs)}</td>
                  <td data-label={t('ads:col.spend')}>{formatMicros(d.spendMicros, data.currency)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </details>
      </section>
    {/if}
  {/if}
</div>

<style>
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
    gap: var(--space-3);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .tiles li {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-3) var(--space-4);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  .label {
    font-size: var(--text-sm);
  }

  .value {
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    overflow-wrap: anywhere;
  }

  .bars {
    display: flex;
    gap: 2px;
    align-items: flex-end;
    height: 7rem;
    padding: var(--space-2);
    border-bottom: 1px solid var(--line);
  }

  .bar {
    flex: 1 1 0;
    min-width: 2px;
    max-width: 2rem;
    background: var(--accent);
    border-radius: 2px 2px 0 0;
  }
</style>
