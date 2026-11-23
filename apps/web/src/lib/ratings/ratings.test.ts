import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useLocale } from '../i18n/test-setup.ts';
import {
  availableParts,
  comparisonRows,
  countryRows,
  fetchDays,
  type HealthView,
  LOW_SAMPLE,
  panelOf,
  type PlatformSnapshot,
  ratingChangeText,
  type RatingsBucket,
  type RatingsView,
  ratingsOverview,
  releaseRows,
  reviewSignal,
  shiftDay,
  stability,
  windowsOf,
  withHealthSection,
} from './ratings.ts';

useLocale('en');

const TO = '2026-11-20';
const bucket = (start: string, average: number | null, count: number | null, extra: Partial<RatingsBucket> = {}): RatingsBucket => ({
  start, end: start, count, average, newCount: 0, newAverage: null, newStars: null, newUnknown: 0, dayAverage: null, reset: false, spansGap: false, ...extra,
});
const ratings = (buckets: RatingsBucket[], extra: Partial<RatingsView> = {}): RatingsView => ({
  store: 'apple', from: shiftDay(TO, -55), to: TO, granularity: 'day', country: 'all', countries: [], historyStart: buckets.find((b) => b.average !== null)?.start ?? null,
  capabilities: { count: true, stars: true },
  summary: { average: [...buckets].reverse().find((b) => b.average !== null)?.average ?? null, count: [...buckets].reverse().find((b) => b.count !== null)?.count ?? null, newCount: 0, newRatingsKnown: true, written: { count: 0, stars: [0, 0, 0, 0, 0], average: null } },
  buckets, written: [], ...extra,
});
const run = (from: string, n: number, f: (i: number) => [number | null, number | null]) =>
  Array.from({ length: n }, (_, i) => { const [a, c] = f(i); return bucket(shiftDay(from, i), a, c); });

test('windows: the range and the same length before it; the API is asked for both', () => {
  const w = windowsOf(TO, 28);
  assert.deepEqual(w.current, { from: '2026-10-24', to: TO });
  assert.deepEqual(w.previous, { from: '2026-09-26', to: '2026-10-23' });
  assert.equal(fetchDays(28), 56);
  assert.equal(fetchDays(500), 730);
  assert.equal(fetchDays(3), 7);
});

test('ratings: no data at all, and a missing response, are "none" with nothing invented', () => {
  for (const v of [null, ratings([])]) {
    const o = ratingsOverview(v, 28);
    assert.equal(o.state, 'none');
    assert.equal(o.average, null);
    assert.equal(o.change.kind, 'none');
    assert.equal(o.points.length, 0);
  }
});

test('ratings: one snapshot has an average and a count but no trend and no change', () => {
  const o = ratingsOverview(ratings([bucket('2026-11-20', 4.5, 1200)]), 28);
  assert.equal(o.state, 'one');
  assert.equal(o.average, 4.5);
  assert.deepEqual(o.change, { kind: 'none', reason: 'one_reading' });
  assert.equal(o.since, '2026-11-20');
  assert.match(ratingChangeText(o.change, 28), /one reading|only one|one/i);
});

test('ratings: change against the previous period when it has readings, else against the start of the range', () => {
  const full = ratingsOverview(ratings(run('2026-09-26', 56, (i) => [i < 28 ? 4.4 : 4.5, 1000 + i])), 28);
  assert.equal(full.change.kind, 'change');
  if (full.change.kind === 'change') {
    assert.equal(full.change.direction, 'up');
    assert.equal(full.change.value, 0.1);
    assert.equal(full.change.basis, 'previous');
  }
  assert.match(ratingChangeText(full.change, 28), /^\+0\.10 .*28/);
  // History started inside the range: compare with the first reading and say since when.
  const short = ratingsOverview(ratings(run('2026-11-01', 20, (i) => [4.6 - i * 0.01, 500])), 28);
  assert.equal(short.change.kind, 'change');
  if (short.change.kind === 'change') {
    assert.equal(short.change.basis, 'range');
    assert.equal(short.change.since, '2026-11-01');
    assert.equal(short.change.direction, 'down');
  }
  assert.match(ratingChangeText(short.change, 28), /Nov 1/);
  // No move: "the same".
  const same = ratingsOverview(ratings(run('2026-09-26', 56, () => [4.5, 900])), 28);
  assert.equal(same.change.kind, 'flat');
});

