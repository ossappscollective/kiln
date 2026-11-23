<!--
  AsoKeywordEstimates: the ESTIMATES of popularity and difficulty of the tracked keywords (docs/adr/0057-keyword-estimates.md), one table
  under the tracked keywords in Insights > Keywords, and the related terms the App Store suggests.
  Neither Apple nor Google publishes how often a term is searched, so every number here is an estimate Kiln worked out from public signals
  and from the team's own data; the head, each cell's "no estimate" reason, the detail and the info popover all say so and explain it.
  A cell is a bar, the number and three dots for the confidence (text and shape, not colour alone); "No estimate" is never 0.
  The detail (one keyword at a time) lists the inputs of both estimates, the hints, the apps in the first results and the trend.
  Reads our own database only (one request per app); "Track" on a related term uses the add-keyword request (aso.write).
  Props: api, workspaceId, members, keywords (all of them), canWrite, onchanged, now.
-->
<script lang="ts">
  import { supports } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { agoText } from '../../lib/aso/ago.ts';
  import { type AsoKeyword, asoErrorMessage, rankText } from '../../lib/aso/aso.ts';
  import {
    confidenceDots,
    confidenceKeys,
    type EstimateDetail,
    type EstimateFilter,
    type EstimateMeasure,
    type EstimateRow,
    type EstimateSort,
    estimateFilters,
    estimateSorts,
    filterEstimates,
    type KeywordSuggestion,
    reasonKey,
    reasonShares,
    sortEstimates,
    trendPath,
  } from '../../lib/aso/estimates.ts';
  import { formatNumber } from '../../lib/i18n/format.ts';
  import { k, t } from '../../lib/i18n/t.ts';
  import { platformLabel, runLimited } from '../../lib/portfolio.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import Section from '../ui/Section.svelte';

  let {
    api,
    workspaceId,
    members,
    keywords,
    canWrite,
    onchanged,
    now,
  }: {
    api: Api;
    workspaceId: string;
    members: AppSummary[];
    keywords: AsoKeyword[];
    canWrite: boolean;
    onchanged: () => Promise<void>;
    now: number;
  } = $props();

  const multi = $derived(members.length > 1);
  const platformOf = (appId: string) => members.find((m) => m.id === appId)?.platform;

  let rows = $state<EstimateRow[]>([]);
  let suggestions = $state<(KeywordSuggestion & { appId: string })[]>([]);
  let loaded = $state(false);
  let failed = $state(false);
  let query = $state('');
  let sort = $state<EstimateSort>('opportunity');
  let filter = $state<EstimateFilter>('all');
  let selected = $state<string | null>(null);
  let detail = $state<EstimateDetail | null>(null);
  let detailBusy = $state(false);
  let trackingKey = $state<string | null>(null);
  let run = 0;

  const signature = $derived(keywords.map((k) => `${k.id}:${k.lastCheckedAt ?? 0}`).join(','));
  const keywordById = $derived(new Map(keywords.map((k) => [k.id, k])));
  const shown = $derived(sortEstimates(filterEstimates(rows, query, filter), sort));

  async function load() {
    const mine = ++run;
    const space = workspaceId;
    const apps = members.filter((m) => keywords.some((k) => k.appId === m.id));
    const nextRows: EstimateRow[] = [];
    const nextSuggestions: (KeywordSuggestion & { appId: string })[] = [];
    let anyFailed = false;
    await runLimited(apps, 3, async (app) => {
      try {
        const [e, s] = await Promise.all([api.asoKeywordEstimates(space, app.id), api.asoKeywordSuggestions(space, app.id)]);
        for (const r of e.estimates) nextRows.push({ ...r, appId: app.id });
        for (const x of s.suggestions) nextSuggestions.push({ ...x, appId: app.id });
      } catch {
        anyFailed = true;
      }
    });
    if (mine !== run) return;
    rows = nextRows;
    suggestions = nextSuggestions;
    failed = anyFailed;
    loaded = true;
    if (selected && !nextRows.some((r) => r.keywordId === selected)) closeDetail();
  }

  $effect(() => {
    void signature;
    void workspaceId;
    untrack(() => void load());
  });

  async function openDetail(r: EstimateRow) {
    if (selected === r.keywordId) return closeDetail();
    selected = r.keywordId;
    detail = null;
    detailBusy = true;
    try {
      const d = await api.asoKeywordEstimate(workspaceId, r.appId, r.keywordId);
      if (selected === r.keywordId) detail = d;
    } catch {
      if (selected === r.keywordId) detail = null;
    } finally {
      detailBusy = false;
    }
  }

  function closeDetail() {
    selected = null;
    detail = null;
  }

  async function track(s: KeywordSuggestion & { appId: string }) {
    const key = `${s.appId}|${s.country}|${s.term}`;
    trackingKey = key;
    try {
      const out = await api.addAsoKeywords(workspaceId, s.appId, [{ term: s.term, country: s.country, locale: s.locale }]);
      const first = out.results[0];
      if (first && (first.status === 'created' || first.status === 'exists')) {
        toast.success(t('aso:est.suggest.tracked', { term: s.term }));
        suggestions = suggestions.filter((x) => `${x.appId}|${x.country}|${x.term}` !== key);
        await onchanged();
      } else {
        toast.error(first?.message ?? t('aso:est.suggest.failed'));
      }
    } catch (e) {
      toast.error(asoErrorMessage(e, t('aso:est.suggest.failed')));
    } finally {
      trackingKey = null;
    }
  }

  const selectedRow = $derived(rows.find((r) => r.keywordId === selected) ?? null);
  const termsText = (list: string[]) => list.join(', ');
  const noneWhy = (m: EstimateMeasure) => {
    const r = m.reasons[0];
    const key = r ? reasonKey(r.code) : '';
    return r ? t(key, r.params) : t('aso:est.noneWhy');
  };
  const trendOf = (key: 'popularity' | 'difficulty') => (detail ? trendPath(detail.trend.map((p) => p[key]), 120, 28) : { path: '', samples: 0 });
  const lastOf = (key: 'popularity' | 'difficulty') => {
    const values = (detail?.trend ?? []).map((p) => p[key]).filter((v): v is number => v !== null);
    return values.length > 0 ? values[values.length - 1] : null;
  };
