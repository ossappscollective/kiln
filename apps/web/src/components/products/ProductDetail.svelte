<!--
  ProductDetail: one in-app purchase or subscription as the last sync read it: its status, period and group, the price of every territory
  (read only, in the currency's own units), where it is on sale, and the editor of its display name and description per language.
  Reads the stored copy only (`GET .../products/<id>`); nothing here asks a store until the person previews a text change.
  Props: api, workspaceId, role, app, productId, writeEnabled, refreshKey (changes after a sync, so this reads again), onsaved (a text was
  changed: the list reads again), onclose, onswitchoff.
-->
<script lang="ts">
  import type { Role } from '@mrm/core';
  import { untrack } from 'svelte';
  import { type Api, ApiError } from '../../lib/api.ts';
  import {
    groupPrices,
    guessedKindNote,
    kindLabel,
    periodLabel,
    priceCountText,
    READ_ONLY_NOTE,
    stateBadge,
  } from '../../lib/products.ts';
  import type { AppSummary, ProductDetailView } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import LocalizationEditor from './LocalizationEditor.svelte';

  let {
    api,
    workspaceId,
    role,
    app,
    productId,
    writeEnabled,
    refreshKey,
    onsaved,
    onclose,
    onswitchoff,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: Pick<AppSummary, 'id' | 'platform' | 'name'>;
    productId: string;
    writeEnabled: boolean;
    refreshKey: number;
    onsaved: () => void;
    onclose: () => void;
    onswitchoff: () => void;
  } = $props();

  let data = $state<ProductDetailView | null>(null);
  let loading = $state(true);
  let problem = $state('');
  let generation = 0;

  async function load() {
    const mine = ++generation;
    loading = true;
    problem = '';
    try {
      const read = await api.appProduct(workspaceId, app.id, productId);
      if (mine !== generation) return;
      data = read;
    } catch (e) {
      if (mine !== generation) return;
      data = null;
      problem = e instanceof ApiError ? e.message : 'Could not load the product.';
    } finally {
      if (mine === generation) loading = false;
    }
  }

  $effect(() => {
    void productId;
    void app.id;
    void workspaceId;
    void refreshKey;
    untrack(() => void load());
  });

  const product = $derived(data?.product ?? null);
  const status = $derived(product ? stateBadge(product.state) : null);
  const groups = $derived(product ? groupPrices(product.prices) : []);
  const guessed = $derived(product !== null && product.kind !== 'subscription' && data?.app.store === 'googleplay');

  function saved() {
    void load();
    onsaved();
  }
</script>

<section class="detail stack" aria-label="Product {productId}" data-testid="product-detail">
  <div class="head row">
    <div class="titles">
      <h3 class="name">{product?.name ?? productId}</h3>
      <p class="muted text-sm"><span class="mono">{productId}</span></p>
    </div>
    <span class="spacer"></span>
    <Button size="sm" icon="x" onclick={onclose}>Close</Button>
  </div>

  {#if loading && !data}
    <div role="status" aria-label="Reading the product" class="stack">
      <Skeleton width="100%" height="2rem" /><Skeleton width="100%" height="6rem" />
    </div>
  {:else if problem !== ''}
    <Alert tone="error" title="Could not load the product">
      {problem}
      <div class="retry"><Button size="sm" icon="refresh" onclick={() => void load()}>Try again</Button></div>
    </Alert>
  {:else if product && status}
    <div class="row badges">
      <Badge tone="neutral">{kindLabel(product.kind)}</Badge>
      <Badge tone={status.tone} dot>{status.label}</Badge>
      {#if product.rawState !== null && product.rawState.toLowerCase().replace(/_/g, ' ') !== status.label.toLowerCase()}
        <span class="muted text-sm">Store status: <span class="mono">{product.rawState}</span></span>
      {/if}
      {#if periodLabel(product.period)}<span class="muted text-sm">{periodLabel(product.period)}</span>{/if}
      {#if product.group}<span class="muted text-sm">Group: {product.group}</span>{/if}
      {#if guessed}<InfoTip label="About the type" text={guessedKindNote} />{/if}
    </div>

    <div class="stack">
      <h4>Texts</h4>
      <LocalizationEditor {api} {workspaceId} {role} {app} {product} {writeEnabled} onsaved={saved} {onswitchoff} />
    </div>

    <div class="stack">
      <div class="row">
        <h4>Prices and availability</h4>
        <InfoTip label="About prices" text={READ_ONLY_NOTE} />
      </div>
      {#if product.prices.length === 0}
        <p class="muted text-sm">The store has no price for this product yet.</p>
      {:else}
        {#each groups as group (group.planId ?? '')}
          <Disclosure summary="{group.label}: {priceCountText(group.prices.length)}" stateKey="product-prices-{app.id}-{product.productId}-{group.planId ?? ''}">
            <div class="table-wrap">
              <table class="compact">
                <thead>
                  <tr><th scope="col">Territory</th><th scope="col" class="num">Price</th></tr>
                </thead>
                <tbody>
                  {#each group.prices as p (p.territory)}
                    <tr>
                      <td><span class="mono">{p.territory}</span>{#if p.territory === product.baseTerritory} <span class="muted text-sm">(base)</span>{/if}</td>
                      <td class="num">{p.display} {p.currency}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </Disclosure>
        {/each}
      {/if}
      {#if product.availability}
        <p class="text-sm">
          On sale in {product.availability.territories.length} {product.availability.territories.length === 1 ? 'territory' : 'territories'}{#if product.availability.availableInNewTerritories === true}, and in territories the store adds later{:else if product.availability.availableInNewTerritories === false}, not in territories the store adds later{/if}.
        </p>
      {:else}
        <p class="muted text-sm">The store gave no availability for this product.</p>
      {/if}
      {#if product.plans.length > 0}
        <p class="muted text-sm">
          {product.plans.length === 1 ? 'Plan' : 'Plans'}:
          {#each product.plans as plan, i (plan.id)}{i > 0 ? ', ' : ''}<span class="mono">{plan.id}</span> ({plan.state.toLowerCase()}){/each}{#if product.offers.length > 0}. {product.offers.length} {product.offers.length === 1 ? 'offer' : 'offers'}.{/if}
        </p>
      {/if}
    </div>
  {/if}
</section>

<style>
  .detail {
    padding: var(--space-4);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--surface);
  }

  .head {
    align-items: flex-start;
  }

  .name {
    margin: 0;
    font-size: var(--text-md);
  }

  .titles p {
    margin: 0;
  }

  .badges {
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
  }

  h4 {
    margin: 0;
    font-size: var(--text-base);
    font-weight: 600;
  }

  .retry {
    margin-top: var(--space-2);
  }
</style>
