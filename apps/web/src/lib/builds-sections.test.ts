import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildsGroups } from './builds-sections.ts';
import { railEntries, resolveRailSection } from './section-rail.ts';

const ids = (input: Parameters<typeof buildsGroups>[0]) => railEntries(buildsGroups(input)).map((e) => e.id);

test('an app without Expo has no EAS entries, and a role without test builds no Test builds', () => {
  assert.deepEqual(ids({ expoLinked: false, configReadable: false, testsReadable: true, submissions: null }), ['builds', 'tests', 'workflows']);
  assert.deepEqual(ids({ expoLinked: false, configReadable: false, testsReadable: false, submissions: null }), ['builds', 'workflows']);
});

test('a linked app gets submissions, configuration and updates, with the submission count', () => {
  const groups = buildsGroups({ expoLinked: true, configReadable: true, testsReadable: true, submissions: 3 });
  const expo = groups.find((g) => g.id === 'expo');
  assert.deepEqual(expo?.entries.map((e) => e.id), ['submissions', 'eas-config', 'eas-updates']);
  assert.equal(expo?.entries[0]?.count, 3);
});

test('the old ?view= addresses open the same section', () => {
  const list = ids({ expoLinked: true, configReadable: true, testsReadable: true, submissions: 0 });
  assert.equal(resolveRailSection('#/apps/a/builds?view=workflows', list), 'workflows');
  assert.equal(resolveRailSection('#/apps/a/builds?view=tests&build=7', list), 'tests');
  assert.equal(resolveRailSection('#/apps/a/builds', list), 'builds');
});
