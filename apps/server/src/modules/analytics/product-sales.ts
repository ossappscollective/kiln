import type { AnalyticsPoint } from '@mrm/connectors';
import {
  type AnalyticsMetric,
  type AnalyticsSource,
  type CoverageNoteCode,
  coverageNoteMessages,
  moneyMetrics,
  productSalesLimits,
  splitProductDimValue,
  supports,
} from '@mrm/core';
import type { Sql } from '@mrm/db';
import type { ManagedApp } from '../../services/apps.ts';
import { type AnalyticsStatus, type Note, type SourceStatus, status } from './query.ts';

/**
 * Per-product sales (docs/adr/0038-sales-analytics.md): the daily sales facts stored under the dimension `product`. Both stores,
 * one shape: Apple Sales and Trends (units and proceeds by SKU, in-app purchases included) and Google Play estimated sales (orders
 * and buyer-paid amounts by SKU ID). Money is kept PER CURRENCY and is never converted or added across currencies. This file holds
 * the storage bound (`capProductPoints`) and the read side (`productSales`); the readers of the stores are in sync.ts.
 */

const isMoney = (metric: AnalyticsMetric) => moneyMetrics.indexOf(metric) >= 0;

/** The id of the product a stored `product` point belongs to. */
const productOf = (point: AnalyticsPoint): string | undefined =>
  point.dimension?.type === 'product'
    ? splitProductDimValue(point.dimension.value, isMoney(point.metric)).productId
    : undefined;

/**
 * Keeps the storage bounded: at most `productSalesLimits.maxProductsPerApp` distinct products per app and source. Products already
 * stored stay; new ones are taken by volume (orders or units, then amount) until the cap. Totals and per-currency points are never
 * dropped. Returns what was dropped, so a note can say so.
 */
