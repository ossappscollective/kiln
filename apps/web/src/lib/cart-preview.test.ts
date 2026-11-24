import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  detailKey,
  expandAllOf,
  expansionOf,
  noneExpanded,
  previewOf,
  pruneExpanded,
  toggleAll,
  toggleExpanded,
} from './cart-preview.ts';
import type { CartDetail } from './pending-cart.ts';

const row = (kind: 'listing' | 'graphics' | 'release' | 'price' | 'review_reply', key = 'a|x') => ({
  kind,
  title: 'Description',
  key,
  appId: 'a',
  id: 'x',
  version: 'v1',
});
const base = (kind: CartDetail['kind']): CartDetail => ({ id: 'x', kind, version: 'v1' });
const img = (n: number) => ({
  position: n,
  name: `${n}.png`,
  width: 10,
  height: 20,
  bytes: 5,
  url: `/api/workspaces/w/apps/a/staged/assets/blob?oid=${n}`,
});

test('a listing text shows the store text against the staged one, with the limit', () => {
  const p = previewOf(row('listing'), {
    ...base('listing'),
    text: {
      field: 'description',
      locale: 'en-US',
      before: 'old',
      after: 'new',
      limit: 4000,
      unit: 'characters',
      truncated: false,
    },
  });
  assert.deepEqual(p, {
    kind: 'text',
    before: 'old',
    after: 'new',
    limit: 4000,
    unit: 'characters',
    beforeNote: null,
    truncated: false,
    field: 'description',
    locale: 'en-US',
  });
});

test('a text with no stored store text says "none"; a release field says the store is not read', () => {
  const text = {
    field: 'x',
    locale: null,
    before: null,
    after: 'n',
    limit: null,
    unit: 'characters' as const,
    truncated: false,
  };
  assert.equal(
    (previewOf(row('listing'), { ...base('listing'), text }) as { beforeNote: string }).beforeNote,
    'none',
  );
  assert.equal(
    (previewOf(row('release'), { ...base('release'), text }) as { beforeNote: string }).beforeNote,
    'unknown',
  );
});

test('graphics pair store and staged images by position; no store read means before is unknown', () => {
  const p = previewOf(row('graphics'), {
    ...base('graphics'),
    graphics: { before: [img(1), img(2)], beforeReadAt: 1, after: [img(3)], truncated: false },
  });
  assert.equal(p.kind, 'images');
  if (p.kind !== 'images') return;
  assert.deepEqual(
    p.pairs.map((x) => [x.before !== null, x.after !== null]),
    [
      [true, true],
      [true, false],
    ],
  );
  assert.equal(p.beforeKnown, true);
  const unknown = previewOf(row('graphics'), {
    ...base('graphics'),
    graphics: { before: null, beforeReadAt: null, after: [img(3)], truncated: false },
  });
  assert.equal(unknown.kind === 'images' && unknown.beforeKnown, false);
  assert.equal(unknown.kind === 'images' && unknown.pairs[0]?.before, null);
});

test('a price row keeps its own table; a reply shows the draft and the review; no detail shows nothing', () => {
  assert.deepEqual(previewOf(row('price'), null), { kind: 'price' });
  const reply = {
    text: 'Thanks',
    truncated: false,
    review: { rating: 1, title: 't', body: 'b', language: null, territory: null, truncated: false },
  };
  const p = previewOf(row('review_reply'), { ...base('review_reply'), reply });
  assert.equal(p.kind === 'reply' && p.review.body, 'b');
  assert.deepEqual(previewOf(row('listing'), null), { kind: 'none' });
  assert.deepEqual(previewOf(row('listing'), base('listing')), { kind: 'none' });
});

test('expand state: collapsed by default, toggle, expand all / collapse all, prune', () => {
  const rows = [row('listing', 'a|1'), row('graphics', 'a|2')];
  assert.equal(expansionOf(noneExpanded, rows), 'none');
  const one = toggleExpanded(noneExpanded, 'a|1');
  assert.equal(expansionOf(one, rows), 'some');
  assert.equal(expansionOf(toggleAll(one, rows), rows), 'all');
  assert.equal(expansionOf(toggleAll(expandAllOf(rows), rows), rows), 'none');
  assert.equal(toggleExpanded(one, 'a|1').size, 0);
  assert.deepEqual([...pruneExpanded(expandAllOf(rows), [rows[1]!])], ['a|2']);
  assert.equal(pruneExpanded(one, rows), one);
  assert.equal(detailKey(row('listing')), 'a|x|v1');
});
