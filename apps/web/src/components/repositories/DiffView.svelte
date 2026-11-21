<!--
  DiffView: a line diff of one file.
  Props: before? and after? (the two texts; a missing side is an empty file), path (names the file
  for assistive technology). Unchanged runs of more than a few lines are folded behind a button.
  Added and removed lines carry a "+" or "-" and hidden text, so color is never the only cue.
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
  import { collapseDiff, diffLines, differsOnlyInLineEnds } from '../../lib/repositories.ts';

  let { before, after, path }: { before?: string | undefined; after?: string | undefined; path: string } = $props();

  const rows = $derived(diffLines(before, after));
  const blocks = $derived(collapseDiff(rows));
  const lineEndsOnly = $derived(differsOnlyInLineEnds(before, after));
  let expanded = $state<Record<number, boolean>>({});
</script>

{#if rows.length === 0}
  <p class="empty muted">{t('repositories:diff.empty')}</p>
{:else}
  <!-- A long diff scrolls sideways; keyboard users need to focus it to scroll it. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="diff" role="region" aria-label={t('repositories:diff.regionAria', { path })} tabindex="0">
    <table>
      <caption class="visually-hidden">{t('repositories:diff.caption', { path })}</caption>
      <thead class="visually-hidden">
        <tr>
          <th scope="col">{t('repositories:diff.oldLine')}</th>
          <th scope="col">{t('repositories:diff.newLine')}</th>
          <th scope="col">{t('repositories:diff.change')}</th>
          <th scope="col">{t('repositories:diff.text')}</th>
        </tr>
      </thead>
      <tbody>
        {#each blocks as block, index (index)}
          {#if block.type === 'collapsed' && !expanded[index]}
            <tr class="fold">
              <td colspan="4">
                <button type="button" class="link" onclick={() => (expanded[index] = true)}>
                  {t('repositories:diff.showUnchanged', { count: block.rows.length })}
                </button>
              </td>
            </tr>
          {:else}
            {#each block.rows as row, at (at)}
              <tr class={row.kind}>
                <td class="no">{row.oldNo ?? ''}</td>
                <td class="no">{row.newNo ?? ''}</td>
                <td class="sign">
                  {#if row.kind === 'add'}<span aria-hidden="true">+</span><span class="visually-hidden">{t('repositories:diff.added')}</span>
                  {:else if row.kind === 'del'}<span aria-hidden="true">-</span><span class="visually-hidden">{t('repositories:diff.removed')}</span>
                  {:else}<span class="visually-hidden">{t('repositories:diff.unchanged')}</span>{/if}
                </td>
                <td class="text">{row.text === '' ? ' ' : row.text}</td>
              </tr>
            {/each}
          {/if}
        {/each}
      </tbody>
    </table>
  </div>
  {#if lineEndsOnly}
    <p class="hint">{t('repositories:diff.lineEndsOnly')}</p>
  {/if}
{/if}

<style>
  .empty {
    padding: var(--space-3) var(--space-4);
    margin: 0;
  }

  .diff {
    overflow: auto;
    background: var(--surface);
    border-top: 1px solid var(--line);
  }

  table {
    width: 100%;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    line-height: var(--leading-snug);
    border-collapse: collapse;
  }

  td {
    padding: 0 var(--space-2);
    vertical-align: top;
    border: 0;
  }

  tbody tr:hover {
    background: none;
  }

  .no {
    width: 1%;
    min-width: var(--space-10);
    padding-right: var(--space-2);
    color: var(--muted);
    text-align: right;
    user-select: none;
    background: var(--surface-sunken);
  }

  .sign {
    width: 1%;
    padding: 0 var(--space-1);
    text-align: center;
    user-select: none;
  }

  .text {
    width: 100%;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  tr.add td:not(.no) {
    color: var(--ok-ink);
    background: var(--ok-bg);
  }

  tr.del td:not(.no) {
    color: var(--bad-ink);
    background: var(--bad-bg);
  }

  tr.fold td {
    padding: var(--space-1) var(--space-3);
    font-family: var(--font-sans);
    background: var(--surface-sunken);
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
  }

  .diff:focus-visible {
    outline-offset: -2px;
  }
</style>
