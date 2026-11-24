import assert from 'node:assert/strict';
import { AsoError } from '@kiln/connectors';
import { latestReviewSlot, nextReviewSlot, type ReviewSchedule } from '@kiln/core';
import { dbTest } from '@kiln/db/testing';
import { createTestLimiter } from '../../services/credential-tests.ts';
import { seedWorkspace } from '../../testkit.ts';
import {
  COMPETITOR_REVIEWS_QUEUE,
  createCompetitorReviewsHandler,
  queueCompetitorReviewReads,
  runCompetitorReviewReads,
} from './competitor-review-schedule.ts';
import { type AsoBoot, bootAso, publicApp } from './test-helpers.ts';

/**
 * Scheduled reads of competitor reviews (docs/adr/0065): due and not due, skip when nothing is new, the guards, jitter, backoff and the
 * failure alert event, pause, Play refused, rights and the workspace boundary. The clock and Apple's feed are fakes: nothing leaves the process.
 */

const DAY = 86_400_000;
const MINUTE = 60_000;
const feed = (id: string, daysAgo: number, now: number) => ({ id, rating: 3, title: `t${id}`, body: `b${id}`, version: '1.0', at: now - daysAgo * DAY });

async function follow(t: AsoBoot, appId: string, id: string, name = `Rival ${id}`): Promise<string> {
  t.sources.setApp('ios', 'us', publicApp(id, { name }));
  const res = await t.call(t.owner, 'POST', `/apps/${appId}/aso/competitors`, { externalId: `id${id}` });
  assert.equal(res.status, 201, res.text);
  return res.body.competitor.id as string;
}
const put = (t: AsoBoot, appId: string, body: Record<string, unknown>, cookie = t.owner) => t.call(cookie, 'PUT', `/apps/${appId}/aso/competitor-review-schedule`, body);
const view = async (t: AsoBoot, appId: string) => (await t.call(t.owner, 'GET', `/apps/${appId}/aso/competitor-review-schedule`)).body;
const queue = (t: AsoBoot, over: Record<string, unknown> = {}) => queueCompetitorReviewReads(t.db, { now: t.clock.now(), jitter: () => 0, ...over });
const run = (t: AsoBoot, appId: string) => runCompetitorReviewReads({ db: t.db, now: t.clock.now, sources: t.sources }, { workspaceId: t.workspaceId, appId });
const jobs = async (t: AsoBoot) => t.db.query('SELECT payload, run_at FROM jobs WHERE queue = ?', [COMPETITOR_REVIEWS_QUEUE]);
/** Moves the fake clock just after the next planned run of a competitor. */
async function toNextSlot(t: AsoBoot, schedule: ReviewSchedule, key: string) {
  const next = nextReviewSlot(schedule, key, t.clock.now()) as number;
  t.clock.advance(next - t.clock.now() + 1000);
}
const DAILY: ReviewSchedule = { mode: 'daily', weekday: null, timezone: null };

dbTest('off by default: nothing is queued, the view says so, and a new schedule waits for its next run', async (db) => {
  const t = await bootAso(db);
  const appId = await t.addApp('ios');
  const cid = await follow(t, appId, '555');
  const v = await view(t, appId);
  assert.deepEqual(v.schedule, { mode: 'off', weekday: null, timezone: null });
  assert.equal(v.nextRunAt, null);
  assert.equal(v.canEdit, true);
  assert.match(v.notice, /Apple only/);
  assert.equal((await queue(t)).queued, 0);
  assert.equal((await put(t, appId, { mode: 'daily' })).status, 200);
  assert.equal((await queue(t)).queued, 0, 'turned on just now: waits for the next planned time, no immediate read');
  const after = await view(t, appId);
  assert.ok(after.competitors[0].nextRunAt > t.clock.now());
  assert.equal(after.competitors[0].competitorId, cid);
});

