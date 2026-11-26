import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveAppState, deriveTopBar, scopeFor } from './derive.ts';
import {
  ANDROID,
  dismissedRun,
  facts,
  failedRun,
  failingAndroid,
  internalTesting,
  IOS,
  pipelineOf,
  running,
  succeededRun,
} from './fixtures.ts';

/**
 * Named scenarios: the incidents this project has seen, each as the facts that caused it and what the model must say (docs/state-model.md).
 */

test('the failing scenario: Android, 29 pending, the last publish refused (draft_not_allowed), build 167 promotable', () => {
  const s = deriveAppState(failingAndroid(), 'android');
  assert.equal(s.phase, 'publish_failed');
  assert.equal(s.headline, 'The last publish failed');
  assert.match(s.reason, /Only releases with status draft|draft|not allowed|rejected|refused/i);
  assert.match(s.reason, /Your 29 changes are still waiting/);
  assert.equal(s.primaryAction.action, 'show_pending');
  assert.equal(s.primaryAction.label, 'Show pending changes');
  assert.equal(s.primaryAction.enabled, true);
  assert.deepEqual(s.secondaryActions.map((a) => [a.action, a.label, a.enabled]), [['publish_again', 'Publish again', true]]);
  // The top bar: failed, count kept.
  assert.deepEqual(s.badge, { kind: 'failed', count: 29, appId: ANDROID.id });
  // The card never says it.
  assert.doesNotMatch(`${s.headline} ${s.reason}`, /nothing is waiting/i);
  // Promote is offered but off, with the reason; so are the release actions.
  assert.ok(s.promotion);
  assert.equal(s.promotion.option.codes[0], '167');
  assert.equal(s.promotion.offer.enabled, false);
  assert.equal(s.promotion.offer.disabledReason, 'Resolve the failed publish first.');
  for (const a of ['promote', 'release', 'submit', 'create_version', 'prepare_release', 'start_release'] as const)
    assert.equal(s.canDo(a, 'android').enabled, false, a);
  // The ways out stay.
  for (const a of ['publish', 'push', 'discard', 'rollout'] as const) assert.equal(s.canDo(a, 'android').enabled, true, a);
});

test('dismissing the failure returns the model to changes_pending (and a later success clears it too)', () => {
  const dismissed = deriveAppState(failingAndroid({ lastRun: { [ANDROID.id]: dismissedRun('android') } }), 'android');
  assert.equal(dismissed.phase, 'changes_pending');
  assert.equal(dismissed.headline, '29 changes waiting');
  assert.deepEqual(dismissed.badge, { kind: 'pending', count: 29, blocking: false });
  assert.equal(dismissed.primaryAction.action, 'show_pending');
  assert.equal(dismissed.promotion?.offer.enabled, true);
  const later = deriveAppState(failingAndroid({ lastRun: { [ANDROID.id]: succeededRun('android') } }), 'android');
  assert.equal(later.phase, 'changes_pending');
  const cleared = deriveAppState(failingAndroid({ lastRun: { [ANDROID.id]: null } }), 'android');
  assert.equal(cleared.phase, 'changes_pending');
});

test('a publish that runs again hides the older failure: it is publishing, nothing is on', () => {
  const s = deriveAppState(failingAndroid({ publishing: { [ANDROID.id]: running() } }), 'android');
  assert.equal(s.phase, 'publishing');
  assert.equal(s.failures.length, 0);
  assert.equal(s.badge.kind, 'publishing');
  assert.equal(s.promotion?.offer.enabled, false);
  assert.match(s.promotion?.offer.disabledReason ?? '', /A publish of this app is running/);
});

test('pending count kept after publishing is the server count, not a remembered one (0 after a successful publish)', () => {
  const s = deriveAppState(facts({ records: [ANDROID], pending: { [ANDROID.id]: { count: 0, blocking: 0 } }, lastRun: { [ANDROID.id]: null } }), 'android');
  assert.equal(s.pendingCount, 0);
  assert.deepEqual(s.badge, { kind: 'idle' });
  assert.equal(s.phase, 'ready_to_release');
});

test('"Nothing is waiting for you" and Start release only when nothing is pending, nothing failed, nothing runs, and the count is read', () => {
  const idle = deriveAppState(facts({ records: [ANDROID] }), 'android');
  assert.equal(idle.phase, 'ready_to_release');
  assert.equal(idle.headline, 'Nothing is waiting for you');
  assert.equal(idle.primaryAction.action, 'start_release');
  const unread = deriveAppState(facts({ records: [ANDROID], pendingKnown: false }), 'android');
  assert.equal(unread.phase, 'unknown');
  assert.doesNotMatch(unread.headline, /nothing is waiting/i);
  assert.equal(unread.primaryAction.action, 'none');
  const pending = deriveAppState(facts({ records: [ANDROID], pending: { [ANDROID.id]: { count: 29, blocking: 0 } } }), 'android');
  assert.equal(pending.phase, 'changes_pending');
  assert.notEqual(pending.primaryAction.action, 'start_release');
});

