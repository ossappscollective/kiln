import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dbTest } from '@kiln/db/testing';
import { CI_POLL_QUEUE, refreshRuns } from './modules/ci/service.ts';
import { bootCi, run, SHA_2 } from './modules/ci/test-helpers.ts';
import {
  createScheduler,
  MAX_SYNC_INTERVAL_MINUTES,
  MIN_SYNC_INTERVAL_MINUTES,
  syncIntervalMs,
} from './scheduler.ts';
import { APP_SYNC_QUEUE } from './services/apps.ts';
import { getRepository } from './services/repositories.ts';

// Every tick here runs on an injected clock, jitter and limiter: nothing waits, nothing is random,
// and the scheduler only ever queues jobs (the worker is not started).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = 1_800_000_000_000 + 10 * MINUTE;

type Booted = Awaited<ReturnType<typeof bootCi>>;

const jobs = (t: Booted, queue: string) =>
  t.db.query('SELECT payload, run_at, status FROM jobs WHERE queue = ? ORDER BY run_at, id', [
    queue,
  ]);
const syncedApps = async (t: Booted, status?: string) =>
  (await jobs(t, APP_SYNC_QUEUE))
    .filter((j) => status === undefined || j.status === status)
    .map((j) => (JSON.parse(String(j.payload)) as { appId: string }).appId)
    .sort();

/** Pretends the queued sync jobs ran: they are done, and the apps were attempted at `at`. */
async function finishSyncs(t: Booted, at: number) {
  await t.db.execute("UPDATE jobs SET status = 'done' WHERE queue = ?", [APP_SYNC_QUEUE]);
  await t.db.execute('UPDATE apps SET last_sync_attempt_at = ?', [at]);
}

/** Reads the fake GitHub's runs into the store, at START. */
async function refreshNow(t: Booted) {
  const repository = await getRepository(t.db, t.workspaceId, t.repositoryId);
  assert.ok(repository);
  await refreshRuns(
    t.context({ now: START }),
    { workspaceId: t.workspaceId, repository, force: true },
    { type: 'system', id: 'test' },
  );
}

async function startRun(t: Booted, status: string, id = '3001') {
  t.fake.runs = [run(id, { status, conclusion: status === 'completed' ? 'success' : undefined })];
  await refreshNow(t);
}

test('syncIntervalMs: off, or whole minutes between the bounds', () => {
  assert.equal(syncIntervalMs(0), 0);
  assert.equal(syncIntervalMs(MIN_SYNC_INTERVAL_MINUTES), 5 * MINUTE);
  assert.equal(syncIntervalMs(60), HOUR);
  assert.equal(syncIntervalMs(MAX_SYNC_INTERVAL_MINUTES), 7 * 24 * HOUR);
  for (const bad of [1, 4, MAX_SYNC_INTERVAL_MINUTES + 1, 7.5, -5, Number.NaN]) {
    assert.throws(() => syncIntervalMs(bad), /sync interval/, String(bad));
  }
});

dbTest('with the interval off no sync is queued', async (db) => {
  const t = await bootCi(db);
  await t.seedApp('ios', [{ version: '1.0', build: '1' }]);
  const scheduler = createScheduler({ db, now: () => START });
  const summary = await scheduler.tick();
  assert.equal(summary.syncsQueued, 0);
  assert.equal((await jobs(t, APP_SYNC_QUEUE)).length, 0);
});

dbTest(
  'every app is queued once, with its own jitter, and not again while its job waits',
  async (db) => {
    const t = await bootCi(db);
    const a = await t.seedApp('ios', [{ version: '1.0', build: '1' }]);
    const b = await t.seedApp('android', [{ version: '1.0', build: '1' }]);
    const asked: [string, number][] = [];
    const scheduler = createScheduler({
      db,
      now: () => START,
      syncIntervalMs: HOUR,
      jitter: (key, max) => {
        asked.push([key, max]);
        return key === a ? 1_234 : 10 * HOUR;
      },
    });

    const first = await scheduler.tick();
    assert.equal(first.syncsQueued, 2);
    assert.deepEqual(await syncedApps(t), [a, b].sort());
    assert.deepEqual(
      asked.map(([, max]) => max),
      [5 * MINUTE, 5 * MINUTE],
      'a tenth of the interval, at most 5 minutes',
    );
    const byApp = new Map(
      (await jobs(t, APP_SYNC_QUEUE)).map((j) => [
        (JSON.parse(String(j.payload)) as { appId: string }).appId,
        Number(j.run_at),
      ]),
    );
    assert.equal(byApp.get(a), START + 1_234);
    assert.equal(
      byApp.get(b),
      START + 5 * MINUTE,
      'a jitter that is too large is cut to the maximum',
    );
    const payload = JSON.parse(String((await jobs(t, APP_SYNC_QUEUE))[0]?.payload));
    assert.equal(payload.workspaceId, t.workspaceId);
    assert.equal(payload.requestedBy, 'scheduler');

    const second = await scheduler.tick();
    assert.equal(second.syncsQueued, 0);
    assert.equal(second.skipped.alreadyQueued, 2);
    assert.equal((await jobs(t, APP_SYNC_QUEUE)).length, 2);
  },
);

