import assert from 'node:assert/strict';
import { test } from 'node:test';
import { warningCountOf, warningGroups } from './warnings.ts';

test('no problems, no groups', () => {
  const groups = warningGroups([
    { appId: 'a', platform: 'iOS', storeError: null, warnings: undefined, repoError: null },
  ]);
  assert.deepEqual(groups, []);
  assert.equal(warningCountOf(groups), 0);
});

test('a store error, warnings and a repository error are three groups', () => {
  const groups = warningGroups([
    {
      appId: 'a',
      platform: 'Android',
      storeError: 'Play failed',
      warnings: ['Icon of zh-CN could not be read', 'Icon of zh-CN could not be read'],
      repoError: 'No access',
    },
  ]);
  assert.deepEqual(
    groups.map((g) => g.id),
    ['a:store-error', 'a:store-warnings', 'a:repo-error'],
  );
  assert.equal(groups[0]?.title, 'The last read of the Android store listing failed');
  assert.equal(groups[2]?.note, null);
  // cleanWarnings drops duplicates and blanks, so the count follows what is shown.
  assert.equal(warningCountOf(groups), 1 + (groups[1]?.lines.length ?? 0) + 1);
});
