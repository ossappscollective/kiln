import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  estimateDifficulty,
  estimateKeyword,
  estimatePopularity,
  KEYWORD_ESTIMATE_MODEL,
  rankRoom,
  type ResultApp,
  termWords,
} from './keyword-estimate.ts';

const apps = (counts: Array<number | null>, name = 'Water reminder app'): ResultApp[] =>
  counts.map((c, i) => ({ id: String(i), name: i % 2 === 0 ? name : 'Other', ratingCount: c }));

test('no signal is no estimate, never 0', () => {
  const p = estimatePopularity('app_store', { term: 'x' });
  assert.equal(p.score, null);
  assert.equal(p.confidence, null);
  assert.equal(p.reasons[0]?.code, 'no_signal');
  assert.equal(estimateDifficulty('app_store', { term: 'x' }).score, null);
  assert.equal(estimateKeyword('app_store', { term: 'x' }).opportunity.score, null);
});

test('the model is versioned', () => {
  assert.equal(estimateKeyword('app_store', { term: 'x' }).model, KEYWORD_ESTIMATE_MODEL);
  assert.equal(KEYWORD_ESTIMATE_MODEL, 'v1');
});

test('hints: first place is high, absent is low, empty is lowest; public signals alone are never high', () => {
  const at = (position: number | null, list: string[]) =>
    estimatePopularity('app_store', { term: 'water', hints: { position, list } });
  const first = at(1, ['water', 'water reminder']);
  assert.equal(first.score, 100);
  assert.equal(first.confidence, 'low');
  assert.equal(first.origin, 'public_signals');
  assert.equal(at(10, new Array(10).fill('x')).score, 40);
  assert.equal(at(null, ['water reminder']).score, 20);
  assert.equal(at(null, []).score, 5);
  assert.equal(at(null, []).reasons[0]?.code, 'hints_empty');
  const both = estimatePopularity('app_store', {
    term: 'water',
    hints: { position: 1, list: ['water'] },
    results: { total: 20, limit: 50, top: apps([1000, 2000, 3000, 4000]) },
  });
  assert.equal(both.confidence, 'medium');
  assert.equal(both.reasons.length, 2);
});

test('own data is the strongest input and makes it "from your data"', () => {
  const p = estimatePopularity('app_store', {
    term: 'water',
    own: { visitors: 1000, installs: 90, days: 30 },
    hints: { position: 2, list: ['a', 'water'] },
    results: { total: 20, limit: 50, top: apps([100, 100, 100]) },
  });
  assert.equal(p.origin, 'own_data');
  assert.equal(p.confidence, 'high');
  assert.equal(p.reasons[0]?.code, 'own_visitors');
  assert.equal(p.reasons[0]?.points, 75);
  const tiny = estimatePopularity('app_store', { term: 'w', own: { visitors: 3, installs: 0, days: 30 }, hints: { position: 1, list: ['w'] } });
  assert.equal(tiny.confidence, 'medium');
});

test('Google Play: only from own data, else no estimate with the reason', () => {
  const none = estimateKeyword('google_play', { term: 'water', hints: { position: 1, list: ['water'] }, results: { total: 9, limit: 9, top: apps([1, 2, 3]) } });
  assert.equal(none.popularity.score, null);
  assert.equal(none.popularity.reasons[0]?.code, 'play_needs_own_data');
  assert.equal(none.difficulty.reasons[0]?.code, 'play_no_competition_data');
  const some = estimatePopularity('google_play', { term: 'water', own: { visitors: 100, installs: 10, days: 28 } });
  assert.equal(some.score, 50);
  assert.equal(some.origin, 'own_data');
  assert.equal(some.confidence, 'medium');
});

test('difficulty: strong apps and title matches raise it, a thin result list needs three rated apps', () => {
  const weak = estimateDifficulty('app_store', { term: 'water reminder', results: { total: 12, limit: 50, top: apps([5, 10, 20, 30]) } });
  const strong = estimateDifficulty('app_store', {
    term: 'water reminder',
    results: { total: 50, limit: 50, top: apps([900000, 800000, 700000, 600000, 500000, 400000, 300000, 200000, 100000, 90000]) },
  });
  assert.ok(weak.score !== null && strong.score !== null && strong.score > weak.score + 30);
  assert.equal(strong.confidence, 'medium');
  assert.equal(weak.confidence, 'low');
  assert.deepEqual(strong.reasons.map((r) => r.code), ['results_strength', 'results_title_match', 'results_crowding']);
  const thin = estimateDifficulty('app_store', { term: 'x', results: { total: 2, limit: 50, top: apps([5, null, 7]) } });
  assert.equal(thin.score, null);
  assert.equal(thin.reasons[0]?.code, 'too_few_results');
  assert.equal(estimateDifficulty('app_store', { term: 'x', results: { total: 0, limit: 50, top: [] } }).reasons[0]?.code, 'results_empty');
});

test('rank volatility joins the difficulty only with enough checks, and never makes it "high"', () => {
  const results = { total: 50, limit: 50, top: apps([1000, 2000, 3000, 4000]) };
  assert.ok(!estimateDifficulty('app_store', { term: 'water', results, ranks: [5, 40, 8] }).reasons.some((r) => r.code === 'rank_volatility'));
  const d = estimateDifficulty('app_store', { term: 'water', results, ranks: [5, 40, null, 8, 30, 3] });
  const v = d.reasons.find((r) => r.code === 'rank_volatility');
  assert.equal(v?.params.checks, 6);
  assert.equal(v?.params.meanMove, 29);
  assert.notEqual(d.confidence, 'high');
});

test('opportunity: popular, easy and poorly ranked wins; a top-3 rank leaves little', () => {
  const base = {
    term: 'water reminder',
    hints: { position: 1, list: ['water reminder'] },
    results: { total: 20, limit: 50, top: apps([10, 20, 30, 40]) },
  };
  const open = estimateKeyword('app_store', { ...base, currentRank: null });
  const held = estimateKeyword('app_store', { ...base, currentRank: 2 });
  assert.ok((open.opportunity.score ?? 0) > (held.opportunity.score ?? 0) * 5);
  assert.equal(open.opportunity.roomFactor, 1);
  assert.equal(held.opportunity.roomFactor, 0.1);
  assert.equal(open.opportunity.confidence, 'low');
  assert.equal(rankRoom(undefined), null);
  assert.equal(rankRoom(25), 0.8);
});

test('termWords splits on spaces and punctuation', () => {
  assert.deepEqual(termWords('Water-Reminder, app'), ['water', 'reminder', 'app']);
});
