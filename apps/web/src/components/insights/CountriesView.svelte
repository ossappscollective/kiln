<!--
  CountriesView: where the downloads come from, by the main language of each country, against the languages of the live store page
  (docs/api/insights.md, countries). Bars by language (biggest first) say "On your store page" or "Not on your store page" with a link to the
  Store listing text, where a language is added; the table below lists the countries with their main language. App Store only: Google Play
  reports carry no country split, and the view says so. Own data only: downloads of the last 28 days from stored analytics.
  Props: api, workspaceId, role, app, refreshKey (changes when a sync finished), openId + platform (the address of the open app, for links).
-->
<script lang="ts">
  import type { Role } from '@kiln/core';
  import { untrack } from 'svelte';
  import { type Api, ApiError } from '../../lib/api.ts';
  import { appAddress, type PlatformScope } from '../../lib/app-scope.ts';
  import {
    countryText,
    type CountriesView,
    languageBars,
    languageText,
    topBars,
    uncoveredText,
    unavailableText,
  } from '../../lib/insights/insights.ts';
  import { formatNumber, formatPercent } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import PageLead from '../ui/PageLead.svelte';
  import Skeleton from '../ui/Skeleton.svelte';

  let {
    api,
    workspaceId,
    app,
    refreshKey,
    openId,
    platform = null,
  }: { api: Api; workspaceId: string; role?: Role | undefined; app: AppSummary; refreshKey: number; openId: string; platform?: PlatformScope | null | undefined } = $props();

  let view = $state<CountriesView | null>(null);
  let loading = $state(true);
  let problem = $state('');
  let generation = 0;

  async function load() {
    const mine = ++generation;
    loading = true;
    problem = '';
    try {
      const read = await api.appInsightsCountries(workspaceId, app.id);
      if (mine !== generation) return;
      view = read;
    } catch (e) {
      if (mine !== generation) return;
      view = null;
      problem = e instanceof ApiError ? e.message : t('insights:countries.loadError');
    } finally {
      if (mine === generation) loading = false;
    }
  }

  $effect(() => {
    void app.id;
    void workspaceId;
    void refreshKey;
    untrack(() => void load());
  });

  const coverage = $derived(view?.coverage ?? null);
  const bars = $derived(coverage ? topBars(languageBars(coverage.languages)) : { shown: [], hidden: 0 });
  const listingHref = $derived(appAddress(openId, 'listing', platform));
</script>

<div class="stack loose" data-testid="countries-view">
  {#if loading}
    <Skeleton height="10rem" />
  {:else if problem}
    <Alert tone="error" title={t('insights:countries.loadErrorTitle')}>{problem}</Alert>
  {:else if view?.unavailable}
    <EmptyState icon="info" title={t('insights:countries.unavailableTitle')} description={unavailableText(view.unavailable)} />
  {:else if coverage}
    <PageLead
      headline={coverage.uncoveredShare > 0
        ? t('insights:countries.leadUncovered', { percent: uncoveredText(coverage) })
        : t('insights:countries.leadCovered')}
      hint={t('insights:countries.hint', { total: formatNumber(coverage.total) })}
      tone={coverage.uncoveredShare >= 0.1 ? 'warn' : 'ok'}
    />

    <section class="card" aria-labelledby="lang-bars">
      <h4 id="lang-bars">{t('insights:countries.byLanguage')}</h4>
      <ul class="bars">
        {#each bars.shown as bar (bar.language)}
          <li>
            <span class="name">{languageText(bar.language)}</span>
            <span class="track" aria-hidden="true"><span class="fill" class:gap={bar.coveredBy === null} style:width="{bar.width}%"></span></span>
            <span class="value num">{formatPercent(bar.share, { maximumFractionDigits: 0 })}</span>
            <span class="status">
              {#if bar.coveredBy}
                <Badge tone="ok" icon="check">{t('insights:countries.onPage', { locale: bar.coveredBy })}</Badge>
              {:else}
                <Badge tone="warn" icon="alert-triangle">{t('insights:countries.notOnPage')}</Badge>
                <Button href={listingHref} variant="link" size="sm">{t('insights:countries.addLanguage')}</Button>
              {/if}
            </span>
          </li>
        {/each}
      </ul>
      {#if bars.hidden > 0}<p class="muted more">{t('insights:countries.moreLanguages', { count: bars.hidden })}</p>{/if}
      {#if coverage.unknownCount > 0}<p class="muted more">{t('insights:countries.unknown', { count: coverage.unknownCount })}</p>{/if}
    </section>

    <section class="card flush" aria-labelledby="country-table">
      <h4 id="country-table" class="table-title">{t('insights:countries.table')}</h4>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">{t('insights:countries.colCountry')}</th>
              <th scope="col">{t('insights:countries.colLanguage')}</th>
              <th scope="col" class="num">{t('insights:countries.colDownloads')}</th>
              <th scope="col" class="num">{t('insights:countries.colShare')}</th>
              <th scope="col">{t('insights:countries.colPage')}</th>
            </tr>
          </thead>
          <tbody>
            {#each coverage.countries as row (row.country)}
              <tr>
                <td>{countryText(row.country)}</td>
                <td>{row.language ? languageText(row.language) : t('insights:countries.languageUnknown')}</td>
                <td class="num">{formatNumber(row.count)}</td>
                <td class="num">{formatPercent(row.share, { maximumFractionDigits: 1 })}</td>
                <td>{row.coveredBy ?? (row.language ? t('insights:countries.notOnPage') : t('insights:countries.dash'))}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  {/if}
</div>

<style>
  h4 {
    margin: 0 0 var(--space-3);
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
  }

  .table-title {
    padding: var(--space-4) var(--space-5) 0;
  }

  .bars {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  li {
    display: grid;
    grid-template-columns: minmax(5rem, 10rem) minmax(0, 1fr) 3.5rem minmax(9rem, auto);
    gap: var(--space-3);
    align-items: center;
    font-size: var(--text-sm);
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .track {
    display: block;
    height: 8px;
  }

  .fill {
    display: block;
    height: 8px;
    background: var(--viz-1);
    border-radius: 0 4px 4px 0;
  }

  .fill.gap {
    background: var(--warn);
  }

  .value {
    font-weight: var(--weight-semibold);
    text-align: right;
  }

  .status {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .more {
    margin: var(--space-3) 0 0;
    font-size: var(--text-sm);
  }

  @media (max-width: 640px) {
    li {
      grid-template-columns: minmax(0, 1fr) 3.5rem;
    }

    .track {
      grid-column: 1 / -1;
      grid-row: 2;
    }

    .status {
      grid-column: 1 / -1;
    }
  }

  @media (forced-colors: active) {
    .fill {
      background: CanvasText;
    }
  }
</style>