</script>

{#snippet explain()}
  <InfoTip label={t('aso:est.how.label')} buttonText={t('aso:est.how.label')} align="start" width="26rem">
    <div class="how stack tight">
      <p>{t('aso:est.how.intro')}</p>
      <ul>
        <li>{t('aso:est.how.hints')}</li>
        <li>{t('aso:est.how.demand')}</li>
        <li>{t('aso:est.how.own')}</li>
        <li>{t('aso:est.how.difficulty')}</li>
      </ul>
      <p>{t('aso:est.how.confidence')}</p>
      <p>{t('aso:est.how.none')}</p>
      <p>{t('aso:est.how.limits', { count: 10 })}</p>
    </div>
  </InfoTip>
{/snippet}

{#snippet cell(m: EstimateMeasure)}
  {#if m.score === null || m.confidence === null}
    <span class="muted">{t('aso:est.none')}</span>
    <InfoTip label={t('aso:est.noneWhy')} icon="info" text={noneWhy(m)} />
  {:else}
    <span class="meter">
      <span class="bar" role="img" aria-label={t('aso:est.value', { score: m.score })}><span class="fill" style:width="{m.score}%"></span></span>
      <span class="score tabular">{m.score}</span>
      <span class="dots" role="img" aria-label={t(confidenceKeys[m.confidence])} title={t(confidenceKeys[m.confidence])}>
        {#each [1, 2, 3] as n (n)}<span class="dot" class:on={n <= confidenceDots(m.confidence)}></span>{/each}
      </span>
    </span>
    {#if m.origin}<span class="origin muted">{t(m.origin === 'own_data' ? k('aso:est.origin.ownData') : k('aso:est.origin.publicSignals'))}</span>{/if}
  {/if}
{/snippet}

{#snippet reasonList(m: EstimateMeasure)}
  {@const shares = reasonShares(m)}
  <ul class="reasons">
    {#each m.reasons as r, i (r.code + i)}
      {@const key = reasonKey(r.code)}
      <li>
        <span>{t(key, r.params)}</span>
        {#if r.points !== null && r.weight > 0}
          <span class="muted line">{t('aso:est.detail.line', { points: r.points, share: shares[i] ?? 0 })}</span>
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

<div class="estimates stack">
  <Section
    title={t('aso:est.title')}
    key="keyword-estimates"
    variant="plain"
    count={loaded ? (shown.length === rows.length ? rows.length : t('aso:kw.shownOf', { shown: shown.length, count: rows.length })) : undefined}
    summary={t('aso:est.lead')}
  >
    <p class="lead muted">{t('aso:est.lead')} {@render explain()}</p>
    {#if !loaded}
      <p class="muted" role="status">…</p>
    {:else if failed && rows.length === 0}
      <p class="muted" role="alert">{t('aso:est.loadFailed')}</p>
    {:else}
      <div class="controls row">
        <input class="search" type="search" placeholder={t('aso:kw.filter')} aria-label={t('aso:kw.filter')} bind:value={query} />
        <select aria-label={t('aso:est.sort.label')} bind:value={sort}>
          {#each estimateSorts as s (s.id)}<option value={s.id}>{t(s.labelKey)}</option>{/each}
        </select>
        <select aria-label={t('aso:est.filter.label')} bind:value={filter}>
          {#each estimateFilters as f (f.id)}<option value={f.id}>{t(f.labelKey)}</option>{/each}
        </select>
      </div>
      {#if rows.every((r) => r.estimate.popularity.score === null && r.estimate.difficulty.score === null)}
        <p class="muted">{t('aso:est.empty')}</p>
      {/if}
      {#if shown.length === 0}
        <p class="muted">{t('aso:est.noMatch')}</p>
      {:else}
        <table class="fit compact">
          <colgroup>
            <col style="width: 28%" />
            <col style="width: 24%" />
            <col style="width: 24%" />
            <col style="width: 14%" />
            <col style="width: 10%" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">{t('aso:est.col.keyword')}</th>
              <th scope="col">{t('aso:est.col.popularity')}</th>
              <th scope="col">{t('aso:est.col.difficulty')}</th>
              <th scope="col">
                {t('aso:est.col.opportunity')}
                <InfoTip label={t('aso:est.col.opportunity')} icon="info" text={t('aso:est.opportunity.tip')} />
              </th>
              <th scope="col"><span class="visually-hidden">{t('aso:est.col.details')}</span></th>
            </tr>
          </thead>
          <tbody>
            {#each shown as r (r.keywordId)}
              {@const kw = keywordById.get(r.keywordId)}
              <tr class:current={selected === r.keywordId}>
                <th scope="row" class="term" data-label={t('aso:est.col.keyword')}>
                  <span class="termline">
                    <span>{r.term}</span>
                    <span class="muted market">{r.country.toUpperCase()}</span>
                    {#if multi}<Badge>{platformLabel(platformOf(r.appId) ?? 'ios')}</Badge>{/if}
                  </span>
                  {#if kw}<span class="muted rank">{t('aso:est.col.rank')}: {rankText(kw).text}</span>{/if}
                </th>
                <td data-label={t('aso:est.col.popularity')}>{@render cell(r.estimate.popularity)}</td>
                <td data-label={t('aso:est.col.difficulty')}>{@render cell(r.estimate.difficulty)}</td>
                <td data-label={t('aso:est.col.opportunity')}>
                  {#if r.estimate.opportunity.score === null || r.estimate.opportunity.confidence === null}
                    <span class="muted">{t('aso:est.none')}</span>
                  {:else}
                    <span class="score tabular">{r.estimate.opportunity.score}</span>
                    <span class="dots" role="img" aria-label={t(confidenceKeys[r.estimate.opportunity.confidence])} title={t(confidenceKeys[r.estimate.opportunity.confidence])}>
                      {#each [1, 2, 3] as n (n)}<span class="dot" class:on={n <= confidenceDots(r.estimate.opportunity.confidence)}></span>{/each}
                    </span>
                  {/if}
                </td>
                <td class="actions" data-label={t('aso:est.col.details')}>
                  <Button size="sm" variant="ghost" aria-expanded={selected === r.keywordId} label={t('aso:est.showDetails', { term: r.term })} onclick={() => openDetail(r)}>{t('aso:est.col.details')}</Button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}

      {#if selectedRow}
        <div class="card detail stack tight" role="region" aria-label={t('aso:est.detail.title', { term: selectedRow.term })}>
          <div class="row">
            <h4>{t('aso:est.detail.title', { term: selectedRow.term })}</h4>
            <span class="spacer"></span>
            {@render explain()}
            <Button size="sm" variant="ghost" onclick={closeDetail}>{t('aso:est.detail.close')}</Button>
          </div>
          <div class="cols">
            <div>
              <h5>{t('aso:est.detail.popularity')}</h5>
              {@render reasonList(selectedRow.estimate.popularity)}
            </div>
            <div>
              <h5>{t('aso:est.detail.difficulty')}</h5>
              {@render reasonList(selectedRow.estimate.difficulty)}
            </div>
          </div>
          {#if selectedRow.estimate.opportunity.roomFactor !== null}
            <p class="muted">{t('aso:est.detail.opportunity', { percent: Math.round(selectedRow.estimate.opportunity.roomFactor * 100) })}</p>
          {/if}
          <div class="cols">
            <div>
              <h5>{t('aso:est.detail.hints')}</h5>
              {#if selectedRow.estimate.hints.length === 0}
                <p class="muted">{t('aso:est.detail.hintsNone')}</p>
              {:else}
                <p class="muted">{t('aso:est.detail.hintsIntro')}</p>
                <ol class="hints">
                  {#each selectedRow.estimate.hints as h, i (h + i)}<li>{h}</li>{/each}
                </ol>
              {/if}
            </div>
            <div>
              <h5>{t('aso:est.detail.competing')}</h5>
              {#if selectedRow.estimate.top.length === 0}
                <p class="muted">{t('aso:est.detail.competingNone')}</p>
              {:else}
                <table class="fit compact">
                  <colgroup><col style="width: 70%" /><col style="width: 30%" /></colgroup>
                  <thead><tr><th scope="col">{t('aso:est.detail.col.app')}</th><th scope="col">{t('aso:est.detail.col.ratings')}</th></tr></thead>
                  <tbody>
                    {#each selectedRow.estimate.top as a (a.id)}
                      <tr>
                        <td data-label={t('aso:est.detail.col.app')}>{a.name ?? a.id}</td>
                        <td data-label={t('aso:est.detail.col.ratings')} class="tabular">{a.ratingCount === null ? '–' : formatNumber(a.ratingCount)}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              {/if}
            </div>
          </div>
          <div>
            <h5>{t('aso:est.detail.trend')}</h5>
            {#if detailBusy}
              <p class="muted" role="status">…</p>
            {:else if !detail || detail.trend.length < 2}
              <p class="muted">{t('aso:est.detail.trendNone')}</p>
            {:else}
              <div class="trends">
                {#each ['popularity', 'difficulty'] as key (key)}
                  {@const p = trendOf(key as 'popularity' | 'difficulty')}
                  {@const label = t(key === 'popularity' ? k('aso:est.detail.trendLabel') : k('aso:est.detail.trendDifficulty'), { count: detail.trend.length, latest: lastOf(key as 'popularity' | 'difficulty') ?? '–' })}
                  <figure>
                    <svg viewBox="0 0 120 28" width="120" height="28" role="img" aria-label={label}><title>{label}</title><path d={p.path} /></svg>
                    <figcaption class="muted">{t(key === 'popularity' ? k('aso:est.col.popularity') : k('aso:est.col.difficulty'))}</figcaption>
                  </figure>
                {/each}
              </div>
            {/if}
          </div>
          <p class="muted">
            {#if selectedRow.estimate.signalsAt !== null}
              {t('aso:est.detail.read', { when: agoText(selectedRow.estimate.signalsAt, now), model: selectedRow.estimate.model })}
            {:else}
              {t('aso:est.detail.noRead', { model: selectedRow.estimate.model })}
            {/if}
          </p>
        </div>
      {/if}
    {/if}
  </Section>

  {#if loaded && (suggestions.length > 0 || rows.some((r) => !supports(r.platform as 'ios', 'unofficialSearch')))}
    <Section title={t('aso:est.suggest.title')} key="keyword-suggestions" variant="plain" count={suggestions.length}>
      <p class="muted">{t('aso:est.suggest.lead')}</p>
      {#if suggestions.length === 0}
        <p class="muted">{t('aso:est.suggest.none')}</p>
      {:else}
        <ul class="suggest">
          {#each suggestions as s (s.appId + s.country + s.term)}
            <li class="row">
              <span class="term">{s.term}</span>
              <span class="muted market">{s.country.toUpperCase()}</span>
              {#if multi}<Badge>{platformLabel(platformOf(s.appId) ?? 'ios')}</Badge>{/if}
              <span class="muted from">{t('aso:est.suggest.from', { terms: termsText(s.from) })}</span>
              <span class="spacer"></span>
              {#if canWrite}
                <Button size="sm" icon="plus" loading={trackingKey === `${s.appId}|${s.country}|${s.term}`} label={t('aso:est.suggest.trackFor', { term: s.term })} onclick={() => track(s)}>{t('aso:est.suggest.track')}</Button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </Section>
  {/if}
</div>

<style>
  .lead {
    margin: 0 0 var(--space-3);
  }

  .controls {
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .search {
    width: 14rem;
    max-width: 100%;
  }

  th,
  td {
    text-align: left;
    vertical-align: top;
  }

  .term {
    font-weight: var(--weight-medium);
  }

  .termline {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .rank {
    display: block;
    font-size: var(--text-sm);
    font-weight: var(--weight-regular, 400);
  }

  .market {
    font-size: var(--text-sm);
  }

  .meter {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
    max-width: 100%;
  }

  .bar {
    display: inline-block;
    width: 3.5rem;
    height: 0.5rem;
    overflow: hidden;
    background: var(--track);
    border-radius: var(--radius-sm);
  }

  .fill {
    display: block;
    height: 100%;
    background: var(--accent);
  }

  .score {
    min-width: 1.75rem;
    font-weight: var(--weight-medium);
  }

  .dots {
    display: inline-flex;
    gap: 2px;
    align-items: center;
  }

  .dot {
    width: 0.4rem;
    height: 0.4rem;
    border: 1px solid var(--muted);
    border-radius: 50%;
  }

  .dot.on {
    background: var(--muted);
  }

  .origin {
    display: block;
    font-size: var(--text-sm);
  }

  tr.current {
    background: var(--surface-active);
  }

  .detail {
    margin-top: var(--space-4);
  }

  .detail h4,
  .detail h5 {
    margin: 0;
  }

  .cols {
    display: grid;
    gap: var(--space-4);
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
  }

  .reasons,
  .hints,
  .suggest {
    padding-left: var(--space-4);
    margin: var(--space-2) 0 0;
  }

  .suggest {
    padding-left: 0;
    list-style: none;
  }

  .suggest li {
    flex-wrap: wrap;
    gap: var(--space-2);
    padding: var(--space-2) 0;
    border-top: 1px solid var(--line);
  }

  .line {
    display: block;
    font-size: var(--text-sm);
  }

  .trends {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4);
  }

  figure {
    margin: 0;
  }

  figure svg {
    display: block;
    color: var(--muted);
  }

  figure path {
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.5;
  }

  .how p,
  .how ul {
    margin: 0;
  }

  .how ul {
    padding-left: var(--space-4);
  }
</style>
