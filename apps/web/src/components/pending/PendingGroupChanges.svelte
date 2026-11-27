<!--
  PendingGroupChanges: the individual changes of one product on the workspace Pending page (docs/adr/0067-diff-and-preview.md), read
  lazily when the group is expanded: GET /apps/{id}/pending/cart for each record of the product (the same read as the cart drawer,
  stored state only, same rights), one expandable row per change with the shared preview (CartRowPreview: text diff, before and after
  images, price table, reply with its review) and an Expand all / Collapse all control. Nothing is published or discarded from here:
  "Open cart" of the product stays the one place for that.
  Props: api, workspaceId, appIds (the product's records), id (DOM id for aria-controls).
-->
<script lang="ts">
  import type { Api } from '../../lib/api.ts';
  import { type Expanded, expansionOf, PREVIEW_KEYS, noneExpanded, toggleAll, toggleExpanded } from '../../lib/cart-preview.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { cartStore } from '../../lib/app-state/cart-store.svelte.ts';
  import { type CartRow, GROUP_KEYS } from '../../lib/pending-cart.ts';
  import CartRowPreview from '../app/CartRowPreview.svelte';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import Skeleton from '../ui/Skeleton.svelte';

  let { api, workspaceId, appIds, id }: { api: Api; workspaceId: string; appIds: readonly string[]; id: string } = $props();

  /** The carts are read once for every screen (`cartStore`): the cart drawer, the Pending page's previews and this list share one read. */
  const known = $derived(appIds.every((appId) => cartStore.rows(workspaceId, appId) !== null));
  const rows = $derived<CartRow[] | null>(known ? appIds.flatMap((appId) => cartStore.rows(workspaceId, appId) ?? []) : null);
  const failed = $derived(!known && appIds.some((appId) => cartStore.failed(workspaceId, appId)));
  let expanded = $state<Expanded>(noneExpanded);
  const expansion = $derived(expansionOf(expanded, rows ?? []));

  $effect(() => cartStore.watch(api, workspaceId, appIds));
  const platformName = (p: string) => (p === 'ios' ? 'iOS' : p === 'android' ? 'Android' : p);
</script>

<div class="changes" {id}>
  {#if failed}
    <Alert tone="error">{t('app:workspacePending.changesFailed')}</Alert>
    <div><Button size="sm" icon="refresh" onclick={() => void cartStore.refresh(api, workspaceId, appIds)}>{t('common:action.tryAgain')}</Button></div>
  {:else if rows === null}
    <div role="status" aria-label={t('app:workspacePending.loading')}><Skeleton width="100%" height="48px" /></div>
  {:else if rows.length === 0}
    <p class="muted">{t('app:workspacePending.changesEmpty')}</p>
  {:else}
    <div class="tools">
      <Button size="sm" variant="ghost" icon={expansion === 'all' ? 'chevron-up' : 'chevron-down'} onclick={() => (expanded = toggleAll(expanded, rows ?? []))}>
        {expansion === 'all' ? t('app:cart.preview.collapseAll') : t('app:cart.preview.expandAll')}
      </Button>
    </div>
    <ul>
      {#each rows as row (row.key)}
        <li>
          <div class="line">
            <button
              type="button"
              class="ghost icon sm"
              aria-expanded={expanded.has(row.key)}
              aria-controls="{id}-{row.key}"
              aria-label={t(PREVIEW_KEYS[expanded.has(row.key) ? 'collapse' : 'expand'], { title: row.title || t(GROUP_KEYS[row.kind]) })}
              onclick={() => (expanded = toggleExpanded(expanded, row.key))}
            >
              <Icon name={expanded.has(row.key) ? 'chevron-up' : 'chevron-down'} />
            </button>
            <Badge>{t(GROUP_KEYS[row.kind])}</Badge>
            <strong class="title">{row.title || t(GROUP_KEYS[row.kind])}</strong>
            {#if appIds.length > 1}<Badge>{platformName(row.platform)}</Badge>{/if}
            {#if row.locale}<Badge>{row.locale}</Badge>{/if}
          </div>
          {#if expanded.has(row.key)}<CartRowPreview {api} {workspaceId} {row} id="{id}-{row.key}" />{/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .changes {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    flex-basis: 100%;
    min-width: 0;
  }
  .tools {
    display: flex;
    justify-content: flex-end;
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: block;
    padding: var(--space-2) 0;
  }
  li + li {
    border-top: 1px solid var(--line);
  }
  .line {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    align-items: center;
  }
  p {
    margin: 0;
    font-size: var(--text-sm);
  }
</style>
