<!--
  RevenueCatCell: the content of the RevenueCat column of the Products table: where the product stands in RevenueCat (a badge) and the
  names of the first entitlements it unlocks. Plain configuration facts; before the first read of RevenueCat it says "Not read yet" and
  claims nothing (docs/adr/0039-revenuecat.md).
  Props: view (the joined view of the app), productId (the store product id).
-->
<script lang="ts">
  import { basePlanCount, entitlementNames, type RevenueCatProductsView, revenueCatCell } from '../../lib/revenuecat/revenuecat.ts';
  import { formatList } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import Badge from '../ui/Badge.svelte';

  let { view, productId }: { view: RevenueCatProductsView; productId: string } = $props();

  const cell = $derived(revenueCatCell(view, productId));
  const names = $derived(cell.entry ? entitlementNames(cell.entry) : { shown: [], more: 0 });
  const plans = $derived(cell.entry ? basePlanCount(cell.entry) : '');
</script>

<Badge tone={cell.tone} dot>{cell.label}</Badge>
{#if plans}<div class="muted text-sm">{plans}</div>{/if}
{#if names.shown.length > 0}
  <div class="muted text-sm" data-testid="product-entitlements">{names.more > 0 ? t('products:rc.cell.more', { list: formatList(names.shown, { type: 'unit' }), count: names.more }) : formatList(names.shown, { type: 'unit' })}</div>
{/if}