dbTest('due and not due: queued once after the planned time, not before, not twice, and not again until the next day', async (db) => {
  const t = await bootAso(db);
  const appId = await t.addApp('ios');
  const cid = await follow(t, appId, '555');
  t.sources.feeds.set('us|555', [feed('a', 1, t.clock.now())]);
  await put(t, appId, { mode: 'daily' });
  const slot = nextReviewSlot(DAILY, cid, t.clock.now()) as number;
  t.clock.advance(slot - t.clock.now() - MINUTE);
  assert.equal((await queue(t)).queued, 0, 'a minute before the planned time');
  t.clock.advance(2 * MINUTE);
  const first = await queue(t);
  assert.equal(first.queued, 1);
  assert.equal((await queue(t)).skipped.alreadyQueued, 1, 'one job per app while it is queued');
  const [job] = await jobs(t);
  const handler = createCompetitorReviewsHandler({ db, now: t.clock.now, sources: t.sources });
  await handler(JSON.parse(String(job?.payload)), {} as never);
  assert.equal(t.sources.reviewReads.length, 1);
  await db.execute("UPDATE jobs SET status = 'done' WHERE queue = ?", [COMPETITOR_REVIEWS_QUEUE]);
  assert.equal((await queue(t)).queued, 0, 'read today: not due again');
  await toNextSlot(t, DAILY, cid);
  assert.equal((await queue(t)).queued, 1, 'due again the next day');
});

dbTest('weekly: only on its weekday, in the time zone of the app', async (db) => {
  const t = await bootAso(db);
  const appId = await t.addApp('ios');
  const cid = await follow(t, appId, '555');
  assert.equal((await put(t, appId, { mode: 'weekly' })).status, 400, 'weekly needs a weekday');
  assert.equal((await put(t, appId, { mode: 'daily', timezone: 'Mars/Base' })).status, 400);
  assert.equal((await put(t, appId, { mode: 'weekly', weekday: 1, timezone: 'Asia/Tokyo' })).status, 200);
  const schedule: ReviewSchedule = { mode: 'weekly', weekday: 1, timezone: 'Asia/Tokyo' };
  const next = (await view(t, appId)).competitors[0].nextRunAt as number;
  assert.equal(next, nextReviewSlot(schedule, cid, t.clock.now()));
  assert.equal(new Date(next).toLocaleString('en-US', { timeZone: 'Asia/Tokyo', weekday: 'short' }), 'Mon');
  t.clock.advance(next - t.clock.now() + 1000);
  assert.equal((await queue(t)).queued, 1);
});

dbTest('nothing new since the last read: the feed is fetched but nothing is stored or audited; a new review is counted', async (db) => {
  const t = await bootAso(db);
  const appId = await t.addApp('ios');
  const cid = await follow(t, appId, '555');
  await put(t, appId, { mode: 'daily' });
  t.sources.feeds.set('us|555', [feed('a', 1, t.clock.now()), feed('b', 2, t.clock.now())]);
  await toNextSlot(t, DAILY, cid);
  assert.deepEqual(await run(t, appId), { read: 1, unchanged: 0, failed: 0, newReviews: 2, skipped: 0 });
  let v = await view(t, appId);
  assert.equal(v.competitors[0].newCount, 2);
  assert.ok(v.competitors[0].lastReadAt > 0);
  const audits = async () => Number((await db.query("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'aso.competitor_reviews_read'"))[0]?.n);
  assert.equal(await audits(), 1);
  await toNextSlot(t, DAILY, cid);
  assert.deepEqual(await run(t, appId), { read: 0, unchanged: 1, failed: 0, newReviews: 0, skipped: 0 });
  assert.equal(await audits(), 1, 'an unchanged read writes no audit entry');
  assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM aso_competitor_reviews'))[0]?.n), 2);
  v = await view(t, appId);
  assert.equal(v.competitors[0].newCount, 0);
  t.sources.feeds.set('us|555', [feed('new', 0, t.clock.now()), feed('a', 1, t.clock.now())]);
  await toNextSlot(t, DAILY, cid);
  assert.equal((await run(t, appId)).newReviews, 1);
  assert.equal((await view(t, appId)).competitors[0].newCount, 1);
});

