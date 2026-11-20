import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dbTest } from '@mrm/db/testing';
import { bootAso } from './test-helpers.ts';
import { createScheduler } from '../../scheduler.ts';
import { ASO_REFRESH_QUEUE } from './service.ts';
import { asoIntervalMs, asoUpkeep, queueAsoRefreshes } from './schedule.ts';

/** Scheduled ASO refreshes and the retention upkeep (docs/api/aso.md, "Scheduling"). */

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

test('asoIntervalMs accepts off or 60 to 10080 minutes', () => {
  assert.equal(asoIntervalMs(0), 0);
  assert.equal(asoIntervalMs(60), HOUR);
  assert.equal(asoIntervalMs(10_080), 7 * DAY);
  for (const bad of [1, 59, 10_081, -1, 1.5])
    assert.throws(() => asoIntervalMs(bad), /ASO interval/, String(bad));
});

const queued = async (db: import('@mrm/db').Database) =>
  (
    await db.query('SELECT payload, run_at FROM jobs WHERE queue = ? ORDER BY run_at', [
      ASO_REFRESH_QUEUE,
    ])
  ).map((r) => ({
    ...(JSON.parse(String(r.payload)) as {
      appId: string;
      workspaceId: string;
      requestedBy: string;
      force?: boolean;
    }),
    runAt: Number(r.run_at),
  }));

dbTest(
  'only apps with something to look at are queued, spaced, one job each, never twice',
  async (db) => {
    const t = await bootAso(db);
    const a = await t.addApp('ios');
    const b = await t.addApp('ios');
    await t.addApp('ios'); // nothing tracked
    await t.addKeywords(a, [{ term: 'k one' }]);
    t.sources.setApp('ios', 'us', { id: '555', name: 'Rival' });
    await t.call(t.owner, 'POST', `/apps/${b}/aso/competitors`, { externalId: '555' });
    const now = t.clock.now();
    const options = { now, intervalMs: HOUR, playEnabled: false, jitter: () => 0, spacingMs: 1000 };
    const first = await queueAsoRefreshes(db, options);
    assert.equal(first.queued, 2);
    const jobs = await queued(db);
    assert.deepEqual(jobs.map((j) => j.appId).sort(), [a, b].sort());
    assert.deepEqual(
      jobs.map((j) => j.runAt),
      [now, now + 1000],
      'spaced',
    );
    assert.equal(
      jobs.every((j) => j.requestedBy === 'scheduler'),
      true,
    );
    assert.equal(
      jobs.every((j) => j.force === undefined),
      true,
      'the scheduler asks for what is due, not for everything',
    );
    const again = await queueAsoRefreshes(db, options);
    assert.deepEqual({ q: again.queued, s: again.skipped.alreadyQueued }, { q: 0, s: 2 });
  },
);

