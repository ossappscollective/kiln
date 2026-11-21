import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalyticsError } from '@kiln/connectors';
import { addDays } from '@kiln/core';
import { dbTest } from '@kiln/db/testing';
import { newestExpectedMonth } from './query.ts';
import { type AnalyticsBoot, BUCKET, bootAnalytics, STORE_APP_ID, tsv } from './test-helpers.ts';

// Earnings and subscription metrics (docs/adr/0042-earnings-and-subscription-metrics.md). Fakes only.

const sync = (t: AnalyticsBoot, appId: string, body?: unknown) =>
  t.call(t.owner, 'POST', `/apps/${appId}/analytics/sync`, body);
const ym = (day: string) => day.slice(0, 4) + day.slice(5, 7);
/** The month `ago` months before the month of `t.day(0)`, as the first day of it. */
function monthAgo(t: AnalyticsBoot, ago: number): string {
  let y = Number(t.day(0).slice(0, 4));
  let m = Number(t.day(0).slice(5, 7)) - ago;
  while (m < 1) {
    m += 12;
    y -= 1;
  }
  return `${y}-${String(m).padStart(2, '0')}-01`;
}
const series = (body: { series: { id: string }[] }, id: string) =>
  body.series.find((s) => s.id === id) as
    | { id: string; total: number | null; currency?: string; cadence?: string; source: string; points: { date: string; value: number | null }[]; coverage: { state: string; notes: { code: string }[] } }
    | undefined;

async function androidApp(t: AnalyticsBoot) {
  await t.enable();
  const appId = await t.addApp('android');
  await t.setSettings({ 'analytics.playBucketId': `gs://${BUCKET}` });
  return appId;
}

dbTest('play earnings need the bucket id: skipped without it, with the next step in the status', async (db) => {
  const t = await bootAnalytics(db);
  await t.enable();
  const appId = await t.addApp('android');
  const res = await sync(t, appId, { sources: ['play_earnings', 'play_subscriptions'] });
  assert.deepEqual(
    res.body.sync.sources.map((s: { status: string; setup: string }) => [s.status, s.setup]),
    [
      ['skipped', 'bucket_id_missing'],
      ['skipped', 'bucket_id_missing'],
    ],
  );
  const earnings = res.body.status.sources.find((s: { source: string }) => s.source === 'play_earnings');
  assert.equal(earnings.setup.optional, true);
  assert.match(earnings.setup.message, /financial/i, 'the permission is named');
  assert.equal(t.built.filter((b) => b.kind === 'earnings').length, 0, 'no store contact without a bucket');
});

dbTest('play earnings: stored per currency on the first of the month, labelled monthly, never summed across currencies; a missing month is not an error', async (db) => {
  const t = await bootAnalytics(db);
  const appId = await androidApp(t);
  const last = monthAgo(t, 1);
  t.earnings.months.set(ym(last), [
    { date: last, metric: 'earnings_net', value: 120.5, dimension: { type: 'currency', value: 'EUR' } },
    { date: last, metric: 'earnings_net', value: 40, dimension: { type: 'currency', value: 'USD' } },
    { date: last, metric: 'earnings_charges', value: 170, dimension: { type: 'currency', value: 'EUR' } },
    { date: last, metric: 'earnings_orders', value: 31 },
  ]);
  const first = await sync(t, appId, { sources: ['play_earnings'] });
  assert.equal(first.body.sync.sources[0].status, 'ok');
  assert.ok(first.body.sync.sources[0].points >= 4);
  assert.equal(t.earnings.asked.length, 6, 'a first read goes six months back');
  assert.equal(t.built.find((b) => b.kind === 'earnings')?.bucketId, BUCKET);
  const again = await sync(t, appId, { sources: ['play_earnings'] });
  assert.equal(again.body.sync.pointsWritten, 0);
  assert.equal(t.earnings.asked.length, 8, 'later reads take the current and the previous month');

  const res = await t.call(
    t.owner,
    'GET',
    `/apps/${appId}/analytics/overview?from=${addDays(last, -1)}&to=${t.day(1)}&granularity=month`,
  );
  const ids = res.body.series.map((s: { id: string }) => s.id);
  assert.ok(ids.includes('earnings_net:EUR') && ids.includes('earnings_net:USD'));
  assert.ok(!ids.includes('earnings_net'), 'no sum over currencies');
  const eur = series(res.body, 'earnings_net:EUR');
  assert.equal(eur?.total, 120.5);
  assert.equal(eur?.currency, 'EUR');
  assert.equal(eur?.cadence, 'monthly');
  assert.equal(eur?.source, 'play_earnings');
  const codes = eur?.coverage.notes.map((n) => n.code) ?? [];
  for (const code of ['play_earnings_monthly', 'play_earnings_net', 'play_earnings_per_currency'])
    assert.ok(codes.includes(code), code);
  assert.ok(!codes.includes('gaps') && !codes.includes('recent_days_incomplete'), 'month figures have no daily gaps');
  // Gross (charges) is a separate series of the same currency, not a second number inside the net one.
  assert.equal(series(res.body, 'earnings_charges:EUR')?.total, 170);
  assert.equal(series(res.body, 'earnings_orders')?.total, 31);
});

