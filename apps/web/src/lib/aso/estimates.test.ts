import assert from 'node:assert/strict';
import { test } from 'node:test';
import { t } from '../i18n/t.ts';
import {
  confidenceDots,
  type EstimateMeasure,
  type EstimateRow,
  filterEstimates,
  reasonKey,
  reasonShares,
  sortEstimates,
  trendPath,
} from './estimates.ts';

const measure = (score: number | null, over: Partial<EstimateMeasure> = {}): EstimateMeasure => ({
  score,
  confidence: score === null ? null : 'medium',
  origin: score === null ? null : 'public_signals',
  reasons: [],
  ...over,
});
const row = (
  term: string,
  pop: number | null,
  diff: number | null,
  opp: number | null,
  origin: 'own_data' | 'public_signals' | null = null,
): EstimateRow => ({
  keywordId: term,
  term,
  country: 'us',
  locale: 'en-US',
  platform: 'ios',
  appId: 'a',
  estimate: {
    model: 'v1',
    popularity: measure(pop, origin ? { origin } : {}),
    difficulty: measure(diff),
    opportunity: { score: opp, confidence: opp === null ? null : 'low', roomFactor: 1 },
    signalsAt: null,
    hints: [],
    top: [],
  },
});

test('sorting: opportunity and popularity high first, difficulty easiest first, no estimate always last', () => {
  const rows = [row('c', null, null, null), row('a', 80, 70, 24), row('b', 50, 10, 45)];
  assert.deepEqual(
    sortEstimates(rows, 'opportunity').map((r) => r.term),
    ['b', 'a', 'c'],
  );
  assert.deepEqual(
    sortEstimates(rows, 'popularity').map((r) => r.term),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(
    sortEstimates(rows, 'difficulty').map((r) => r.term),
    ['b', 'a', 'c'],
  );
  assert.deepEqual(
    sortEstimates(rows, 'term').map((r) => r.term),
    ['a', 'b', 'c'],
  );
});

test('filtering by text, by having an estimate, by own data', () => {
  const rows = [
    row('water', 50, 10, 45),
    row('tea', null, null, null),
    row('milk', 60, null, null, 'own_data'),
  ];
  assert.deepEqual(
    filterEstimates(rows, 'WAT', 'all').map((r) => r.term),
    ['water'],
  );
  assert.deepEqual(
    filterEstimates(rows, '', 'estimated').map((r) => r.term),
    ['water', 'milk'],
  );
  assert.deepEqual(
    filterEstimates(rows, '', 'none').map((r) => r.term),
    ['tea'],
  );
  assert.deepEqual(
    filterEstimates(rows, '', 'own').map((r) => r.term),
    ['milk'],
  );
});

test('confidence dots, reason keys (every server code has an English sentence) and shares', () => {
  assert.deepEqual(
    ['low', 'medium', 'high', null].map((c) => confidenceDots(c as 'low' | null)),
    [1, 2, 3, 0],
  );
  for (const code of [
    'hints_position',
    'hints_absent',
    'hints_empty',
    'results_demand',
    'own_visitors',
    'results_strength',
    'results_title_match',
    'results_crowding',
    'rank_volatility',
    'no_signal',
    'play_needs_own_data',
    'play_no_competition_data',
    'results_empty',
    'too_few_results',
  ]) {
    assert.notEqual(t(reasonKey(code), { position: 1, size: 3 }), reasonKey(code), code);
  }
  assert.equal(reasonKey('future_code'), 'aso:est.reason.unknown');
  const m = measure(50, {
    reasons: [
      { code: 'a', params: {}, points: 10, weight: 3 },
      { code: 'b', params: {}, points: 90, weight: 1 },
      { code: 'c', params: {}, points: null, weight: 0 },
    ],
  });
  assert.deepEqual(reasonShares(m), [75, 25, 0]);
});

test('trend path breaks at a missing day and keeps 0 at the bottom', () => {
  assert.deepEqual(trendPath([0, 100, null, 50], 30, 10), {
    path: 'M0.0 10.0L10.0 0.0M30.0 5.0',
    samples: 3,
  });
  assert.deepEqual(trendPath([], 30, 10), { path: '', samples: 0 });
  assert.equal(trendPath([40], 30, 10).path, 'M15.0 6.0');
});
