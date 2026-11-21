<!--
  BarList: a ranked list of horizontal bars, one per app version, largest first: the name, a thin bar and the value. One color,
  because the bars are one measure of nameless-order categories (no color per version). Counts are not rates and are never
  mixed: the list has one unit. The value is exact in the title and in the text.
  Props: bars ({ id, title, unit, items }). Values of 0 or less draw no bar but are still listed.
-->
<script lang="ts">
  import { formatExact, formatValue } from '../../lib/analytics/analytics.ts';
  import { t } from '../../lib/i18n/t.ts';
  import type { VersionBars } from '../../lib/analytics/view.ts';

  let { bars }: { bars: VersionBars } = $props();

  const top = $derived(Math.max(0, ...bars.items.map((i) => i.total)));
</script>

<div class="bars">
  <h4>{bars.title}</h4>
  <ul>
    {#each bars.items as item (item.value)}
      <li title={t('analytics:bars.itemTitle', { name: item.value, value: formatExact(bars.unit, item.total) })}>
        <span class="name">{item.value}</span>
        <span class="track" aria-hidden="true"><span class="fill" style:width="{top > 0 ? Math.max(0, (item.total / top) * 100) : 0}%"></span></span>
        <span class="value num">{formatValue(bars.unit, item.total)}</span>
      </li>
    {/each}
  </ul>
</div>

<style>
  .bars {
    padding-top: var(--space-3);
    border-top: 1px solid var(--line);
  }

  h4 {
    margin: 0 0 var(--space-2);
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
  }

  ul {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  li {
    display: grid;
    grid-template-columns: minmax(4rem, 9rem) minmax(0, 1fr) 4.5rem;
    gap: var(--space-3);
    align-items: center;
    font-size: var(--text-sm);
  }

  .name {
    overflow: hidden;
    color: var(--muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .track {
    display: block;
    height: 8px;
  }

  .fill {
    display: block;
    height: 8px;
    min-width: 0;
    background: var(--viz-1);
    border-radius: 0 4px 4px 0;
  }

  .value {
    font-weight: var(--weight-semibold);
    text-align: right;
  }

  @media (forced-colors: active) {
    .fill {
      background: CanvasText;
    }
  }
</style>
