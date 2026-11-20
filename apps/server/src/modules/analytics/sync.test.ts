import assert from 'node:assert/strict';
import { AnalyticsError, StoreError } from '@mrm/connectors';
import { dbTest } from '@mrm/db/testing';
import {
  type AnalyticsBoot,
  BUCKET,
  bootAnalytics,
  discoveryTsv,
  downloadsTsv,
  mdy,
  SEGMENT_SECRET,
  salesTsv,
} from './test-helpers.ts';

// Everything here runs against fakes: no store is ever contacted.

const sync = (t: AnalyticsBoot, appId: string, body?: unknown, cookie = t.owner) =>
  t.call(cookie, 'POST', `/apps/${appId}/analytics/sync`, body);
const count = async (t: AnalyticsBoot, where = '') =>
  Number((await t.rows(`SELECT COUNT(*) AS n FROM analytics_daily ${where}`))[0]?.n);

/** An iOS app with an ONGOING request, a discovery and a downloads report of two days each. */
async function appleApp(t: AnalyticsBoot) {
  await t.enable();
  const appId = await t.addApp('ios');
  await t.db.execute(
    `INSERT INTO analytics_report_requests (id, workspace_id, app_id, apple_request_id, access_type, status, created_by, created_at)
     VALUES ('r1', ?, ?, 'req-ongoing', 'ONGOING', 'active', 'u', 1)`,
    [t.workspaceId, appId],
  );
  t.apple.setUp(
    'App Store Discovery and Engagement Standard',
    'inst-d1',
    t.day(1),
    discoveryTsv(t.day(3), t.day(2)),
  );
  t.apple.setUp('App Store Downloads Standard', 'inst-w1', t.day(1), downloadsTsv(t.day(3)));
  return appId;
}

dbTest(
  'analytics sync is closed while the workspace setting analytics.enabled is off',
  async (db) => {
    const t = await bootAnalytics(db);
    const appId = await t.addApp('ios');
    const res = await sync(t, appId);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'analytics_disabled');
    assert.equal(t.built.length, 0, 'no connector was built, so no store was contacted');
    assert.equal(await count(t), 0);
  },
);

dbTest(
  'apple sync stores the mapped daily facts once: a second sync changes nothing and reads no instance twice',
  async (db) => {
    const t = await bootAnalytics(db);
    const appId = await appleApp(t);
    const first = await sync(t, appId);
    assert.equal(first.status, 200);
    const apple = first.body.sync.sources.find(
      (s: { source: string }) => s.source === 'apple_analytics',
    );
    assert.equal(apple.status, 'ok');
    assert.ok(apple.points > 0);
    assert.equal(apple.reports, 2);
    assert.equal(t.apple.reads.length, 2);
    const stored = await count(t);
    assert.ok(stored > 0);
    // The numbers: impressions of the first day add up all rows; the Mac-free iPhone/iPad rows only.
    const impressions = await t.rows(
      "SELECT value_micro FROM analytics_daily WHERE metric = 'impressions' AND dim_type = '' AND day = ?",
      [t.day(3)],
    );
    assert.equal(Number(impressions[0]?.value_micro), 5200 * 1_000_000);
    const firstTime = await t.rows(
      "SELECT value_micro FROM analytics_daily WHERE metric = 'downloads_first_time' AND dim_type = '' AND day = ?",
      [t.day(3)],
    );
    assert.equal(Number(firstTime[0]?.value_micro), 40 * 1_000_000, 'updates are not downloads');

    const again = await sync(t, appId);
    assert.equal(again.status, 200);
    assert.equal(again.body.sync.pointsWritten, 0, 'the same data again writes nothing');
    assert.equal(t.apple.reads.length, 2, 'a read instance is not read again');
    assert.equal(await count(t), stored);
    // apple_sales is skipped without a vendor number: a setup need, not a failure.
    const sales = again.body.sync.sources.find(
      (s: { source: string }) => s.source === 'apple_sales',
    );
    assert.deepEqual([sales.status, sales.setup], ['skipped', 'vendor_number_missing']);
  },
);

