<!--
  RevenueCatDetail: the RevenueCat part of one product in the Products table (docs/adr/0039-revenuecat.md): whether RevenueCat has the
  product, the RevenueCat products that use its store id (a Google Play subscription has one per base plan), the entitlements they unlock,
  and the offerings and packages that sell them. Configuration facts as plain text: no money, no customers, nothing editable. Read from the
  stored copy of the last "Sync products"; nothing here asks RevenueCat.
  Props: view (the joined view of the app), productId (the store product id), now.
-->
<script lang="ts">
  import {
    basePlanCount,
    eligibilityText,
    matchedLine,
    matchedTitle,
    type RevenueCatProductsView,
    revenueCatCell,
    syncLine,
    warningsOf,
  } from '../../lib/revenuecat/revenuecat.ts';
  import Badge from '../ui/Badge.svelte';

  let { view, productId, now }: { view: RevenueCatProductsView; productId: string; now: number } = $props();

  const cell = $derived(revenueCatCell(view, productId));
  const entry = $derived(cell.entry);
  const line = $derived(syncLine(view.sync, now));
  const warnings = $derived(warningsOf(view.warnings, productId));
  const plans = $derived(entry ? basePlanCount(entry) : '');
</script>

<div class="stack" data-testid="product-revenuecat-section">
  <div class="row">
    <h4>RevenueCat</h4>
    <Badge tone={cell.tone} dot>{cell.label}</Badge>
    {#if plans}<span class="muted text-sm">{plans}</span>{/if}
  </div>

  {#if entry === null}
    <p class="muted text-sm">{line.text}</p>
  {:else}
    {#if entry.status === 'not_in_revenuecat'}
      <p class="text-sm">No product in RevenueCat has the store id <span class="mono">{productId}</span>. Add it in the RevenueCat dashboard, under Products, if this product should be sold through RevenueCat. This tool changes nothing there.</p>
    {:else if entry.status === 'id_not_matched'}
      <p class="text-sm">A RevenueCat product has this id with different letter case, so it is not matched. Store ids are compared exactly.</p>
    {:else if entry.status === 'archived'}
      <p class="text-sm">RevenueCat has this product, but it is archived there.</p>
    {/if}

    {#if entry.products.length > 0}
      <div class="stack tight">
        <h5>{entry.products.length === 1 ? 'RevenueCat product' : 'RevenueCat products'}</h5>
        <ul class="plain list">
          {#each entry.products as p (p.rcProductId)}
            <li class="text-sm">
              <span class="mono">{matchedTitle(p)}</span>{#if p.displayName} · {p.displayName}{/if}
              <span class="muted">: {matchedLine(p)}{p.state === 'archived' ? ', archived' : ''}</span>
              {#if p.planInStore === false}<span class="muted"> (this base plan is not in the store snapshot)</span>{/if}
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if entry.entitlements.length > 0}
      <div class="stack tight">
        <h5>Entitlements</h5>
        <ul class="plain list">
          {#each entry.entitlements as e (e.id)}
            <li class="text-sm">
              {e.displayName ?? e.lookupKey} <span class="muted">(<span class="mono">{e.lookupKey}</span>{e.state === 'archived' ? ', archived' : ''})</span>
            </li>
          {/each}
        </ul>
      </div>
    {:else if entry.products.length > 0}
      <p class="muted text-sm">No entitlement is unlocked by this product.</p>
    {/if}

    {#if entry.offerings.length > 0}
      <div class="stack tight">
        <h5>Offerings</h5>
        <ul class="plain list">
          {#each entry.offerings as o (o.id)}
            <li class="text-sm">
              <span class="mono">{o.lookupKey}</span>{#if o.isCurrent} <span class="muted">(current offering)</span>{/if}{#if o.state === 'archived'} <span class="muted">(archived)</span>{/if}
              <span class="muted">: {o.packages.map((p) => `package ${p.lookupKey} (${eligibilityText(p.eligibility)})`).join(', ')}</span>
            </li>
          {/each}
        </ul>
      </div>
    {:else if entry.products.length > 0}
      <p class="muted text-sm">This product is in no offering.</p>
    {/if}

    {#if warnings.length > 0}
      <ul class="plain list" aria-label="Things to check for this product">
        {#each warnings as w, i (i)}
          <li class="text-sm"><Badge tone={w.severity === 'info' ? 'info' : w.severity}>{w.severity === 'bad' ? 'Problem' : w.severity === 'warn' ? 'Check' : 'Note'}</Badge> {w.message}</li>
        {/each}
      </ul>
    {/if}
    <p class="muted text-sm">{line.text}</p>
  {/if}
</div>

<style>
  h4,
  h5 {
    margin: 0;
    font-size: var(--text-base);
    font-weight: 600;
  }

  h5 {
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .list {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin: 0;
  }
</style>
