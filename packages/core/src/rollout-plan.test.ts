import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  APPLE_PHASED_SCHEDULE,
  MAX_ROLLOUT_STEPS,
  REMINDER_STALE_DAYS,
  ROLLOUT_TEMPLATES,
  type RolloutStepState,
  checkRolloutAction,
  compareRollout,
  deadlineReminder,
  formatPercent,
  rolloutStepReminderDue,
  rolloutTemplate,
  rolloutTemplatesFor,
  storeRollout,
  summarizeRollout,
  validateRolloutSteps,
} from './rollout-plan.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CREATED = Date.UTC(2027, 0, 1);
const step = (id: string, percent: number, status: RolloutStepState['status'] = 'planned', plannedAt: number | null = null): RolloutStepState => ({
  id,
  percent,
  plannedAt,
  note: null,
  status,
  doneAt: status === 'done' ? CREATED + HOUR : null,
});
const messages = (r: ReturnType<typeof validateRolloutSteps>) => (r.ok ? [] : r.issues.map((i) => i.message));

test('templates: Play ramp, Apple phased (informational) and immediate, by platform', () => {
  assert.deepEqual(rolloutTemplate('builtin:play-default')?.steps.map((s) => s.percent), [1, 5, 20, 50, 100]);
  assert.deepEqual(rolloutTemplate('builtin:immediate')?.steps.map((s) => s.percent), [100]);
  const apple = rolloutTemplate('builtin:apple-phased');
  assert.equal(apple?.kind, 'apple_phased');
  assert.deepEqual(apple?.steps, [], 'no editable percentages');
  assert.deepEqual(APPLE_PHASED_SCHEDULE.map((s) => [s.day, s.percent]), [[1, 1], [2, 2], [3, 5], [4, 10], [5, 20], [6, 50], [7, 100]]);
  assert.deepEqual(rolloutTemplatesFor('android').map((t) => t.id), ['builtin:play-default', 'builtin:immediate']);
  assert.deepEqual(rolloutTemplatesFor('ios').map((t) => t.id), ['builtin:apple-phased', 'builtin:immediate']);
  assert.equal(rolloutTemplate('builtin:nope'), undefined);
  // Every template that has steps is valid by its own rules.
  for (const t of ROLLOUT_TEMPLATES.filter((x) => x.kind === 'steps')) {
    assert.deepEqual(validateRolloutSteps(t.steps, { planCreatedAt: CREATED }), { ok: true }, t.id);
  }
});

test('validation: count, range, strictly increasing, dates, notes, ids', () => {
  const ok = (steps: Parameters<typeof validateRolloutSteps>[0], existing: RolloutStepState[] = []) =>
    validateRolloutSteps(steps, { planCreatedAt: CREATED, existing });
  assert.deepEqual(ok([{ percent: 1 }, { percent: 100 }]), { ok: true });
  assert.match(messages(ok([])).join(), /at least one/);
  const many = Array.from({ length: MAX_ROLLOUT_STEPS + 1 }, (_, i) => ({ percent: i + 1 }));
  assert.match(messages(ok(many)).join(), /12 steps at most/);
  assert.deepEqual(ok(many.slice(0, MAX_ROLLOUT_STEPS)), { ok: true });
  for (const percent of [0, -1, 101, 2.5, Number.NaN]) assert.equal(ok([{ percent }]).ok, false, String(percent));
  assert.match(messages(ok([{ percent: 20 }, { percent: 20 }])).join(), /higher than the one before \(20%\)/);
  assert.match(messages(ok([{ percent: 20 }, { percent: 10 }])).join(), /higher than the one before/);
  // Dates: not before the plan was created, not backwards, and a real date.
  assert.match(messages(ok([{ percent: 10, plannedAt: CREATED - 1 }])).join(), /after the plan was created/);
  assert.equal(ok([{ percent: 10, plannedAt: CREATED }]).ok, true);
  assert.match(messages(ok([{ percent: 10, plannedAt: CREATED + 2 * DAY }, { percent: 20, plannedAt: CREATED + DAY }])).join(), /before the step above/);
  assert.equal(ok([{ percent: 10, plannedAt: CREATED + DAY }, { percent: 20 }, { percent: 30, plannedAt: CREATED + DAY }]).ok, true);
  assert.match(messages(ok([{ percent: 10, plannedAt: 1.5 }])).join(), /date and time/);
  // A step that is done keeps its date even when it is before the plan's creation.
  const done = step('a', 10, 'done', CREATED - DAY);
  assert.equal(ok([{ id: 'a', percent: 10, plannedAt: CREATED - DAY }, { percent: 50 }], [done]).ok, true);
  // Notes: one line, 200 characters.
  assert.match(messages(ok([{ percent: 10, note: 'a\nb' }])).join(), /One line/);
  assert.match(messages(ok([{ percent: 10, note: 'x'.repeat(201) }])).join(), /One line/);
  assert.equal(ok([{ percent: 10, note: 'x'.repeat(200) }]).ok, true);
  // Ids: known, and not twice.
  assert.match(messages(ok([{ id: 'zzz', percent: 10 }])).join(), /does not exist/);
  assert.match(messages(ok([{ id: 'a', percent: 10 }, { id: 'a', percent: 20 }], [step('a', 10)])).join(), /listed twice/);
});