test('"next step" showing iOS when Android is selected: the card is about the platform in scope only', () => {
  const f = facts({ pipelines: { [IOS.id]: pipelineOf(IOS, 'needs_you'), [ANDROID.id]: null } });
  const android = deriveAppState(f, 'android');
  assert.equal(android.flow, null);
  assert.equal(android.phase, 'ready_to_release');
  const ios = deriveAppState(f, 'ios');
  assert.equal(ios.phase, 'release_needs_you');
  assert.match(ios.headline, /3\.1\.1/);
  assert.deepEqual(ios.platforms.map((p) => p.platform), ['ios']);
});

test('the scope filters the count and says where the rest is', () => {
  const f = facts({ pending: { [IOS.id]: { count: 3, blocking: 0 }, [ANDROID.id]: { count: 29, blocking: 0 } } });
  assert.equal(deriveAppState(f, 'android').pendingCount, 29);
  assert.equal(deriveAppState(f, 'ios').pendingCount, 3);
  assert.equal(deriveAppState(f, 'both').pendingCount, 32);
  const android = deriveAppState(f, 'android');
  assert.equal(android.elsewhere.pendingCount, 3);
  assert.deepEqual(android.elsewhere.platforms, ['ios']);
  // Pending only on the other platform: this scope is not "pending", but says where.
  const quiet = deriveAppState(facts({ pending: { [IOS.id]: { count: 3, blocking: 0 } } }), 'android');
  assert.equal(quiet.phase, 'ready_to_release');
  assert.equal(quiet.elsewhere.pendingCount, 3);
});

test('a publish on the OTHER platform of the app still holds every write back (one batch writes the app), and the card says where', () => {
  const f = facts({ releases: { [ANDROID.id]: [internalTesting()] }, publishing: { [IOS.id]: running() } });
  const s = deriveAppState(f, 'android');
  assert.equal(s.phase, 'ready_to_release', 'the scope is Android: its card is not "publishing"');
  assert.equal(s.elsewhere.publishing, true);
  assert.equal(s.promotion?.offer.enabled, false);
  assert.equal(s.primaryAction.enabled, false);
  assert.match(s.primaryAction.disabledReason ?? '', /A publish of this app is running/);
});

test('promote while a publish runs is off, with the reason; with no run it is on', () => {
  const f = facts({ records: [ANDROID], releases: { [ANDROID.id]: [internalTesting()] } });
  assert.equal(deriveAppState(f, 'android').promotion?.offer.enabled, true);
  const busy = deriveAppState({ ...f, publishing: { [ANDROID.id]: running() } }, 'android');
  assert.equal(busy.promotion?.offer.enabled, false);
});

test('a role that cannot release never gets promote, and a viewer gets nothing that writes', () => {
  const f = facts({ records: [ANDROID], role: 'viewer', releases: { [ANDROID.id]: [internalTesting()] }, pending: { [ANDROID.id]: { count: 4, blocking: 0 } } });
  const s = deriveAppState(f, 'android');
  assert.equal(s.promotion, null);
  for (const a of ['publish', 'push', 'discard', 'submit', 'release', 'promote', 'rollout', 'prepare_release', 'start_release'] as const)
    assert.equal(s.canDo(a, 'android').enabled, false, a);
  assert.equal(s.phase, 'changes_pending');
});

test('the top bar follows a publish of another app and keeps the open app\'s count', () => {
  const open = deriveAppState(facts({ records: [ANDROID], pending: { [ANDROID.id]: { count: 4, blocking: 0 } } }), 'android');
  assert.deepEqual(deriveTopBar(open, 'other-app'), { kind: 'publishing', count: 4, appId: 'other-app', elsewhere: true });
  assert.deepEqual(deriveTopBar(open, null), { kind: 'pending', count: 4, blocking: false });
  assert.deepEqual(deriveTopBar(null, null), { kind: 'idle' });
});

test('a release in review with changes pending: pending leads, the review stays reachable as the secondary action', () => {
  const f = facts({ records: [IOS], pending: { [IOS.id]: { count: 2, blocking: 0 } }, pipelines: { [IOS.id]: pipelineOf(IOS, 'in_review') } });
  const s = deriveAppState(f, 'ios');
  assert.equal(s.phase, 'changes_pending');
  assert.equal(s.secondaryActions[0]?.action, 'follow_review');
  assert.ok(s.flow);
});

test('an unknown outcome says to look at the store before publishing again', () => {
  const s = deriveAppState(failingAndroid({ lastRun: { [ANDROID.id]: failedRun('android', { outcome: 'partial', results: [{ ...failedRun().results[0]!, outcome: 'unknown', error: 'outcome_unknown' }] }) } }), 'android');
  assert.match(s.reason, /Look at the store before you publish again/);
});

test('scopeFor names the scope of the records a page shows', () => {
  assert.equal(scopeFor([IOS, ANDROID], [ANDROID]), 'android');
  assert.equal(scopeFor([IOS, ANDROID], [IOS, ANDROID]), 'both');
  assert.equal(scopeFor([ANDROID], [ANDROID]), 'android');
});
