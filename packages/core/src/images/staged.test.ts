import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isUnpushed, stagedCountsOf } from './staged.ts';

test('unpushed: never pushed, or pushed and then changed (pushed_hash IS NULL OR pushed_hash <> value_hash)', () => {
  assert.equal(isUnpushed({ pushedHash: null, valueHash: 'a' }), true);
  assert.equal(isUnpushed({ pushedHash: undefined, valueHash: 'a' }), true);
  assert.equal(isUnpushed({ pushedHash: 'a', valueHash: 'b' }), true);
  assert.equal(isUnpushed({ pushedHash: 'a', valueHash: 'a' }), false);
});

test('counts: total (pushed rows included) and unpushed (what a push sends) are two named families', () => {
  const view = {
    text: [{ pushed: false }, { pushed: true }],
    assets: [
      { pushed: false, files: [1, 2, 3] },
      { pushed: true, files: [1, 2, 3, 4] },
      { pushed: false, files: [] },
    ],
  };
  assert.deepEqual(stagedCountsOf(view as never), {
    totalTexts: 2,
    totalSets: 3,
    totalFiles: 7,
    unpushedTexts: 1,
    unpushedSets: 2,
    unpushedFiles: 3,
  });
  // the tray said "2 sets (7 files)" while the cart said 0 after a push: now both numbers exist and are named
  const afterPush = { text: [], assets: [{ pushed: true, files: [1, 2, 3, 4, 5, 6, 7] }] };
  const c = stagedCountsOf(afterPush as never);
  assert.equal(c.totalSets, 1);
  assert.equal(c.unpushedSets, 0);
  assert.equal(stagedCountsOf(null).totalSets, 0);
});
