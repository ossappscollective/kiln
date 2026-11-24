import assert from 'node:assert/strict';
import { test } from 'node:test';
import { railEntries } from '../section-rail.ts';
import {
  buildOverview,
  chartColumns,
  emptyReason,
  platformShape,
  type PlatformView,
} from './insights-view.ts';
import { insightsGroups } from './sections.ts';
import type { StatChipModel } from './view.ts';

const chip = (id: string, value: string, label = id): StatChipModel => ({
  id,
  label,
  value,
  title: '',
  delta: { kind: 'none' } as never,
  line: '',
  spoken: '',
  tone: 'neutral' as never,
});
const view = (
  platform: string,
  shape: PlatformView['shape'],
  chips: StatChipModel[] = [],
): PlatformView => ({ id: platform, platform, shape, chips });

test('a platform is loading, failed, off, empty or has data', () => {
  assert.equal(platformShape({ statusError: true, enabled: null, stored: false }), 'error');
  assert.equal(platformShape({ statusError: false, enabled: null, stored: false }), 'loading');
  assert.equal(platformShape({ statusError: false, enabled: false, stored: false }), 'off');
  assert.equal(platformShape({ statusError: false, enabled: true, stored: false }), 'empty');
  assert.equal(platformShape({ statusError: false, enabled: false, stored: true }), 'data');
  assert.equal(emptyReason('empty'), 'never');
  assert.equal(emptyReason('off'), 'off');
});

test('no data at all: no figures, one line per platform, loading says so, analytics off is a reason', () => {
  const m = buildOverview([view('ios', 'off'), view('android', 'empty')]);
  assert.equal(m.kpis, 'none');
  assert.deepEqual(
    m.without.map((p) => p.platform),
    ['ios', 'android'],
  );
  assert.equal(m.withData.length, 0);
  assert.equal(m.loading, false);
  assert.equal(buildOverview([view('ios', 'loading')]).loading, true);
  assert.equal(buildOverview([]).kpis, 'none');
});

test('one platform with data: a grid of its figures, the other is one compact line (never an empty column)', () => {
  const m = buildOverview([
    view('ios', 'empty'),
    view('android', 'data', [chip('downloads', '1.2k'), chip('rating', '4.5')]),
  ]);
  assert.equal(m.kpis, 'grid');
  assert.deepEqual(
    m.gridChips.map((c) => c.id),
    ['downloads', 'rating'],
  );
  assert.deepEqual(
    m.without.map((p) => p.platform),
    ['ios'],
  );
  assert.equal(chartColumns(m.withData.length), 1);
});

test('both with data: a comparison, a row per measure in the first platform order, a missing figure is a null cell', () => {
  const m = buildOverview([
    view('ios', 'data', [chip('impressions', '9k'), chip('downloads', '1k')]),
    view('android', 'data', [chip('downloads', '2k'), chip('anr_rate', '0.1%')]),
  ]);
  assert.equal(m.kpis, 'compare');
  assert.deepEqual(
    m.columns.map((c) => c.platform),
    ['ios', 'android'],
  );
  assert.deepEqual(
    m.rows.map((r) => r.id),
    ['impressions', 'downloads', 'anr_rate'],
  );
  assert.deepEqual(
    m.rows[0]?.cells.map((c) => c?.value ?? null),
    ['9k', null],
  );
  assert.deepEqual(
    m.rows[1]?.cells.map((c) => c?.value),
    ['1k', '2k'],
  );
  assert.deepEqual(
    m.rows[2]?.cells.map((c) => c?.value ?? null),
    [null, '0.1%'],
  );
  assert.equal(chartColumns(2), 2);
  assert.equal(m.without.length, 0);
});

test('data without figures for the range says so instead of drawing an empty block', () => {
  const m = buildOverview([view('ios', 'data', [])]);
  assert.equal(m.kpis, 'none');
  assert.equal(m.noNumbers, true);
});

test('a failed platform next to one with data is a line, not a hole', () => {
  const m = buildOverview([
    view('ios', 'error'),
    view('android', 'data', [chip('downloads', '3')]),
  ]);
  assert.equal(m.kpis, 'grid');
  assert.equal(emptyReason(m.without[0]?.shape ?? 'data'), 'error');
});

test('the rail: the numbers sections only exist when something is stored; Data sources and Next steps always can', () => {
  const counts = { acquisition: 1, quality: 1, revenue: 1, failedSources: null };
  const ids = (stored: boolean, next = true) =>
    railEntries(insightsGroups(counts, next, stored)).map((e) => e.id);
  assert.deepEqual(ids(true), ['overview', 'acquisition', 'quality', 'revenue', 'next', 'sources']);
  assert.deepEqual(ids(false), ['overview', 'next', 'sources']);
  assert.deepEqual(ids(false, false), ['overview', 'sources']);
  assert.ok(ids(false, false).length >= 2, 'the rail is drawn only with two or more sections');
});
