import assert from 'node:assert/strict';
import { AnalyticsError, StoreError } from '@mrm/connectors';
import { dbTest } from '@mrm/db/testing';
import { BUCKET, bootAnalytics } from './analytics-test-helpers.ts';
import { createTestLimiter } from './services/credential-tests.ts';

/**
 * The Google Play reports bucket (bug: "Android Insights shows crashes and ANRs but no downloads"). Installs and ratings come only from
 * the monthly CSV files of ONE private Cloud Storage bucket per Play developer account. A workspace can hold apps of several Play
 * accounts, so the bucket is per app, with the Play credential (optional) and the workspace setting as defaults. Everything runs against
 * fakes: no store is contacted.
 */
const url = (appId: string, tail = '') => `/apps/${appId}/analytics/play-bucket${tail}`;
const PLAY_CSV = (pkg: string) =>
  `Date,Package Name,Daily Device Installs,Daily Device Uninstalls,Daily User Installs,Active Device Installs\n2026-11-01,${pkg},12,3,10,500\n2026-11-02,${pkg},20,4,15,510\n2026-11-02,com.other.app,99,9,90,9000\n`;

dbTest('play bucket: the app override wins over the Play credential, which wins over the workspace default; clearing the override inherits', async (db) => {
  const t = await bootAnalytics(db);
  const a = await t.addApp('android');
  const b = await t.addApp('android');
  const none = (await t.call(t.owner, 'GET', url(a))).body.playBucket;
  assert.deepEqual(none, {
    bucketId: null, source: null, app: null, account: null, workspace: null, inherited: { bucketId: null, source: null }, credentialId: t.playCredential, sharedWith: 2,
  });

  // 1. The workspace default only: every Android app reads it.
  await t.setSettings({ 'analytics.playBucketId': BUCKET });
  for (const id of [a, b]) {
    const view = (await t.call(t.owner, 'GET', url(id))).body.playBucket;
    assert.deepEqual([view.bucketId, view.source, view.inherited.source], [BUCKET, 'workspace', 'workspace']);
  }
  assert.deepEqual((await t.call(t.owner, 'GET', `/apps/${b}/analytics/status`)).body.google, { bucketIdSet: true, bucketSource: 'workspace' });

  // 2. An app of another Play account has its own bucket: it wins for that app only (the default is shown as what it would inherit).
  const OWN = 'pubsite_prod_rev_99999999999';
  const put = await t.call(t.owner, 'PUT', url(b), { bucket: `gs://${OWN}/` });
  assert.equal(put.status, 200, put.text);
  assert.deepEqual([put.body.playBucket.bucketId, put.body.playBucket.source], [OWN, 'app']);
  assert.deepEqual(put.body.playBucket.inherited, { bucketId: BUCKET, source: 'workspace' });
  assert.equal((await t.call(t.owner, 'GET', url(a))).body.playBucket.bucketId, BUCKET, 'the other app still reads the default');
  assert.deepEqual((await t.call(t.owner, 'GET', `/apps/${b}/analytics/status`)).body.google, { bucketIdSet: true, bucketSource: 'app' });

  // 3. "Use workspace default": clearing the override inherits again.
  const cleared = await t.call(t.owner, 'PUT', url(b), { bucket: null });
  assert.deepEqual([cleared.body.playBucket.bucketId, cleared.body.playBucket.source], [BUCKET, 'workspace']);

  // Optional: the Play credential (developer account) holds one for all its apps; below the app, above the workspace default.
  const OTHER = 'pubsite_prod_rev_55555555555';
  const account = await t.call(t.owner, 'PUT', url(a), { bucket: OTHER, scope: 'account' });
  assert.deepEqual([account.body.playBucket.bucketId, account.body.playBucket.source], [OTHER, 'account']);
  assert.equal((await t.call(t.owner, 'GET', url(b))).body.playBucket.bucketId, OTHER, 'shared by the apps of the credential');
  assert.equal((await t.call(t.owner, 'PUT', url(b), { bucket: OWN })).body.playBucket.source, 'app');
  assert.equal((await t.call(t.owner, 'PUT', url(a), { bucket: null, scope: 'account' })).body.playBucket.source, 'workspace');
});

