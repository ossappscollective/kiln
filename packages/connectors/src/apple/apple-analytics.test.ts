import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as ax from '../analytics.fixtures.ts';
import { AnalyticsError } from '../analytics-types.ts';
import { StoreError } from '../errors.ts';
import * as fx from '../store.fixtures.ts';
import { AppleAnalyticsConnector } from './apple-analytics.ts';

const T0 = Date.UTC(2026, 10, 19, 12, 0, 0);
const key = fx.appleKeyPem();
const APP = ax.APPLE_APP_ID;

function setup() {
  const fake = new ax.RouteFetch();
  const connector = new AppleAnalyticsConnector({
    credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: key.privateKey },
    fetch: fake.fetch,
    now: () => T0,
    sleep: async () => undefined,
  });
  return { fake, connector };
}

const errorBody = (code: string, title: string) => ({
  errors: [{ status: '403', code, title, detail: 'x' }],
});
const captured = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected an error');
};

test('createRequest posts the documented body; a 403 that is not a bad key is analytics_role_required', async () => {
  const { fake, connector } = setup();
  fake.on('POST', '/v1/analyticsReportRequests', {
    status: 201,
    json: { data: ax.requestJson('req-9', 'ONGOING') },
  });
  const created = await connector.createRequest(APP, 'ONGOING');
  assert.deepEqual(created, { id: 'req-9', accessType: 'ONGOING', stoppedDueToInactivity: false });
  const call = fake.calls[0];
  assert.ok(call?.headers.get('authorization')?.startsWith('Bearer '));
  assert.deepEqual(JSON.parse(call?.body ?? '{}'), {
    data: {
      type: 'analyticsReportRequests',
      attributes: { accessType: 'ONGOING' },
      relationships: { app: { data: { type: 'apps', id: APP } } },
    },
  });

  const denied = setup();
  denied.fake.on('POST', '/v1/analyticsReportRequests', {
    status: 403,
    json: errorBody('FORBIDDEN_ERROR', 'This request is forbidden for security reasons'),
  });
  const error = await captured(() => denied.connector.createRequest(APP, 'ONGOING'));
  assert.ok(error instanceof AnalyticsError);
  assert.equal(error.code, 'analytics_role_required');

  // A key Apple does not accept at all is still a credential problem, not a role problem.
  const bad = setup();
  bad.fake.on('POST', '/v1/analyticsReportRequests', {
    status: 403,
    json: errorBody('NOT_AUTHORIZED', 'Authentication credentials are missing or invalid.'),
  });
  const credential = await captured(() => bad.connector.createRequest(APP, 'ONGOING'));
  assert.ok(credential instanceof StoreError);
  assert.equal((credential as StoreError).kind, 'auth');
});

test('the app id must be numeric before it goes into a URL', async () => {
  const { connector } = setup();
  const error = await captured(() => connector.listRequests('../1'));
  assert.ok(error instanceof StoreError);
  assert.equal((error as StoreError).kind, 'invalid_input');
});

test('listRequests, listReports and listInstances read the JSON:API lists; instances are DAILY only, newest first', async () => {
  const { fake, connector } = setup();
  fake
    .on('GET', `/v1/apps/${APP}/analyticsReportRequests`, {
      json: {
        data: [
          ax.requestJson('req-1', 'ONGOING', true),
          ax.requestJson('req-2', 'ONE_TIME_SNAPSHOT'),
        ],
      },
    })
    .on('GET', '/v1/analyticsReportRequests/req-1/reports', {
      json: {
        data: [
          ax.reportJson('r1', 'App Store Downloads Standard', 'COMMERCE'),
          { type: 'analyticsReports', id: 'r2' },
        ],
      },
    })
    .on('GET', '/v1/analyticsReports/r1/instances', {
      json: {
        data: [
          ax.instanceJson('i1', '2026-11-08T08:00:00Z'),
          ax.instanceJson('i2', '2026-11-10T08:00:00Z'),
          ax.instanceJson('iw', '2026-11-11T08:00:00Z', 'WEEKLY'),
        ],
        links: {},
      },
    });
  const requests = await connector.listRequests(APP);
  assert.deepEqual(requests, [
    { id: 'req-1', accessType: 'ONGOING', stoppedDueToInactivity: true },
    { id: 'req-2', accessType: 'ONE_TIME_SNAPSHOT', stoppedDueToInactivity: false },
  ]);
  assert.deepEqual(await connector.listReports('req-1'), [
    { id: 'r1', name: 'App Store Downloads Standard', category: 'COMMERCE' },
  ]);
  const instances = await connector.listInstances('r1');
  assert.deepEqual(
    instances.map((i) => [i.id, i.processingDate]),
    [
      ['i2', '2026-11-10'],
      ['i1', '2026-11-08'],
    ],
  );
  assert.match(fake.calls[2]?.url.search ?? '', /filter\[granularity\]=DAILY/);
});

