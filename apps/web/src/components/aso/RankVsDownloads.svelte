<!--
  RankVsDownloads: the rank history of some tracked keywords of one storefront laid on the same days as the app's downloads. Two panels
  on one calendar: the rank on top with rank 1 at the TOP (an inverted axis; "not ranked" at the bottom, a gap where nothing was
  checked) and the downloads per day under it. Big rank moves (the threshold of the ASO settings) are marked with a triangle that points
  up for a better rank and down for a worse one. For each move a plain "what changed" line gives the downloads per day in the 7 days
  before and the 7 days after, the percent change and the number of days compared, and ALWAYS says "Correlation, not proof": it shows
  what happened at the same time, never that a rank move changed downloads. A release, a campaign or a holiday moves downloads too.
  The newest days of the downloads can still change (Apple about 2 days, Play files 3 to 7), so they are shaded and not compared yet.
  The view is hidden when fewer than 14 days of either series exist, and says plainly what is missing ("Turn on Analytics to see downloads").
  Reads our own database through the server; nothing reaches a store.
  Props: api, workspaceId, app ({ id, platform }), now, version (a number that, when it changes, reads again), analyticsHref, keywordsHref.
  The numbers are core buildRankVsDownloads (server side); the layout and words are lib/rank-downloads.ts. Colors come from VizScope.
