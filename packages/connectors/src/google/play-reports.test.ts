import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as ax from '../analytics.fixtures.ts';
import { AnalyticsError } from '../analytics-types.ts';
import { parseTable } from '../delimited.ts';
import { DEVSTORAGE_READ_ONLY_SCOPE } from './google-auth.ts';
import { mapPlayTable, PlayReportsConnector } from './play-analytics.ts';
import * as fx from '../store.fixtures.ts';

const T0 = Date.UTC(2026, 10, 19, 12, 0, 0);
const account = fx.serviceAccountJson(fx.googleKeyPem().privateKey);
const PKG = ax.PACKAGE;
const MONTH = '202611';
const OBJ = (dir: string, suffix: string) => `stats/${dir}/${dir}_${PKG}_${MONTH}_${suffix}.csv`;

const captured = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected an error');
};

/** A bucket with some files. A file is bytes; the listing answers the names under the prefix. */
function bucket(files: Record<string, Uint8Array | string>) {
  const fake = new ax.RouteFetch();
  fake.on('POST', '/token', { json: fx.googleToken });
  fake.on('GET', new RegExp(`/storage/v1/b/${ax.BUCKET}/o\\?`), (_n, call) => {
    const prefix = call.url.searchParams.get('prefix') ?? '';
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
  const connector = new PlayReportsConnector({
    serviceAccount: account,
    packageName: PKG,
    bucketId: ax.BUCKET,
    fetch: fake.fetch,
    now: () => T0,
    sleep: async () => undefined,
  });
  return { fake, connector };
}

test('readMonth: installs, ratings and store performance by header name, with the devstorage scope and the documented calls', async () => {
  const { fake, connector } = bucket({
    [OBJ('installs', 'overview')]: ax.INSTALLS_CSV,
    [OBJ('ratings', 'overview')]: ax.RATINGS_CSV,
    [OBJ('store_performance', 'country')]: ax.PERFORMANCE_CSV,
    [OBJ('installs', 'country')]: 'ignored',
  });
  const r = await connector.readMonth(MONTH);
  const at = (date: string, metric: string) =>
    r.points.find((p) => p.date === date && p.metric === metric)?.value;
  assert.equal(at('2026-11-10', 'installs_user'), 110);
  assert.equal(at('2026-11-11', 'installs_device'), 130);
  assert.equal(at('2026-11-10', 'uninstalls_device'), 30);
  assert.equal(at('2026-11-11', 'active_installs_device'), 7100);
  assert.equal(at('2026-11-10', 'rating_average_daily'), 4.5);
  assert.equal(at('2026-11-11', 'rating_average_total'), 4.3);
  // A country breakdown is added up per day.
  assert.equal(at('2026-11-10', 'store_listing_visitors'), 1200);
  assert.equal(at('2026-11-10', 'store_listing_acquisitions'), 105);
  assert.deepEqual(
    r.files.map((f) => f.report),
    ['installs', 'ratings', 'store_performance'],
  );
  assert.equal(
    r.files[0]?.name,
    OBJ('installs', 'overview'),
    'the overview file wins over the breakdown',
  );
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.unmapped, []);
  assert.equal(r.stats.rowsUsed, 7);
  const scope = fx.decodeJwt(new URLSearchParams(fake.calls[0]?.body ?? '').get('assertion') ?? '')
    .payload.scope;
  assert.equal(scope, DEVSTORAGE_READ_ONLY_SCOPE);
  const media = fake.calls.find((c) => c.url.searchParams.get('alt') === 'media');
  assert.ok(media?.headers.get('authorization')?.startsWith('Bearer '));
  assert.equal(media?.url.host, 'storage.googleapis.com');
});

test('readMonth: a UTF-16 file is decoded; a report with no file is missing, not an error; unknown columns are unmapped', async () => {
  const { connector } = bucket({
    [OBJ('installs', 'overview')]: ax.utf16le(ax.INSTALLS_CSV),
    [OBJ('store_performance', 'country')]: ax.csv([
      ['Date', 'Package Name', 'Something New'],
      ['2026-11-10', PKG, '5'],
    ]),
  });
  const r = await connector.readMonth(MONTH);
  assert.equal(
    r.points.find((p) => p.metric === 'installs_user' && p.date === '2026-11-11')?.value,
    121,
  );
  assert.deepEqual(r.missing, ['ratings']);
  assert.deepEqual(r.unmapped, ['store_performance']);
  assert.ok(
    !r.points.some((p) => p.metric.startsWith('store_listing')),
    'no column, no invented number',
  );
});

test('bucket errors are fixed codes: no bucket, a malformed bucket, forbidden, not found', async () => {
  const code = (e: Error) => (e instanceof AnalyticsError ? e.code : `other:${e.message}`);
  const make = (bucketId: string | undefined) => () =>
    new PlayReportsConnector({
      serviceAccount: account,
      packageName: PKG,
      ...(bucketId !== undefined ? { bucketId } : {}),
      fetch: new ax.RouteFetch().fetch,
    });
  assert.equal(code(await captured(async () => make(undefined)())), 'bucket_missing');
  assert.equal(code(await captured(async () => make('some-other-bucket')())), 'bucket_invalid');
  assert.ok(make(`gs://${ax.BUCKET}/`)(), 'gs:// and a trailing slash are accepted');

  for (const [status, expected] of [
    [403, 'bucket_forbidden'],
    [404, 'bucket_not_found'],
  ] as const) {
    const fake = new ax.RouteFetch();
    fake.on('POST', '/token', { json: fx.googleToken });
    fake.on('GET', /\/storage\/v1\/b\//, { status, json: { error: { message: 'x' } } });
    const connector = new PlayReportsConnector({
      serviceAccount: account,
      packageName: PKG,
      bucketId: ax.BUCKET,
      fetch: fake.fetch,
      now: () => T0,
    });
    assert.equal(code(await captured(() => connector.readMonth(MONTH))), expected);
  }
});

test('an oversized or malformed report file is refused with a fixed code', async () => {
  const big = bucket({ [OBJ('installs', 'overview')]: new Uint8Array(11 * 1024 * 1024) });
  assert.equal(
    ((await captured(() => big.connector.readMonth(MONTH))) as AnalyticsError).code,
    'file_too_large',
  );
  const bad = bucket({
    [OBJ('installs', 'overview')]: ax.gz('Date,Daily User Installs\n2026-11-10,1\n').slice(0, 15),
  });
  assert.equal(
    ((await captured(() => bad.connector.readMonth(MONTH))) as AnalyticsError).code,
    'bad_gzip',
  );
});

test('mapPlayTable: rows without a date or number are counted; a table without the columns is unmapped', () => {
  const mapping = [
    { column: ['daily user installs'], metric: 'installs_user' as const, combine: 'sum' as const },
  ];
  const r = mapPlayTable(
    parseTable('Date,Daily User Installs\n2026-11-10,5\nsoon,6\n2026-11-11,x\n'),
    mapping,
  );
  assert.deepEqual(r.points, [{ date: '2026-11-10', metric: 'installs_user', value: 5 }]);
  assert.equal(r.stats.rowsUnreadable, 2);
  assert.equal(mapPlayTable(parseTable('Date,Other\n2026-11-10,5\n'), mapping).mapped, false);
});
