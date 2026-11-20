import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlanStep } from './pending.ts';
import { capItems, foldWarnings, planHeadline, publishDisabledReason, publishTitle, shownStatusWord, stepGist } from './readability.ts';

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

test('the dialog title says what happens, naming the version and the store', () => {
  const rel = step('release', 3, true, { version: '2.9.0' });
  assert.equal(publishTitle({ steps: [step('push_draft', 1, true), step('submit', 2, true), rel] }, 'the App Store'), 'Release 2.9.0 to the App Store');
  assert.equal(publishTitle({ steps: [step('push_draft', 1, true), step('submit', 2, true, { versionString: '2.9.0' })] }, 'the App Store'), 'Submit 2.9.0 for review on the App Store');
  assert.equal(publishTitle({ steps: [step('push_draft', 1, true), step('release', 3, false, { version: '1' })] }, 'Google Play'), 'Update the draft on Google Play');
  assert.equal(publishTitle({ steps: [step('release', 1, true)] }, 'Google Play'), 'Release to Google Play');
  assert.equal(publishTitle({ steps: [step('rollout', 1, true)] }, 'the App Store'), 'Change the rollout on the App Store');
  assert.equal(publishTitle({ steps: [] }, 'the App Store'), 'Publish to the App Store');
});

test('the footer says why Publish is off, and names a phrase only when one is required', () => {
  const plan = (over: Record<string, unknown>) => ({ confirmable: true, confirmationRequired: false, confirmation: null, ...over }) as Parameters<typeof publishDisabledReason>[0]['plan'];
  const base = { phase: 'ready', stale: false, ready: false, wanted: 1 };
  assert.equal(publishDisabledReason({ ...base, ready: true, plan: plan({}) }), '');
  assert.equal(publishDisabledReason({ ...base, plan: plan({}) }), 'Tick the box above to publish.');
  assert.equal(publishDisabledReason({ ...base, plan: plan({ confirmationRequired: true, confirmation: { phrase: 'release 2.9.0', instruction: '' } }) }), 'Type "release 2.9.0" to publish.');
  assert.equal(publishDisabledReason({ ...base, stale: true, plan: plan({}) }), 'The plan is out of date. Review again to publish.');
  assert.equal(publishDisabledReason({ ...base, wanted: 0, plan: plan({ confirmable: false }) }), 'Tick at least one step to publish.');
  assert.equal(publishDisabledReason({ ...base, plan: plan({ confirmable: false }) }), 'A step cannot run. Untick it or fix what blocks it.');
  assert.equal(publishDisabledReason({ ...base, phase: 'previewing', plan: null }), 'Making the plan.');
  assert.equal(publishDisabledReason({ ...base, phase: 'publishing', plan: plan({}) }), '');
});