test('a paging link is followed on the API host only', async () => {
  const { fake, connector } = setup();
  fake.on('GET', `/v1/apps/${APP}/analyticsReportRequests`, {
    json: { data: [], links: { next: 'https://evil.example/steal?x=1' } },
  });
  const error = await captured(() => connector.listRequests(APP));
  assert.match(error.message, /another host/);
  assert.equal(fake.calls.length, 1, 'the link was not followed, and no token went there');
});

test('readInstance downloads each segment at once, WITHOUT the bearer token, and decodes gzip', async () => {
  const { fake, connector } = setup();
  fake
    .on('GET', '/v1/analyticsReportInstances/i1/segments', {
      json: {
        data: [
          ax.segmentJson('s1', ax.SEGMENT_URL, 500),
          ax.segmentJson(
            's2',
            'https://analytics-segments.example-storage.test/reports/seg-2.csv.gz?sig=ABCDEFGHIJKL',
            300,
          ),
        ],
      },
    })
    .on('GET', 'analytics-segments.example-storage.test/reports/seg-1.csv.gz', {
      bytes: ax.gz(ax.DOWNLOADS_TSV),
    })
    .on('GET', 'analytics-segments.example-storage.test/reports/seg-2.csv.gz', {
      bytes: ax.utf16le(ax.CRASHES_TSV),
    });
  const read = await connector.readInstance('i1');
  assert.equal(read.segments, 2);
  assert.equal(read.texts[0], ax.DOWNLOADS_TSV);
  assert.equal(read.texts[1], ax.CRASHES_TSV, 'an uncompressed UTF-16 file is read too');
  const downloads = fake.calls.filter((c) => c.url.host.startsWith('analytics-segments'));
  assert.equal(downloads.length, 2);
  for (const call of downloads)
    assert.equal(call.headers.get('authorization'), null, 'no token to the storage host');
  assert.equal(fake.unexpected.length, 0);
});

test('a segment link is never in a message, in JSON, or in a printed segment', async () => {
  const { fake, connector } = setup();
  fake
    .on('GET', '/v1/analyticsReportInstances/i1/segments', {
      json: { data: [ax.segmentJson('s1', ax.SEGMENT_URL)] },
    })
    .on('GET', 'analytics-segments.example-storage.test/reports/seg-1.csv.gz', {
      status: 500,
      json: { oops: ax.SEGMENT_URL },
    });
  const error = await captured(() => connector.readInstance('i1'));
  const shown = `${error.message} ${error.stack ?? ''}`;
  assert.ok(!shown.includes('SECRETSIGNATURE'), shown);
  assert.ok(!shown.includes('X-Amz'), shown);
  const reached = fake.calls.some((c) => c.url.search.includes('SECRETSIGNATURE'));
  assert.ok(reached, 'the link was used');
});