dbTest(
  'an app synced or attempted within the interval is skipped, until the interval has passed',
  async (db) => {
    const clock = { now: START };
    const t = await bootCi(db);
    const fresh = await t.seedApp('ios', [{ version: '1.0', build: '1' }], {
      identifier: 'com.acme.fresh',
    });
    const attempted = await t.seedApp('ios', [{ version: '1.0', build: '1' }], {
      identifier: 'com.acme.attempted',
    });
    const stale = await t.seedApp('ios', [{ version: '1.0', build: '1' }], {
      identifier: 'com.acme.stale',
    });
    await db.execute('UPDATE apps SET last_synced_at = ? WHERE id = ?', [
      START - 10 * MINUTE,
      fresh,
    ]);
    await db.execute('UPDATE apps SET last_sync_attempt_at = ? WHERE id = ?', [
      START - 20 * MINUTE,
      attempted,
    ]);
    await db.execute('UPDATE apps SET last_synced_at = ? WHERE id = ?', [START - 2 * HOUR, stale]);
    const scheduler = createScheduler({
      db,
      now: () => clock.now,
      syncIntervalMs: HOUR,
      jitter: () => 0,
    });

    const first = await scheduler.tick();
    assert.deepEqual(await syncedApps(t), [stale]);
    assert.equal(
      first.skipped.recent,
      2,
      'a failed attempt counts too, so a broken credential is not hammered',
    );

    // The job ran at START: the stale app counts from there, the others from their own last attempt.
    await finishSyncs(t, START);
    await db.execute('UPDATE apps SET last_sync_attempt_at = ? WHERE id = ?', [
      START - 20 * MINUTE,
      attempted,
    ]);
    await db.execute('UPDATE apps SET last_sync_attempt_at = NULL WHERE id = ?', [fresh]);
    clock.now = START + 30 * MINUTE;
    const quiet = await scheduler.tick();
    assert.equal(quiet.syncsQueued, 0, 'nothing is due yet on the injected clock');
    assert.equal(quiet.skipped.recent, 3);

    clock.now = START + HOUR - 1;
    assert.equal(
      (await scheduler.tick()).syncsQueued,
      2,
      'the other two are due, the stale one is not',
    );
    assert.deepEqual(await syncedApps(t, 'queued'), [attempted, fresh].sort());
  },
);

dbTest(
  'the rate limiter of the sync route is respected, and a refused workspace is left alone',
  async (db) => {
    const t = await bootCi(db);
    for (let i = 0; i < 4; i++) {
      await t.seedApp('ios', [{ version: '1.0', build: '1' }], { identifier: `com.acme.app${i}` });
    }
    let slots = 2;
    const taken: string[] = [];
    const scheduler = createScheduler({
      db,
      now: () => START,
      syncIntervalMs: HOUR,
      jitter: () => 0,
      limiter: {
        take(key) {
          taken.push(key);
          return slots-- > 0 ? 0 : 30;
        },
      },
    });
    const summary = await scheduler.tick();
    assert.equal(summary.syncsQueued, 2);
    assert.equal(summary.skipped.rateLimited, 2);
    assert.deepEqual(
      taken,
      [t.workspaceId, t.workspaceId, t.workspaceId],
      'once refused, the workspace is not asked again',
    );
    assert.equal((await syncedApps(t)).length, 2);

    // The next tick takes up where this one stopped (the rest have never been attempted).
    slots = 10;
    assert.equal((await scheduler.tick()).syncsQueued, 2);
  },
);

