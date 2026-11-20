import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checklistView,
  elapsedText,
  irreversibleLine,
  planLine,
  releaseLead,
  rolloutNowLine,
  type LeadRelease,
} from './release-detail.ts';
import { formatTargetDate } from './release.ts';
import type { RolloutState } from './store-rollout.ts';

const NOW = Date.UTC(2026, 10, 20, 12);
const HOUR = 3_600_000;
const rel = (over: Partial<LeadRelease> = {}): LeadRelease => ({
  appId: 'a1',
  platform: 'ios',
  status: 'in_review',
  track: null,
  rolloutFraction: null,
  since: null,
  ...over,
});
const lead = (releases: LeadRelease[], over: Record<string, unknown> = {}) =>
  releaseLead({ version: '2.9.0', appId: 'a1', releases, planned: false, blocked: false, now: NOW, ...over });

test('elapsed text is hours, then days, and empty when unknown', () => {
  assert.equal(elapsedText(null, NOW), '');
  assert.equal(elapsedText(NOW + HOUR, NOW), '');
  assert.equal(elapsedText(NOW - 10 * 60_000, NOW), 'less than an hour');
  assert.equal(elapsedText(NOW - HOUR, NOW), '1 hour');
  assert.equal(elapsedText(NOW - 5 * HOUR, NOW), '5 hours');
  assert.equal(elapsedText(NOW - 24 * HOUR, NOW), '1 day');
  assert.equal(elapsedText(NOW - 50 * HOUR, NOW), '2 days');
});

test('a version in review says how long and offers the release steps', () => {
  const l = lead([rel({ since: NOW - 50 * HOUR })]);
  assert.equal(l.headline, 'Version 2.9.0 is in store review for 2 days');
  assert.equal(l.tone, 'info');
  assert.deepEqual(l.action, { label: 'Open the release steps', appId: 'a1', step: 'confirm' });
  assert.deepEqual(l.words, [{ platform: 'ios', word: 'In review', tone: 'info' }]);
});

test('the button labels follow the train button of the Releases tab', () => {
  assert.deepEqual(lead([rel({ status: 'approved' })]).action, {
    label: 'Release it',
    appId: 'a1',
    step: 'confirm',
  });
  assert.equal(lead([rel({ status: 'approved' })]).headline, 'Version 2.9.0 is approved: waiting for you to release it');
  assert.deepEqual(lead([rel({ status: 'rejected' })]).action, {
    label: 'See what to fix',
    appId: 'a1',
    step: 'review',
  });
  assert.equal(lead([rel({ status: 'rejected' })]).tone, 'bad');
  for (const status of ['draft', 'build_chosen', 'ready'] as const)
    assert.equal(lead([rel({ status })]).action?.label, 'Finish the release');
});

test('a live version has no button, a rolling one says the share', () => {
  const live = lead([rel({ status: 'live' })]);
  assert.equal(live.headline, 'Version 2.9.0 is live');
  assert.equal(live.action, null);
  assert.equal(live.tone, 'ok');
  const rolling = lead([rel({ status: 'rolling_out', platform: 'android', rolloutFraction: 0.2 })]);
  assert.equal(rolling.headline, 'Version 2.9.0 is rolling out: 20% of users');
  assert.equal(
    lead([rel({ status: 'halted', platform: 'android', rolloutFraction: 0.2 })]).headline,
    'The rollout of 2.9.0 is halted at 20% of users',
  );
});

test('with several platforms the one that needs the person leads, and each has one word', () => {
  const l = lead([
    rel({ appId: 'ios', platform: 'ios', status: 'live' }),
    rel({ appId: 'and', platform: 'android', status: 'approved' }),
  ]);
  assert.equal(l.headline, 'Version 2.9.0 on Android is approved: waiting for you to release it');
  assert.equal(l.action?.appId, 'and');
  assert.deepEqual(
    l.words.map((w) => [w.platform, w.word]),
    [
      ['ios', 'Live'],
      ['android', 'Approved'],
    ],
  );
});

test('two Android tracks give one word for the platform: the most pressing one', () => {
  const l = lead([
    rel({ platform: 'android', status: 'live', track: 'production' }),
    rel({ platform: 'android', status: 'rejected', track: 'beta' }),
  ]);
  assert.equal(l.words.length, 1);
  assert.equal(l.words[0]?.word, 'Rejected');
});

test('a version that is not in a store yet', () => {
  const planned = lead([], { planned: true });
  assert.equal(planned.headline, 'Version 2.9.0 is planned, not in the store yet');
  assert.equal(planned.action?.step, 'build');
  const none = lead([]);
  assert.equal(none.headline, 'Version 2.9.0 is not in the store yet');
  assert.equal(none.action, null);
});

