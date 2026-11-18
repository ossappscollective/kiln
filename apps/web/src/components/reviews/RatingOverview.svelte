<!--
  RatingOverview: the numbers of the Reviews tab: average and histogram of the stored reviews, the
  store-wide rating where the store gives one, the versions, and the weekly trend as a small inline
  SVG (no chart library).
  Props: summary (ReviewsSummary). Every figure says what it is computed from: the stored
  reviews are what this tool has read, which is not every rating in the store.
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
    type ReviewsSummary,
  } from '../../lib/reviews.ts';
  import Icon from '../ui/Icon.svelte';

  let { summary }: { summary: ReviewsSummary } = $props();

  const stored = $derived(summary.stored);
  const bars = $derived(histogramBars(stored.histogram));
  const trend = $derived(trendGeometry(stored.weeks));
  const first = $derived(stored.weeks[0]);
  const last = $derived(stored.weeks[stored.weeks.length - 1]);
  /** The versions with the most reviews first; a long list is cut and says so. */
  const versions = $derived(stored.byVersion.slice(0, 8));
</script>

<div class="overview">
  <section class="card block" aria-labelledby="ov-stored">
    <h3 id="ov-stored" class="visually-hidden">Stored reviews</h3>
    <div class="avg">
      <span class="avg-number num">{averageText(stored.average)}</span>
      <span class="avg-meta">
        <span class="stars" role="img" aria-label={stored.average === null ? 'No ratings yet' : `Average ${ratingText(stored.average)}`}>
          {#each [1, 2, 3, 4, 5] as n (n)}
            <Icon name={stored.average !== null && stored.average >= n - 0.5 ? 'star-filled' : 'star'} size={16} />
          {/each}
        </span>
        <span class="basis">{stored.label}</span>
      </span>
    </div>

    <ul class="bars" aria-label="Reviews by rating">
      {#each bars as bar (bar.stars)}
        <li>
          <span class="bar-label">{bar.stars} {bar.stars === 1 ? 'star' : 'stars'}</span>
          <span class="bar-track" aria-hidden="true"><span class="bar-fill" style:width="{Math.round(bar.share * 100)}%"></span></span>
          <span class="bar-count num">{bar.count}<span class="bar-percent"> ({bar.percent}%)</span></span>
        </li>
      {/each}
    </ul>
    {#if stored.truncated}
      <p class="muted small">Only the newest reviews are counted here: there are more stored than a summary reads.</p>
    {/if}
    {#if stored.oldestAt !== null && stored.newestAt !== null}
      <p class="muted small">Stored reviews from {fullTime(stored.oldestAt)} to {fullTime(stored.newestAt)}.</p>
    {/if}
  </section>

  <section class="card block" aria-labelledby="ov-store">
    <h3 id="ov-store">Store-wide rating</h3>
    {#if summary.storeWide.length === 0}
      <p class="muted small">
        {#if summary.app.store === 'googleplay'}
          Google Play does not give this tool a store-wide rating. Only the reviews it can list are counted.
        {:else}
          Not read yet. It comes from Apple’s public lookup and is stored after a successful read.
        {/if}
      </p>
    {:else}
      {#each summary.storeWide as wide (wide.territory)}
        <p class="wide">
          <span class="avg-number small-number num">{averageText(wide.average)}</span>
          <span class="muted small">
            {wide.label}. Read {fullTime(wide.observedAt)}.
            {#if wide.currentVersionAverage !== null}
              This version: {averageText(wide.currentVersionAverage)}{wide.currentVersionCount !== null ? ` from ${wide.currentVersionCount} ratings` : ''}.
            {/if}
          </span>
        </p>
      {/each}
      <p class="muted small">Ratings in the store include people who did not write a review, so this differs from the stored reviews.</p>
    {/if}
  </section>

  <section class="card block" aria-labelledby="ov-trend">
    <h3 id="ov-trend">Weekly trend</h3>
    {#if stored.count === 0}
      <p class="muted small">Nothing to chart yet.</p>
    {:else}
      <svg
        class="trend"
        viewBox="0 0 {trend.width} {trend.height}"
        role="img"
        aria-label={trendDescription(stored.weeks)}
      >
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
          {#each segment as point (`${point.x}`)}
            <circle class="trend-dot" cx={point.x} cy={point.y} r="2" />
          {/each}
        {/each}
      </svg>
      <p class="muted small trend-caption">
        {#if first && last}{weekLabel(first.weekStart)} to {weekLabel(last.weekStart)}.{/if}
        Bars are reviews a week, the line is the weekly average rating (1 at the bottom, 5 at the top).
      </p>
    {/if}
  </section>

  <section class="card block" aria-labelledby="ov-versions">
    <h3 id="ov-versions">By app version</h3>
    {#if versions.length === 0}
      <p class="muted small">No version is known for the stored reviews.</p>
    {:else}
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
    {/if}
  </section>

  <section class="card block" aria-labelledby="ov-status">
    <h3 id="ov-status">Triage</h3>
    <ul class="statuses">
      {#each statusOrder as status (status)}
        <li><span class="num">{summary.byStatus[status]}</span> {statusLabel(status)}</li>
      {/each}
    </ul>
  </section>
</div>

<style>
  .overview {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: var(--space-4);
  }

  .block {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }

  h3 {
    margin: 0;
    font-size: var(--text-md);
  }

  .small {
    margin: 0;
    font-size: var(--text-sm);
  }

  .avg {
    display: flex;
    gap: var(--space-4);
    align-items: center;
  }

  .avg-number {
    font-size: var(--text-3xl);
    font-weight: var(--weight-semibold);
    line-height: 1;
  }

  .small-number {
    font-size: var(--text-2xl);
  }

  .avg-meta {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .stars {
    display: inline-flex;
    color: var(--warn);
  }

  .basis {
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .bars {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .bars li {
    display: grid;
    grid-template-columns: 56px 1fr 84px;
    gap: var(--space-2);
    align-items: center;
    font-size: var(--text-sm);
  }

  .bar-track {
    height: 8px;
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

  .wide {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    margin: 0;
  }

  .trend {
    width: 100%;
    height: 72px;
  }

  .trend-bar {
    fill: var(--line-strong);
  }

  .trend-line {
    stroke: var(--accent);
    stroke-width: 1.5;
    vector-effect: non-scaling-stroke;
  }

  .trend-dot {
    fill: var(--accent);
  }

  .trend-caption {
    max-width: 52ch;
  }

  .versions {
    width: 100%;
    font-size: var(--text-sm);
  }

  .versions .r {
    text-align: right;
  }

  .statuses {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin: 0;
    padding: 0;
    font-size: var(--text-sm);
    list-style: none;
  }
</style>
