import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as ax from '../analytics.fixtures.ts';
import { AnalyticsError } from '../analytics-types.ts';
import { parseTable } from '../delimited.ts';
import * as fx from '../store.fixtures.ts';
import { earningsTypeOf, mapPlayEarningsTable, PlayEarningsConnector } from './play-earnings.ts';
import { zip } from './play-search-terms.fixtures.ts';

const T0 = Date.UTC(2026, 10, 21, 12, 0, 0);
const account = fx.serviceAccountJson(fx.googleKeyPem().privateKey);
const PKG = ax.PACKAGE;
const OTHER = 'com.example.other';
const MONTH = '202610';
const FILE = `earnings/earnings_${MONTH}.zip`;

// The documented columns of the Earnings report (answer 6135870), in the documented order.
const HEADER = [
  'Description',
  'Transaction Date',
  'Transaction Time',
  'Tax Type',
  'Transaction Type',
  'Refund Type',
  'Product Title',
  'Package ID',
  'Product Type',
  'SKU ID',
  'Hardware',
  'Buyer Country',
  'Buyer State',
  'Buyer Postcode',
  'Buyer Currency',
  'Amount (Buyer Currency)',
  'Currency Conversion Rate',
  'Merchant Currency',
  'Amount (Merchant Currency)',
];
const row = (type: string, pkg: string, sku: string, merchant: string, amount: string) => [
  'GPA.3333-4444-5555-66666',
  '"Oct 12, 2026"',
  '3:04:05 AM PDT',
  '',
  type,
  type.includes('refund') ? 'Full' : '',
  'Pro',
  pkg,
  'Subscription',
  sku,
  'pixel',
  'DE',
  '',
  '',
  'EUR',
  '9.99',
  '1.0',
  merchant,
  amount,
];
// Signs as Google is ASSUMED to write them (UNVERIFIED): fees and refunds negative.
const EARNINGS = ax.csv([
  HEADER,
  row('Charge', PKG, 'pro_monthly', 'EUR', '9.99'),
  row('Tax', PKG, 'pro_monthly', 'EUR', '-1.60'),
  row('Google fee', PKG, 'pro_monthly', 'EUR', '-1.25'),
  row('Charge', PKG, 'pro_monthly', 'EUR', '9.99'),
  row('Tax', PKG, 'pro_monthly', 'EUR', '-1.60'),
  row('Google fee', PKG, 'pro_monthly', 'EUR', '-1.25'),
  row('Charge', PKG, 'coins_100', 'USD', '"1,234.50"'),
  row('Google fee', PKG, 'coins_100', 'USD', '-185.18'),
  row('Charge refund', PKG, 'pro_monthly', 'EUR', '-9.99'),
  row('Google fee refund', PKG, 'pro_monthly', 'EUR', '1.25'),
  row('Adjustment', PKG, '', 'EUR', '0.50'),
  row('Charge', OTHER, 'pro_monthly', 'EUR', '99.00'),
  row('Charge', PKG, 'pro_monthly', 'EUR', 'n/a'),
]);

type P = {
  date: string;
  metric: string;
  value: number;
  dimension?: { type: string; value: string };
};
const find = (points: P[], metric: string, dim?: string) =>
  points.find(
    (p) =>
      p.metric === metric &&
      (dim === undefined
        ? p.dimension === undefined
        : `${p.dimension?.type}:${p.dimension?.value}` === dim),
  )?.value;
