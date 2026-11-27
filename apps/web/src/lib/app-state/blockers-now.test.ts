import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SubmitBlocker } from '@kiln/core';
import type { ReadinessFact } from './blockers.ts';
import { blockersViewOf } from './blockers.ts';
import { deriveAppState } from './derive.ts';
import { blockedRun, facts, IOS, iosRelease, NOW } from './fixtures.ts';

/**
 * The blockers a publish run kept are true of the moment it ran. The user's report (OSS Document Scanner, 2026-11-27): the run said "At
 * most 10 screenshots per device size. en-US iPad 13" / 12.9": 12 found." and an empty fr-FR; the person removed screenshots and filled the
 * text, the store shows 10, and Kiln kept saying 12. The model holds the run's list (HISTORY) against a CURRENT reading of the store
 * (`GET /apps/:id/publish/readiness`, judged by the pure rules of core) and shows only what still holds.
 */

const COUNT_RUN = {
  code: 'asset_spec',
  message: 'At most 10 screenshots per device size. en-US iPad 13" / 12.9": 12 found.',
  locale: 'en-US',
  item: 'apple.screenshot.count',
};
const FR_RUN = { code: 'missing_text', message: 'Description is empty in fr-FR.', locale: 'fr-FR', item: 'description' };
const userRun = () => blockedRun('ios', [COUNT_RUN, FR_RUN]);

const fix = { kind: 'screenshots' as const, href: null };
const countNow = (count: number): SubmitBlocker => ({
  code: 'asset_spec',
  message: `At most 10 screenshots per device size. en-US iPad 13" / 12.9" (APP_IPAD_PRO_3GEN_129): ${count} found.`,
  locale: 'en-US',
  item: 'apple.screenshot.count:APP_IPAD_PRO_3GEN_129',
  params: { count, max: 10, device: 'ipad_13', set: 'APP_IPAD_PRO_3GEN_129' },
  fix,
});
const frNow: SubmitBlocker = {
  code: 'missing_text',
  message: 'Description is empty in fr-FR.',
  locale: 'fr-FR',
  item: 'description',
  fix: { kind: 'listing', href: null },
};
const reading = (blockers: SubmitBlocker[], over: Partial<ReadinessFact> = {}): ReadinessFact => ({
  reading: {
    ready: blockers.length === 0,
    blockers,
    unknown: [],
    versionString: '2.0.1',
    storeReadAt: NOW - 5_000,
  },
  checking: false,
  error: null,
  ...over,
});
const draft = iosRelease({ version: '2.0.1', status: 'draft', rawState: 'PREPARE_FOR_SUBMISSION' });
const state = (fact: ReadinessFact | null | undefined, over: Partial<Parameters<typeof facts>[0]> = {}) =>
  deriveAppState(
    facts({
      records: [IOS],
      pending: { [IOS.id]: { count: 0, blocking: 0 } },
      lastRun: { [IOS.id]: userRun() },
      releases: { [IOS.id]: [draft] },
      ...(fact === undefined ? {} : { readiness: { [IOS.id]: fact } }),
      ...over,
    }),
    'ios',
  );

test('the run said 12 screenshots and an empty fr-FR; the store now has 10 and fr-FR is filled: ready to submit, the run kept as history', () => {
  const s = state(reading([]));
  assert.equal(s.phase, 'ready_to_submit');
  assert.equal(s.headline, 'Ready to submit');
  assert.equal(
    s.reason,
    'The last publish was partly done; everything that blocked the submit is fixed now.',
  );
  assert.equal(s.primaryAction.action, 'submit_now');
  assert.equal(s.primaryAction.label, 'Submit 2.0.1 for review');
  assert.equal(s.primaryAction.enabled, true);
  assert.equal(s.primaryAction.appId, IOS.id);
  assert.deepEqual(s.badge, { kind: 'failed', count: 0, appId: IOS.id, blocked: true, ready: true });
  assert.equal(s.tone, 'info');
  assert.equal(s.canDo('submit', 'ios').enabled, true);
  // The record of the run is still there, as history: what it said then, apart from what is true now.
  const view = s.failures[0]?.blockers;
  assert.equal(view?.state, 'ready');
  assert.deepEqual(view?.current, []);
  assert.equal(view?.run.length, 2);
  assert.equal(view?.resolved.length, 2);
  assert.equal(view?.summary, 'All clear');
  assert.match(view?.runLabel ?? '', /^From the last publish, 6 minutes ago$/);
  assert.equal(s.platforms[0]?.phase, 'ready_to_submit');
  // No "nothing is waiting": a run that is still there is not "nothing".
  assert.doesNotMatch(s.headline, /Nothing is waiting/);
});

