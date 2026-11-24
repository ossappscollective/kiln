<!--
  PendingItemPreview: the expanded part of a row of the per-app "Pending changes" page (docs/adr/0067-diff-and-preview.md). One
  implementation of the preview for every kind the page lists:
  - a staged item (listing texts, a graphics set, a release field) is shown through its cart items with the SAME shared preview as the
    cart drawer and the workspace Pending page (CartRowPreview: text diff, before and after images with the viewer);
  - any other item (a pushed draft, a draft release, a version in review or approved, a due rollout step) is read lazily from
    GET /apps/{id}/pending/detail and shown as facts: what it contains and what happens next. Nothing is sent from here.
  Props: api, workspaceId, appId, item (a PendingItem), cartRows (the app's cart rows, null while not read, `failed` when it could not
  be), id (the DOM id the row's chevron points to with aria-controls), onretry (read the cart again).
-->
<script lang="ts">
  import type { Api } from '../../lib/api.ts';
  import { t } from '../../lib/i18n/t.ts';
  import type { CartRow } from '../../lib/pending-cart.ts';
  import { pendingItemDetailStore } from '../../lib/pending-item-detail.svelte.ts';
  import { FIRST_ROWS, detailView, planOf } from '../../lib/pending-preview.ts';
  import type { PendingItem } from '../../lib/pending.ts';
  import CartRowPreview from '../app/CartRowPreview.svelte';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Skeleton from '../ui/Skeleton.svelte';

  let {
    api,
    workspaceId,
    appId,
    item,
    cartRows,
    cartFailed = false,
    id,
    onretry,
  }: {
    api: Api;
    workspaceId: string;
    appId: string;
    item: PendingItem;
    cartRows: CartRow[] | null;
    cartFailed?: boolean | undefined;
    id: string;
    onretry: () => void;
  } = $props();

  const plan = $derived(planOf(item, cartRows));
  const entry = $derived(plan.source === 'detail' ? pendingItemDetailStore.entryOf(appId, item) : undefined);
  const view = $derived(entry?.status === 'ok' ? detailView(entry.detail) : null);
  let all = $state(false);
  const shown = $derived(plan.source === 'cart' ? (all ? plan.rows : plan.rows.slice(0, FIRST_ROWS)) : []);

  $effect(() => {
    if (plan.source === 'detail') void pendingItemDetailStore.load(api, workspaceId, appId, item);
  });
</script>

<div class="preview" {id} data-testid="pending-item-preview">
  {#if plan.source === 'cart'}
    {#if cartFailed}
      <Alert tone="error">{t('publish:pending.preview.cartFailed')}</Alert>
      <div><Button size="sm" icon="refresh" onclick={onretry}>{t('common:action.tryAgain')}</Button></div>
    {:else if !plan.loaded}
      <div role="status" aria-label={t('publish:pending.preview.loading')}><Skeleton width="100%" height="72px" /></div>
    {:else}
      {#if plan.rows.length === 0}
        <p class="muted note">{t('publish:pending.preview.gone')}</p>
      {/if}
      {#each shown as row (row.key)}
        <div class="part">
          {#if item.kind === 'listing_text'}
            <p class="head"><strong>{row.title}</strong>{#if row.locale} <Badge>{row.locale}</Badge>{/if}</p>
          {/if}
          <CartRowPreview {api} {workspaceId} {row} id="{id}-{row.id}" />
        </div>
      {/each}
      {#if plan.rows.length > shown.length}
        <p class="muted note">{t('publish:pending.preview.shown', { shown: shown.length, count: plan.rows.length })}</p>
        <div><Button size="sm" onclick={() => (all = true)}>{t('publish:pending.preview.showMore', { count: plan.rows.length })}</Button></div>
      {/if}
      {#if plan.rows.length > 0 && plan.missing > 0}<p class="muted note">{t('publish:pending.preview.gone')}</p>{/if}
    {/if}
  {:else if plan.source === 'detail'}
    {#if entry?.status === 'failed'}
      <Alert tone="error">{t('publish:pending.preview.failed')}</Alert>
      <div><Button size="sm" icon="refresh" onclick={() => void pendingItemDetailStore.load(api, workspaceId, appId, item, true)}>{t('common:action.tryAgain')}</Button></div>
    {:else if entry?.status === 'ok' && view === null}
      <p class="muted note">{t('publish:pending.preview.noPreview')}</p>
    {:else if view !== null}
      <p class="note">{view.intro}</p>
      {#each view.groups as g (g.heading)}
        <div class="group">
          <p class="head"><strong>{g.heading}</strong></p>
          {#if g.lines.length > 0}
            <ul>{#each g.lines as line, i (i)}<li>{line}</li>{/each}</ul>
          {/if}
        </div>
      {/each}
      {#each view.notes as n (n)}<p class="muted note">{n}</p>{/each}
    {:else}
      <div role="status" aria-label={t('publish:pending.preview.loading')}><Skeleton width="100%" height="48px" /></div>
    {/if}
  {:else}
    <p class="muted note">{t('publish:pending.preview.noPreview')}</p>
  {/if}
</div>

<style>
  .preview {
    display: grid;
    flex-basis: 100%;
    gap: var(--space-2);
    min-width: 0;
  }
  .part {
    display: grid;
    gap: var(--space-1);
    min-width: 0;
  }
  .part + .part {
    padding-top: var(--space-2);
    border-top: 1px solid var(--line);
  }
  .head,
  .note {
    margin: 0;
    font-size: var(--text-sm);
  }
  ul {
    max-height: 14rem;
    padding: 0 0 0 var(--space-4);
    margin: var(--space-1) 0 0;
    overflow: auto;
    font-size: var(--text-sm);
  }
</style>
