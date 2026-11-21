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
    severityLabel,
    syncLine,
    warningsOf,
  } from '../../lib/revenuecat/revenuecat.ts';
  import { formatList } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import Badge from '../ui/Badge.svelte';
  import T from '../ui/T.svelte';

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
      <p class="text-sm"><T key="products:rc.detail.notIn" params={{ id: productId }} tags={{ code: mono }} /></p>
    {:else if entry.status === 'id_not_matched'}
      <p class="text-sm">{t('products:rc.detail.idDiffers')}</p>
    {:else if entry.status === 'archived'}
      <p class="text-sm">{t('products:rc.detail.archived')}</p>
    {/if}

    {#if entry.products.length > 0}
      <div class="stack tight">
        <h5>{t('products:rc.detail.productsHeading', { count: entry.products.length })}</h5>
        <ul class="plain list">
          {#each entry.products as p (p.rcProductId)}
            <li class="text-sm">
              <span class="mono">{matchedTitle(p)}</span>{#if p.displayName} · {p.displayName}{/if}
              <span class="muted">{p.state === 'archived' ? t('products:rc.detail.matchedArchived', { line: matchedLine(p) }) : t('products:rc.detail.matched', { line: matchedLine(p) })}</span>
              {#if p.planInStore === false}<span class="muted"> {t('products:rc.detail.planNotInStore')}</span>{/if}
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if entry.entitlements.length > 0}
      <div class="stack tight">
        <h5>{t('products:rc.detail.entitlements')}</h5>
        <ul class="plain list">
          {#each entry.entitlements as e (e.id)}
            <li class="text-sm">
              {e.displayName ?? e.lookupKey} <span class="muted">{#if e.state === 'archived'}<T key="products:rc.detail.keyArchived" params={{ key: e.lookupKey }} tags={{ code: mono }} />{:else}<T key="products:rc.detail.key" params={{ key: e.lookupKey }} tags={{ code: mono }} />{/if}</span>
            </li>
          {/each}
        </ul>
      </div>
    {:else if entry.products.length > 0}
      <p class="muted text-sm">{t('products:rc.detail.noEntitlement')}</p>
    {/if}

    {#if entry.offerings.length > 0}
      <div class="stack tight">
        <h5>{t('products:rc.detail.offerings')}</h5>
        <ul class="plain list">
          {#each entry.offerings as o (o.id)}
            <li class="text-sm">
              <span class="mono">{o.lookupKey}</span>{#if o.isCurrent} <span class="muted">{t('products:rc.detail.currentOffering')}</span>{/if}{#if o.state === 'archived'} <span class="muted">{t('products:rc.detail.archivedMark')}</span>{/if}
              <span class="muted">{t('products:rc.detail.packages', { list: formatList(o.packages.map((p) => t('products:rc.detail.package', { key: p.lookupKey, eligibility: eligibilityText(p.eligibility) })), { type: 'unit' }) })}</span>
            </li>
          {/each}
        </ul>
      </div>
    {:else if entry.products.length > 0}
      <p class="muted text-sm">{t('products:rc.detail.noOffering')}</p>
    {/if}

    {#if warnings.length > 0}
      <ul class="plain list" aria-label={t('products:rc.detail.warningsLabel')}>
        {#each warnings as w, i (i)}
          <li class="text-sm"><Badge tone={w.severity === 'info' ? 'info' : w.severity}>{severityLabel(w.severity)}</Badge> {w.message}</li>
        {/each}
      </ul>
    {/if}
    <p class="muted text-sm">{line.text}</p>
  {/if}
</div>

{#snippet mono(text: string)}<span class="mono">{text}</span>{/snippet}

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
