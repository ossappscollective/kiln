import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalyticsError, StoreError } from '@kiln/connectors';
import { addDays } from '@kiln/core';
import { dbTest } from '@kiln/db/testing';
import { classifyAnalyticsError, pacificDay } from './sync.ts';
import {
  type AnalyticsBoot,
  ASC_SECRET,
  BUCKET,
  bootAnalytics,
  STORE_APP_ID,
} from './test-helpers.ts';

// Per-credential vendor number, the Pacific sales day, the finer failure codes and "Test access". Fakes only: every store answer in
// these tests is hand-written, none is a recording of Apple or Google.

const sync = (t: AnalyticsBoot, appId: string, body?: unknown) =>
  t.call(t.owner, 'POST', `/apps/${appId}/analytics/sync`, body);
const test_ = (t: AnalyticsBoot, appId: string, source: string) =>
  t.call(t.owner, 'POST', `/apps/${appId}/analytics/access-test`, { source });

test('pacificDay: the calendar day in Pacific Time, summer and winter', () => {
  assert.equal(pacificDay(Date.parse('2026-11-21T03:00:00Z')), '2026-11-20');
  assert.equal(pacificDay(Date.parse('2026-11-21T08:00:00Z')), '2026-11-21');
  assert.equal(pacificDay(Date.parse('2026-07-01T06:59:00Z')), '2026-06-30');
  assert.equal(pacificDay(Date.parse('2026-07-01T07:00:00Z')), '2026-07-01');
});

test('a 4xx the store sends with no meaning of its own is store_rejected, not an outage; a 5xx stays store_unavailable', () => {
  const rejected = classifyAnalyticsError(
    new StoreError('appstoreconnect', 'unexpected', 'x', 400),
  );
  assert.deepEqual([rejected.code, rejected.transient], ['store_rejected', false]);
  assert.equal(
    classifyAnalyticsError(new StoreError('appstoreconnect', 'server', 'x', 503)).code,
    'store_unavailable',
  );
});

dbTest(
  'the vendor number is per Apple credential: another team keeps its own, the workspace number is the default',
  async (db) => {
    const t = await bootAnalytics(db);
    await t.enable();
    await t.setSettings({ 'analytics.appleVendorNumber': '85123456' });
    const a = await t.addApp('ios');
    const other = await t.addCredential('app_store_connect', ASC_SECRET);
    const made = await t.call(t.owner, 'POST', '/apps', {
      platform: 'ios',
      identifier: 'com.other.team',
      credentialId: other,
      name: 'Other team',
    });
    const b = made.body.app.id as string;
    await db.execute('UPDATE apps SET store_app_id = ? WHERE id = ?', [STORE_APP_ID, b]);

    const bad = await t.call(t.owner, 'PUT', `/apps/${b}/analytics/apple-vendor`, {
      vendorNumber: '12',
    });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error, 'vendor_number_invalid');
    const put = await t.call(t.owner, 'PUT', `/apps/${b}/analytics/apple-vendor`, {
      vendorNumber: ' 90000001 ',
    });
    assert.equal(put.status, 200, put.text);
    assert.equal(put.body.vendorNumber, '90000001');

    const src = async (id: string) =>
      (await t.call(t.owner, 'GET', `/apps/${id}/analytics/status`)).body.apple;
    assert.deepEqual(
      [(await src(a)).vendorNumberSource, (await src(a)).vendorNumber],
      ['workspace', '85123456'],
    );
    assert.deepEqual(
      [(await src(b)).vendorNumberSource, (await src(b)).vendorNumber],
      ['credential', '90000001'],
    );

    await sync(t, a, { sources: ['apple_sales'] });
    await sync(t, b, { sources: ['apple_sales'] });
    assert.ok(t.apple.salesAsked.some((s) => s.startsWith('85123456:')));
    assert.ok(t.apple.salesAsked.some((s) => s.startsWith('90000001:')));

    // Clearing goes back to the workspace default.
    await t.call(t.owner, 'PUT', `/apps/${b}/analytics/apple-vendor`, { vendorNumber: null });
    assert.equal((await src(b)).vendorNumberSource, 'workspace');
    // Android apps have no vendor number.
    const droid = await t.addApp('android');
    const no = await t.call(t.owner, 'PUT', `/apps/${droid}/analytics/apple-vendor`, {
      vendorNumber: '85123456',
    });
    assert.equal(no.status, 422);
    // The number is not written to the audit log.
    const audit = JSON.stringify(
      await db.query(
        "SELECT detail FROM audit_events WHERE action = 'analytics.vendor_number_set'",
      ),
    );
    assert.ok(audit.length > 2 && !audit.includes('90000001'));
  },
);

