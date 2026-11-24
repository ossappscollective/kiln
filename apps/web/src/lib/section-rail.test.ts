import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  nonEmptyGroups,
  railEntries,
  resolveRailSection,
  stepRail,
  withRailSection,
} from './section-rail.ts';

const ids = ['builds', 'tests', 'submissions'];

test('the section comes from ?section=, then from an old ?view=, else the first', () => {
  assert.equal(resolveRailSection('#/apps/a/builds?section=submissions', ids), 'submissions');
  assert.equal(resolveRailSection('#/apps/a/builds?view=tests', ids), 'tests');
  assert.equal(resolveRailSection('#/apps/a/builds?view=old', ids, { old: 'builds' }), 'builds');
  assert.equal(resolveRailSection('#/apps/a/builds?section=nope', ids), 'builds');
  assert.equal(resolveRailSection('#/apps/a/builds', ids), 'builds');
  assert.equal(resolveRailSection('#/x', []), '');
});

test('a section that is not available falls back to the first', () => {
  assert.equal(resolveRailSection('#/a?section=submissions', ['builds', 'tests']), 'builds');
});

test('withRailSection drops the old view and keeps other parameters', () => {
  assert.equal(
    withRailSection('#/apps/a/builds?view=tests&build=12&platform=ios', 'submissions'),
    '#/apps/a/builds?build=12&platform=ios&section=submissions',
  );
  assert.equal(withRailSection('#/apps/a/builds', 'tests'), '#/apps/a/builds?section=tests');
});

test('arrow keys move through the entries and wrap', () => {
  assert.equal(stepRail(ids, 'builds', 'ArrowDown'), 'tests');
  assert.equal(stepRail(ids, 'submissions', 'ArrowDown'), 'builds');
  assert.equal(stepRail(ids, 'builds', 'ArrowUp'), 'submissions');
  assert.equal(stepRail(ids, 'tests', 'End'), 'submissions');
  assert.equal(stepRail(ids, 'tests', 'Home'), 'builds');
  assert.equal(stepRail(ids, 'tests', 'x'), null);
  assert.equal(stepRail([], 'a', 'ArrowDown'), null);
});

test('empty groups are left out', () => {
  const groups = [
    { id: 'a', label: 'A', entries: [{ id: 'x', label: 'X' }] },
    { id: 'b', label: 'B', entries: [] },
  ];
  assert.deepEqual(
    nonEmptyGroups(groups).map((g) => g.id),
    ['a'],
  );
  assert.deepEqual(
    railEntries(groups).map((e) => e.id),
    ['x'],
  );
});
