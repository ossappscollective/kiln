import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Database } from '@mrm/db';
import { dbTest } from '@mrm/db/testing';
import { loadConfig } from './config.ts';
import { DEFAULT_REMINDER_INTERVAL_MINUTES, createScheduler, reminderIntervalMs } from './scheduler.ts';
import { REMINDER_ACTOR, sendPlanReminders } from './services/plan-reminders.ts';
import { addMember, auditActions, boot, registerOwner, seedWorkspace } from './testkit.ts';

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
  const appId = crypto.randomUUID();
  await db.execute(
    `INSERT INTO apps (id, workspace_id, name, platform, identifier, credential_id, created_at)
     VALUES (?, ?, 'Acme', 'android', 'com.acme.app', 'cred', 0)`,
    [appId, owner.workspaceId],
  );
  const plan = async (version: string, targetDate?: string) =>
    ((await call('POST', `/apps/${appId}/plans`, { version, ...(targetDate ? { targetDate } : {}) })).body.plan as Json).id as string;
  const events = async (type?: string) =>
    (await call('GET', `/events?since=0${type ? `&type=${type}` : ''}&limit=200`)).body.events as Json[];
  const rollout = async (planId: string, steps: Json[]) =>
    (await call('PUT', `/apps/${appId}/plans/${planId}/rollout`, { kind: 'steps', steps })).body.rollout as Json;
  return { ...t, owner, call, appId, plan, events, rollout };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const run = (t: Setup, at: number, options = {}) => sendPlanReminders(t.db, at, { onError: () => {}, ...options });
const counts = (s: Awaited<ReturnType<typeof sendPlanReminders>>) => [s.dueSoon, s.overdue, s.stepsDue];

// ---------------------------------------------------------------------------------------------
// Deadlines

dbTest('a deadline within 24 hours sends one plan.deadline_due_soon, and a second run sends nothing', async (db) => {
  const t = await setup(db);
  const planId = await t.plan('2.0.0', '2027-01-11'); // the day ends 36 hours from NOW
  assert.deepEqual(counts(await run(t, NOW)), [0, 0, 0], 'not yet: more than 24 hours before the end of the day');

  const at = Date.UTC(2027, 0, 11, 0, 0, 0); // 24 hours before the end of 2027-01-11
  const first = await run(t, at);
  assert.deepEqual(counts(first), [1, 0, 0]);
  assert.equal(first.capped, false);
  assert.deepEqual(counts(await run(t, at + 5 * 60_000)), [0, 0, 0]);
  assert.deepEqual(counts(await run(t, at + 6 * HOUR)), [0, 0, 0]);

  const events = await t.events('plan.deadline_due_soon');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]?.subject, { appId: t.appId });
  assert.equal(events[0]?.payload.planId, planId);
  assert.equal(events[0]?.payload.version, '2.0.0');
  assert.equal(events[0]?.payload.targetDate, '2027-01-11');
  assert.equal(events[0]?.payload.hoursLeft, 24);
  assert.equal(events[0]?.payload.appName, 'Acme');
  assert.equal(events[0]?.payload.openRequiredItems, 0);
  assert.deepEqual(events[0]?.payload.actor, REMINDER_ACTOR);
  assert.equal(events[0]?.createdAt, at);

  // The audit actor follows the background sync's convention: the system, named after the job.
  const audit = (await auditActions(db, t.owner.workspaceId)).filter((a) => a.action === 'plan.reminder');
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.actorId, 'plan.reminders');
  assert.equal(audit[0]?.targetId, planId);
  assert.equal(audit[0]?.detail?.kind, 'due_soon');
  const row = (await db.query('SELECT actor_type FROM audit_events WHERE action = ?', ['plan.reminder']))[0];
  assert.equal(row?.actor_type, 'system');
});

dbTest('the lead time is configurable and the overdue reminder follows when the day is over', async (db) => {
  const t = await setup(db);
  await t.plan('2.0.0', '2027-01-11');
  assert.deepEqual(counts(await run(t, NOW, { leadHours: 48 })), [1, 0, 0], '48 hours of lead time catches it now');
  // Overdue is a different kind: it is sent once the target day is over, next to the earlier one.
  assert.deepEqual(counts(await run(t, Date.UTC(2027, 0, 12, 0, 0, 0) - 1, { leadHours: 48 })), [0, 0, 0]);
  const late = Date.UTC(2027, 0, 12, 3, 0, 0);
  assert.deepEqual(counts(await run(t, late)), [0, 1, 0]);
  assert.deepEqual(counts(await run(t, late + DAY)), [0, 0, 0]);
  const overdue = (await t.events('plan.deadline_overdue'))[0] as Json;
  assert.equal(overdue.payload.daysOverdue, 1);
  assert.equal(overdue.payload.targetDate, '2027-01-11');
  assert.equal((await t.events()).length, 2);
});

