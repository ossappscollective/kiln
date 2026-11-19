import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalyticsError } from './analytics-types.ts';
import * as ax from './analytics.fixtures.ts';
import {
  ANDROID_PUBLISHER_SCOPE,
  DEVSTORAGE_READ_ONLY_SCOPE,
  GoogleTokenProvider,
  PLAY_DEVELOPER_REPORTING_SCOPE,
  parseServiceAccount,
} from './google-auth.ts';
import { PlayReportsConnector, PlayVitalsConnector, mapPlayTable, parseVitalsRows } from './play-analytics.ts';
import { StoreError } from './errors.ts';
import { StoreHttp } from './store-http.ts';
import { parseTable } from './delimited.ts';
import * as fx from './store.fixtures.ts';

const T0 = Date.UTC(2026, 10, 19, 12, 0, 0);
const key = fx.googleKeyPem();
const account = fx.serviceAccountJson(key.privateKey);
const PKG = ax.PACKAGE;

/** The scope claim of every token request the fake saw. */
const scopesAsked = (fake: ax.RouteFetch) =>
  fake.calls
    .filter((c) => c.url.pathname === '/token')
    .map((c) => String(fx.decodeJwt(new URLSearchParams(c.body ?? '').get('assertion') ?? '').payload.scope));

const tokenRoute = (fake: ax.RouteFetch) => fake.on('POST', '/token', { json: fx.googleToken });
const captured = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected an error');
};

test('GoogleTokenProvider: the scope parameter is the scope claim, one token per scope, androidpublisher stays the default', async () => {
  const fake = new ax.RouteFetch();
  tokenRoute(fake);
  const http = new StoreHttp({ store: 'googleplay', fetch: fake.fetch, now: () => T0 });
  const acct = parseServiceAccount(account);
  const publisher = new GoogleTokenProvider(acct, http);
  const reporting = new GoogleTokenProvider(acct, http, PLAY_DEVELOPER_REPORTING_SCOPE);
  const storage = new GoogleTokenProvider(acct, http, DEVSTORAGE_READ_ONLY_SCOPE);
  assert.equal(publisher.scope, ANDROID_PUBLISHER_SCOPE);
  await publisher.token();
  await reporting.token();
  await storage.token();
  await reporting.token();
  assert.deepEqual(scopesAsked(fake), [ANDROID_PUBLISHER_SCOPE, PLAY_DEVELOPER_REPORTING_SCOPE, DEVSTORAGE_READ_ONLY_SCOPE]);
  assert.equal(PLAY_DEVELOPER_REPORTING_SCOPE, 'https://www.googleapis.com/auth/playdeveloperreporting');
  assert.equal(DEVSTORAGE_READ_ONLY_SCOPE, 'https://www.googleapis.com/auth/devstorage.read_only');
});

test('a refused scope names that scope, not androidpublisher', async () => {
  const fake = new ax.RouteFetch();
  fake.on('POST', '/token', { status: 400, json: fx.googleTokenErrors.scope });
  const http = new StoreHttp({ store: 'googleplay', fetch: fake.fetch, now: () => T0 });
  const provider = new GoogleTokenProvider(parseServiceAccount(account), http, PLAY_DEVELOPER_REPORTING_SCOPE);
  const error = await captured(() => provider.token());
  assert.match(error.message, /playdeveloperreporting scope/);
  assert.ok(!/androidpublisher/.test(error.message));
});

test('parseVitalsRows: rate rows with and without a version; unreadable rows are counted, not stored', () => {
  const totals = parseVitalsRows(ax.crashRateTotals);
  assert.deepEqual(totals.points, [
    { date: '2026-11-10', metric: 'crash_rate', value: 0.0123 },
    { date: '2026-11-11', metric: 'crash_rate', value: 0.0101 },
  ]);
  const byVersion = parseVitalsRows(ax.crashRateByVersion);
  assert.deepEqual(byVersion.points[0], { date: '2026-11-10', metric: 'crash_rate', value: 0.02, dimension: { type: 'app_version', value: '241' } });
  const odd = parseVitalsRows({ rows: [{ startTime: { year: 2026, month: 13, day: 1 }, metrics: [] }, ax.vitalsRow('2026-11-10', 'otherRate', '1'), ax.vitalsRow('2026-11-10', 'anrRate', 'x')] });
  assert.deepEqual(odd.points, []);
  assert.equal(odd.skipped, 3);
  assert.deepEqual(parseVitalsRows(null).points, []);
});