test('an expired link (403) is asked for again once; a link that is dead twice is segment_expired', async () => {
  const { fake, connector } = setup();
  fake.on('GET', '/v1/analyticsReportInstances/i1/segments', {
    json: { data: [ax.segmentJson('s1', ax.SEGMENT_URL)] },
  });
  fake.on('GET', 'analytics-segments.example-storage.test/reports/seg-1.csv.gz', (n) =>
    n === 1
      ? { status: 403, bytes: new TextEncoder().encode('<Error>Request has expired</Error>') }
      : { bytes: ax.gz(ax.SESSIONS_TSV) },
  );
  const read = await connector.readInstance('i1');
  assert.equal(read.texts[0], ax.SESSIONS_TSV);
  assert.equal(
    fake.calls.filter((c) => c.url.pathname.endsWith('/segments')).length,
    2,
    'the segments were listed again for fresh links',
  );

  const dead = setup();
  dead.fake.on('GET', '/v1/analyticsReportInstances/i1/segments', {
    json: { data: [ax.segmentJson('s1', ax.SEGMENT_URL)] },
  });
  dead.fake.on('GET', 'analytics-segments.example-storage.test/reports/seg-1.csv.gz', {
    status: 410,
    bytes: new Uint8Array(),
  });
  const error = await captured(() => dead.connector.readInstance('i1'));
  assert.ok(error instanceof AnalyticsError);
  assert.equal(error.code, 'segment_expired');
  assert.equal(
    dead.fake.calls.filter((c) => c.url.pathname.endsWith('/segments')).length,
    2,
    'asked once more, not for ever',
  );
});

test('size caps: the size Apple announces, the bytes that arrive, and the text after gunzip', async () => {
  const announced = setup();
  announced.fake.on('GET', '/v1/analyticsReportInstances/i1/segments', {
    json: { data: [ax.segmentJson('s1', ax.SEGMENT_URL, 50 * 1024 * 1024)] },
  });
  const e1 = await captured(() => announced.connector.readInstance('i1'));
  assert.equal((e1 as AnalyticsError).code, 'segment_too_large');
  assert.equal(
    announced.fake.calls.filter((c) => c.url.host.startsWith('analytics-segments')).length,
    0,
    'nothing was downloaded',
  );

  const arriving = setup();
  arriving.fake.on('GET', '/v1/analyticsReportInstances/i1/segments', {
    json: { data: [ax.segmentJson('s1', ax.SEGMENT_URL, 100)] },
  });
  arriving.fake.on('GET', 'analytics-segments.example-storage.test/reports/seg-1.csv.gz', {
    bytes: new Uint8Array(11 * 1024 * 1024),
  });
  const e2 = await captured(() => arriving.connector.readInstance('i1'));
  assert.equal((e2 as AnalyticsError).code, 'segment_too_large');

  const bomb = setup();
  bomb.fake.on('GET', '/v1/analyticsReportInstances/i1/segments', {
    json: { data: [ax.segmentJson('s1', ax.SEGMENT_URL, 100)] },
  });
  bomb.fake.on('GET', 'analytics-segments.example-storage.test/reports/seg-1.csv.gz', {
    bytes: ax.gz(new Uint8Array(70 * 1024 * 1024)),
  });
  const e3 = await captured(() => bomb.connector.readInstance('i1'));
  assert.equal((e3 as AnalyticsError).code, 'segment_too_large');
});

test('a segment that is not gzip but claims to be is bad_gzip', async () => {
  const { fake, connector } = setup();
  fake.on('GET', '/v1/analyticsReportInstances/i1/segments', {
    json: { data: [ax.segmentJson('s1', ax.SEGMENT_URL)] },
  });
  fake.on('GET', 'analytics-segments.example-storage.test/reports/seg-1.csv.gz', {
    bytes: new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3]),
  });
  const error = await captured(() => connector.readInstance('i1'));
  assert.equal((error as AnalyticsError).code, 'bad_gzip');
});

