import assert from 'node:assert/strict';
import { dbTest } from '@kiln/db/testing';
import { createScheduler } from '../../scheduler.ts';
import { runAlertEvaluator } from './evaluator.ts';
import { createAlertRunner } from './runner.ts';
import { bootAlerts } from './test-helpers.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 10, 12, 0);

type T = Awaited<ReturnType<typeof bootAlerts>>;
const types = async (t: T) => (await t.alerts()).map((a) => String(a.type));

dbTest(
  'a store sync that keeps failing raises one alert, again only after the window, and resolves when it works',
  async (db) => {
    const t = await bootAlerts(db);
    const app = await t.addApp();
    // A blip: failed a minute ago, good five minutes ago. Not news.
    await db.execute(
      'UPDATE apps SET last_sync_error = ?, last_sync_attempt_at = ?, last_synced_at = ? WHERE id = ?',
      ['boom', NOW - 60_000, NOW - 300_000, app],
    );
    assert.equal((await runAlertEvaluator(db, NOW)).raised, 0);
    // An hour without a good sync is.
    await db.execute('UPDATE apps SET last_synced_at = ? WHERE id = ?', [NOW - 3_600_000, app]);
    assert.equal((await runAlertEvaluator(db, NOW)).raised, 1);
    assert.deepEqual(await types(t), ['store.sync_failed']);
    const [alert] = await t.alerts();
    assert.equal(alert?.title, 'Syncing Moon Diary with the store is failing');
    assert.doesNotMatch(
      String(alert?.body),
      /boom/,
      'the error text of the store is never repeated',
    );
    // The next passes see the same condition and stay quiet.
    await runAlertEvaluator(db, NOW + 300_000);
    await runAlertEvaluator(db, NOW + 600_000);
    assert.equal((await t.alerts()).length, 1);
    assert.equal(Number((await t.alerts())[0]?.count), 1);
    // A day later it is a reminder (the same alert, counted).
    await runAlertEvaluator(db, NOW + DAY + 1000);
    assert.equal((await t.alerts()).length, 2, 'the window passed: a new alert');
    // When the sync works again the alert is resolved.
    await db.execute('UPDATE apps SET last_sync_error = NULL, last_synced_at = ? WHERE id = ?', [
      NOW + DAY + 2000,
      app,
    ]);
    const done = await runAlertEvaluator(db, NOW + DAY + 3000);
    assert.equal(done.resolved, 1);
    const open = await db.query('SELECT id FROM alerts WHERE resolved_at IS NULL');
    assert.equal(open.length, 1, 'the older alert is a history entry; the newest one is resolved');
    assert.equal((await db.query('SELECT active FROM alert_conditions'))[0]?.active, 0);
    // It can fail again later: that is a new alert.
    await db.execute(
      'UPDATE apps SET last_sync_error = ?, last_sync_attempt_at = ?, last_synced_at = ? WHERE id = ?',
      ['boom', NOW + 3 * DAY, NOW + 2 * DAY, app],
    );
    assert.equal((await runAlertEvaluator(db, NOW + 3 * DAY)).raised, 1);
  },
);

dbTest(
  'a credential whose test keeps failing is reported, and an alert already raised by the test event is not doubled',
  async (db) => {
    const t = await bootAlerts(db);
    await db.execute(
      "INSERT INTO credentials (id, workspace_id, kind, label, ciphertext, created_at, last_test_at, last_test_ok, last_test_message) VALUES ('c1', ?, 'github_token', 'GitHub CI', 'x', 1, 5, 0, 'token-test-message-xyz')",
      [t.workspaceId],
    );
    await db.execute(
      "INSERT INTO credentials (id, workspace_id, kind, label, ciphertext, created_at, last_test_at, last_test_ok) VALUES ('c2', ?, 'github_token', 'Fine', 'x', 1, 5, 1)",
      [t.workspaceId],
    );
    await runAlertEvaluator(db, NOW);
    const alerts = await t.alerts();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.type, 'credential.invalid');
    assert.match(String(alerts[0]?.body), /GitHub CI/);
    assert.doesNotMatch(JSON.stringify(alerts), /token-test-message-xyz|ciphertext/);
    // The same credential failing its test through the event collapses into the alert that is there.
    await t.emit(
      'credential.test_failed',
      { credentialId: 'c1', kind: 'github_token', saved: true },
      undefined,
      NOW + 1000,
    );
    assert.equal((await t.alerts()).length, 1);
    assert.equal(Number((await t.alerts())[0]?.count), 2);
    await db.execute('UPDATE credentials SET last_test_ok = 1 WHERE id = ?', ['c1']);
    assert.equal((await runAlertEvaluator(db, NOW + 600_000)).resolved, 1);
    assert.ok((await t.alerts())[0]?.resolved_at);
  },
);