dbTest('volume guard: only the newest N reviews of the feed are looked at; the number of competitors per run is capped', async (db) => {
  const t = await bootAso(db);
  const appId = await t.addApp('ios');
  const ids = [await follow(t, appId, '1'), await follow(t, appId, '2'), await follow(t, appId, '3')];
  const now = t.clock.now();
  t.sources.feeds.set('us|1', Array.from({ length: 30 }, (_, i) => feed(`r${i}`, i % 60, now)));
  assert.equal((await put(t, appId, { mode: 'daily', maxReviews: 5, maxCompetitors: 2 })).status, 200);
  assert.equal((await put(t, appId, { maxReviews: 51 })).status, 400);
  assert.equal((await put(t, appId, { maxCompetitors: 11 })).status, 400);
  for (const id of ids) await toNextSlot(t, DAILY, id);
  t.clock.advance(4 * 60 * MINUTE);
  const out = await run(t, appId);
  assert.equal(out.read + out.unchanged, 2, 'two competitors this run');
  assert.equal(out.skipped, 1);
  assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM aso_competitor_reviews WHERE competitor_id = ?', [ids[0] ?? '']))[0]?.n), 5, 'the newest five only');
  assert.equal((await queue(t)).queued, 1, 'the third competitor is still due');
  const out2 = await run(t, appId);
  assert.equal(out2.read + out2.unchanged, 1);
});

dbTest('jitter: every job and every planned time stays inside its bounds, and competitors do not meet at one minute', async (db) => {
  const t = await bootAso(db);
  const apps: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const appId = await t.addApp('ios', `App ${i}`);
    apps.push(appId);
    await follow(t, appId, String(100 + i));
    await put(t, appId, { mode: 'daily' });
  }
  t.clock.advance(30 * 60 * 60_000);
  const startedAt = t.clock.now();
  const summary = await queueCompetitorReviewReads(t.db, { now: startedAt, perTick: 10, perWorkspace: 10, spacingMs: 20_000, maxJitterMs: 120_000, jitter: (_k, max) => max + 99_999 });
  assert.equal(summary.queued, 4);
  const runAts = (await jobs(t)).map((j) => Number(j.run_at)).sort((a, b) => a - b);
  for (const [i, at] of runAts.entries()) assert.ok(at >= startedAt + i * 20_000 && at <= startedAt + i * 20_000 + 120_000, 'spacing plus at most the jitter');
  const times = new Set<number>();
  for (const row of await db.query('SELECT id FROM aso_competitors')) times.add(latestReviewSlot(DAILY, String(row.id), startedAt) as number);
  assert.equal(times.size, 4, 'four competitors, four different planned minutes');
});

dbTest('failure: coded reason, backoff, no retry before it ends, an alert event once per streak, and a good read clears it', async (db) => {
  const t = await bootAso(db);
  const appId = await t.addApp('ios');
  const cid = await follow(t, appId, '555');
  await put(t, appId, { mode: 'daily' });
  t.sources.reviewsError = new AsoError('apple_search', 'timeout', 'Too slow.');
  await toNextSlot(t, DAILY, cid);
  assert.equal((await run(t, appId)).failed, 1);
  let c = (await view(t, appId)).competitors[0];
  assert.equal(c.failures, 1);
  assert.equal(c.lastError, 'timeout');
  assert.ok(c.backoffUntil > t.clock.now());
  assert.equal(c.nextRunAt, c.backoffUntil, 'the next run is when the backoff ends');
  assert.equal((await queue(t)).queued, 0, 'not before the backoff ends');
  assert.equal((await t.events('review.sync_failed')).length, 0, 'one failure is not news');
  t.clock.advance(15 * MINUTE + 1000);
  assert.equal((await queue(t)).queued, 1, 'retried within the same day when the backoff ends');
  await db.execute("UPDATE jobs SET status = 'done' WHERE queue = ?", [COMPETITOR_REVIEWS_QUEUE]);
  assert.equal((await run(t, appId)).failed, 1);
  c = (await view(t, appId)).competitors[0];
  assert.equal(c.failures, 2);
  assert.ok(c.backoffUntil - t.clock.now() > 15 * MINUTE, 'doubled');
  const events = await t.events('review.sync_failed');
  assert.equal(events.length, 1, 'raised at the second failure in a row');
  assert.equal(events[0]?.payload.source, 'competitor');
  assert.equal(events[0]?.payload.code, 'timeout');
  assert.ok(!JSON.stringify(events[0]).includes('Rival'), 'no name in an event');
  t.clock.advance(31 * MINUTE);
  await run(t, appId);
  assert.equal((await t.events('review.sync_failed')).length, 1, 'not again in the same streak');
  t.sources.reviewsError = undefined;
  t.sources.feeds.set('us|555', [feed('a', 1, t.clock.now())]);
  t.clock.advance(61 * MINUTE);
  assert.equal((await run(t, appId)).read, 1);
  c = (await view(t, appId)).competitors[0];
  assert.deepEqual([c.failures, c.lastError, c.backoffUntil], [0, null, null]);
});