dbTest(
  'a later processing date restates a day; an older one never replaces a newer one',
  async (db) => {
    const t = await bootAnalytics(db);
    const appId = await appleApp(t);
    await sync(t, appId);
    const value = async () =>
      Number(
        (
          await t.rows(
            "SELECT value_micro FROM analytics_daily WHERE metric = 'downloads_first_time' AND dim_type = '' AND day = ?",
            [t.day(3)],
          )
        )[0]?.value_micro,
      ) / 1_000_000;
    assert.equal(await value(), 40);
    // Apple restates the day in a newer instance of the same report.
    t.apple.setUp(
      'App Store Downloads Standard',
      'inst-w2',
      t.day(0),
      downloadsTsv(t.day(3), '55'),
    );
    const restated = await sync(t, appId);
    assert.ok(restated.body.sync.pointsWritten > 0);
    assert.equal(await value(), 55);
    // A late instance with an OLDER processing date cannot undo it.
    t.apple.setUp(
      'App Store Downloads Standard',
      'inst-w0',
      t.day(6),
      downloadsTsv(t.day(3), '10'),
    );
    await sync(t, appId);
    assert.equal(await value(), 55);
  },
);

dbTest(
  'a segment link that expired is a partial sync with a fixed code, and the next sync reads it again',
  async (db) => {
    const t = await bootAnalytics(db);
    const appId = await appleApp(t);
    t.apple.texts.set('inst-w1', new AnalyticsError('segment_expired'));
    const first = await sync(t, appId);
    const apple = first.body.sync.sources.find(
      (s: { source: string }) => s.source === 'apple_analytics',
    );
    assert.deepEqual([apple.status, apple.errorCode], ['partial', 'segment_expired']);
    assert.ok(apple.points > 0, 'the other report was stored');
    const status = (await t.call(t.owner, 'GET', `/apps/${appId}/analytics/status`)).body;
    assert.equal(status.sources[0].lastError.code, 'segment_expired');
    // The link is fetched again with the next listing.
    t.apple.texts.set('inst-w1', [downloadsTsv(t.day(3))]);
    const second = await sync(t, appId);
    assert.equal(second.body.sync.sources[0].status, 'ok');
    assert.equal(await count(t, "WHERE metric = 'downloads_first_time' AND dim_type = ''"), 1);
    assert.equal(
      t.apple.reads.filter((id) => id === 'inst-d1').length,
      1,
      'the instance that worked is not read again',
    );
  },
);

dbTest(
  'an oversize or corrupt segment is recorded once with its code and not read again',
  async (db) => {
    const t = await bootAnalytics(db);
    const appId = await appleApp(t);
    t.apple.texts.set('inst-w1', new AnalyticsError('segment_too_large'));
    t.apple.setUp('App Sessions Standard', 'inst-s1', t.day(1), 'x', 'req-ongoing', 'rep-sessions');
    t.apple.texts.set('inst-s1', new AnalyticsError('bad_gzip'));
    const first = await sync(t, appId);
    assert.equal(first.body.sync.sources[0].status, 'partial');
    const rows = await t.rows(
      'SELECT apple_instance_id, status, error_code FROM analytics_instances ORDER BY apple_instance_id',
    );
    assert.deepEqual(
      rows.map((r) => [String(r.apple_instance_id), String(r.status), String(r.error_code ?? '')]),
      [
        ['inst-d1', 'read', ''],
        ['inst-s1', 'failed', 'bad_gzip'],
        ['inst-w1', 'failed', 'segment_too_large'],
      ],
    );
    const reads = t.apple.reads.length;
    await sync(t, appId);
    assert.equal(
      t.apple.reads.length,
      reads,
      'a failure that will not go away is not retried every sync',
    );
  },
);

dbTest(
  'a 403 on the report requests is analytics_role_required, which the status turns into a next step with the import as an alternative',
  async (db) => {
    const t = await bootAnalytics(db);
    const appId = await appleApp(t);
    t.apple.listError = new AnalyticsError('analytics_role_required');
    const res = await sync(t, appId);
    assert.equal(res.status, 200);
    const apple = res.body.sync.sources[0];
    assert.deepEqual([apple.status, apple.errorCode], ['failed', 'analytics_role_required']);
    const setup = res.body.status.sources[0].setup;
    assert.deepEqual(
      [setup.code, setup.nextStep, setup.alternatives],
      ['role_required', 'ask_apple_admin', ['import_apple_report']],
    );
    assert.equal(res.body.status.sources[0].state, 'needs_setup');
  },
);

dbTest('a request Apple stopped for inactivity is reported, not read', async (db) => {
  const t = await bootAnalytics(db);
  const appId = await appleApp(t);
  t.apple.requests = [{ id: 'req-ongoing', accessType: 'ONGOING', stoppedDueToInactivity: true }];
  const res = await sync(t, appId);
  assert.equal(res.body.sync.sources[0].errorCode, 'analytics_request_stopped');
  assert.equal(res.body.status.sources[0].setup.code, 'request_stopped');
  assert.equal(t.apple.reads.length, 0);
  assert.equal(
    (await t.rows('SELECT status FROM analytics_report_requests'))[0]?.status,
    'stopped',
  );
});