test('validation: a done step keeps its percent and stays, and nothing open comes before it', () => {
  const existing = [step('a', 5, 'done'), step('b', 20), step('c', 100)];
  const check = (steps: Parameters<typeof validateRolloutSteps>[0]) => validateRolloutSteps(steps, { planCreatedAt: CREATED, existing });
  assert.deepEqual(check([{ id: 'a', percent: 5 }, { id: 'b', percent: 25 }]), { ok: true });
  assert.match(messages(check([{ id: 'a', percent: 6 }, { id: 'b', percent: 20 }])).join(), /keeps its percentage/);
  assert.match(messages(check([{ id: 'b', percent: 20 }])).join(), /cannot be removed/);
  assert.match(messages(check([{ percent: 2 }, { id: 'a', percent: 5 }])).join(), /before a completed step/);
  // A skipped step before a done step is fine.
  const withSkipped = [step('s', 2, 'skipped'), step('a', 5, 'done')];
  assert.deepEqual(validateRolloutSteps([{ id: 's', percent: 2 }, { id: 'a', percent: 5 }], { planCreatedAt: CREATED, existing: withSkipped }), { ok: true });
});

test('moving a step: order, skipping, reopening, and asking for the state it is already in', () => {
  const steps = [step('a', 5, 'done'), step('b', 20), step('c', 50), step('d', 100)];
  const ok = (id: string, action: Parameters<typeof checkRolloutAction>[2]) => checkRolloutAction(steps, id, action);
  assert.deepEqual(ok('b', 'complete'), { ok: true, noop: false, to: 'done' });
  assert.deepEqual(ok('a', 'complete'), { ok: true, noop: true, to: 'done' });
  assert.equal((ok('c', 'complete') as { code: string }).code, 'earlier_steps_open');
  assert.deepEqual(ok('c', 'skip'), { ok: true, noop: false, to: 'skipped' });
  assert.equal((ok('a', 'skip') as { code: string }).code, 'invalid_transition');
  assert.equal((ok('a', 'reopen') as { ok: boolean }).ok, true);
  assert.deepEqual(ok('b', 'reopen'), { ok: true, noop: true, to: 'planned' });
  const later = [step('a', 5, 'done'), step('b', 20, 'skipped'), step('c', 50, 'done')];
  assert.equal((checkRolloutAction(later, 'a', 'reopen') as { code: string }).code, 'later_steps_done');
  assert.equal((checkRolloutAction(later, 'b', 'reopen') as { code: string }).code, 'later_steps_done');
  assert.equal((checkRolloutAction(later, 'zzz', 'complete') as { code: string }).code, 'step_not_found');
});