dbTest(
  'Sales and Trends asks for yesterday in Pacific Time, never a day that has no report yet',
  async (db) => {
    const t = await bootAnalytics(db);
    await t.enable();
    await t.setSettings({ 'analytics.appleVendorNumber': '85123456' });
    const id = await t.addApp('ios');
    await sync(t, id, { sources: ['apple_sales'] });
    const days = t.apple.salesAsked.map((s) => s.split(':')[1] as string).sort();
    const newest = days.at(-1) as string;
    assert.ok(newest <= addDays(pacificDay(t.now()), -1), `asked ${newest}`);
  },
);

dbTest(
  'an Apple vendor number Apple refuses is its own setup code, with the step that fixes it',
  async (db) => {
    const t = await bootAnalytics(db);
    await t.enable();
    await t.setSettings({ 'analytics.appleVendorNumber': '85123456' });
    const id = await t.addApp('ios');
    for (let i = 1; i <= 40; i++)
      t.apple.sales.set(
        addDays(pacificDay(t.now()), -i),
        new AnalyticsError('vendor_number_invalid'),
      );
    const res = await sync(t, id, { sources: ['apple_sales'] });
    assert.equal(res.body.sync.sources[0].errorCode, 'vendor_number_invalid');
    const row = res.body.status.sources.find((s: { source: string }) => s.source === 'apple_sales');
    assert.deepEqual(
      [row.setup.code, row.setup.nextStep, row.setup.optional],
      ['vendor_number_invalid', 'set_vendor_number', false],
    );
  },
);

dbTest(
  'Test access (Apple): one call, the cause in a code; a day without a report is not a failure',
  async (db) => {
    const t = await bootAnalytics(db);
    await t.enable();
    const id = await t.addApp('ios');
    const missing = (await test_(t, id, 'apple_sales')).body.result;
    assert.deepEqual([missing.ok, missing.code], [false, 'vendor_number_missing']);
    await t.setSettings({ 'analytics.appleVendorNumber': '85123456' });
    const none = (await test_(t, id, 'apple_sales')).body.result;
    assert.deepEqual([none.ok, none.code], [true, 'no_report_yet']);
    assert.equal(t.apple.salesAsked.length, 1, 'one call');
    const day = addDays(pacificDay(t.now()), -2);
    t.apple.sales.set(day, new AnalyticsError('sales_forbidden'));
    const role = (await test_(t, id, 'apple_sales')).body.result;
    assert.deepEqual([role.ok, role.code], [false, 'sales_forbidden']);
    assert.match(role.message, /Sales, Finance, Admin or Account Holder/);
    t.apple.sales.set(day, 'Provider\tSKU\n');
    assert.equal((await test_(t, id, 'apple_sales')).body.result.code, 'ok');
    // A source of the other platform is refused.
    assert.equal((await test_(t, id, 'play_reports')).status, 422);
  },
);

dbTest(
  'Test access (Google): the refused bucket and the refused financial folder are told apart; the account address is shown',
  async (db) => {
    const t = await bootAnalytics(db);
    await t.enable();
    const id = await t.addApp('android');
    const none = (await test_(t, id, 'play_reports')).body.result;
    assert.deepEqual([none.ok, none.code], [false, 'bucket_missing']);
    assert.equal(none.serviceAccountEmail, 'bot@proj.iam.gserviceaccount.com');
    await t.setSettings({ 'analytics.playBucketId': BUCKET });
    t.reports.error = new AnalyticsError('bucket_forbidden');
    const whole = (await test_(t, id, 'play_reports')).body.result;
    assert.deepEqual([whole.ok, whole.code], [false, 'bucket_forbidden']);
    assert.match(whole.message, /another Play developer account/);
    t.reports.error = new AnalyticsError('bucket_not_found');
    assert.equal((await test_(t, id, 'play_reports')).body.result.code, 'bucket_not_found');
    t.reports.error = undefined;
    assert.equal((await test_(t, id, 'play_reports')).body.result.code, 'no_report_yet');
    t.sales.error = new AnalyticsError('play_sales_forbidden');
    const fin = (await test_(t, id, 'play_sales')).body.result;
    assert.deepEqual([fin.ok, fin.code], [false, 'play_sales_forbidden']);
    assert.match(fin.message, /View financial data/);
    const viewer = await t.call(t.owner, 'POST', `/apps/${id}/analytics/access-test`, {
      source: 'nope',
    });
    assert.equal(viewer.status, 400);
  },
);

dbTest(
  'a readable bucket that lacks the package is package_not_in_bucket with the bucket step, not "optional setup"',
  async (db) => {
    const t = await bootAnalytics(db);
    await t.enable();
    const id = await t.addApp('android');
    await t.setSettings({ 'analytics.playBucketId': BUCKET });
    t.reports.packageKnown = false;
    const res = await sync(t, id, { sources: ['play_reports'] });
    const row = res.body.status.sources.find(
      (s: { source: string }) => s.source === 'play_reports',
    );
    assert.deepEqual(
      [row.setup.code, row.setup.nextStep, row.setup.optional],
      ['package_not_in_bucket', 'set_bucket_id', false],
    );
  },
);