export function capProductPoints(
  points: AnalyticsPoint[],
  known: ReadonlySet<string>,
  max: number = productSalesLimits.maxProductsPerApp,
): { points: AnalyticsPoint[]; droppedProducts: number } {
  const volume = new Map<string, number>();
  for (const p of points) {
    const id = productOf(p);
    if (id === undefined || known.has(id)) continue;
    volume.set(id, (volume.get(id) ?? 0) + Math.abs(p.value) * (isMoney(p.metric) ? 0.001 : 1));
  }
  const room = Math.max(0, max - known.size);
  const ranked = [...volume.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const keep = new Set(ranked.slice(0, room).map(([id]) => id));
  const kept = points.filter((p) => {
    const id = productOf(p);
    return id === undefined || known.has(id) || keep.has(id);
  });
  return { points: kept, droppedProducts: Math.max(0, ranked.length - keep.size) };
}

/** The products already stored for an app and source (to apply the cap against). */
export async function storedProductIds(
  sql: Sql,
  input: { workspaceId: string; appId: string; platform: string; source: AnalyticsSource },
): Promise<Set<string>> {
  const rows = await sql.query(
    `SELECT DISTINCT metric, dim_value FROM analytics_daily
      WHERE workspace_id = ? AND app_id = ? AND platform = ? AND source = ? AND dim_type = 'product'`,
    [input.workspaceId, input.appId, input.platform, input.source],
  );
  const ids = new Set<string>();
  for (const r of rows)
    ids.add(
      splitProductDimValue(String(r.dim_value), isMoney(String(r.metric) as AnalyticsMetric))
        .productId,
    );
  return ids;
}

/** The product ids of the app as the Products page has them (the stored snapshot; no store is called). */
export async function storedStoreProductIds(
  sql: Sql,
  workspaceId: string,
  appId: string,
): Promise<Set<string>> {
  const rows = await sql.query(
    'SELECT product_id FROM store_products WHERE app_id = ? AND workspace_id = ?',
    [appId, workspaceId],
  );
  return new Set(rows.map((r) => String(r.product_id)));
}

// ---------------------------------------------------------------------------------------------
// The read side

export type ProductSalesAmount = {
  /** ISO 4217. Amounts of two currencies are never added. */
  currency: string;
  /**
   * Apple: developer proceeds (already net of refunds, which Apple reports as negative units). Google: the amounts buyers were
   * charged (tax included, Google's fee NOT deducted).
   */
  amount: number;
  /** Google: what was refunded in the range (a positive number); null for Apple, whose `amount` is already net. */
  refunds: number | null;
};

export type ProductSalesItem = {
  productId: string;
  /** Apple: net units (refunds are negative). Google: charged orders. Null when the store gave no count for the product. */
  units: number | null;
  amounts: ProductSalesAmount[];
  /** Days of the range with a value for this product. */
  days: number;
};

export type ProductSales = {
  appId: string;
  platform: string;
  from: string;
  to: string;
  /** The store source the numbers come from. */
  source: 'apple_sales' | 'play_sales';
  /** What `amount` is: `apple_proceeds` (developer proceeds) or `google_buyer_paid_estimate` (buyer-paid, estimated). */
  measure: 'apple_proceeds' | 'google_buyer_paid_estimate';
  /** What `units` counts: `units` (Apple) or `orders` (Google). */
  unitsKind: 'units' | 'orders';
  /** Whether any sales day of this app is stored at all (in any range). When false a client hides its sales UI and shows `source.setup`. */
  hasSalesData: boolean;
  /** The workspace setting `analytics.enabled`. */
  enabled: boolean;
  /** The sales source of the app: its state and what is still needed. */
  sales: Pick<SourceStatus, 'source' | 'label' | 'state' | 'setup' | 'lastOkAt' | 'lastError'>;
  products: ProductSalesItem[];
  notes: Note[];
};

const note = (code: CoverageNoteCode): Note => ({ code, message: coverageNoteMessages[code] });

export async function productSales(
  sql: Sql,
  input: {
    workspaceId: string;
    app: ManagedApp;
    from: string;
    to: string;
    intervalMinutes: number;
  },
): Promise<ProductSales> {
  const { app } = input;
  const google = supports(app.platform, 'playReportsBucket');
  const source = google ? ('play_sales' as const) : ('apple_sales' as const);
  const unitsMetric: AnalyticsMetric = google ? 'sales_orders' : 'sales_units';
  const amountMetric: AnalyticsMetric = google ? 'sales_gross' : 'sales_proceeds';
  const st: AnalyticsStatus = await status(sql, {
    workspaceId: input.workspaceId,
    app,
    intervalMinutes: input.intervalMinutes,
  });
  const entry = st.sources.find((s) => s.source === source);
  const sales: ProductSales['sales'] = entry
    ? {
        source: entry.source,
        label: entry.label,
        state: entry.state,
        setup: entry.setup,
        lastOkAt: entry.lastOkAt,
        lastError: entry.lastError,
      }
    : {
        source,
        label: '',
        state: 'needs_setup',
        setup: null,
        lastOkAt: null,
        lastError: null,
      };
  const hasSalesData = entry !== undefined && entry.firstDay !== null;

  const rows = await sql.query(
    `SELECT metric, day, dim_value, value_micro FROM analytics_daily
      WHERE workspace_id = ? AND app_id = ? AND platform = ? AND source = ? AND dim_type = 'product'
        AND day >= ? AND day <= ? AND metric IN (?, ?, ?)`,
    [
      input.workspaceId,
      app.id,
      app.platform,
      source,
      input.from,
      input.to,
      unitsMetric,
      amountMetric,
      'sales_refunds',
    ],
  );
  type Acc = {
    units: number | null;
    amounts: Map<string, { amount: number; refunds: number | null }>;
    days: Set<string>;
  };
  const byProduct = new Map<string, Acc>();
  const accOf = (id: string): Acc => {
    let found = byProduct.get(id);
    if (!found) {
      found = { units: null, amounts: new Map(), days: new Set() };
      byProduct.set(id, found);
    }
    return found;
  };
  for (const r of rows) {
    const metric = String(r.metric) as AnalyticsMetric;
    const value = Number(r.value_micro) / 1_000_000;
    const { productId, currency } = splitProductDimValue(String(r.dim_value), isMoney(metric));
    const acc = accOf(productId);
    acc.days.add(String(r.day));
    if (metric === unitsMetric) acc.units = (acc.units ?? 0) + value;
    else if (currency !== null) {
      const cur = acc.amounts.get(currency) ?? { amount: 0, refunds: google ? 0 : null };
      if (metric === amountMetric) cur.amount += value;
      else if (google && cur.refunds !== null) cur.refunds += value;
      acc.amounts.set(currency, cur);
    }
  }
  const products: ProductSalesItem[] = [...byProduct.entries()]
    .map(([productId, acc]) => ({
      productId,
      units: acc.units,
      amounts: [...acc.amounts.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([currency, v]) => ({ currency, amount: v.amount, refunds: v.refunds })),
      days: acc.days.size,
    }))
    .sort((a, b) => (b.units ?? 0) - (a.units ?? 0) || (a.productId < b.productId ? -1 : 1));

  const stored = await storedProductIds(sql, {
    workspaceId: input.workspaceId,
    appId: app.id,
    platform: app.platform,
    source,
  });
  const notes: Note[] = google
    ? [
        note('play_estimated_sales_gross'),
        note('play_sales_per_currency'),
        note('play_sales_latency'),
        note('play_sales_utc'),
      ]
    : [
        note('apple_proceeds_per_currency'),
        note('apple_estimates'),
        note('apple_pacific_time'),
        note('apple_product_sales_include_in_app'),
      ];
  if (stored.size >= productSalesLimits.maxProductsPerApp) notes.push(note('sales_products_capped'));
  return {
    appId: app.id,
    platform: app.platform,
    from: input.from,
    to: input.to,
    source,
    measure: google ? 'google_buyer_paid_estimate' : 'apple_proceeds',
    unitsKind: google ? 'orders' : 'units',
    hasSalesData,
    enabled: st.enabled,
    sales,
    products,
    notes,
  };
}
