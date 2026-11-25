import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type CompetitorReviewState,
  competitorStateLines,
  isScheduleDirty,
  readErrorText,
  scheduleChanges,
  scheduleSentence,
  scheduleToForm,
  validateSchedule,
  weekdayOrder,
} from './competitor-review-schedule.ts';

const view = {
  schedule: { mode: 'weekly' as const, weekday: 1, timezone: null },
  paused: false,
  maxCompetitors: 5,
  maxReviews: 20,
};
const limits = { maxCompetitors: 10, maxReviews: 50 };
const NOW = Date.UTC(2026, 10, 24, 12);
const comp = (over: Partial<CompetitorReviewState> = {}): CompetitorReviewState => ({
  competitorId: 'c1',
  name: 'Rival',
  store: 'apple',
  supported: true,
  override: null,
  effective: { mode: 'weekly', weekday: 1, timezone: null },
  lastReadAt: NOW - 2 * 86_400_000,
  newCount: 3,
  failures: 0,
  lastError: null,
  backoffUntil: null,
  nextRunAt: NOW + 86_400_000,
  ...over,
});

test('the form mirrors the view and week starts on Monday', () => {
  assert.deepEqual(scheduleToForm(view), {
    mode: 'weekly',
    weekday: 1,
    timezone: '',
    paused: false,
    maxCompetitors: '5',
    maxReviews: '20',
  });
  assert.deepEqual(weekdayOrder, [1, 2, 3, 4, 5, 6, 0]);
});

test('validation bounds the two guards', () => {
  const form = scheduleToForm(view);
  assert.deepEqual(validateSchedule(form, limits), {});
  assert.ok(validateSchedule({ ...form, maxCompetitors: '0' }, limits).maxCompetitors);
  assert.ok(validateSchedule({ ...form, maxCompetitors: '11' }, limits).maxCompetitors);
  assert.ok(validateSchedule({ ...form, maxReviews: '51' }, limits).maxReviews);
  assert.ok(validateSchedule({ ...form, maxReviews: '2.5' }, limits).maxReviews);
});

test('only changes go to the PUT; the weekday goes with a switch to weekly', () => {
  const form = scheduleToForm(view);
  assert.deepEqual(scheduleChanges(view, form), {});
  assert.equal(isScheduleDirty(view, form), false);
  assert.deepEqual(scheduleChanges(view, { ...form, weekday: 3, maxReviews: '30' }), {
    weekday: 3,
    maxReviews: 30,
  });
  assert.deepEqual(scheduleChanges(view, { ...form, timezone: 'Europe/Paris' }), {
    timezone: 'Europe/Paris',
  });
  const off = {
    ...view,
    schedule: { mode: 'off' as const, weekday: null, timezone: 'Europe/Paris' },
  };
  assert.deepEqual(scheduleChanges(off, { ...scheduleToForm(off), mode: 'weekly', timezone: '' }), {
    mode: 'weekly',
    weekday: 1,
    timezone: null,
  });
});

test('sentences: every Monday, every day, none', () => {
  assert.match(scheduleSentence({ mode: 'weekly', weekday: 1, timezone: null }), /Monday/);
  assert.notEqual(
    scheduleSentence({ mode: 'daily', weekday: null, timezone: null }),
    scheduleSentence({ mode: 'off', weekday: null, timezone: null }),
  );
});

test('error codes read as reasons and an unknown code as a general failure', () => {
  assert.equal(readErrorText(null), '');
  assert.notEqual(readErrorText('timeout'), readErrorText('rate_limited'));
  assert.equal(readErrorText('weird'), readErrorText('failed'));
  assert.notEqual(readErrorText('unavailable_503'), readErrorText('weird'));
});

test('the state line gives schedule, last read with the count, and next run', () => {
  const lines = competitorStateLines(comp(), false, NOW);
  assert.match(lines.schedule, /Monday/);
  assert.match(lines.last, /3 new reviews/);
  assert.notEqual(lines.next, '');
  assert.equal(lines.failure, '');
  assert.match(competitorStateLines(comp({ lastReadAt: null }), false, NOW).last, /Not read yet/);
  assert.match(competitorStateLines(comp(), true, NOW).schedule, /Paused/);
});

test('a failure and a play competitor', () => {
  const failed = competitorStateLines(comp({ failures: 2, lastError: 'timeout' }), false, NOW);
  assert.match(failed.failure, /2 reads in a row/);
  const waiting = competitorStateLines(
    comp({ failures: 0, lastError: 'rate_limited' }),
    false,
    NOW,
  );
  assert.match(waiting.failure, /Waiting/);
  const play = competitorStateLines(comp({ supported: false, store: 'play' }), false, NOW);
  assert.match(play.schedule, /Google Play/);
  assert.equal(play.last + play.next + play.failure, '');
});
