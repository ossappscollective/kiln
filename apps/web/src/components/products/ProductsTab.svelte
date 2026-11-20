<!--
  ProductsTab: the in-app purchases and subscriptions of one app, read from its store (docs/api/products.md, docs/adr/0034-in-app-products.md).
  A table of what the last sync read (name, type, status, price, languages), a "Sync products" button, and the detail of the product that is
  open (prices and availability read only; the display name and description editable per language, behind a preview).
  Reading and syncing never change a store. The one write, a text change, is OFF until the server's switch is on and needs the admin role:
  the page says so instead of hiding the texts.
  Props: api, workspaceId, role, app, refreshKey (changes when an app sync finished, so this reads again).
-->
<script lang="ts">
  import { can, type Role } from '@mrm/core';
  import { untrack } from 'svelte';
  import { type Api, ApiError } from '../../lib/api.ts';
  import {
    classifyProductFailure,
    kindLabel,
    periodLabel,
    priceCountText,
    priceText,
    READ_ONLY_NOTE,
    stateBadge,
    syncLine,
  } from '../../lib/products.ts';
  import { storeForPlatform } from '../../lib/stores.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary, ProductsView } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import PageLead from '../ui/PageLead.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import ProductDetail from './ProductDetail.svelte';

  let { api, workspaceId, role, app, refreshKey }: { api: Api; workspaceId: string; role: Role; app: AppSummary; refreshKey: number } = $props();

  const maySync = $derived(can(role, 'apps.sync'));
  const storeName = $derived(storeForPlatform(app.platform).fullLabel);

  let view = $state<ProductsView | null>(null);
  let loading = $state(true);
  let problem = $state('');
  let syncing = $state(false);
  let syncProblem = $state('');
  let openId = $state<string | null>(null);
  let detailKey = $state(0);
  let now = $state(Date.now());
  let generation = 0;

  async function load() {
    const mine = ++generation;
    loading = true;
    problem = '';
    try {
      const read = await api.appProducts(workspaceId, app.id);
      if (mine !== generation) return;
      view = read;
      now = Date.now();
    } catch (e) {
      if (mine !== generation) return;
      view = null;
      problem = e instanceof ApiError ? e.message : 'Could not load the products.';
    } finally {
      if (mine === generation) loading = false;
    }
  }

  $effect(() => {
    void app.id;
    void workspaceId;
    void refreshKey;
    openId = null;
    untrack(() => void load());
  });

  async function sync() {
    if (syncing) return;
    syncing = true;
    syncProblem = '';
    try {
      const done = await api.syncAppProducts(workspaceId, app.id);
      const n = done.sync.products;
      toast.success(`Read ${n} ${n === 1 ? 'product' : 'products'} from ${storeName}.`);
      detailKey += 1;
      await load();
    } catch (e) {
      syncProblem = classifyProductFailure(e, 'read').message;
      // The failure is also kept on the server, so the list says it.
      await load();
    } finally {
      syncing = false;
    }
  }

  const products = $derived(view?.products ?? []);
  const line = $derived(view ? syncLine(view.sync, now) : null);
  const headline = $derived(
    view === null
      ? 'In-app purchases and subscriptions'
      : products.length === 0
        ? 'No products read yet'
        : `${products.length} ${products.length === 1 ? 'product' : 'products'} in ${storeName}`,
  );
</script>

