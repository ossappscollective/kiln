import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bucketsIn, weekStart } from './days.ts';
import { countryRows, type Reading, ratingBuckets, reviewBuckets, stepsOf } from './history.ts';

const r = (
  day: string,
  average: number,
  count: number | null,
  extra: Partial<Reading> = {},
): Reading => ({ day, territory: 'US', average, count, stars: null, ...extra });

test('new ratings are the count difference; their average comes from the two averages', () => {
  const steps = stepsOf([r('2026-11-01', 4, 10), r('2026-11-02', 4.2, 15)], 'US');
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.newCount, 5);
  assert.equal(steps[0]!.newSum, 4.2 * 15 - 40); // 23 stars over 5 ratings
  assert.equal(steps[0]!.newStars, null);
});

test('a missing day is carried over: the step lands on the later day and says it spans a gap', () => {
  const rows = [r('2026-11-01', 4, 10), r('2026-11-04', 4, 16)];
  const [b] = ratingBuckets(rows, {
    country: 'US',
    granularity: 'week',
    from: '2026-11-02',
    to: '2026-11-08',
  });
  assert.equal(b!.newCount, 6);
  assert.equal(
    b!.spansGap,
    true,
    'the readings were on 11-01 and 11-04: part of the six may be from 11-01',
  );
  const days = ratingBuckets(rows, {
    country: 'US',
    granularity: 'day',
    from: '2026-11-01',
    to: '2026-11-04',
  });
  assert.deepEqual(
    days.map((d) => d.newCount),
    [0, 0, 0, 6],
  );
  assert.deepEqual(
    days.map((d) => d.count),
    [10, 10, 10, 16],
    'the count is carried over',
  );
});

test('with stars at both ends the new ratings per star are exact; without them the share is unknown', () => {
  const rows = [
    r('2026-11-01', 4, 10, { stars: [1, 1, 1, 3, 4] }),
    r('2026-11-02', 4.2, 14, { stars: [1, 1, 1, 3, 8] }),
    r('2026-11-03', 4.2, 17),
  ];
  const [a, b, c] = ratingBuckets(rows, {
    country: 'US',
    granularity: 'day',
    from: '2026-11-01',
    to: '2026-11-03',
  });
  assert.deepEqual(a!.newStars, null);
  assert.deepEqual(b!.newStars, [0, 0, 0, 0, 4]);
  assert.equal(b!.newUnknown, 0);
  assert.equal(c!.newStars, null);
  assert.equal(c!.newUnknown, 3, 'the grey share');
});

test('a count that falls is not new ratings; under half it is a reset and the ratings counted since are all new', () => {
  assert.equal(stepsOf([r('2026-11-01', 4, 100), r('2026-11-02', 4, 98)], 'US')[0]!.newCount, 0);
  const reset = stepsOf([r('2026-11-01', 4, 100), r('2026-11-02', 5, 12)], 'US')[0]!;
  assert.equal(reset.reset, true);
  assert.equal(reset.newCount, 12);
});

test('Apple rounds averages: with many ratings and few new ones the new ratings get no average', () => {
  const step = stepsOf(
    [r('2026-11-01', 4.4, 2_000_000), r('2026-11-02', 4.4, 2_000_003)],
    'US',
  )[0]!;
  assert.equal(step.newCount, 3);
  assert.equal(step.newSum, null);
});

test('all countries add up the newest reading of each; a country read less often keeps its last reading', () => {
  const rows = [
    r('2026-11-01', 4, 10),
    r('2026-11-02', 4, 12),
    { ...r('2026-11-01', 5, 2), territory: 'FR' },
  ];
  const [, b] = ratingBuckets(rows, {
    country: 'all',
    granularity: 'day',
    from: '2026-11-01',
    to: '2026-11-02',
  });
  assert.equal(b!.count, 14);
  assert.equal(b!.newCount, 2);
  assert.equal(countryRows(rows, '2026-11-01', '2026-11-02')[0]!.territory, 'US');
});

test('Google Play has an average and no count: no new ratings, the average and the day average still show', () => {
  const rows = [
    r('2026-11-01', 4.1, null, { territory: 'ALL', dayAverage: 5 }),
    r('2026-11-02', 4.2, null, { territory: 'ALL', dayAverage: 3 }),
  ];
  const [, b] = ratingBuckets(rows, {
    country: 'all',
    granularity: 'day',
    from: '2026-11-01',
    to: '2026-11-02',
  });
  assert.equal(b!.count, null);
  assert.equal(b!.average, 4.2);
  assert.equal(b!.newCount, 0);
  assert.equal(b!.dayAverage, 3);
});

test('buckets: weeks start on Monday, the last bucket ends at the window end; written reviews are counted per star', () => {
  assert.equal(weekStart('2026-11-22'), '2026-11-16');
  assert.deepEqual(bucketsIn('2026-11-18', '2026-11-24', 'week'), [
    { start: '2026-11-16', end: '2026-11-22' },
    { start: '2026-11-23', end: '2026-11-24' },
  ]);
  const w = reviewBuckets(
    [
      { day: '2026-11-18', rating: 5 },
      { day: '2026-11-19', rating: 1 },
      { day: '2026-11-23', rating: 5 },
      { day: '2026-10-01', rating: 3 },
    ],
    { country: 'all', granularity: 'week', from: '2026-11-18', to: '2026-11-24' },
  );
  assert.deepEqual(
    w.map((b) => b.count),
    [2, 1],
  );
  assert.deepEqual(w[0]!.stars, [1, 0, 0, 0, 1]);
  assert.equal(w[0]!.average, 3);
});
