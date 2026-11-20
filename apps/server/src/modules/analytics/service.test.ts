import assert from 'node:assert/strict';
import { dbTest } from '@mrm/db/testing';
import { type AnalyticsBoot, bootAnalytics, discoveryTsv, downloadsTsv } from './test-helpers.ts';

// Everything here runs against fakes: no store is ever contacted.

const get = (t: AnalyticsBoot, path: string, cookie = t.owner) => t.call(cookie, 'GET', path);

/** An iOS app with downloads, discovery (views and impressions) of two days, stored through the real sync. */
async function seeded(t: AnalyticsBoot) {
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
  assert.equal((await t.call(t.owner, 'POST', `/apps/${appId}/analytics/sync`)).status, 200);
  return appId;
}

dbTest(
  'overview: series with source, delay and coverage; derived conversions; days that have no data are null',
  async (db) => {
    const t = await bootAnalytics(db);
    const appId = await seeded(t);
    const res = await get(t, `/apps/${appId}/analytics/overview?from=${t.day(5)}&to=${t.day(1)}`);
    assert.equal(res.status, 200);
    const o = res.body;
    assert.deepEqual(
      [o.appId, o.platform, o.from, o.to, o.granularity],
      [appId, 'ios', t.day(5), t.day(1), 'day'],
    );
    const byId = (id: string) => o.series.find((s: { id: string }) => s.id === id);
    const impressions = byId('impressions');
    assert.deepEqual(
      [
        impressions.source,
        impressions.unit,
        impressions.aggregation,
        impressions.delayDays,
        impressions.derived,
      ],
      ['apple_analytics', 'count', 'sum', 3, false],
    );
    assert.equal(impressions.points.length, 5);
    assert.deepEqual(
      impressions.points.map((p: { value: number | null }) => p.value),
      [null, null, 5200, 3500, null],
    );
    assert.equal(impressions.total, 8700);
    assert.deepEqual(
      [
        impressions.coverage.state,
        impressions.coverage.firstDay,
        impressions.coverage.lastDay,
        impressions.coverage.days,
      ],
      ['complete', t.day(3), t.day(2), 2],
    );
    const codes = impressions.coverage.notes.map((n: { code: string }) => n.code);
    assert.ok(
      codes.includes('apple_privacy_thresholds') && codes.includes('apple_counts_not_unique'),
    );
    assert.ok(impressions.coverage.notes.every((n: { message: string }) => n.message.length > 0));
    // The stores that were never read say so instead of showing zeros.
    const sessions = byId('sessions');
    assert.equal(sessions.total, null);
    assert.ok(sessions.points.every((p: { value: number | null }) => p.value === null));
    // The source was read, but Apple has no sessions report for this app yet: "no data yet", not "not connected".
    assert.deepEqual(
      [
        sessions.coverage.state,
        sessions.coverage.notes.map((n: { code: string }) => n.code).includes('no_data_yet'),
      ],
      ['none', true],
    );
    assert.ok(
      byId('sales_units').coverage.notes.some(
        (n: { code: string }) => n.code === 'source_not_connected',
      ),
    );
    // Derived: first-time downloads over product page views, with the day it can be computed.
    const conversion = byId('product_page_conversion');
    assert.equal(conversion.derived, true);
    assert.equal(
      conversion.coverage.notes.map((n: { code: string }) => n.code).includes('derived'),
      true,
    );
    assert.equal(conversion.points[2].value, 40 / 700);
    assert.equal(conversion.points[3].value, null, 'no downloads that day');
    assert.equal(byId('impression_tap_rate').points[2].value, 700 / 5200);
    assert.ok(
      o.notes.some((n: { code: string }) => n.code === 'apple_rating_history_not_available'),
    );
  },
);

dbTest(
  'overview: weeks start on Monday and add counts up; breakdown lists the top values; bad parameters are 400',
  async (db) => {
    const t = await bootAnalytics(db);
    const appId = await seeded(t);
    const week = await get(
      t,
      `/apps/${appId}/analytics/overview?from=${t.day(20)}&to=${t.day(1)}&granularity=week`,
    );
    const impressions = week.body.series.find((s: { id: string }) => s.id === 'impressions');
    assert.equal(
      impressions.points.reduce((n: number, p: { value: number | null }) => n + (p.value ?? 0), 0),
      8700,
      'no day is lost or counted twice',
    );
    assert.ok(
      impressions.points.every(
        (p: { date: string }) => new Date(`${p.date}T00:00:00Z`).getUTCDay() === 1,
      ),
    );
    const dim = await get(
      t,
      `/apps/${appId}/analytics/overview?from=${t.day(5)}&to=${t.day(1)}&breakdown=source_type`,
    );
    const items = dim.body.series.find((s: { id: string }) => s.id === 'impressions').breakdown;
    assert.equal(items.dimension, 'source_type');
    assert.deepEqual(items.items[0], { value: 'App Store Search', total: 7500 });
    assert.deepEqual(items.items[1], { value: 'App Store Browse', total: 1200 });
    const bySource = await get(
      t,
      `/apps/${appId}/analytics/overview?from=${t.day(5)}&to=${t.day(1)}&breakdown=territory`,
    );
    assert.equal(
      bySource.body.series.find((s: { id: string }) => s.id === 'impressions').breakdown,
      undefined,
      'a series the source has no such dimension for has none',
    );
    assert.equal(
      bySource.body.series.find((s: { id: string }) => s.id === 'downloads_first_time').breakdown
        .items[0].value,
      'US',
    );
    for (const q of [
      'platform=android',
      'granularity=year',
      'from=nope',
      'to=2026-13-45',
      'breakdown=color',
      `from=${t.day(1)}&to=${t.day(5)}`,
      `from=${t.day(500)}&to=${t.day(1)}`,
    ]) {
      const bad = await get(t, `/apps/${appId}/analytics/overview?${q}`);
      assert.equal(bad.status, 400, q);
      assert.equal(bad.body.error, 'invalid_request');
    }
    assert.equal((await get(t, `/apps/${appId}/analytics/overview?platform=ios`)).status, 200);
    assert.equal((await get(t, '/apps/missing/analytics/overview')).status, 404);
  },
);

