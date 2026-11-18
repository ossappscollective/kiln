import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type AppleRolloutState,
  normalizeFraction,
  type PlayRolloutState,
  percent,
  planAppleRollout,
  planPlayRollout,
  rolloutKey,
  sameRolloutState,
} from './rollout-types.ts';

const play = (over: Partial<PlayRolloutState> = {}): PlayRolloutState => ({
  store: 'googleplay',
  platform: 'android',
  track: 'production',
  versionCodes: ['240'],
  name: '2.4.0',
  status: 'inProgress',
  userFraction: 0.1,
  otherReleases: 1,
  ...over,
});
const apple = (over: Partial<AppleRolloutState> = {}): AppleRolloutState => ({
  store: 'appstoreconnect',
  platform: 'ios',
  version: '2.4.0',
  storeVersionId: 'v-1',
  versionState: 'READY_FOR_DISTRIBUTION',
  phasedReleaseId: 'p-1',
  phasedReleaseState: 'ACTIVE',
  currentDayNumber: 3,
  startDate: 1,
  totalPauseDays: 0,
  ...over,
});

test('a fraction is more than 0 and less than 1, to four decimals', () => {
  assert.equal(normalizeFraction(0.2), 0.2);
  assert.equal(normalizeFraction(0.123456), 0.1235);
  for (const bad of [0, 1, -0.1, 1.5, 0.00001, Number.NaN, Number.POSITIVE_INFINITY, '0.2', null, undefined]) {
    assert.equal(normalizeFraction(bad), undefined, String(bad));
  }
  assert.equal(percent(0.125), '12.5%');
  assert.equal(percent(null), 'unknown');
});

test('Play: the share only goes up, and only while the rollout is in progress', () => {
  const up = planPlayRollout(play(), { action: 'set_fraction', userFraction: 0.2 });
  assert.ok(up.ok);
  assert.equal(up.ok && up.irreversible, false);
  assert.deepEqual(up.ok && [up.proposed.store === 'googleplay' && up.proposed.status, up.proposed.store === 'googleplay' && up.proposed.userFraction], ['inProgress', 0.2]);
  assert.match(up.ok ? up.summary : '', /from 10% to 20%/);

  for (const asked of [0.1, 0.05]) {
    const down = planPlayRollout(play(), { action: 'set_fraction', userFraction: asked });
    assert.ok(!down.ok && down.code === 'not_an_increase', String(asked));
  }
  const invalid = planPlayRollout(play(), { action: 'set_fraction', userFraction: 1 });
  assert.ok(!invalid.ok && invalid.code === 'invalid_fraction', 'to reach everyone, complete');
  for (const status of ['halted', 'completed', 'draft']) {
    const refused = planPlayRollout(play({ status }), { action: 'set_fraction', userFraction: 0.5 });
    assert.ok(!refused.ok && refused.code === 'not_allowed', status);
  }
  const unknown = planPlayRollout(play({ userFraction: null }), { action: 'set_fraction', userFraction: 0.5 });
  assert.ok(!unknown.ok && unknown.code === 'not_allowed', 'a share that cannot be compared is not raised');
});

