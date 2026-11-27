import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Database } from '@kiln/db';
import { dbTest } from '@kiln/db/testing';
import { loadConfig } from '../../config.ts';
import {
  createScheduler,
  DEFAULT_RELEASE_WATCH_INTERVAL_MINUTES,
  releaseWatchIntervalMs,
} from '../../scheduler.ts';
import { auditActions, boot, registerOwner } from '../../testkit.ts';
import { RELEASE_WATCH_ACTOR, sendReleaseWatch } from './release-watch.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** 2027-01-10 12:00 UTC. */
const NOW = Date.UTC(2027, 0, 10, 12, 0, 0);

// biome-ignore lint/suspicious/noExplicitAny: responses are inspected loosely
type Json = Record<string, any>;

async function setup(db: Database) {
  const t = await boot(db);
  t.clock.now = NOW;
  const owner = await registerOwner(t.app);
  const call = async (method: string, path: string, body?: unknown, cookie = owner.cookie) => {
    const res = await t.app.request(`/api/workspaces/${owner.workspaceId}${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as Json };
  };
  const addApp = async (platform: 'ios' | 'android' = 'ios', name = 'Acme') => {
    const id = crypto.randomUUID();
    await db.execute(
      `INSERT INTO apps (id, workspace_id, name, platform, identifier, credential_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'cred', 0)`,
      [id, owner.workspaceId, name, platform, `com.acme.${id.slice(0, 6)}`],
    );
    return id;
  };
  /** A version in `status` since `since`, and (iOS) its processed build uploaded `uploaded` ms ago. */
  const version = async (
    appId: string,
    v: string,
    status: string,
    since: number,
    platform = 'ios',
  ) =>
    db.execute(
      `INSERT INTO app_releases (id, app_id, workspace_id, platform, version, track, build, status, raw_state, details_json, synced_at, status_since)
       VALUES (?, ?, ?, ?, ?, '', '240', ?, 'RAW', '{}', ?, ?)`,
      [crypto.randomUUID(), appId, owner.workspaceId, platform, v, status, since, since],
    );
  const build = (appId: string, n: string, uploadedAt: number) =>
    db.execute(
      `INSERT INTO app_builds (app_id, platform, build_number, workspace_id, store_id, version, processing_state, raw_state, expired, uploaded_at, first_seen_at, last_seen_at)
       VALUES (?, 'ios', ?, ?, ?, '2.4.0', 'processed', 'VALID', 0, ?, ?, ?)`,
      [appId, n, owner.workspaceId, `b-${n}`, uploadedAt, uploadedAt, uploadedAt],
    );
  const review = (
    appId: string,
    rating: number,
    createdAt: number,
    extra: { response?: boolean; status?: string } = {},
  ) =>
    db.execute(
      `INSERT INTO app_reviews (id, workspace_id, app_id, store, store_review_id, rating, title, body, created_at, updated_at, first_seen_at, fetched_at, developer_response, status)
       VALUES (?, ?, ?, 'appstoreconnect', ?, ?, 'SECRET-TITLE', 'SECRET-BODY', ?, ?, 1, 1, ?, ?)`,
      [
        crypto.randomUUID(),
        owner.workspaceId,
        appId,
        crypto.randomUUID(),
        rating,
        createdAt,
        createdAt,
        extra.response ? '{"body":"x"}' : null,
        extra.status ?? 'new',
      ],
    );
  const events = async (type: string) =>
    (await call('GET', `/events?since=0&type=${type}&limit=200`)).body.events as Json[];
  const setting = (values: Json) => call('PUT', '/settings', values);
  return { ...t, owner, call, addApp, version, build, review, events, setting };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const run = (t: Setup, at: number, options = {}) =>
  sendReleaseWatch(t.db, at, { onError: () => {}, ...options });
/** An app whose draft version waited 10 hours at NOW with its build. */
const stalledApp = async (t: Setup, name = 'Acme') => {
  const app = await t.addApp('ios', name);
  await t.version(app, '2.4.0', 'draft', NOW - 10 * HOUR);
  await t.build(app, '240', NOW - 12 * HOUR);
  return app;
};

dbTest(
  'a stalled release sends one release.stalled, only ids and times, and a second run sends nothing',
  async (db) => {
    const t = await setup(db);
    const app = await stalledApp(t);
    const first = await run(t, NOW);
    assert.equal(first.stalled, 1);
    assert.equal(first.capped, false);
    assert.equal((await run(t, NOW + 5 * 60_000)).stalled, 0);
    assert.equal((await run(t, NOW + 20 * HOUR)).stalledRepeats, 0, 'default repeat is 24 hours');

    const events = await t.events('release.stalled');
    assert.equal(events.length, 1);
    const e = events[0] as Json;
    assert.deepEqual(e.subject, { appId: app });
    assert.equal(e.payload.appId, app);
    assert.equal(e.payload.platform, 'ios');
    assert.equal(e.payload.step, 'draft');
    assert.equal(e.payload.episode, 'draft:2.4.0');
    assert.equal(e.payload.version, '2.4.0');
    assert.equal(e.payload.buildNumber, '240');
    assert.equal(e.payload.runId, null);
    assert.equal(e.payload.repeat, false);
    assert.equal(e.payload.sentCount, 1);
    assert.deepEqual(e.payload.actor, RELEASE_WATCH_ACTOR);
    assert.equal(e.createdAt, NOW);
    assert.equal(e.payload.hours, 10);
    assert.equal(e.payload.since, NOW - 10 * HOUR);

    const audit = (await auditActions(db, t.owner.workspaceId)).filter(
      (a) => a.action === 'release.reminder',
    );
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.actorId, 'release.watch');
    assert.ok(!JSON.stringify(audit).includes('SECRET'));
  },
);

dbTest(
  'the same stall repeats only after release.stalledRepeatHours, and 0 means never',
  async (db) => {
    const t = await setup(db);
    await stalledApp(t);
    assert.equal((await t.setting({ 'release.stalledRepeatHours': 12 })).status, 200);
    assert.equal((await run(t, NOW)).stalled, 1);
    assert.equal((await run(t, NOW + 11 * HOUR)).stalledRepeats, 0);
    const again = await run(t, NOW + 12 * HOUR);
    assert.equal(again.stalledRepeats, 1);
    assert.equal(again.stalled, 0, 'a repeat is not a new episode');
    assert.equal((await run(t, NOW + 13 * HOUR)).stalledRepeats, 0);
    const events = await t.events('release.stalled');
    assert.deepEqual(
      events.map((x) => [x.payload.repeat, x.payload.sentCount]),
      [
        [false, 1],
        [true, 2],
      ],
    );

    assert.equal((await t.setting({ 'release.stalledRepeatHours': 0 })).status, 200);
    assert.equal((await run(t, NOW + 5 * DAY)).stalledRepeats, 0);
    assert.equal((await t.events('release.stalled')).length, 2);
  },
);

dbTest(
  'a cleared stall is forgotten, so the next one is a new episode; a different step is a new episode too',
  async (db) => {
    const t = await setup(db);
    const app = await stalledApp(t);
    assert.equal((await run(t, NOW)).stalled, 1);
    const rows = async () =>
      (await db.query('SELECT episode_key, sent_count FROM release_stall_reminders')).map((r) => [
        String(r.episode_key),
        Number(r.sent_count),
      ]);
    assert.deepEqual(await rows(), [['draft:2.4.0', 1]]);

    // The version moves on (submitted for review, nothing waits for a person): the row goes.
    await db.execute(
      "UPDATE app_releases SET status = 'in_review', status_since = ? WHERE app_id = ?",
      [NOW + HOUR, app],
    );
    const cleared = await run(t, NOW + 2 * HOUR);
    assert.equal(cleared.cleared, 1);
    assert.deepEqual(await rows(), []);

    // Rejected and left for ten hours: a new episode, a new reminder.
    await db.execute(
      "UPDATE app_releases SET status = 'rejected', status_since = ? WHERE app_id = ?",
      [NOW + 3 * HOUR, app],
    );
    const next = await run(t, NOW + 14 * HOUR);
    assert.equal(next.stalled, 1);
    assert.deepEqual(await rows(), [['rejected:2.4.0', 1]]);
    assert.equal((await t.events('release.stalled')).length, 2);

    // An app that is deleted loses its row.
    await db.execute('DELETE FROM app_releases WHERE app_id = ?', [app]);
    await db.execute('DELETE FROM app_builds WHERE app_id = ?', [app]);
    await db.execute('DELETE FROM apps WHERE id = ?', [app]);
    assert.equal((await run(t, NOW + 15 * HOUR)).cleared, 1);
    assert.deepEqual(await rows(), []);
  },
);

dbTest(
  'release.stalledAfterHours 0 is off, a longer threshold waits, a stale stall is never reminded',
  async (db) => {
    const t = await setup(db);
    const app = await stalledApp(t);
    assert.equal((await t.setting({ 'release.stalledAfterHours': 0 })).status, 200);
    assert.equal((await run(t, NOW)).stalled, 0);
    assert.equal((await t.setting({ 'release.stalledAfterHours': 24 })).status, 200);
    assert.equal((await run(t, NOW)).stalled, 0);
    assert.equal(
      (await run(t, NOW + 15 * HOUR)).stalled,
      1,
      'the version has waited 25 hours by now',
    );

    // Waiting for more than 14 days: shown by the pipeline, not reminded.
    await db.execute('DELETE FROM release_stall_reminders');
    await db.execute('UPDATE app_releases SET status_since = ? WHERE app_id = ?', [
      NOW - 30 * DAY,
      app,
    ]);
    await db.execute('UPDATE app_builds SET uploaded_at = ? WHERE app_id = ?', [
      NOW - 30 * DAY,
      app,
    ]);
    assert.equal((await run(t, NOW + 16 * HOUR)).stalled, 0);
  },
);

dbTest('two runs at the same time send one reminder', async (db) => {
  const t = await setup(db);
  await stalledApp(t);
  const [a, b] = await Promise.all([run(t, NOW), run(t, NOW)]);
  assert.equal(a.stalled + b.stalled, 1);
  assert.equal((await t.events('release.stalled')).length, 1);
});

dbTest('maxPerRun caps the reminders; the rest wait for the next run', async (db) => {
  const t = await setup(db);
  await stalledApp(t, 'One');
  await stalledApp(t, 'Two');
  const first = await run(t, NOW, { maxPerRun: 1 });
  assert.equal(first.stalled, 1);
  assert.equal(first.capped, true);
  const second = await run(t, NOW + 60_000, { maxPerRun: 1 });
  assert.equal(second.stalled, 1);
  assert.equal(second.capped, false);
  assert.equal((await t.events('release.stalled')).length, 2);
});

dbTest(
  'review.unanswered: off by default, one digest per interval, counts and times only',
  async (db) => {
    const t = await setup(db);
    const a = await t.addApp('ios', 'Alpha');
    const b = await t.addApp('android', 'Beta');
    await t.review(a, 1, NOW - 30 * HOUR);
    await t.review(a, 2, NOW - 2 * HOUR); // too fresh
    await t.review(a, 5, NOW - 40 * HOUR); // above the rating limit below
    await t.review(a, 1, NOW - 50 * HOUR, { response: true });
    await t.review(a, 1, NOW - 50 * HOUR, { status: 'ignored' });
    await t.review(b, 3, NOW - 26 * HOUR);

    assert.equal(
      (await run(t, NOW)).unansweredDigests,
      0,
      'off: reviews.unansweredReminderHours is 0',
    );
    assert.equal(
      (await t.setting({ 'reviews.unansweredReminderHours': 24, 'reviews.unansweredMaxRating': 3 }))
        .status,
      200,
    );
    assert.equal((await run(t, NOW)).unansweredDigests, 1);
    assert.equal(
      (await run(t, NOW + 12 * HOUR)).unansweredDigests,
      0,
      'not again within the interval',
    );

    const events = await t.events('review.unanswered');
    assert.equal(events.length, 1);
    const p = (events[0] as Json).payload;
    assert.equal(p.count, 2);
    assert.equal(p.appsTotal, 2);
    assert.equal(p.oldestAt, NOW - 30 * HOUR);
    assert.equal(p.maxRating, 3);
    assert.equal(p.waitingHours, 24);
    assert.deepEqual(
      p.apps.map((x: Json) => [x.appId, x.count, x.oldestAt]),
      [
        [a, 1, NOW - 30 * HOUR],
        [b, 1, NOW - 26 * HOUR],
      ],
    );
    assert.equal((events[0] as Json).subject.appId, undefined);
    const text =
      JSON.stringify(events) + JSON.stringify(await auditActions(db, t.owner.workspaceId));
    assert.ok(!text.includes('SECRET'), 'no review text and no title');

    // After the interval, still waiting: the next digest.
    assert.equal((await run(t, NOW + 25 * HOUR)).unansweredDigests, 1);
    // Answered: nothing to say.
    await db.execute('UPDATE app_reviews SET developer_response = \'{"body":"x"}\'');
    assert.equal((await run(t, NOW + 60 * HOUR)).unansweredDigests, 0);
  },
);

dbTest(
  'a token limited to some apps never sees the review digest, which names every app',
  async (db) => {
    const t = await setup(db);
    const a = await t.addApp('ios', 'Alpha');
    await t.review(a, 1, NOW - 30 * HOUR);
    await t.setting({ 'reviews.unansweredReminderHours': 24 });
    await run(t, NOW);
    const made = await t.call('POST', '/tokens', { name: 'Scoped', role: 'viewer', appIds: [a] });
    const res = await t.app.request(
      `/api/workspaces/${t.owner.workspaceId}/events?since=0&type=review.unanswered`,
      { headers: { authorization: `Bearer ${made.body.token}` } },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as Json).events, []);
  },
);

dbTest(
  'the scheduler runs the release watch on its own interval, and a failure does not stop the tick',
  async (db) => {
    const t = await setup(db);
    await stalledApp(t);
    let at = NOW;
    const reported: string[] = [];
    const scheduler = createScheduler({
      db,
      now: () => at,
      releaseWatchIntervalMs: 15 * 60_000,
      onError: (m) => reported.push(m),
    });
    const first = await scheduler.tick();
    assert.equal(first.releaseWatch?.stalled, 1);
    at += 60_000;
    assert.equal((await scheduler.tick()).releaseWatch, undefined, 'not due yet');
    at += 15 * 60_000;
    assert.equal((await scheduler.tick()).releaseWatch?.stalled, 0);

    const off = createScheduler({ db, now: () => at });
    assert.equal((await off.tick()).releaseWatch, undefined);

    await db.execute('DROP TABLE release_stall_reminders');
    const broken = createScheduler({
      db,
      now: () => at,
      releaseWatchIntervalMs: 15 * 60_000,
      onError: (m) => reported.push(m),
    });
    const summary = await broken.tick();
    assert.equal(summary.releaseWatch?.failed, 1, 'the failure is counted, not thrown');
    assert.equal(typeof summary.syncsQueued, 'number', 'the rest of the tick still ran');
    assert.ok(reported.length > 0);
  },
);

test('releaseWatchIntervalMs: off, or whole minutes between 5 and a week', () => {
  assert.equal(releaseWatchIntervalMs(0), 0);
  assert.equal(releaseWatchIntervalMs(5), 5 * 60_000);
  assert.equal(releaseWatchIntervalMs(DEFAULT_RELEASE_WATCH_INTERVAL_MINUTES), 15 * 60_000);
  assert.equal(releaseWatchIntervalMs(10_080), 7 * DAY);
  for (const bad of [1, 4, 10_081, 7.5, -5, Number.NaN])
    assert.throws(() => releaseWatchIntervalMs(bad), /release watch interval/, String(bad));
});

test('KILN_RELEASE_WATCH_INTERVAL_MINUTES defaults to 15, 0 is off, and the range is checked', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  assert.equal(loadConfig({ KILN_MASTER_KEY: key }).releaseWatchIntervalMinutes, 15);
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_RELEASE_WATCH_INTERVAL_MINUTES: '' })
      .releaseWatchIntervalMinutes,
    15,
  );
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_RELEASE_WATCH_INTERVAL_MINUTES: '0' })
      .releaseWatchIntervalMinutes,
    0,
  );
  assert.equal(
    loadConfig({ KILN_MASTER_KEY: key, KILN_RELEASE_WATCH_INTERVAL_MINUTES: '10080' })
      .releaseWatchIntervalMinutes,
    10_080,
  );
  for (const bad of ['1', '4', '10081', '-1', '2.5', 'soon']) {
    assert.throws(
      () => loadConfig({ KILN_MASTER_KEY: key, KILN_RELEASE_WATCH_INTERVAL_MINUTES: bad }),
      /KILN_RELEASE_WATCH_INTERVAL_MINUTES/,
      bad,
    );
  }
});

dbTest(
  'a draft that is left behind by what is live (1.11.6 under a rolling out 1.19.0) sends no release.stalled; the newer draft does',
  async (db) => {
    const t = await setup(db);
    const app = await t.addApp('ios', 'Acme');
    await t.version(app, '1.19.0', 'rolling_out', NOW - 200 * HOUR);
    await t.version(app, '1.11.6', 'draft', NOW - 10 * HOUR);
    await t.build(app, '240', NOW - 12 * HOUR);
    const first = await run(t, NOW);
    assert.equal(first.stalled, 0, 'nothing is stalled: the only draft is obsolete');
    assert.equal((await t.events('release.stalled')).length, 0);

    await t.version(app, '2.0.0', 'draft', NOW - 10 * HOUR);
    const next = await run(t, NOW + 60_000);
    assert.equal(next.stalled, 1);
    const events = await t.events('release.stalled');
    assert.equal(events[0]?.payload.version, '2.0.0');
  },
);
