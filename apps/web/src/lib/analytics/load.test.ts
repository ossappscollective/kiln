import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, createApi } from '../api.ts';
import type { AnalyticsOverview, AnalyticsStatus } from './analytics.ts';
import { resolveRange } from './analytics.ts';
import { appleOverview, NOW, sourceOf, statusOf } from './fixtures.ts';
import { type AnalyticsReads, loadOverviews, loadStrip } from './load.ts';

type Query = {
  platform?: string;
  from?: string;
  to?: string;
  granularity?: string;
  breakdown?: string;
};

function reads(
  over: Partial<{
    status: AnalyticsStatus;
    overview: AnalyticsOverview;
    statusError: boolean;
    overviewError: (query: Query) => boolean;
  }> = {},
) {
  const calls: { kind: string; appId: string; query?: Query }[] = [];
  const api: AnalyticsReads = {
    analyticsStatus: async (_ws, appId) => {
      calls.push({ kind: 'status', appId });
      if (over.statusError) throw new ApiError(500, 'internal', 'x');
      return over.status ?? statusOf();
    },
    analyticsOverview: async (_ws, appId, query = {}) => {
      calls.push({ kind: 'overview', appId, query });
      if (over.overviewError?.(query)) throw new ApiError(500, 'internal', 'x');
      return over.overview ?? appleOverview();
    },
  };
  return { api, calls };
}

const app = { id: 'app-ios', platform: 'ios' };
const range = resolveRange({ kind: 'preset', days: 28 }, NOW);

test('the screen reads this period with the version breakdown and the previous period for the comparison', async () => {
  const { api, calls } = reads();
  const loaded = await loadOverviews(api, 'w1', app, range);
  assert.equal(loaded.previous?.platform, 'ios');
  assert.equal(calls.length, 2);
  const current = calls.find((c) => c.query?.breakdown === 'app_version');
  const previous = calls.find((c) => c.query?.breakdown === undefined);
  assert.deepEqual(current?.query, {
    platform: 'ios',
    from: '2026-10-22',
    to: '2026-11-18',
    granularity: 'day',
    breakdown: 'app_version',
  });
  assert.deepEqual(previous?.query, {
    platform: 'ios',
    from: '2026-09-24',
    to: '2026-10-21',
    granularity: 'day',
  });
});

test('a failed previous read only loses the comparison; a failed current read fails the screen', async () => {
  const lost = reads({ overviewError: (q) => q.breakdown === undefined });
  const loaded = await loadOverviews(lost.api, 'w1', app, range);
  assert.equal(loaded.previous, null);
  assert.equal(loaded.current.appId, 'app-ios');
  const failed = reads({ overviewError: (q) => q.breakdown === 'app_version' });
  await assert.rejects(loadOverviews(failed.api, 'w1', app, range), ApiError);
});

test('the dashboard strip makes no overview read while analytics is off or has no stored data', async () => {
  const off = reads({ status: statusOf({ enabled: false }) });
  assert.equal(await loadStrip(off.api, 'w1', app, NOW), null);
  assert.deepEqual(
    off.calls.map((c) => c.kind),
    ['status'],
  );
  const empty = reads({
    status: statusOf({
      sources: [sourceOf({ source: 'apple_analytics', firstDay: null, lastDay: null })],
    }),
  });
  assert.equal(await loadStrip(empty.api, 'w1', app, NOW), null);
  assert.deepEqual(
    empty.calls.map((c) => c.kind),
    ['status'],
  );
});

test('the dashboard strip reads the last 28 days once when there is data', async () => {
  const { api, calls } = reads();
  const strip = await loadStrip(api, 'w1', app, NOW);
  assert.deepEqual(
    strip?.items.map((i) => i.id),
    ['downloads', 'conversion', 'crash_rate'],
  );
  assert.deepEqual(
    calls.map((c) => c.kind),
    ['status', 'overview'],
  );
  assert.deepEqual(calls[1]?.query, {
    platform: 'ios',
    from: '2026-10-22',
    to: '2026-11-18',
    granularity: 'day',
  });
});

test('any failure on the dashboard leaves no strip and no error', async () => {
  assert.equal(await loadStrip(reads({ statusError: true }).api, 'w1', app, NOW), null);
  assert.equal(await loadStrip(reads({ overviewError: () => true }).api, 'w1', app, NOW), null);
});

// ---- the API client: paths, methods and bodies ----

function recorded(
  respond: () => Response = () =>
    new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
) {
  const calls: { path: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ path: String(input), init });
    return respond();
  }) as typeof fetch;
  return { calls, api: createApi({ fetch: fetchImpl }) };
}

test('analytics reads are GETs under the app, with only the query that was asked for', async () => {
  const { calls, api } = recorded();
  await api.analyticsStatus('w/1', 'a b');
  await api.analyticsOverview('w1', 'a1', {
    platform: 'ios',
    from: '2026-10-01',
    to: '2026-10-31',
    granularity: 'day',
    breakdown: 'app_version',
  });
  await api.analyticsOverview('w1', 'a1');
  assert.equal(calls[0]?.path, '/api/workspaces/w%2F1/apps/a%20b/analytics/status');
  assert.equal(calls[0]?.init?.method, 'GET');
  assert.equal(
    calls[1]?.path,
    '/api/workspaces/w1/apps/a1/analytics/overview?platform=ios&from=2026-10-01&to=2026-10-31&granularity=day&breakdown=app_version',
  );
  assert.equal(calls[2]?.path, '/api/workspaces/w1/apps/a1/analytics/overview');
});

test('sync, enable and import use the documented routes; enable sends only the confirm hash', async () => {
  const { calls, api } = recorded();
  await api.syncAnalytics('w1', 'a1');
  await api.syncAnalytics('w1', 'a1', ['apple_sales']);
  await api.previewAppleEnable('w1', 'a1');
  await api.previewAppleEnable('w1', 'a1', true);
  await api.enableApple('w1', 'a1', { confirmHash: 'abc' });
  const file = new Blob(['a,b\n1,2\n'], { type: 'text/csv' });
  await api.previewAnalyticsImport('w1', 'a1', 'My report.csv', file);
  await api.importAnalytics('w1', 'a1', 'My report.csv', 'h&h', file);
  const base = '/api/workspaces/w1/apps/a1/analytics';
  assert.deepEqual(
    calls.map((c) => `${c.init?.method} ${c.path}`),
    [
      `POST ${base}/sync`,
      `POST ${base}/sync`,
      `GET ${base}/apple/enable`,
      `GET ${base}/apple/enable?backfill=true`,
      `POST ${base}/apple/enable`,
      `POST ${base}/import/preview?fileName=My%20report.csv`,
      `POST ${base}/import?fileName=My%20report.csv&confirmHash=h%26h`,
    ],
  );
  assert.equal(calls[0]?.init?.body, undefined);
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { sources: ['apple_sales'] });
  assert.deepEqual(JSON.parse(String(calls[4]?.init?.body)), { confirmHash: 'abc' });
  assert.equal(calls[5]?.init?.body, file);
  assert.deepEqual(calls[5]?.init?.headers, { 'content-type': 'text/csv' });
});
