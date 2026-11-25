import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  changeImageRef,
  changeSentence,
  changesStatus,
  competitorImageUrl,
  oldestOf,
  type ScreenshotsChange,
  searchImageUrl,
  shotAlt,
  stripOf,
} from './competitor-changes.ts';

const shot = (id: string, size = '392x696bb.jpg') =>
  `https://is1-ssl.mzstatic.com/image/thumb/P/v4/${id}/${id}.png/${size}`;
const change: ScreenshotsChange = {
  kind: 'screenshots',
  device: 'iphone',
  added: 0,
  removed: 0,
  replaced: 1,
  reordered: false,
  before: [shot('a'), shot('b'), shot('c')],
  after: [shot('a', '1242x2688bb.webp'), shot('z'), shot('c')],
};

test('image urls carry a ref, never an address, and the ref grammar of the server', () => {
  assert.equal(
    competitorImageUrl('w 1', 'a/1', 'c1', 's.p.3', 160),
    '/api/workspaces/w%201/apps/a%2F1/aso/competitors/c1/image?ref=s.p.3&size=160',
  );
  assert.equal(
    searchImageUrl('w', 'a', 'abc', 96),
    '/api/workspaces/w/apps/a/aso/competitors/search-image?ref=abc&size=96',
  );
  assert.equal(changeImageRef('id1', 'before', 'p', 2), 'c.id1.b.p.2');
});

test('strips mark what was removed and what is new, by image identity (a re-encode is the same image)', () => {
  const before = stripOf('x1', change, 'before');
  const after = stripOf('x1', change, 'after');
  assert.deepEqual(
    before.map((i) => i.status),
    ['kept', 'removed', 'kept'],
  );
  assert.deepEqual(
    after.map((i) => i.status),
    ['kept', 'new', 'kept'],
  );
  assert.equal(before[1]?.ref, 'c.x1.b.p.1');
  assert.equal(
    shotAlt(before[0] as never, 'before', 'iphone'),
    'Screenshot 1 of 3, before (iPhone)',
  );
  assert.match(
    shotAlt(before[1] as never, 'before', 'iphone'),
    /Screenshot 2 of 3, before \(iPhone\), removed/,
  );
});

test('sentences say what changed in words', () => {
  assert.equal(changeSentence(change), 'iPhone screenshots: 1 replaced');
  assert.equal(
    changeSentence({ ...change, replaced: 0, added: 2, removed: 1, reordered: true }),
    'iPhone screenshots: 2 added, 1 removed, and reordered',
  );
  assert.equal(
    changeSentence({ kind: 'price', before: 'Free', after: '$1.99' }),
    'Price: Free to $1.99',
  );
  assert.equal(
    changeSentence({ kind: 'rating', before: 4500, after: 4300 }),
    'Average rating: 4.5 to 4.3 stars',
  );
});

test('the status line is honest that history starts when following began', () => {
  const base = {
    watching: { state: 'watched' as const, since: 1_000_000 },
    lastCheckedAt: null as number | null,
    changes: [],
  };
  assert.deepEqual(
    changesStatus({ ...base, watching: { state: 'not_watched', reason: 'play_pages_not_read' } }),
    { kind: 'notWatched' },
  );
  assert.deepEqual(changesStatus(base), { kind: 'notChecked' });
  assert.deepEqual(changesStatus({ ...base, lastCheckedAt: 1_000_500 }), {
    kind: 'firstOnly',
    since: 1_000_000,
  });
  assert.deepEqual(changesStatus({ ...base, lastCheckedAt: 9_000_000 }), {
    kind: 'none',
    since: 1_000_000,
    checkedAt: 9_000_000,
  });
  const row = { id: 'r', competitorId: 'c', detectedAt: 5, kinds: ['icon'], changes: [] };
  assert.equal(changesStatus({ ...base, lastCheckedAt: 9_000_000, changes: [row] }).kind, 'list');
  assert.equal(oldestOf([row, { ...row, detectedAt: 3 }]), 3);
  assert.equal(oldestOf([]), undefined);
});
