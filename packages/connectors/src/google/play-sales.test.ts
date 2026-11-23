import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as ax from '../analytics.fixtures.ts';
import { AnalyticsError } from '../analytics-types.ts';
import { parseTable } from '../delimited.ts';
import * as fx from '../store.fixtures.ts';
import { DEVSTORAGE_READ_ONLY_SCOPE } from './google-auth.ts';
import {
  mapPlaySalesTable,
  PlaySalesConnector,
  parseSalesAmount,
  salesStatusKind,
} from './play-sales.ts';
import { zip } from './play-search-terms.fixtures.ts';

const T0 = Date.UTC(2026, 10, 19, 12, 0, 0);
const account = fx.serviceAccountJson(fx.googleKeyPem().privateKey);
const PKG = ax.PACKAGE;
const OTHER = 'com.example.other';
const MONTH = '202611';
const FILE = `sales/salesreport_${MONTH}.zip`;

// The documented columns of the Estimated sales report (answer 6135870), in the documented order.
const HEADER = [
  'Order Number',
  'Order Charged Date',
  'Order Charged Timestamp',
  'Financial Status',
  'Device Model',
  'Product Title',
  'Package ID',
  'Product Type',
  'SKU ID',
  'Currency of Sale',
  'Item Price',
  'Taxes Collected',
  'Charged Amount',
  'City of Buyer',
  'State of Buyer',
  'Postcode of Buyer',
  'Country of Buyer',
];
const row = (
  status: string,
  date: string,
  pkg: string,
  sku: string,
  currency: string,
  item: string,
  tax: string,
  charged: string,
) => [
  'GPA.1234-1234-1234-12345',
  date,
  '1731240000',
  status,
  'pixel',
  'Coins',
  pkg,
  'One-time product',
  sku,
  currency,
  item,
  tax,
  charged,
  '',
  '',
  '',
  'DE',
];
const SALES = ax.csv([
  HEADER,
  row('Charged', '2026-11-10', PKG, 'coins_100', 'EUR', '1.99', '0.38', '2.37'),
  row('Charged', '2026-11-10', PKG, 'coins_100', 'EUR', '1.99', '0.38', '2.37'),
  row('Charged', '2026-11-10', PKG, 'pro_monthly', 'USD', '4.99', '0', '4.99'),
  row('Charged', '2026-11-11', PKG, 'pro_monthly', 'USD', '4.99', '0', '4.99'),
  row('Charged', '2026-11-11', PKG, 'big_pack', 'JPY', '"1,200"', '0', '"1,200"'),
  row('Refund', '2026-11-11', PKG, 'pro_monthly', 'USD', '-4.99', '0', '-4.99'),
  row('Partial refund', '2026-11-12', PKG, 'coins_100', 'EUR', '1.00', '0', '1.00'),
  row('Charged', '2026-11-10', OTHER, 'coins_100', 'EUR', '9.99', '0', '9.99'),
  row('Chargeback', '2026-11-12', PKG, 'coins_100', 'EUR', '1.99', '0', '1.99'),
  row('Charged', 'soon', PKG, 'coins_100', 'EUR', '1.99', '0', '1.99'),
]);

const find = (
  points: {
    date: string;
    metric: string;
    value: number;
    dimension?: { type: string; value: string };
  }[],
  date: string,
  metric: string,
  dim?: string,
) =>
  points.find(
    (p) =>
      p.date === date &&
      p.metric === metric &&
      (dim === undefined
        ? p.dimension === undefined
        : `${p.dimension?.type}:${p.dimension?.value}` === dim),
  )?.value;

test('the status and the amounts are read as Google writes them', () => {
  assert.equal(salesStatusKind('Charged'), 'charge');
  assert.equal(salesStatusKind('charged'), 'charge');
  assert.equal(salesStatusKind('Refund'), 'refund');
  assert.equal(salesStatusKind('Partial refund'), 'refund');
  assert.equal(salesStatusKind('Chargeback'), 'other');
  assert.equal(parseSalesAmount('12,345.67'), 12345.67);
  assert.equal(parseSalesAmount('2.37'), 2.37);
  assert.equal(parseSalesAmount('-4.99'), -4.99);
  assert.equal(parseSalesAmount('1,2'), undefined);
  assert.equal(parseSalesAmount(''), undefined);
});

test('mapPlaySalesTable: one package out of the account, gross and refunds per currency and per product, orders counted', () => {
  const r = mapPlaySalesTable(parseTable(SALES), { packageName: PKG });
  const p = r.points;
  // 2 * 2.37 EUR; USD kept apart; JPY with a thousands separator. Nothing is converted or added across currencies.
  assert.ok(Math.abs((find(p, '2026-11-10', 'sales_gross', 'currency:EUR') ?? 0) - 4.74) < 1e-9);
  assert.equal(find(p, '2026-11-10', 'sales_gross', 'currency:USD'), 4.99);
  assert.equal(find(p, '2026-11-11', 'sales_gross', 'currency:JPY'), 1200);
  assert.equal(find(p, '2026-11-10', 'sales_gross'), undefined, 'no total over currencies');
  // Refunds are positive numbers of their own metric, whatever the sign Google writes (UNVERIFIED).
  assert.equal(find(p, '2026-11-11', 'sales_refunds', 'currency:USD'), 4.99);
  assert.equal(find(p, '2026-11-12', 'sales_refunds', 'currency:EUR'), 1);
  // Orders: charged rows only.
  assert.equal(find(p, '2026-11-10', 'sales_orders'), 3);
  assert.equal(find(p, '2026-11-11', 'sales_orders'), 2);
  assert.equal(find(p, '2026-11-12', 'sales_orders'), undefined);
  // Per product: the currency is part of the key of money.
  assert.ok(
    Math.abs((find(p, '2026-11-10', 'sales_gross', 'product:EUR:coins_100') ?? 0) - 4.74) < 1e-9,
  );
  assert.equal(find(p, '2026-11-10', 'sales_orders', 'product:coins_100'), 2);
  assert.equal(find(p, '2026-11-11', 'sales_refunds', 'product:USD:pro_monthly'), 4.99);
  // The other app, the chargeback and the unreadable date are not in it.
  assert.equal(r.stats.rowsRead, 10);
  assert.equal(r.stats.rowsUsed, 7);
  assert.equal(r.stats.rowsFiltered, 2);
  assert.equal(r.stats.rowsUnreadable, 1);
  assert.ok(!JSON.stringify(p).includes('9.99'));
});

