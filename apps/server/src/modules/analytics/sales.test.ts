import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AnalyticsPoint } from '@kiln/connectors';
import { AnalyticsError } from '@kiln/connectors';
import { productSalesLimits } from '@kiln/core';
import { dbTest } from '@kiln/db/testing';
import { capProductPoints } from './product-sales.ts';
import { type AnalyticsBoot, BUCKET, bootAnalytics, mdy, salesTsv } from './test-helpers.ts';

// Sales analytics (docs/adr/0038-sales-analytics.md): Google Play estimated sales, and sales by product for both stores. Fakes only.

const sync = (t: AnalyticsBoot, appId: string, body?: unknown) =>
  t.call(t.owner, 'POST', `/apps/${appId}/analytics/sync`, body);
const month = (t: AnalyticsBoot, ago: number) => t.day(ago).slice(0, 4) + t.day(ago).slice(5, 7);

/** A day of Play sales: two EUR orders of coins, one USD order of the subscription, one EUR refund. */
const playDay = (date: string): AnalyticsPoint[] => [
  { date, metric: 'sales_orders', value: 3 },
  { date, metric: 'sales_orders', value: 2, dimension: { type: 'product', value: 'coins_100' } },
  { date, metric: 'sales_orders', value: 1, dimension: { type: 'product', value: 'pro_monthly' } },
  { date, metric: 'sales_gross', value: 4.74, dimension: { type: 'currency', value: 'EUR' } },
  { date, metric: 'sales_gross', value: 4.99, dimension: { type: 'currency', value: 'USD' } },
  {
    date,
    metric: 'sales_gross',
    value: 4.74,
    dimension: { type: 'product', value: 'EUR:coins_100' },
  },
  {
    date,
    metric: 'sales_gross',
    value: 4.99,
    dimension: { type: 'product', value: 'USD:pro_monthly' },
  },
  { date, metric: 'sales_refunds', value: 2.37, dimension: { type: 'currency', value: 'EUR' } },
  {
    date,
    metric: 'sales_refunds',
    value: 2.37,
    dimension: { type: 'product', value: 'EUR:coins_100' },
  },
];

async function androidApp(t: AnalyticsBoot) {
  await t.enable();
  const appId = await t.addApp('android');
  await t.setSettings({ 'analytics.playBucketId': `gs://${BUCKET}` });
  return appId;
}

dbTest(
  'play sales need the bucket id: skipped without it, a next step in the status',
  async (db) => {
    const t = await bootAnalytics(db);
    await t.enable();
    const appId = await t.addApp('android');
    const res = await sync(t, appId, { sources: ['play_sales'] });
    assert.deepEqual(
      [res.body.sync.sources[0].status, res.body.sync.sources[0].setup],
      ['skipped', 'bucket_id_missing'],
    );
    const sales = res.body.status.sources.find(
      (s: { source: string }) => s.source === 'play_sales',
    );
    assert.equal(sales.setup.optional, true);
    assert.equal(sales.label, 'Play Console sales reports');
    assert.equal(
      t.built.filter((b) => b.kind === 'sales').length,
      0,
      'no store contact without a bucket',
    );
  },
);

dbTest(
  'play sales are stored per currency and per product, never as proceeds, and a second sync changes nothing',
  async (db) => {
    const t = await bootAnalytics(db);
    const appId = await androidApp(t);
    t.sales.months.set(month(t, 0), playDay(t.day(3)));
    const first = await sync(t, appId, { sources: ['play_sales'] });
    assert.equal(first.body.sync.sources[0].status, 'ok');
    assert.ok(first.body.sync.sources[0].points > 0);
    assert.equal(t.sales.asked.length, 3, 'a first read takes three months');
    assert.equal(t.built.find((b) => b.kind === 'sales')?.bucketId, BUCKET);
    const again = await sync(t, appId, { sources: ['play_sales'] });
    assert.equal(again.body.sync.pointsWritten, 0);
    assert.equal(t.sales.asked.length, 5);

    const res = await t.call(
      t.owner,
      'GET',
      `/apps/${appId}/analytics/overview?from=${t.day(10)}&to=${t.day(1)}`,
    );
    const ids = res.body.series.map((s: { id: string }) => s.id);
    assert.ok(ids.includes('sales_gross:EUR') && ids.includes('sales_gross:USD'));
    assert.ok(ids.includes('sales_refunds:EUR'));
    assert.ok(
      !ids.some((id: string) => id.startsWith('sales_proceeds')),
      'Android has no proceeds',
    );
    const eur = res.body.series.find((s: { id: string }) => s.id === 'sales_gross:EUR');
    assert.equal(eur.total, 4.74);
    assert.equal(eur.currency, 'EUR');
    assert.equal(eur.source, 'play_sales');
    assert.ok(!/proceeds/i.test(eur.label), eur.label);
    const codes = eur.coverage.notes.map((n: { code: string }) => n.code);
    for (const code of [
      'play_estimated_sales_gross',
      'play_sales_latency',
      'play_sales_utc',
      'play_sales_per_currency',
    ])
      assert.ok(codes.includes(code), code);
    const orders = res.body.series.find((s: { id: string }) => s.id === 'sales_orders');
    assert.equal(orders.total, 3);
    assert.equal(
      res.body.series.find((s: { id: string }) => s.id === 'sales_gross')?.id,
      undefined,
      'no sum over currencies',
    );
  },
);

