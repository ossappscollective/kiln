<!--
  RatingOverview: the numbers of the Reviews tab on one compact row: the average and the rating
  distribution of the stored reviews as mini bars, the store-wide rating where the store gives one, a
  tiny weekly trend (a small inline SVG, no chart library), and the triage counts as chips (a chip
  filters the list by that status). "By version" is only there when a version is known. The basis of
  each figure (what it is computed from, the dates, the limits) is behind the "About these numbers"
  popover: the stored reviews are what this tool has read, which is not every rating in the store.
  Props: summary (ReviewsSummary), activeStatus? (the status the list is filtered by, '' for none),
  onstatus? (called with a status to filter by it, or '' to clear; without it the chips are plain).
-->
<script lang="ts">
  import { fullTime } from '../../lib/format.ts';
  import {
    averageText,
    histogramBars,
    ratingText,
    statusLabel,
    statusOrder,
    trendDescription,
    trendGeometry,
    weekLabel,
    type ReviewStatus,
    type ReviewsSummary,
  } from '../../lib/reviews.ts';
  import Icon from '../ui/Icon.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import StatChip from '../ui/StatChip.svelte';

  let {
    summary,
    activeStatus = '',
    onstatus,
  }: { summary: ReviewsSummary; activeStatus?: '' | ReviewStatus; onstatus?: (status: '' | ReviewStatus) => void } = $props();

  const stored = $derived(summary.stored);
  const bars = $derived(histogramBars(stored.histogram));
  const trend = $derived(trendGeometry(stored.weeks, 160, 40, 2));
  const first = $derived(stored.weeks[0]);
  const last = $derived(stored.weeks[stored.weeks.length - 1]);
  /** The versions with the most reviews first; a long list is cut and says so. */
  const versions = $derived(stored.byVersion.slice(0, 8));
  const wide = $derived(summary.storeWide[0] ?? null);
</script>

<section class="overview card" aria-label="Rating summary">
  <div class="top">
    <div class="avg">
      <span class="avg-number num">{averageText(stored.average)}</span>
      <span class="avg-meta">
        <span class="stars" role="img" aria-label={stored.average === null ? 'No ratings yet' : `Average ${ratingText(stored.average)}`}>
          {#each [1, 2, 3, 4, 5] as n (n)}
            <Icon name={stored.average !== null && stored.average >= n - 0.5 ? 'star-filled' : 'star'} size={14} />
          {/each}
        </span>
        <span class="basis">{stored.count} stored {stored.count === 1 ? 'review' : 'reviews'}</span>
      </span>
    </div>

    <ul class="bars" aria-label="Reviews by rating">
      {#each bars as bar (bar.stars)}
        <li>
          <span class="bar-label">{bar.stars}<span class="visually-hidden"> {bar.stars === 1 ? 'star' : 'stars'}</span></span>
          <span class="bar-track" aria-hidden="true"><span class="bar-fill" style:width="{Math.round(bar.share * 100)}%"></span></span>
          <span class="bar-count num">{bar.count}<span class="bar-percent"> ({bar.percent}%)</span></span>
        </li>
      {/each}
    </ul>

    {#if wide}
      <div class="wide" title={wide.label}>
        <span class="eyebrow">Store-wide</span>
        <span class="wide-line">
          <span class="wide-number num">{averageText(wide.average)}</span>
          {#if wide.ratingCount !== null}<span class="muted small">{wide.ratingCount} ratings</span>{/if}
        </span>
      </div>
    {/if}

    {#if stored.count > 0}
      <div class="trendbox">
        <span class="eyebrow">Weekly trend</span>
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
      </div>
    {/if}
  </div>

  <div class="bottom">
    <ul class="chips" aria-label="Triage">
      {#each statusOrder as status (status)}
        <li>
          <StatChip
            label={statusLabel(status)}
            value={summary.byStatus[status]}
            tone={status === 'new' ? 'info' : 'neutral'}
            onclick={onstatus ? () => onstatus(activeStatus === status ? '' : status) : undefined}
            pressed={onstatus ? activeStatus === status : undefined}
          />
        </li>
      {/each}
    </ul>
    <span class="spacer"></span>
    {#if versions.length > 0}
      <InfoTip label="Reviews by app version" buttonText="By version" icon="tag" align="end" width="20rem">
        <table class="versions">
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
          <p class="muted small">{stored.byVersion.length - versions.length} more versions not shown. Filter by version below.</p>
        {/if}
      </InfoTip>
    {/if}
    <InfoTip label="About these numbers" buttonText="About the numbers" align="end" width="26rem">
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
  </div>
</section>

<style>
  .overview {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
  }

  .top {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3) var(--space-8);
    align-items: center;
  }

  .bottom {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    padding-top: var(--space-2);
    border-top: 1px solid var(--line);
  }

  .small {
    margin: 0;
    font-size: var(--text-sm);
  }

  .avg {
    display: flex;
    gap: var(--space-3);
    align-items: center;
  }

  .avg-number {
    font-size: var(--text-3xl);
    font-weight: var(--weight-semibold);
    line-height: 1;
  }

  .avg-meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .stars {
    display: inline-flex;
    color: var(--warn);
  }

  .basis {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .bars {
    display: flex;
    flex: 0 1 260px;
    flex-direction: column;
    gap: 2px;
    min-width: 200px;
    margin: 0;
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

  .wide,
  .trendbox {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .wide-line {
    display: flex;
    gap: var(--space-2);
    align-items: baseline;
  }

  .wide-number {
    font-size: var(--text-2xl);
    font-weight: var(--weight-semibold);
    line-height: 1.1;
  }

  .trend {
    width: 160px;
    height: 40px;
  }

  .trend-bar {
    fill: var(--line-strong);
  }

  .trend-line {
    stroke: var(--accent);
    stroke-width: 1.5;
    vector-effect: non-scaling-stroke;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .versions {
    width: 100%;
    font-size: var(--text-sm);
  }

  .versions .r {
    text-align: right;
  }
</style>
