<!--
  DataTable: the table twin of a chart ("Show data"): a row per day and a column per series, the exact numbers, and "No data"
  where the store gave none (never a zero). It is the way to read every value without the pointer.
  Props: model (DataTableModel from lib/analytics-view.ts), caption.
-->
<script lang="ts">
  import type { DataTableModel } from '../../lib/analytics/view.ts';

  let { model, caption }: { model: DataTableModel; caption: string } = $props();
</script>

<div class="table-wrap">
  <table class="compact sticky">
    <caption class="visually-hidden">{caption}</caption>
    <thead>
      <tr>
        {#each model.columns as column, i (column)}
          <th scope="col" class:num={i > 0}>{column}</th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each model.rows as row (row.date)}
        <tr>
          <th scope="row">{row.date}</th>
          {#each row.cells as cell, i (i)}
            <td class="num" class:muted={cell === 'No data'}>{cell}</td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .table-wrap {
    max-height: 16rem;
    overflow: auto;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  tbody th {
    font-weight: var(--weight-regular);
    text-align: left;
    white-space: nowrap;
  }
</style>