dbTest('a plan that is already overdue gets only the overdue reminder, and a stale one none', async (db) => {
  const t = await setup(db);
  await t.plan('1.0.0', '2027-01-08');
  await t.plan('0.9.0', '2026-10-01'); // more than 30 days past
  assert.deepEqual(counts(await run(t, NOW)), [0, 1, 0]);
  assert.deepEqual((await t.events()).map((e) => [e.type, e.payload.version]), [['plan.deadline_overdue', '1.0.0']]);
});

dbTest('a changed date re-arms the reminder, and a date that comes back is armed again too', async (db) => {
  const t = await setup(db);
  const planId = await t.plan('2.0.0', '2027-01-10');
  assert.deepEqual(counts(await run(t, NOW)), [1, 0, 0]);
  assert.deepEqual(counts(await run(t, NOW + HOUR)), [0, 0, 0]);

  // Pushed out two days: not due soon yet. Then close again: a new date is a new reminder.
  await t.call('PATCH', `/apps/${t.appId}/plans/${planId}`, { targetDate: '2027-01-12' });
  assert.deepEqual(counts(await run(t, NOW)), [0, 0, 0]);
  assert.deepEqual(counts(await run(t, Date.UTC(2027, 0, 12, 6, 0, 0))), [1, 0, 0]);
  // Back to the first date (now in the past): that one is armed again, as overdue.
  await t.call('PATCH', `/apps/${t.appId}/plans/${planId}`, { targetDate: '2027-01-10' });
  assert.deepEqual(counts(await run(t, Date.UTC(2027, 0, 12, 7, 0, 0))), [0, 1, 0]);
  assert.deepEqual((await t.events()).map((e) => e.type), [
    'plan.deadline_due_soon',
    'plan.deadline_due_soon',
    'plan.deadline_overdue',
  ]);
});

dbTest('a plan whose release is live, a plan without a date and a deleted plan send nothing', async (db) => {
  const t = await setup(db);
  const live = await t.plan('3.0.0', '2027-01-08');
  await t.plan('3.1.0');
  const gone = await t.plan('3.2.0', '2027-01-09');
  await db.execute(
    `INSERT INTO app_releases (id, app_id, workspace_id, platform, version, track, status, raw_state, synced_at)
     VALUES ('r1', ?, ?, 'android', '3.0.0', 'production', 'live', 'completed', 1)`,
    [t.appId, t.owner.workspaceId],
  );
  await t.call('DELETE', `/apps/${t.appId}/plans/${gone}`);
  assert.deepEqual(counts(await run(t, NOW)), [0, 0, 0]);
  assert.equal((await t.events()).length, 0);
  void live;
});

dbTest('open required checklist items are counted in the reminder', async (db) => {
  const t = await setup(db);
  const planId = await t.plan('2.0.0', '2027-01-10');
  await t.call('POST', `/apps/${t.appId}/plans/${planId}/items`, { text: 'Screenshots', required: true });
  await t.call('POST', `/apps/${t.appId}/plans/${planId}/items`, { text: 'Optional', required: false });
  await run(t, NOW);
  assert.equal((await t.events())[0]?.payload.openRequiredItems, 1);
});

// ---------------------------------------------------------------------------------------------
// Rollout steps

dbTest('a rollout step whose planned time has passed sends plan.rollout_step_due once; changing the time re-arms it', async (db) => {
  const t = await setup(db);
  const planId = await t.plan('2.0.0');
  const plannedAt = NOW + 2 * HOUR;
  const made = await t.rollout(planId, [{ percent: 5, plannedAt }, { percent: 20, plannedAt: plannedAt + DAY }, { percent: 100 }]);
  assert.deepEqual(counts(await run(t, plannedAt - 1)), [0, 0, 0]);
  assert.deepEqual(counts(await run(t, plannedAt)), [0, 0, 1]);
  assert.deepEqual(counts(await run(t, plannedAt + HOUR)), [0, 0, 0]);
  const events = await t.events('plan.rollout_step_due');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]?.payload.stepId, made.steps[0].id);
  assert.equal(events[0]?.payload.percent, 5);
  assert.equal(events[0]?.payload.index, 1);
  assert.equal(events[0]?.payload.total, 3);
  assert.equal(events[0]?.payload.plannedAt, plannedAt);
  assert.equal(events[0]?.payload.minutesLate, 0);

  // Moving the planned time is a new key: due again once the new time has passed.
  const moved = plannedAt + 3 * DAY;
  await t.rollout(planId, [{ id: made.steps[0].id, percent: 5, plannedAt: moved }, { id: made.steps[1].id, percent: 20, plannedAt: moved + DAY }, { id: made.steps[2].id, percent: 100 }]);
  assert.deepEqual(counts(await run(t, moved + 60_000)), [0, 0, 1]);
  assert.equal((await t.events('plan.rollout_step_due')).length, 2);

  // Done and skipped steps are not due; neither is a step of a released plan.
  await t.call('POST', `/apps/${t.appId}/plans/${planId}/rollout/steps/${made.steps[0].id}/complete`, {});
  await t.call('POST', `/apps/${t.appId}/plans/${planId}/rollout/steps/${made.steps[1].id}/skip`);
  assert.deepEqual(counts(await run(t, moved + 10 * DAY)), [0, 0, 0]);
  const audit = (await auditActions(db, t.owner.workspaceId)).filter((a) => a.action === 'plan.reminder');
  assert.equal(audit.length, 2);
  assert.equal(audit[0]?.detail?.kind, 'rollout_step_due');
});