dbTest('play earnings: a refused folder is play_sales_forbidden with the financial-permission step; other sources are untouched', async (db) => {
  const t = await bootAnalytics(db);
  const appId = await androidApp(t);
  t.earnings.error = new AnalyticsError('play_sales_forbidden');
  t.subscriptions.error = new AnalyticsError('play_sales_forbidden');
  const res = await sync(t, appId, { sources: ['play_earnings', 'play_subscriptions'] });
  for (const r of res.body.sync.sources) assert.equal(r.errorCode, 'play_sales_forbidden');
  const status = res.body.status.sources.find((s: { source: string }) => s.source === 'play_earnings');
  assert.equal(status.lastError.code, 'play_sales_forbidden');
  assert.match(status.lastError.message, /financial/i);
});

dbTest('play earnings: a bucket without any earnings file yet stores nothing and says so only through the coverage', async (db) => {
  const t = await bootAnalytics(db);
  const appId = await androidApp(t);
  const res = await sync(t, appId, { sources: ['play_earnings'] });
  assert.equal(res.body.sync.sources[0].status, 'ok');
  assert.equal(res.body.sync.pointsWritten, 0);
  const overview = await t.call(t.owner, 'GET', `/apps/${appId}/analytics/overview?granularity=month`);
  const net = series(overview.body, 'earnings_net');
  assert.equal(net?.total ?? null, null);
  assert.equal(net?.coverage.state, 'none');
});

dbTest('play subscriptions: counts are unitless levels, per product; a month without a file is skipped', async (db) => {
  const t = await bootAnalytics(db);
  const appId = await androidApp(t);
  const day = t.day(3);
  t.subscriptions.months.set(ym(day), [
    { date: day, metric: 'play_subscriptions_active', value: 80 },
    { date: day, metric: 'play_subscriptions_active', value: 60, dimension: { type: 'product', value: 'pro_monthly' } },
    { date: day, metric: 'play_subscriptions_new', value: 7 },
    { date: day, metric: 'play_subscriptions_cancelled', value: 2 },
  ]);
  const run = await sync(t, appId, { sources: ['play_subscriptions'] });
  assert.equal(run.body.sync.sources[0].status, 'ok');
  const res = await t.call(
    t.owner,
    'GET',
    `/apps/${appId}/analytics/overview?from=${t.day(10)}&to=${t.day(1)}&breakdown=product`,
  );
  const active = series(res.body, 'play_subscriptions_active');
  assert.equal(active?.currency ?? null, null, 'a count has no currency');
  assert.equal(active?.source, 'play_subscriptions');
  assert.equal(active?.total, 80);
  assert.equal(series(res.body, 'play_subscriptions_cancelled')?.total, 2);
  const items = (res.body.series.find((s: { id: string }) => s.id === 'play_subscriptions_active') as { breakdown?: { items: unknown[] } })
    .breakdown?.items;
  assert.deepEqual(items, [{ value: 'pro_monthly', total: 60 }]);
});

// ---- Apple ---------------------------------------------------------------------------------------------------------

