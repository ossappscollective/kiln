<!--
  RatingOverview: the numbers of the Reviews tab as one slim line: the average with its stars, how many reviews are stored, a tiny
  weekly trend (a small inline SVG, no chart library) and the store-wide rating where the store gives one. Everything else (the
  distribution by rating, the basis and dates of each figure, the store-wide detail, the versions) is behind "About the numbers":
  the stored reviews are what this tool has read, which is not every rating in the store. The status chips live in the toolbar of
  the tab, not here.
  Props: summary (ReviewsSummary).
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
  import { fullTime } from '../../lib/format.ts';
  import { formatNumber, formatPercent } from '../../lib/i18n/format.ts';
  import {
    averageText,
    histogramBars,
    ratingText,
    trendDescription,
    trendGeometry,
    weekLabel,
    type ReviewsSummary,
  } from '../../lib/reviews/reviews.ts';
  import Icon from '../ui/Icon.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import { statsLine } from '../../lib/reviews/toolbar.ts';

  let { summary }: { summary: ReviewsSummary } = $props();

  const stored = $derived(summary.stored);
  const bars = $derived(histogramBars(stored.histogram));
  const trend = $derived(trendGeometry(stored.weeks, 72, 20, 1));
  const first = $derived(stored.weeks[0]);
  const last = $derived(stored.weeks[stored.weeks.length - 1]);
  /** The versions with the most reviews first; a long list is cut and says so. */
  const versions = $derived(stored.byVersion.slice(0, 8));
  const wide = $derived(summary.storeWide[0] ?? null);
</script>