test('mapPlaySalesTable: a missing column is refused; the older Product ID column and a missing Charged Amount are tolerated', () => {
  assert.throws(
    () =>
      mapPlaySalesTable(parseTable('Order Charged Date,Financial Status\n2026-11-10,Charged\n'), {
        packageName: PKG,
      }),
    (e: unknown) => e instanceof AnalyticsError && e.code === 'missing_columns',
  );
  const old = ax.csv([
    [
      'Order Charged Date',
      'Financial Status',
      'Product ID',
      'SKU ID',
      'Currency of Sale',
      'Item Price',
      'Taxes Collected',
    ],
    ['2026-11-10', 'Charged', PKG, 'a', 'EUR', '1.00', '0.19'],
  ]);
  const r = mapPlaySalesTable(parseTable(old), { packageName: PKG });
  assert.ok(
    Math.abs((find(r.points, '2026-11-10', 'sales_gross', 'currency:EUR') ?? 0) - 1.19) < 1e-9,
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
  const connector = new PlaySalesConnector({
    serviceAccount: account,
    packageName: PKG,
    bucketId: ax.BUCKET,
    fetch: fake.fetch,
    now: () => T0,
    sleep: async () => undefined,
  });
  return { fake, connector };
}

test('readMonth: the zip of the month (UTF-16 inside), the devstorage scope, only this package', async () => {
  const { fake, connector } = bucket({
    [FILE]: zip([{ name: `salesreport_${MONTH}.csv`, data: ax.utf16le(SALES) }]),
    [`sales/salesreport_202610.zip`]: 'not asked',
    [`earnings/earnings_${MONTH}.zip`]: 'not asked',
  });
  const r = await connector.readMonth(MONTH);
  assert.equal(r.file, FILE);
  assert.equal(find(r.points, '2026-11-10', 'sales_orders'), 3);
  assert.equal(r.stats.rowsUsed, 7);
  const scope = fx.decodeJwt(new URLSearchParams(fake.calls[0]?.body ?? '').get('assertion') ?? '')
    .payload.scope;
  assert.equal(scope, DEVSTORAGE_READ_ONLY_SCOPE);
  assert.ok(fake.calls.every((c) => !c.url.pathname.includes('earnings')));
});

test('readMonth: a plain UTF-8 csv works too; a month without a file is reports_not_found', async () => {
  const plain = bucket({ [`sales/salesreport_${MONTH}.csv`]: SALES });
  assert.equal((await plain.connector.readMonth(MONTH)).stats.rowsUsed, 7);
  const none = bucket({});
  await assert.rejects(
    () => none.connector.readMonth(MONTH),
    (e: unknown) => e instanceof AnalyticsError && e.code === 'reports_not_found',
  );
});

test('readMonth: a refused sales folder is play_sales_forbidden (the financial permission), not a bucket problem', async () => {
  // The statistics folder can be read, the financial one cannot: the Play Console permission View financial data.
  const { connector } = bucket({}, 403, true);
  await assert.rejects(
    () => connector.readMonth(MONTH),
    (e: unknown) => e instanceof AnalyticsError && e.code === 'play_sales_forbidden',
  );
  // Every folder refused: the whole bucket is out of reach (another account's bucket, or no invitation): bucket_forbidden.
  await assert.rejects(
    () => bucket({}, 403).connector.readMonth(MONTH),
    (e: unknown) => e instanceof AnalyticsError && e.code === 'bucket_forbidden',
  );
  await assert.rejects(
    () => bucket({}, 403).connector.checkAccess(),
    (e: unknown) => e instanceof AnalyticsError && e.code === 'bucket_forbidden',
  );
  await assert.rejects(
    () => bucket({}, 403, true).connector.checkAccess(),
    (e: unknown) => e instanceof AnalyticsError && e.code === 'play_sales_forbidden',
  );
  await bucket({}).connector.checkAccess(); // an empty folder is access that works
  const notFound = bucket({}, 404);
  await assert.rejects(
    () => notFound.connector.readMonth(MONTH),
    (e: unknown) => e instanceof AnalyticsError && e.code === 'bucket_not_found',
  );
});

test('readMonth: a broken zip and a table without the sales columns are fixed codes', async () => {
  const broken = bucket({
    [FILE]: zip([{ name: 'a.csv', data: new TextEncoder().encode(SALES) }]).subarray(0, 40),
  });
  await assert.rejects(
    () => broken.connector.readMonth(MONTH),
    (e: unknown) => e instanceof AnalyticsError && e.code === 'bad_zip',
  );
  const wrong = bucket({
    [FILE]: zip([{ name: 'a.csv', data: new TextEncoder().encode('A,B\n1,2\n') }]),
  });
  await assert.rejects(
    () => wrong.connector.readMonth(MONTH),
    (e: unknown) => e instanceof AnalyticsError && e.code === 'missing_columns',
  );
});
