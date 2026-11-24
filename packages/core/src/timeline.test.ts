import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays } from './analytics.ts';
import { figureFor } from './report-figures.ts';
import {
  type TimelineEvent,
  dailyValue,
  liveDayOf,
  mergeEvents,
  timelineMetricsFrom,
} from './timeline-events.ts';
import {
  confidenceBar,
  countConfidence,
  impactOf,
  normalCdf,
  proportionConfidence,
  sinceWindowDays,
  windowStats,
} from './timeline-impact.ts';
import {
  compareWith,
  latestCompletePeriod,
  periodContaining,
  recentPeriods,
} from './timeline-periods.ts';

const range = (
  from: string,
  days: number,
  f: (i: number) => number | null,
): Map<string, number> => {
  const m = new Map<string, number>();
  for (let i = 0; i < days; i += 1) {
    const v = f(i);
    if (v !== null) m.set(addDays(from, i), v);
  }
  return m;
};

test('normal cdf and the two tests', () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-3);
  assert.equal(proportionConfidence(1, 0, 1, 10), null);
  assert.ok((proportionConfidence(5, 10, 5, 10) ?? 1) < 1e-6);
  assert.ok((proportionConfidence(100, 1000, 150, 1000) ?? 0) > 0.99);
  assert.equal(countConfidence(0, 0), null);
  assert.ok((countConfidence(100, 200) ?? 0) > 0.99);
});

test('confidence bar: none before a week, 99% while filling, 90% when full', () => {
  assert.equal(confidenceBar(6, 14), null);
  assert.equal(confidenceBar(7, 14), 0.99);
  assert.equal(confidenceBar(13, 14), 0.99);
  assert.equal(confidenceBar(14, 14), 0.9);
  assert.equal(confidenceBar(7, 7), 0.9);
});

test('windowStats counts gaps as missing, not zero', () => {
  const v = range('2026-03-01', 10, (i) => (i === 3 ? null : 10));
  const w = windowStats('count', v, undefined, '2026-03-01', '2026-03-10');
  assert.equal(w.calendarDays, 10);
  assert.equal(w.dataDays, 9);
  assert.equal(w.value, 10);
  assert.equal(windowStats('count', v, undefined, '2026-03-10', '2026-03-01').calendarDays, 0);
});

test('a rate over visits: clear rise after a full window', () => {
  const visits = range('2026-03-01', 40, () => 100);
  const dl = range('2026-03-01', 40, (i) => (i < 14 ? 10 : 15));
  const r = impactOf({
    kind: 'ratio',
    values: dl,
    denominators: visits,
    anchor: '2026-03-14',
    latest: '2026-04-09',
    days: 14,
  });
  assert.equal(r.verdict, 'higher');
  assert.ok(Math.abs((r.change ?? 0) - 0.5) < 1e-9);
  assert.equal(r.daysAfter, 14);
  assert.equal(r.daysToFull, 0);
  assert.ok(!r.caveats.includes('short_window'));
});

test('short window: fewer than 7 days is too early, 7 to 13 needs 99%', () => {
  const visits = range('2026-03-01', 40, () => 100);
  const dl = range('2026-03-01', 40, (i) => (i < 14 ? 10 : 15));
  const early = impactOf({
    kind: 'ratio',
    values: dl,
    denominators: visits,
    anchor: '2026-03-14',
    latest: '2026-03-19',
    days: 14,
  });
  assert.equal(early.verdict, 'too_early');
  assert.equal(early.daysAfter, 5);
  assert.equal(early.daysToFirstRead, 2);
  assert.ok(early.caveats.includes('short_window'));
  const wk = impactOf({
    kind: 'ratio',
    values: dl,
    denominators: visits,
    anchor: '2026-03-14',
    latest: '2026-03-21',
    days: 14,
  });
  assert.equal(wk.verdict, 'higher');
  const faint = range('2026-03-01', 40, (i) => (i < 14 ? 10 : 11));
  assert.equal(
    impactOf({
      kind: 'ratio',
      values: faint,
      denominators: visits,
      anchor: '2026-03-14',
      latest: '2026-03-21',
      days: 14,
    }).verdict,
    'too_early',
  );
  assert.equal(
    impactOf({
      kind: 'ratio',
      values: faint,
      denominators: visits,
      anchor: '2026-03-14',
      latest: '2026-04-09',
      days: 14,
    }).verdict,
    'no_clear_difference',
  );
});