test('ratings: gaps in the days stay gaps (null, never zero) and are said', () => {
  const buckets = run('2026-10-24', 28, (i) => (i % 2 === 0 ? [4.2, 300] : [null, null]));
  const o = ratingsOverview(ratings(buckets), 28);
  assert.equal(o.points.length, 28);
  assert.equal(o.points.filter((p) => p.value === null).length, 14);
  assert.ok(o.points.every((p) => p.value !== 0));
  const gap = ratingsOverview(ratings([bucket('2026-11-10', 4.2, 300), bucket('2026-11-20', 4.3, 310, { spansGap: true })]), 28);
  assert.equal(gap.spansGap, true);
});

test('ratings: a count that drops (Apple takes ratings away) is flagged, not hidden', () => {
  const o = ratingsOverview(ratings([bucket('2026-11-10', 4.5, 1000), bucket('2026-11-15', 4.5, 940, { reset: false }), bucket('2026-11-20', 4.5, 950)]), 28);
  assert.equal(o.countDropped, true);
  const reset = ratingsOverview(ratings([bucket('2026-11-10', 4.5, 1000), bucket('2026-11-20', 4.9, 12, { reset: true })]), 28);
  assert.equal(reset.reset, true);
  assert.equal(reset.lowSample, true);
});

test('ratings: a small count is a low sample; no count (Google Play) is unknown, not zero', () => {
  assert.equal(ratingsOverview(ratings([bucket('2026-11-19', 5, LOW_SAMPLE - 1), bucket('2026-11-20', 5, LOW_SAMPLE - 1)]), 28).lowSample, true);
  assert.equal(ratingsOverview(ratings([bucket('2026-11-19', 5, LOW_SAMPLE), bucket('2026-11-20', 5, LOW_SAMPLE)]), 28).lowSample, false);
  const play = ratingsOverview(ratings([bucket('2026-11-19', 4.1, null), bucket('2026-11-20', 4.2, null)], { store: 'google', capabilities: { count: false, stars: false } }), 28);
  assert.equal(play.countKnown, false);
  assert.equal(play.count, null);
  assert.equal(play.lowSample, false);
  assert.equal(play.newStars, null);
});

test('ratings: new ratings and stars are summed over the range only', () => {
  const buckets = run('2026-11-10', 11, () => [4.5, 100]).map((b, i) => ({ ...b, newCount: i === 3 ? 4 : 0, newStars: i === 3 ? [0, 0, 1, 1, 2] : null }));
  const o = ratingsOverview(ratings(buckets), 28);
  assert.equal(o.newCount, 4);
  assert.deepEqual(o.newStars, [0, 0, 1, 1, 2]);
  assert.equal(o.newCountPrevious, null);
});

test('reviews: share only from a real sample; below it the count and the number of low reviews', () => {
  const written = (stars: number[], start = '2026-11-15') => ({ start, end: start, stars, count: stars.reduce((a, b) => a + b, 0), average: null });
  const small = reviewSignal(ratings([], { written: [written([2, 1, 0, 0, 1])] }), 28);
  assert.equal(small.count, 4);
  assert.equal(small.low, 3);
  assert.equal(small.lowShare, null);
  assert.equal(small.lowSample, true);
  const big = reviewSignal(ratings([], { written: [written([20, 10, 5, 5, 60]), written([10, 5, 5, 5, 75], '2026-10-10')] }), 28);
  assert.equal(big.lowShare, 0.3);
  assert.equal(big.previous?.lowShare, 0.15);
  assert.equal(big.shareChange.kind, 'change');
  assert.equal(reviewSignal(null, 28).count, 0);
  assert.equal(reviewSignal(ratings([], { written: [written([1, 1, 1, 1, 1], '2026-01-01')] }), 28).count, 0);
});

