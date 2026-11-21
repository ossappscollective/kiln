import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, buildRankVsDownloads, dateToDay } from '@kiln/core';
import {
  chartName,
  dayIndexAt,
  delayLine,
  downloadsName,
  downloadsPanel,
  gateOf,
  MAX_DRAWN,
  markerText,
  queryText,
  type RankVsDownloadsResponse,
  rankPanel,
  tipFor,
  toggleKeyword,
  whatChanged,
  whatChangedList,
} from './rank-downloads.ts';

const TODAY = '2026-11-19';
const day = (ago: number) => addDays(TODAY, -ago);
const noon = (d: string) => Date.parse(`${d}T12:00:00Z`);

/** A view as the server answers it: 40 days, one keyword that went from 30 to 5 on day(19), downloads 10 then 20 a day. */
function view(
  over: {
    rank?: (ago: number) => number | null;
    skipChecks?: (ago: number) => boolean;
    downloads?: boolean;
    analytics?: boolean;
    first?: number;
  } = {},
): RankVsDownloadsResponse {
  const first = over.first ?? 40;
  const rank = over.rank ?? ((ago) => (ago >= 20 ? 30 : 5));
  const checks: { checkedAt: number; rank: number | null; total: number }[] = [];
  for (let ago = first; ago >= 1; ago--)
    if (!over.skipChecks?.(ago))
      checks.push({ checkedAt: noon(day(ago)), rank: rank(ago), total: 50 });
  const points = [];
  for (let ago = first; ago >= 1; ago--) points.push({ day: day(ago), value: ago >= 19 ? 10 : 20 });
  const built = buildRankVsDownloads({
    from: day(first),
    to: day(1),
    today: TODAY,
    keywords: [{ id: 'k1', term: 'coffee timer', checks }],
    downloads:
      over.downloads === false
        ? null
        : { metric: 'installs_user', label: 'User installs', source: 'play', delayDays: 7, points },
    threshold: 5,
    analyticsEnabled: over.analytics ?? true,
  });
  return {
    ...built,
    appId: 'a1',
    platform: 'android',
    country: 'us',
    countries: ['us'],
    available: [
      {
        id: 'k1',
        term: 'coffee timer',
        locale: 'en-US',
        priority: 2,
        checks: checks.length,
        lastCheckedAt: null,
      },
    ],
    selected: ['k1'],
  };
}

const box = { width: 400, height: 150, left: 44, right: 14, top: 12, bottom: 8 };

test('the query is built from what is set', () => {
  assert.equal(queryText({}), '');
  assert.equal(
    queryText({ country: 'us', keywords: ['a', 'b'], from: '2026-10-01', to: '2026-10-31' }),
    '?country=us&keywords=a,b&from=2026-10-01&to=2026-10-31',
  );
});

test('ticking a keyword adds it, ticking it again removes it, a fourth drops the oldest', () => {
  assert.deepEqual(toggleKeyword([], 'a'), ['a']);
  assert.deepEqual(toggleKeyword(['a', 'b'], 'a'), ['b']);
  assert.deepEqual(toggleKeyword(['a', 'b', 'c'], 'd'), ['b', 'c', 'd']);
  assert.equal(MAX_DRAWN, 3);
});

test('the view draws only with enough days of both series, and says plainly what is missing', () => {
  assert.deepEqual(gateOf(view()), { kind: 'chart' });
  const off = gateOf(view({ downloads: false, analytics: false }));
  assert.deepEqual(
    [off.kind, off.kind === 'missing' && off.text, off.kind === 'missing' && off.action],
    ['missing', 'Turn on Analytics to see downloads.', 'analytics'],
  );
  const none = gateOf(view({ downloads: false }));
  assert.match(none.kind === 'missing' ? none.text : '', /No download numbers are stored/);
  const noRank = gateOf(view({ skipChecks: () => true }));
  assert.match(noRank.kind === 'missing' ? noRank.text : '', /No rank checks/);
  const short = gateOf(view({ first: 9 }));
  assert.equal(short.kind, 'too_few');
  assert.match(
    short.kind === 'too_few' ? short.text : '',
    /at least 14 days of both\. .*9 days with a rank and 9 with downloads/,
  );
  const nothing = view();
  assert.equal(gateOf({ ...nothing, available: [], selected: [] }).kind, 'missing');
  assert.equal(gateOf({ ...nothing, selected: [] }).kind, 'missing');
});