test('gaps, small numbers, no data, levels, other events', () => {
  const v = range('2026-03-01', 30, (i) => (i % 2 ? null : 5));
  const r = impactOf({
    kind: 'count',
    values: v,
    anchor: '2026-03-14',
    latest: '2026-03-30',
    days: 14,
    otherEvents: 2,
  });
  assert.ok(r.caveats.includes('gaps'));
  assert.ok(r.caveats.includes('other_events'));
  assert.ok(r.caveats.includes('small_numbers'));
  assert.ok(r.caveats.includes('approximate_test'));
  const none = impactOf({
    kind: 'count',
    values: new Map(),
    anchor: '2026-03-14',
    latest: '2026-03-30',
    days: 14,
  });
  assert.equal(none.verdict, 'no_data');
  assert.equal(none.change, null);
  const money = range('2026-03-01', 30, (i) => (i < 14 ? 10 : 20));
  const m = impactOf({
    kind: 'level',
    values: money,
    anchor: '2026-03-14',
    latest: '2026-03-30',
    days: 14,
  });
  assert.equal(m.verdict, 'not_tested');
  assert.equal(m.confidence, null);
  assert.ok(m.caveats.includes('not_tested'));
  const notYet = impactOf({
    kind: 'count',
    values: money,
    anchor: '2026-03-14',
    latest: '2026-03-14',
    days: 14,
  });
  assert.equal(notYet.verdict, 'too_early');
  assert.equal(notYet.daysAfter, 0);
});

test('sinceWindowDays caps at 28 and is 0 on the day of the change', () => {
  assert.equal(sinceWindowDays('2026-03-01', '2026-03-01'), 0);
  assert.equal(sinceWindowDays('2026-03-01', '2026-03-10'), 9);
  assert.equal(sinceWindowDays('2026-01-01', '2026-03-10'), 28);
});

const ev = (
  id: string,
  day: string,
  kind: TimelineEvent['kind'],
  extra: Partial<TimelineEvent> = {},
): TimelineEvent => ({
  id,
  day,
  kind,
  origin: 'kiln',
  label: null,
  title: null,
  note: null,
  version: null,
  liveDay: null,
  waitsForRelease: false,
  ...extra,
});

test('mergeEvents: dedup by id, one release per version and day, drift after a push dropped, sorted', () => {
  const merged = mergeEvents([
    [
      ev('b', '2026-03-05', 'press', { origin: 'manual', title: 'x' }),
      ev('a', '2026-03-05', 'release', { version: '2.0' }),
    ],
    [
      ev('a', '2026-03-05', 'release', { version: '2.0' }),
      ev('c', '2026-03-05', 'release', { version: '2.0' }),
      ev('d', '2026-03-01', 'listing_text'),
    ],
    [
      ev('e', '2026-03-02', 'listing_drift'),
      ev('f', '2026-03-09', 'listing_drift'),
      ev('g', '2026-03-01', 'graphics'),
    ],
  ]);
  assert.deepEqual(
    merged.map((e) => e.id),
    ['g', 'd', 'a', 'b', 'f'],
  );
});

test('liveDayOf waits for the next release on the App Store, is the day otherwise', () => {
  const page = ev('p', '2026-03-05', 'graphics', { waitsForRelease: true });
  assert.equal(liveDayOf(page, ['2026-03-01', '2026-03-10', '2026-03-20']), '2026-03-10');
  assert.equal(liveDayOf(page, ['2026-03-05']), '2026-03-05');
  assert.equal(liveDayOf(page, ['2026-03-01']), null);
  assert.equal(liveDayOf(ev('q', '2026-03-05', 'press'), []), '2026-03-05');
});

test('timelineMetricsFrom keeps metrics with data, rates from two series, Play pair, money per currency, skips monthly', () => {
  const pts = (n: number) => [
    { date: '2026-03-01', value: n },
    { date: '2026-03-02', value: null },
  ];
  const apple = timelineMetricsFrom([
    { id: 'impressions', points: pts(1000) },
    { id: 'product_page_views', points: pts(100) },
    { id: 'downloads_first_time', points: pts(10) },
    { id: 'sales_proceeds:EUR', points: pts(5) },
    { id: 'earnings_net:EUR', cadence: 'monthly', points: pts(5) },
    { id: 'sessions', points: [] },
  ]);
  assert.deepEqual(
    apple.map((m) => m.id),
    [
      'impressions',
      'product_page_views',
      'downloads_first_time',
      'download_rate',
      'product_page_conversion',
      'sales_proceeds:EUR',
    ],
  );
  const rate = apple.find((m) => m.id === 'download_rate');
  assert.equal(dailyValue(rate!, '2026-03-01'), 0.01);
  assert.equal(dailyValue(rate!, '2026-03-02'), null);
  const play = timelineMetricsFrom([
    { id: 'store_listing_visitors', points: pts(200) },
    { id: 'store_listing_acquisitions', points: pts(20) },
  ]);
  assert.deepEqual(
    play.map((m) => m.id),
    ['store_listing_visitors', 'store_listing_acquisitions', 'product_page_conversion'],
  );
  assert.equal(dailyValue(play[2]!, '2026-03-01'), 0.1);
});

