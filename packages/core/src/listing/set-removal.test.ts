import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  afterRemoval,
  failedRemovals,
  type RemovalResult,
  setNeedsAnImage,
  summarizeRemoval,
} from './set-removal.ts';

const result = (index: number, outcome: RemovalResult['outcome']): RemovalResult => ({
  index,
  id: { position: index + 1 },
  outcome,
  ...(outcome === 'not_found' ? { reason: 'unknown_file' as const } : {}),
});

test('the summary counts each outcome once', () => {
  const results = [
    result(0, 'removed'),
    result(1, 'removed'),
    result(2, 'already_removed'),
    result(3, 'not_found'),
  ];
  assert.deepEqual(summarizeRemoval(results), { removed: 2, alreadyRemoved: 1, notFound: 1 });
  assert.deepEqual(summarizeRemoval([]), { removed: 0, alreadyRemoved: 0, notFound: 0 });
  assert.deepEqual(
    failedRemovals(results).map((r) => r.index),
    [3],
    'an already removed file is not a failure',
  );
});

test('what is left after taking files out, and when the set is emptied', () => {
  assert.deepEqual(afterRemoval(5, 2), { remaining: 3, empties: false });
  assert.deepEqual(afterRemoval(3, 3), { remaining: 0, empties: true });
  assert.deepEqual(afterRemoval(3, 9), { remaining: 0, empties: true });
  assert.deepEqual(afterRemoval(0, 0), { remaining: 0, empties: false });
  assert.deepEqual(afterRemoval(3, -1), { remaining: 3, empties: false });
});

test('the App Store needs an image in the largest iPhone and iPad sizes, not in the legacy ones', () => {
  const shot = (device: string | null) => ({ kind: 'screenshot' as const, device });
  assert.equal(setNeedsAnImage('app_store', shot('iphone_6_9')), true);
  assert.equal(setNeedsAnImage('app_store', shot('ipad_13')), true);
  assert.equal(setNeedsAnImage('app_store', shot('iphone_5_5')), false);
  assert.equal(setNeedsAnImage('app_store', shot('iphone_6_5')), false);
  assert.equal(setNeedsAnImage('app_store', shot('ipad_11')), false);
  assert.equal(setNeedsAnImage('app_store', shot(null)), false);
  assert.equal(setNeedsAnImage('app_store', { kind: 'preview', device: 'iphone_6_9' }), false);
  assert.equal(setNeedsAnImage('google_play', shot('phone')), true);
  assert.equal(setNeedsAnImage('google_play', shot('tablet_10')), false);
});