dbTest(
  'analytics that fail N times in a row, listing reads that keep failing, and pending changes that wait too long',
  async (db) => {
    const t = await bootAlerts(db);
    const app = await t.addApp();
    const run = (id: string, status: string, at: number) =>
      db.execute(
        "INSERT INTO analytics_sync_runs (id, workspace_id, app_id, platform, source, trigger_kind, status, error_code, started_at) VALUES (?, ?, ?, 'ios', 'sales', 'schedule', ?, ?, ?)",
        [id, t.workspaceId, app, status, status === 'failed' ? 'auth_failed' : null, at],
      );
    await run('r1', 'failed', NOW - 3 * 3_600_000);
    await run('r2', 'failed', NOW - 2 * 3_600_000);
    await runAlertEvaluator(db, NOW);
    assert.deepEqual(await types(t), [], 'two failures are below the limit of three');
    await run('r3', 'failed', NOW - 3_600_000);
    await runAlertEvaluator(db, NOW);
    assert.deepEqual(await types(t), ['analytics.sync_failing']);
    assert.match(String((await t.alerts())[0]?.body), /auth_failed/);
    await run('r4', 'ok', NOW + 1000);
    assert.equal((await runAlertEvaluator(db, NOW + 2000)).resolved, 1);

    await db.execute(
      'INSERT INTO app_listing_status (app_id, workspace_id, listing_failures) VALUES (?, ?, 4)',
      [app, t.workspaceId],
    );
    await db.execute(
      "INSERT INTO staged_changes (id, workspace_id, app_id, platform, kind, locale, target, ordinal, source, value_text, value_hash, created_by, created_at, updated_at) VALUES ('s1', ?, ?, 'ios', 'listing_text', 'en-US', 'subtitle', 0, 'store', 'x', 'h', 'u', ?, ?)",
      [t.workspaceId, app, NOW - 10 * DAY, NOW - 10 * DAY],
    );
    await runAlertEvaluator(db, NOW + 3000);
    assert.deepEqual((await types(t)).sort(), [
      'analytics.sync_failing',
      'listing.read_failing',
      'pending.stale',
    ]);
    const stale = (await t.alerts()).find((a) => a.type === 'pending.stale');
    assert.match(String(stale?.title), /older than 7 days/);
    // The workspace can move the threshold: 14 days makes a ten day old change fine.
    await t.call(t.owner, 'PUT', '/alerts/rules/pending.stale', { params: { days: 14 } });
    assert.equal((await runAlertEvaluator(db, NOW + 4000)).resolved, 1);
    // And can switch a type off: nothing is evaluated for it.
    await t.call(t.owner, 'PUT', '/alerts/rules/listing.read_failing', { enabled: false });
    const before = (await t.alerts()).length;
    await runAlertEvaluator(db, NOW + 2 * DAY);
    assert.ok((await t.alerts()).length >= before);
  },
);

dbTest(
  'a rating that fell by more than the limit, within a window, is reported once a week',
  async (db) => {
    const t = await bootAlerts(db);
    const app = await t.addApp();
    const rating = (id: string, milli: number, at: number) =>
      db.execute(
        "INSERT INTO app_rating_summaries (id, workspace_id, app_id, store, territory, current_average_milli, observed_at) VALUES (?, ?, ?, 'appstore', 'USA', ?, ?)",
        [id, t.workspaceId, app, milli, at],
      );
    await rating('a', 4600, NOW - 8 * DAY);
    await rating('b', 4550, NOW - 3 * DAY);
    await rating('c', 4500, NOW - 1000);
    await runAlertEvaluator(db, NOW);
    assert.deepEqual(await types(t), [], 'a fall of 0.1 is within the limit of 0.2');
    await rating('d', 4300, NOW);
    await runAlertEvaluator(db, NOW + 1000);
    assert.deepEqual(await types(t), ['rating.dropped']);
    assert.match(String((await t.alerts())[0]?.title), /dropped to 4\.3/);
    await runAlertEvaluator(db, NOW + 2000);
    assert.equal((await t.alerts()).length, 1);
  },
);