dbTest('our own rate limit is not a failure: the read waits and nothing is counted', async (db) => {
  const t = await bootAso(db);
  const appId = await t.addApp('ios');
  const cid = await follow(t, appId, '555');
  await put(t, appId, { mode: 'daily' });
  t.sources.reviewsError = new AsoError('apple_search', 'rate_limited', 'Slow down.', { retryAfterSeconds: 120 });
  await toNextSlot(t, DAILY, cid);
  await run(t, appId);
  const c = (await view(t, appId)).competitors[0];
  assert.equal(c.failures, 0);
  assert.equal(c.lastError, 'rate_limited');
  assert.ok(c.backoffUntil >= t.clock.now() + 15 * MINUTE - 5000);
});

dbTest('pause and resume: nothing is queued while paused, the schedule is kept', async (db) => {
  const t = await bootAso(db);
  const appId = await t.addApp('ios');
  const cid = await follow(t, appId, '555');
  await put(t, appId, { mode: 'daily' });
  await toNextSlot(t, DAILY, cid);
  assert.equal((await put(t, appId, { paused: true })).status, 200);
  const v = await view(t, appId);
  assert.equal(v.paused, true);
  assert.equal(v.schedule.mode, 'daily');
  assert.equal(v.nextRunAt, null);
  assert.equal((await queue(t)).queued, 0);
  assert.equal((await run(t, appId)).read, 0, 'a job that was already queued reads nothing either');
  assert.equal((await put(t, appId, { paused: false })).status, 200);
  await toNextSlot(t, DAILY, cid);
  assert.equal((await queue(t)).queued, 1);
});