<div class="stack">
  <PageLead {headline} hint="What the store sells in this app, as of the last sync. Prices are read only; display texts can be changed here by an admin.">
    {#snippet aside()}
      <InfoTip label="About products" buttonText="About products" width="26rem">
        <p>{READ_ONLY_NOTE}</p>
        <p>Subscriptions and in-app purchases are read from {storeName} with the credential of this app. Reading and syncing change nothing in the store.</p>
      </InfoTip>
    {/snippet}
    {#snippet actions()}
      {#if maySync && view?.supported !== false}
        <Button variant={products.length === 0 ? 'primary' : 'secondary'} icon="refresh" loading={syncing} onclick={() => void sync()}>Sync products</Button>
      {/if}
    {/snippet}
  </PageLead>

  {#if syncProblem !== ''}<Alert tone="error" title="The sync did not finish">{syncProblem}</Alert>{/if}

  {#if loading && !view}
    <div role="status" aria-label="Reading the products" class="stack">
      <Skeleton width="100%" height="2.5rem" /><Skeleton width="100%" height="2.5rem" /><Skeleton width="100%" height="2.5rem" />
    </div>
  {:else if problem !== ''}
    <Alert tone="error" title="Could not load the products">
      {problem}
      <div class="retry"><Button size="sm" icon="refresh" onclick={() => void load()}>Try again</Button></div>
    </Alert>
  {:else if view}
    {#if line && view.sync !== null}
      <p class="sync-line text-sm" class:bad={line.tone === 'bad'} class:warn={line.tone === 'warn'} role={line.tone === 'bad' ? 'alert' : 'status'}>
        {line.text}
      </p>
    {/if}
    {#if view.sync && view.sync.warnings.length > 0}
      <Alert tone="warn" title="Some parts could not be read">
        <ul class="warnings">
          {#each view.sync.warnings as warning (warning)}<li>{warning}</li>{/each}
        </ul>
      </Alert>
    {/if}

    {#if !view.supported}
      <EmptyState icon="tag" title="No in-app purchases for this store" description="This app's store has no in-app purchases or subscriptions that this tool reads." />
    {:else if products.length === 0}
      <EmptyState
        icon="tag"
        title={view.sync === null || view.sync.lastSyncedAt === null ? 'Nothing read from the store yet' : 'No in-app purchases or subscriptions'}
        description={view.sync === null || view.sync.lastSyncedAt === null
          ? `Sync to read the in-app purchases and subscriptions of this app from ${storeName}. Nothing is changed in the store.`
          : `${storeName} lists no in-app purchases or subscriptions for this app. If that is wrong, check that the credential may read them, then sync again.`}
      >
        {#snippet actions()}
          {#if maySync}
            <Button variant="primary" icon="refresh" loading={syncing} onclick={() => void sync()}>Sync products</Button>
          {:else}
            <span class="muted text-sm">Ask a member to sync this app's products.</span>
          {/if}
        {/snippet}
      </EmptyState>
    {:else}
      <div class="table-wrap card flush">
        <table aria-label="In-app purchases and subscriptions of {app.name}">
          <thead>
            <tr>
              <th scope="col">Product</th>
              <th scope="col">Type</th>
              <th scope="col">Status</th>
              <th scope="col" class="num">Price</th>
              <th scope="col">Languages</th>
              <th scope="col"><span class="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {#each products as p (p.productId)}
              {@const status = stateBadge(p.state)}
              <tr class:open={openId === p.productId}>
                <td>
                  <div class="name">{p.name ?? p.referenceName}</div>
                  <div class="muted text-sm"><span class="mono">{p.productId}</span>{#if p.group} · {p.group}{/if}</div>
                </td>
                <td>
                  {kindLabel(p.kind)}
                  {#if periodLabel(p.period)}<div class="muted text-sm">{periodLabel(p.period)}</div>{/if}
                </td>
                <td><Badge tone={status.tone} dot>{status.label}</Badge></td>
                <td class="num">
                  {priceText(p.price)}
                  <div class="muted text-sm">{priceCountText(p.territoryCount)}</div>
                </td>
                <td class="muted text-sm">{p.locales.length === 0 ? 'None' : p.locales.length <= 3 ? p.locales.join(', ') : `${p.locales.slice(0, 3).join(', ')} and ${p.locales.length - 3} more`}</td>
                <td class="actions">
                  <Button
                    size="sm"
                    icon={openId === p.productId ? 'chevron-up' : 'edit'}
                    aria-expanded={openId === p.productId}
                    aria-controls="product-detail-{p.productId}"
                    onclick={() => (openId = openId === p.productId ? null : p.productId)}
                  >
                    {openId === p.productId ? 'Close' : 'Open'}<span class="visually-hidden"> {p.name ?? p.referenceName}</span>
                  </Button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if openId !== null}
        <div id="product-detail-{openId}">
          <ProductDetail
            {api}
            {workspaceId}
            {role}
            {app}
            productId={openId}
            writeEnabled={view.write.enabled}
            refreshKey={detailKey}
            onsaved={() => void load()}
            onclose={() => (openId = null)}
            onswitchoff={() => {
              if (view) view = { ...view, write: { ...view.write, enabled: false } };
            }}
          />
        </div>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .sync-line {
    margin: 0;
    color: var(--muted);
  }

  .sync-line.bad {
    color: var(--bad-ink);
  }

  .sync-line.warn {
    color: var(--warn-ink);
  }

  .name {
    font-weight: 500;
  }

  .warnings {
    margin: 0;
    padding-left: var(--space-4);
  }

  .retry {
    margin-top: var(--space-2);
  }

  tr.open {
    background: var(--accent-bg);
  }
</style>
