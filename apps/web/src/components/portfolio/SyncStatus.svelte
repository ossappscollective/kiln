<!--
  SyncStatus: when an app was last synced and, if the last attempt failed, why.
  Props: app, now (epoch ms, so relative times update), compact = false (a table cell: only the relative time, muted, small, on one
  line, with the exact time in the tooltip; "Never synced" when there is none). The error shows two lines at most; the
  full text is in the tooltip and on the app's own screen.
  A failed attempt keeps the time of the last good sync, because the releases shown are from it.
-->
<script lang="ts">
  import T from '../ui/T.svelte';
  import { t } from '../../lib/i18n/t.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import { syncInfo } from '../../lib/portfolio.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Icon from '../ui/Icon.svelte';

  let { app, now, compact = false }: { app: AppSummary; now: number; compact?: boolean | undefined } = $props();

  const info = $derived(syncInfo(app, now));
</script>

<div class="sync" class:compact>
  {#if app.lastSyncedAt !== null}
    <time class:quiet={compact} datetime={new Date(app.lastSyncedAt).toISOString()} title={fullTime(app.lastSyncedAt)}>{compact ? timeAgo(app.lastSyncedAt, now) : info.label}</time>
  {:else}
    <span class="muted">{info.label}</span>
  {/if}
  {#if info.error}
    <p class="error" title={info.error}>
      <Icon name="alert" size={14} />
      <span><T key="portfolio:sync.failed" params={{ error: info.error }} /></span>
    </p>
    {#if info.attempt}<p class="attempt muted">{info.attempt}</p>{/if}
  {/if}
</div>

<style>
  .sync {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }

  .compact {
    font-size: var(--text-sm);
    white-space: nowrap;
  }

  .quiet {
    color: var(--muted);
  }

  .error {
    display: flex;
    gap: var(--space-1);
    align-items: flex-start;
    margin: 0;
    font-size: var(--text-sm);
    color: var(--bad-ink);
  }

  .error :global(.icon) {
    margin-top: 2px;
  }

  .error span {
    display: -webkit-box;
    overflow: hidden;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .attempt {
    margin: 0;
    font-size: var(--text-xs);
  }
</style>