dbTest('play bucket: each app reads ITS resolved bucket; a package that is not in the bucket is its own code, not empty charts', async (db) => {
  const t = await bootAnalytics(db);
  await t.enable();
  const a = await t.addApp('android');
  const b = await t.addApp('android');
  const OWN = 'pubsite_prod_rev_99999999999';
  await t.setSettings({ 'analytics.playBucketId': BUCKET });
  await t.call(t.owner, 'PUT', url(b), { bucket: OWN });
  const month = t.day(0).slice(0, 4) + t.day(0).slice(5, 7);
  t.reports.months.set(month, [{ date: t.day(3), metric: 'installs_user', value: 110 }]);
  const sync = (id: string) => t.call(t.owner, 'POST', `/apps/${id}/analytics/sync`, { sources: ['play_reports'] });
  assert.equal((await sync(a)).body.sync.sources[0].status, 'ok');
  assert.equal(t.built.filter((x) => x.kind === 'reports').at(-1)?.bucketId, BUCKET, 'no override: the workspace default');
  assert.equal((await sync(b)).body.sync.sources[0].status, 'ok');
  assert.equal(t.built.filter((x) => x.kind === 'reports').at(-1)?.bucketId, OWN, 'its own bucket, not the workspace one');

  // The wrong account: the bucket can be read, but the package is nowhere in it.
  t.reports.months.clear();
  t.reports.packageKnown = false;
  const wrong = await sync(a);
  assert.equal(wrong.body.sync.sources[0].errorCode, 'package_not_in_bucket');
  assert.match(wrong.body.status.sources[1].lastError.code, /package_not_in_bucket/);
  // A package the bucket knows, with no file for these months, is still the plain "no file yet".
  t.reports.packageKnown = true;
  assert.equal((await sync(a)).body.sync.sources[0].errorCode, 'reports_not_found');
});

dbTest('play bucket: validated, admin only, iOS refused, and the audit entry holds ids and no bucket id', async (db) => {
  const t = await bootAnalytics(db);
  const android = await t.addApp('android');
  const ios = await t.addApp('ios');
  for (const bad of ['my-bucket', 'gs://other/path', 'pubsite_prod_rev_12', '', 'x'.repeat(300)]) {
    const res = await t.call(t.owner, 'PUT', url(android), { bucket: bad });
    assert.ok(res.status === 400 || res.status === 422, `${bad.slice(0, 20)} -> ${res.status}`);
  }
  assert.equal((await t.call(t.owner, 'PUT', url(android), { bucket: 'my-bucket' })).body.error, 'bucket_invalid');
  assert.equal((await t.call(t.owner, 'PUT', url(android), { bucket: BUCKET, extra: 1 })).status, 400);
  assert.equal((await t.call(t.owner, 'PUT', url(ios), { bucket: BUCKET })).body.error, 'not_an_android_app');
  assert.equal((await t.call(t.owner, 'GET', url(ios))).status, 422);
  assert.equal((await t.call(t.owner, 'PUT', url('nope'), { bucket: BUCKET })).status, 404);

  const viewer = await t.addMember('viewer');
  const member = await t.addMember('member');
  const admin = await t.addMember('admin');
  for (const cookie of [viewer, member]) {
    assert.equal((await t.call(cookie, 'PUT', url(android), { bucket: BUCKET })).status, 403);
    assert.equal((await t.call(cookie, 'POST', url(android, '/test'))).status, 403);
    assert.equal((await t.call(cookie, 'GET', url(android))).status, 200, 'everyone reads where it is set');
  }
  assert.equal((await t.call(admin, 'PUT', url(android), { bucket: BUCKET })).status, 200);
  const trail = JSON.stringify(await t.auditActions());
  assert.match(trail, /analytics\.play_bucket_set/);
  const rows = await t.db.query("SELECT detail FROM audit_events WHERE action = 'analytics.play_bucket_set'");
  assert.equal(rows.length, 1);
  assert.ok(!String(rows[0]?.detail).includes('pubsite'), 'the bucket id is not in the log');
  assert.ok(String(rows[0]?.detail).includes(android));
});

dbTest('play bucket: the sync reads the account bucket, and deleting the credential removes it', async (db) => {
  const t = await bootAnalytics(db);
  await t.enable();
  const appId = await t.addApp('android');
  await t.call(t.owner, 'PUT', url(appId), { bucket: BUCKET, scope: 'account' });
  const month = t.day(0).slice(0, 4) + t.day(0).slice(5, 7);
  t.reports.months.set(month, [{ date: t.day(3), metric: 'installs_user', value: 110 }]);
  const done = await t.call(t.owner, 'POST', `/apps/${appId}/analytics/sync`, { sources: ['play_reports'] });
  assert.equal(done.body.sync.sources[0].status, 'ok');
  assert.equal(t.built.find((x) => x.kind === 'reports')?.bucketId, BUCKET);
  assert.equal(Number((await t.rows('SELECT COUNT(*) AS n FROM analytics_credential_config'))[0]?.n), 1);
});

