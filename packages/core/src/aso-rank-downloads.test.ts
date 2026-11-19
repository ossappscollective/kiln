import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, dayToMs } from './analytics.ts';
import {
  type DownloadsIn,
  type RankCheckIn,
  buildRankVsDownloads,
  compareMove,
  dailyRanks,
  describeComparison,
  rankDownloadsLimits,
  rankMarkers,
} from './aso-rank-downloads.ts';

const D0 = '2026-09-01';
const day = (n: number) => addDays(D0, n);
const at = (n: number, hour = 12) => dayToMs(day(n)) + hour * 3_600_000;
const check = (n: number, rank: number | null, hour = 12): RankCheckIn => ({ checkedAt: at(n, hour), rank, total: 50 });
const TODAY = day(60);

/** A flat rank of 30, then 12 from day `moveAt` on, checked every day from 0 to `last`. */
const steppedChecks = (moveAt: number, last: number, before = 30, after = 12): RankCheckIn[] => {
  const out: RankCheckIn[] = [];
  for (let n = 0; n <= last; n += 1) out.push(check(n, n < moveAt ? before : after));
  return out;
};

const downloads = (from: number, to: number, value: (n: number) => number | null, over: Partial<DownloadsIn> = {}): DownloadsIn => ({
  metric: 'downloads_first_time',
  label: 'First-time downloads',
  source: 'apple',
  delayDays: 2,
  points: Array.from({ length: to - from + 1 }, (_, i) => ({ day: day(from + i), value: value(from + i) })),
  ...over,
});

test('the last check of a UTC day is the day\'s rank; a move is dated by the later check', () => {
  const daily = dailyRanks([check(0, 30, 9), check(0, 28, 20), check(1, 29), check(2, 12)]);
  assert.deepEqual(daily.map((d) => [d.day, d.sample.rank]), [[day(0), 28], [day(1), 29], [day(2), 12]]);
  const markers = rankMarkers('k', daily, 5);
  assert.equal(markers.length, 1);
  assert.deepEqual([markers[0]?.day, markers[0]?.previousDay, markers[0]?.kind, markers[0]?.delta, markers[0]?.from, markers[0]?.to], [day(2), day(1), 'up', 17, 29, 12]);
});

test('markers use the threshold; entering or leaving counts only within the top 10', () => {
  const small = dailyRanks([check(0, 20), check(1, 17)]);
  assert.equal(rankMarkers('k', small, 5).length, 0);
  assert.equal(rankMarkers('k', small, 3).length, 1);
  assert.equal(rankMarkers('k', dailyRanks([check(0, null), check(1, 8)]), 5)[0]?.kind, 'entered');
  assert.equal(rankMarkers('k', dailyRanks([check(0, null), check(1, 40)]), 5).length, 0, 'entering at 40 is not news');
  assert.equal(rankMarkers('k', dailyRanks([check(0, 4), check(1, null)]), 5)[0]?.kind, 'dropped');
  assert.equal(rankMarkers('k', dailyRanks([check(0, 12), check(1, 30)]), 5)[0]?.kind, 'down');
});

test('compareMove: seven days before the earlier check and seven days after the later one, averaged, with the days counted', () => {
  const values: Record<string, number | null> = {};
  for (let n = 0; n < 40; n += 1) values[day(n)] = n <= 20 ? 10 : 15;
  const marker = rankMarkers('k', dailyRanks([check(19, 30), check(20, 12)]), 5)[0];
  assert.ok(marker);
  const c = compareMove(marker, values, { settledThrough: day(38) });
  assert.equal(c.status, 'ok');
  assert.deepEqual([c.before.from, c.before.to, c.before.days, c.before.perDay], [day(13), day(19), 7, 10]);
  assert.deepEqual([c.after.from, c.after.to, c.after.days, c.after.perDay], [day(21), day(27), 7, 15]);
  assert.equal(c.changePercent, 50);
  assert.equal(c.checkGapDays, 1);
  assert.equal(c.overlapsOtherMove, false);
  assert.match(describeComparison(c, 'water reminder'), /Correlation, not proof\./);
  assert.match(describeComparison(c, 'water reminder'), /7 days before: 10; 7 days after: 15 \(\+50%\)/);
});

