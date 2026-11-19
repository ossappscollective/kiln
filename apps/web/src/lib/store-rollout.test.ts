import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from './api.ts';
import {
  actionButtons,
  buildRequest,
  canConfirm,
  canRollout,
  classifyFailure,
  confirmationMatches,
  confirmPhrase,
  controlsAvailability,
  describeState,
  mayRetry,
  type PlayRolloutState,
  parsePercent,
  type RolloutConfig,
  type RolloutPreview,
  rolloutTargets,
  stateQuery,
} from './store-rollout.ts';
import type { ReleaseSummary } from './types.ts';

const config: RolloutConfig = {
  enabled: true,
  envName: 'MRM_STORE_ROLLOUT_ENABLED',
  actions: {
    android: ['set_fraction', 'halt', 'resume', 'complete'],
    ios: ['pause', 'resume', 'release_to_all'],
  },
  irreversible: ['complete', 'release_to_all'],
  fraction: { exclusiveMin: 0, exclusiveMax: 1 },
};

const play = (over: Partial<PlayRolloutState> = {}): PlayRolloutState => ({
  store: 'googleplay',
  platform: 'android',
  track: 'production',
  versionCodes: ['240'],
  name: '2.4.0',
  status: 'inProgress',
  userFraction: 0.1,
  otherReleases: 0,
  ...over,
});

const preview = (over: Partial<RolloutPreview> = {}): RolloutPreview => ({
  app: { id: 'a1', name: 'Shop', platform: 'android', store: 'googleplay' },
  action: 'complete',
  target: { track: 'production', versionCodes: ['240'] },
  current: play(),
  proposed: play({ status: 'completed', userFraction: null }),
  summary: 'Release 2.4.0 to everyone.',
  irreversible: true,
  confirmHash: 'a'.repeat(64),
  warnings: [],
  readAt: 1,
  ...over,
});

const release = (over: Partial<ReleaseSummary>): ReleaseSummary => ({
  id: 'r',
  appId: 'a1',
  platform: 'android',
  version: '2.4.0',
  track: 'production',
  build: '240',
  status: 'live',
  rawState: 'completed',
  rolloutFraction: null,
  versionCodes: ['240'],
  storeUpdatedAt: null,
  syncedAt: 1,
  ...over,
});

test('only admin and owner can use the controls: others see nothing', () => {
  assert.equal(canRollout('owner'), true);
  assert.equal(canRollout('admin'), true);
  assert.equal(canRollout('member'), false);
  assert.equal(canRollout('viewer'), false);
  assert.deepEqual(controlsAvailability('member', config, false), { state: 'hidden' });
  assert.deepEqual(controlsAvailability('viewer', null, true), { state: 'hidden' });
});

test('availability: loading, failed, off with the env name, ready', () => {
  assert.equal(controlsAvailability('admin', null, false).state, 'loading');
  assert.equal(controlsAvailability('admin', null, true).state, 'unknown');
  const off = controlsAvailability('admin', { ...config, enabled: false }, false);
  assert.equal(off.state, 'off');
  assert.ok(off.state === 'off' && off.message.includes('MRM_STORE_ROLLOUT_ENABLED'));
  assert.equal(controlsAvailability('owner', config, false).state, 'ready');
});

test('targets: Play releases need a track and version codes; in-flight ones come first', () => {
  const list = [
    release({ id: '1', version: '2.3.0', versionCodes: ['230'], status: 'live' }),
    release({
      id: '2',
      version: '2.4.0',
      versionCodes: ['241', '240'],
      status: 'rolling_out',
      rolloutFraction: 0.1,
    }),
    release({ id: '3', version: '2.5.0', track: null, versionCodes: null, status: 'draft' }),
    release({ id: '4', version: '2.5.0', track: 'internal', versionCodes: [], status: 'draft' }),
    release({ id: '5', platform: 'ios', version: '9.9', track: null }),
  ];
  const targets = rolloutTargets({ platform: 'android' }, list);
  assert.equal(targets.length, 2);
  assert.deepEqual(targets[0]?.base, { track: 'production', versionCodes: ['240', '241'] });
  assert.ok(targets[0]?.label.includes('10%'));
  assert.deepEqual(targets[1]?.base, { track: 'production', versionCodes: ['230'] });
});