dbTest('breakdown=product: the top products of a series, of its own currency only', async (db) => {
  const t = await bootAnalytics(db);
  const appId = await androidApp(t);
  t.sales.months.set(month(t, 0), playDay(t.day(3)));
  await sync(t, appId, { sources: ['play_sales'] });
  const res = await t.call(
    t.owner,
    'GET',
    `/apps/${appId}/analytics/overview?from=${t.day(10)}&to=${t.day(1)}&breakdown=product`,
  );
  const by = (id: string) => res.body.series.find((s: { id: string }) => s.id === id)?.breakdown;
  assert.deepEqual(by('sales_gross:EUR'), {
    dimension: 'product',
    items: [{ value: 'coins_100', total: 4.74 }],
  });
  assert.deepEqual(by('sales_gross:USD'), {
    dimension: 'product',
    items: [{ value: 'pro_monthly', total: 4.99 }],
  });
  assert.deepEqual(by('sales_orders').items, [
    { value: 'coins_100', total: 2 },
    { value: 'pro_monthly', total: 1 },
  ]);
  const bad = await t.call(t.owner, 'GET', `/apps/${appId}/analytics/overview?breakdown=sku`);
  assert.equal(bad.status, 400);
});

dbTest(
  'product-sales (Android): per product, per currency, refunds apart; what the amount is is said',
  async (db) => {
    const t = await bootAnalytics(db);
    const appId = await androidApp(t);
    const before = await t.call(t.owner, 'GET', `/apps/${appId}/analytics/product-sales`);
    assert.equal(before.status, 200);
    assert.equal(before.body.hasSalesData, false);
    assert.deepEqual(before.body.products, []);
    assert.equal(before.body.sales.source, 'play_sales');
    assert.equal(before.body.sales.setup.code, 'first_sync_pending');

    t.sales.months.set(month(t, 0), playDay(t.day(3)));
    await sync(t, appId, { sources: ['play_sales'] });
    const res = await t.call(t.owner, 'GET', `/apps/${appId}/analytics/product-sales`);
    assert.equal(res.body.hasSalesData, true);
    assert.equal(res.body.measure, 'google_buyer_paid_estimate');
    assert.equal(res.body.unitsKind, 'orders');
    assert.deepEqual(
      res.body.products.map((p: { productId: string }) => p.productId),
      ['coins_100', 'pro_monthly'],
    );
    const coins = res.body.products[0];
    assert.equal(coins.units, 2);
    assert.deepEqual(coins.amounts, [{ currency: 'EUR', amount: 4.74, refunds: 2.37 }]);
    assert.deepEqual(res.body.products[1].amounts, [{ currency: 'USD', amount: 4.99, refunds: 0 }]);
    const codes = res.body.notes.map((n: { code: string }) => n.code);
    assert.ok(codes.includes('play_estimated_sales_gross'));
    assert.ok(!codes.includes('apple_proceeds_per_currency'));
    // A range with no sale has no product, but the app still has sales data.
    const old = await t.call(
      t.owner,
      'GET',
      `/apps/${appId}/analytics/product-sales?from=${t.day(80)}&to=${t.day(70)}`,
    );
    assert.deepEqual(old.body.products, []);
    assert.equal(old.body.hasSalesData, true);
  },
);

dbTest(
  'product-sales (iOS): units and proceeds by SKU; the total chart is untouched',
  async (db) => {
    const t = await bootAnalytics(db);
    await t.enable();
    const appId = await t.addApp('ios');
    await t.setSettings({ 'analytics.appleVendorNumber': '85123456' });
    t.apple.sales.set(t.day(2), salesTsv(mdy(t.day(2))));
    const run = await sync(t, appId, { sources: ['apple_sales'] });
    assert.equal(run.body.sync.sources[0].status, 'ok');
    const res = await t.call(t.owner, 'GET', `/apps/${appId}/analytics/product-sales`);
    assert.equal(res.body.measure, 'apple_proceeds');
    assert.equal(res.body.unitsKind, 'units');
    assert.equal(res.body.hasSalesData, true);
    assert.equal(res.body.products.length, 1);
    const p = res.body.products[0];
    assert.equal(p.productId, 'coffee-sku');
    assert.equal(p.units, 14);
    assert.deepEqual(p.amounts, [
      { currency: 'EUR', amount: 9.96, refunds: null },
      { currency: 'USD', amount: 29.9, refunds: null },
    ]);
    const overview = await t.call(
      t.owner,
      'GET',
      `/apps/${appId}/analytics/overview?from=${t.day(5)}&to=${t.day(1)}`,
    );
    assert.equal(
      overview.body.series.find((s: { id: string }) => s.id === 'sales_proceeds:USD').total,
      29.9,
    );
    assert.equal(
      overview.body.series.find((s: { id: string }) => s.id === 'sales_units').total,
      14,
    );
  },
);