test('compareMove: gaps are not zeros, an unsettled "after" waits, too few days is said, nothing before gives no percent', () => {
  const values: Record<string, number | null> = {};
  for (let n = 0; n < 40; n += 1) values[day(n)] = 10;
  const marker = rankMarkers('k', dailyRanks([check(19, 30), check(20, 12)]), 5)[0];
  assert.ok(marker);

  // Two days of the after window have no number: five days compared, the daily average is unchanged by the gap.
  values[day(22)] = null;
  values[day(23)] = null;
  const gapped = compareMove(marker, values, { settledThrough: day(38) });
  assert.equal(gapped.status, 'ok');
  assert.equal(gapped.after.days, 5);
  assert.equal(gapped.after.perDay, 10);
  assert.equal(gapped.changePercent, 0);

  // Three gaps leave four days: not compared.
  values[day(24)] = null;
  const thin = compareMove(marker, values, { settledThrough: day(38) });
  assert.equal(thin.status, 'too_few_days');
  assert.equal(thin.changePercent, null);
  assert.match(describeComparison(thin, 'x'), /Not enough days with numbers to compare \(7 before, 4 after; at least 5 each\)\. Correlation, not proof\./);

  // The store has not settled the last day of the window: wait, and say through when.
  const waiting = compareMove(marker, values, { settledThrough: day(26) });
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.settledNeededThrough, day(27));
  assert.equal(waiting.changePercent, null);

  // Nothing before: no percent, said plainly.
  const zero: Record<string, number | null> = {};
  for (let n = 0; n < 40; n += 1) zero[day(n)] = n < 20 ? 0 : 4;
  const none = compareMove(marker, zero, { settledThrough: day(38) });
  assert.equal(none.status, 'ok');
  assert.equal(none.changePercent, null);
  assert.match(describeComparison(none, 'x'), /no change figure \(no downloads before\)/);
});

test('checks several days apart are flagged, and two moves close together say they share days', () => {
  const values: Record<string, number | null> = {};
  for (let n = 0; n < 60; n += 1) values[day(n)] = 10;
  const a = rankMarkers('a', dailyRanks([check(10, 30), check(14, 20)]), 5)[0];
  const b = rankMarkers('b', dailyRanks([check(15, 30), check(16, 10)]), 5)[0];
  const c = rankMarkers('c', dailyRanks([check(40, 30), check(41, 10)]), 5)[0];
  assert.ok(a && b && c);
  const all = [a, b, c];
  const ca = compareMove(a, values, { settledThrough: day(58), others: all });
  assert.equal(ca.checkGapDays, 4);
  assert.equal(ca.overlapsOtherMove, true);
  assert.equal(compareMove(c, values, { settledThrough: day(58), others: all }).overlapsOtherMove, false);
});

test('buildRankVsDownloads aligns both series on the days of the range', () => {
  const view = buildRankVsDownloads({
    from: day(0),
    to: day(29),
    today: TODAY,
    keywords: [{ id: 'k1', term: 'water reminder', checks: steppedChecks(15, 29) }],
    downloads: downloads(-7, 36, (n) => (n === 5 ? null : 100 + n)),
    threshold: 5,
    analyticsEnabled: true,
  });
  assert.equal(view.days.length, 30);
  assert.equal(view.keywords[0]?.samples.length, 30);
  assert.equal(view.keywords[0]?.samples[0]?.rank, 30);
  assert.equal(view.keywords[0]?.samples[29]?.rank, 12);
  assert.equal(view.downloads?.values.length, 30);
  assert.equal(view.downloads?.values[5], null, 'a gap stays null');
  assert.equal(view.downloads?.values[6], 106);
  assert.equal(view.downloads?.days, 29);
  assert.deepEqual(view.coverage, { rankDays: 30, downloadDays: 29, minDays: 14 });
  assert.equal(view.enough, true);
  assert.equal(view.missing, null);
  assert.equal(view.markers.length, 1);
  assert.equal(view.markers[0]?.day, day(15));
  assert.equal(view.comparisons[0]?.status, 'ok');
  assert.equal(view.comparisons[0]?.before.days, 7);
  assert.ok(view.notes.some((n) => n.code === 'correlation_not_proof'));
  assert.ok(view.notes.some((n) => n.code === 'downloads_delay' && n.message.includes('Apple')));
});

test('lag: the newest days are not settled, so a late move waits', () => {
  const view = buildRankVsDownloads({
    from: day(0),
    to: day(29),
    today: day(30),
    keywords: [{ id: 'k1', term: 'x term', checks: steppedChecks(25, 29) }],
    downloads: downloads(-7, 29, () => 10, { delayDays: 4, source: 'play', metric: 'installs_user', label: 'User installs' }),
    threshold: 5,
    analyticsEnabled: true,
  });
  assert.equal(view.downloads?.settledThrough, day(26));
  assert.equal(view.comparisons.length, 1);
  assert.equal(view.comparisons[0]?.status, 'waiting');
  assert.equal(view.comparisons[0]?.settledNeededThrough, day(32));
  assert.ok(view.notes.some((n) => n.code === 'downloads_delay' && n.message.includes('Play')));
});