dbTest('a tick queues at most a few syncs per workspace and in total', async (db) => {
  const t = await bootCi(db);
  for (let i = 0; i < 5; i++) {
    await t.seedApp('ios', [{ version: '1.0', build: '1' }], { identifier: `com.acme.app${i}` });
  }
  const perWorkspace = createScheduler({
    db,
    now: () => START,
    syncIntervalMs: HOUR,
    jitter: () => 0,
    perWorkspacePerTick: 2,
  });
  const first = await perWorkspace.tick();
  assert.equal(first.syncsQueued, 2);
  assert.equal(first.skipped.capped, 3);
  const second = await perWorkspace.tick();
  assert.equal(second.syncsQueued, 2, 'the apps already queued are not queued twice');
  assert.equal(second.skipped.alreadyQueued, 2);

  await db.execute('DELETE FROM jobs');
  const total = createScheduler({
    db,
    now: () => START,
    syncIntervalMs: HOUR,
    jitter: () => 0,
    maxPerTick: 3,
  });
  assert.equal((await total.tick()).syncsQueued, 3);
});

dbTest(
  'a run that is still going gets a poll queued, once, and only while it is recent',
  async (db) => {
    const clock = { now: START };
    const t = await bootCi(db);
    await startRun(t, 'in_progress');
    const scheduler = createScheduler({ db, now: () => clock.now });

    const first = await scheduler.tick();
    assert.equal(first.pollsQueued, 1);
    assert.equal(first.syncsQueued, 0, 'scheduled syncs are off here, polls are not');
    const [queued] = await jobs(t, CI_POLL_QUEUE);
    const payload = JSON.parse(String(queued?.payload));
    assert.equal(payload.repositoryId, t.repositoryId);
    assert.equal(payload.workspaceId, t.workspaceId);
    assert.equal(payload.requestedBy, 'scheduler');
    assert.equal(Number(queued?.run_at), START);

    assert.equal((await scheduler.tick()).pollsQueued, 0, 'a poll is already waiting');

    await db.execute("UPDATE jobs SET status = 'done'");
    clock.now = START + 4 * HOUR;
    assert.equal(
      (await scheduler.tick()).pollsQueued,
      0,
      'older than the maximum duration: given up',
    );
    clock.now = START + HOUR;
    assert.equal((await scheduler.tick()).pollsQueued, 1);
  },
);

dbTest('finished runs are not polled', async (db) => {
  const t = await bootCi(db);
  await startRun(t, 'completed');
  const summary = await createScheduler({ db, now: () => START }).tick();
  assert.equal(summary.pollsQueued, 0);
  assert.equal((await jobs(t, CI_POLL_QUEUE)).length, 0);
});

dbTest('rows of a disconnected repository and of a deleted app are removed', async (db) => {
  const t = await bootCi(db);
  const appId = await t.seedApp('ios', [{ version: '2.4.0', build: '240' }]);
  t.fake.runs = [run('3100', { displayTitle: 'build 240', headSha: SHA_2 })];
  await refreshNow(t);
  const scheduler = createScheduler({ db, now: () => START });
  assert.equal((await scheduler.tick()).purged, 0, 'nothing is orphaned yet');
  assert.equal((await db.query('SELECT id FROM build_links')).length, 1);

  await db.execute('DELETE FROM app_releases WHERE app_id = ?', [appId]);
  await db.execute('DELETE FROM apps WHERE id = ?', [appId]);
  await db.execute('DELETE FROM repositories WHERE id = ?', [t.repositoryId]);
  assert.equal((await scheduler.tick()).purged, 2, 'one run row and one link');
  assert.equal((await db.query('SELECT id FROM workflow_runs')).length, 0);
  assert.equal((await db.query('SELECT id FROM build_links')).length, 0);
});

dbTest(
  'start ticks on its own, a failing tick is reported and does not stop it, stop waits',
  async (db) => {
    const t = await bootCi(db);
    await t.seedApp('ios', [{ version: '1.0', build: '1' }]);
    const errors: string[] = [];
    const scheduler = createScheduler({
      db,
      now: () => START,
      syncIntervalMs: HOUR,
      jitter: () => 0,
      tickMs: 5,
      onError: (message) => errors.push(message),
    });
    scheduler.start();
    scheduler.start();
    for (let i = 0; i < 100 && (await jobs(t, APP_SYNC_QUEUE)).length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await scheduler.stop();
    assert.equal((await jobs(t, APP_SYNC_QUEUE)).length, 1);
    assert.equal(errors.length, 0);

    const broken = createScheduler({
      db: { ...db, query: async () => Promise.reject(new Error('database is gone')) } as typeof db,
      tickMs: 5,
      onError: (message) => errors.push(message),
    });
    broken.start();
    for (let i = 0; i < 100 && errors.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await broken.stop();
    assert.ok(errors.length >= 2, 'it keeps ticking after a failure');
    assert.equal(errors[0], 'scheduler tick failed');
  },
);