test('the rank axis is inverted: rank 1 is at the top, a worse rank is lower', () => {
  const v = view();
  const geo = rankPanel(v, box);
  assert.equal(geo.top, 1);
  assert.ok(geo.y(1) < geo.y(5));
  assert.ok(geo.y(5) < geo.y(30));
  assert.equal(geo.y(1), box.top);
  const line = geo.lines[0];
  assert.equal(line?.runs.length, 1);
  const first = line?.runs[0]?.points[0];
  const last = line?.runs[0]?.points[line.runs[0].points.length - 1];
  assert.ok((first?.y ?? 0) > (last?.y ?? 0), 'the rank improved, so the line ends higher');
  assert.equal(geo.ticks[0]?.value, 1);
});

test('no check is a gap in the line, not a zero or a "not ranked"', () => {
  const v = view({ skipChecks: (ago) => ago >= 25 && ago <= 28 });
  const line = rankPanel(v, box).lines[0];
  assert.equal(line?.runs.length, 2);
  const gapDays = v.keywords[0]?.samples.filter((s) => s === null).length;
  assert.equal(gapDays, 4);
});

test('a keyword outside the results sits at the bottom and the axis says N+', () => {
  const v = view({ rank: (ago) => (ago >= 20 ? null : 5) });
  const geo = rankPanel(v, box);
  assert.equal(geo.ticks[geo.ticks.length - 1]?.label, '50+');
  const first = geo.lines[0]?.runs[0]?.points[0];
  assert.equal(first?.y, Math.round(geo.y(geo.bottom) * 10) / 10);
});

test('the big move is marked at the day of the later check, pointing up for a better rank', () => {
  const v = view();
  const geo = rankPanel(v, box);
  assert.equal(geo.markers.length, 1);
  const m = geo.markers[0];
  assert.deepEqual([m?.direction, m?.day], ['better', day(19)]);
  assert.equal(m?.i, v.days.indexOf(day(19)));
  assert.match(m?.text ?? '', /coffee timer: 30 to 5 on /);
  const worse = rankPanel(view({ rank: (ago) => (ago >= 20 ? 5 : 30) }), box);
  assert.equal(worse.markers[0]?.direction, 'worse');
});

test('the downloads panel shades the days the store may still change and hatches missing days', () => {
  const v = view();
  const geo = downloadsPanel(v, { ...box, height: 130, bottom: 24 });
  assert.ok(geo);
  assert.equal(geo?.bars.length, 40);
  assert.ok(geo?.provisional, 'the days after the settled day are provisional');
  assert.equal(
    geo?.provisional?.from,
    v.days.length - 6,
    'settled through 7 days ago, so the shade starts the day after',
  );
  assert.equal(v.days[geo?.provisional?.from ?? 0], day(6));
  assert.equal(downloadsPanel(view({ downloads: false }), box), null);
});

test('a position is the day under it, and nothing outside the plot', () => {
  const geo = rankPanel(view(), box);
  assert.equal(dayIndexAt(geo, geo.box.left - 1), null);
  assert.equal(dayIndexAt(geo, geo.box.left + 0.1), 0);
  assert.equal(dayIndexAt(geo, geo.box.left + geo.slot * geo.count - 0.1), geo.count - 1);
  assert.equal(dayIndexAt(geo, geo.box.left + geo.slot * geo.count + 5), null);
});