test('sales: the documented query, gzip decoded; 404 is no report; 403 is sales_forbidden; a bad vendor number never leaves', async () => {
  const { fake, connector } = setup();
  fake
    .on('GET', (url) => url.pathname === '/v1/salesReports' && url.search.includes('2026-11-10'), {
      bytes: ax.gz(ax.SALES_TSV),
    })
    .on('GET', (url) => url.pathname === '/v1/salesReports' && url.search.includes('2026-11-11'), {
      status: 404,
      json: { errors: [{ code: 'NOT_FOUND' }] },
    })
    .on('GET', (url) => url.pathname === '/v1/salesReports' && url.search.includes('2026-11-12'), {
      status: 403,
      json: { errors: [{ code: 'FORBIDDEN_ERROR' }] },
    });
  assert.equal(
    await connector.fetchSalesReport({ vendorNumber: '85012345', date: '2026-11-10' }),
    ax.SALES_TSV,
  );
  const q = fake.calls[0]?.url.searchParams;
  assert.equal(q?.get('filter[reportType]'), 'SALES');
  assert.equal(q?.get('filter[reportSubType]'), 'SUMMARY');
  assert.equal(q?.get('filter[frequency]'), 'DAILY');
  assert.equal(q?.get('filter[vendorNumber]'), '85012345');
  assert.equal(q?.get('filter[reportDate]'), '2026-11-10');
  assert.ok(
    !fake.calls.some((c) => c.url.search.includes('INSTALLS')),
    'the INSTALLS report ended on 2026-11-04 and is never asked for',
  );
  assert.equal(
    await connector.fetchSalesReport({ vendorNumber: '85012345', date: '2026-11-11' }),
    null,
  );
  const forbidden = await captured(() =>
    connector.fetchSalesReport({ vendorNumber: '85012345', date: '2026-11-12' }),
  );
  assert.equal((forbidden as AnalyticsError).code, 'sales_forbidden');
  const invalid = await captured(() =>
    connector.fetchSalesReport({ vendorNumber: '85012345&x=1', date: '2026-11-10' }),
  );
  assert.equal((invalid as AnalyticsError).code, 'vendor_number_invalid');
});

test('subscriptions: SUBSCRIPTION and SUBSCRIPTION_EVENT use version 1_3, SUMMARY and DAILY; 404 is no report; 403 is sales_forbidden', async () => {
  const { fake, connector } = setup();
  fake
    .on('GET', (url) => url.pathname === '/v1/salesReports' && url.search.includes('2026-11-10'), {
      bytes: ax.gz(ax.SALES_TSV),
    })
    .on('GET', (url) => url.pathname === '/v1/salesReports' && url.search.includes('2026-11-11'), {
      status: 404,
      json: { errors: [{ code: 'NOT_FOUND' }] },
    })
    .on('GET', (url) => url.pathname === '/v1/salesReports' && url.search.includes('2026-11-12'), {
      status: 403,
      json: { errors: [{ code: 'FORBIDDEN_ERROR' }] },
    });
  assert.equal(
    await connector.fetchSubscriptionReport({ kind: 'subscription', vendorNumber: '85012345', date: '2026-11-10' }),
    ax.SALES_TSV,
  );
  const q = fake.calls[0]?.url.searchParams;
  assert.equal(q?.get('filter[reportType]'), 'SUBSCRIPTION');
  assert.equal(q?.get('filter[reportSubType]'), 'SUMMARY');
  assert.equal(q?.get('filter[frequency]'), 'DAILY');
  assert.equal(q?.get('filter[version]'), '1_3');
  assert.equal(q?.get('filter[vendorNumber]'), '85012345');
  await connector.fetchSubscriptionReport({ kind: 'subscription_event', vendorNumber: '85012345', date: '2026-11-10' });
  assert.equal(fake.calls[1]?.url.searchParams.get('filter[reportType]'), 'SUBSCRIPTION_EVENT');
  assert.equal(fake.calls[1]?.url.searchParams.get('filter[version]'), '1_3');
  assert.ok(
    !fake.calls.some((c) => c.url.search.includes('SUBSCRIBER')),
    'the per-subscriber report is never asked for',
  );
  assert.equal(
    await connector.fetchSubscriptionReport({ kind: 'subscription', vendorNumber: '85012345', date: '2026-11-11' }),
    null,
  );
  const forbidden = await captured(() =>
    connector.fetchSubscriptionReport({ kind: 'subscription', vendorNumber: '85012345', date: '2026-11-12' }),
  );
  assert.equal((forbidden as AnalyticsError).code, 'sales_forbidden');
  // The sales summary keeps its own report type and version.
  await connector.fetchSalesReport({ vendorNumber: '85012345', date: '2026-11-10' });
  assert.equal(fake.calls[fake.calls.length - 1]?.url.searchParams.get('filter[version]'), '1_0');
});
