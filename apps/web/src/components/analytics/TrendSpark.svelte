<!--
  TrendSpark: a small line of one series for a figure (the dashboard strip). Days with no value break the line, they are never
  drawn as zero; the newest value is marked with a dot. The axis follows the data, so it shows the shape only: the figure
  beside it carries the number. The accessible name says what it is and its newest and extreme values.
  Props: points ((number | null)[]), label (the accessible name), width = 96, height = 28.
-->
<script lang="ts">
  import { presentRuns } from '../../lib/analytics/analytics.ts';
  import { t } from '../../lib/i18n/t.ts';

  let { points, label, width = 96, height = 28 }: { points: (number | null)[]; label: string; width?: number | undefined; height?: number | undefined } = $props();

  const pad = 5;
  const values = $derived(points.filter((v): v is number => v !== null));
  const lo = $derived(values.length ? Math.min(...values) : 0);
  const hi = $derived(values.length ? Math.max(...values) : 1);
  const span = $derived(hi > lo ? hi - lo : 1);
  const x = (i: number) => pad + (points.length > 1 ? (i * (width - pad * 2)) / (points.length - 1) : (width - pad * 2) / 2);
  const y = (v: number) => (hi > lo ? pad + (height - pad * 2) * (1 - (v - lo) / span) : height / 2);
  const runs = $derived(presentRuns(points));
  const last = $derived.by(() => {
    for (let i = points.length - 1; i >= 0; i -= 1) {
      const v = points[i];
      if (v !== null && v !== undefined) return { x: x(i), y: y(v) };
    }
    return null;
  });
  const paths = $derived(
    runs
      .filter((r) => r.end > r.start)
      .map((r) => {
        let d = '';
        for (let i = r.start; i <= r.end; i += 1) d += `${i === r.start ? 'M' : 'L'}${Math.round(x(i) * 10) / 10},${Math.round(y(points[i] as number) * 10) / 10}`;
        return d;
      }),
  );
  const lone = $derived(runs.filter((r) => r.end === r.start).map((r) => ({ x: x(r.start), y: y(points[r.start] as number) })));
</script>

{#if values.length === 0}
  <span class="none muted" title={t('analytics:tip.noData')}>–</span>
{:else}
  <svg viewBox="0 0 {width} {height}" {width} {height} role="img" aria-label={label}>
    <title>{label}</title>
    {#each paths as d (d)}<path {d} />{/each}
    {#each lone as p (p.x)}<circle class="mark" cx={p.x} cy={p.y} r="4" />{/each}
    {#if last}<circle class="mark" cx={last.x} cy={last.y} r="4" />{/if}
  </svg>
{/if}

<style>
  svg {
    display: block;
    overflow: visible;
  }

  path {
    fill: none;
    stroke: var(--muted);
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 2;
  }

  .mark {
    fill: var(--viz-1, var(--accent));
    stroke: var(--surface);
    stroke-width: 2;
  }

  @media (forced-colors: active) {
    path {
      stroke: CanvasText;
    }

    .mark {
      fill: CanvasText;
    }
  }
</style>
