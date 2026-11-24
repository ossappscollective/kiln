import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CartRow } from './pending-cart.ts';
import {
  FIRST_ROWS,
  type PendingItemDetail,
  cartIdsOf,
  detailView,
  isDetailKind,
  itemDetailKey,
  itemKey,
  needsCart,
  planOf,
  thumbsOf,
} from './pending-preview.ts';
import type { PendingItem } from './pending.ts';

const item = (
  kind: PendingItem['kind'],
  id: string,
  over: Partial<PendingItem> = {},
): PendingItem => ({
  kind,
  platform: 'ios',
  id,
  label: id,
  state: 'staged',
  problems: [],
  nextStep: 'push_draft',
  counts: {},
  refs: [],
  truncated: false,
  since: 5,
  ...over,
});
const cartRow = (id: string, over: Partial<CartRow> = {}): CartRow =>
  ({
    id,
    kind: id.split(':')[0],
    appId: 'a',
    key: `a|${id}`,
    title: 't',
    thumbs: [],
    counts: {},
    version: 'v',
    ...over,
  }) as unknown as CartRow;

test('staged items are made of cart items by id; every other kind has none', () => {
  const texts = item('listing_text', 'listing_text', { refs: [{ id: 'r1' }, { id: 'r2' }] });
  assert.deepEqual(cartIdsOf(texts), ['listing:r1', 'listing:r2']);
  assert.deepEqual(cartIdsOf(item('asset_set', 's1')), ['graphics:s1']);
  assert.deepEqual(cartIdsOf(item('release_field', 'f1')), ['release:f1']);
  for (const k of [
    'pushed_draft',
    'draft_release',
    'in_review',
    'approved',
    'rollout_step',
  ] as const) {
    assert.deepEqual(cartIdsOf(item(k, 'x')), []);
    assert.equal(isDetailKind(k), true);
    assert.equal(needsCart(item(k, 'x')), false);
  }
  assert.equal(needsCart(texts), true);
});

test('the plan: staged items join the cart rows, say what is missing, and wait for the cart; others read the detail', () => {
  const texts = item('listing_text', 'listing_text', { refs: [{ id: 'r1' }, { id: 'r2' }] });
  const rows = [cartRow('listing:r1'), cartRow('graphics:s1')];
  const p = planOf(texts, rows);
  assert.equal(p.source === 'cart' && p.rows.length, 1);
  assert.equal(p.source === 'cart' && p.missing, 1);
  assert.deepEqual(planOf(texts, null), { source: 'cart', rows: [], missing: 2, loaded: false });
  assert.equal(
    (planOf(item('asset_set', 's1'), rows) as { rows: CartRow[] }).rows[0]?.id,
    'graphics:s1',
  );
  assert.deepEqual(planOf(item('pushed_draft', 'pushed_draft'), null), {
    source: 'detail',
    kind: 'pushed_draft',
  });
  assert.deepEqual(planOf({ kind: 'mystery' as PendingItem['kind'], id: 'x', refs: [] }, rows), {
    source: 'none',
  });
  assert.ok(FIRST_ROWS > 0);
});

test('a graphics row shows the thumbnails of its cart item inline; nothing for another kind or an unread cart', () => {
  const rows = [cartRow('graphics:s1', { thumbs: ['/a', '/b'], counts: { files: 2, before: 3 } })];
  assert.deepEqual(thumbsOf(item('asset_set', 's1'), rows), { thumbs: ['/a', '/b'], before: 3 });
  assert.deepEqual(thumbsOf(item('asset_set', 's2'), rows), { thumbs: [], before: null });
  assert.deepEqual(thumbsOf(item('asset_set', 's1'), null), { thumbs: [], before: null });
  assert.deepEqual(thumbsOf(item('listing_text', 'listing_text'), rows), {
    thumbs: [],
    before: null,
  });
});

test('what each non-staged kind expands to: its contents, then what happens next', () => {
  const pushed = detailView({
    kind: 'pushed_draft',
    id: 'pushed_draft',
    pushedDraft: {
      versionString: '2.1',
      pushedAt: 1700000000000,
      texts: [{ locale: 'en-US', field: 'description' }],
      sets: [
        {
          locale: 'de-DE',
          key: 'screenshot:iphone_6_5',
          kind: 'screenshot',
          device: 'iphone_6_5',
          files: 3,
        },
      ],
      release: { track: 'production', codes: ['7', '8'] },
      truncated: true,
    },
  })!;
  assert.match(pushed.intro, /not submitted yet/);
  assert.match(pushed.intro, /2\.1/);
  assert.equal(pushed.groups.length, 3);
  assert.deepEqual(pushed.groups[0]!.lines, ['en-US: description']);
  assert.match(pushed.groups[1]!.lines[0]!, /de-DE: screenshot:iphone_6_5, files: 3/);
  assert.match(pushed.groups[2]!.heading, /production.*7, 8/);
  assert.equal(pushed.notes.length, 2, 'truncated note and next step');

  const draft = detailView({
    kind: 'draft_release',
    id: 'd',
    draftRelease: { track: 'production', codes: ['241'], since: 1 },
  })!;
  assert.match(draft.intro, /production/);
  assert.match(draft.groups[0]!.heading, /241/);
  assert.match(
    detailView({
      kind: 'draft_release',
      id: 'd',
      draftRelease: { track: 'beta', codes: [], since: null },
    })!.groups[0]!.heading,
    /No version codes/,
  );

  const review = detailView({
    kind: 'in_review',
    id: 'release:r',
    release: { version: '2.2', track: null, status: 'in_review', since: 5 },
  })!;
  assert.match(review.intro, /2\.2.*in review/);
  const approved = detailView({
    kind: 'approved',
    id: 'release:r',
    release: { version: '2.1', track: 'production', status: 'approved', since: 5 },
  })!;
  assert.match(approved.intro, /2\.1 \(production\).*approved/);
  assert.match(approved.notes[0]!, /release/);

  const step = detailView({
    kind: 'rollout_step',
    id: 'rollout:s',
    rolloutStep: { planVersion: '2.1', percent: 50, plannedAt: 1700000000000 },
  })!;
  assert.match(step.intro, /2\.1.*50%/);
});

test('a detail that does not fit its kind shows nothing (the row says "No preview")', () => {
  assert.equal(detailView({ kind: 'approved', id: 'x' } as PendingItemDetail), null);
  assert.equal(
    detailView({
      kind: 'pushed_draft',
      id: 'x',
      release: { version: '1', track: null, status: 'approved', since: null },
    } as PendingItemDetail),
    null,
  );
});

test('keys: a row is the app and the item, a detail is kept per item and the time it started waiting', () => {
  assert.equal(itemKey('a', { id: 'x' }), 'a/x');
  assert.notEqual(
    itemDetailKey('a', item('pushed_draft', 'p', { since: 1 })),
    itemDetailKey('a', item('pushed_draft', 'p', { since: 2 })),
  );
  assert.notEqual(
    itemDetailKey('a', item('pushed_draft', 'p')),
    itemDetailKey('b', item('pushed_draft', 'p')),
  );
});