test('targets: an iOS version names the marketing version', () => {
  const list = [
    release({
      platform: 'ios',
      version: '3.1.0',
      track: null,
      versionCodes: null,
      rawState: 'READY_FOR_SALE',
    }),
  ];
  const targets = rolloutTargets({ platform: 'ios' }, list);
  assert.deepEqual(
    targets.map((t) => t.base),
    [{ version: '3.1.0' }],
  );
});

test('state query', () => {
  assert.equal(
    stateQuery({ track: 'production', versionCodes: ['240', '241'] }),
    'track=production&versionCodes=240,241',
  );
  assert.equal(stateQuery({ version: '2.4.0 beta' }), 'version=2.4.0%20beta');
});

test('buttons: disabled with the server reason, irreversible marked, blocked wins', () => {
  const state = {
    allowedActions: [
      { action: 'set_fraction', allowed: true, irreversible: false },
      { action: 'halt', allowed: true, irreversible: false },
      { action: 'resume', allowed: false, reason: 'It is not halted.', irreversible: false },
      { action: 'complete', allowed: true, irreversible: true },
    ],
  };
  const buttons = actionButtons(config, 'android', state, null);
  assert.deepEqual(
    buttons.map((b) => [b.action, b.disabled]),
    [
      ['set_fraction', false],
      ['halt', false],
      ['resume', true],
      ['complete', false],
    ],
  );
  assert.equal(buttons[2]?.reason, 'It is not halted.');
  assert.equal(buttons[3]?.irreversible, true);
  assert.equal(buttons[3]?.label, 'Release to 100%');
  assert.ok(actionButtons(config, 'android', null, null).every((b) => b.disabled));
  assert.ok(
    actionButtons(config, 'android', state, 'Unknown outcome.').every(
      (b) => b.disabled && b.reason === 'Unknown outcome.',
    ),
  );
  assert.equal(actionButtons(config, 'ios', null, null)[1]?.label, 'Resume phased release');
});

test('percent: a fraction above the current share, below 100, at most 4 decimals', () => {
  assert.deepEqual(parsePercent('25', 0.1), { ok: true, fraction: 0.25 });
  assert.deepEqual(parsePercent(' 12,5 % ', 0.1), { ok: true, fraction: 0.125 });
  assert.deepEqual(parsePercent('0.01', null), { ok: true, fraction: 0.0001 });
  for (const bad of ['', 'abc', '0', '100', '150', '-5', '1.005'])
    assert.equal(parsePercent(bad, null).ok, false, bad);
  const down = parsePercent('10', 0.1);
  assert.equal(down.ok, false);
  assert.ok(!down.ok && down.message.includes('only raises'));
  assert.equal(parsePercent('5', 0.1).ok, false);
});

test('request: the share only goes with set_fraction and resume', () => {
  const base = { track: 'production', versionCodes: ['240'] };
  assert.deepEqual(buildRequest(base, 'set_fraction', 0.25), {
    action: 'set_fraction',
    track: 'production',
    versionCodes: ['240'],
    userFraction: 0.25,
  });
  assert.deepEqual(buildRequest(base, 'halt', 0.25), {
    action: 'halt',
    track: 'production',
    versionCodes: ['240'],
  });
  assert.deepEqual(buildRequest({ version: '2.4.0' }, 'pause'), {
    action: 'pause',
    version: '2.4.0',
  });
});

test('describe a state for a person', () => {
  assert.equal(describeState(play()), '2.4.0 on Production: rolling out at 10%');
  assert.equal(describeState(play({ status: 'halted' })), '2.4.0 on Production: halted at 10%');
  const apple = {
    store: 'appstoreconnect' as const,
    platform: 'ios' as const,
    version: '3.1.0',
    storeVersionId: 'v',
    versionState: 'READY_FOR_SALE',
    phasedReleaseId: 'p',
    phasedReleaseState: 'ACTIVE',
    currentDayNumber: 3,
    startDate: 1,
    totalPauseDays: 0,
  };
  assert.equal(describeState(apple), '3.1.0 on the App Store: phased release active (day 3 of 7)');
  assert.ok(
    describeState({ ...apple, phasedReleaseState: null, phasedReleaseId: null }).includes(
      'no phased release',
    ),
  );
});