dbTest(
  'sales and trends needs the vendor number; with it, days are read from the newest stored day on and never twice',
  async (db) => {
    const t = await bootAnalytics(db);
    const appId = await appleApp(t);
    await t.setSettings({ 'analytics.appleVendorNumber': '85123456' });
    t.apple.sales.set(t.day(2), salesTsv(mdy(t.day(2))));
    t.apple.sales.set(t.day(1), salesTsv(mdy(t.day(1))));
    const first = await sync(t, appId, { sources: ['apple_sales'] });
    const sales = first.body.sync.sources[0];
    assert.equal(sales.status, 'ok');
    assert.equal(sales.reports, 2);
    const units = await t.rows(
      "SELECT value_micro FROM analytics_daily WHERE metric = 'sales_units' AND dim_type = '' AND day = ?",
      [t.day(2)],
    );
    assert.equal(
      Number(units[0]?.value_micro),
      14 * 1_000_000,
      'updates and other apps are left out',
    );
    const proceeds = await t.rows(
      "SELECT dim_value, value_micro FROM analytics_daily WHERE metric = 'sales_proceeds' AND day = ? ORDER BY dim_value",
      [t.day(2)],
    );
    assert.deepEqual(
      proceeds.map((r) => [String(r.dim_value), Number(r.value_micro) / 1_000_000]),
      [
        ['EUR', 9.96],
        ['USD', 29.9],
      ],
    );
    assert.ok(t.apple.salesAsked.every((s) => s.startsWith('85123456:')));
    assert.equal(
      await count(
        t,
        "WHERE source = 'apple_sales' AND dim_type = '' AND metric = 'sales_proceeds'",
      ),
      0,
      'proceeds have no cross-currency total',
    );
    const again = await sync(t, appId, { sources: ['apple_sales'] });
    assert.equal(again.body.sync.pointsWritten, 0);
    // The oldest day asked for the second time is not the whole window again.
    const asked = t.apple.salesAsked.length;
    assert.ok(asked < 2 * 31);
  },
);

dbTest('a Sales and Trends 403 is sales_forbidden', async (db) => {
  const t = await bootAnalytics(db);
  const appId = await appleApp(t);
  await t.setSettings({ 'analytics.appleVendorNumber': '85123456' });
  t.apple.sales.set(t.day(2), new AnalyticsError('sales_forbidden'));
  const res = await sync(t, appId, { sources: ['apple_sales'] });
  assert.deepEqual(
    [res.body.sync.sources[0].status, res.body.sync.sources[0].errorCode],
    ['failed', 'sales_forbidden'],
  );
  assert.equal(res.body.status.sources[1].setup.code, 'sales_forbidden');
});

// ---- Google Play ----------------------------------------------------------------------------------------------------

const vitalsPoints = (t: AnalyticsBoot) => [
  { date: t.day(3), metric: 'crash_rate' as const, value: 0.0123 },
  { date: t.day(2), metric: 'crash_rate' as const, value: 0.0101 },
  {
    date: t.day(3),
    metric: 'crash_rate' as const,
    value: 0.02,
    dimension: { type: 'app_version' as const, value: '241' },
  },
  { date: t.day(3), metric: 'anr_rate' as const, value: 0.0031 },
];

dbTest(
  'play vitals are stored by day, version code kept as a dimension, and read again over a short overlap',
  async (db) => {
    const t = await bootAnalytics(db);
    await t.enable();
    const appId = await t.addApp('android');
    t.vitals.points = vitalsPoints(t);
    const res = await sync(t, appId, { sources: ['play_vitals'] });
    assert.equal(res.body.sync.sources[0].status, 'ok');
    assert.equal(await count(t, "WHERE source = 'play_vitals'"), 4);
    assert.equal(t.built.find((b) => b.kind === 'vitals')?.packageName, 'com.acme.app1');
    // The first read goes back 90 days; a later one starts a week before the newest stored day.
    assert.ok(
      t.vitals.calls[0] &&
        t.vitals.calls[0].from === t.day(90) &&
        t.vitals.calls[0].to === t.day(1),
      JSON.stringify(t.vitals.calls[0]),
    );
    const again = await sync(t, appId, { sources: ['play_vitals'] });
    assert.equal(again.body.sync.pointsWritten, 0);
    assert.equal(t.vitals.calls[1]?.from, t.day(2 + 7), 'a week before the newest stored day');
  },
);

