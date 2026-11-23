import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as ax from '../analytics.fixtures.ts';
import { AnalyticsError } from '../analytics-types.ts';
import { parseTable } from '../delimited.ts';
import * as fx from '../store.fixtures.ts';
import { mapPlaySubscriptionsTable, PlaySubscriptionsConnector } from './play-subscriptions.ts';

const T0 = Date.UTC(2026, 10, 21, 12, 0, 0);
const account = fx.serviceAccountJson(fx.googleKeyPem().privateKey);
const PKG = ax.PACKAGE;
const MONTH = '202611';
const NAME = (product: string, dim = 'country') =>
  `financial-stats/subscriptions/subscriptions_${PKG}_${product}_${MONTH}_${dim}.csv`;

// The documented columns of the subscription statistics (answer 6135870), in the documented order.
const HEADER = [
  'Date',
  'Package Name',
  'Product ID',
  'Country',
  'New Subscriptions',
  'Canceled Subscriptions',
  'Active Subscriptions',
  'Base Plan ID',
  'Offer ID',
];
const row = (
  date: string,
  product: string,
  country: string,
  nw: string,
  cancel: string,
  active: string,
  pkg = PKG,
) => [date, pkg, product, country, nw, cancel, active, 'monthly', ''];
const PRO = ax.csv([
  HEADER,
  row('2026-11-01', 'pro', 'DE', '2', '1', '40'),
  row('2026-11-01', 'pro', 'US', '3', '0', '60'),
  row('2026-11-02', 'pro', 'DE', '1', '2', '39'),
  row('2026-11-02', 'pro', 'US', '0', '1', '59'),
  row('2026-11-02', 'pro', 'FR', 'x', 'y', 'z'),
  row('not a date', 'pro', 'FR', '1', '1', '1'),
  row('2026-11-02', 'pro', 'FR', '9', '9', '9', 'com.example.other'),
]);
const PLUS = ax.csv([HEADER, row('2026-11-01', 'plus', 'DE', '1', '0', '5')]);

type P = {
  date: string;
  metric: string;
  value: number;
  dimension?: { type: string; value: string };
};
const find = (points: P[], date: string, metric: string, dim?: string) =>
  points.find(
    (p) =>
      p.date === date &&
      p.metric === metric &&
      (dim === undefined
        ? p.dimension === undefined
        : `${p.dimension?.type}:${p.dimension?.value}` === dim),
  )?.value;

test('mapPlaySubscriptionsTable: counts per day over the rows (countries), the active level, and per product', () => {
  const r = mapPlaySubscriptionsTable(parseTable(PRO), { packageName: PKG });
  const p = r.points;
  assert.equal(find(p, '2026-11-01', 'play_subscriptions_new'), 5);
  assert.equal(find(p, '2026-11-01', 'play_subscriptions_cancelled'), 1);
  assert.equal(find(p, '2026-11-01', 'play_subscriptions_active'), 100);
  assert.equal(find(p, '2026-11-02', 'play_subscriptions_active'), 98);
  assert.equal(find(p, '2026-11-02', 'play_subscriptions_new', 'product:pro'), 1);
  assert.equal(r.stats.rowsRead, 7);
  assert.equal(r.stats.rowsUsed, 4);
  assert.equal(r.stats.rowsUnreadable, 2);
  assert.equal(r.stats.rowsFiltered, 1);
  assert.ok(!p.some((x) => x.value === 9), 'the other app is not in it');
});

test('mapPlaySubscriptionsTable: the product of the file name is used when a row has none; a table without date and counts is refused', () => {
  const noProduct = ax.csv([
    ['Date', 'New Subscriptions'],
    ['2026-11-01', '4'],
  ]);
  const r = mapPlaySubscriptionsTable(parseTable(noProduct), { fallbackProduct: 'gold' });
  assert.equal(find(r.points, '2026-11-01', 'play_subscriptions_new', 'product:gold'), 4);
  assert.throws(
    () => mapPlaySubscriptionsTable(parseTable('Country\nDE\n'), {}),
    (e: unknown) => e instanceof AnalyticsError && e.code === 'missing_columns',
  );
});

/** `statsOpen`: the status applies to every folder but `stats/` (a service account that may read the statistics only). */
function bucket(files: Record<string, Uint8Array | string>, status?: number, statsOpen = false) {
  const fake = new ax.RouteFetch();
  fake.on('POST', '/token', { json: fx.googleToken });
  fake.on('GET', new RegExp(`/storage/v1/b/${ax.BUCKET}/o\\?`), (_n, call) => {
    const prefix = call.url.searchParams.get('prefix') ?? '';
    if (status && !(statsOpen && prefix.startsWith('stats/')))
      return { status, json: { error: { message: 'no' } } };
    return {
      json: {
        items: Object.keys(files)
          .filter((n) => n.startsWith(prefix))
          .map((name) => ({ name })),
      },
    };
  });
  fake.on(
    'GET',
    (url) =>
      url.pathname.startsWith(`/storage/v1/b/${ax.BUCKET}/o/`) &&
      url.searchParams.get('alt') === 'media',
    (_n, call) => {
      const name = decodeURIComponent(call.url.pathname.split('/o/')[1] ?? '');
      const file = files[name];
      if (file === undefined)
        return { status: 404, json: { error: { message: 'No such object' } } };
      return { bytes: typeof file === 'string' ? new TextEncoder().encode(file) : file };
    },
  );
  const connector = new PlaySubscriptionsConnector({
    serviceAccount: account,
    packageName: PKG,
    bucketId: ax.BUCKET,
    fetch: fake.fetch,
    now: () => T0,
    sleep: async () => undefined,
  });
  return { fake, connector };
}

test('readMonth: one file per product (overview before country), summed over products, UTF-16 read', async () => {
  const { fake, connector } = bucket({
    [NAME('pro')]: ax.utf16le(PRO),
    [NAME('pro', 'overview')]: ax.csv([HEADER, row('2026-11-01', 'pro', '', '7', '0', '70')]),
    [NAME('plus')]: PLUS,
    [`financial-stats/subscriptions/subscriptions_${PKG}_pro_202610_country.csv`]: 'other month',
    [`financial-stats/subscriptions/subscriptions_com.example.other_pro_${MONTH}_country.csv`]:
      'other app',
  });
  const r = await connector.readMonth(MONTH);
  assert.equal(r.products, 2);
  assert.deepEqual(r.files, [NAME('plus'), NAME('pro', 'overview')]);
  assert.equal(find(r.points, '2026-11-01', 'play_subscriptions_active'), 75);
  assert.equal(find(r.points, '2026-11-01', 'play_subscriptions_active', 'product:plus'), 5);
  assert.ok(fake.calls.every((c) => !c.url.pathname.includes('earnings')));
});

test('readMonth: no file is reports_not_found; a refused folder is play_sales_forbidden', async () => {
  await assert.rejects(
    () => bucket({}).connector.readMonth(MONTH),
    (e: unknown) => e instanceof AnalyticsError && e.code === 'reports_not_found',
  );
  await assert.rejects(
    () => bucket({}, 403, true).connector.readMonth(MONTH),
    (e: unknown) => e instanceof AnalyticsError && e.code === 'play_sales_forbidden',
  );
  await assert.rejects(
    () => bucket({}, 403).connector.readMonth(MONTH),
    (e: unknown) => e instanceof AnalyticsError && e.code === 'bucket_forbidden',
  );
  await bucket({}).connector.checkAccess();
  await assert.rejects(
    () => bucket({}).connector.readMonth('2026-11'),
    (e: unknown) => e instanceof AnalyticsError && e.code === 'reports_not_found',
  );
});