test('typed confirmation: the version, any case, needed only for irreversible changes, plus the acknowledgement', () => {
  const p = preview();
  assert.equal(confirmPhrase(p), '2.4.0');
  assert.equal(confirmPhrase(preview({ current: play({ name: null }) })), 'Shop');
  assert.equal(confirmationMatches(' 2.4.0 ', '2.4.0'), true);
  assert.equal(confirmationMatches('', ''), false);
  assert.equal(confirmationMatches('2.4', '2.4.0'), false);
  assert.equal(canConfirm(p, '', true), false);
  assert.equal(canConfirm(p, '2.4.0', false), false);
  assert.equal(canConfirm(p, '2.4.0', true), true);
  assert.equal(canConfirm(preview({ irreversible: false }), '', true), true);
  assert.equal(canConfirm(preview({ irreversible: false }), '', false), false);
});

const err = (
  status: number,
  code: string,
  body: Record<string, unknown> = {},
  retryAfter?: number,
) => new ApiError(status, code, `message for ${code}`, retryAfter, { error: code, ...body });

test('state_changed with a new proposal becomes the next preview with the new hash', () => {
  const now = play({ userFraction: 0.2 });
  const proposed = play({ status: 'completed', userFraction: null });
  const f = classifyFailure(
    err(409, 'state_changed', {
      message: 'The store changed.',
      current: now,
      proposed,
      summary: 'New summary.',
      irreversible: true,
      confirmHash: 'b'.repeat(64),
    }),
    preview(),
  );
  assert.equal(f.kind, 'state_changed');
  assert.ok(f.kind === 'state_changed' && f.next !== null);
  if (f.kind === 'state_changed' && f.next) {
    assert.equal(f.next.confirmHash, 'b'.repeat(64));
    assert.equal(f.next.summary, 'New summary.');
    assert.deepEqual(f.next.current, now);
    assert.equal(f.next.app.name, 'Shop');
    assert.deepEqual(f.next.target, { track: 'production', versionCodes: ['240'] });
  }
});

test('state_changed that no longer fits has no next preview', () => {
  const f = classifyFailure(
    err(409, 'state_changed', {
      current: play(),
      reason: 'not_allowed',
      problem: 'Already complete.',
    }),
    preview(),
  );
  assert.ok(f.kind === 'state_changed' && f.next === null && f.current !== null);
});

test('an unknown outcome says to refresh and is never retried', () => {
  for (const e of [err(409, 'outcome_unknown'), err(504, 'timeout'), err(502, 'write_failed')]) {
    const f = classifyFailure(e, preview());
    assert.equal(f.kind, 'outcome_unknown');
    assert.equal(mayRetry(f), false);
    assert.ok(f.message.includes('Refresh state'));
  }
});

test('a confirmed no, a write in progress, a disabled switch, changes in review', () => {
  const no = classifyFailure(err(502, 'write_failed', { outcome: 'not_applied' }), preview());
  assert.equal(no.kind, 'not_applied');
  assert.equal(mayRetry(no), true);
  const busy = classifyFailure(err(409, 'write_in_progress'), preview());
  assert.equal(busy.kind, 'write_in_progress');
  assert.equal(mayRetry(busy), true);
  assert.equal(
    classifyFailure(err(409, 'rollout_disabled', { envName: 'X' }), null).kind,
    'disabled',
  );
  const review = classifyFailure(err(409, 'changes_in_review'), null);
  assert.equal(review.kind, 'other');
  assert.ok(review.message.includes('never cancels'));
  assert.equal(mayRetry(review), false);
  assert.equal(classifyFailure(new Error('x'), null).kind, 'other');
  assert.ok(classifyFailure(err(429, 'rate_limited', {}, 30), null).message.includes('30 seconds'));
});