function vitals() {
  const fake = new ax.RouteFetch();
  tokenRoute(fake);
  const base = `/v1beta1/apps/${PKG}`;
  fake
    .on('GET', `${base}/crashRateMetricSet`, { json: ax.freshness })
    .on('GET', `${base}/anrRateMetricSet`, { json: ax.freshness })
    .on('POST', `${base}/crashRateMetricSet:query`, (_n, call) => ({ json: JSON.parse(call.body ?? '{}').dimensions.length === 0 ? ax.crashRateTotals : ax.crashRateByVersion }))
    .on('POST', `${base}/anrRateMetricSet:query`, (_n, call) => ({ json: JSON.parse(call.body ?? '{}').dimensions.length === 0 ? ax.anrRateTotals : ax.anrRateByVersion }));
  const connector = new PlayVitalsConnector({ serviceAccount: account, packageName: PKG, fetch: fake.fetch, now: () => T0, sleep: async () => undefined });
  return { fake, connector };
}

test('vitals: crash and ANR rate, total and by version, with the playdeveloperreporting scope and the documented query', async () => {
  const { fake, connector } = vitals();
  const result = await connector.rates({ from: '2026-11-01', to: '2026-11-11' });
  assert.equal(result.points.filter((p) => p.metric === 'crash_rate' && !p.dimension).length, 2);
  assert.equal(result.points.filter((p) => p.metric === 'crash_rate' && p.dimension?.value === '242').length, 2);
  assert.equal(result.points.filter((p) => p.metric === 'anr_rate').length, 2);
  assert.equal(result.dataThrough, '2026-11-11', 'the freshness end time is exclusive');
  assert.deepEqual([...new Set(scopesAsked(fake))], [PLAY_DEVELOPER_REPORTING_SCOPE]);
  const query = fake.calls.find((c) => c.url.pathname.endsWith('crashRateMetricSet:query') && c.body?.includes('versionCode'));
  const body = JSON.parse(query?.body ?? '{}');
  assert.equal(body.timelineSpec.aggregationPeriod, 'DAILY');
  assert.deepEqual(body.timelineSpec.startTime, { year: 2026, month: 11, day: 1, timeZone: { id: 'America/Los_Angeles' } });
  assert.equal(body.timelineSpec.endTime.day, 12, 'the end is exclusive');
  assert.deepEqual(body.dimensions, ['versionCode']);
  assert.deepEqual(body.metrics, ['crashRate']);
  assert.equal(query?.url.host, 'playdeveloperreporting.googleapis.com');
  assert.equal(fake.unexpected.length, 0);
});

test('vitals: a next page token is followed', async () => {
  const fake = new ax.RouteFetch();
  tokenRoute(fake);
  const base = `/v1beta1/apps/${PKG}`;
  // A metric set answer without freshness information: the data-through day is simply unknown.
  fake.on('GET', new RegExp(`${base}/(crash|anr)RateMetricSet$`), { json: { name: 'x' } });
  fake.on('POST', `${base}/crashRateMetricSet:query`, (_n, call) => {
    const body = JSON.parse(call.body ?? '{}');
    if (body.dimensions.length > 0) return { json: { rows: [] } };
    return body.pageToken ? { json: ax.crashRateTotals } : { json: { rows: [ax.vitalsRow('2026-11-09', 'crashRate', '0.5')], nextPageToken: 'p2' } };
  });
  fake.on('POST', `${base}/anrRateMetricSet:query`, { json: { rows: [] } });
  const connector = new PlayVitalsConnector({ serviceAccount: account, packageName: PKG, fetch: fake.fetch, now: () => T0 });
  const result = await connector.rates({ from: '2026-11-01', to: '2026-11-11' });
  assert.equal(result.points.length, 3);
  assert.equal(result.dataThrough, null);
});

test('vitals errors are fixed codes: API not enabled, permission, no such app', async () => {
  const cases: [number, unknown, string][] = [
    [403, { error: { message: 'Google Play Developer Reporting API has not been used in project 1 before or it is disabled.', details: [{ reason: 'SERVICE_DISABLED' }] } }, 'play_reporting_not_enabled'],
    [403, { error: { message: 'The caller does not have permission' } }, 'play_permission_missing'],
    [404, { error: { message: 'Requested entity was not found.' } }, 'play_app_not_found'],
  ];
  for (const [status, json, code] of cases) {
    const fake = new ax.RouteFetch();
    tokenRoute(fake);
    fake.on('GET', /MetricSet$/, { json: ax.freshness });
    fake.on('POST', /MetricSet:query$/, { status, json });
    const connector = new PlayVitalsConnector({ serviceAccount: account, packageName: PKG, fetch: fake.fetch, now: () => T0 });
    const error = await captured(() => connector.rates({ from: '2026-11-01', to: '2026-11-02' }));
    assert.ok(error instanceof AnalyticsError, `${code}: ${error.message}`);
    assert.equal(error.code, code);
    assert.ok(!error.message.includes('ya29'));
  }
});
