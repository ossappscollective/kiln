<!--
  WorkspacePending: the workspace-level overview of everything pending (docs/ux-ia.md "Pending changes across the workspace", ADR 0064).
  One row per app (the records of one product together) with its number of pending changes and what kinds they are, from
  GET /pending/cart-summary (counts only, stored state). "Open cart" goes to the app and opens ITS cart drawer (the one place to review, publish
  or discard); nothing is published or discarded from here, and nothing across apps.
  Each product can be expanded to list its individual changes with the same previews as the cart (PendingGroupChanges, ADR 0067);
  that is read lazily from the per-app cart, the summary stays counts only.
  Props: api, workspaceId, role (the view contract).
-->
<script lang="ts">
  import type { Role } from '@kiln/core';
  import { onMount } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { appAddress } from '../../lib/app-scope.ts';
  import { appStateStore } from '../../lib/app-state/app-state-store.svelte.ts';
  import { KIND_LABEL, pendingAcrossText } from '../../lib/cart-summary.ts';
  import { k, t } from '../../lib/i18n/t.ts';
  import { navSignals } from '../../lib/nav-signals.svelte.ts';
  import { queueCartOpen } from '../../lib/pending-cart.ts';
  import FailureAnchor from '../app-state/FailureAnchor.svelte';
  import PendingGroupChanges from './PendingGroupChanges.svelte';
  import PublishFailure from '../publish/PublishFailure.svelte';
  import PublishingStatus from '../publish/PublishingStatus.svelte';
  import Badge from '../ui/Badge.svelte';
  import Icon from '../ui/Icon.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import PageHeader from '../ui/PageHeader.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import Skeleton from '../ui/Skeleton.svelte';

  let { api, workspaceId }: { api: Api; workspaceId: string; role: Role } = $props();

  // Everything on this page comes from the app-state store: the same count as the top bar and the sidebar, the same failures.
  const known = $derived(appStateStore.pendingKnown(workspaceId));
  const rows = $derived(appStateStore.workspaceRows(workspaceId, navSignals.appsOf(workspaceId)));
  const totals = $derived(appStateStore.workspaceTotals(workspaceId, navSignals.appsOf(workspaceId)));
  /** The apps that publish right now, whatever is left in their carts (a publish can empty the cart before it ends). */
  const publishingApps = $derived(appStateStore.workspacePublishing(workspaceId, navSignals.appsOf(workspaceId)));
  /** Apps whose latest publish did not go through (and nobody hid it), with the reason; an app that publishes again shows its progress instead. */
  const failedApps = $derived(appStateStore.workspaceFailures(workspaceId, navSignals.appsOf(workspaceId)));
  const publishingKeys = $derived(new Set(publishingApps.map((p) => p.app.id)));
  let failed = $state(false);
  /** Products whose changes are listed (read lazily when first opened); collapsed by default. */
  let open = $state<ReadonlySet<string>>(new Set());
  const toggle = (key: string) => {
    const next = new Set(open);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    open = next;
  };
  const uid = $props.id();

  async function read() {
    failed = false;
    await appStateStore.refresh(api, workspaceId);
    failed = !appStateStore.pendingKnown(workspaceId);
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

{#if !known && !failed}
  <div role="status" aria-label={t('app:workspacePending.loading')}><Skeleton width="100%" height="72px" /></div>
{:else if !known}
  <EmptyState icon="alert-triangle" title={t('app:workspacePending.loadFailed')}>
    {#snippet actions()}<Button onclick={() => void read()}>{t('common:action.retry')}</Button>{/snippet}
  </EmptyState>
{:else if rows.length === 0 && publishingApps.length === 0 && failedApps.length === 0}
  <EmptyState icon="check" title={t('app:workspacePending.empty')} />
{:else}
  {#each publishingApps as p (p.app.id)}
    <div class="publishing-now" data-testid="workspace-publishing">
      <strong>{p.app.name}</strong>
      <PublishingStatus publishing={p.entry} platform={p.app.platform} appId={p.app.id} href={appAddress(p.app.id, 'pending')} />
    </div>
  {/each}
  {#each failedApps as f (f.app.id)}
    <div class="publishing-now" data-testid="workspace-publish-failed">
      <strong>{f.app.name}</strong>
      <FailureAnchor appId={f.app.id}>
        <PublishFailure run={f.run} appName={f.app.name} platform={f.app.platform} ondismiss={() => appStateStore.dismissFailure(api, workspaceId, f.app.id)} />
      </FailureAnchor>
    </div>
  {/each}
  {#if totals}<p class="total" role="status">{pendingAcrossText(totals)}</p>{/if}
  <ul class="rows" aria-label={t('app:workspacePending.listLabel')}>
    {#each rows as row (row.key)}
      <li>
        <div class="what">
          <button type="button" class="ghost icon sm" aria-expanded={open.has(row.key)} aria-controls="{uid}-{row.key}" aria-label={t(open.has(row.key) ? k('app:workspacePending.hideChanges') : k('app:workspacePending.showChanges'), { name: row.name })} onclick={() => toggle(row.key)}>
            <Icon name={open.has(row.key) ? 'chevron-up' : 'chevron-down'} />
          </button>
          <strong>{row.name}</strong>
          <span class="platforms">{#each row.platforms as p (p)}<PlatformBadge platform={p} showLabel={false} />{/each}</span>
          <span class="muted kinds">{row.kinds.map((x) => `${t(KIND_LABEL[x.kind])} ${x.count}`).join(' · ')}</span>
        </div>
        <span class="count">
          {#if row.appIds.some((id) => publishingKeys.has(id))}<Badge tone="info" icon="refresh">{t('publish:publishing.chip')}</Badge>{/if}
          {t('shell:badge.pendingChanges', { count: row.count })}
        </span>
        <Button size="sm" icon="upload" label={t('app:workspacePending.openLabel', { name: row.name })} href={appAddress(row.key)} onclick={() => queueCartOpen(row.key)}>{t('app:workspacePending.open')}</Button>
        {#if open.has(row.key)}<PendingGroupChanges {api} {workspaceId} appIds={row.appIds} id="{uid}-{row.key}" />{/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .publishing-now {
    display: grid;
    gap: var(--space-1);
    margin: 0 0 var(--space-3);
  }

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
    flex-wrap: wrap;
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
