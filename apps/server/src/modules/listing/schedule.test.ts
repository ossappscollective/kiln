import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StoreError } from '@kiln/connectors';
import { dbTest } from '@kiln/db/testing';
import { claimNext } from '../../jobs.ts';
import { createScheduler } from '../../scheduler.ts';
import { APP_SYNC_QUEUE } from '../../services/apps.ts';
import { createTestLimiter } from '../../services/credential-tests.ts';
import { listingBackoffMs, listingDueAt } from './drift.ts';
import {
  claimListingRead,
  createListingReadHandler,
  DEFAULT_LISTING_PER_TICK,
  DEFAULT_LISTING_PER_WORKSPACE,
  forgetRunningListingReads,
  LISTING_READ_QUEUE,
  listingIntervalMs,
  queueListingReads,
  runListingRead,
} from './schedule.ts';
import {
  ASC_SECRET,
  bootListing,
  EN_US,
  iosListing,
  iosSections,
  type ListingBoot,
  playListing,
} from './test-helpers.ts';

// Scheduled listing reads. Every pass runs on an injected clock, jitter and limiter, and every read
// on a fake store connector: nothing waits, nothing is random, no store is contacted, and the
// worker is not started (the jobs are claimed by hand where that matters).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const START = 1_800_000_000_000 + 10 * MINUTE;
const INTERVAL = HOUR;
const noJitter = () => 0;

// ---------------------------------------------------------------------------------------------
// Pure

test('listingIntervalMs: off, or whole minutes between the bounds', () => {
  assert.equal(listingIntervalMs(0), 0);
  assert.equal(listingIntervalMs(30), 30 * MINUTE);
  assert.equal(listingIntervalMs(60), HOUR);
  assert.equal(listingIntervalMs(7 * 24 * 60), 7 * DAY);
  for (const bad of [1, 29, 10_081, 45.5, -30, Number.NaN]) {
    assert.throws(() => listingIntervalMs(bad), /listing read interval/, String(bad));
  }
});

test('listingBackoffMs doubles with every failure, up to a day (or the interval, when that is longer)', () => {
  assert.equal(listingBackoffMs(HOUR, 0), HOUR);
  assert.equal(listingBackoffMs(HOUR, 1), 2 * HOUR);
  assert.equal(listingBackoffMs(HOUR, 3), 8 * HOUR);
  assert.equal(listingBackoffMs(HOUR, 5), DAY, 'capped at a day: 32 hours would be more');
  assert.equal(listingBackoffMs(HOUR, 50), DAY);
  assert.equal(
    listingBackoffMs(2 * DAY, 4),
    2 * DAY,
    'an interval longer than a day is never shortened',
  );
  assert.equal(listingBackoffMs(HOUR, -3), HOUR);
  assert.equal(listingBackoffMs(HOUR, 1.9), 2 * HOUR);
});

test('listingDueAt: never tried is due now (null), otherwise the later of read and attempt plus the backoff', () => {
  assert.equal(listingDueAt(HOUR, { readAt: null, attemptAt: null }, 0), null);
  assert.equal(listingDueAt(HOUR, { readAt: 1000, attemptAt: null }, 0), 1000 + HOUR);
  assert.equal(listingDueAt(HOUR, { readAt: 1000, attemptAt: 5000 }, 0), 5000 + HOUR);
  assert.equal(listingDueAt(HOUR, { readAt: 9000, attemptAt: 5000 }, 0), 9000 + HOUR);
  assert.equal(listingDueAt(HOUR, { readAt: 1000, attemptAt: 5000 }, 2), 5000 + 4 * HOUR);
});

// ---------------------------------------------------------------------------------------------
// Queueing

/** A workspace with `n` iOS apps, each with a credential of its own unless `shared` says otherwise. */
async function apps(t: ListingBoot, n: number, shared = false): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const credentialId = shared
      ? t.iosCredential
      : await t.addCredential('app_store_connect', ASC_SECRET);
    const res = await t.call(t.owner, 'POST', '/apps', {
      platform: 'ios',
      identifier: `com.acme.app${i}`,
      credentialId,
    });
    assert.equal(res.status, 201, res.text);
    ids.push(res.body.app.id);
  }
  return ids;
}