dbTest(
  'play vitals: the Reporting API not being enabled and a missing permission are codes with next steps',
  async (db) => {
    const t = await bootAnalytics(db);
    await t.enable();
    const appId = await t.addApp('android');
    t.vitals.error = new AnalyticsError('play_reporting_not_enabled');
    const first = await sync(t, appId, { sources: ['play_vitals'] });
    assert.equal(first.body.sync.sources[0].errorCode, 'play_reporting_not_enabled');
    assert.deepEqual(
      [first.body.status.sources[0].setup.code, first.body.status.sources[0].setup.nextStep],
      ['reporting_api_not_enabled', 'enable_reporting_api'],
    );
    t.vitals.error = new AnalyticsError('play_permission_missing');
    const second = await sync(t, appId, { sources: ['play_vitals'] });
    assert.equal(second.body.status.sources[0].setup.nextStep, 'grant_play_permission');
    t.vitals.error = undefined;
    t.vitals.points = vitalsPoints(t);
    const fixed = await sync(t, appId, { sources: ['play_vitals'] });
    assert.equal(fixed.body.status.sources[0].setup, null, 'the need goes away once a sync works');
    assert.equal(fixed.body.status.sources[0].state, 'ready');
  },
);

dbTest(
  'play vitals: a rejected query, an empty first read and a rate limit each show their own code and message, never a generic one',
  async (db) => {
    const t = await bootAnalytics(db);
    await t.enable();
    const appId = await t.addApp('android');
    t.vitals.error = new AnalyticsError('play_vitals_bad_request', undefined, 400);
    const bad = await sync(t, appId, { sources: ['play_vitals'] });
    assert.equal(bad.body.sync.sources[0].errorCode, 'play_vitals_bad_request');
    assert.equal(bad.body.status.sources[0].lastError.code, 'play_vitals_bad_request');
    assert.notEqual(
      bad.body.status.sources[0].lastError.message,
      'The store did not answer or failed. The next sync tries again.',
    );
    t.vitals.error = new AnalyticsError('play_app_not_found', undefined, 404);
    assert.equal(
      (await sync(t, appId, { sources: ['play_vitals'] })).body.status.sources[0].lastError.code,
      'play_app_not_found',
    );
    t.vitals.error = undefined;
    t.vitals.points = [];
    const empty = await sync(t, appId, { sources: ['play_vitals'] });
    assert.equal(empty.body.status.sources[0].lastError.code, 'play_vitals_no_data');
  },
);

dbTest(
  'play reports need the bucket id: skipped without it, read with it, a month without a file is fine',
  async (db) => {
    const t = await bootAnalytics(db);
    await t.enable();
    const appId = await t.addApp('android');
    t.vitals.points = vitalsPoints(t);
    const month = (ago: number) => t.day(ago).slice(0, 4) + t.day(ago).slice(5, 7);
    const without = await sync(t, appId);
    const skipped = without.body.sync.sources.find(
      (s: { source: string }) => s.source === 'play_reports',
    );
    assert.deepEqual([skipped.status, skipped.setup], ['skipped', 'bucket_id_missing']);
    assert.equal(without.body.status.sources[1].setup.optional, true);

    await t.setSettings({ 'analytics.playBucketId': `gs://${BUCKET}` });
    t.reports.months.set(month(0), [
      { date: t.day(3), metric: 'installs_user', value: 110 },
      { date: t.day(3), metric: 'rating_average_total', value: 4.31 },
    ]);
    const withBucket = await sync(t, appId, { sources: ['play_reports'] });
    assert.equal(withBucket.body.sync.sources[0].status, 'ok');
    assert.equal(
      t.built.find((b) => b.kind === 'reports')?.bucketId,
      BUCKET,
      'the id is normalised before it is used',
    );
    assert.equal(t.reports.asked.length, 3, 'a first read takes three months');
    const rating = await t.rows(
      "SELECT value_micro FROM analytics_daily WHERE metric = 'rating_average_total'",
    );
    assert.equal(Number(rating[0]?.value_micro), 4_310_000);
    const again = await sync(t, appId, { sources: ['play_reports'] });
    assert.equal(again.body.sync.pointsWritten, 0);
    assert.equal(t.reports.asked.length, 5, 'later reads take the current and the previous month');
  },
);

