import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allowedEvents,
  DASHBOARD_BUCKETS,
  dashboardBucket,
  RELEASE_STATES,
  type ReleaseEvent,
  type ReleaseState,
  transition,
} from './lifecycle.ts';
import type { Platform } from '../platform.ts';

function run(platform: Platform, events: ReleaseEvent[]): ReleaseState {
  let state: ReleaseState = 'draft';
  for (const event of events) {
    const result = transition(platform, state, event);
    assert.ok(result.ok, result.ok ? '' : result.reason);
    state = result.state;
  }
  return state;
}

test('iOS happy path reaches live', () => {
  const end = run('ios', [
    'choose_build',
    'mark_ready',
    'submit',
    'approve',
    'release',
    'complete',
  ]);
  assert.equal(end, 'live');
});

test('Android passes through propagating before rolling out', () => {
  assert.equal(
    run('android', ['choose_build', 'mark_ready', 'submit', 'approve', 'release']),
    'propagating',
  );
  assert.equal(
    run('android', ['choose_build', 'mark_ready', 'submit', 'approve', 'release', 'propagated']),
    'rolling_out',
  );
});

test('iOS never enters propagating', () => {
  const result = transition('ios', 'propagating', 'propagated');
  assert.equal(result.ok, false);
});

test('rejection loops back to draft only through fix', () => {
  assert.equal(run('ios', ['choose_build', 'mark_ready', 'submit', 'reject']), 'rejected');
  assert.equal(run('ios', ['choose_build', 'mark_ready', 'submit', 'reject', 'fix']), 'draft');
  assert.equal(transition('ios', 'rejected', 'submit').ok, false);
});

test('a rollout can be halted and resumed', () => {
  const rolling = run('android', [
    'choose_build',
    'mark_ready',
    'submit',
    'approve',
    'release',
    'propagated',
  ]);
  const halted = transition('android', rolling, 'halt');
  assert.deepEqual(halted, { ok: true, state: 'halted' });
  assert.deepEqual(transition('android', 'halted', 'resume'), { ok: true, state: 'rolling_out' });
});

test('illegal transitions explain themselves', () => {
  const result = transition('ios', 'draft', 'approve');
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /Cannot apply "approve"/);
});

test('allowedEvents depends on the platform', () => {
  assert.deepEqual(allowedEvents('ios', 'approved'), ['release']);
  assert.deepEqual(allowedEvents('android', 'propagating'), ['propagated']);
  assert.deepEqual(allowedEvents('ios', 'propagating'), []);
});

test('every state maps to a dashboard bucket', () => {
  for (const state of RELEASE_STATES) {
    assert.ok(DASHBOARD_BUCKETS.includes(dashboardBucket(state)), state);
  }
  assert.equal(dashboardBucket('rejected'), 'in_review');
  assert.equal(dashboardBucket('approved'), 'ready_to_release');
  assert.equal(dashboardBucket('halted'), 'live');
});

test('every non-terminal state can move somewhere on at least one platform', () => {
  for (const state of RELEASE_STATES) {
    if (state === 'live') continue;
    const moves = [...allowedEvents('ios', state), ...allowedEvents('android', state)];
    assert.ok(moves.length > 0, `${state} is a dead end`);
  }
});
