import assert from 'node:assert/strict';
import { dbTest } from '@kiln/db/testing';
import { bootRevenueCat, json, overviewBody, REVENUECAT_KEY } from './test-helpers.ts';

// The RevenueCat metrics overview (docs/adr/0043-revenuecat-metrics.md). A fake RevenueCat; no network.

const metricsOf = (
  t: Awaited<ReturnType<typeof bootRevenueCat>>,
  appId: string,
  cookie = t.owner,
) => t.call(cookie, 'GET', t.base(appId, '/metrics'));

dbTest('before a sync there is nothing to show, and the read never asks RevenueCat', async (db) => {
  const t = await bootRevenueCat(db);
  const appId = await t.linked('ios');
  const before = t.rc.calls.length;
  const res = await metricsOf(t, appId);
  assert.equal(res.status, 200);
  assert.deepEqual(
    [res.body.supported, res.body.linked, res.body.metrics, res.body.status],
    [true, true, null, null],
  );
  assert.equal(t.rc.calls.length, before, 'a read of the copy is a database read');
  const bare = await t.addApp('ios');
  const none = await metricsOf(t, bare);
  assert.deepEqual([none.body.linked, none.body.metrics], [false, null]);
});

dbTest(
  'a sync stores the overview next to the configuration: counts are unitless, money carries RevenueCat’s currency, the scope is the project',
  async (db) => {
    const t = await bootRevenueCat(db);
    const appId = await t.linked('ios');
    const run = await t.rcSync(appId);
    assert.equal(run.status, 200, run.text);
    assert.deepEqual(run.body.sync.metrics, {
      ok: true,
      metrics: 5,
      fetchedAt: run.body.sync.syncedAt,
    });
    assert.ok(t.rc.calls.every((c) => c.method === 'GET'));
    assert.ok(t.rc.calls.some((c) => c.path.endsWith('/metrics/overview')));

    const { metrics, status } = (await metricsOf(t, appId)).body;
    assert.equal(metrics.scope, 'project');
    assert.equal(metrics.projectName, 'MagicWeather');
    assert.equal(metrics.currency, 'USD');
    assert.deepEqual(
      [
        metrics.figures.activeSubscriptions.value,
        metrics.figures.activeSubscriptions.kind,
        metrics.figures.activeSubscriptions.currency,
      ],
      [340, 'count', null],
    );
    assert.deepEqual(
      [metrics.figures.activeTrials.value, metrics.figures.activeTrials.windowDays],
      [12, 0],
    );
    assert.deepEqual(
      [
        metrics.figures.mrr.value,
        metrics.figures.mrr.kind,
        metrics.figures.mrr.currency,
        metrics.figures.mrr.windowDays,
      ],
      [1234.5, 'money', 'USD', 0],
    );
    assert.deepEqual(
      [
        metrics.figures.revenue.value,
        metrics.figures.revenue.currency,
        metrics.figures.revenue.windowDays,
      ],
      [2000, 'USD', 28],
    );
    assert.deepEqual(
      metrics.others.map((m: { id: string }) => m.id),
      ['new_customers'],
    );
    assert.equal(metrics.others[0].currency, null);
    assert.deepEqual(status, {
      lastAttemptAt: run.body.sync.syncedAt,
      lastError: null,
      failures: 0,
    });
  },
);

dbTest(
  'the figures are in the currency RevenueCat reports, and none is guessed when it names none',
  async (db) => {
    const t = await bootRevenueCat(db);
    const appId = await t.linked('ios');
    t.rc.overview = overviewBody('EUR');
    await t.rcSync(appId);
    assert.equal((await metricsOf(t, appId)).body.metrics.figures.mrr.currency, 'EUR');
    t.rc.overview = { ...overviewBody(), currency: undefined };
    await t.rcSync(appId);
    const { metrics } = (await metricsOf(t, appId)).body;
    assert.equal(metrics.currency, null);
    assert.deepEqual([metrics.figures.mrr.kind, metrics.figures.mrr.currency], ['money', null]);
  },
);

