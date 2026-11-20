import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlanStep } from './pending.ts';
import { capItems, foldWarnings, planHeadline, shownStatusWord, stepGist } from './readability.ts';

const step = (type: PlanStep['type'], order: number, included: boolean, summary: PlanStep['summary'] = null) =>
  ({ type, order, included, summary }) as PlanStep;

test('one short warning stays on the line, anything else is folded, and none is lost', () => {
  assert.deepEqual(foldWarnings([]), { inline: [], folded: [], label: '' });
  assert.deepEqual(foldWarnings(['Short.']), { inline: ['Short.'], folded: [], label: '' });
  const two = foldWarnings(['One.', 'Two.']);
  assert.deepEqual([two.inline, two.folded], [[], ['One.', 'Two.']]);
  assert.equal(two.label, '2 things to read before you confirm');
  const long = foldWarnings(['x'.repeat(141)]);
  assert.deepEqual([long.inline.length, long.folded.length, long.label], [0, 1, '1 thing to read before you confirm']);
  assert.deepEqual(foldWarnings(['  ', 'Real.']).inline, ['Real.']);
});

test('the headline names the steps in the order they run', () => {
  const plan = { included: 2, steps: [step('submit', 2, true), step('push_draft', 1, true), step('release', 3, false)] };
  assert.deepEqual(planHeadline(plan, 'App Store Connect'), {
    title: '2 steps will be written to App Store Connect',
    sequence: 'Push the draft, then Submit for review',
  });
  assert.equal(planHeadline({ included: 1, steps: [step('release', 1, true)] }, 'Google Play').title, '1 step will be written to Google Play');
  assert.equal(planHeadline({ included: 0, steps: [] }, 'x').title, 'Nothing is included yet');
});

test('"Ready" on a ticked step is not repeated; any other word is kept', () => {
  assert.equal(shownStatusWord({ word: 'Ready', tone: 'ok', checked: true }), null);
  assert.equal(shownStatusWord({ word: 'Ready', tone: 'ok', checked: false }), 'Ready');
  assert.equal(shownStatusWord({ word: 'Blocked', tone: 'bad', checked: true }), 'Blocked');
  assert.equal(shownStatusWord({ word: 'Needs details', tone: 'warn', checked: false }), 'Needs details');
});

test('the gist of a step is its numbers, or empty', () => {
  assert.equal(stepGist(step('push_draft', 1, true, { textChanged: 3, assetSetsChanged: 1 })), '3 text changes, 1 graphics set');
  assert.equal(stepGist(step('submit', 1, true)), '');
});

test('capping keeps the first items and every bad one visible', () => {
  const items = [
    { id: 1, tone: 'warn' },
    { id: 2, tone: 'warn' },
    { id: 3, tone: 'info' },
    { id: 4, tone: 'bad' },
    { id: 5, tone: 'info' },
  ];
  const { shown, hidden } = capItems(items, 2);
  assert.deepEqual(shown.map((i) => i.id), [1, 2, 4]);
  assert.deepEqual(hidden.map((i) => i.id), [3, 5]);
  assert.deepEqual(capItems(items, 10).hidden, []);
});
