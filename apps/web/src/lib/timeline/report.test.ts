import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareWith, type ReportFigure } from '@kiln/core';
import {
  CSV_HEADER,
  type ReportApi,
  csvCell,
  dataNotes,
  figureRow,
  periodNav,
  periodTitle,
  reportCsv,
  reportDayOf,
  reportFileName,
  reportIsEmpty,
  reportKindOf,
  reportMarkdown,
  reviewsRow,
  withReport,
} from './report.ts';

const fig = (over: Partial<ReportFigure>): ReportFigure => ({
  id: 'downloads_first_time', metric: 'downloads_first_time', currency: null, kind: 'count', value: 1200, previous: 1000, change: 0.2, uncompared: null, days: 7, previousDays: 7, ...over,
});
const base = (over: Partial<ReportApi> = {}): ReportApi => ({
  app: { id: 'a1', name: 'Kiln | Demo', platform: 'ios', store: 'app_store' },
  kind: 'week',
  through: '2026-11-22',
  comparison: compareWith('week', '2026-11-09', '2026-11-22'),
  figures: [fig({}), fig({ id: 'download_rate', metric: 'download_rate', kind: 'ratio', value: 0.031, previous: 0.03, change: 0.0333 })],
  countries: [{ code: 'US', value: 700, share: 0.58, change: 0.1 }],
  sources: [{ source: 'App Store search', seen: 9000, pageViews: 3000, downloads: 800 }],
  reviews: { current: { count: 40, average: 4.4, lowUnanswered: 2 }, previous: { count: 35, average: 4.2, lowUnanswered: 0 } },
  events: [{ id: 'm:1', day: '2026-11-10', kind: 'press', origin: 'manual', label: null, title: '=cmd|"x"\nline', note: null, version: null, liveDay: null, waitsForRelease: false }],
  missingDays: 0,
  downloadMetric: 'downloads_first_time',
  ...over,
});

test('figures: counts, rates and a change with its direction; no change reads as words, never as zero', () => {
  const up = figureRow(fig({}));
  assert.equal(up.value, '1,200');
  assert.equal(up.change, '+20%');
  assert.equal(up.direction, 'up');
  const down = figureRow(fig({ change: -0.052, value: 948 }));
  assert.equal(down.change, '-5.2%');
  assert.equal(down.direction, 'down');
  const rate = figureRow(fig({ id: 'download_rate', metric: 'download_rate', kind: 'ratio', value: 0.031, change: null, uncompared: 'previous_incomplete' }));
  assert.equal(rate.value, '3.1%');
  assert.equal(rate.change, null);
  assert.match(rate.note ?? '', /Not compared/);
  const none = figureRow(fig({ value: null, previous: null, change: null, uncompared: 'no_data' }));
  assert.equal(none.value, 'no data');
  assert.equal(figureRow(fig({ id: 'sales_proceeds:EUR', metric: 'sales_proceeds', currency: 'EUR', kind: 'level', value: 12.5, previous: 10 })).label, 'Proceeds (EUR)');
});

test('reviews: nothing on either side is no row; a small count is flagged; the delta needs both averages', () => {
  assert.equal(reviewsRow({ current: { count: 0, average: null, lowUnanswered: 0 }, previous: { count: 0, average: null, lowUnanswered: 0 } }), null);
  const row = reviewsRow(base().reviews);
  assert.equal(row?.delta, '+0.2');
  assert.equal(row?.lowSample, false);
  const small = reviewsRow({ current: { count: 3, average: 5, lowUnanswered: 0 }, previous: { count: 0, average: null, lowUnanswered: 0 } });
  assert.equal(small?.lowSample, true);
  assert.equal(small?.delta, null);
});