test('summary: how far the plan is, the next step and the steps whose time has passed', () => {
  const now = CREATED + 10 * DAY;
  const steps = [step('a', 5, 'done', now - 3 * DAY), step('b', 20, 'skipped'), step('c', 50, 'planned', now - HOUR), step('d', 100, 'planned', now + DAY)];
  assert.deepEqual(summarizeRollout('steps', steps, now), {
    kind: 'steps',
    total: 4,
    done: 1,
    skipped: 1,
    planned: 2,
    planPercent: 5,
    current: { index: 1, percent: 5 },
    next: { id: 'c', index: 3, percent: 50, plannedAt: now - HOUR },
    dueSteps: 1,
    nextPlannedAt: now - HOUR,
  });
  const none = summarizeRollout('steps', [step('a', 10)], now);
  assert.equal(none.planPercent, 0);
  assert.equal(none.current, null);
  assert.equal(summarizeRollout('apple_phased', [], now).total, 0);
});

test('the store share: Play reports one, a live Play release is 100% by inference, Apple has none', () => {
  const play = { platform: 'android' as const, rawState: 'inProgress', syncedAt: 1 };
  assert.deepEqual(storeRollout({ ...play, status: 'rolling_out', fraction: 0.2 }), { ...play, status: 'rolling_out', fraction: 0.2, percent: 20, inferred: false });
  assert.equal(storeRollout({ ...play, status: 'rolling_out', fraction: 0.205 }).percent, 20.5);
  assert.equal(storeRollout({ ...play, status: 'rolling_out', fraction: null }).percent, null);
  assert.deepEqual(
    (({ percent, inferred }) => ({ percent, inferred }))(storeRollout({ ...play, status: 'live', fraction: null })),
    { percent: 100, inferred: true },
  );
  for (const fraction of [0, 1.5, Number.NaN, -1]) assert.equal(storeRollout({ ...play, status: 'rolling_out', fraction }).percent, null, String(fraction));
  const apple = { platform: 'ios' as const, rawState: 'READY_FOR_DISTRIBUTION', syncedAt: 1, fraction: null };
  assert.equal(storeRollout({ ...apple, status: 'live' }).percent, null, 'a phased release is not read: never inferred');
  assert.equal(storeRollout({ ...apple, status: 'rolling_out' }).percent, null);
});

test('plan against store: agree, store ahead (confirmable), store behind, unknown', () => {
  const steps = [step('a', 5, 'done'), step('b', 20, 'done'), step('c', 50), step('d', 100)];
  const store = (percent: number | null, extra: Partial<Parameters<typeof storeRollout>[0]> = {}) =>
    storeRollout({ platform: 'android', status: 'rolling_out', rawState: 'inProgress', fraction: percent === null ? null : percent / 100, syncedAt: 1, ...extra });

  const match = compareRollout(steps, store(20));
  assert.equal(match.verdict, 'match');
  assert.equal(match.mismatch, false);
  assert.deepEqual(match.planStep, { index: 2, total: 4, percent: 20 });
  assert.equal(match.confirmStepId, null, 'the store has not reached the next step');
  assert.match(match.message, /Store says 20%, the plan has step 2 of 4 \(20%\) done: they agree/);

  const ahead = compareRollout(steps, store(50));
  assert.equal(ahead.verdict, 'store_ahead');
  assert.equal(ahead.mismatch, true);
  assert.equal(ahead.confirmStepId, 'c');
  assert.match(ahead.message, /ahead of the plan/);
  assert.match(ahead.message, /confirm the next step/);

  const behind = compareRollout(steps, store(5));
  assert.equal(behind.verdict, 'store_behind');
  assert.equal(behind.mismatch, true);
  assert.equal(behind.confirmStepId, null);
  assert.match(behind.message, /behind the plan/);

  // Nothing done yet and the store has started: ahead, and the first step is confirmable once reached.
  const fresh = [step('a', 5), step('b', 20)];
  assert.equal(compareRollout(fresh, store(5)).confirmStepId, 'a');
  assert.equal(compareRollout(fresh, store(1)).confirmStepId, null);
  assert.match(compareRollout(fresh, store(1)).message, /no step done yet/);

  // Unknown is not a mismatch.
  for (const unknown of [store(null), null]) {
    const c = compareRollout(steps, unknown);
    assert.equal(c.verdict, 'unknown');
    assert.equal(c.mismatch, false);
    assert.equal(c.confirmStepId, null);
  }
  const ios = compareRollout(steps, storeRollout({ platform: 'ios', status: 'live', rawState: 'x', fraction: null, syncedAt: 1 }));
  assert.match(ios.message, /Apple phased release is not read/);
  assert.match(compareRollout(steps, store(20, { status: 'halted' })).message, /halted/);
  assert.equal(compareRollout(steps, store(20, { status: 'halted' })).halted, true);
  // A rollout where every step is done and the store is at 100%.
  const all = [step('a', 50, 'done'), step('b', 100, 'done')];
  assert.equal(compareRollout(all, storeRollout({ platform: 'android', status: 'live', rawState: 'completed', fraction: null, syncedAt: 1 })).verdict, 'match');
  assert.equal(formatPercent(20), '20%');
  assert.equal(formatPercent(20.54), '20.5%');
});