<section class="overview" aria-label={t('reviews:overview.region')}>
  <span class="avg-number num">{averageText(stored.average)}</span>
  <span class="stars" role="img" aria-label={stored.average === null ? t('reviews:overview.noRatings') : t('reviews:overview.averageLabel', { rating: ratingText(stored.average) })}>
    {#each [1, 2, 3, 4, 5] as n (n)}
      <Icon name={stored.average !== null && stored.average >= n - 0.5 ? 'star-filled' : 'star'} size={13} />
    {/each}
  </span>
  <span class="line muted">{statsLine(stored)}</span>
  {#if wide}<span class="line muted" title={wide.label}>{wide.ratingCount !== null ? t('reviews:overview.storeWideCount', { value: averageText(wide.average), count: wide.ratingCount }) : t('reviews:overview.storeWide', { value: averageText(wide.average) })}</span>{/if}
  {#if stored.count > 0}
    <svg class="trend" viewBox="0 0 {trend.width} {trend.height}" role="img" aria-label={trendDescription(stored.weeks)}>
      {#each trend.bars as bar (bar.weekStart)}
        {#if bar.h > 0}
          <rect class="trend-bar" x={bar.x} y={bar.y} width={bar.w} height={bar.h}>
            <title>{bar.average !== null ? t('reviews:overview.barAverage', { week: weekLabel(bar.weekStart), count: bar.count, average: averageText(bar.average) }) : t('reviews:overview.bar', { week: weekLabel(bar.weekStart), count: bar.count })}</title>
          </rect>
        {/if}
      {/each}
      {#each trend.segments as segment, i (i)}
        {#if segment.length > 1}
          <polyline class="trend-line" points={segment.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" />
        {/if}
      {/each}
    </svg>
  {/if}
  <span class="spacer"></span>
  <span class="tips">
    <InfoTip label={t('reviews:overview.aboutLabel')} buttonText={t('reviews:overview.about')} align="end" width="26rem">
      <ul class="bars" aria-label={t('reviews:overview.byRating')}>
        {#each bars as bar (bar.stars)}
          <li>
            <span class="bar-label"><span aria-hidden="true">{bar.stars}</span><span class="visually-hidden">{t('reviews:overview.stars', { count: bar.stars })}</span></span>
            <span class="bar-track" aria-hidden="true"><span class="bar-fill" style:width="{Math.round(bar.share * 100)}%"></span></span>
            <span class="bar-count num">{formatNumber(bar.count)}<span class="bar-percent"> ({formatPercent(bar.percent / 100)})</span></span>
          </li>
        {/each}
      </ul>
      {#if versions.length > 0}
        <table class="versions">
          <caption class="visually-hidden">{t('reviews:overview.byVersion')}</caption>
          <thead>
            <tr><th scope="col">{t('reviews:overview.colVersion')}</th><th scope="col" class="r">{t('reviews:overview.colReviews')}</th><th scope="col" class="r">{t('reviews:overview.colAverage')}</th></tr>
          </thead>
          <tbody>
            {#each versions as v (v.version)}
              <tr><th scope="row">{v.version}</th><td class="r">{formatNumber(v.count)}</td><td class="r">{averageText(v.average)}</td></tr>
            {/each}
          </tbody>
        </table>
        {#if stored.byVersion.length > versions.length}
          <p class="muted small">{t('reviews:overview.moreVersions', { count: stored.byVersion.length - versions.length })}</p>
        {/if}
      {/if}
      <p><strong>{t('reviews:overview.storedHeading')}</strong> {stored.label}</p>
      {#if stored.truncated}
        <p class="muted">{t('reviews:overview.truncated')}</p>
      {/if}
      {#if stored.oldestAt !== null && stored.newestAt !== null}
        <p class="muted">{t('reviews:overview.storedRange', { from: fullTime(stored.oldestAt), to: fullTime(stored.newestAt) })}</p>
      {/if}
      <p>
        <strong>{t('reviews:overview.storeWideHeading')}</strong>
        {#if summary.storeWide.length === 0}
          {#if summary.app.store === 'googleplay'}
            {t('reviews:overview.noStoreWideGoogle')}
          {:else}
            {t('reviews:overview.noStoreWideApple')}
          {/if}
        {:else}
          {#each summary.storeWide as w (w.territory)}
            {t('reviews:overview.storeRead', { label: w.label, time: fullTime(w.observedAt) })}
            {#if w.currentVersionAverage !== null}
              {w.currentVersionCount !== null ? t('reviews:overview.thisVersionCount', { average: averageText(w.currentVersionAverage), count: w.currentVersionCount }) : t('reviews:overview.thisVersion', { average: averageText(w.currentVersionAverage) })}
            {/if}
          {/each}
          {t('reviews:overview.storeWideNote')}
        {/if}
      </p>
      {#if stored.count > 0}
        <p class="muted">
          {first && last
            ? t('reviews:overview.trendNoteRange', { from: weekLabel(first.weekStart), to: weekLabel(last.weekStart) })
            : t('reviews:overview.trendNote')}
        </p>
      {/if}
    </InfoTip>
  </span>
</section>

<style>
  .overview {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    align-items: center;
    min-width: 0;
    padding: var(--space-1) 0;
  }

  .small {
    margin: 0;
    font-size: var(--text-sm);
  }

  .avg-number {
    font-size: var(--text-xl);
    font-weight: var(--weight-semibold);
    line-height: 1;
  }

  .stars {
    display: inline-flex;
    color: var(--warn);
  }

  .line {
    font-size: var(--text-sm);
  }

  .tips {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
  }

  .bars {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0 0 var(--space-3);
    padding: 0;
    list-style: none;
  }

  .bars li {
    display: grid;
    grid-template-columns: 12px 1fr 72px;
    gap: var(--space-2);
    align-items: center;
    font-size: var(--text-xs);
  }

  .bar-track {
    height: 6px;
    overflow: hidden;
    background: var(--surface-sunken);
    border-radius: var(--radius-full);
  }

  .bar-fill {
    display: block;
    height: 100%;
    background: var(--viz-1, var(--accent));
    border-radius: var(--radius-full);
  }

  .bar-count {
    text-align: right;
  }

  .bar-percent {
    color: var(--muted);
  }

  .trend {
    width: 72px;
    height: 20px;
  }

  .trend-bar {
    fill: var(--line-strong);
  }

  .trend-line {
    stroke: var(--viz-1, var(--accent));
    stroke-width: 1.5;
    vector-effect: non-scaling-stroke;
  }

  .versions {
    width: 100%;
    margin-bottom: var(--space-2);
    font-size: var(--text-sm);
  }

  .versions .r {
    text-align: right;
  }
</style>
