import assert from 'node:assert/strict';
import { test } from 'node:test';
import { t } from '../i18n/t.ts';
import { asOf, metricValue, type RevenueCatMetric, type RevenueCatMetricsRead, STRIP_SCOPE, stripProblem, stripTiles, stripVisible } from './metrics.ts';

const metric = (over: Partial<RevenueCatMetric>): RevenueCatMetric => ({
  id: 'x',
  name: 'X',
  kind: 'count',
  value: 1,
  currency: null,
  period: 'P0D',
  windowDays: 0,
  lastUpdatedAt: null,
  ...over,
});

const read = (over: Partial<RevenueCatMetricsRead> = {}): RevenueCatMetricsRead => ({
  supported: true,
  linked: true,
  metrics: {
    scope: 'project',
    projectId: 'proj1',
    projectName: 'MagicWeather',
    currency: 'USD',
    fetchedAt: 1_000_000,
    figures: {
      activeSubscriptions: metric({ id: 'active_subscriptions', value: 1340 }),
      activeTrials: metric({ id: 'active_trials', value: 12 }),
      mrr: metric({ id: 'mrr', kind: 'money', value: 1234.5, currency: 'USD' }),
      revenue: metric({ id: 'revenue', kind: 'money', value: 2000, currency: 'USD', period: 'P28D', windowDays: 28 }),
    },
    others: [],
  },
  status: { lastAttemptAt: 1_000_000, lastError: null, failures: 0 },
  ...over,
});

test('the four tiles, in order; revenue names its window, counts and money are told apart', () => {
  const tiles = stripTiles(read());
  assert.deepEqual(
    tiles.map((t) => [t.label, t.value]),
    [
      ['Active subscriptions', '1,340'],
      ['Active trials', '12'],
      ['MRR', '$1,235'],
      ['Revenue (28d)', '$2,000'],
    ],
  );
  assert.match(tiles[3]?.title ?? '', /before store fees and taxes/);
  assert.equal(t(STRIP_SCOPE), 'RevenueCat figures, all stores');
});

test('money keeps the currency RevenueCat reported; without one it is not dressed up as money', () => {
  assert.match(metricValue(metric({ kind: 'money', value: 10, currency: 'EUR' })), /€10/);
  assert.equal(metricValue(metric({ kind: 'money', value: 10, currency: null })), '10.00 (currency not reported)');
});

test('a figure RevenueCat did not report is left out, never drawn as zero', () => {
  const r = read();
  if (r.metrics) r.metrics.figures.mrr = null;
  assert.deepEqual(stripTiles(r).map((t) => t.id), ['active_subscriptions', 'active_trials', 'revenue']);
  assert.deepEqual(stripTiles(null), []);
});

test('the strip is drawn for a linked app with figures, or with a reason; never for an unlinked or unsupported app', () => {
  assert.equal(stripVisible(read()), true);
  assert.equal(stripVisible(read({ linked: false, metrics: null, status: null })), false);
  assert.equal(stripVisible(read({ supported: false })), false);
  assert.equal(stripVisible(read({ metrics: null, status: null })), false, 'nothing read yet, nothing to say');
  assert.equal(
    stripVisible(read({ metrics: null, status: { lastAttemptAt: 1, lastError: 'Give the key the permission.', failures: 1 } })),
    true,
  );
  assert.equal(stripVisible(null), false);
});

test('a failed read next to older figures says the figures are older', () => {
  const failed = read({ status: { lastAttemptAt: 2, lastError: 'Try again in a minute.', failures: 1 } });
  assert.match(stripProblem(failed), /older\. Try again in a minute\./);
  assert.equal(stripProblem(read()), '');
  assert.equal(stripProblem(read({ metrics: null, status: { lastAttemptAt: 2, lastError: 'No permission.', failures: 1 } })), 'No permission.');
});

test('as of', () => {
  assert.match(asOf(read(), 1_000_000 + 3 * 60_000), /^As of 3 minutes ago$/);
  assert.equal(asOf(null, 0), '');
});
