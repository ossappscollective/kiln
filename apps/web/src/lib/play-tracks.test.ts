import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareTracks, sortByTrack, trackRank } from './play-tracks.ts';

test('tracks: production, open, closed (alpha, then custom), internal, app sharing', () => {
  const shuffled = [
    'internal',
    'qa-team',
    'alpha',
    'app-sharing',
    'production',
    'beta',
    'closed-b',
  ];
  assert.deepEqual(
    sortByTrack(shuffled, (x) => x),
    ['production', 'beta', 'alpha', 'closed-b', 'qa-team', 'internal', 'app-sharing'],
  );
});

test('a record with no track comes first; names compare without case', () => {
  assert.ok(trackRank(null) < trackRank('production'));
  assert.equal(trackRank('Production'), trackRank('production'));
  assert.ok(compareTracks('Internal', 'beta') > 0);
});

test('equal tracks keep their order', () => {
  const rows = [
    { id: 1, track: 'internal' },
    { id: 2, track: 'production' },
    { id: 3, track: 'internal' },
  ];
  assert.deepEqual(
    sortByTrack(rows, (r) => r.track).map((r) => r.id),
    [2, 1, 3],
  );
});