dbTest(
  'play reports: a bucket with no file at all is reports_not_found, and a forbidden bucket is a next step',
  async (db) => {
    const t = await bootAnalytics(db);
    await t.enable();
    const appId = await t.addApp('android');
    await t.setSettings({ 'analytics.playBucketId': BUCKET });
    const none = await sync(t, appId, { sources: ['play_reports'] });
    assert.equal(none.body.sync.sources[0].errorCode, 'reports_not_found');
    t.reports.error = new AnalyticsError('bucket_forbidden');
    const forbidden = await sync(t, appId, { sources: ['play_reports'] });
    assert.equal(forbidden.body.status.sources[1].setup.code, 'bucket_forbidden');
  },
);

dbTest(
  'a store failure becomes a fixed code, and nothing of the store text, the key or a link is stored or answered',
  async (db) => {
    const t = await bootAnalytics(db);
    await t.enable();
    const appId = await t.addApp('android');
    t.vitals.error = new StoreError(
      'googleplay',
      'auth',
      `bad key ${SEGMENT_SECRET} https://x.test/seg?${SEGMENT_SECRET}`,
      401,
    );
    const res = await sync(t, appId, { sources: ['play_vitals'] });
    assert.equal(res.body.sync.sources[0].errorCode, 'store_auth');
    assert.equal(res.body.status.sources[0].setup.code, 'credential_problem');
    for (const table of ['analytics_sync_runs', 'analytics_source_state', 'audit_events']) {
      const dump = JSON.stringify(await t.rows(`SELECT * FROM ${table}`));
      assert.ok(!dump.includes('SECRETSIGNATURE'), table);
      assert.ok(!dump.includes('PRIVATE KEY') && !dump.includes('SECRETKEYBODY'), table);
    }
    assert.ok(
      t.texts.every((text) => !text.includes('SECRETSIGNATURE') && !text.includes('SECRETKEYBODY')),
    );
  },
);

dbTest(
  'a sync is audited once with ids, counts and codes, and raises analytics.synced only when numbers were stored',
  async (db) => {
    const t = await bootAnalytics(db);
    await t.enable();
    const appId = await t.addApp('android');
    t.vitals.points = vitalsPoints(t);
    await sync(t, appId, { sources: ['play_vitals'] });
    const events = await t.events();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.payload.appId, appId);
    assert.equal(events[0]?.payload.pointsWritten, 4);
    assert.deepEqual(Object.keys(events[0]?.payload ?? {}).sort(), [
      'appId',
      'platform',
      'pointsWritten',
      'sources',
      'trigger',
    ]);
    const audits = (await t.auditActions()).filter((a) => a.action === 'analytics.sync');
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.targetId, appId);
    const detail = JSON.parse(audits[0]?.detail ?? '{}');
    assert.deepEqual(detail.sources, [{ source: 'play_vitals', status: 'ok', points: 4 }]);
    await sync(t, appId, { sources: ['play_vitals'] });
    assert.equal((await t.events()).length, 1, 'nothing new, no event');
    assert.equal((await t.auditActions()).filter((a) => a.action === 'analytics.sync').length, 2);
  },
);

dbTest('deleting an app deletes its analytics', async (db) => {
  const t = await bootAnalytics(db);
  await t.enable();
  const appId = await t.addApp('android');
  t.vitals.points = vitalsPoints(t);
  await sync(t, appId, { sources: ['play_vitals'] });
  assert.ok((await count(t)) > 0);
  assert.equal((await t.call(t.owner, 'DELETE', `/apps/${appId}`)).status, 204);
  for (const table of [
    'analytics_daily',
    'analytics_sync_runs',
    'analytics_source_state',
    'analytics_app_config',
    'analytics_instances',
    'analytics_report_requests',
  ]) {
    assert.equal(Number((await t.rows(`SELECT COUNT(*) AS n FROM ${table}`))[0]?.n), 0, table);
  }
});

dbTest(
  'a source that is not one of the app’s platform is refused, and a body that is not JSON is a 400',
  async (db) => {
    const t = await bootAnalytics(db);
    await t.enable();
    const appId = await t.addApp('android');
    const wrong = await sync(t, appId, { sources: ['apple_sales'] });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.issues[0].path, 'sources');
    const junk = await t.app.request(
      `/api/workspaces/${t.workspaceId}/apps/${appId}/analytics/sync`,
      {
        method: 'POST',
        headers: { cookie: t.owner, 'content-type': 'application/json' },
        body: '{nope',
      },
    );
    assert.equal(junk.status, 400);
    assert.equal((await sync(t, 'missing')).status, 404);
  },
);