dbTest('a figure RevenueCat did not report is null, never zero', async (db) => {
  const t = await bootRevenueCat(db);
  const appId = await t.linked('ios');
  const body = overviewBody();
  t.rc.overview = { ...body, metrics: body.metrics.filter((m) => m.id !== 'mrr') };
  await t.rcSync(appId);
  const { figures } = (await metricsOf(t, appId)).body.metrics;
  assert.equal(figures.mrr, null);
  assert.equal(figures.activeTrials.value, 12);
});

dbTest(
  'a key without the metrics permission fails only the metrics: the configuration is synced, the sentence names the permission',
  async (db) => {
    const t = await bootRevenueCat(db);
    const appId = await t.linked('ios');
    t.rc.overviewStatus = 403;
    const run = await t.rcSync(appId);
    assert.equal(run.status, 200, 'the sync as a whole succeeded');
    assert.equal(run.body.sync.products, 3);
    assert.equal(run.body.sync.metrics.ok, false);
    assert.equal(run.body.sync.metrics.code, 'revenuecat_forbidden');
    assert.match(run.body.sync.metrics.message, /charts_metrics:overview:read/);
    const res = (await metricsOf(t, appId)).body;
    assert.equal(res.metrics, null);
    assert.equal(res.status.failures, 1);
    assert.match(res.status.lastError, /Charts & Metrics/);
    assert.equal(
      (await t.view(appId)).body.sync.lastError,
      null,
      'the configuration read is not marked failed',
    );
  },
);

dbTest(
  'a failed read keeps the last good figures and says what went wrong; a good one clears it',
  async (db) => {
    const t = await bootRevenueCat(db);
    const appId = await t.linked('ios');
    await t.rcSync(appId);
    t.rc.overviewStatus = 500;
    const bad = await t.rcSync(appId);
    assert.equal(bad.body.sync.metrics.ok, false);
    const kept = (await metricsOf(t, appId)).body;
    assert.equal(kept.metrics.figures.mrr.value, 1234.5, 'the old figures stay');
    assert.equal(kept.status.failures, 1);
    assert.ok(kept.status.lastError.length > 10);
    t.rc.overviewStatus = undefined;
    await t.rcSync(appId);
    const ok = (await metricsOf(t, appId)).body;
    assert.deepEqual([ok.status.failures, ok.status.lastError], [0, null]);
  },
);

dbTest('a rate limit is "wait", not a failure streak', async (db) => {
  const t = await bootRevenueCat(db);
  const appId = await t.linked('ios');
  await t.rcSync(appId);
  t.rc.overviewStatus = 429;
  const run = await t.rcSync(appId);
  assert.equal(run.body.sync.metrics.code, 'rate_limited');
  assert.equal((await metricsOf(t, appId)).body.status.failures, 0);
});

dbTest('viewers can read the figures; nobody outside the workspace can', async (db) => {
  const t = await bootRevenueCat(db);
  const appId = await t.linked('ios');
  await t.rcSync(appId);
  const viewer = await t.addMember('viewer');
  const seen = await metricsOf(t, appId, viewer);
  assert.equal(seen.status, 200);
  assert.equal(seen.body.metrics.figures.mrr.value, 1234.5);
  assert.equal((await t.call('', 'GET', t.base(appId, '/metrics'))).status, 401);
});

dbTest('unlinking clears the figures; the key never reaches a response or a table', async (db) => {
  const t = await bootRevenueCat(db);
  const appId = await t.linked('ios');
  await t.rcSync(appId);
  assert.equal((await t.call(t.owner, 'DELETE', t.base(appId))).status, 204);
  assert.equal((await db.query('SELECT 1 FROM revenuecat_metrics')).length, 0);
  const again = await t.linked('android');
  await t.rcSync(again);
  assert.ok(!(await t.everything()).includes(REVENUECAT_KEY));
  void json;
});

dbTest(
  'the products sync carries the metrics step too, and the metrics are read with GET only',
  async (db) => {
    const t = await bootRevenueCat(db);
    const appId = await t.linked('ios');
    const run = await t.sync(appId);
    assert.equal(run.body.revenuecat.ok, true);
    assert.equal(run.body.revenuecat.metrics.ok, true);
    assert.equal((await metricsOf(t, appId)).body.metrics.figures.activeSubscriptions.value, 340);
  },
);