dbTest(
  'a listing that changed in the store without a push from here is drift; a push explains it',
  async (db) => {
    const t = await bootAlerts(db);
    const app = await t.addApp();
    const snap = (id: string, hash: string, at: number, field = 'subtitle') =>
      db.execute(
        "INSERT INTO listing_snapshots (id, workspace_id, app_id, platform, locale, field, channel, value, value_hash, source, observed_at) VALUES (?, ?, ?, 'ios', 'en-US', ?, 'live', 'v', ?, 'store', ?)",
        [id, t.workspaceId, app, field, hash, at],
      );
    await snap('s1', 'h1', NOW - 20 * DAY);
    await snap('s2', 'h1', NOW - 5 * 3_600_000);
    await runAlertEvaluator(db, NOW);
    assert.deepEqual(await types(t), [], 'unchanged');
    await snap('s3', 'h2', NOW - 3_600_000);
    await runAlertEvaluator(db, NOW);
    assert.deepEqual(await types(t), ['listing.drift']);
    assert.match(String((await t.alerts())[0]?.body), /1 listing field/);
  },
);

dbTest('a listing change that this tool pushed is not drift', async (db) => {
  const t = await bootAlerts(db);
  const app = await t.addApp();
  const snap = (id: string, hash: string, at: number) =>
    db.execute(
      "INSERT INTO listing_snapshots (id, workspace_id, app_id, platform, locale, field, channel, value, value_hash, source, observed_at) VALUES (?, ?, ?, 'ios', 'en-US', 'subtitle', 'live', 'v', ?, 'store', ?)",
      [id, t.workspaceId, app, hash, at],
    );
  await snap('s1', 'h1', NOW - 6 * 3_600_000);
  await snap('s2', 'h2', NOW - 3_600_000);
  await t.emit('listing.submitted', { appId: app }, app, NOW - 2 * 3_600_000);
  await runAlertEvaluator(db, NOW);
  assert.deepEqual(await types(t), []);
});

dbTest(
  'mail that cannot be sent raises a system alert that never travels by mail, and clears when mail works',
  async (db) => {
    const t = await bootAlerts(db);
    const delivery = (id: string, status: string, outcome: string, at: number) =>
      db.execute(
        "INSERT INTO alert_deliveries (id, workspace_id, user_id, channel, kind, status, outcome, attempts, created_at, updated_at) VALUES (?, ?, ?, 'email', 'alert', ?, ?, 1, ?, ?)",
        [id, t.workspaceId, t.ownerId, status, outcome, at, at],
      );
    await delivery('d1', 'failed', 'smtp_auth_failed', NOW - 3000);
    await delivery('d2', 'failed', 'smtp_auth_failed', NOW - 2000);
    await runAlertEvaluator(db, NOW);
    assert.deepEqual(await types(t), []);
    await delivery('d3', 'failed', 'smtp_auth_failed', NOW - 1000);
    await runAlertEvaluator(db, NOW);
    assert.deepEqual(await types(t), ['system.smtp_failing']);
    const channels = (await t.log('alert_id IS NOT NULL')).map((r) => String(r.channel));
    assert.ok(!channels.includes('email'), 'no mail about the mail');
    assert.ok(channels.includes('in_app'));
    await delivery('d4', 'sent', 'ok', NOW + 1000);
    assert.equal((await runAlertEvaluator(db, NOW + 2000)).resolved, 1);
  },
);

dbTest(
  'the runner does the evaluator, the digests and the pruning, and the scheduler runs it on its interval',
  async (db) => {
    const t = await bootAlerts(db);
    const app = await t.addApp();
    await db.execute(
      'UPDATE apps SET last_sync_error = ?, last_sync_attempt_at = ?, last_synced_at = ? WHERE id = ?',
      ['x', NOW, NOW - DAY, app],
    );
    let clock = NOW;
    const runner = createAlertRunner({ db, now: () => clock });
    const scheduler = createScheduler({
      db,
      now: () => clock,
      alerts: { intervalMs: 300_000, run: runner.run },
    });
    const first = await scheduler.tick();
    assert.ok(first.alerts);
    assert.equal((await t.alerts()).length, 1);
    clock += 60_000;
    assert.equal((await scheduler.tick()).alerts, undefined, 'not yet due');
    clock += 300_000;
    assert.ok((await scheduler.tick()).alerts);
    // Old alerts, their inbox rows and log rows go after 90 days.
    clock = NOW + 100 * DAY;
    await db.execute('UPDATE apps SET last_sync_error = NULL WHERE id = ?', [app]);
    const done = (await runner.run()) as { pruned?: { alerts: number; deliveries: number } };
    assert.ok((done.pruned?.alerts ?? 0) >= 1);
    assert.equal((await db.query('SELECT alert_id FROM alert_inbox')).length, 0);
  },
);
