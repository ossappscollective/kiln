import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RepoSideFile } from '../listing/asset-sync.ts';
import {
  compareDisplay,
  compareRows,
  compareSentence,
  pullRefOf,
  pullRefsOfDisplay,
} from './compare.ts';
import { IPAD, imageFiles, tenPlusTwo } from './fixtures.ts';
import { groupStoreImages } from './groups.ts';

/**
 * Compare rows carry the store ref (audit images.md F6.1/F6.2: "Pull this image" on a sibling group pulled another image).
 */

const repoFile = (n: number, over: Partial<RepoSideFile> = {}): RepoSideFile => ({
  path: `s${n}.png`,
  oid: `oid${n}`,
  sha256: null,
  bytes: 1000,
  width: IPAD.width,
  height: IPAD.height,
  ...over,
});

test('a row of a SIBLING group carries the store position and ref, never the index: pull selects by storeRef', () => {
  const display = groupStoreImages(tenPlusTwo())[0];
  assert.ok(display);
  const sibling = display.groups.find((g) => g.target === 'APP_IPAD_PRO_129');
  const rows = compareRows([], sibling ?? null);
  assert.deepEqual(
    rows.map((r) => [r.index, r.position, r.storePosition, r.storeRef, r.group, r.status]),
    [
      [0, 1, 11, 'b-11', 'APP_IPAD_PRO_129', 'only_store'],
      [1, 2, 12, 'b-12', 'APP_IPAD_PRO_129', 'only_store'],
    ],
  );
  // the old key `set#position` would have asked for store position 1 or 2 (the primary group's images)
  assert.equal(pullRefOf(rows[1] as never), 'b-12');
});

test('pairs the repository files with the group in order; an empty side is only_repo / only_store with a null ref', () => {
  const rows = compareRows([repoFile(1), repoFile(2), repoFile(3)], {
    target: 'G',
    files: imageFiles(2),
  });
  assert.deepEqual(
    rows.map((r) => r.status),
    ['likely_same', 'likely_same', 'only_repo'],
  );
  assert.equal(rows[2]?.storeRef, null);
  assert.equal(rows[2]?.storePosition, null);
  assert.equal(pullRefOf(rows[2] as never), null);
  const none = compareRows([], null);
  assert.deepEqual(none, []);
  const differs = compareRows([repoFile(1, { width: 10, height: 10 })], {
    target: 'G',
    files: imageFiles(1),
  });
  assert.equal(differs[0]?.status, 'differs');
});

test('a display: the primary group against the repository, every sibling image is only_store, a whole-display pull takes ALL groups', () => {
  const display = groupStoreImages(tenPlusTwo())[0] ?? null;
  const cmp = compareDisplay(
    Array.from({ length: 10 }, (_, i) => repoFile(i + 1)),
    display,
  );
  assert.equal(cmp.rows.length, 10);
  assert.equal(cmp.siblings.length, 1);
  assert.equal(cmp.siblings[0]?.group, 'APP_IPAD_PRO_129');
  assert.equal(cmp.totals.only_store, 2);
  assert.equal(cmp.inSync, false);
  assert.equal(pullRefsOfDisplay(display as never).length, 12);
  assert.deepEqual(pullRefsOfDisplay(display as never).slice(0, 2), ['a-1', 'a-2']);
  const nothing = compareDisplay([], null);
  assert.equal(nothing.inSync, true);
});

test('the sentence: state, parts and changes, one structure for the three old builders', () => {
  const totals = { identical: 3, likely_same: 0, differs: 1, only_repo: 0, only_store: 2 };
  const s = compareSentence(totals);
  assert.equal(s.state, 'changed');
  assert.equal(s.needsUpdate, true);
  assert.equal(s.tone, 'warn');
  assert.equal(s.text, '3 identical, 1 differs, 2 only in the store');
  assert.deepEqual(s.changes, [{ status: 'differs', count: 1 }]);
  assert.equal(
    compareSentence({ identical: 2, likely_same: 1, differs: 0, only_repo: 0, only_store: 0 })
      .state,
    'match',
  );
  assert.equal(
    compareSentence({ identical: 0, likely_same: 0, differs: 0, only_repo: 0, only_store: 0 })
      .state,
    'nothing',
  );
  assert.equal(compareSentence(null).state, 'not_compared');
  assert.equal(
    compareSentence({ identical: 0, likely_same: 0, differs: 2, only_repo: 0, only_store: 0 }).text,
    '2 differ',
  );
  assert.equal(
    compareSentence({ identical: 1, likely_same: 0, differs: 0, only_repo: 0, only_store: 1 }).tone,
    'ok',
  );
});

test('the sentence text is the existing compareText (one wording)', async () => {
  const { compareText } = await import('../listing/asset-sync.ts');
  const cases = [
    { identical: 3, likely_same: 1, differs: 1, only_repo: 2, only_store: 1 },
    { identical: 0, likely_same: 0, differs: 2, only_repo: 0, only_store: 0 },
    { identical: 0, likely_same: 0, differs: 0, only_repo: 0, only_store: 0 },
  ];
  for (const t of cases) assert.equal(compareSentence(t).text, compareText(t));
});
