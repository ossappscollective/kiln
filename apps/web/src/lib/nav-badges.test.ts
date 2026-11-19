import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appNavCounts, attentionCount, badgeLabel, badgeText, unansweredCount } from './nav-badges.ts';
import type { ReleaseSummary } from './types.ts';

const release = (status: ReleaseSummary['status']) => ({ status }) as ReleaseSummary;

test('an app needs attention when a sync failed or a release was rejected or halted', () => {
  assert.equal(
    attentionCount([
      { syncFailed: false, attention: null },
      { syncFailed: true, attention: null },
      { syncFailed: false, attention: release('rejected') },
      { syncFailed: false, attention: release('halted') },
      { syncFailed: false, attention: release('in_review') },
      { syncFailed: true, attention: release('rejected') },
    ]),
    4,
  );
  assert.equal(attentionCount([]), 0);
});

test('the unanswered count tolerates a summary without the field', () => {
  assert.equal(unansweredCount({ totals: { total: 5, new: 1, unanswered: 4, lowRating: 0, average: 4 } }), 4);
  assert.equal(unansweredCount({ unanswered: 2 }), 2);
  assert.equal(unansweredCount({ totals: { total: 5, new: 1 } }), null);
  assert.equal(unansweredCount({ totals: { unanswered: '4' } }), null);
  assert.equal(unansweredCount({ totals: { unanswered: -1 } }), null);
  assert.equal(unansweredCount({}), null);
  assert.equal(unansweredCount(null), null);
  assert.equal(unansweredCount(undefined), null);
  assert.equal(unansweredCount('x'), null);
});

test('a badge is drawn for a positive count only', () => {
  assert.equal(badgeText(3), '3');
  assert.equal(badgeText(99), '99');
  assert.equal(badgeText(100), '99+');
  assert.equal(badgeText(0), null);
  assert.equal(badgeText(null), null);
  assert.equal(badgeText(undefined), null);
  assert.equal(badgeText(Number.NaN), null);
});

test('a badge has a name for a screen reader', () => {
  assert.equal(badgeLabel(1, 'app needs attention', 'apps need attention'), '1 app needs attention');
  assert.equal(badgeLabel(4, 'unanswered review', 'unanswered reviews'), '4 unanswered reviews');
  assert.equal(badgeLabel(250, 'unanswered review', 'unanswered reviews'), '99+ unanswered reviews');
  assert.equal(badgeLabel(0, 'a', 'b'), null);
  assert.equal(badgeLabel(null, 'a', 'b'), null);
});

test('the sidebar of one app: unanswered reviews of its records, and releases left unfinished', () => {
  const stalled = [
    { app: { id: 'a' }, stalled: { stale: false } },
    { app: { id: 'b' }, stalled: { stale: true } },
    { app: { id: 'z' }, stalled: { stale: false } },
    { app: { id: 'c' }, stalled: null },
  ];
  assert.deepEqual(appNavCounts({ memberIds: ['a', 'b'], unanswered: { a: 2, b: 3, z: 9 }, stalled }), { reviews: 5, releases: 1 });
  assert.deepEqual(appNavCounts({ memberIds: ['a', 'b'], unanswered: {}, stalled: [] }), { reviews: null, releases: null });
  assert.deepEqual(appNavCounts({ memberIds: ['a'], unanswered: { a: 0 }, stalled }), { reviews: 0, releases: 1 });
});