const health = (rows: [string, number | null, number | null][], extra: Partial<HealthView> = {}): HealthView => ({
  store: 'google', from: shiftDay(TO, -55), to: TO, unit: 'share', setup: null, hasData: rows.some((r) => r[1] !== null), versions: [], finding: null,
  days: rows.map(([day, crash, freeze]) => ({ day, crash, freeze, crashMentions: 0 })), ...extra,
});

test('stability: mean over days with data, change vs previous, and not enough days says so', () => {
  const days = Array.from({ length: 56 }, (_, i): [string, number | null, number | null] => [shiftDay('2026-09-26', i), i < 28 ? 0.01 : 0.02, 0.004]);
  const s = stability(health(days), 28);
  assert.equal(s.state, 'data');
  assert.ok(Math.abs((s.crash.current ?? 0) - 0.02) < 1e-9);
  assert.equal(s.crash.change.kind, 'change');
  if (s.crash.change.kind === 'change') assert.equal(s.crash.change.value, 1);
  assert.equal(s.freeze?.change.kind, 'flat');
  const sparse = stability(health(days.map((d, i) => (i % 3 === 0 ? d : [d[0], null, null]))), 28);
  assert.deepEqual(sparse.crash.change, { kind: 'none', reason: 'not_enough_data' });
  const noPrev = stability(health(days.filter((d) => d[0] >= '2026-10-24')), 28);
  assert.deepEqual(noPrev.crash.change, { kind: 'none', reason: 'no_previous' });
});

test('stability: no data, setup missing, failed read and no freeze numbers (App Store) are told apart', () => {
  assert.equal(stability(null, 28).state, 'none');
  assert.equal(stability(health([]), 28).state, 'none');
  assert.equal(stability(health([], { setup: { setupCode: 'reporting_api_off', lastErrorCode: null, lastOkAt: null } }), 28).state, 'setup');
  assert.equal(stability(health([], { setup: { setupCode: null, lastErrorCode: 'x', lastOkAt: null } }), 28).state, 'error');
  assert.equal(stability(health([['2026-11-20', 0.01, null]], { store: 'apple', unit: 'perSessions' }), 28).freeze, null);
  const finding = { kind: 'worse' as const, measure: 'crash' as const, version: '2.1', name: null, previous: '2.0', before: 0.01, after: 0.03, overLine: true, from: '2026-11-10', to: TO, mentions: 3 };
  assert.equal(stability(health([['2026-11-20', 0.03, null]], { finding }), 28).finding?.version, '2.1');
});

test('release impact: rating before and 7 to 14 days after; too early and no history are explicit', () => {
  const r = ratings(run('2026-10-01', 50, (i) => [i < 20 ? 4.0 : 4.3, 500]));
  const h = health([], {
    versions: [
      { version: '2.0', name: null, from: '2026-10-21', to: '2026-11-05', crash: { rate: 0.01, volume: 1000, steady: true }, freeze: null, change: { kind: 'better', previous: '1.9', before: 0.02, after: 0.01, overLine: false }, reviews: 5, crashReviews: 0 },
      { version: '2.1', name: null, from: '2026-11-18', to: TO, crash: { rate: 0.01, volume: 10, steady: false }, freeze: null, change: null, reviews: 0, crashReviews: 0 },
      { version: '1.0', name: null, from: '2026-09-01', to: '2026-09-30', crash: { rate: 0.01, volume: 10, steady: false }, freeze: null, change: null, reviews: 0, crashReviews: 0 },
    ],
  });
  const rows = releaseRows(h, r);
  assert.equal(rows[0]?.ratingState, 'ok');
  assert.equal(rows[0]?.ratingChange.kind, 'change');
  assert.equal(rows[0]?.crashChange?.kind, 'better');
  assert.equal(rows[1]?.ratingState, 'too_early');
  assert.equal(rows[2]?.ratingState, 'no_history');
  assert.equal(releaseRows(null, r).length, 0);
  assert.equal(releaseRows(h, null)[0]?.ratingState, 'no_history');
});

