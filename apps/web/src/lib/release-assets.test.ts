import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assetsLine, stagedSetsLine } from './release-assets.ts';

const totals = (
  over: Partial<
    Record<'identical' | 'likely_same' | 'differs' | 'only_repo' | 'only_store', number>
  > = {},
) => ({
  identical: 0,
  likely_same: 0,
  differs: 0,
  only_repo: 0,
  only_store: 0,
  ...over,
});

test('the screenshots against the store, in one sentence', () => {
  assert.equal(assetsLine(null).tone, 'neutral');
  assert.match(assetsLine(totals()).text, /Nothing to compare/);
  const same = assetsLine(totals({ identical: 4, likely_same: 1 }));
  assert.deepEqual([same.tone, same.needsUpdate], ['ok', false]);
  const differs = assetsLine(totals({ identical: 2, differs: 1, only_repo: 2 }));
  assert.deepEqual([differs.tone, differs.needsUpdate], ['warn', true]);
  assert.match(
    differs.text,
    /1 screenshot differs from the store and 2 screenshots are only in the repository/,
  );
  assert.match(
    assetsLine(totals({ identical: 1, only_store: 1 })).text,
    /1 screenshot is only in the store/,
  );
});

test('the staged sets as a sentence', () => {
  assert.match(stagedSetsLine(0, 0), /stay as they are/);
  assert.equal(
    stagedSetsLine(1, 3),
    '1 graphic set is staged (3 files). They go to the store draft with the rest.',
  );
  assert.match(stagedSetsLine(2, 1), /2 graphic sets are staged \(1 file\)/);
});
