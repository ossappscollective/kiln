import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PendingItem } from './pending.ts';
import {
  buildChip,
  buildHasProblem,
  confirmSteps,
  footerFor,
  orderBuilds,
  railMark,
  stepIntro,
  visibleBuilds,
} from './stepper-layout.ts';

test('the rail: the current step is filled, a ready one is a check, a problem keeps its mark', () => {
  assert.equal(railMark('ready', true), 'current');
  assert.equal(railMark('ready', false), 'done');
  assert.equal(railMark('attention', false), 'attention');
  assert.equal(railMark('blocked', false), 'blocked');
  assert.equal(railMark('optional', false), 'optional');
  assert.equal(railMark('todo', false), 'todo');
  assert.equal(railMark('unknown', false), 'todo');
});

test('the footer names the next step, and the last step publishes', () => {
  const all = ['build', 'notes', 'assets', 'review', 'confirm'] as const;
  assert.deepEqual(footerFor('build', all), {
    position: 'Step 1 of 5',
    back: null,
    primary: { kind: 'step', to: 'notes', label: 'Next: Notes' },
  });
  assert.deepEqual(footerFor('review', all).primary, {
    kind: 'step',
    to: 'confirm',
    label: 'Next: Confirm',
  });
  assert.deepEqual(footerFor('confirm', all), {
    position: 'Step 5 of 5',
    back: 'review',
    primary: { kind: 'publish', label: 'Review and publish' },
  });
  const four = ['build', 'notes', 'assets', 'review'] as const;
  assert.deepEqual(footerFor('review', four).primary, { kind: 'close', label: 'Close' });
  assert.equal(footerFor('review', four).position, 'Step 4 of 4');
});

const item = (
  kind: PendingItem['kind'],
  nextStep: PendingItem['nextStep'],
  label: string,
  counts: Record<string, number> = {},
): PendingItem =>
  ({
    kind,
    nextStep,
    label,
    counts,
    refs: [{ id: 'a' }],
    state: 'staged',
    problems: [],
  }) as unknown as PendingItem;

test('the Confirm list is in the order the steps run, with the badge on the step that cannot be undone', () => {
  const list = confirmSteps(
    [
      item('approved', 'release', 'Version 2.9.0'),
      item('listing_text', 'push_draft', 'Texts', { changes: 3 }),
      item('asset_set', 'push_draft', 'Shots'),
      item('pushed_draft', 'submit', 'Version 2.9.0'),
    ],
    'ios',
  );
  assert.deepEqual(
    list.map((s) => s.type),
    ['push_draft', 'submit', 'release'],
  );
  assert.equal(list[0]?.detail, '3 text changes and 1 graphics set');
  assert.deepEqual(
    list.map((s) => s.irreversible),
    [false, false, true],
  );
  assert.equal(list[2]?.note, 'Cannot be undone from here');
  assert.deepEqual(confirmSteps([item('in_review', null, 'In review')], 'ios'), []);
});

const facts = (over: Record<string, unknown> = {}) =>
  ({
    platform: 'ios',
    version: '2.9.0',
    chosen: null,
    notes: { withText: 0 },
    staged: { total: 0 },
    confirm: null,
    ...over,
  }) as Parameters<typeof stepIntro>[1];

test('each step has one heading and one sentence', () => {
  assert.equal(stepIntro('build', facts()).title, 'Choose the build for 2.9.0');
  assert.equal(
    stepIntro('build', facts({ chosen: { label: 'Build 413', where: 'store' } })).sentence,
    'Build 413 is attached, so you can go straight to the next step.',
  );
  assert.equal(
    stepIntro('build', facts({ platform: 'android' })).title,
    'Choose the version codes',
  );
  assert.equal(
    stepIntro('notes', facts({ notes: { withText: 6 } })).sentence,
    '6 languages have notes. Check them, or go on.',
  );
  assert.equal(
    stepIntro('review', facts({ staged: { total: 1 } })).sentence,
    '1 change is staged. Remove what you do not want. Nothing is sent yet.',
  );
  assert.equal(
    stepIntro('confirm', facts({ confirm: [{}, {}] })).title,
    'Publish 2 steps to the App Store',
  );
  assert.equal(
    stepIntro('confirm', facts({ platform: 'android', confirm: [{}] })).title,
    'Publish 1 step to Google Play',
  );
  assert.equal(stepIntro('confirm', facts({ confirm: [] })).title, 'Nothing waits to be published');
  const waiting = stepIntro('confirm', facts({ confirm: [], inReview: true }));
  assert.match(waiting.title, /in store review$/);
  assert.match(waiting.sentence, /Waiting on the store/);
  // With something staged the version in review changes nothing: the steps still lead.
  assert.match(stepIntro('confirm', facts({ confirm: [{}], inReview: true })).title, /^Publish /);
});

const row = (id: string, selectable: boolean, tone: 'ok' | 'warn' | 'bad' | 'neutral' = 'ok') => ({
  id,
  eligibility: { selectable, tone },
});

test('the build to start from comes first; the others keep their order', () => {
  const rows = [row('413', true), row('412', true), row('410', true)];
  assert.deepEqual(
    orderBuilds(rows, '412').rows.map((r) => r.id),
    ['412', '413', '410'],
  );
  assert.equal(orderBuilds(rows, null).firstId, '413');
  assert.deepEqual(
    orderBuilds([row('9', false, 'bad'), row('8', true)], null).rows.map((r) => r.id),
    ['8', '9'],
  );
  assert.equal(orderBuilds([row('9', false, 'bad')], null).firstId, null);
});

test('the newest three are shown, and the picked build is never hidden', () => {
  const rows = ['5', '4', '3', '2', '1'].map((id) => ({ id }));
  assert.deepEqual(visibleBuilds(rows, { showAll: false, pickedId: '' }), {
    shown: rows.slice(0, 3),
    hidden: 2,
  });
  assert.deepEqual(
    visibleBuilds(rows, { showAll: false, pickedId: '1' }).shown.map((r) => r.id),
    ['5', '4', '1'],
  );
  assert.equal(visibleBuilds(rows, { showAll: true, pickedId: '' }).hidden, 0);
  assert.equal(visibleBuilds(rows.slice(0, 3), { showAll: false, pickedId: '' }).hidden, 0);
});

test('one chip per build, and the details open only for a real problem', () => {
  const ok = row('a', true);
  assert.deepEqual(buildChip(ok, { attached: true, staged: false }), {
    text: 'Attached',
    tone: 'ok',
  });
  assert.deepEqual(buildChip(ok, { attached: true, staged: true }), {
    text: 'Chosen',
    tone: 'info',
  });
  assert.deepEqual(buildChip(ok, { attached: false, staged: false }), {
    text: 'Can be chosen',
    tone: 'neutral',
  });
  assert.deepEqual(buildChip(row('b', true, 'warn'), { attached: false, staged: false }), {
    text: 'Read first',
    tone: 'warn',
  });
  assert.deepEqual(buildChip(row('c', false, 'bad'), { attached: false, staged: false }), {
    text: 'Cannot be chosen',
    tone: 'bad',
  });
  assert.equal(buildHasProblem(ok), false);
  assert.equal(buildHasProblem(row('b', true, 'warn')), true);
  assert.equal(buildHasProblem(row('c', false, 'bad')), true);
  assert.equal(buildHasProblem(undefined), false);
});
