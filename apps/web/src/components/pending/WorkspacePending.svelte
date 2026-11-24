<!--
  WorkspacePending: the workspace-level overview of everything pending (docs/ux-ia.md "Pending changes across the workspace", ADR 0064).
  One row per app (the records of one product together) with its number of pending changes and what kinds they are, from
  GET /pending/cart-summary (counts only, stored state). "Open cart" goes to the app and opens ITS cart drawer (the one place to review, publish
  or discard); nothing is published or discarded from here, and nothing across apps.
  Props: api, workspaceId, role (the view contract).
-->
<script lang="ts">
  import type { Role } from '@kiln/core';
  import { onMount } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { appAddress } from '../../lib/app-scope.ts';
  import { KIND_LABEL, pendingAcrossText, pendingRows, pendingTotals } from '../../lib/cart-summary.ts';
  import { cartSummaryStore } from '../../lib/cart-summary.svelte.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { navSignals } from '../../lib/nav-signals.svelte.ts';
  import { queueCartOpen } from '../../lib/pending-cart.ts';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import PageHeader from '../ui/PageHeader.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import Skeleton from '../ui/Skeleton.svelte';

  let { api, workspaceId }: { api: Api; workspaceId: string; role: Role } = $props();

  const summary = $derived(cartSummaryStore.summaryOf(workspaceId));
  const rows = $derived(pendingRows(summary, navSignals.appsOf(workspaceId)));
  const totals = $derived(pendingTotals(rows, summary));
  let failed = $state(false);

  async function read() {
    failed = false;
    await cartSummaryStore.refresh(api, workspaceId);
    failed = cartSummaryStore.summaryOf(workspaceId) === null;
  }

  onMount(() => {
    void navSignals.ensureApps(api, workspaceId);
  });
  // The page always shows what the server holds now (the badge may be up to half a minute old).
  $effect(() => {
    void workspaceId;
    void read();
  });
</script>

<PageHeader title={t('app:workspacePending.title')} description={t('app:workspacePending.lead')} />

{#if summary === null && !failed}
  <div role="status" aria-label={t('app:workspacePending.loading')}><Skeleton width="100%" height="72px" /></div>
{:else if summary === null}
  <EmptyState icon="alert-triangle" title={t('app:workspacePending.loadFailed')}>
    {#snippet actions()}<Button onclick={() => void read()}>{t('common:action.retry')}</Button>{/snippet}
  </EmptyState>
{:else if rows.length === 0}
  <EmptyState icon="check" title={t('app:workspacePending.empty')} />
{:else}
  {#if totals}<p class="total" role="status">{pendingAcrossText(totals)}</p>{/if}
  <ul class="rows" aria-label={t('app:workspacePending.listLabel')}>
    {#each rows as row (row.key)}
      <li>
        <div class="what">
          <strong>{row.name}</strong>
          <span class="platforms">{#each row.platforms as p (p)}<PlatformBadge platform={p} showLabel={false} />{/each}</span>
          <span class="muted kinds">{row.kinds.map((x) => `${t(KIND_LABEL[x.kind])} ${x.count}`).join(' · ')}</span>
        </div>
        <span class="count">{t('shell:badge.pendingChanges', { count: row.count })}</span>
        <Button size="sm" icon="upload" label={t('app:workspacePending.openLabel', { name: row.name })} href={appAddress(row.key)} onclick={() => queueCartOpen(row.key)}>{t('app:workspacePending.open')}</Button>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .total {
    margin: 0 0 var(--space-3);
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .rows {
    display: flex;
    flex-direction: column;
    padding: 0;
    margin: 0;
    list-style: none;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  li {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
  }

  li + li {
    border-top: 1px solid var(--line);
  }

  .what {
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    align-items: center;
    min-width: 0;
  }

  .platforms {
    display: inline-flex;
    gap: var(--space-1);
  }

  .kinds {
    flex-basis: 100%;
    font-size: var(--text-sm);
  }

  .count {
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .muted {
    color: var(--muted);
  }
</style>
