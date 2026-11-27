<!--
  ProductDetail: one in-app purchase or subscription as the last sync read it: its status, period and group, the price of every territory
  (read only, in the currency's own units), where it is on sale, and the editor of its display name and description per language.
  Reads the stored copy only (`GET .../products/<id>`); nothing here asks a store until the person previews a text change.
  A small "Sales" section shows the last 28 days of this product from the stored sales numbers the list already read (`sales`; null hides the
  section: no stored sales, or a role that cannot read analytics). Per currency, never summed; the text says what the number is.
  A "RevenueCat" section (configuration facts as plain text, from the stored copy; docs/adr/0039-revenuecat.md) is drawn when the app is linked
  (`revenueCat`, the joined view of the app; null hides it).
  Props: api, workspaceId, role, app, productId, sales, revenueCat, writeEnabled, refreshKey (changes after a sync, so this reads again), embedded (inside the
  table row of the product), onsaved (a text was changed: the list reads again), onclose, onswitchoff.
-->
<script lang="ts">
  import type { Role } from '@kiln/core';
  import { untrack } from 'svelte';
  import {
    type ProductSalesView,
    salesByProduct,
    salesCell,
    salesMeasureText,
  } from '../../lib/analytics/product-sales.ts';
  import { type Api, ApiError } from '../../lib/api.ts';
  import { t } from '../../lib/i18n/t.ts';
  import {
    groupPrices,
    guessedKindNote,
    kindLabel,
    periodLabel,
    priceCountText,
    priceDisplay,
    READ_ONLY_NOTE,
    stateBadge,
  } from '../../lib/products.ts';
  import type { RevenueCatProductsView } from '../../lib/revenuecat/revenuecat.ts';
  import type { AppSummary, ProductDetailView } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import T from '../ui/T.svelte';
  import RevenueCatDetail from '../revenuecat/RevenueCatDetail.svelte';
  import LocalizationEditor from './LocalizationEditor.svelte';
  import PriceEditor from './PriceEditor.svelte';
  import { useNow } from '../../lib/app-state/clock.svelte.ts';

  let {
    api,
    workspaceId,
    role,
    app,
    productId,
    sales = null,
    revenueCat = null,
    writeEnabled,
    refreshKey,
    embedded = false,
    onsaved,
    onclose,
    onswitchoff,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: Pick<AppSummary, 'id' | 'platform' | 'name'>;
    productId: string;
    /** The stored sales of the app (null: none stored, or no right to read analytics: the section is not drawn). */
    sales?: ProductSalesView | null | undefined;
    /** The joined RevenueCat view of the app (null: the app is not linked: the section is not drawn). */
    revenueCat?: RevenueCatProductsView | null | undefined;
    writeEnabled: boolean;
    refreshKey: number;
    /** Drawn inside the table row of the product: no card of its own and no Close (the row's button hides it). */
    embedded?: boolean | undefined;
    onsaved: () => void;
    onclose: () => void;
    onswitchoff: () => void;
  } = $props();

  const clock = useNow();

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
      problem = e instanceof ApiError ? e.message : t('products:detail.loadError');
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
  const salesItem = $derived(sales ? salesByProduct(sales).get(productId) : undefined);
  const salesLines = $derived(sales ? salesCell(sales, salesItem) : []);
  const guessed = $derived(product !== null && product.kind !== 'subscription' && data?.app.store === 'googleplay');

  function saved() {
    void load();
    onsaved();
  }
</script>

<section class="detail stack" class:embedded aria-label={t('products:detail.aria', { id: productId })} data-testid="product-detail">
  <div class="head row">
    <div class="titles">
      <h3 class="name">{product?.name ?? productId}</h3>
      <p class="muted text-sm"><span class="mono">{productId}</span></p>
    </div>
    {#if !embedded}
      <span class="spacer"></span>
      <Button size="sm" icon="x" onclick={onclose}>{t('products:detail.close')}</Button>
    {/if}
  </div>

  {#if loading && !data}
    <div role="status" aria-label={t('products:detail.reading')} class="stack">
      <Skeleton width="100%" height="2rem" /><Skeleton width="100%" height="6rem" />
    </div>
  {:else if problem !== ''}
    <Alert tone="error" title={t('products:detail.loadErrorTitle')}>
      {problem}
      <div class="retry"><Button size="sm" icon="refresh" onclick={() => void load()}>{t('common:action.tryAgain')}</Button></div>
    </Alert>
  {:else if product && status}
    <div class="row badges">
      <Badge tone="neutral">{kindLabel(product.kind)}</Badge>
      <Badge tone={status.tone} dot>{status.label}</Badge>
      {#if product.rawState !== null && product.rawState.toLowerCase().replace(/_/g, ' ') !== status.label.toLowerCase()}
        <span class="muted text-sm"><T key="products:detail.storeStatus" params={{ status: product.rawState }} tags={{ code: mono }} /></span>
      {/if}
      {#if periodLabel(product.period)}<span class="muted text-sm">{periodLabel(product.period)}</span>{/if}
      {#if product.group}<span class="muted text-sm">{t('products:detail.group', { group: product.group })}</span>{/if}
      {#if guessed}<InfoTip label={t('products:detail.aboutType')} text={t(guessedKindNote)} />{/if}
    </div>

    {#if sales}
      <div class="stack" data-testid="product-sales-section">
        <div class="row">
          <h4>{t('products:detail.salesTitle')}</h4>
          <InfoTip label={t('products:detail.aboutSales')} text={salesMeasureText(sales)} />
        </div>
        {#if salesLines[0] === '—'}
          <p class="muted text-sm">{t('products:detail.noSales')}</p>
        {:else}
          <p class="text-sm sales-lines">
            {#each salesLines as line, i (line)}{i > 0 ? ' · ' : ''}<span>{line}</span>{/each}
          </p>
        {/if}
        <p class="muted text-sm">{sales.measure === 'apple_proceeds' ? t('products:detail.measureApple') : t('products:detail.measureGoogle')}</p>
      </div>
    {/if}

    {#if revenueCat}
      <RevenueCatDetail view={revenueCat} {productId} now={clock.value} />
    {/if}

    <div class="stack">
      <h4>{t('products:detail.texts')}</h4>
      <LocalizationEditor {api} {workspaceId} {role} {app} {product} {writeEnabled} onsaved={saved} {onswitchoff} />
    </div>

    <div class="stack">
      <div class="row">
        <h4>{t('products:detail.pricesTitle')}</h4>
        <InfoTip label={t('products:detail.aboutPrices')} text={t(READ_ONLY_NOTE)} />
      </div>
      {#if data}
        <PriceEditor {api} {workspaceId} {role} {app} store={data.app.store} {product} onstaged={saved} />
      {/if}
      {#if revenueCat}<p class="muted text-sm" data-testid="revenuecat-prices-note">{t('products:price.revenueCatNote')}</p>{/if}
      {#if product.prices.length === 0}
        <p class="muted text-sm">{t('products:detail.noPrice')}</p>
      {:else}
        {#each groups as group (group.planId ?? '')}
          <Disclosure summary={t('products:detail.priceGroup', { label: group.label, territories: priceCountText(group.prices.length) })} stateKey="product-prices-{app.id}-{product.productId}-{group.planId ?? ''}">
            <div class="table-wrap">
              <table class="compact">
                <thead>
                  <tr><th scope="col">{t('products:detail.colTerritory')}</th><th scope="col" class="num">{t('products:detail.colPrice')}</th></tr>
                </thead>
                <tbody>
                  {#each group.prices as p (p.territory)}
                    <tr>
                      <td><span class="mono">{p.territory}</span>{#if p.territory === product.baseTerritory} <span class="muted text-sm">{t('products:detail.base')}</span>{/if}</td>
                      <td class="num">{priceDisplay(p)}</td>
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
          {product.availability.availableInNewTerritories === true
            ? t('products:detail.onSaleAndNew', { count: product.availability.territories.length })
            : product.availability.availableInNewTerritories === false
              ? t('products:detail.onSaleNotNew', { count: product.availability.territories.length })
              : t('products:detail.onSale', { count: product.availability.territories.length })}
        </p>
      {:else}
        <p class="muted text-sm">{t('products:detail.noAvailability')}</p>
      {/if}
      {#if product.plans.length > 0}
        <p class="muted text-sm">
          {t('products:detail.plans', { count: product.plans.length })}
          {#each product.plans as plan, i (plan.id)}{i > 0 ? ', ' : ''}<span class="mono">{plan.id}</span> ({plan.state.toLowerCase()}){/each}{#if product.offers.length > 0}. {t('products:detail.offers', { count: product.offers.length })}{/if}
        </p>
      {/if}
    </div>
  {/if}
</section>

{#snippet mono(text: string)}<span class="mono">{text}</span>{/snippet}

<style>
  .detail {
    padding: var(--space-4);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--surface);
  }

  .detail.embedded {
    border: 0;
    border-radius: 0;
    background: var(--surface-sunken);
    padding: var(--space-4) var(--space-5);
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

  .sales-lines {
    margin: 0;
  }
</style>
