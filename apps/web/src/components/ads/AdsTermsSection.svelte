<!--
  AdsTermsSection: the Search terms (what people typed before they tapped one of your ads) or the Keywords (the keywords you bid on) of the Ads
  tab. A sortable table (click a heading), a filter box, pages of 50. A search term that you do not track yet has "Track keyword": it adds the
  term to the keyword tracker of the app (nothing is written to Apple Ads). Apple hides terms with very few impressions, so the list is not
  every search. Left aligned table.fit, a stacked card per row on a narrow screen.
  Props: api, workspaceId, role, appId, kind ('term' | 'keyword'), window, refreshKey.
-->
<script lang="ts">
  import { type Role, can } from '@kiln/core';
  import type { Api } from '../../lib/api.ts';
  import {
    ADS_PAGE_SIZE,
    type AdsTermRow,
    type AdsTermsResponse,
    DEFAULT_SORT,
    type SortState,
    adsErrorText,
    ariaSort,
    countryText,
    formatCount,
    formatMicros,
    formatRatio,
    nextSort,
    termColumns,
    termsQueryOf,
    trackBody,
  } from '../../lib/ads/ads.ts';
  import { asoErrorMessage } from '../../lib/aso/aso.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import Skeleton from '../ui/Skeleton.svelte';

  let {
    api,
    workspaceId,
    role,
    appId,
    kind,
    window,
    refreshKey = 0,
  }: { api: Api; workspaceId: string; role: Role; appId: string; kind: 'term' | 'keyword'; window: { from: string; to: string }; refreshKey?: number | undefined } = $props();

  const canTrack = $derived(can(role, 'aso.write') && kind === 'term');

  let sort = $state<SortState>(DEFAULT_SORT);
  let typed = $state('');
  let q = $state('');
  let offset = $state(0);
  let data = $state<AdsTermsResponse | null>(null);
  let error = $state('');
  let loading = $state(true);
  let tracking = $state<Record<string, boolean>>({});
  let generation = 0;

  // The filter waits for a pause in typing, and a new filter, sort, kind or range starts at the first page.
  $effect(() => {
    const value = typed;
    const timer = setTimeout(() => {
      if (value !== q) {
        q = value;
        offset = 0;
      }
    }, 250);
    return () => clearTimeout(timer);
  });
  $effect(() => {
    void kind;
    void window.from;
    void window.to;
    void appId;
    offset = 0;
  });

  $effect(() => {
    void refreshKey;
    const query = termsQueryOf({ kind, window, sort, q, offset });
    const mine = ++generation;
    loading = true;
    api
      .adsTerms(workspaceId, appId, query)
      .then((r) => {
        if (mine !== generation) return;
        data = r;
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

  const rowKey = (r: AdsTermRow) => `${r.termKey}|${r.country}|${r.matchType ?? ''}`;

  async function track(row: AdsTermRow) {
    const key = rowKey(row);
    if (tracking[key]) return;
    tracking = { ...tracking, [key]: true };
    try {
      await api.addAsoKeywords(workspaceId, appId, [trackBody(row)]);
      if (data) data = { ...data, rows: data.rows.map((r) => (rowKey(r) === key ? { ...r, tracked: true } : r)) };
      toast.success(t('ads:terms.tracked', { term: row.term }));
    } catch (e) {
      toast.error(asoErrorMessage(e));
    } finally {
      tracking = { ...tracking, [key]: false };
    }
  }

  const from = $derived(data && data.total > 0 ? data.offset + 1 : 0);
  const to = $derived(data ? data.offset + data.rows.length : 0);
  const heading = $derived(kind === 'term' ? t('ads:terms.col.term') : t('ads:terms.col.keyword'));
</script>

<div class="stack" data-testid="ads-terms">
  <div class="row">
    <input class="search" type="search" placeholder={t('ads:terms.filter')} aria-label={t('ads:terms.filter')} bind:value={typed} />
    {#if data}<span class="muted text-sm" aria-live="polite">{t('ads:terms.count', { count: data.total })}</span>{/if}
  </div>

  {#if error}
    <Alert tone="error">{error}</Alert>
  {:else if loading && data === null}
    <Skeleton height="8rem" />
  {:else if data}
    {#if data.total === 0}
      <p class="muted" data-testid="ads-empty">{q.trim() !== '' ? t('ads:terms.noMatch') : kind === 'term' ? t('ads:terms.empty') : t('ads:terms.emptyKeywords')}</p>
    {:else}
      <table class="fit compact" class:busy={loading} aria-label={kind === 'term' ? t('ads:rail.terms') : t('ads:rail.keywords')}>
        <colgroup>
          <col style="width: {canTrack ? 22 : 26}%" /><col style="width: 7%" /><col style="width: 10%" /><col style="width: 8%" /><col style="width: 9%" /><col style="width: 11%" /><col style="width: 9%" /><col style="width: 9%" /><col style="width: 8%" />{#if canTrack}<col style="width: 11%" />{/if}
        </colgroup>
        <thead>
          <tr>
            <th scope="col" aria-sort={ariaSort(sort, 'term')}>
              <button type="button" class="sort" onclick={() => (sort = nextSort(sort, 'term'), (offset = 0))}>{heading}{#if sort.sort === 'term'}<Icon name={sort.dir === 'asc' ? 'chevron-up' : 'chevron-down'} size={12} />{/if}</button>
            </th>
            <th scope="col">{t('ads:col.country')}</th>
            {#each termColumns as c (c.sort)}
              <th scope="col" aria-sort={ariaSort(sort, c.sort)}>
                <button type="button" class="sort" onclick={() => (sort = nextSort(sort, c.sort), (offset = 0))}>{t(c.labelKey)}{#if sort.sort === c.sort}<Icon name={sort.dir === 'asc' ? 'chevron-up' : 'chevron-down'} size={12} />{/if}</button>
              </th>
            {/each}
            {#if canTrack}<th scope="col"><span class="visually-hidden">{t('ads:terms.track')}</span></th>{/if}
          </tr>
        </thead>
        <tbody>
          {#each data.rows as r (rowKey(r))}
            <tr>
              <th scope="row" data-label={heading}>
                {r.term}
                {#if r.matchType}<Badge tone="neutral">{r.matchType}</Badge>{/if}
                {#if r.keywordText && r.keywordText.toLowerCase() !== r.term.toLowerCase()}<span class="muted text-sm block">{t('ads:terms.matched', { keyword: r.keywordText })}</span>{/if}
              </th>
              <td data-label={t('ads:col.country')}>{countryText(r.country)}</td>
              <td data-label={t('ads:col.impressions')}>{formatCount(r.impressions)}</td>
              <td data-label={t('ads:col.taps')}>{formatCount(r.taps)}</td>
              <td data-label={t('ads:col.installs')}>{formatCount(r.installs)}</td>
              <td data-label={t('ads:col.spend')}>{formatMicros(r.spendMicros, data.currency)}</td>
              <td data-label={t('ads:col.cpt')}>{formatMicros(r.cptMicros, data.currency)}</td>
              <td data-label={t('ads:col.cpi')}>{formatMicros(r.cpiMicros, data.currency)}</td>
              <td data-label={t('ads:col.ttr')}>{formatRatio(r.ttr)}</td>
              {#if canTrack}
                <td>
                  {#if r.tracked}
                    <Badge tone="ok" icon="check">{t('ads:terms.isTracked')}</Badge>
                  {:else}
                    <Button size="sm" variant="secondary" loading={tracking[rowKey(r)] === true} onclick={() => void track(r)}>{t('ads:terms.track')}</Button>
                  {/if}
                </td>
              {/if}
            </tr>
          {/each}
        </tbody>
      </table>
      <div class="row pager">
        <span class="muted text-sm">{t('ads:terms.range', { from, to, total: data.total })}</span>
        <Button size="sm" variant="ghost" disabled={offset === 0 || loading} onclick={() => (offset = Math.max(0, offset - ADS_PAGE_SIZE))}>{t('ads:terms.prev')}</Button>
        <Button size="sm" variant="ghost" disabled={to >= data.total || loading} onclick={() => (offset = offset + ADS_PAGE_SIZE)}>{t('ads:terms.next')}</Button>
      </div>
      {#if kind === 'term'}<p class="muted text-sm">{t('ads:terms.hiddenNote')}</p>{/if}
    {/if}
  {/if}
</div>

<style>
  .search {
    min-width: 14rem;
  }

  .sort {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
    padding: 0;
    font: inherit;
    font-weight: var(--weight-semibold);
    color: inherit;
    text-align: left;
    cursor: pointer;
    background: none;
    border: 0;
  }

  .busy {
    opacity: 0.6;
  }

  .block {
    display: block;
  }

  .pager {
    justify-content: flex-start;
  }
</style>