test('periods: Monday weeks, months, leap years', () => {
  assert.deepEqual(periodContaining('week', '2026-03-04'), {
    from: '2026-03-02',
    to: '2026-03-08',
  });
  assert.deepEqual(periodContaining('week', '2026-03-08'), {
    from: '2026-03-02',
    to: '2026-03-08',
  });
  assert.deepEqual(periodContaining('month', '2024-02-10'), {
    from: '2024-02-01',
    to: '2024-02-29',
  });
  assert.deepEqual(periodContaining('month', '2025-02-10'), {
    from: '2025-02-01',
    to: '2025-02-28',
  });
  assert.deepEqual(periodContaining('month', '2025-12-31'), {
    from: '2025-12-01',
    to: '2025-12-31',
  });
  assert.deepEqual(periodContaining('year', '2024-06-01'), {
    from: '2024-01-01',
    to: '2024-12-31',
  });
});

test('compareWith: complete period, previous period, lengths differ, partial period', () => {
  const march = compareWith('month', '2025-03-10', '2025-04-02');
  assert.equal(march.partial, false);
  assert.deepEqual(march.previous, { from: '2025-02-01', to: '2025-02-28' });
  assert.equal(march.currentDays, 31);
  assert.equal(march.previousDays, 28);
  assert.equal(march.lengthsDiffer, true);
  const leap = compareWith('year', '2025-05-05', '2026-01-02');
  assert.equal(leap.previousDays, 366); // 2024 is a leap year
  assert.equal(leap.currentDays, 365);
  assert.equal(leap.lengthsDiffer, true);
  const week = compareWith('week', '2026-03-04', '2026-03-09');
  assert.equal(week.lengthsDiffer, false);
  const partial = compareWith('week', '2026-03-09', '2026-03-11');
  assert.equal(partial.partial, true);
  assert.deepEqual(partial.current, { from: '2026-03-09', to: '2026-03-11' });
  assert.deepEqual(partial.previous, { from: '2026-03-02', to: '2026-03-04' });
  assert.equal(partial.lengthsDiffer, false);
  const yearSoFar = compareWith('year', '2024-03-01', '2024-03-01');
  assert.equal(yearSoFar.currentDays, 61);
  assert.deepEqual(yearSoFar.previous, { from: '2023-01-01', to: '2023-03-02' });
  const future = compareWith('month', '2026-05-01', '2026-03-01');
  assert.equal(future.currentDays, 0);
  assert.equal(future.partial, true);
});

test('latest complete period and the list of recent ones', () => {
  assert.deepEqual(latestCompletePeriod('week', '2026-03-11'), {
    from: '2026-03-02',
    to: '2026-03-08',
  });
  assert.deepEqual(latestCompletePeriod('week', '2026-03-08'), {
    from: '2026-03-02',
    to: '2026-03-08',
  });
  assert.deepEqual(latestCompletePeriod('month', '2026-03-31'), {
    from: '2026-03-01',
    to: '2026-03-31',
  });
  assert.deepEqual(latestCompletePeriod('year', '2026-03-31'), {
    from: '2025-01-01',
    to: '2025-12-31',
  });
  const list = recentPeriods('month', '2026-01-15', 3);
  assert.deepEqual(
    list.map((w) => w.from),
    ['2026-01-01', '2025-12-01', '2025-11-01'],
  );
});

test('figureFor: totals, rates, uncompared when the period before is incomplete', () => {
  const cmp = compareWith('week', '2026-03-04', '2026-03-09');
  const full = timelineMetricsFrom([
    {
      id: 'impressions',
      points: Array.from({ length: 14 }, (_, i) => ({
        date: addDays('2026-02-23', i),
        value: i < 7 ? 10 : 20,
      })),
    },
  ])[0]!;
  const f = figureFor(full, cmp);
  assert.equal(f.value, 140);
  assert.equal(f.previous, 70);
  assert.equal(f.change, 1);
  const late = timelineMetricsFrom([
    {
      id: 'impressions',
      points: Array.from({ length: 7 }, (_, i) => ({ date: addDays('2026-03-02', i), value: 20 })),
    },
  ])[0]!;
  const g = figureFor(late, cmp);
  assert.equal(g.change, null);
  assert.equal(g.uncompared, 'previous_incomplete');
  assert.equal(g.value, 140);
});
