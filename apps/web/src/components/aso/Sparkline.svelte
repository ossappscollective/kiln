<!--
  Sparkline: a tiny inline line chart of a rank history, drawn by hand (no chart library). Rank 1 is at the
  top; "not ranked" sits at the bottom. The last point is marked. The text in `label` is the accessible name
  and the hover title ("14 checks, best 3, latest 12"), so the numbers are not only in the shape.
  Props: checks (oldest first), label, width = 72, height = 20.
-->
<script lang="ts">
  import { type AsoCheck, sparkline } from '../../lib/aso/aso.ts';
  import { t } from '../../lib/i18n/t.ts';

  let { checks, label, width = 72, height = 20 }: { checks: Pick<AsoCheck, 'rank' | 'total'>[]; label: string; width?: number | undefined; height?: number | undefined } = $props();

  const spark = $derived(sparkline(checks, width, height));
</script>

{#if spark.samples === 0}
  <span class="none muted" title={t('aso:spark.noHistory')}>–</span>
{:else}
  <svg viewBox="0 0 {spark.width} {spark.height}" {width} {height} role="img" aria-label={label}>
    <title>{label}</title>
    {#if spark.samples > 1}<path d={spark.path} />{/if}
    {#if spark.last}<circle cx={spark.last.x} cy={spark.last.y} r="2" />{/if}
  </svg>
{/if}

<style>
  svg {
    display: block;
    color: var(--muted);
  }

  path {
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.5;
  }

  circle {
    fill: var(--viz-1, var(--accent));
  }
</style>
