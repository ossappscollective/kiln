<!--
  Chart: one panel of a chart card, drawn by hand as SVG (no chart library): a line, columns, or stacked columns of one or two
  series on one axis (never a second axis). Days with no value are a hatched band, never a zero, and a line breaks at a gap.
  Days the store may still change are shaded. A crosshair or a lifted column follows the pointer and the arrow keys, and one
  tooltip lists every series at that day with its exact number; the same words go to a screen reader through a live region.
  The tooltip never gates a value: the end of each line is labelled, and the "Show data" table has every number.
  Props: panel (ChartPanel), cardTitle, dates (one per position), today (UTC day), hover (bindable index or null, shared by the
  panels of a card so their crosshairs move together), height = 168 (the plot and the date axis together).
  A line of a single series is drawn with the brand gradient (--viz-1, --viz-mid, --viz-end), a blurred copy of it as glow, and a fading
  area under it; with two series each line keeps its own solid color. The geometry is lib/analytics-chart.ts; the words are
  lib/analytics-view.ts. Colors come from the --viz-* tokens (styles/theme.css; see VizScope).
-->
<script lang="ts">
  import { formatDay, formatValue } from '../../lib/analytics/analytics.ts';
  import { floating } from '../../lib/floating.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { pointAnchor } from '../../lib/virtual-anchor.ts';
  import { indexAt, labelsCollide, plot, provisionalIndex, xTickIndexes } from '../../lib/analytics/chart.ts';
  import { type ChartPanel, describePanel, tooltipFor } from '../../lib/analytics/view.ts';

  let {
    panel,
    cardTitle,
    dates,
    today,
    hover = $bindable(null),
    height = 168,
  }: { panel: ChartPanel; cardTitle: string; dates: string[]; today: string; hover?: number | null | undefined; height?: number | undefined } = $props();

  const uid = $props.id();
  let width = $state(640);
  let svg = $state<SVGSVGElement | null>(null);

  const plotSeries = $derived(panel.series.map((ps) => ({ key: ps.key, color: ps.color, values: ps.series.points.map((p) => p.value) })));
  const bounds = $derived<[number, number] | undefined>(panel.unit === 'rating' ? [1, 5] : undefined);
  const delay = $derived(Math.max(...panel.series.map((ps) => ps.series.delayDays)));
  const provisional = $derived(provisionalIndex(dates, today, delay));

  // The axis labels set the left margin: a first pass at a fixed size only to know the tick values.
  const label = (v: number) => formatValue(panel.unit, v, panel.currency);
  const left = $derived(
    10 +
      7 *
        Math.max(
          ...plot({
            box: { width: 400, height, left: 0, right: 0, top: 12, bottom: 24 },
            count: dates.length,
            kind: panel.kind,
            series: plotSeries,
            domain: panel.domain,
            ...(bounds ? { bounds } : {}),
          }).ticks.map((t) => label(t.value).length),
        ),
  );
  const box = $derived({ width, height, left, right: 14, top: 12, bottom: 24 });
  const geo = $derived(
    plot({
      box,
      count: dates.length,
      kind: panel.kind,
      series: plotSeries,
      domain: panel.domain,
      ...(bounds ? { bounds } : {}),
      ...(provisional >= 0 ? { provisionalFrom: provisional } : {}),
    }),
  );
  const xTicks = $derived(xTickIndexes(dates.length, Math.max(2, Math.floor(geo.plotW / 76))));
  const tip = $derived(hover === null ? null : tooltipFor(panel, hover, today));
  const tipLeft = $derived(hover === null ? 0 : geo.xCenter(hover));
  const flip = $derived(tipLeft > width * 0.58);
  /** The tip hangs on a point beside the crosshair and is drawn in the top layer (lib/floating.ts), so no card can clip it. */
  const tipAnchor = $derived(tip && svg ? pointAnchor(svg, tipLeft + (flip ? -12 : 12), 8) : null);
  const name = $derived(describePanel(panel, cardTitle));
  const spoken = $derived(tip ? `${tip.heading}. ${tip.rows.map((r) => `${r.label}: ${r.text}`).join('. ')}${tip.provisional ? '. May still change.' : ''}` : '');
  const isLine = $derived(panel.kind === 'line');
  /** One line gets the gradient, the glow and the area; two lines stay solid so the legend can tell them apart. */
  const fancy = $derived(isLine && panel.series.length === 1);
  const areaPath = (run: { d: string; points: { x: number }[] }) => {
    const first = run.points[0];
    const last = run.points[run.points.length - 1];
    return first && last ? `${run.d}L${last.x},${geo.baseline}L${first.x},${geo.baseline}Z` : '';
  };

  // End labels of lines: the newest value, left of the end dot, and a second one only when it would not overlap.
  const endLabels = $derived.by(() => {
    const out: { key: string; x: number; y: number; text: string }[] = [];
    for (const line of geo.lines) {
      if (!line.last) continue;
      const y = line.last.y - 9 < geo.box.top + 4 ? line.last.y + 16 : line.last.y - 9;
      if (out.some((o) => labelsCollide(o.y, y))) continue;
      out.push({ key: line.key, x: Math.min(line.last.x, geo.box.width - geo.box.right), y, text: label(line.last.value) });
    }
    return out;
  });

  function at(event: PointerEvent): number | null {
    if (!svg) return null;
    return indexAt(geo, event.clientX - svg.getBoundingClientRect().left);
  }

  function lastWithData(): number {
    for (let i = dates.length - 1; i >= 0; i -= 1) {
      if (panel.series.some((ps) => ps.series.points[i]?.value !== null && ps.series.points[i]?.value !== undefined)) return i;
    }
    return Math.max(0, dates.length - 1);
  }

  function onkeydown(event: KeyboardEvent) {
    const last = dates.length - 1;
    const now = hover ?? lastWithData();
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = Math.max(0, now - 1);
    else if (event.key === 'ArrowRight') next = Math.min(last, now + 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    else if (event.key === 'Escape' && hover !== null) {
      hover = null;
      event.stopPropagation();
      return;
    }
    if (next === null) return;
    event.preventDefault();
    hover = next;
  }

  const gapTitle = (from: number, to: number) =>
    from === to ? `No data for ${formatDay(dates[from] ?? '')}` : `No data from ${formatDay(dates[from] ?? '')} to ${formatDay(dates[to] ?? '')}`;
</script>

<div class="panel">
  {#if panel.title || panel.series.length > 1}
    <div class="head">
      {#if panel.title}<h4>{panel.title}</h4>{/if}
      {#if panel.series.length > 1}
        <ul class="legend" aria-label={t('analytics:chart.series')}>
          {#each panel.series as ps (ps.key)}
            <li>
              <span class="key s{ps.color}" class:col={!isLine} aria-hidden="true"></span>
              <span>{ps.label}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}

  <div class="plot" bind:clientWidth={width}>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <svg
      bind:this={svg}
      viewBox="0 0 {width} {height}"
      {width}
      {height}
      role="img"
      aria-label={name}
      aria-describedby="{uid}-live"
      tabindex="0"
      onpointermove={(e) => (hover = at(e))}
      onpointerleave={() => (hover = null)}
      onfocus={() => (hover = hover ?? lastWithData())}
      onblur={() => (hover = null)}
      {onkeydown}
    >
      <defs>
        <pattern id="{uid}-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" class="hatch" />
        </pattern>
        {#if fancy}
          <linearGradient id="{uid}-line" gradientUnits="userSpaceOnUse" x1={geo.box.left} x2={Math.max(geo.box.left + 1, geo.box.width - geo.box.right)} y1="0" y2="0">
            <stop offset="0" class="stop-a" />
            <stop offset="0.55" class="stop-b" />
            <stop offset="1" class="stop-c" />
          </linearGradient>
          <linearGradient id="{uid}-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" class="stop-area" />
            <stop offset="1" class="stop-area end" />
          </linearGradient>
          <filter id="{uid}-glow" filterUnits="userSpaceOnUse" x="-16" y="-16" width={width + 32} height={height + 32}>
            <feGaussianBlur stdDeviation="4" />
          </filter>
        {/if}
      </defs>

      {#if geo.provisional}
        <rect class="wash" x={geo.provisional.x} y={geo.box.top} width={geo.provisional.w} height={geo.plotH} />
      {/if}
      {#each geo.missing as band (band.from)}
        <rect x={band.x} y={geo.box.top} width={band.w} height={geo.plotH} fill="url(#{uid}-hatch)"><title>{gapTitle(band.from, band.to)}</title></rect>
      {/each}

      {#each geo.ticks as t (t.value)}
        <line class="grid" x1={geo.box.left} x2={geo.box.width - geo.box.right} y1={t.y} y2={t.y} />
        <text class="ytick" x={geo.box.left - 8} y={t.y + 4} text-anchor="end">{label(t.value)}</text>
      {/each}
      <line class="axis" x1={geo.box.left} x2={geo.box.width - geo.box.right} y1={geo.baseline} y2={geo.baseline} />

      {#each xTicks as i, k (i)}
        <text class="xtick" x={geo.xCenter(i)} y={height - 6} text-anchor={k === 0 && xTicks.length > 1 ? 'start' : k === xTicks.length - 1 && xTicks.length > 1 ? 'end' : 'middle'}>{formatDay(dates[i] ?? '')}</text>
      {/each}

      {#if hover !== null}
        {#if isLine}
          <line class="cross" x1={geo.xCenter(hover)} x2={geo.xCenter(hover)} y1={geo.box.top} y2={geo.box.top + geo.plotH} />
        {:else}
          <rect class="lift" x={geo.box.left + hover * geo.slot} y={geo.box.top} width={geo.slot} height={geo.plotH} />
        {/if}
      {/if}

      {#each geo.bars as bar (`${bar.key}-${bar.i}`)}
        <path d={bar.d} class="bar s{bar.color}" class:hot={hover === bar.i} />
      {/each}

      {#each geo.lines as line (line.key)}
        {#each line.runs as run, r (r)}
          {#if run.points.length > 1}
            {#if fancy}
              <path d={areaPath(run)} class="area" fill="url(#{uid}-area)" />
              <path d={run.d} class="line glow" style="stroke: url(#{uid}-line)" filter="url(#{uid}-glow)" aria-hidden="true" />
            {/if}
            <path d={run.d} class="line s{line.color}" style={fancy ? `stroke: url(#${uid}-line)` : undefined} />
          {:else if run.points[0]}
            <circle class="dot s{line.color}" class:fancy cx={run.points[0].x} cy={run.points[0].y} r="4" />
          {/if}
        {/each}
        {#if line.last && hover === null}
          <circle class="dot s{line.color}" class:fancy cx={line.last.x} cy={line.last.y} r="4" />
        {/if}
      {/each}

      {#if hover !== null && isLine}
        {#each geo.lines as line (line.key)}
          {#each line.runs as run (run.d)}
            {#each run.points.filter((p) => p.i === hover) as p (p.i)}
              <circle class="dot s{line.color}" class:fancy cx={p.x} cy={p.y} r="4" />
            {/each}
          {/each}
        {/each}
      {/if}

      {#if hover === null}
        {#each endLabels as l (l.key)}
          <text class="endlabel" x={l.x} y={l.y} text-anchor="end">{l.text}</text>
        {/each}
      {/if}
    </svg>

    {#if tip}
      <div class="tip" aria-hidden="true" use:floating={{ anchor: tipAnchor, align: flip ? 'end' : 'start', gap: 0 }}>
        <div class="tip-body">
          <div class="tip-date">{tip.heading}</div>
          {#each tip.rows as row (row.key)}
            <div class="tip-row" class:none={row.missing}>
              {#if row.color !== 0}<span class="key s{row.color}" class:col={!isLine} aria-hidden="true"></span>{:else}<span class="key-gap" aria-hidden="true"></span>{/if}
              <strong class="num">{row.text}</strong>
              <span class="tip-label">{row.label}</span>
            </div>
          {/each}
          {#if tip.provisional}<div class="tip-note">{t('analytics:chart.provisional')}</div>{/if}
        </div>
      </div>
    {/if}
    <div class="visually-hidden" id="{uid}-live" aria-live="polite">{spoken}</div>
  </div>
</div>

<style>
  .panel {
    min-width: 0;
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-4);
    align-items: baseline;
    margin-bottom: var(--space-1);
  }

  h4 {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--ink);
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-4);
    padding: 0;
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
    list-style: none;
  }

  .legend li,
  .tip-row {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
  }

  /* A short stroke for a line, a small square for a column: the key follows the mark. */
  .key {
    display: inline-block;
    width: 14px;
    height: 2px;
    border-radius: 1px;
  }

  .key.col {
    width: 10px;
    height: 10px;
    border-radius: 2px;
  }

  .key-gap {
    display: inline-block;
    width: 14px;
  }

  .key.s1 {
    background: var(--viz-1);
  }

  .key.s2 {
    background: var(--viz-2);
  }

  .plot {
    position: relative;
    min-width: 0;
  }

  svg {
    display: block;
    max-width: 100%;
    overflow: visible;
    touch-action: pan-y;
    border-radius: var(--radius-sm);
  }

  svg:focus-visible {
    outline: var(--ring);
    outline-offset: 2px;
  }

  .grid {
    stroke: var(--viz-grid);
    stroke-width: 1;
  }

  .axis {
    stroke: var(--viz-axis);
    stroke-width: 1;
  }

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
    font-size: var(--text-xs);
    fill: var(--faint);
    font-variant-numeric: tabular-nums;
  }

  .endlabel {
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    fill: var(--ink);
    paint-order: stroke;
    stroke: var(--surface);
    stroke-width: 3px;
    stroke-linejoin: round;
  }

  .line {
    fill: none;
    stroke-width: var(--viz-line-width);
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* The gradient line: stops, the blurred glow copy and the area below it. All values are tokens. */
  .stop-a {
    stop-color: var(--viz-1);
  }

  .stop-b {
    stop-color: var(--viz-mid);
  }

  .stop-c {
    stop-color: var(--viz-end);
  }

  .stop-area {
    stop-color: var(--viz-mid);
    stop-opacity: var(--viz-area-opacity);
  }

  .stop-area.end {
    stop-opacity: 0;
  }

  .line.glow {
    stroke-width: calc(var(--viz-line-width) + var(--viz-glow-blur));
    opacity: var(--viz-glow-opacity);
    pointer-events: none;
  }

  .area {
    stroke: none;
    pointer-events: none;
  }

  .dot.s1.fancy {
    fill: var(--viz-mid);
  }

  .line.s1 {
    stroke: var(--viz-1);
  }

  .line.s2 {
    stroke: var(--viz-2);
  }

  /* A dot is the series color inside a 2px ring in the surface color, so it stays readable where it crosses a line. */
  .dot {
    stroke: var(--surface);
    stroke-width: 2;
  }

  .dot.s1 {
    fill: var(--viz-1);
  }

  .dot.s2 {
    fill: var(--viz-2);
  }

  .bar.s1 {
    fill: var(--viz-1);
  }

  .bar.s2 {
    fill: var(--viz-2);
  }

  .bar.hot {
    filter: brightness(1.15);
  }

  /* In the top layer and placed by the floating action: the card around the chart cannot clip it. */
  .tip {
    width: max-content;
    padding: var(--space-2) var(--space-3);
    color: var(--ink);
    pointer-events: none;
    font-size: var(--text-sm);
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-md);
  }

  .tip-body {
    min-width: 11rem;
    max-width: 18rem;
  }

  .tip-date {
    margin-bottom: var(--space-1);
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .tip-row {
    display: flex;
    width: 100%;
  }

  .tip-row strong {
    font-weight: var(--weight-semibold);
    color: var(--ink);
  }

  .tip-row.none strong {
    font-weight: var(--weight-regular);
    color: var(--muted);
  }

  .tip-label {
    color: var(--muted);
  }

  .tip-note {
    margin-top: var(--space-1);
    font-size: var(--text-xs);
    color: var(--muted);
  }

  @media (forced-colors: active) {
    .line.glow,
    .area {
      display: none;
    }

    .line.s1 {
      stroke: CanvasText !important;
    }

    .line.s2 {
      stroke: CanvasText;
      stroke-dasharray: 6 3;
    }

    .bar.s1,
    .dot.s1,
    .dot.s1.fancy {
      fill: CanvasText;
    }

    .bar.s2,
    .dot.s2 {
      fill: GrayText;
    }

    .key.s1,
    .key.s2 {
      background: CanvasText;
    }
  }
</style>
