import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRevenueCatClient } from './client.ts';
import { RevenueCatError } from './errors.ts';
import { pickOverviewMetric, readRevenueCatOverview } from './overview.ts';
import { errorBody, fakeFetch, KEY, PROJECT_ID } from './revenuecat.fixtures.ts';

const client = (f: ReturnType<typeof fakeFetch>) =>
  createRevenueCatClient({ apiKey: KEY, fetch: f.fetch });

// The shape of the API reference's sample, with the other cards of the dashboard's Overview added (ids UNVERIFIED).
const metric = (id: string, name: string, unit: string, period: string, value: unknown) => ({
  object: 'overview_metric',
  id,
  name,
  description: 'string',
  unit,
  period,
  value,
  last_updated_at: 1758000000000,
  last_updated_at_iso8601: '2025-09-16 05:20:00+00:00',
});
const BODY = {
  object: 'overview_metrics',
  metrics: [
    metric('active_trials', 'Active Trials', '#', 'P0D', 34),
    metric('active_subscriptions', 'Active Subscriptions', '#', 'P0D', 1200),
    metric('mrr', 'MRR', '$', 'P0D', 16),
    metric('revenue', 'Revenue', '$', 'P28D', '4210'),
    metric('new_customers', 'New Customers', '#', 'P28D', 310),
    {
      object: 'overview_metric',
      id: 'broken',
      name: 'No value',
      unit: '#',
      period: 'P0D',
      value: null,
    },
    'not an object',
  ],
  currency: 'eur',
};

test('the overview is one GET of the Charts and Metrics endpoint, with the currency RevenueCat reports', async () => {
  const f = fakeFetch(() => ({ body: BODY }));
  const got = await readRevenueCatOverview(client(f), { projectId: PROJECT_ID });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]?.path, `/v2/projects/${PROJECT_ID}/metrics/overview`);
  assert.equal(f.calls[0]?.init.method, 'GET');
  assert.equal(got.currency, 'EUR');
  assert.deepEqual(
    got.metrics.map((m) => m.id),
    ['active_trials', 'active_subscriptions', 'mrr', 'revenue', 'new_customers'],
  );
  const revenue = got.metrics.find((m) => m.id === 'revenue');
  assert.deepEqual(revenue, {
    id: 'revenue',
    name: 'Revenue',
    unit: '$',
    period: 'P28D',
    value: 4210,
    lastUpdatedAt: 1758000000000,
  });
});

test('an id with a slash cannot change the path; a missing currency is null, never guessed', async () => {
  const f = fakeFetch(() => ({ body: { object: 'overview_metrics', metrics: [] } }));
  const got = await readRevenueCatOverview(client(f), { projectId: 'a/b' });
  assert.equal(f.calls[0]?.path, '/v2/projects/a%2Fb/metrics/overview');
  assert.deepEqual(got, { currency: null, metrics: [] });
});

test('the strip finds a figure by id, else by display name; a missing one is null, not zero', () => {
  const metrics = [
    { id: 'mrr', name: 'MRR', unit: '$', period: 'P0D', value: 16, lastUpdatedAt: null },
    {
      id: 'x1',
      name: 'Active Subscriptions',
      unit: '#',
      period: 'P0D',
      value: 9,
      lastUpdatedAt: null,
    },
  ];
  assert.equal(pickOverviewMetric(metrics, 'mrr')?.value, 16);
  assert.equal(pickOverviewMetric(metrics, 'active_subscriptions')?.value, 9);
  assert.equal(pickOverviewMetric(metrics, 'revenue'), null);
});

test('a missing permission is the fixed forbidden sentence; a rate limit says when to try again; neither carries the key or RevenueCat’s text', async () => {
  const denied = fakeFetch(() => ({ status: 403, body: errorBody('authorization_error') }));
  await assert.rejects(
    () => readRevenueCatOverview(client(denied), { projectId: PROJECT_ID }),
    (e: unknown) =>
      e instanceof RevenueCatError &&
      e.kind === 'forbidden' &&
      !e.message.includes(KEY) &&
      !e.message.includes('Secret detail'),
  );
  const limited = fakeFetch(() => ({
    status: 429,
    body: errorBody('rate_limit_error'),
    headers: { 'retry-after': '30' },
  }));
  await assert.rejects(
    () => readRevenueCatOverview(client(limited), { projectId: PROJECT_ID }),
    (e: unknown) =>
      e instanceof RevenueCatError && e.kind === 'rate_limited' && e.retryAfterSeconds === 30,
  );
});