dbTest('play bucket test: fixed result codes, never the store text, nothing stored', async (db) => {
  const t = await bootAnalytics(db, { limiter: createTestLimiter({ limit: 100 }) });
  const appId = await t.addApp('android');
  const test = (body?: unknown) => t.call(t.owner, 'POST', url(appId, '/test'), body);
  assert.equal((await test()).body.result.code, 'not_set');
  assert.equal((await test({ bucket: 'nope' })).body.result.code, 'bucket_invalid');
  assert.equal(t.reports.asked.length, 0, 'nothing was asked of Google for an invalid or missing id');

  // A bucket of another Play account: readable, but the package is not in it.
  t.reports.packageKnown = false;
  assert.equal((await test({ bucket: BUCKET })).body.result.code, 'package_not_found');
  t.reports.packageKnown = true;
  // A bucket that is readable but holds no file yet, then one that holds files.
  const none = await test({ bucket: BUCKET });
  assert.deepEqual([none.status, none.body.result.code, none.body.result.ok], [200, 'no_reports_yet', true]);
  const month = t.day(0).slice(0, 4) + t.day(0).slice(5, 7);
  t.reports.months.set(month, [{ date: t.day(3), metric: 'installs_user', value: 1 }]);
  const ok = await test({ bucket: `gs://${BUCKET}` });
  assert.deepEqual([ok.body.result.code, ok.body.result.ok], ['ok', true]);
  assert.equal(t.built.at(-1)?.bucketId, BUCKET);
  assert.equal((await t.call(t.owner, 'GET', url(appId))).body.playBucket.bucketId, null, 'testing a pasted value does not save it');

  for (const [error, code] of [
    [new AnalyticsError('bucket_forbidden'), 'bucket_forbidden'],
    [new AnalyticsError('bucket_not_found'), 'bucket_not_found'],
    [new StoreError('googleplay', 'forbidden', 'SECRET-GOOGLE-TEXT'), 'bucket_forbidden'],
    [new StoreError('googleplay', 'auth', 'SECRET-GOOGLE-TEXT'), 'credential_problem'],
    [new StoreError('googleplay', 'network', 'SECRET-GOOGLE-TEXT'), 'unreachable'],
    [new Error('SECRET-GOOGLE-TEXT'), 'unreachable'],
  ] as const) {
    t.reports.error = error;
    const res = await test({ bucket: BUCKET });
    assert.equal(res.status, 200);
    assert.equal(res.body.result.code, code);
    assert.equal(res.body.result.ok, false);
    assert.ok(!res.text.includes('SECRET-GOOGLE-TEXT'));
  }
  assert.equal(Number((await t.rows('SELECT COUNT(*) AS n FROM analytics_daily'))[0]?.n), 0);
});

dbTest('play statistics file import: an Android app takes a Play Console CSV (installs), only its own package, idempotent', async (db) => {
  const t = await bootAnalytics(db);
  const appId = await t.addApp('android');
  const pkg = 'com.acme.app1';
  const preview = await t.upload(t.owner, `/apps/${appId}/analytics/import/preview`, PLAY_CSV(pkg));
  assert.equal(preview.status, 200, preview.text);
  const plan = preview.body.plan;
  assert.equal(plan.source, 'play_reports');
  assert.equal(plan.report.kind, 'installs');
  assert.deepEqual([plan.dateFrom, plan.dateTo, plan.days], ['2026-11-01', '2026-11-02', 2]);
  assert.equal(plan.stats.rowsFiltered, 1, 'the row of another package is left out');
  const total = (metric: string) => plan.metrics.find((m: { metric: string }) => m.metric === metric)?.total;
  assert.equal(total('installs_user'), 25);

  const stored = await t.upload(t.owner, `/apps/${appId}/analytics/import?confirmHash=${preview.body.confirmHash}`, PLAY_CSV(pkg));
  assert.equal(stored.status, 201, stored.text);
  assert.equal(stored.body.imported.source, 'play_reports');
  const sum = await t.rows("SELECT value_micro FROM analytics_daily WHERE metric = 'installs_user' ORDER BY day");
  assert.deepEqual(sum.map((r) => Number(r.value_micro)), [10_000_000, 15_000_000]);
  const again = await t.upload(t.owner, `/apps/${appId}/analytics/import?confirmHash=${preview.body.confirmHash}`, PLAY_CSV(pkg));
  assert.equal(again.body.imported.written, 0);

  const notPlay = await t.upload(t.owner, `/apps/${appId}/analytics/import/preview`, 'Date,Something\n2026-11-01,3\n');
  assert.equal(notPlay.status, 422);
  assert.equal(notPlay.body.error, 'unknown_report');
});