-->
<script lang="ts">
  import { type Platform, addDays, dateToDay } from '@mrm/core';
  import type { Api } from '../../lib/api.ts';
  import { formatDay } from '../../lib/analytics.ts';
  import type { Box } from '../../lib/analytics-chart.ts';
  import { xTickIndexes } from '../../lib/analytics-chart.ts';
  import { missingRuns } from '../../lib/analytics.ts';
  import { asoErrorMessage } from '../../lib/aso.ts';
  import {
    DEFAULT_DAYS,
    MAX_DRAWN,
    type RankVsDownloadsResponse,
    chartName,
    dashes,
    dayIndexAt,
    delayLine,
    downloadsName,
    downloadsPanel,
    gateOf,
    rangeChoices,
    rankPanel,
    tipFor,
    toggleKeyword,
    whatChangedList,
  } from '../../lib/rank-downloads.ts';
  import { floating } from '../../lib/floating.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import { pointAnchor } from '../../lib/virtual-anchor.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import VizScope from '../analytics/VizScope.svelte';

  let {
    api,
    workspaceId,
    app,
    now,
    version = 0,
    heading = false,
    analyticsHref,
    keywordsHref,
  }: {
    api: Api;
    workspaceId: string;
    app: { id: string; platform: Platform };
    now: number;
    version?: number;
    heading?: boolean;
    analyticsHref?: string;
    keywordsHref?: string;
  } = $props();

  const uid = $props.id();

  let days = $state(DEFAULT_DAYS);
  let country = $state('');
  /** The keyword ids the person chose; null: the ones the server picked (the most checked). */
  let chosen = $state<string[] | null>(null);
  let view = $state<RankVsDownloadsResponse | null>(null);
  let error = $state('');
  let loading = $state(true);
  let generation = 0;
  let hover = $state<number | null>(null);
  let width = $state(640);
  let plotsEl = $state<HTMLElement | null>(null);

  $effect(() => {
    void version;
    const range = days;
    const where = country;
    const ids = chosen;
    const upTo = addDays(dateToDay(now), -1);
    const mine = ++generation;
    loading = true;
    void (async () => {
      try {
        const next = await api.asoRankVsDownloads(workspaceId, app.id, {
          from: addDays(upTo, -(range - 1)),
          to: upTo,
          ...(where !== '' ? { country: where } : {}),
          ...(ids && ids.length > 0 ? { keywords: ids } : {}),
        });
        if (mine !== generation) return;
        view = next;
        error = '';
      } catch (e) {
        if (mine !== generation) return;
        error = asoErrorMessage(e, 'Could not load the comparison.');
      } finally {
        if (mine === generation) loading = false;
      }
    })();
  });

  const gate = $derived(view ? gateOf(view) : null);
  const rankBox = $derived<Box>({ width, height: 150, left: 44, right: 14, top: 12, bottom: 8 });
  const dlBox = $derived<Box>({ width, height: 130, left: 44, right: 14, top: 8, bottom: 24 });
  const rank = $derived(view && gate?.kind === 'chart' ? rankPanel(view, rankBox) : null);
  const dl = $derived(view && gate?.kind === 'chart' ? downloadsPanel(view, dlBox) : null);
  const xTicks = $derived(view ? xTickIndexes(view.days.length, Math.max(2, Math.floor((width - 58) / 76))) : []);
  const tip = $derived(view && hover !== null ? tipFor(view, hover) : null);
  const tipX = $derived(rank && hover !== null ? rank.xCenter(hover) : 0);
  const flip = $derived(tipX > width * 0.58);
  /** The tip hangs on a point beside the crosshair and is drawn in the top layer (lib/floating.ts), so no card can clip it. */
  const tipAnchor = $derived(tip && plotsEl ? pointAnchor(plotsEl, tipX + (flip ? -12 : 12), 4) : null);
  const changed = $derived(view && gate?.kind === 'chart' ? whatChangedList(view) : []);
  const noCheckBands = $derived.by(() => {
    if (!view || !rank) return [];
    const v = view;
    const flags = v.days.map((_, i) => (v.keywords.every((k) => !k.samples[i]) ? null : 0));
    return missingRuns(flags).map((r) => ({ x: rank.box.left + r.start * rank.slot, w: (r.end - r.start + 1) * rank.slot, from: r.start }));
  });
  const delay = $derived(view ? delayLine(view) : null);

  const pick = (id: string) => {
    if (!view) return;
    chosen = toggleKeyword(chosen ?? view.selected, id);
  };

  function at(event: PointerEvent) {
    if (!rank) return;
    const el = event.currentTarget as SVGSVGElement;
    hover = dayIndexAt(rank, event.clientX - el.getBoundingClientRect().left);
  }

  function onkeydown(event: KeyboardEvent) {
    if (!view) return;
    const last = view.days.length - 1;
    const here = hover ?? last;
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = Math.max(0, here - 1);
    else if (event.key === 'ArrowRight') next = Math.min(last, here + 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    else if (event.key === 'Escape') {
      hover = null;
      return;
    }
    if (next === null) return;
    event.preventDefault();
    hover = next;
  }

  const trianglePath = (m: { x: number; y: number; direction: 'better' | 'worse' }) =>
    m.direction === 'better' ? `M${m.x},${m.y - 7}L${m.x + 5.5},${m.y + 3}L${m.x - 5.5},${m.y + 3}Z` : `M${m.x},${m.y + 7}L${m.x + 5.5},${m.y - 3}L${m.x - 5.5},${m.y - 3}Z`;
</script>

<VizScope>
  <section class="rvd stack" aria-label="{platformLabel(app.platform)} rank and downloads">
    {#if heading}<h3 class="eyebrow">{platformLabel(app.platform)}</h3>{/if}

    {#if error}
      <Alert tone="error">{error}</Alert>
    {:else if !view}
      <Skeleton width="100%" height="200px" />
    {:else}
      <div class="row controls">
        {#if (view.countries ?? []).length > 1}
          <label for="{uid}-country" class="muted">Storefront</label>
          <select id="{uid}-country" value={view.country ?? ''} onchange={(e) => ((country = e.currentTarget.value), (chosen = null))}>
            {#each view.countries ?? [] as c (c)}<option value={c}>{c.toUpperCase()}</option>{/each}
          </select>
        {:else if view.country}
          <span class="muted">Storefront {view.country.toUpperCase()}</span>
        {/if}
        <label for="{uid}-days" class="muted">Period</label>
        <select id="{uid}-days" bind:value={days}>
          {#each rangeChoices as r (r.days)}<option value={r.days}>Last {r.label}</option>{/each}
        </select>
        <InfoTip label="How to read this view" buttonText="How to read this" align="start" width="28rem">
          <ul class="plain">
            {#each view.notes as n (n.code)}<li>{n.message}</li>{/each}
            {#if delay}<li>{delay}</li>{/if}
          </ul>
        </InfoTip>
      </div>

      {#if view.available.length > 0}
        <fieldset class="picks">
          <legend class="muted">Keywords to draw (up to {MAX_DRAWN})</legend>
          {#each view.available as k (k.id)}
            <label class="pick" class:off={k.checks === 0}>
              <input type="checkbox" checked={view.selected.indexOf(k.id) >= 0} onchange={() => pick(k.id)} disabled={k.checks === 0 && view.selected.indexOf(k.id) < 0} />
              <span>{k.term}</span>
              <span class="muted">{k.checks === 0 ? 'no checks' : `${k.checks} ${k.checks === 1 ? 'check' : 'checks'}`}</span>
            </label>
          {/each}
        </fieldset>
      {/if}

      {#if gate && gate.kind !== 'chart'}
        <div class="gate" role="status">
          <p>{gate.text}</p>
          {#if gate.kind === 'missing' && gate.action === 'analytics' && analyticsHref}<Button size="sm" href={analyticsHref}>Open Analytics</Button>{/if}
          {#if gate.kind === 'missing' && gate.action === 'keywords' && keywordsHref}<Button size="sm" href={keywordsHref}>Track keywords</Button>{/if}
        </div>
      {:else if gate && rank}
        <div class="plots" class:loading bind:clientWidth={width} bind:this={plotsEl}>
          <ul class="legend" aria-label="Keywords">
            {#each rank.lines as l (l.id)}
              <li>
                <svg width="26" height="8" aria-hidden="true"><line x1="0" y1="4" x2="26" y2="4" class="swatch" stroke-dasharray={dashes[l.pattern]} /></svg>
                <span>{l.term}</span>
              </li>
            {/each}
            <li><svg width="12" height="12" aria-hidden="true"><path d="M6,1L11,10L1,10Z" class="mk" /></svg><span>better rank</span></li>
            <li><svg width="12" height="12" aria-hidden="true"><path d="M6,11L11,2L1,2Z" class="mk" /></svg><span>worse rank</span></li>
          </ul>

          <h4>Rank <span class="muted">(1 is the top)</span></h4>
          <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
          <svg
            viewBox="0 0 {width} {rank.box.height}"
            {width}
            height={rank.box.height}
            role="img"
            aria-label={chartName(view)}
            aria-describedby="{uid}-live"
            tabindex="0"
            onpointermove={at}
            onpointerleave={() => (hover = null)}
            onfocus={() => (hover = hover ?? view!.days.length - 1)}
            onblur={() => (hover = null)}
            {onkeydown}
          >
            <defs>
              <pattern id="{uid}-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" class="hatch" /></pattern>
            </defs>
            {#each noCheckBands as b (b.from)}
              <rect x={b.x} y={rank.box.top} width={b.w} height={rank.plotH} fill="url(#{uid}-hatch)"><title>No rank check on these days</title></rect>
            {/each}
            {#each rank.ticks as t (t.label)}
              <line class="grid" x1={rank.box.left} x2={width - rank.box.right} y1={t.y} y2={t.y} />
              <text class="ytick" x={rank.box.left - 8} y={t.y + 4} text-anchor="end">{t.label}</text>
            {/each}
            {#if hover !== null}<line class="cross" x1={rank.xCenter(hover)} x2={rank.xCenter(hover)} y1={rank.box.top} y2={rank.box.top + rank.plotH} />{/if}
            {#each rank.lines as l (l.id)}
              {#each l.runs as run, r (r)}
                {#if run.points.length > 1}
                  <path d={run.d} class="line" stroke-dasharray={dashes[l.pattern]} />
                {:else if run.points[0]}
                  <circle class="dot" cx={run.points[0].x} cy={run.points[0].y} r="3.5" />
                {/if}
              {/each}
              {#if l.last}<circle class="dot" cx={l.last.x} cy={l.last.y} r="3.5" />{/if}
            {/each}
            {#each rank.markers as m (`${m.keywordId}-${m.day}`)}
              <path d={trianglePath(m)} class="mk"><title>{m.text}</title></path>
            {/each}
          </svg>

          <h4>{downloadsName(view)} <span class="muted">per day</span></h4>
          {#if dl}
            <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
            <svg viewBox="0 0 {width} {dl.box.height}" {width} height={dl.box.height} role="img" aria-label="{downloadsName(view)} per day, in the same days as the rank above" tabindex="0" onpointermove={at} onpointerleave={() => (hover = null)} {onkeydown}>
              {#if dl.provisional}<rect class="wash" x={dl.provisional.x} y={dl.box.top} width={dl.provisional.w} height={dl.plotH}><title>The store may still change these days</title></rect>{/if}
              {#each dl.missing as b (b.from)}
                <rect x={b.x} y={dl.box.top} width={b.w} height={dl.plotH} fill="url(#{uid}-hatch)"><title>No download number on these days</title></rect>
              {/each}
              {#each dl.ticks as t (t.value)}
                <line class="grid" x1={dl.box.left} x2={width - dl.box.right} y1={t.y} y2={t.y} />
                <text class="ytick" x={dl.box.left - 8} y={t.y + 4} text-anchor="end">{t.value}</text>
              {/each}
              <line class="axis" x1={dl.box.left} x2={width - dl.box.right} y1={dl.baseline} y2={dl.baseline} />
              {#if hover !== null}<rect class="lift" x={dl.box.left + hover * dl.slot} y={dl.box.top} width={dl.slot} height={dl.plotH} />{/if}
              {#each dl.bars as bar (bar.i)}<path d={bar.d} class="bar" />{/each}
              {#each xTicks as i, k (i)}
                <text class="xtick" x={dl.xCenter(i)} y={dl.box.height - 6} text-anchor={k === 0 && xTicks.length > 1 ? 'start' : k === xTicks.length - 1 && xTicks.length > 1 ? 'end' : 'middle'}>{formatDay(view.days[i] ?? '')}</text>
              {/each}
            </svg>
          {/if}

          {#if tip}
            <div class="tip" aria-hidden="true" use:floating={{ anchor: tipAnchor, align: flip ? 'end' : 'start', gap: 0 }}>
              <div class="tip-date">{tip.heading}</div>
              {#each tip.ranks as r (r.id)}<div class="tip-row"><strong class="num">{r.text}</strong><span class="muted">{r.term}</span></div>{/each}
              <div class="tip-row"><strong class="num">{tip.downloads}</strong><span class="muted">{view.downloads ? view.downloads.label.toLowerCase() : 'downloads'}</span></div>
              {#if tip.provisional}<div class="tip-note">The store may still change this day.</div>{/if}
            </div>
          {/if}
          <div class="visually-hidden" id="{uid}-live" aria-live="polite">{tip ? `${tip.heading}. ${tip.ranks.map((r) => `${r.term}: ${r.text}`).join('. ')}. Downloads: ${tip.downloads}.` : ''}</div>
        </div>

        {#if view.markers.length > 0}
          <div class="changes stack">
            <h4 class="what">What changed after a big rank move <Badge tone="info">Correlation, not proof</Badge></h4>
            <ul class="moves">
              {#each changed as c, i (`${c.keywordId}-${i}`)}
                <li>
                  <strong>{c.head}.</strong>
                  <span>{c.detail}</span>
                  <span class="muted label">{c.label}</span>
                  {#if c.overlap}<span class="muted">{c.overlap}</span>{/if}
                  {#if c.gap}<span class="muted">{c.gap}</span>{/if}
                </li>
              {/each}
            </ul>
          </div>
        {:else}
          <p class="muted quiet">No rank move of {view.threshold} places or more in this period, so there is nothing to compare.</p>
        {/if}
      {/if}
    {/if}
  </section>
</VizScope>

<style>
  .controls {
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
  }

  .controls select {
    width: auto;
  }

  .picks {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-4);
    padding: 0;
    margin: 0;
    border: 0;
  }

  .picks legend {
    padding: 0;
    margin-bottom: var(--space-1);
    font-size: var(--text-sm);
  }

  .pick {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
    font-size: var(--text-sm);
  }

  .pick.off {
    color: var(--muted);
  }

  .gate p {
    margin: 0 0 var(--space-2);
  }

  .plots {
    position: relative;
    min-width: 0;
  }

  .plots.loading {
    opacity: 0.6;
  }

  h4 {
    margin: var(--space-3) 0 var(--space-1);
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-4);
    padding: 0;
    margin: 0;
    font-size: var(--text-sm);
    color: var(--muted);
    list-style: none;
  }

  .legend li,
  .tip-row {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
  }

  .swatch {
    stroke: var(--viz-1);
    stroke-width: 2;
  }

  svg {
    display: block;
    max-width: 100%;
    overflow: visible;
    touch-action: pan-y;
  }

  svg:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .grid {
    stroke: var(--viz-grid);
    stroke-width: 1;
  }

  .axis,
  .cross {
    stroke: var(--viz-axis);
    stroke-width: 1;
  }

  .hatch {
    stroke: var(--viz-hatch);
    stroke-width: 1.5;
    opacity: 0.7;
  }

  .wash {
    fill: var(--viz-wash);
  }

  .lift {
    fill: var(--surface-hover);
  }

  .ytick,
  .xtick {
    font-size: var(--text-sm);
    fill: var(--faint);
    font-variant-numeric: tabular-nums;
  }

  .line {
    fill: none;
    stroke: var(--viz-1);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .dot {
    fill: var(--viz-1);
    stroke: var(--surface);
    stroke-width: 2;
  }

  .mk {
    fill: var(--ink);
    stroke: var(--surface);
    stroke-width: 1.5;
    stroke-linejoin: round;
  }

  .bar {
    fill: var(--viz-2);
  }

  /* In the top layer and placed by the floating action: nothing around the chart can clip it. */
  .tip {
    width: max-content;
    max-width: 18rem;
    color: var(--ink);
    padding: var(--space-2) var(--space-3);
    pointer-events: none;
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-md);
    font-size: var(--text-sm);
  }

  .tip-date {
    margin-bottom: var(--space-1);
    font-weight: var(--weight-semibold);
  }

  .tip-note {
    margin-top: var(--space-1);
    color: var(--muted);
  }

  .what {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .moves {
    display: grid;
    gap: var(--space-3);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .moves li {
    display: grid;
    gap: var(--space-1);
    font-size: var(--text-sm);
  }

  .label {
    font-size: var(--text-sm);
  }

  .quiet {
    margin: 0;
    font-size: var(--text-sm);
  }

  .plain {
    padding-left: var(--space-4);
    margin: 0;
    font-size: var(--text-sm);
  }
</style>