test('fewer than 14 days of either series hides the view and says what is missing', () => {
  const rankOnly = buildRankVsDownloads({
    from: day(0), to: day(29), today: TODAY,
    keywords: [{ id: 'k1', term: 'x term', checks: steppedChecks(15, 29) }],
    downloads: null,
    threshold: 5,
    analyticsEnabled: false,
  });
  assert.equal(rankOnly.enough, false);
  assert.equal(rankOnly.missing, 'turn_on_analytics');
  assert.deepEqual([rankOnly.markers.length, rankOnly.comparisons.length], [0, 0]);

  const noneRead = buildRankVsDownloads({ from: day(0), to: day(29), today: TODAY, keywords: [{ id: 'k1', term: 'x', checks: steppedChecks(15, 29) }], downloads: null, threshold: 5, analyticsEnabled: true });
  assert.equal(noneRead.missing, 'no_downloads');

  const fewRanks = buildRankVsDownloads({
    from: day(0), to: day(29), today: TODAY,
    keywords: [{ id: 'k1', term: 'x term', checks: steppedChecks(5, 12) }],
    downloads: downloads(0, 29, () => 10),
    threshold: 5,
    analyticsEnabled: true,
  });
  assert.equal(fewRanks.enough, false);
  assert.equal(fewRanks.coverage.rankDays, 13);
  assert.equal(fewRanks.missing, null);

  const fewDownloads = buildRankVsDownloads({
    from: day(0), to: day(29), today: TODAY,
    keywords: [{ id: 'k1', term: 'x term', checks: steppedChecks(15, 29) }],
    downloads: downloads(0, 12, () => 10),
    threshold: 5,
    analyticsEnabled: true,
  });
  assert.equal(fewDownloads.enough, false);
  assert.equal(fewDownloads.coverage.downloadDays, 13);

  const noRanks = buildRankVsDownloads({ from: day(0), to: day(29), today: TODAY, keywords: [{ id: 'k', term: 'x', checks: [] }], downloads: downloads(0, 29, () => 10), threshold: 5, analyticsEnabled: true });
  assert.equal(noRanks.missing, 'no_rank_checks');
  assert.equal(noRanks.enough, false);
});

test('exactly 14 days of both is enough; the rank days are the days any chosen keyword was checked', () => {
  const view = buildRankVsDownloads({
    from: day(0), to: day(29), today: TODAY,
    keywords: [
      { id: 'a', term: 'a term', checks: steppedChecks(100, 6) },
      { id: 'b', term: 'b term', checks: Array.from({ length: 7 }, (_, i) => check(10 + i, 20)) },
    ],
    downloads: downloads(0, 13, () => 5),
    threshold: 5,
    analyticsEnabled: true,
  });
  assert.equal(view.coverage.rankDays, 14);
  assert.equal(view.coverage.downloadDays, 14);
  assert.equal(view.enough, true);
});

test('at most five keywords, and the range is capped', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ id: `k${i}`, term: `term ${i}`, checks: steppedChecks(15, 29) }));
  const view = buildRankVsDownloads({ from: day(0), to: day(29), today: TODAY, keywords: many, downloads: downloads(0, 29, () => 10), threshold: 5, analyticsEnabled: true });
  assert.equal(view.keywords.length, rankDownloadsLimits.maxKeywords);
  const long = buildRankVsDownloads({ from: day(0), to: day(900), today: day(1000), keywords: [], downloads: null, threshold: 5, analyticsEnabled: true });
  assert.equal(long.days.length, rankDownloadsLimits.maxDays);
});

test('no sentence claims a cause', () => {
  const view = buildRankVsDownloads({
    from: day(0), to: day(29), today: TODAY,
    keywords: [{ id: 'k1', term: 'water reminder', checks: steppedChecks(15, 29) }],
    downloads: downloads(-7, 36, (n) => (n < 15 ? 10 : 20)),
    threshold: 5,
    analyticsEnabled: true,
  });
  const text = [...view.notes.map((n) => n.message), ...view.comparisons.map((c) => describeComparison(c, 'water reminder'))].join(' ').toLowerCase();
  for (const word of ['because', 'caused', 'led to', 'resulted', 'drove', 'thanks to', 'due to', 'boosted', 'improved downloads']) assert.ok(!text.includes(word), word);
  assert.ok(text.includes('correlation, not proof'));
});