test('the tooltip of a day lists the rank or "No check", and the downloads or "No number"', () => {
  const v = view({ skipChecks: (ago) => ago === 30 });
  const i = v.days.indexOf(day(30));
  const gap = tipFor(v, i);
  assert.equal(gap?.ranks[0]?.text, 'No check');
  assert.equal(gap?.downloads, '10');
  assert.equal(gap?.provisional, false);
  const recent = tipFor(v, v.days.length - 1);
  assert.equal(recent?.provisional, true);
  assert.equal(recent?.ranks[0]?.text, 'Rank 5');
  assert.equal(tipFor(v, 999), null);
  const out = tipFor(view({ rank: () => null }), 3);
  assert.equal(out?.ranks[0]?.text, 'Not in the first 50');
});

test('what changed always says correlation, not proof, and the days compared; no causal words', () => {
  const v = view();
  const list = whatChangedList(v);
  assert.equal(list.length, 1);
  const c = list[0];
  assert.equal(c?.status, 'ok');
  assert.match(c?.head ?? '', /^coffee timer moved from 30 to 5 on /);
  assert.match(
    c?.detail ?? '',
    /Downloads per day: 10 in the 7 days before, 20 in the 7 days after \(\+100%\)\./,
  );
  assert.equal(c?.label, 'Correlation, not proof. Compared 7 days before with 7 days after.');
  assert.equal(c?.percent, 100);
  for (const word of [
    'caused',
    'because',
    'due to',
    'led to',
    'result of',
    'drove',
    'boosted',
    'thanks to',
  ]) {
    assert.ok(!`${c?.head} ${c?.detail} ${c?.label}`.toLowerCase().includes(word), word);
  }
});

test('a move whose days after are not settled waits and says so, still labelled', () => {
  const v = view({ rank: (ago) => (ago >= 5 ? 30 : 4) });
  const c = whatChangedList(v)[0];
  assert.equal(c?.status, 'waiting');
  assert.match(c?.detail ?? '', /not settled yet/);
  assert.match(c?.label ?? '', /^Correlation, not proof\./);
  assert.equal(c?.percent, null);
});

test('too few days with a number is said with the counts; an overlap and a check gap are said', () => {
  const base = whatChangedList(view())[0];
  assert.equal(base?.overlap, null);
  assert.equal(base?.gap, null);
  const v = view();
  const comparison = v.comparisons[0];
  if (!comparison) throw new Error('no comparison');
  const few = whatChanged(
    {
      ...comparison,
      status: 'too_few_days',
      before: { ...comparison.before, days: 3 },
      after: { ...comparison.after, days: 7 },
      changePercent: null,
      overlapsOtherMove: true,
      checkGapDays: 3,
    },
    'coffee timer',
  );
  assert.match(few.detail, /Not enough days with a download number: 3 before and 7 after/);
  assert.match(few.label, /Correlation, not proof\. 3 days before and 7 days after/);
  assert.match(few.overlap ?? '', /Another rank move/);
  assert.match(few.gap ?? '', /3 days apart/);
});

test('the words about delays, the downloads name and the chart name', () => {
  const play = view();
  assert.match(delayLine(play) ?? '', /Play files reach this server 3 to 7 days late/);
  assert.match(
    delayLine(play) ?? '',
    new RegExp(`through .*${dateToDay(Date.parse(`${day(7)}T00:00:00Z`)).slice(0, 4)}`),
  );
  assert.equal(downloadsName(play), 'User installs, from Google Play');
  assert.equal(downloadsName({ downloads: null }), 'Downloads');
  assert.equal(delayLine({ downloads: null }), null);
  assert.match(
    chartName(play),
    /^Rank of coffee timer \(rank 1 at the top\) above user installs per day/,
  );
  const apple = {
    ...play,
    downloads: play.downloads
      ? { ...play.downloads, source: 'apple' as const, delayDays: 2 }
      : null,
  };
  assert.match(delayLine(apple) ?? '', /Apple reports downloads about 2 days late/);
  assert.match(
    markerText(
      {
        keywordId: 'k',
        day: day(3),
        previousDay: day(4),
        kind: 'dropped',
        from: 4,
        to: null,
        delta: null,
      },
      'x',
    ),
    /x: left the results \(was 4\)/,
  );
});