test('one fixed, one still there: only the one that holds is shown, as the next step and in the count', () => {
  const s = state(reading([frNow]));
  assert.equal(s.phase, 'publish_failed');
  assert.equal(s.headline, 'Draft pushed, submit blocked');
  assert.equal(s.primaryAction.action, 'fix_blockers');
  assert.equal(s.primaryAction.label, 'Fix 1 blocker, then submit 2.0.1 for review');
  // The sentence names what blocks now, not what the run recorded.
  assert.match(s.reason, /Description is empty in fr-FR/);
  assert.doesNotMatch(s.reason, /12 found/);
  const view = s.failures[0]?.blockers;
  assert.equal(view?.state, 'blocked');
  assert.deepEqual(view?.current.map((b) => b.code), ['missing_text']);
  assert.deepEqual(view?.resolved.map((b) => b.code), ['asset_spec']);
  assert.equal(view?.run.length, 2);
  assert.equal(view?.summary, 'Still 1 thing in the way');
  assert.deepEqual(s.badge, { kind: 'failed', count: 0, appId: IOS.id, blocked: true });
});

test('still 12 iPad 13" screenshots: the answer says which and how many to remove', () => {
  const s = state(reading([countNow(12)]));
  const view = s.failures[0]?.blockers;
  assert.equal(view?.summary, 'Still 12 iPad 13" / 12.9" screenshots: remove 2');
  assert.equal(s.primaryAction.label, 'Fix 1 blocker, then submit 2.0.1 for review');
  // The fix for a count blocker is to remove screenshots, not to replace an image.
  assert.match(view?.current[0]?.fix ?? '', /Remove the extra screenshots/);
  // The same blocker is not "new": the run's count blocker and the current one are one.
  assert.equal(view?.resolved.map((b) => b.code).join(), 'missing_text');
});

test('no reading yet: the run\'s blockers are shown as they were, labelled with their age, and nothing is claimed to be fixed', () => {
  const s = state(undefined);
  assert.equal(s.phase, 'publish_failed');
  assert.equal(s.primaryAction.label, 'Fix 2 blockers, then submit 2.0.1 for review');
  const view = s.failures[0]?.blockers;
  assert.equal(view?.state, 'unverified');
  assert.equal(view?.current.length, 0);
  assert.equal(view?.run.length, 2);
  assert.equal(view?.readAt, null);
  assert.equal(view?.summary, '');
  assert.match(s.reason, /12 found/);
});

test('a reading made before the run ended says nothing about what the run left', () => {
  const s = state(reading([], { reading: { ready: true, blockers: [], unknown: [], versionString: '2.0.1', storeReadAt: NOW - 500_000 } }));
  assert.equal(s.phase, 'publish_failed');
  assert.equal(s.failures[0]?.blockers?.state, 'unverified');
});

test('a reading that is on its way, or that failed, keeps the run\'s list and says so', () => {
  const checking = state({ reading: null, checking: true, error: null });
  assert.equal(checking.failures[0]?.blockers?.checking, true);
  assert.equal(checking.failures[0]?.blockers?.state, 'unverified');
  const failed = state({ reading: null, checking: false, error: 'forbidden' });
  assert.equal(failed.failures[0]?.blockers?.error, 'forbidden');
  assert.equal(failed.phase, 'publish_failed');
});

