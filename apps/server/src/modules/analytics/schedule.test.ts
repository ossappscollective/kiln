import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dbTest } from '@kiln/db/testing';
import { createScheduler } from '../../scheduler.ts';
import { createTestLimiter } from '../../services/credential-tests.ts';
import { analyticsIntervalMs, queueAnalyticsSyncs } from './schedule.ts';
import { analyticsUpkeep } from './store.ts';
import { ANALYTICS_SYNC_QUEUE, createAnalyticsSyncHandler } from './sync.ts';
import { type AnalyticsBoot, bootAnalytics } from './test-helpers.ts';

/** Scheduled analytics syncs and the upkeep (docs/api/analytics.md, "Scheduling"). Everything runs against fakes. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test('analyticsIntervalMs accepts off or 15 to 10080 minutes', () => {
  assert.equal(analyticsIntervalMs(0), 0);
  assert.equal(analyticsIntervalMs(360), 6 * HOUR);
  assert.equal(analyticsIntervalMs(15), 15 * MINUTE);
  assert.equal(analyticsIntervalMs(10_080), 7 * DAY);
  for (const bad of [1, 14, 10_081, -1, 1.5])
    assert.throws(() => analyticsIntervalMs(bad), /analytics interval/, String(bad));
});

const queued = async (t: AnalyticsBoot) =>
  (await t.rows('SELECT payload FROM jobs WHERE queue = ?', [ANALYTICS_SYNC_QUEUE])).map(
    (r) =>
      JSON.parse(String(r.payload)) as { appId: string; workspaceId: string; requestedBy: string },
  );

dbTest(
  'nothing is queued until the workspace turns analytics on, however the interval is set',
  async (db) => {
    const t = await bootAnalytics(db);
    await t.addApp('android');
    const summary = await queueAnalyticsSyncs(db, {
      now: t.now(),
      intervalMs: 6 * HOUR,
      jitter: () => 0,
    });
    assert.equal(summary.queued, 0);
    assert.equal(summary.skipped.off, 1);
    assert.equal((await queued(t)).length, 0);
    await t.enable();
    assert.equal(
      (await queueAnalyticsSyncs(db, { now: t.now(), intervalMs: 6 * HOUR, jitter: () => 0 }))
        .queued,
      1,
    );
  },
);

dbTest(
  'only apps with something to read are queued: Android always, Apple with a request or the vendor number',
  async (db) => {
    const t = await bootAnalytics(db);
    await t.enable();
    const android = await t.addApp('android');
    const bare = await t.addApp('ios');
    const withRequest = await t.addApp('ios');
    await t.db.execute(
      `INSERT INTO analytics_report_requests (id, workspace_id, app_id, apple_request_id, access_type, status, created_by, created_at)
     VALUES ('r1', ?, ?, 'q', 'ONGOING', 'active', 'u', 1)`,
      [t.workspaceId, withRequest],
    );
    const first = await queueAnalyticsSyncs(db, {
      now: t.now(),
      intervalMs: 6 * HOUR,
      jitter: () => 0,
    });
    assert.equal(first.queued, 2);
    assert.equal(first.skipped.notReady, 1);
    assert.deepEqual((await queued(t)).map((j) => j.appId).sort(), [android, withRequest].sort());
    assert.ok((await queued(t)).every((j) => j.requestedBy === 'scheduler'));
    // With the vendor number set, the bare iOS app has Sales and Trends to read.
    await t.setSettings({ 'analytics.appleVendorNumber': '85123456' });
    await t.db.execute('DELETE FROM jobs');
    const second = await queueAnalyticsSyncs(db, {
      now: t.now(),
      intervalMs: 6 * HOUR,
      jitter: () => 0,
    });
    assert.equal(second.queued, 3);
    assert.ok((await queued(t)).some((j) => j.appId === bare));
  },
);

dbTest(
  'an app is due an interval after its last attempt, never queued twice, and the caps and the shared limiter hold',
  async (db) => {
    const t = await bootAnalytics(db);
    await t.enable();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await t.addApp('android'));
    const capped = await queueAnalyticsSyncs(db, {
      now: t.now(),
      intervalMs: 6 * HOUR,
      jitter: () => 0,
      perTick: 4,
      perWorkspace: 3,
    });
    assert.equal(capped.queued, 3, 'per workspace');
    assert.equal(capped.skipped.capped, 3);
    const again = await queueAnalyticsSyncs(db, {
      now: t.now(),
      intervalMs: 6 * HOUR,
      jitter: () => 0,
      perWorkspace: 10,
    });
    assert.equal(again.skipped.alreadyQueued, 3, 'not while a job waits');
    assert.equal(again.queued, 3);
    // The jobs are spaced out.
    const runs = (await t.rows('SELECT run_at FROM jobs ORDER BY run_at')).map((r) =>
      Number(r.run_at),
    );
    assert.ok(runs.every((r, i) => i === 0 || r > (runs[i - 1] ?? 0)));
    // After an attempt, the app waits an interval.
    await t.db.execute('DELETE FROM jobs');
    const attempt = t.now();
    for (const id of ids) {
      await t.db.execute(
        `INSERT INTO analytics_source_state (app_id, platform, source, workspace_id, last_attempt_at, updated_at) VALUES (?, 'android', 'play_vitals', ?, ?, ?)`,
        [id, t.workspaceId, attempt, attempt],
      );
    }
    const recent = await queueAnalyticsSyncs(db, {
      now: attempt + 5 * HOUR,
      intervalMs: 6 * HOUR,
      jitter: () => 0,
    });
    assert.deepEqual([recent.queued, recent.skipped.recent], [0, 6]);
    const due = await queueAnalyticsSyncs(db, {
      now: attempt + 7 * HOUR,
      intervalMs: 6 * HOUR,
      jitter: () => 0,
      perTick: 100,
      perWorkspace: 100,
    });
    assert.equal(due.queued, 6);
    // The workspace's limiter is shared: a slot is taken for each app queued.
    await t.db.execute('DELETE FROM jobs');
    const limiter = createTestLimiter({ limit: 2, now: t.now });
    const limited = await queueAnalyticsSyncs(db, {
      now: attempt + 7 * HOUR,
      intervalMs: 6 * HOUR,
      jitter: () => 0,
      perTick: 100,
      perWorkspace: 100,
      limiter,
    });
    assert.equal(limited.queued, 2);
    assert.equal(limited.skipped.rateLimited, 4);
  },
);

dbTest(
  'the scheduler queues analytics only when its interval is on, and the worker handler runs the same sync as the route',
  async (db) => {
    const t = await bootAnalytics(db);
    await t.enable();
    const appId = await t.addApp('android');
    t.vitals.points = [{ date: t.day(3), metric: 'crash_rate', value: 0.01 }];
    const off = await createScheduler({ db, now: t.now, jitter: () => 0 }).tick();
    assert.equal(off.analytics, undefined);
    assert.equal((await queued(t)).length, 0);
    const scheduler = createScheduler({
      db,
      now: t.now,
      jitter: () => 0,
      analyticsIntervalMs: 6 * HOUR,
    });
    const summary = await scheduler.tick();
    assert.equal(summary.analytics?.queued, 1);
    assert.deepEqual(summary.analyticsUpkeep, { runs: 0, instances: 0, orphans: 0 });
    assert.equal(
      (await scheduler.tick()).analyticsUpkeep,
      undefined,
      'the upkeep runs once an hour',
    );

    const [job] = await queued(t);
    assert.equal(job?.appId, appId);
    const handler = createAnalyticsSyncHandler({
      db,
      masterKey: t.masterKey,
      now: t.now,
      connectors: t.connectors,
      timeoutMs: 1000,
    });
    // A job with a bad payload does nothing, and nothing throws out of the handler.
    await handler({ nonsense: true }, undefined as never);
    assert.equal(Number((await t.rows())[0]?.n), 0);
    await handler(job, undefined as never);
    assert.equal(
      Number((await t.rows())[0]?.n),
      1,
      'the queued job ran the same sync as the route',
    );
    const runs = await t.rows('SELECT trigger_kind, status FROM analytics_sync_runs');
    assert.deepEqual(
      runs.map((r) => [String(r.trigger_kind), String(r.status)]),
      [['schedule', 'ok']],
    );
  },
);

dbTest(
  'upkeep removes old run rows and instance bookkeeping and rows of deleted apps, but keeps every daily fact',
  async (db) => {
    const t = await bootAnalytics(db);
    await t.enable();
    const appId = await t.addApp('android');
    t.vitals.points = [{ date: t.day(300), metric: 'crash_rate', value: 0.01 }];
    await t.call(t.owner, 'POST', `/apps/${appId}/analytics/sync`);
    const now = t.now();
    await t.db.execute(
      `INSERT INTO analytics_instances (app_id, apple_instance_id, workspace_id, apple_report_id, report_kind, status, read_at) VALUES (?, 'old', ?, 'r', 'downloads', 'read', ?)`,
      [appId, t.workspaceId, now - 130 * DAY],
    );
    await t.db.execute(
      `INSERT INTO analytics_instances (app_id, apple_instance_id, workspace_id, apple_report_id, report_kind, status, read_at) VALUES (?, 'new', ?, 'r', 'downloads', 'read', ?)`,
      [appId, t.workspaceId, now - DAY],
    );
    await t.db.execute(
      `INSERT INTO analytics_sync_runs (id, workspace_id, app_id, platform, source, trigger_kind, status, started_at) VALUES ('oldrun', ?, ?, 'android', 'play_vitals', 'manual', 'ok', ?)`,
      [t.workspaceId, appId, now - 100 * DAY],
    );
    await t.db.execute(
      `INSERT INTO analytics_daily (app_id, platform, source, metric, day, workspace_id, value_micro, updated_at) VALUES ('ghost', 'android', 'play_vitals', 'crash_rate', '2026-01-01', ?, 5, 1)`,
      [t.workspaceId],
    );
    const summary = await analyticsUpkeep(db, { now });
    assert.deepEqual(summary, { runs: 1, instances: 1, orphans: 1 });
    assert.equal(
      Number(
        (await t.rows('SELECT COUNT(*) AS n FROM analytics_daily WHERE app_id = ?', [appId]))[0]?.n,
      ),
      1,
      'a stored day is never pruned',
    );
    assert.equal(Number((await t.rows('SELECT COUNT(*) AS n FROM analytics_instances'))[0]?.n), 1);
  },
);