dbTest('rollout steps of a released plan, or long past due, send nothing', async (db) => {
  const t = await setup(db);
  const a = await t.plan('2.0.0');
  const b = await t.plan('2.1.0');
  await t.rollout(a, [{ percent: 50, plannedAt: NOW + HOUR }, { percent: 100 }]);
  await t.rollout(b, [{ percent: 50, plannedAt: NOW + HOUR }, { percent: 100 }]);
  await db.execute(
    `INSERT INTO app_releases (id, app_id, workspace_id, platform, version, track, status, raw_state, synced_at)
     VALUES ('r1', ?, ?, 'android', '2.0.0', 'production', 'live', 'completed', 1)`,
    [t.appId, t.owner.workspaceId],
  );
  assert.deepEqual(counts(await run(t, NOW + 40 * DAY)), [0, 0, 0], 'stale: more than 30 days past');
  assert.deepEqual(counts(await run(t, NOW + 2 * HOUR)), [0, 0, 1]);
  assert.equal((await t.events('plan.rollout_step_due'))[0]?.payload.planId, b);
});

// ---------------------------------------------------------------------------------------------
// Idempotence, bounds, several instances

dbTest('two runs at once (two server instances) send each reminder exactly once', async (db) => {
  const t = await setup(db);
  for (let i = 0; i < 4; i++) await t.plan(`2.${i}.0`, '2027-01-10');
  const results = await Promise.all([run(t, NOW), run(t, NOW), run(t, NOW)]);
  assert.equal(results.reduce((n, r) => n + r.dueSoon, 0), 4);
  assert.equal(results.reduce((n, r) => n + r.failed, 0), 0);
  assert.equal((await t.events('plan.deadline_due_soon')).length, 4);
  assert.equal((await db.query('SELECT plan_id FROM plan_reminders')).length, 4);
});

dbTest('a run sends at most maxPerRun reminders; the next run continues, nothing is sent twice', async (db) => {
  const t = await setup(db);
  for (let i = 0; i < 5; i++) await t.plan(`2.${i}.0`, '2027-01-10');
  const first = await run(t, NOW, { maxPerRun: 2 });
  assert.deepEqual(counts(first), [2, 0, 0]);
  assert.equal(first.capped, true);
  const second = await run(t, NOW, { maxPerRun: 2 });
  assert.equal(second.dueSoon, 2);
  assert.equal(second.capped, true);
  const third = await run(t, NOW, { maxPerRun: 2 });
  assert.equal(third.dueSoon, 1);
  assert.equal(third.capped, false);
  const sent = (await t.events('plan.deadline_due_soon')).map((e) => e.payload.version);
  assert.equal(sent.length, 5);
  assert.equal(new Set(sent).size, 5);
});

dbTest('already sent reminders do not use up the limit, so a new one is never starved', async (db) => {
  const t = await setup(db);
  for (let i = 0; i < 3; i++) await t.plan(`1.${i}.0`, '2027-01-10');
  await run(t, NOW);
  await t.plan('9.9.0', '2027-01-10');
  const next = await run(t, NOW, { maxPerRun: 1 });
  assert.deepEqual(counts(next), [1, 0, 0]);
  assert.equal(next.capped, false);
});

