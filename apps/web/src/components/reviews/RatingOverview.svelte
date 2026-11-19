<!--
  RatingOverview: the numbers of the Reviews tab as one slim line: the average with its stars, how many reviews are stored, a tiny
  weekly trend (a small inline SVG, no chart library) and the store-wide rating where the store gives one. Everything else (the
  distribution by rating, the basis and dates of each figure, the store-wide detail, the versions) is behind "About the numbers":
  the stored reviews are what this tool has read, which is not every rating in the store. The status chips live in the toolbar of
  the tab, not here.
  Props: summary (ReviewsSummary).
-->
<script lang="ts">
  import { fullTime } from '../../lib/format.ts';
  import {
    averageText,
    histogramBars,
    ratingText,
    trendDescription,
    trendGeometry,
    weekLabel,
    type ReviewsSummary,
  } from '../../lib/reviews.ts';
  import Icon from '../ui/Icon.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import { statsLine } from '../../lib/reviews-toolbar.ts';

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

<section class="overview" aria-label="Rating summary">
  <span class="avg-number num">{averageText(stored.average)}</span>
  <span class="stars" role="img" aria-label={stored.average === null ? 'No ratings yet' : `Average ${ratingText(stored.average)}`}>
    {#each [1, 2, 3, 4, 5] as n (n)}
      <Icon name={stored.average !== null && stored.average >= n - 0.5 ? 'star-filled' : 'star'} size={13} />
    {/each}
  </span>
  <span class="line muted">{statsLine(stored)}</span>
  {#if wide}<span class="line muted" title={wide.label}>Store-wide {averageText(wide.average)}{wide.ratingCount !== null ? `, ${wide.ratingCount} ratings` : ''}</span>{/if}
  {#if stored.count > 0}
    <svg class="trend" viewBox="0 0 {trend.width} {trend.height}" role="img" aria-label={trendDescription(stored.weeks)}>
      {#each trend.bars as bar (bar.weekStart)}
        {#if bar.h > 0}
          <rect class="trend-bar" x={bar.x} y={bar.y} width={bar.w} height={bar.h}>
            <title>{weekLabel(bar.weekStart)}: {bar.count} {bar.count === 1 ? 'review' : 'reviews'}{bar.average !== null ? `, average ${averageText(bar.average)}` : ''}</title>
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
    <InfoTip label="About these numbers" buttonText="About the numbers" align="end" width="26rem">
      <ul class="bars" aria-label="Reviews by rating">
        {#each bars as bar (bar.stars)}
          <li>
            <span class="bar-label">{bar.stars}<span class="visually-hidden"> {bar.stars === 1 ? 'star' : 'stars'}</span></span>
            <span class="bar-track" aria-hidden="true"><span class="bar-fill" style:width="{Math.round(bar.share * 100)}%"></span></span>
            <span class="bar-count num">{bar.count}<span class="bar-percent"> ({bar.percent}%)</span></span>
          </li>
        {/each}
      </ul>
      {#if versions.length > 0}
        <table class="versions">
          <caption class="visually-hidden">Reviews by app version</caption>
          <thead>
            <tr><th scope="col">Version</th><th scope="col" class="r">Reviews</th><th scope="col" class="r">Average</th></tr>
          </thead>
          <tbody>
            {#each versions as v (v.version)}
              <tr><th scope="row">{v.version}</th><td class="r">{v.count}</td><td class="r">{averageText(v.average)}</td></tr>
            {/each}
          </tbody>
        </table>
        {#if stored.byVersion.length > versions.length}
          <p class="muted small">{stored.byVersion.length - versions.length} more versions not shown. Filter by version in the filters.</p>
        {/if}
      {/if}
      <p><strong>Stored reviews.</strong> {stored.label}</p>
      {#if stored.truncated}
        <p class="muted">Only the newest reviews are counted here: there are more stored than a summary reads.</p>
      {/if}
      {#if stored.oldestAt !== null && stored.newestAt !== null}
        <p class="muted">Stored reviews from {fullTime(stored.oldestAt)} to {fullTime(stored.newestAt)}.</p>
      {/if}
      <p>
        <strong>Store-wide rating.</strong>
        {#if summary.storeWide.length === 0}
          {#if summary.app.store === 'googleplay'}
            Google Play does not give this tool a store-wide rating. Only the reviews it can list are counted.
          {:else}
            Not read yet. It comes from Apple’s public lookup and is stored after a successful read.
          {/if}
        {:else}
          {#each summary.storeWide as w (w.territory)}
            {w.label}. Read {fullTime(w.observedAt)}.
            {#if w.currentVersionAverage !== null}
              This version: {averageText(w.currentVersionAverage)}{w.currentVersionCount !== null ? ` from ${w.currentVersionCount} ratings` : ''}.
            {/if}
          {/each}
          Ratings in the store include people who did not write a review, so this differs from the stored reviews.
        {/if}
      </p>
      {#if stored.count > 0}
        <p class="muted">
          Weekly trend:
          {#if first && last}{weekLabel(first.weekStart)} to {weekLabel(last.weekStart)}.{/if}
          Bars are reviews a week, the line is the weekly average rating (1 at the bottom, 5 at the top).
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
    background: var(--accent);
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
    stroke: var(--accent);
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