test('a blocked plan turns the lead to a warning unless it is already bad', () => {
  const l = lead([rel({ status: 'approved' })], { blocked: true });
  assert.equal(l.tone, 'warn');
  assert.match(l.hint, /blocked/);
  assert.equal(lead([rel({ status: 'rejected' })], { blocked: true }).tone, 'bad');
});

test('the checklist shows open items first, required before optional, and counts the done ones', () => {
  const items = [
    { id: 'a', required: false, done: false },
    { id: 'b', required: true, done: true },
    { id: 'c', required: true, done: false },
    { id: 'd', required: true, done: true },
    { id: 'e', required: false, done: true },
    { id: 'f', required: true, done: false },
  ];
  const v = checklistView(items);
  assert.deepEqual(
    v.open.map((i) => i.id),
    ['c', 'f', 'a'],
  );
  assert.deepEqual(
    v.done.map((i) => i.id),
    ['b', 'd', 'e'],
  );
  assert.equal(v.headline, '3 of 6 done');
  assert.equal(v.hint, '2 required items are still open.');
  assert.equal(checklistView([]).headline, 'No items yet');
  assert.equal(checklistView([{ required: true, done: true }]).hint, 'Everything is done.');
  assert.equal(
    checklistView([
      { required: true, done: true },
      { required: false, done: false },
    ]).hint,
    'Every required item is done.',
  );
  assert.equal(checklistView([{ required: true, done: false }]).hint, '1 required item is still open.');
});

test('the plan is one quiet line', () => {
  const base = {
    platform: null,
    targetDate: '2026-12-01',
    due: { dueSoon: false, overdue: false, daysLeft: 11 },
    released: false,
    readiness: { notes: { locales: 3, filled: 2 } },
  };
  assert.equal(
    planLine(base as never),
    `Both platforms · Target ${formatTargetDate('2026-12-01')} (Due in 11 days) · Release notes in 2 of 3 locales`,
  );
  assert.equal(
    planLine({ ...base, targetDate: null, readiness: { notes: { locales: 0, filled: 0 } } } as never),
    'Both platforms · No target date',
  );
});

const play = (over: Record<string, unknown> = {}): RolloutState =>
  ({
    store: 'googleplay',
    platform: 'android',
    track: 'production',
    versionCodes: ['12'],
    name: '2.9.0',
    status: 'inProgress',
    userFraction: 0.2,
    otherReleases: 0,
    ...over,
  }) as RolloutState;
const apple = (over: Record<string, unknown> = {}): RolloutState =>
  ({
    store: 'appstoreconnect',
    platform: 'ios',
    version: '2.9.0',
    storeVersionId: 'v1',
    versionState: 'READY_FOR_SALE',
    phasedReleaseId: 'p1',
    phasedReleaseState: 'ACTIVE',
    currentDayNumber: 3,
    startDate: null,
    totalPauseDays: null,
    ...over,
  }) as RolloutState;

test('the current rollout is one line', () => {
  assert.equal(rolloutNowLine(play()), 'Rolling out: 20% of users');
  assert.equal(rolloutNowLine(play({ status: 'halted' })), 'Halted at 20% of users');
  assert.equal(rolloutNowLine(play({ status: 'completed', userFraction: 1 })), 'Released to 100% of users');
  assert.equal(rolloutNowLine(play({ userFraction: null })), 'Rolling out');
  assert.equal(rolloutNowLine(apple()), 'Rolling out: day 3 of 7');
  assert.equal(rolloutNowLine(apple({ phasedReleaseState: 'PAUSED' })), 'Paused on day 3 of 7');
  assert.equal(rolloutNowLine(apple({ phasedReleaseState: 'COMPLETE' })), 'Released to all users');
  assert.equal(rolloutNowLine(apple({ phasedReleaseState: null })), 'No phased release');
});

test('one line names the enabled changes that cannot be undone', () => {
  const b = (label: string, irreversible: boolean, disabled = false) => ({ label, irreversible, disabled });
  assert.equal(irreversibleLine([b('Halt rollout', false), b('Release to 100%', false)]), null);
  assert.equal(irreversibleLine([b('Halt rollout', false), b('Release to 100%', true)]), 'Release to 100% cannot be undone.');
  assert.equal(irreversibleLine([b('Release to 100%', true, true)]), null);
  assert.equal(
    irreversibleLine([b('Release to all users', true), b('Release to 100%', true)]),
    'Release to all users and Release to 100% cannot be undone.',
  );
});