const status = (
  t: ListingBoot,
  appId: string,
  s: { read?: number; attempt?: number; failures?: number },
) =>
  t.db.execute(
    `INSERT INTO app_listing_status (app_id, workspace_id, listing_read_at, listing_attempt_at, listing_failures)
     VALUES (?, ?, ?, ?, ?)`,
    [appId, t.workspaceId, s.read ?? null, s.attempt ?? null, s.failures ?? 0],
  );

const queued = async (t: ListingBoot, queue = LISTING_READ_QUEUE) =>
  (
    await t.db.query(
      'SELECT payload, run_at, status FROM jobs WHERE queue = ? ORDER BY run_at, id',
      [queue],
    )
  ).map((j) => ({
    ...(JSON.parse(String(j.payload)) as {
      appId: string;
      credentialId: string;
      requestedBy: string;
      workspaceId: string;
    }),
    runAt: Number(j.run_at),
    status: String(j.status),
  }));

dbTest(
  'off by default: with no interval nothing is queued, by the queue or by the scheduler',
  async (db) => {
    const t = await bootListing(db);
    await apps(t, 2);
    const summary = await queueListingReads(db, { now: START, intervalMs: 0 });
    assert.equal(summary.queued, 0);
    const scheduler = createScheduler({ db, now: () => START });
    const tick = await scheduler.tick();
    assert.equal(tick.listings, undefined, 'the tick does not even report listing reads');
    assert.equal((await queued(t)).length, 0);
    // The sync interval alone does not turn it on either.
    const synced = createScheduler({ db, now: () => START, syncIntervalMs: HOUR });
    await synced.tick();
    assert.equal((await queued(t)).length, 0);
  },
);

dbTest('a pass queues the apps that are due, spaced apart, at most perTick of them', async (db) => {
  const t = await bootListing(db);
  const ids = await apps(t, 5);
  const summary = await queueListingReads(db, {
    now: START,
    intervalMs: INTERVAL,
    perTick: 3,
    perWorkspace: 10,
    spacingMs: 15_000,
    jitter: noJitter,
  });
  assert.equal(summary.queued, 3);
  assert.equal(summary.skipped.capped, 2);
  const jobs = await queued(t);
  assert.deepEqual(
    jobs.map((j) => j.appId),
    ids.slice(0, 3),
    'the apps that were never read go first, in order',
  );
  assert.deepEqual(
    jobs.map((j) => j.runAt),
    [START, START + 15_000, START + 30_000],
  );
  assert.ok(
    jobs.every(
      (j) =>
        j.requestedBy === 'scheduler' && j.workspaceId === t.workspaceId && j.status === 'queued',
    ),
  );

  // The next pass: the three are in flight, so the other two are next, not the same three again.
  const next = await queueListingReads(db, {
    now: START + MINUTE,
    intervalMs: INTERVAL,
    perTick: 3,
    perWorkspace: 10,
    jitter: noJitter,
  });
  assert.equal(next.queued, 2);
  assert.equal(next.skipped.alreadyQueued, 3);
  assert.deepEqual((await queued(t)).map((j) => j.appId).sort(), [...ids].sort());
});

dbTest('the defaults are small, and a workspace has a smaller share of a pass', async (db) => {
  const t = await bootListing(db);
  await apps(t, 6);
  const summary = await queueListingReads(db, {
    now: START,
    intervalMs: INTERVAL,
    jitter: noJitter,
  });
  assert.equal(DEFAULT_LISTING_PER_TICK, 3);
  assert.equal(DEFAULT_LISTING_PER_WORKSPACE, 2);
  assert.equal(summary.queued, 2, 'one workspace gets two');
  assert.equal(summary.skipped.capped, 4);
});

dbTest('jitter is added to the spacing and is bounded', async (db) => {
  const t = await bootListing(db);
  await apps(t, 2);
  await queueListingReads(db, {
    now: START,
    intervalMs: INTERVAL,
    spacingMs: 10_000,
    maxJitterMs: 5_000,
    jitter: () => 10 ** 9,
  });
  assert.deepEqual(
    (await queued(t)).map((j) => j.runAt),
    [START + 5_000, START + 10_000 + 5_000],
  );
});