test('a check of the run that nothing can recompute (the store drifted) is not carried over as current, and does not hold the submit', () => {
  const s = state(reading([]), {
    lastRun: { [IOS.id]: blockedRun('ios', [{ code: 'draft_differs', message: 'The screenshots x (en-US) in the store no longer match what was pushed. Push the draft again.' }]) },
  });
  assert.equal(s.phase, 'ready_to_submit');
  assert.equal(s.failures[0]?.blockers?.resolved.length, 0);
  assert.equal(s.failures[0]?.blockers?.run.length, 1);
});

test('fixed blockers and new pending changes: the changes lead, the run stays in the failure block', () => {
  const s = state(reading([]), { pending: { [IOS.id]: { count: 3, blocking: 0 } } });
  assert.equal(s.phase, 'changes_pending');
  assert.equal(s.failures.length, 1);
  assert.equal(s.platforms[0]?.phase, 'changes_pending');
});

test('dismissing the run ends the history too: no failure, no view', () => {
  const s = state(reading([]), { lastRun: { [IOS.id]: { ...userRun(), dismissed: true } } });
  assert.equal(s.failures.length, 0);
  assert.notEqual(s.phase, 'ready_to_submit');
});

test('a run that is not only a blocked submit has no blockers view', () => {
  assert.equal(blockersViewOf({ ...userRun(), results: [] }, reading([]), NOW), null);
});

test('without the right to submit the action is off with the reason (the view is the same)', () => {
  const s = state(reading([]), { role: 'viewer' });
  assert.equal(s.phase, 'ready_to_submit');
  assert.equal(s.primaryAction.enabled, false);
  assert.ok((s.primaryAction.disabledReason ?? '') !== '');
});

test('over every reading x pending x role x scope the model keeps its promises about a blocked run', () => {
  const readings: Array<[string, ReadinessFact | undefined]> = [
    ['none', undefined],
    ['clear', reading([])],
    ['one', reading([frNow])],
    ['count', reading([countNow(12)])],
    ['checking', { reading: null, checking: true, error: null }],
    ['failed', { reading: null, checking: false, error: 'x' }],
  ];
  let n = 0;
  for (const [name, fact] of readings)
    for (const count of [0, 4])
      for (const role of ['owner', 'viewer'] as const)
        for (const scope of ['ios', 'both'] as const) {
          const s = deriveAppState(
            facts({
              records: [IOS],
              pending: { [IOS.id]: { count, blocking: 0 } },
              lastRun: { [IOS.id]: userRun() },
              releases: { [IOS.id]: [draft] },
              role,
              ...(fact === undefined ? {} : { readiness: { [IOS.id]: fact } }),
            }),
            scope,
          );
          const at = `${name}/${count}/${role}/${scope}`;
          assert.equal(s.failures.length, 1, at);
          const view = s.failures[0]?.blockers;
          assert.ok(view, at);
          // The run is always kept, as history, whatever the reading says.
          assert.equal(view.run.length, 2, at);
          // "Ready" is only ever said of an empty current list, and "blocked" only of a non-empty one.
          assert.equal(view.state === 'ready', view.current.length === 0 && view.readAt !== null && name === 'clear', at);
          if (view.state === 'blocked') assert.ok(view.current.length > 0, at);
          // The phase "ready to submit" is never claimed over blockers or pending changes.
          if (s.phase === 'ready_to_submit') {
            assert.equal(view.state, 'ready', at);
            assert.equal(count, 0, at);
            assert.equal(s.primaryAction.action, 'submit_now', at);
          }
          if (view.state === 'ready' && count === 0) assert.equal(s.phase, 'ready_to_submit', at);
          n += 1;
        }
  assert.equal(n, 48);
});