dbTest(
  'recent, backoff, claim, not ready, Google Play off and the per tick cap each skip an app',
  async (db) => {
    const t = await bootAso(db);
    const ios = await t.addApp('ios');
    const droid = await t.addApp('android');
    const notSynced = await t.addApp('ios');
    await db.execute('UPDATE apps SET store_app_id = NULL WHERE id = ?', [notSynced]);
    for (const id of [ios, droid, notSynced]) await t.addKeywords(id, [{ term: 'k one' }]);
    const now = t.clock.now();
    const base = { now, intervalMs: HOUR, jitter: () => 0 };

    const off = await queueAsoRefreshes(db, { ...base, playEnabled: false });
    assert.deepEqual(
      { q: off.queued, play: off.skipped.playOff, nr: off.skipped.notReady },
      { q: 1, play: 1, nr: 1 },
    );
    await db.execute('DELETE FROM jobs WHERE queue = ?', [ASO_REFRESH_QUEUE]);

    const on = await queueAsoRefreshes(db, { ...base, playEnabled: true });
    assert.equal(on.queued, 2, 'with Google Play on, the Android app is queued too');
    await db.execute('DELETE FROM jobs WHERE queue = ?', [ASO_REFRESH_QUEUE]);

    // Recent: an attempt inside the interval.
    await db.execute(
      'INSERT INTO aso_app_state (app_id, workspace_id, last_attempt_at) VALUES (?, ?, ?)',
      [ios, t.workspaceId, now - 10 * 60_000],
    );
    assert.equal((await queueAsoRefreshes(db, { ...base, playEnabled: false })).skipped.recent, 1);
    // Due again after the interval.
    await db.execute('UPDATE aso_app_state SET last_attempt_at = ? WHERE app_id = ?', [
      now - 2 * HOUR,
      ios,
    ]);
    assert.equal((await queueAsoRefreshes(db, { ...base, playEnabled: false })).queued, 1);
    await db.execute('DELETE FROM jobs WHERE queue = ?', [ASO_REFRESH_QUEUE]);
    // Backoff after failures.
    await db.execute(
      'UPDATE aso_app_state SET backoff_until = ?, consecutive_failures = 2 WHERE app_id = ?',
      [now + HOUR, ios],
    );
    const backoff = await queueAsoRefreshes(db, { ...base, playEnabled: false });
    assert.deepEqual({ q: backoff.queued, b: backoff.skipped.backoff }, { q: 0, b: 1 });
    // A live claim of a running refresh.
    await db.execute(
      'UPDATE aso_app_state SET backoff_until = NULL, claimed_at = ? WHERE app_id = ?',
      [now - 60_000, ios],
    );
    assert.equal((await queueAsoRefreshes(db, { ...base, playEnabled: false })).skipped.claimed, 1);
    // A stale one does not count.
    await db.execute('UPDATE aso_app_state SET claimed_at = ? WHERE app_id = ?', [
      now - 30 * 60_000,
      ios,
    ]);
    assert.equal((await queueAsoRefreshes(db, { ...base, playEnabled: false })).queued, 1);
    await db.execute('DELETE FROM jobs WHERE queue = ?', [ASO_REFRESH_QUEUE]);

    // Work left over from the last run (it stopped at the cap) comes back after 30 minutes, not after the interval.
    await db.execute(
      'UPDATE aso_app_state SET claimed_at = NULL, last_attempt_at = ?, last_result = ? WHERE app_id = ?',
      [now - 40 * 60_000, JSON.stringify({ deferred: true }), ios],
    );
    assert.equal((await queueAsoRefreshes(db, { ...base, playEnabled: false })).queued, 1);
    await db.execute('DELETE FROM jobs WHERE queue = ?', [ASO_REFRESH_QUEUE]);

    const capped = await queueAsoRefreshes(db, { ...base, playEnabled: true, perTick: 1 });
    assert.deepEqual({ q: capped.queued, c: capped.skipped.capped }, { q: 1, c: 1 });
    await db.execute('DELETE FROM jobs WHERE queue = ?', [ASO_REFRESH_QUEUE]);

    const limited = await queueAsoRefreshes(db, {
      ...base,
      playEnabled: true,
      limiter: { take: () => 30 },
    });
    assert.deepEqual({ q: limited.queued, r: limited.skipped.rateLimited }, { q: 0, r: 2 });
  },
);

dbTest(
  'the scheduler queues ASO refreshes only when the interval is on, and runs the upkeep',
  async (db) => {
    const t = await bootAso(db);
    const a = await t.addApp('ios');
    await t.addKeywords(a, [{ term: 'k one' }]);
    const off = createScheduler({ db, now: t.clock.now, jitter: () => 0 });
    const quiet = await off.tick();
    assert.equal(quiet.aso, undefined);
    assert.equal(quiet.asoUpkeep, undefined);
    assert.equal((await queued(db)).length, 0);

    const on = createScheduler({
      db,
      now: t.clock.now,
      jitter: () => 0,
      asoIntervalMs: HOUR,
      asoPlayEnabled: false,
      asoRetentionDays: 30,
    });
    const summary = await on.tick();
    assert.equal(summary.aso?.queued, 1);
    assert.deepEqual(summary.asoUpkeep, { rankChecks: 0, snapshots: 0, orphans: 0 });
    assert.equal((await queued(db)).length, 1);
    const second = await on.tick();
    assert.equal(second.aso?.queued, 0);
    assert.equal(second.asoUpkeep, undefined, 'the upkeep runs once an hour');
  },
);