dbTest(
  'one read at a time per credential: apps that share a credential are queued one after the other',
  async (db) => {
    const t = await bootListing(db);
    const ids = await apps(t, 3, true);
    const first = await queueListingReads(db, {
      now: START,
      intervalMs: INTERVAL,
      perTick: 10,
      perWorkspace: 10,
      jitter: noJitter,
    });
    assert.equal(first.queued, 1);
    assert.equal(first.skipped.credentialBusy, 2);
    assert.deepEqual(
      (await queued(t)).map((j) => j.appId),
      [ids[0]],
    );
    // Once that job is done the next app is due.
    await db.execute("UPDATE jobs SET status = 'done' WHERE queue = ?", [LISTING_READ_QUEUE]);
    await status(t, ids[0] as string, { read: START, attempt: START });
    const second = await queueListingReads(db, {
      now: START + MINUTE,
      intervalMs: INTERVAL,
      perTick: 10,
      perWorkspace: 10,
      jitter: noJitter,
    });
    assert.equal(second.queued, 1);
    assert.equal((await queued(t)).filter((j) => j.status === 'queued')[0]?.appId, ids[1]);
  },
);

dbTest(
  'an app is not queued again until an interval has passed since its last attempt, successful or not',
  async (db) => {
    const t = await bootListing(db);
    const [a, b, c] = await apps(t, 3);
    await status(t, a as string, { read: START - 10 * MINUTE, attempt: START - 10 * MINUTE });
    await status(t, b as string, { read: START - 3 * HOUR, attempt: START - 3 * HOUR });
    await status(t, c as string, { read: START - 3 * HOUR, attempt: START - 5 * MINUTE });
    const summary = await queueListingReads(db, {
      now: START,
      intervalMs: INTERVAL,
      perTick: 10,
      perWorkspace: 10,
      jitter: noJitter,
    });
    assert.equal(summary.queued, 1);
    assert.equal(
      summary.skipped.notDue,
      2,
      'one read ten minutes ago, one attempt five minutes ago',
    );
    assert.deepEqual(
      (await queued(t)).map((j) => j.appId),
      [b],
    );
  },
);

dbTest('backoff: after failures in a row an app waits twice as long for each', async (db) => {
  const t = await bootListing(db);
  const [a] = await apps(t, 1);
  await status(t, a as string, { read: START - 10 * DAY, attempt: START - 3 * HOUR, failures: 2 });
  const early = await queueListingReads(db, { now: START, intervalMs: INTERVAL, jitter: noJitter });
  assert.equal(early.queued, 0, 'two failures: four intervals, and three hours have passed');
  assert.equal(early.skipped.notDue, 1);
  const later = await queueListingReads(db, {
    now: START + HOUR + MINUTE,
    intervalMs: INTERVAL,
    jitter: noJitter,
  });
  assert.equal(later.queued, 1);
});

dbTest(
  'the store rate limiter is shared: no slot, no job; and a limited workspace is not asked again in the pass',
  async (db) => {
    const t = await bootListing(db);
    await apps(t, 3);
    let asked = 0;
    const blocked = await queueListingReads(db, {
      now: START,
      intervalMs: INTERVAL,
      perWorkspace: 10,
      jitter: noJitter,
      limiter: {
        take: () => {
          asked++;
          return 30;
        },
      },
    });
    assert.equal(blocked.queued, 0);
    assert.equal(blocked.skipped.rateLimited, 3);
    assert.equal(asked, 1, 'once per workspace and pass');

    const limiter = createTestLimiter({ limit: 1, now: () => START });
    const one = await queueListingReads(db, {
      now: START,
      intervalMs: INTERVAL,
      perWorkspace: 10,
      jitter: noJitter,
      limiter,
    });
    assert.equal(one.queued, 1, 'a slot for one read');
    assert.equal(one.skipped.rateLimited, 2);
  },
);

dbTest(
  'an app with a sync waiting or running is not queued for a read (the sync reads the listing too)',
  async (db) => {
    const t = await bootListing(db);
    const [a, b] = await apps(t, 2);
    await db.execute(
      "INSERT INTO jobs (id, queue, payload, status, run_at, attempts, created_at) VALUES ('sync-1', ?, ?, 'running', ?, 1, ?)",
      [APP_SYNC_QUEUE, JSON.stringify({ workspaceId: t.workspaceId, appId: a }), START, START],
    );
    const summary = await queueListingReads(db, {
      now: START,
      intervalMs: INTERVAL,
      perWorkspace: 10,
      jitter: noJitter,
    });
    assert.equal(summary.queued, 1);
    assert.equal(summary.skipped.alreadyQueued, 1);
    assert.deepEqual(
      (await queued(t)).map((j) => j.appId),
      [b],
    );
    // A job whose payload is not JSON belongs to nobody and breaks nothing.
    await db.execute(
      "INSERT INTO jobs (id, queue, payload, status, run_at, attempts, created_at) VALUES ('junk', ?, 'not json', 'queued', ?, 0, ?)",
      [LISTING_READ_QUEUE, START, START],
    );
    await queueListingReads(db, { now: START + MINUTE, intervalMs: INTERVAL, jitter: noJitter });
  },
);