dbTest(
  'overview of an app that was never read: every series is empty with a fixed note, never zero',
  async (db) => {
    const t = await bootAnalytics(db);
    const appId = await t.addApp('android');
    const o = (await get(t, `/apps/${appId}/analytics/overview`)).body;
    assert.equal(o.platform, 'android');
    assert.ok(o.series.length > 0);
    assert.ok(
      o.series.every(
        (s: { total: number | null; coverage: { state: string } }) =>
          s.total === null && s.coverage.state === 'none',
      ),
    );
    assert.ok(o.notes.some((n: { code: string }) => n.code === 'google_no_impressions'));
    assert.ok(!o.series.some((s: { source: string }) => s.source.startsWith('apple')));
    // 28 days up to yesterday by default.
    assert.equal(o.series[0].points.length, 28);
    assert.equal(o.to, t.day(1));
  },
);

dbTest(
  'status: the setup needs of an app with next-step codes, before and after analytics is turned on',
  async (db) => {
    const t = await bootAnalytics(db);
    const ios = await t.addApp('ios');
    const android = await t.addApp('android');
    const off = (await get(t, `/apps/${ios}/analytics/status`)).body;
    assert.equal(off.enabled, false);
    assert.equal(off.schedule.intervalMinutes, 360);
    assert.deepEqual(
      off.sources.map((s: { source: string }) => s.source),
      ['apple_analytics', 'apple_sales'],
    );
    assert.deepEqual(
      [off.sources[0].state, off.sources[0].setup.code, off.sources[0].setup.nextStep],
      ['off', 'turn_on_analytics', 'turn_on_analytics'],
    );
    assert.deepEqual(off.sources[0].setup.alternatives, ['import_apple_report']);
    assert.equal(off.apple.mode, 'off');
    assert.equal(off.google, null);

    await t.enable();
    const on = (await get(t, `/apps/${ios}/analytics/status`)).body;
    assert.deepEqual(
      [on.sources[0].state, on.sources[0].setup.code, on.sources[0].setup.nextStep],
      ['needs_setup', 'create_report_request', 'enable_apple_analytics'],
    );
    assert.deepEqual(
      [on.sources[1].setup.code, on.sources[1].setup.nextStep, on.sources[1].setup.optional],
      ['vendor_number_missing', 'set_vendor_number', true],
    );
    assert.ok(on.sources[0].setup.message.length > 0);

    const droid = (await get(t, `/apps/${android}/analytics/status`)).body;
    assert.equal(droid.apple, null);
    assert.deepEqual(droid.google, { bucketIdSet: false, bucketSource: null });
    assert.deepEqual(
      [droid.sources[0].setup.code, droid.sources[0].setup.nextStep],
      ['first_sync_pending', 'sync_now'],
    );
    assert.deepEqual(
      [droid.sources[1].setup.code, droid.sources[1].setup.nextStep],
      ['bucket_id_missing', 'set_bucket_id'],
    );
    assert.deepEqual(droid.runs, []);
  },
);

dbTest(
  'analytics settings: validated, admin only, vendor number and bucket id normalised',
  async (db) => {
    const t = await bootAnalytics(db);
    const member = await t.addMember('member');
    assert.equal(
      (await t.setSettings({ 'analytics.enabled': true }, member)).status,
      403,
      'analytics.manage is an admin right',
    );
    assert.equal((await t.setSettings({ 'analytics.enabled': 'yes' })).status, 400);
    assert.equal((await t.setSettings({ 'analytics.appleVendorNumber': 'abc' })).status, 400);
    assert.equal((await t.setSettings({ 'analytics.playBucketId': 'my-bucket' })).status, 400);
    const ok = await t.setSettings({
      'analytics.enabled': true,
      'analytics.appleVendorNumber': ' 85123456 ',
      'analytics.playBucketId': 'gs://pubsite_prod_rev_01234567890123456789/',
    });
    assert.equal(ok.status, 200);
    const values = (await get(t, '/settings')).body.values;
    assert.deepEqual(
      [
        values['analytics.enabled'],
        values['analytics.appleVendorNumber'],
        values['analytics.playBucketId'],
      ],
      [true, '85123456', 'pubsite_prod_rev_01234567890123456789'],
    );
    const defaults = (await get(t, '/settings')).body.defaults;
    assert.equal(defaults['analytics.enabled'], false, 'off by default');
  },
);