test('deadline reminders: due soon from the lead time before the end of the day, overdue after it, not forever', () => {
  const date = '2027-01-11'; // ends at 2027-01-12T00:00Z
  const end = Date.UTC(2027, 0, 12);
  const kind = (now: number, options = {}) => deadlineReminder(date, now, options).kind;
  assert.equal(kind(end - 24 * HOUR - 1), null);
  assert.equal(kind(end - 24 * HOUR), 'due_soon');
  assert.equal(deadlineReminder(date, end - 24 * HOUR).hoursLeft, 24);
  assert.equal(deadlineReminder(date, end - 90 * 60_000).hoursLeft, 2);
  assert.equal(kind(end - 1), 'due_soon');
  assert.equal(kind(end), 'overdue');
  assert.equal(deadlineReminder(date, end).daysOverdue, 1);
  assert.equal(deadlineReminder(date, end + 2 * DAY).daysOverdue, 3);
  assert.equal(kind(end + REMINDER_STALE_DAYS * DAY), 'overdue');
  assert.equal(kind(end + REMINDER_STALE_DAYS * DAY + 1), null);
  assert.equal(kind(end - 47 * HOUR, { leadHours: 48 }), 'due_soon');
  assert.equal(kind(end - 49 * HOUR, { leadHours: 48 }), null);
  assert.equal(kind(end, { released: true }), null);
  assert.equal(deadlineReminder(null, end).kind, null);
  assert.equal(deadlineReminder('not a date', end).kind, null);
  // The due key is the date itself, so a new date is a new key.
  assert.equal(deadlineReminder(date, end).dueKey, date);
  // A silly lead time is clamped, never trusted.
  assert.equal(kind(end - 100 * DAY, { leadHours: 1e9 }), null);
});

test('a rollout step is due once its planned time has passed, while open, and not long after', () => {
  const at = CREATED;
  assert.equal(rolloutStepReminderDue({ status: 'planned', plannedAt: at }, at), true);
  assert.equal(rolloutStepReminderDue({ status: 'planned', plannedAt: at + 1 }, at), false);
  assert.equal(rolloutStepReminderDue({ status: 'planned', plannedAt: null }, at), false);
  assert.equal(rolloutStepReminderDue({ status: 'done', plannedAt: at - HOUR }, at), false);
  assert.equal(rolloutStepReminderDue({ status: 'skipped', plannedAt: at - HOUR }, at), false);
  assert.equal(rolloutStepReminderDue({ status: 'planned', plannedAt: at - REMINDER_STALE_DAYS * DAY }, at), true);
  assert.equal(rolloutStepReminderDue({ status: 'planned', plannedAt: at - REMINDER_STALE_DAYS * DAY - 1 }, at), false);
});