dbTest(
  'the scheduler tick queues the reads, reports them, and never throws for them',
  async (db) => {
    const t = await bootListing(db);
    const ids = await apps(t, 2);
    const errors: string[] = [];
    const scheduler = createScheduler({
      db,
      now: () => START,
      listingIntervalMs: INTERVAL,
      listing: { perTick: 1, spacingMs: 1000 },
      jitter: noJitter,
      onError: (message) => errors.push(message),
    });
    const tick = await scheduler.tick();
    assert.equal(tick.listings?.queued, 1);
    assert.equal(tick.listings?.skipped.capped, 1);
    assert.deepEqual(
      (await queued(t)).map((j) => j.appId),
      [ids[0]],
    );
    assert.deepEqual(errors, []);

    // The listing status table goes away under it (a database problem): the tick still returns.
    await db.execute('ALTER TABLE app_listing_status RENAME TO app_listing_status_gone');
    const broken = await scheduler.tick();
    assert.equal(broken.listings, undefined);
    assert.deepEqual(errors, ['scheduled listing reads failed']);
  },
);

// ---------------------------------------------------------------------------------------------
// Running

function context(t: ListingBoot, at: number, intervalMs: number | null = INTERVAL) {
  return {
    db: t.db,
    masterKey: t.masterKey,
    now: () => at,
    connectorFactory: t.factory,
    timeoutMs: 5_000,
    ...(intervalMs === null ? {} : { intervalMs }),
  };
}

/** An iOS app that has an Apple id, as a synced one has. */
async function readyIos(t: ListingBoot) {
  const id = (await apps(t, 1))[0] as string;
  await t.db.execute('UPDATE apps SET store_app_id = ? WHERE id = ?', ['1234567890', id]);
  t.stores.ios.listing = iosListing({ 'en-US': EN_US }, iosSections());
  return id;
}

const payload = (
  t: ListingBoot,
  appId: string,
  credentialId: string,
  extra: Record<string, unknown> = {},
) => ({
  workspaceId: t.workspaceId,
  appId,
  credentialId,
  requestedBy: 'scheduler',
  ...extra,
});

const appCredential = async (t: ListingBoot, appId: string) =>
  String(
    (await t.db.query('SELECT credential_id FROM apps WHERE id = ?', [appId]))[0]?.credential_id,
  );

dbTest(
  'a scheduled read records the listing like a sync does, audited as the scheduler, and writes nothing to the store',
  async (db) => {
    const t = await bootListing(db);
    const id = await readyIos(t);
    const outcome = await runListingRead(
      context(t, START),
      payload(t, id, await appCredential(t, id)),
      { id: 'job-1' },
    );
    assert.equal(outcome.status, 'read');
    assert.deepEqual(t.stores.ios.calls, [`readListing:1234567890`], 'one read, no other call');
    assert.deepEqual(t.stores.ios.options, [{ extended: true }]);

    const live = (await t.live(id)).body;
    assert.equal(live.channels[0].locales['en-US'].name, 'Acme App');
    assert.equal(live.channels[0].sections.categories.primary, 'PRODUCTIVITY');
    assert.equal(live.readAt, START);
    assert.equal(live.schedule.lastAttemptAt, START);
    assert.equal(live.schedule.nextReadAt, START + INTERVAL);

    const uses = (await t.auditActions()).filter((a) => a.action === 'credential.use');
    assert.equal(uses.length, 1);
    assert.equal(uses[0]?.actorType, 'system');
    assert.equal(uses[0]?.actorId, LISTING_READ_QUEUE);
    assert.match(uses[0]?.detail ?? '', /app\.listing/);
    t.noLeaks();
  },
);