const near = (a: number | undefined, b: number) =>
  assert.ok(a !== undefined && Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test('transaction types are grouped into families; only a plain Charge is an order', () => {
  assert.deepEqual(earningsTypeOf('Charge'), { family: 'charges', isCharge: true });
  assert.deepEqual(earningsTypeOf('charge refund'), { family: 'charges', isCharge: false });
  assert.deepEqual(earningsTypeOf('Charge rebill'), { family: 'charges', isCharge: false });
  assert.deepEqual(earningsTypeOf('Tax rebill'), { family: 'taxes', isCharge: false });
  assert.deepEqual(earningsTypeOf('Google fee'), { family: 'fees', isCharge: false });
  assert.deepEqual(earningsTypeOf('Google fee rebill'), { family: 'fees', isCharge: false });
  assert.deepEqual(earningsTypeOf('Adjustment'), { family: 'other', isCharge: false });
  assert.deepEqual(earningsTypeOf('Something new'), { family: 'other', isCharge: false });
});

test('mapPlayEarningsTable: one month, dated the first day, per merchant currency and product; net is the signed sum of every line', () => {
  const r = mapPlayEarningsTable(parseTable(EARNINGS), { packageName: PKG, month: MONTH });
  const p = r.points;
  assert.ok(
    p.every((x) => x.date === '2026-10-01'),
    'every point is on the first day of the month',
  );
  const eurNet = 2 * (9.99 - 1.6 - 1.25) + (-9.99 + 1.25) + 0.5;
  near(find(p, 'earnings_net', 'currency:EUR'), eurNet);
  near(find(p, 'earnings_net', 'currency:USD'), 1234.5 - 185.18);
  assert.equal(find(p, 'earnings_net'), undefined, 'no total over currencies');
  near(find(p, 'earnings_charges', 'currency:EUR'), 9.99);
  near(find(p, 'earnings_taxes', 'currency:EUR'), -3.2);
  near(find(p, 'earnings_fees', 'currency:EUR'), -1.25);
  near(find(p, 'earnings_charges', 'currency:USD'), 1234.5);
  // The split plus the adjustment is the net.
  const parts =
    (find(p, 'earnings_charges', 'currency:EUR') ?? 0) +
    (find(p, 'earnings_taxes', 'currency:EUR') ?? 0) +
    (find(p, 'earnings_fees', 'currency:EUR') ?? 0) +
    0.5;
  near(find(p, 'earnings_net', 'currency:EUR'), parts);
  // Orders: Charge lines only, in total and per product.
  assert.equal(find(p, 'earnings_orders'), 3);
  assert.equal(find(p, 'earnings_orders', 'product:pro_monthly'), 2);
  assert.equal(find(p, 'earnings_orders', 'product:coins_100'), 1);
  // Per product: the currency is part of the key. The adjustment has no SKU: currency total only.
  near(
    find(p, 'earnings_net', 'product:EUR:pro_monthly'),
    2 * (9.99 - 1.6 - 1.25) + (-9.99 + 1.25),
  );
  near(find(p, 'earnings_net', 'product:USD:coins_100'), 1234.5 - 185.18);
  // The other app and the unreadable amount are not in it.
  assert.equal(r.stats.rowsRead, 13);
  assert.equal(r.stats.rowsUsed, 11);
  assert.equal(r.stats.rowsFiltered, 1);
  assert.equal(r.stats.rowsUnreadable, 1);
  assert.ok(!p.some((x) => x.value === 99), 'the other app’s 99.00 is not in it');
});

test('mapPlayEarningsTable: a table without the earnings columns is refused; the older Product ID column is read; a bad month is refused', () => {
  assert.throws(
    () =>
      mapPlayEarningsTable(parseTable('Transaction Type,Package ID\nCharge,x\n'), {
        packageName: PKG,
        month: MONTH,
      }),
    (e: unknown) => e instanceof AnalyticsError && e.code === 'missing_columns',
  );
  const old = ax.csv([
    ['Transaction Type', 'Product ID', 'SKU ID', 'Merchant Currency', 'Amount (Merchant Currency)'],
    ['Charge', PKG, 'a', 'EUR', '2.00'],
  ]);
  const got = mapPlayEarningsTable(parseTable(old), { packageName: PKG, month: MONTH });
  near(find(got.points, 'earnings_net', 'currency:EUR'), 2);
  assert.throws(
    () => mapPlayEarningsTable(parseTable(old), { packageName: PKG, month: '2026-10' }),
    (e: unknown) => e instanceof AnalyticsError && e.code === 'reports_not_found',
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
  const connector = new PlayEarningsConnector({
    serviceAccount: account,
    packageName: PKG,
    bucketId: ax.BUCKET,
    fetch: fake.fetch,
    now: () => T0,
    sleep: async () => undefined,
  });
  return { fake, connector };
}

const zipOf = (csv: string) => zip([{ name: `earnings_${MONTH}.csv`, data: ax.utf16le(csv) }]);

test('readMonth: the zip of the month (UTF-16 inside), only this package, nothing from sales/ or other months', async () => {
  const { fake, connector } = bucket({
    [FILE]: zipOf(EARNINGS),
    'earnings/earnings_202609.zip': 'not asked',
    'sales/salesreport_202610.zip': 'not asked',
  });
  const r = await connector.readMonth(MONTH);
  assert.deepEqual(r.files, [FILE]);
  near(find(r.points, 'earnings_net', 'currency:USD'), 1234.5 - 185.18);
  assert.ok(fake.calls.every((c) => !c.url.pathname.includes('salesreport')));
});

test('readMonth: a suffixed file is read too, and an identical copy is not counted twice', async () => {
  const part2 = ax.csv([HEADER, row('Charge', PKG, 'late', 'EUR', '5.00')]);
  const { connector } = bucket({
    [FILE]: zipOf(EARNINGS),
    [`earnings/earnings_${MONTH}_1.zip`]: zipOf(part2),
    [`earnings/earnings_${MONTH}_2.zip`]: zipOf(part2),
  });
  const r = await connector.readMonth(MONTH);
  assert.equal(r.files.length, 2, 'the duplicate was skipped');
  near(
    find(r.points, 'earnings_net', 'currency:EUR'),
    2 * (9.99 - 1.6 - 1.25) + (-9.99 + 1.25) + 0.5 + 5,
  );
});

test('readMonth: a month without a file is reports_not_found (not available yet); a refused folder is play_sales_forbidden', async () => {
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
    () => bucket({}, 404).connector.readMonth(MONTH),
    (e: unknown) => e instanceof AnalyticsError && e.code === 'bucket_not_found',
  );
});

test('readMonth: a broken zip is bad_zip and a table without the columns is missing_columns', async () => {
  await assert.rejects(
    () => bucket({ [FILE]: zipOf(EARNINGS).subarray(0, 40) }).connector.readMonth(MONTH),
    (e: unknown) => e instanceof AnalyticsError && e.code === 'bad_zip',
  );
  await assert.rejects(
    () =>
      bucket({
        [FILE]: zip([{ name: 'a.csv', data: new TextEncoder().encode('A,B\n1,2\n') }]),
      }).connector.readMonth(MONTH),
    (e: unknown) => e instanceof AnalyticsError && e.code === 'missing_columns',
  );
});
