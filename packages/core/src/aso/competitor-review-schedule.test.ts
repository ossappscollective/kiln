import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  competitorReviewLimits,
  effectiveReviewSchedule,
  latestReviewSlot,
  nextReviewRunAt,
  nextReviewSlot,
  normalizeReviewSchedule,
  type ReviewSchedule,
  reviewJitterMinutes,
  reviewReadBackoffMs,
  reviewReadDue,
} from './competitor-review-schedule.ts';

const daily: ReviewSchedule = { mode: 'daily', weekday: null, timezone: null };
const weekly = (weekday: number, timezone: string | null = null): ReviewSchedule => ({
  mode: 'weekly',
  weekday,
  timezone,
});
const T = Date.UTC(2026, 10, 24, 12, 0); // Tuesday 24 November 2026, 12:00 UTC
const due = (over: Partial<Parameters<typeof reviewReadDue>[0]> = {}) =>
  reviewReadDue({
    schedule: daily,
    key: 'c1',
    now: T,
    lastAttemptAt: null,
    changedAt: 0,
    backoffUntil: null,
    paused: false,
    ...over,
  });

test('jitter stays inside its bounds, is stable and spreads competitors', () => {
  const seen = new Set<number>();
  for (let i = 0; i < 300; i += 1) {
    const j = reviewJitterMinutes(`competitor-${i}`);
    assert.ok(j >= 0 && j < competitorReviewLimits.jitterMinutes);
    assert.equal(j, reviewJitterMinutes(`competitor-${i}`));
    seen.add(j);
  }
  assert.ok(seen.size > 100);
  const slot = latestReviewSlot(daily, 'c1', T);
  assert.ok(slot !== null);
  const minutes = (slot - Date.UTC(2026, 10, 24)) / 60_000;
  assert.ok(
    minutes >= competitorReviewLimits.baseMinutes &&
      minutes < competitorReviewLimits.baseMinutes + competitorReviewLimits.jitterMinutes,
  );
});

test('daily: due once after the slot of the day, not again until the next one', () => {
  assert.equal(due().due, true);
  const slot = latestReviewSlot(daily, 'c1', T) as number;
  assert.equal(due({ now: slot - 1, lastAttemptAt: slot - 86_400_000 }).due, false);
  assert.equal(due({ now: slot, lastAttemptAt: slot - 86_400_000 }).due, true);
  assert.equal(due({ lastAttemptAt: slot + 60_000 }).due, false);
  const next = nextReviewSlot(daily, 'c1', T) as number;
  assert.equal(next - slot, 86_400_000);
  assert.equal(due({ now: next, lastAttemptAt: slot + 60_000 }).due, true);
});

test('weekly: only on its weekday, in the zone of the app', () => {
  const monday = weekly(1);
  const slot = latestReviewSlot(monday, 'c1', T) as number;
  assert.equal(new Date(slot).getUTCDay(), 1);
  assert.ok(T - slot < 7 * 86_400_000);
  assert.equal(due({ schedule: monday, lastAttemptAt: slot + 1000 }).due, false);
  const next = nextReviewSlot(monday, 'c1', T) as number;
  assert.equal(next - slot, 7 * 86_400_000);
  // Tokyo is a day ahead of UTC late in the evening: the local Wednesday starts at 15:00 UTC on Tuesday.
  const tokyo = weekly(3, 'Asia/Tokyo');
  const wed = nextReviewSlot(tokyo, 'c1', Date.UTC(2026, 10, 24, 16, 0)) as number;
  assert.equal(
    new Date(wed).toLocaleString('en-US', { timeZone: 'Asia/Tokyo', weekday: 'short' }),
    'Wed',
  );
  const hour = Number(
    new Date(wed).toLocaleString('en-US', {
      timeZone: 'Asia/Tokyo',
      hour: '2-digit',
      hourCycle: 'h23',
    }),
  );
  assert.ok(hour >= 5 && hour <= 8);
});