test('data notes: a running period, missing days, a store without sources, a period that has not started', () => {
  assert.deepEqual(dataNotes(base()).map((n) => n.id), []);
  const running = base({ comparison: compareWith('week', '2026-11-16', '2026-11-18'), missingDays: 1 });
  const ids = dataNotes(running).map((n) => n.id);
  assert.ok(ids.includes('partial') && ids.includes('missing'));
  assert.ok(dataNotes(base({ app: { id: 'a2', name: 'D', platform: 'android', store: 'google_play' }, sources: [] })).some((n) => n.id === 'noSources'));
  assert.deepEqual(dataNotes(base({ comparison: compareWith('week', '2026-12-07', '2026-11-22'), figures: [] })).map((n) => n.id), ['notStarted']);
  const none = base({ figures: [], countries: [], sources: [], events: [], reviews: { current: { count: 0, average: null, lowUnanswered: 0 }, previous: { count: 0, average: null, lowUnanswered: 0 } } });
  assert.equal(reportIsEmpty(none), true);
  assert.ok(dataNotes(none).some((n) => n.id === 'noFigures'));
  assert.ok(dataNotes(base({ figures: [fig({ change: null, uncompared: 'previous_incomplete' })] })).some((n) => n.id === 'uncompared'));
  assert.equal(reportIsEmpty(base()), false);
});

test('period navigation: earlier is always possible, later only while it has started', () => {
  const v = base();
  const nav = periodNav('week', v.comparison, v.through);
  assert.equal(nav.prev, '2026-11-02');
  assert.equal(nav.next, '2026-11-16');
  assert.equal(periodNav('week', compareWith('week', '2026-11-16', '2026-11-22'), '2026-11-22').next, null);
  assert.equal(periodTitle('month', { from: '2026-11-01', to: '2026-11-30' }), 'Nov 2026');
  assert.equal(periodTitle('year', { from: '2026-01-01', to: '2026-12-31' }), '2026');
});

test('addresses: unknown values fall back to a week of the newest finished period', () => {
  assert.equal(reportKindOf('#/portfolio/a1/insights?view=timeline&section=reports&report=month'), 'month');
  assert.equal(reportKindOf('#/portfolio/a1/insights?report=decade'), 'week');
  assert.equal(reportDayOf('#/x?on=2026-11-09'), '2026-11-09');
  assert.equal(reportDayOf('#/x?on=yesterday'), null);
  assert.equal(withReport('#/portfolio/a1/insights?platform=ios', { kind: 'month', on: '2026-10-01' }), '#/portfolio/a1/insights?platform=ios&view=timeline&section=reports&report=month&on=2026-10-01');
  assert.equal(withReport('#/p?report=month&on=2026-10-01&section=reports&view=timeline', { kind: 'week', on: null }), '#/p?section=reports&view=timeline');
});

test('Markdown: a table of figures, cells that cannot break it, the events and the notes', () => {
  const md = reportMarkdown([base()], (p) => (p === 'ios' ? 'iOS' : 'Android'));
  assert.match(md, /^# Report: Nov 9 to Nov 15, 2026/);
  assert.match(md, /## Kiln \| Demo \(iOS\)/);
  assert.match(md, /\| Figure \| This period \| Before \| Change \|/);
  assert.match(md, /\| Downloads \(first time\) \| 1,200 \| 1,000 \| \+20% \|/);
  assert.match(md, /### Events of the period/);
  assert.equal(md.split('\n').filter((l) => l.indexOf('=cmd') >= 0).length, 1, 'a line break in a title stays on one line');
  assert.equal(reportMarkdown([], () => ''), '');
});

test('CSV: raw numbers, ISO days, formulas defused, quotes escaped, BOM and CRLF', () => {
  const csv = reportCsv([base()]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[0], CSV_HEADER.join(','));
  assert.ok(lines.includes('"Kiln | Demo",ios,figure,downloads_first_time,,2026-11-09,2026-11-15,1200,1000,20,'.replace('"Kiln | Demo"', 'Kiln | Demo')));
  assert.ok(lines.some((l) => l.indexOf(',reviews_average,') > 0 && l.indexOf(',4.4,4.2,') > 0));
  assert.ok(lines.some((l) => l.indexOf(',countries,US,') > 0));
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(csvCell('-1+1'), "'-1+1");
  assert.equal(csvCell('a "b", c'), '"a ""b"", c"');
  assert.equal(csvCell(-5), '-5');
  assert.equal(csvCell(null), '');
  assert.equal(reportFileName([base()]), 'kiln-report-kiln-demo-2026-11-09_2026-11-15.csv');
  assert.equal(reportFileName([]), 'kiln-report.csv');
  // A period with no figures is a header only, not a crash.
  assert.equal(reportCsv([base({ figures: [], countries: [], sources: [], reviews: { current: { count: 0, average: null, lowUnanswered: 0 }, previous: { count: 0, average: null, lowUnanswered: 0 } } })]).split('\r\n').length, 2);
});