dbTest(
  'a refused sales folder is play_sales_forbidden with the financial-permission step; vitals and reports are not touched',
  async (db) => {
    const t = await bootAnalytics(db);
    const appId = await androidApp(t);
    t.sales.error = new AnalyticsError('play_sales_forbidden');
    const res = await sync(t, appId, { sources: ['play_sales'] });
    assert.deepEqual(
      [res.body.sync.sources[0].status, res.body.sync.sources[0].errorCode],
      ['failed', 'play_sales_forbidden'],
    );
    const sales = res.body.status.sources.find(
      (s: { source: string }) => s.source === 'play_sales',
    );
    assert.equal(sales.setup.code, 'play_sales_forbidden');
    assert.equal(sales.setup.nextStep, 'grant_play_financial_permission');
    assert.equal(sales.setup.optional, true);
    assert.match(sales.setup.message, /View financial data/);
    assert.match(sales.lastError.message, /Global/);
    const product = await t.call(t.owner, 'GET', `/apps/${appId}/analytics/product-sales`);
    assert.equal(product.body.hasSalesData, false);
    assert.equal(product.body.sales.setup.code, 'play_sales_forbidden');
  },
);

dbTest(
  'a month without a sales file is expected: the sync is ok, with no data and no error',
  async (db) => {
    const t = await bootAnalytics(db);
    const appId = await androidApp(t);
    const res = await sync(t, appId, { sources: ['play_sales'] });
    assert.equal(res.body.sync.sources[0].status, 'ok');
    assert.equal(res.body.sync.sources[0].points, 0);
    assert.equal(
      res.body.status.sources.find((s: { source: string }) => s.source === 'play_sales').lastError,
      null,
    );
  },
);

dbTest(
  'the products of an app are capped: known ones stay, new ones are taken by volume, totals are kept',
  async (db) => {
    const t = await bootAnalytics(db);
    const appId = await androidApp(t);
    const points: AnalyticsPoint[] = [{ date: t.day(3), metric: 'sales_orders', value: 999 }];
    for (let i = 0; i < productSalesLimits.maxProductsPerApp + 5; i++)
      points.push({
        date: t.day(3),
        metric: 'sales_orders',
        value: i + 1,
        dimension: { type: 'product', value: `sku_${String(i).padStart(3, '0')}` },
      });
    t.sales.months.set(month(t, 0), points);
    await sync(t, appId, { sources: ['play_sales'] });
    const distinct = await t.rows(
      "SELECT COUNT(DISTINCT dim_value) AS n FROM analytics_daily WHERE source = 'play_sales' AND dim_type = 'product'",
    );
    assert.equal(Number(distinct[0]?.n), productSalesLimits.maxProductsPerApp);
    const total = await t.rows(
      "SELECT value_micro FROM analytics_daily WHERE source = 'play_sales' AND dim_type = '' AND metric = 'sales_orders'",
    );
    assert.equal(Number(total[0]?.value_micro), 999 * 1_000_000, 'the total is never dropped');
    const lowest = await t.rows(
      "SELECT COUNT(*) AS n FROM analytics_daily WHERE dim_type = 'product' AND dim_value = 'sku_000'",
    );
    assert.equal(Number(lowest[0]?.n), 0, 'the product with the least volume was left out');
    const res = await t.call(t.owner, 'GET', `/apps/${appId}/analytics/product-sales`);
    assert.equal(res.body.products.length, productSalesLimits.maxProductsPerApp);
    assert.ok(res.body.notes.some((n: { code: string }) => n.code === 'sales_products_capped'));
  },
);

test('capProductPoints: totals and per-currency points always stay; money counts by its product id', () => {
  const d = '2026-11-10';
  const points: AnalyticsPoint[] = [
    { date: d, metric: 'sales_gross', value: 1, dimension: { type: 'currency', value: 'EUR' } },
    { date: d, metric: 'sales_gross', value: 5, dimension: { type: 'product', value: 'EUR:a' } },
    { date: d, metric: 'sales_gross', value: 5, dimension: { type: 'product', value: 'USD:a' } },
    { date: d, metric: 'sales_orders', value: 1, dimension: { type: 'product', value: 'a' } },
    { date: d, metric: 'sales_orders', value: 9, dimension: { type: 'product', value: 'b' } },
  ];
  const r = capProductPoints(points, new Set(), 1);
  assert.equal(r.droppedProducts, 1);
  // 'b' sold more orders than 'a': it is the one kept.
  const kept = new Set(r.points.map((p) => p.dimension?.value));
  assert.ok(kept.has('EUR') && kept.has('b'));
  assert.ok(!kept.has('a') && !kept.has('EUR:a') && !kept.has('USD:a'));
  const keepKnown = capProductPoints(points, new Set(['a']), 1);
  assert.equal(keepKnown.droppedProducts, 1);
  assert.ok(
    keepKnown.points.some((p) => p.dimension?.value === 'EUR:a'),
    'a known product stays',
  );
  assert.ok(!keepKnown.points.some((p) => p.dimension?.value === 'b'));
});