test('Play: halt keeps the share, resume never lowers it, complete is final', () => {
  const halted = planPlayRollout(play(), { action: 'halt' });
  assert.ok(halted.ok && halted.proposed.store === 'googleplay' && halted.proposed.status === 'halted' && halted.proposed.userFraction === 0.1);
  assert.ok(!planPlayRollout(play({ status: 'halted' }), { action: 'halt' }).ok);
  assert.ok(!planPlayRollout(play({ status: 'completed', userFraction: null }), { action: 'halt' }).ok);

  const stopped = play({ status: 'halted', userFraction: 0.2 });
  const same = planPlayRollout(stopped, { action: 'resume' });
  assert.ok(same.ok && same.proposed.store === 'googleplay' && same.proposed.status === 'inProgress' && same.proposed.userFraction === 0.2);
  const higher = planPlayRollout(stopped, { action: 'resume', userFraction: 0.5 });
  assert.ok(higher.ok && higher.proposed.store === 'googleplay' && higher.proposed.userFraction === 0.5);
  const lower = planPlayRollout(stopped, { action: 'resume', userFraction: 0.1 });
  assert.ok(!lower.ok && lower.code === 'not_an_increase');
  assert.ok(!planPlayRollout(stopped, { action: 'resume', userFraction: 2 }).ok);
  assert.ok(!planPlayRollout(play(), { action: 'resume' }).ok, 'only a halted rollout is resumed');
  const noShare = planPlayRollout(play({ status: 'halted', userFraction: null }), { action: 'resume' });
  assert.ok(!noShare.ok && noShare.code === 'invalid_fraction');

  const done = planPlayRollout(play(), { action: 'complete' });
  assert.ok(done.ok && done.irreversible && done.proposed.store === 'googleplay' && done.proposed.status === 'completed' && done.proposed.userFraction === null);
  assert.ok(!planPlayRollout(stopped, { action: 'complete' }).ok, 'resume a halted rollout first');
  assert.ok(!planPlayRollout(play({ status: 'completed', userFraction: null }), { action: 'complete' }).ok);
});

test('Apple: pause, resume and release to all, and nothing else; a finished or unstarted release is left alone', () => {
  const paused = planAppleRollout(apple(), { action: 'pause' });
  assert.ok(paused.ok && paused.proposed.store === 'appstoreconnect' && paused.proposed.phasedReleaseState === 'PAUSED' && !paused.irreversible);
  assert.ok(!planAppleRollout(apple({ phasedReleaseState: 'PAUSED' }), { action: 'pause' }).ok);
  const resumed = planAppleRollout(apple({ phasedReleaseState: 'PAUSED' }), { action: 'resume' });
  assert.ok(resumed.ok && resumed.proposed.store === 'appstoreconnect' && resumed.proposed.phasedReleaseState === 'ACTIVE');
  assert.ok(!planAppleRollout(apple(), { action: 'resume' }).ok);

  for (const state of ['ACTIVE', 'PAUSED']) {
    const all = planAppleRollout(apple({ phasedReleaseState: state }), { action: 'release_to_all' });
    assert.ok(all.ok && all.irreversible && all.proposed.store === 'appstoreconnect' && all.proposed.phasedReleaseState === 'COMPLETE', state);
  }
  for (const action of ['pause', 'resume', 'release_to_all'] as const) {
    assert.ok(!planAppleRollout(apple({ phasedReleaseState: 'COMPLETE' }), { action }).ok, `no un-release: ${action}`);
    assert.ok(!planAppleRollout(apple({ phasedReleaseState: 'INACTIVE' }), { action }).ok, `not started: ${action}`);
    assert.ok(!planAppleRollout(apple({ phasedReleaseState: 'SOMETHING_NEW' }), { action }).ok, `unknown state: ${action}`);
    assert.ok(!planAppleRollout(apple({ phasedReleaseId: null, phasedReleaseState: null }), { action }).ok, `no phased release: ${action}`);
  }
});

test('the key of a state leaves out what moves by itself, and sorts version codes', () => {
  assert.ok(sameRolloutState(apple(), apple({ currentDayNumber: 4, totalPauseDays: 2, startDate: 99 })));
  assert.ok(!sameRolloutState(apple(), apple({ phasedReleaseState: 'PAUSED' })));
  assert.ok(sameRolloutState(play({ versionCodes: ['2', '10'] }), play({ versionCodes: ['10', '2'] })));
  assert.ok(!sameRolloutState(play(), play({ userFraction: 0.2 })));
  assert.ok(!sameRolloutState(play(), play({ status: 'halted' })));
  assert.deepEqual(Object.keys(rolloutKey(play())), ['store', 'track', 'versionCodes', 'status', 'userFraction']);
});