dbTest('reminders are isolated per workspace and reach every role that can read plans', async (db) => {
  const t = await setup(db);
  await t.plan('2.0.0', '2027-01-10');
  const viewer = await addMember(t.app, t.owner, 'viewer@example.com', 'viewer');
  await run(t, NOW);
  const mine = await t.call('GET', '/events?since=0', undefined, viewer.cookie);
  assert.equal(mine.body.events.length, 1);
  assert.equal(mine.body.events[0].type, 'plan.deadline_due_soon');
  // A token-less outsider cannot read this workspace's events at all.
  const outsider = await seedWorkspace(db, 'Other', 'someone@example.com', NOW);
  const res = await t.app.request(`/api/workspaces/${t.owner.workspaceId}/events?since=0`, { headers: { cookie: outsider.cookie } });
  assert.equal(res.status, 404);
  const theirs = await t.app.request(`/api/workspaces/${outsider.workspaceId}/events?since=0`, { headers: { cookie: outsider.cookie } });
  assert.deepEqual(((await theirs.json()) as Json).events, []);
});

// ---------------------------------------------------------------------------------------------
// The scheduler and its configuration

dbTest('the scheduler runs reminders on their own interval, and not at all when off', async (db) => {
  const t = await setup(db);
  await t.plan('2.0.0', '2027-01-10');
  let now = NOW;
  const off = createScheduler({ db, now: () => now });
  assert.equal((await off.tick()).reminders, null);
  assert.equal((await t.events()).length, 0);

  const scheduler = createScheduler({ db, now: () => now, reminderIntervalMs: 15 * 60_000 });
  const first = await scheduler.tick();
  assert.deepEqual(first.reminders && counts(first.reminders), [1, 0, 0]);
  now += 60_000;
  assert.equal((await scheduler.tick()).reminders, null, 'not due again until the interval has passed');
  now += 15 * 60_000;
  const later = await scheduler.tick();
  assert.deepEqual(later.reminders && counts(later.reminders), [0, 0, 0]);
  assert.equal((await t.events()).length, 1, 'a second tick, and a second scheduler, never re-emit');
  const restarted = createScheduler({ db, now: () => now, reminderIntervalMs: 15 * 60_000 });
  const again = (await restarted.tick()).reminders;
  assert.deepEqual(again && counts(again), [0, 0, 0], 'a restarted process runs at once and finds everything already sent');
  assert.equal((await t.events()).length, 1);
});

dbTest('a failing reminder run is reported and never throws out of the tick', async (db) => {
  const t = await setup(db);
  await t.plan('2.0.0', '2027-01-10');
  await db.execute('DROP TABLE plan_reminders');
  const reported: string[] = [];
  const scheduler = createScheduler({ db, now: () => NOW, reminderIntervalMs: 15 * 60_000, onError: (message) => reported.push(message) });
  const summary = await scheduler.tick();
  assert.equal(summary.reminders, null);
  assert.deepEqual(reported, ['plan reminders failed']);
  assert.equal(typeof summary.syncsQueued, 'number', 'the rest of the tick still ran');
});

test('reminderIntervalMs: off, or whole minutes between 5 and a week', () => {
  assert.equal(reminderIntervalMs(0), 0);
  assert.equal(reminderIntervalMs(5), 5 * 60_000);
  assert.equal(reminderIntervalMs(DEFAULT_REMINDER_INTERVAL_MINUTES), 15 * 60_000);
  assert.equal(reminderIntervalMs(10_080), 7 * DAY);
  for (const bad of [1, 4, 10_081, 7.5, -5, Number.NaN]) assert.throws(() => reminderIntervalMs(bad), /reminder interval/, String(bad));
});

test('MRM_REMINDER_INTERVAL_MINUTES defaults to 15, 0 or blank is off-or-default, and the range is checked', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  assert.equal(loadConfig({ MRM_MASTER_KEY: key }).reminderIntervalMinutes, 15);
  assert.equal(loadConfig({ MRM_MASTER_KEY: key, MRM_REMINDER_INTERVAL_MINUTES: '' }).reminderIntervalMinutes, 15);
  assert.equal(loadConfig({ MRM_MASTER_KEY: key, MRM_REMINDER_INTERVAL_MINUTES: '0' }).reminderIntervalMinutes, 0);
  assert.equal(loadConfig({ MRM_MASTER_KEY: key, MRM_REMINDER_INTERVAL_MINUTES: '5' }).reminderIntervalMinutes, 5);
  assert.equal(loadConfig({ MRM_MASTER_KEY: key, MRM_REMINDER_INTERVAL_MINUTES: '10080' }).reminderIntervalMinutes, 10_080);
  for (const bad of ['1', '4', '10081', '-1', '2.5', 'soon']) {
    assert.throws(() => loadConfig({ MRM_MASTER_KEY: key, MRM_REMINDER_INTERVAL_MINUTES: bad }), /MRM_REMINDER_INTERVAL_MINUTES/, bad);
  }
});