const SUB_HEADER = [
  'App Apple ID',
  'Subscription Apple ID',
  'Standard Subscription Duration',
  'Device',
  'Active Standard Price Subscriptions',
  'Active Free Trial Introductory Offer Subscriptions',
];
const EVENT_HEADER = [
  'Event Date',
  'Event',
  'App Apple ID',
  'Subscription Apple ID',
  'Standard Subscription Duration',
  'Subscription Offer Type',
  'Device',
  'Quantity',
];

async function iosApp(t: AnalyticsBoot) {
  await t.enable();
  const appId = await t.addApp('ios');
  await t.setSettings({ 'analytics.appleVendorNumber': '85123456' });
  return appId;
}

dbTest('apple subscriptions need the vendor number: skipped without it', async (db) => {
  const t = await bootAnalytics(db);
  await t.enable();
  const appId = await t.addApp('ios');
  const res = await sync(t, appId, { sources: ['apple_subscriptions'] });
  assert.deepEqual([res.body.sync.sources[0].status, res.body.sync.sources[0].setup], ['skipped', 'vendor_number_missing']);
  assert.deepEqual(t.apple.subscriptionsAsked, [], 'no store contact without a vendor number');
});

dbTest('apple subscriptions: active counts from the Subscription report, new and cancelled from the events; counts only, no money', async (db) => {
  const t = await bootAnalytics(db);
  const appId = await iosApp(t);
  const day = t.day(2);
  t.apple.subscriptions.set(
    `subscription:${day}`,
    tsv([
      SUB_HEADER,
      [STORE_APP_ID, '6001', '1 Month', 'iPhone', '40', '5'],
      [STORE_APP_ID, '6001', '1 Month', 'iPad', '10', '0'],
      ['555', '7001', '1 Month', 'iPhone', '999', '0'],
    ]),
  );
  t.apple.subscriptions.set(
    `subscription_event:${day}`,
    tsv([
      EVENT_HEADER,
      [day, 'Subscribe', STORE_APP_ID, '6001', '1 Month', '', 'iPhone', '4'],
      [day, 'Cancel', STORE_APP_ID, '6001', '1 Month', '', 'iPhone', '3'],
      [day, 'Renew', STORE_APP_ID, '6001', '1 Month', '', 'iPhone', '50'],
    ]),
  );
  const run = await sync(t, appId, { sources: ['apple_subscriptions'] });
  assert.equal(run.body.sync.sources[0].status, 'ok');
  assert.ok(t.apple.subscriptionsAsked.includes(`subscription:${day}`));
  assert.ok(t.apple.subscriptionsAsked.includes(`subscription_event:${day}`));
  const res = await t.call(t.owner, 'GET', `/apps/${appId}/analytics/overview?from=${t.day(5)}&to=${t.day(1)}`);
  const active = series(res.body, 'subscriptions_active');
  assert.equal(active?.total, 50);
  assert.equal(active?.currency ?? null, null);
  assert.equal(active?.source, 'apple_subscriptions');
  assert.equal(series(res.body, 'subscriptions_active_trial')?.total, 5);
  assert.equal(series(res.body, 'subscriptions_new')?.total, 4);
  assert.equal(series(res.body, 'subscriptions_cancelled')?.total, 3);
  const codes = active?.coverage.notes.map((n) => n.code) ?? [];
  assert.ok(codes.includes('apple_subscription_counts'));
  const again = await sync(t, appId, { sources: ['apple_subscriptions'] });
  assert.equal(again.body.sync.pointsWritten, 0, 'a second sync changes nothing');
});

dbTest('apple subscriptions: a day Apple has no report for is skipped, not an error', async (db) => {
  const t = await bootAnalytics(db);
  const appId = await iosApp(t);
  const run = await sync(t, appId, { sources: ['apple_subscriptions'] });
  assert.equal(run.body.sync.sources[0].status, 'ok');
  assert.equal(run.body.sync.pointsWritten, 0);
});

test('newestExpectedMonth: the report of a month is expected once the 6th of the next month is over', () => {
  assert.equal(newestExpectedMonth('2026-11-21'), '2026-10-01');
  assert.equal(newestExpectedMonth('2026-11-07'), '2026-10-01');
  assert.equal(newestExpectedMonth('2026-11-06'), '2026-09-01');
  assert.equal(newestExpectedMonth('2026-01-10'), '2025-12-01');
  assert.equal(newestExpectedMonth('2026-01-03'), '2025-11-01');
});
