<!--
  CompareTable: the headline figures of two or more platforms as ONE compact table, a row per measure and a column per platform, instead of two
  long runs of tiles. A figure a platform does not have is a dash (with "No data" for a screen reader). Each figure carries its change against the
  previous period in words, an arrow and a sign (colour only says whether the direction is good), like StatRow. Apple downloads and Google installs
  are never added together: each column is its own platform.
  Props: columns ({ id, platform }[]), rows (CompareRow[], lib/analytics/insights-view.ts), days (the length of the period, for the sentence).
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
  import type { CompareRow } from '../../lib/analytics/insights-view.ts';
  import Icon from '../ui/Icon.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';

  let { columns, rows, days }: { columns: { id: string; platform: string }[]; rows: CompareRow[]; days: number } = $props();
</script>

<div class="wrap">
  <table aria-label={t('analytics:stat.label')}>
    <thead>
      <tr>
        <th scope="col">{t('analytics:overview.measure')}</th>
        {#each columns as c (c.id)}
          <th scope="col"><PlatformBadge platform={c.platform as never} tinted /></th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each rows as row (row.id)}
        <tr>
          <th scope="row" title={row.title}>{row.label}</th>
          {#each row.cells as cell, i (columns[i]?.id ?? i)}
            <td>
              {#if cell}
                <span class="v tabular">{cell.value}</span>
                {#if cell.line}
                  <span class="delta {cell.tone}" aria-label={cell.spoken}>
                    {#if cell.delta.kind === 'change'}<Icon name={cell.delta.direction === 'up' ? 'arrow-up' : 'arrow-down'} size={12} />{/if}
                    <span aria-hidden="true">{cell.line}</span>
                  </span>
                {/if}
              {:else}
                <span class="none" aria-hidden="true">–</span><span class="visually-hidden">{t('analytics:overview.noValue')}</span>
              {/if}
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
  <span class="visually-hidden">{t('analytics:stat.compared', { count: days })}</span>
</div>

<style>
  .wrap {
    overflow-x: auto;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-card);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }

  th,
  td {
    padding: var(--space-2) var(--space-4);
    text-align: left;
    vertical-align: baseline;
  }

  thead th {
    font-weight: var(--weight-semibold);
    border-bottom: 1px solid var(--line);
  }

  tbody tr + tr > * {
    border-top: 1px solid var(--line);
  }

  tbody th {
    font-weight: var(--weight-medium);
    color: var(--muted);
  }

  .v {
    margin-right: var(--space-2);
    font-family: var(--font-display);
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
  }

  .delta {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
    color: var(--muted);
  }

  .delta.ok {
    color: var(--ok-ink);
  }

  .delta.bad {
    color: var(--bad-ink);
  }

  .none {
    color: var(--muted);
  }
</style>