dbTest(
  'a read that is no longer due (somebody refreshed the app since the job was queued) is skipped',
  async (db) => {
    const t = await bootListing(db);
    const id = await readyIos(t);
    await status(t, id, { read: START - 5 * MINUTE, attempt: START - 5 * MINUTE });
    const outcome = await runListingRead(
      context(t, START),
      payload(t, id, await appCredential(t, id)),
      { id: 'job-1' },
    );
    assert.deepEqual(outcome, { status: 'skipped', reason: 'not_due' });
    assert.equal(t.stores.ios.calls.length, 0);
    // Without an interval (the handler of a server with the schedule off) the job simply runs.
    const run = await runListingRead(
      context(t, START - 4 * MINUTE, null),
      payload(t, id, await appCredential(t, id)),
      { id: 'job-2' },
    );
    assert.equal(run.status, 'skipped');
    assert.equal(
      (run as { reason: string }).reason,
      'claimed',
      'but a read attempted within two minutes is not started again',
    );
  },
);

dbTest('two instances claiming the same app: exactly one wins', async (db) => {
  const t = await bootListing(db);
  const id = await readyIos(t);
  const results = await Promise.all([
    claimListingRead(db, t.workspaceId, id, START),
    claimListingRead(db, t.workspaceId, id, START),
    claimListingRead(db, t.workspaceId, id, START + 1),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  // Later than the guard, the app can be claimed again.
  assert.equal(await claimListingRead(db, t.workspaceId, id, START + 3 * MINUTE), true);
  assert.equal(await claimListingRead(db, t.workspaceId, id, START + 3 * MINUTE + 1000), false);
});

dbTest('two jobs for one app (two instances queued it at once) read it once', async (db) => {
  const t = await bootListing(db);
  const id = await readyIos(t);
  const credentialId = await appCredential(t, id);
  const [a, b] = await Promise.all([
    runListingRead(context(t, START), payload(t, id, credentialId), { id: 'job-a' }),
    runListingRead(context(t, START), payload(t, id, credentialId), { id: 'job-b' }),
  ]);
  const reads = [a, b].filter((o) => o.status === 'read');
  assert.equal(reads.length, 1);
  assert.equal(t.stores.ios.calls.length, 1);
});

dbTest('the queue hands a job to one worker only', async (db) => {
  const t = await bootListing(db);
  await apps(t, 1);
  await queueListingReads(db, { now: START, intervalMs: INTERVAL, jitter: noJitter });
  const claims = await Promise.all([claimNext(db, START + MINUTE), claimNext(db, START + MINUTE)]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(claims.find(Boolean)?.queue, LISTING_READ_QUEUE);
});

dbTest(
  'a failed read is recorded on the app, counted, and never thrown; the next success resets the count',
  async (db) => {
    const t = await bootListing(db);
    const id = await readyIos(t);
    const credentialId = await appCredential(t, id);
    t.stores.ios.error = new StoreError(
      'appstoreconnect',
      'auth',
      'App Store Connect refused the key.',
      401,
    );
    const failed = await runListingRead(context(t, START), payload(t, id, credentialId), {
      id: 'j1',
    });
    assert.equal(failed.status, 'failed');
    let live = (await t.live(id)).body;
    assert.match(live.error, /refused the key/);
    assert.equal(live.schedule.failures, 1);
    assert.equal(live.schedule.nextReadAt, START + 2 * INTERVAL);

    const again = await runListingRead(context(t, START + 3 * HOUR), payload(t, id, credentialId), {
      id: 'j2',
    });
    assert.equal(again.status, 'failed');
    live = (await t.live(id)).body;
    assert.equal(live.schedule.failures, 2);
    assert.equal(live.schedule.nextReadAt, START + 3 * HOUR + 4 * INTERVAL);

    // Plain exceptions (a bug in a connector) do not escape either.
    t.stores.ios.error = new Error('boom');
    const crashed = await runListingRead(
      context(t, START + 10 * HOUR),
      payload(t, id, credentialId),
      { id: 'j3' },
    );
    assert.equal(crashed.status, 'failed');

    t.stores.ios.error = undefined;
    const ok = await runListingRead(context(t, START + 2 * DAY), payload(t, id, credentialId), {
      id: 'j4',
    });
    assert.equal(ok.status, 'read');
    live = (await t.live(id)).body;
    assert.equal(live.schedule.failures, 0);
    assert.equal(live.error, null);
    t.noLeaks();
  },
);

dbTest(
  'a read of an app that is being read in this process is skipped, not doubled',
  async (db) => {
    const t = await bootListing(db);
    const id = await readyIos(t);
    const credentialId = await appCredential(t, id);
    let release: () => void = () => undefined;
    t.stores.ios.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = runListingRead(context(t, START), payload(t, id, credentialId), { id: 'slow' });
    await new Promise((r) => setTimeout(r, 20));
    const second = await runListingRead(
      context(t, START + 10 * MINUTE),
      payload(t, id, credentialId),
      { id: 'fast' },
    );
    assert.deepEqual(second, { status: 'skipped', reason: 'running' });
    release();
    assert.equal((await first).status, 'read');
    forgetRunningListingReads();
  },
);

dbTest(
  'a job whose credential is used by another running listing job puts itself back, a bounded number of times',
  async (db) => {
    const t = await bootListing(db);
    const id = await readyIos(t);
    const credentialId = await appCredential(t, id);
    await db.execute(
      "INSERT INTO jobs (id, queue, payload, status, run_at, attempts, created_at) VALUES ('other', ?, ?, 'running', ?, 1, ?)",
      [
        LISTING_READ_QUEUE,
        JSON.stringify(payload(t, 'some-other-app', credentialId)),
        START,
        START,
      ],
    );
    const outcome = await runListingRead(context(t, START), payload(t, id, credentialId), {
      id: 'mine',
    });
    assert.deepEqual(outcome, { status: 'skipped', reason: 'deferred' });
    assert.equal(t.stores.ios.calls.length, 0);
    const waiting = (await queued(t)).filter((j) => j.status === 'queued');
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0]?.appId, id);
    assert.equal(waiting[0]?.runAt, START + 30_000);
    assert.equal((waiting[0] as unknown as { deferrals: number }).deferrals, 1);

    // After ten deferrals it goes ahead: a job whose neighbour never ends must not wait forever.
    const gone = await runListingRead(
      context(t, START + HOUR),
      payload(t, id, credentialId, { deferrals: 10 }),
      { id: 'mine2' },
    );
    assert.equal(gone.status, 'read');
  },
);

dbTest(
  'an unknown app, a payload nobody knows and a handler for a server with the schedule off',
  async (db) => {
    const t = await bootListing(db);
    const id = await readyIos(t);
    const unknown = await runListingRead(context(t, START), payload(t, 'no-such-app', 'c'), {
      id: 'x',
    });
    assert.deepEqual(unknown, { status: 'skipped', reason: 'no_app' });
    // An app of another workspace is "no app" too.
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
    const foreign = await runListingRead(
      context(t, START),
      { ...payload(t, id, 'c'), workspaceId: 'other' },
      { id: 'y' },
    );
    assert.deepEqual(foreign, { status: 'skipped', reason: 'no_app' });

    const handler = createListingReadHandler(context(t, START, null));
    await handler(null, { id: 'z', queue: LISTING_READ_QUEUE, payload: null, attempts: 1 });
    await handler({ appId: 5 }, { id: 'z', queue: LISTING_READ_QUEUE, payload: null, attempts: 1 });
    assert.equal(t.stores.ios.calls.length, 0);
    const real = payload(t, id, await appCredential(t, id));
    await handler(real, { id: 'z', queue: LISTING_READ_QUEUE, payload: real, attempts: 1 });
    assert.equal(t.stores.ios.calls.length, 1);
  },
);

dbTest(
  'a Google Play app is read by its package name, and the read records the Play sections',
  async (db) => {
    const t = await bootListing(db);
    const res = await t.call(t.owner, 'POST', '/apps', {
      platform: 'android',
      identifier: 'com.acme.play',
      credentialId: t.playCredential,
    });
    const id = res.body.app.id as string;
    t.stores.android.listing = playListing(
      { 'en-US': { title: 'Acme Play' } },
      {
        details: { defaultLanguage: 'en-US' },
        media: { screenshots: { 'en-US': [{ type: 'phoneScreenshots', count: 4 }] } },
      },
    );
    const outcome = await runListingRead(context(t, START), payload(t, id, t.playCredential), {
      id: 'p1',
    });
    assert.equal(outcome.status, 'read');
    assert.deepEqual(t.stores.android.calls, ['readListing:com.acme.play']);
    const live = (await t.live(id)).body;
    assert.equal(live.channels[0].sections.media.screenshots['en-US'][0].count, 4);
  },
);
