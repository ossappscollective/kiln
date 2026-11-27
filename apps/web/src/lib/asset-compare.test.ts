import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssetCompareRow, AssetDiffSet, AssetDiffView } from '@kiln/core';
import { compareState, MAX_COMPARE_ROWS, statusOf } from './asset-compare.ts';

const side = (n: number) => ({ path: `p${n}.png`, bytes: 10 }) as never;
const storeSide = (n: number) => ({ ref: `r${n}` }) as never;
const row = (status: AssetCompareRow['status'], repo: boolean, store: boolean): AssetCompareRow =>
  ({
    position: 1,
    status,
    repo: repo ? side(1) : null,
    store: store ? storeSide(1) : null,
    reason: '',
  }) as never;
const totalsOf = (rows: AssetCompareRow[]) => {
  const t = { identical: 0, likely_same: 0, differs: 0, only_repo: 0, only_store: 0 };
  for (const r of rows) t[r.status] += 1;
  return t;
};
const set = (locale: string, rows: AssetCompareRow[], device = 'iphone_6_5'): AssetDiffSet =>
  ({
    platform: 'ios',
    locale,
    kind: 'screenshot',
    device,
    deviceLabel: 'iPhone 6.5-inch',
    target: null,
    rows,
    totals: totalsOf(rows),
    inSync: false,
  }) as never;
const view = (sets: AssetDiffSet[], repoStatus: 'ok' | 'no_repository' = 'ok'): AssetDiffView =>
  ({
    appId: 'a',
    platform: 'ios',
    readAt: 1,
    commit: 'c',
    version: null,
    repoStatus,
    sets,
    totals: totalsOf(sets.flatMap((s) => s.rows)),
    unplaced: 0,
    notes: [],
  }) as never;

test('no repository and nothing on either side are their own explicit states', () => {
  assert.deepEqual(compareState(view([], 'no_repository')), { kind: 'no_repository' });
  assert.deepEqual(compareState(view([])), { kind: 'nothing' });
  assert.deepEqual(compareState(view([set('en-US', [])])), { kind: 'nothing' });
});

test('one status per set: changed, missing in the store, only in the store, probably the same, same', () => {
  assert.equal(
    statusOf(set('x', [row('differs', true, true), row('identical', true, true)])),
    'changed',
  );
  assert.equal(statusOf(set('x', [row('only_repo', true, false)])), 'missing');
  assert.equal(statusOf(set('x', [row('only_store', false, true)])), 'extra');
  assert.equal(statusOf(set('x', [row('likely_same', true, true)])), 'probably');
  assert.equal(statusOf(set('x', [row('identical', true, true)])), 'same');
});

test('the table counts both sides and lists what needs a look first', () => {
  const state = compareState(
    view([
      set('de-DE', [row('identical', true, true)]),
      set('en-US', [
        row('identical', true, true),
        row('only_repo', true, false),
        row('differs', true, true),
      ]),
      set('fr-FR', [row('only_store', false, true)]),
    ]),
  );
  assert.equal(state.kind, 'table');
  if (state.kind !== 'table') return;
  assert.deepEqual(
    state.rows.map((r) => [r.locale, r.status, r.repoCount, r.storeCount]),
    [
      ['en-US', 'changed', 3, 2],
      ['fr-FR', 'extra', 0, 1],
      ['de-DE', 'same', 1, 1],
    ],
  );
  assert.equal(state.needsAttention, 1);
  assert.equal(state.hidden, 0);
});

test('a long list is capped and says how many are left', () => {
  const sets = Array.from({ length: MAX_COMPARE_ROWS + 5 }, (_, i) =>
    set(`l${String(i).padStart(3, '0')}`, [row('identical', true, true)]),
  );
  const state = compareState(view(sets));
  assert.equal(state.kind === 'table' ? state.rows.length : -1, MAX_COMPARE_ROWS);
  assert.equal(state.kind === 'table' ? state.hidden : -1, 5);
});

test('a display the store keeps in two sets is two rows, each named by its group: neither stands for, nor is added to, the other', () => {
  const primary = { ...set('en-US', [row('differs', true, true), row('only_repo', true, false)], 'ipad_13'), target: 'APP_IPAD_PRO_3GEN_129' } as AssetDiffSet;
  const legacy = { ...set('en-US', [row('only_store', false, true), row('only_store', false, true)], 'ipad_13'), target: 'APP_IPAD_PRO_129' } as AssetDiffSet;
  const state = compareState(view([primary, legacy]));
  assert.equal(state.kind, 'table');
  if (state.kind !== 'table') return;
  assert.equal(state.rows.length, 2);
  assert.equal(new Set(state.rows.map((r) => r.key)).size, 2);
  const [a, b] = [state.rows.find((r) => /3GEN/.test(r.what)), state.rows.find((r) => /IPAD_PRO_129/.test(r.what))];
  assert.deepEqual([a?.repoCount, a?.storeCount], [2, 1]);
  assert.deepEqual([b?.repoCount, b?.storeCount], [0, 2]);
  // One set per display keeps its plain name.
  const alone = compareState(view([{ ...primary } as AssetDiffSet]));
  assert.equal(alone.kind === 'table' ? alone.rows[0]?.what : '', 'iPhone 6.5-inch');
});
