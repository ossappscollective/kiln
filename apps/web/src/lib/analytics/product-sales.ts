import { t } from '../i18n/t.ts';
import { formatMoney } from './analytics.ts';

/**
 * Sales by product on the Products page (docs/api/analytics.md, docs/adr/0038-sales-analytics.md). Pure: no `window`, no network.
 * The rules this file keeps:
 * - Money stays PER CURRENCY: two currencies are two lines and are never added or converted.
 * - What the number is gets said every time: Apple proceeds are developer proceeds; the Google figure is an ESTIMATE of what buyers
 *   paid (tax included, Google's fee not deducted), never called proceeds.
 * - No data is `—`, never 0. Without any stored sales day the whole sales UI is hidden and `salesSetupHint` says how to turn it on.
 */

export type ProductSalesAmount = { currency: string; amount: number; refunds: number | null };
export type ProductSalesItem = {
  productId: string;
  units: number | null;
  amounts: ProductSalesAmount[];
  days: number;
};
export type ProductSalesView = {
  appId: string;
  platform: string;
  from: string;
  to: string;
  source: 'apple_sales' | 'play_sales';
  measure: 'apple_proceeds' | 'google_buyer_paid_estimate';
  unitsKind: 'units' | 'orders';
  hasSalesData: boolean;
  enabled: boolean;
  sales: {
    source: string;
    label: string;
    state: string;
    setup: { code: string; nextStep: string; optional: boolean; message: string } | null;
    lastOkAt: number | null;
    lastError: { code: string; message: string } | null;
  };
  products: ProductSalesItem[];
  notes: { code: string; message: string }[];
};

/** Whether sales are shown at all: only once a sales day of the app is stored. */
export const salesVisible = (view: ProductSalesView | null): view is ProductSalesView =>
  view !== null && view.hasSalesData;

export function salesByProduct(view: ProductSalesView | null): Map<string, ProductSalesItem> {
  const map = new Map<string, ProductSalesItem>();
  if (view) for (const item of view.products) map.set(item.productId, item);
  return map;
}

/** The amount of one currency as shown: Apple proceeds as they are (net of refunds); Google buyer-paid with its refunds taken off. */
export const shownAmount = (view: Pick<ProductSalesView, 'measure'>, a: ProductSalesAmount): number =>
  view.measure === 'google_buyer_paid_estimate' ? a.amount - (a.refunds ?? 0) : a.amount;

/** One line per currency, in that currency's own format. Never a sum over currencies. */
export function amountLines(view: ProductSalesView, item: ProductSalesItem | undefined): string[] {
  if (!item) return [];
  return item.amounts.map((a) => formatMoney(shownAmount(view, a), a.currency));
}

/** "12 units" or "3 orders"; empty when the store gave no count. */
export function unitsText(view: ProductSalesView, item: ProductSalesItem | undefined): string {
  if (!item || item.units === null) return '';
  return view.unitsKind === 'orders' ? t('analytics:sales.orders', { count: item.units }) : t('analytics:sales.units', { count: item.units });
}

/** The cell text lines of the column, or `['—']` when this product has no sales number in the range. */
export function salesCell(view: ProductSalesView, item: ProductSalesItem | undefined): string[] {
  const lines: string[] = [];
  const units = unitsText(view, item);
  if (units !== '') lines.push(units);
  lines.push(...amountLines(view, item));
  return lines.length === 0 ? ['—'] : lines;
}

/** What the number is, for the tooltip of the column header and the detail section. */
export function salesMeasureText(view: Pick<ProductSalesView, 'measure'>): string {
  return view.measure === 'apple_proceeds' ? t('analytics:sales.measureApple') : t('analytics:sales.measureGoogle');
}

/** The header of the sales column of the products table. */
export const salesColumnTitleText = (): string => t('analytics:sales.columnTitle');
/** @deprecated English only: use `salesColumnTitleText()` (or `t('analytics:sales.columnTitle')`). */
export const salesColumnTitle = 'Sales (28 days)';

/**
 * How to turn sales on, when none is stored. Words only (the setup is done under Settings and Analytics, and the Play Console).
 * Apple: the vendor number. Google: the reports bucket id and the Play Console permission View financial data.
 */
export function salesSetupHint(view: ProductSalesView | null, platformIsApple: boolean): string {
  const code = view?.sales.setup?.code ?? '';
  if (platformIsApple) {
    if (view !== null && !view.enabled)
      return t('analytics:sales.hintAppleOff');
    if (code === 'sales_forbidden')
      return t('analytics:sales.hintAppleForbidden');
    return t('analytics:sales.hintAppleVendor');
  }
  if (view !== null && !view.enabled)
    return t('analytics:sales.hintGoogleOff');
  if (code === 'bucket_id_missing')
    return t('analytics:sales.hintGoogleBucket');
  if (code === 'play_sales_forbidden')
    return t('analytics:sales.hintGoogleForbidden');
  return t('analytics:sales.hintGoogleWaiting');
}