test('daylight saving: the local hour stays the same across the change', () => {
  const paris: ReviewSchedule = { mode: 'daily', weekday: null, timezone: 'Europe/Paris' };
  const before = latestReviewSlot(paris, 'c1', Date.UTC(2026, 9, 24, 12)) as number;
  const after = latestReviewSlot(paris, 'c1', Date.UTC(2026, 10, 3, 12)) as number;
  const h = (t: number) =>
    new Date(t).toLocaleString('en-US', {
      timeZone: 'Europe/Paris',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  assert.equal(h(before), h(after));
});

test('off and paused are never due and have no next run', () => {
  const off: ReviewSchedule = { mode: 'off', weekday: null, timezone: null };
  assert.deepEqual(due({ schedule: off }), { due: false, reason: 'off' });
  assert.deepEqual(due({ paused: true }), { due: false, reason: 'paused' });
  assert.equal(
    nextReviewRunAt({
      schedule: off,
      key: 'c1',
      now: T,
      lastAttemptAt: null,
      changedAt: 0,
      backoffUntil: null,
      paused: false,
    }),
    null,
  );
  assert.equal(
    nextReviewRunAt({
      schedule: daily,
      key: 'c1',
      now: T,
      lastAttemptAt: null,
      changedAt: 0,
      backoffUntil: null,
      paused: true,
    }),
    null,
  );
});

test('a new schedule waits for its next slot instead of reading at once', () => {
  assert.equal(due({ changedAt: T - 1000 }).due, false);
  assert.equal(due({ changedAt: T - 1000 }).reason, 'not_yet');
});

test('backoff after a failure: 15 minutes, doubled, capped at 6 hours; due again only when it ends', () => {
  assert.equal(reviewReadBackoffMs(1), 15 * 60_000);
  assert.equal(reviewReadBackoffMs(2), 30 * 60_000);
  assert.equal(reviewReadBackoffMs(20), 6 * 60 * 60_000);
  assert.deepEqual(due({ backoffUntil: T + 1 }), { due: false, reason: 'backoff' });
  assert.equal(due({ backoffUntil: T }).due, true);
  const next = nextReviewRunAt({
    schedule: daily,
    key: 'c1',
    now: T,
    lastAttemptAt: null,
    changedAt: 0,
    backoffUntil: T + 600_000,
    paused: false,
  });
  assert.equal(next, T + 600_000);
});

test('a competitor can override the app: off, or its own weekday', () => {
  assert.deepEqual(effectiveReviewSchedule(daily, null), daily);
  assert.equal(effectiveReviewSchedule(daily, { mode: 'off', weekday: null }).mode, 'off');
  assert.deepEqual(
    effectiveReviewSchedule(weekly(1, 'Europe/Paris'), { mode: 'weekly', weekday: 5 }),
    weekly(5, 'Europe/Paris'),
  );
  assert.equal(effectiveReviewSchedule(daily, { mode: 'weekly', weekday: null }).weekday, 1);
});

test('normalize: weekly needs a weekday, a bad zone is refused, daily drops the weekday', () => {
  const off: ReviewSchedule = { mode: 'off', weekday: null, timezone: null };
  assert.ok(!normalizeReviewSchedule({ mode: 'weekly' }, off).ok);
  assert.ok(!normalizeReviewSchedule({ mode: 'daily', timezone: 'Mars/Base' }, off).ok);
  assert.ok(!normalizeReviewSchedule({ mode: 'hourly' }, off).ok);
  const ok = normalizeReviewSchedule({ mode: 'daily', weekday: 2, timezone: 'Europe/Paris' }, off);
  assert.ok(ok.ok && ok.value.weekday === null && ok.value.timezone === 'Europe/Paris');
  const w = normalizeReviewSchedule({ mode: 'weekly', weekday: 0 }, off);
  assert.ok(w.ok && w.value.weekday === 0);
});