dbTest(
  'upkeep deletes old checks and snapshots, keeps the newest snapshot of a competitor, and removes rows of deleted apps',
  async (db) => {
    const t = await bootAso(db);
    const appId = await t.addApp('ios');
    await t.addKeywords(appId, [{ term: 'k one' }]);
    t.sources.setApp('ios', 'us', { id: '555', name: 'Rival' });
    await t.call(t.owner, 'POST', `/apps/${appId}/aso/competitors`, { externalId: '555' });
    const [kw] = await db.query('SELECT id FROM aso_keywords');
    const [comp] = await db.query('SELECT id FROM aso_competitors');
    const now = t.clock.now();
    const old = now - 400 * DAY;
    const check = (id: string, at: number) =>
      db.execute(
        "INSERT INTO aso_rank_checks (id, workspace_id, keyword_id, app_id, checked_at, rank_pos, total, source) VALUES (?, ?, ?, ?, ?, 3, 50, 'apple_search')",
        [id, t.workspaceId, String(kw?.id), appId, at],
      );
    await check('c-old-1', old);
    await check('c-old-2', old + 1);
    await check('c-new', now - DAY);
    const snap = (id: string, at: number) =>
      db.execute(
        "INSERT INTO aso_competitor_snapshots (id, workspace_id, competitor_id, app_id, checked_at, kind, text_hash) VALUES (?, ?, ?, ?, ?, 'heartbeat', 'h')",
        [id, t.workspaceId, String(comp?.id), appId, at],
      );
    await snap('s-old-1', old);
    await snap('s-old-2', old + 5);
    await db.execute('UPDATE aso_competitor_snapshots SET checked_at = ? WHERE kind = ?', [
      old - DAY,
      'first',
    ]);

    // Rows of an app that is gone.
    await db.execute(
      "INSERT INTO aso_keywords (id, workspace_id, app_id, platform, country, locale, term, term_key, priority, created_by, created_at, updated_at) VALUES ('ghost-k', ?, 'ghost-app', 'ios', 'us', 'en-US', 'g', 'g', 2, 'u', 1, 1)",
      [t.workspaceId],
    );
    await db.execute("INSERT INTO aso_app_state (app_id, workspace_id) VALUES ('ghost-app', ?)", [
      t.workspaceId,
    ]);

    const summary = await asoUpkeep(db, { now, retentionDays: 365 });
    assert.equal(summary.rankChecks, 2);
    assert.equal(summary.snapshots, 2, 'the newest snapshot of the competitor is never pruned');
    assert.equal(summary.orphans, 2);
    assert.deepEqual(
      (await db.query('SELECT id FROM aso_rank_checks')).map((r) => r.id),
      ['c-new'],
    );
    assert.deepEqual(
      (await db.query('SELECT id FROM aso_competitor_snapshots')).map((r) => r.id),
      ['s-old-2'],
    );
    assert.equal((await db.query("SELECT id FROM aso_keywords WHERE id = 'ghost-k'")).length, 0);

    // 0 keeps everything (but orphans still go).
    await check('c-keep', old);
    const kept = await asoUpkeep(db, { now, retentionDays: 0 });
    assert.equal(kept.rankChecks, 0);
    assert.equal((await db.query("SELECT id FROM aso_rank_checks WHERE id = 'c-keep'")).length, 1);
  },
);