dbTest('per competitor: an override can turn one off or give it its own weekday; a Play competitor is refused', async (db) => {
  const t = await bootAso(db, { playEnabled: true });
  const appId = await t.addApp('ios');
  const a = await follow(t, appId, '111');
  const b = await follow(t, appId, '222');
  await put(t, appId, { mode: 'daily' });
  const route = (cid: string, body: Record<string, unknown>) => t.call(t.owner, 'PUT', `/apps/${appId}/aso/competitors/${cid}/review-schedule`, body);
  assert.equal((await route(a, { mode: 'off' })).status, 200);
  assert.equal((await route(b, { mode: 'weekly' })).status, 400, 'weekly needs a weekday');
  const set = await route(b, { mode: 'weekly', weekday: 5 });
  assert.equal(set.status, 200, set.text);
  const v = set.body;
  const byId = (id: string) => v.competitors.find((c: { competitorId: string }) => c.competitorId === id);
  assert.equal(byId(a).effective.mode, 'off');
  assert.equal(byId(a).nextRunAt, null);
  assert.deepEqual([byId(b).effective.mode, byId(b).effective.weekday], ['weekly', 5]);
  assert.equal((await route(b, { mode: null })).body.competitors.find((c: { competitorId: string }) => c.competitorId === b).override, null, 'null follows the app again');
  const droid = await t.addApp('android', 'Droid');
  t.sources.setApp('android', 'us', publicApp('com.rival.app', { name: 'Rival Play' }));
  const play = await t.call(t.owner, 'POST', `/apps/${droid}/aso/competitors`, { externalId: 'com.rival.app' });
  assert.equal(play.status, 201, play.text);
  await put(t, droid, { mode: 'daily' });
  const refused = await t.call(t.owner, 'PUT', `/apps/${droid}/aso/competitors/${play.body.competitor.id}/review-schedule`, { mode: 'daily' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'play_reviews_not_available');
  assert.equal(refused.body.code, 'aso.playReviewsNotAvailable');
  const playState = (await view(t, droid)).competitors[0];
  assert.equal(playState.supported, false);
  assert.equal(playState.nextRunAt, null);
  t.clock.advance(3 * DAY);
  await queue(t);
  assert.ok(!(await jobs(t)).some((j) => String(j.payload).includes(droid)), 'a Play competitor is never queued');
  assert.equal((await run(t, droid)).read, 0);
  assert.equal(t.sources.reviewReads.length, 0, 'Play is never read');
});

dbTest('reading is independent of the AI switch for competitor reviews', async (db) => {
  const t = await bootAso(db);
  const appId = await t.addApp('ios');
  const cid = await follow(t, appId, '555');
  await db.execute("INSERT INTO ai_app_review_policy (app_id, workspace_id, own_reviews, competitor_reviews, detail, redact, updated_by, updated_at) VALUES (?, ?, 'off', 'off', 'text', 1, 'u', 1)", [appId, t.workspaceId]);
  t.sources.feeds.set('us|555', [feed('a', 1, t.clock.now())]);
  await put(t, appId, { mode: 'daily' });
  await toNextSlot(t, DAILY, cid);
  assert.equal((await run(t, appId)).read, 1);
});

dbTest('the shared per workspace limiter holds the queue back; a competitor of another app is not read by this app', async (db) => {
  const t = await bootAso(db);
  const appId = await t.addApp('ios');
  const other = await t.addApp('ios', 'Other');
  const cid = await follow(t, appId, '555');
  await follow(t, other, '777');
  await put(t, appId, { mode: 'daily' });
  await toNextSlot(t, DAILY, cid);
  const limiter = createTestLimiter({ limit: 0, now: t.clock.now });
  const held = await queue(t, { limiter });
  assert.equal(held.queued, 0);
  assert.equal(held.skipped.rateLimited, 1);
  assert.equal((await queue(t)).queued, 1);
  await run(t, appId);
  assert.deepEqual(t.sources.reviewReads.map((r) => r.id), ['555'], 'the other app has no schedule and is not read');
});

dbTest('rights, audit with from to, and the workspace boundary', async (db) => {
  const t = await bootAso(db);
  const appId = await t.addApp('ios');
  const cid = await follow(t, appId, '555');
  const viewer = await t.addMember('viewer');
  assert.equal((await t.call(viewer, 'GET', `/apps/${appId}/aso/competitor-review-schedule`)).status, 200);
  assert.equal((await t.call(viewer, 'GET', `/apps/${appId}/aso/competitor-review-schedule`)).body.canEdit, false);
  assert.equal((await put(t, appId, { mode: 'daily' }, viewer)).status, 403);
  assert.equal((await t.call(viewer, 'PUT', `/apps/${appId}/aso/competitors/${cid}/review-schedule`, { mode: 'off' })).status, 403);
  assert.equal((await put(t, appId, { mode: 'daily', timezone: 'Europe/Paris' })).status, 200);
  assert.equal((await put(t, appId, { mode: 'daily', timezone: 'Europe/Paris' })).status, 200, 'no change, no second entry');
  const rows = await db.query("SELECT detail FROM audit_events WHERE action = 'aso.competitor_review_schedule_update'");
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(String(rows[0]?.detail)).changes, [
    { field: 'mode', from: 'off', to: 'daily' },
    { field: 'timezone', from: null, to: 'Europe/Paris' },
  ]);
  assert.equal((await put(t, appId, { mode: 'hourly' })).status, 400);
  assert.equal((await put(t, appId, { surprise: 1 })).status, 400);

  const other = await seedWorkspace(db, 'Other', 'other@example.com', t.clock.now());
  const call = (workspaceId: string, method: string, path: string, body?: unknown) =>
    t.app.request(`/api/workspaces/${workspaceId}${path}`, {
      method,
      headers: { cookie: other.cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  for (const [method, path, body] of [
    ['GET', `/apps/${appId}/aso/competitor-review-schedule`],
    ['PUT', `/apps/${appId}/aso/competitor-review-schedule`, { mode: 'off' }],
    ['PUT', `/apps/${appId}/aso/competitors/${cid}/review-schedule`, { mode: 'off' }],
  ] as [string, string, unknown?][]) {
    assert.equal((await call(t.workspaceId, method, path, body)).status, 404, `not a member: ${method} ${path}`);
    assert.equal((await call(other.workspaceId, method, path, body)).status, 404, `not their app: ${method} ${path}`);
  }
  assert.equal((await view(t, appId)).schedule.mode, 'daily', 'nothing of ours was touched');
});