test('countries: biggest count first, small samples marked, no count last', () => {
  const c = (territory: string, count: number | null) => ({ territory, average: 4, count, newCount: 0, newAverage: null, change: null, day: TO });
  const rows = countryRows(ratings([], { countries: [c('FR', 12), c('US', 5000), c('DE', null)] }));
  assert.deepEqual(rows.map((x) => x.territory), ['US', 'FR', 'DE']);
  assert.deepEqual(rows.map((x) => x.lowSample), [false, true, false]);
  assert.deepEqual(countryRows(null), []);
});

const snap = (platform: string, r: RatingsView | null, h: HealthView | null): PlatformSnapshot => ({
  platform, appId: platform, ratings: ratingsOverview(r, 28), reviews: reviewSignal(r, 28), stability: stability(h, 28), releases: releaseRows(h, r), countries: countryRows(r),
});

test('parts: a section with nothing to say is not listed; one platform or none still gives Ratings', () => {
  assert.deepEqual(availableParts([snap('ios', null, null)]), ['ratings']);
  const r = ratings(run('2026-11-01', 20, () => [4.5, 900]), { countries: [{ territory: 'US', average: 4.5, count: 900, newCount: 0, newAverage: null, change: null, day: TO }], written: [{ start: '2026-11-10', end: '2026-11-10', stars: [1, 0, 0, 0, 2], count: 3, average: null }] });
  const parts = availableParts([snap('ios', r, health([[TO, 0.01, null]]))]);
  assert.deepEqual(parts, ['ratings', 'reviews', 'stability', 'countries']);
});

test('comparison: one row per measure and one cell per platform, with dashes for what a store does not give', () => {
  const ios = snap('ios', ratings(run('2026-11-01', 20, () => [4.5, 900])), health([[TO, 0.002, null]], { store: 'apple', unit: 'perSessions' }));
  const android = snap('android', ratings(run('2026-11-01', 20, () => [4.1, null]), { store: 'google', capabilities: { count: false, stars: false } }), null);
  const rows = comparisonRows([ios, android], 28);
  assert.deepEqual(rows.map((x) => x.id), ['average', 'count', 'change', 'low', 'crash', 'freeze']);
  assert.ok(rows.every((x) => x.cells.length === 2));
  assert.equal(rows[0]?.cells[0]?.text, '4.50');
  assert.equal(rows[1]?.cells[1]?.text, '—');
  assert.equal(rows[4]?.cells[0]?.text, '0.20%');
  assert.equal(rows[5]?.cells[0]?.text, '—');
});

test('panelOf: nothing to draw without a value; a gap is not a zero; a rating axis is tight', () => {
  assert.equal(panelOf('r', 'rating', 'x', [{ date: TO, value: null }]), null);
  const p = panelOf('r', 'rating', 'x', [{ date: '2026-11-19', value: 4.5 }, { date: TO, value: null }]);
  assert.equal(p?.domain, 'tight');
  assert.equal(p?.series[0]?.series.coverage.gapDays, 1);
  assert.equal(p?.series[0]?.series.coverage.state, 'partial');
});

test('address: the section keeps ?view=ratings; the first section is the default', () => {
  assert.equal(withHealthSection('#/portfolio/a1/insights?view=ratings', 'stability'), '#/portfolio/a1/insights?view=ratings&section=stability');
  assert.equal(withHealthSection('#/portfolio/a1/insights?view=ratings&section=stability&range=90', 'ratings'), '#/portfolio/a1/insights?view=ratings&range=90');
  assert.equal(withHealthSection('#/portfolio/a1/insights', 'countries'), '#/portfolio/a1/insights?view=ratings&section=countries');
});

test('a custom range that ended in the past is windowed on its own end, not on today', () => {
  const buckets = run('2026-08-01', 120, (i) => [i < 28 ? 4.0 : i < 56 ? 4.2 : 4.8, 800]);
  const o = ratingsOverview(ratings(buckets), 28, '2026-09-25');
  assert.equal(o.points.length, 28);
  assert.equal(o.change.kind === 'change' && o.change.direction, 'up');
  assert.equal(fetchDays(28, '2026-08-29', '2026-11-20'), 112);
});
