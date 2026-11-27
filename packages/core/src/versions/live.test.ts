import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReleaseState } from '../release/lifecycle.ts';
import {
  isNewerThanLive,
  isObsolete,
  isObsoleteVersion,
  isPreparingStatus,
  isServingStatus,
  liveOf,
  obsoleteReasonOf,
  PAST_PREPARE_STATUSES,
  PREPARING_STATUSES,
  type ReleaseFact,
  SERVING_STATUSES,
} from './live.ts';

/**
 * The one definition of "what is live" (audit releases.md F1/F2/F5): the scenarios that showed three answers on three screens.
 */

const apple = (
  version: string,
  status: ReleaseState | null,
  extra: Partial<Omit<ReleaseFact, 'id'>> & { id?: string } = {},
): ReleaseFact & { id: string } => ({
  id: `${version}:${status}`,
  version,
  track: null,
  build: null,
  status,
  versionCodes: null,
  ...extra,
});

const play = (
  version: string,
  track: string,
  status: ReleaseState | null,
  codes: string[],
  extra: Partial<Omit<ReleaseFact, 'id'>> & { id?: string } = {},
): ReleaseFact & { id: string } => ({
  id: `${track}:${version}:${status}`,
  version,
  track,
  build: null,
  status,
  versionCodes: codes,
  ...extra,
});

test('the serving set, status by status (every state of the lifecycle has an answer)', () => {
  const states: ReleaseState[] = [
    'draft',
    'build_chosen',
    'ready',
    'in_review',
    'rejected',
    'approved',
    'propagating',
    'rolling_out',
    'live',
    'halted',
  ];
  const serving = states.filter((s) => isServingStatus(s));
  assert.deepEqual(serving, ['rolling_out', 'live', 'halted']);
  assert.deepEqual(SERVING_STATUSES.slice().sort(), ['halted', 'live', 'rolling_out']);
  assert.deepEqual(PREPARING_STATUSES, ['draft', 'build_chosen', 'ready']);
  assert.equal(isServingStatus(null), false);
  assert.equal(isPreparingStatus(null), false);
  // a status is never both serving and preparing, and every one is accounted for
  for (const s of states) {
    assert.equal(isServingStatus(s) && isPreparingStatus(s), false, s);
    assert.equal(
      isServingStatus(s) || isPreparingStatus(s) || PAST_PREPARE_STATUSES.indexOf(s) >= 0,
      true,
      s,
    );
  }
  // propagating is past prepare but NOT serving: it must not move the live version
  assert.equal(PAST_PREPARE_STATUSES.indexOf('propagating') >= 0, true);
  assert.equal(isServingStatus('propagating'), false);
});

test('iOS: 1.19.0 phased + obsolete 1.11.6 draft: serving is 1.19.0 and the draft is obsolete (the 1.11.6 bug)', () => {
  const releases = [
    apple('1.11.6', 'draft'),
    apple('1.19.0', 'rolling_out', { build: '90' }),
    apple('1.18.0', 'live', { build: '80' }),
  ];
  const facts = liveOf(releases, { platform: 'ios' });
  assert.deepEqual(
    facts.serving.map((r) => r.version),
    ['1.19.0', '1.18.0'],
  );
  assert.equal(facts.newestLive?.version, '1.19.0');
  assert.deepEqual(
    facts.rollingOut.map((r) => r.version),
    ['1.19.0'],
  );
  assert.deepEqual(
    facts.live.map((r) => r.version),
    ['1.18.0'],
  );
  assert.deepEqual(facts.halted, []);
  assert.deepEqual(facts.ref, { version: '1.19.0', build: '90', codes: [] });
  const draft = releases[0] as ReleaseFact;
  assert.equal(isObsolete(draft, facts), true);
  assert.equal(obsoleteReasonOf(draft, facts), 'older_than_live');
});

test('iOS: serving order is by VERSION, not by status_since (an old release re-synced later does not outrank a newer one)', () => {
  const facts = liveOf(
    [
      apple('1.18.0', 'live', { statusSince: 9_000 }),
      apple('1.19.0', 'live', { statusSince: 1_000 }),
    ],
    { platform: 'ios' },
  );
  assert.equal(facts.newestLive?.version, '1.19.0');
  // same version and build: the later status_since wins (tie-break only)
  const tie = liveOf(
    [
      apple('1.19.0', 'live', { build: '5', statusSince: 1, id: 'old' }),
      apple('1.19.0', 'live', { build: '5', statusSince: 2, id: 'new' }),
    ],
    { platform: 'ios' },
  );
  assert.equal((tie.newestLive as { id: string }).id, 'new');
});

test('iOS: halted serves, in_review/approved/propagating/draft do not; same version: the higher build is live', () => {
  const facts = liveOf(
    [
      apple('2.0.0', 'in_review'),
      apple('1.9.0', 'approved'),
      apple('1.8.0', 'halted', { build: '70' }),
      apple('1.8.0', 'live', { build: '71', id: 'b71' }),
      apple('3.0.0', 'propagating'),
    ],
    { platform: 'macos' },
  );
  assert.deepEqual(
    facts.serving.map((r) => `${r.version}/${r.build}`),
    ['1.8.0/71', '1.8.0/70'],
  );
  assert.deepEqual(
    facts.halted.map((r) => r.build),
    ['70'],
  );
  assert.equal((facts.newestLive as { id: string }).id, 'b71');
});

test('nothing serving: no live, nothing obsolete (a first release has no old drafts)', () => {
  const releases = [apple('1.0.0', 'draft'), apple('0.9.0', 'in_review')];
  const facts = liveOf(releases, { platform: 'ios' });
  assert.equal(facts.newestLive, null);
  assert.equal(facts.ref, null);
  assert.deepEqual(facts.serving, []);
  assert.equal(isObsolete(releases[0] as ReleaseFact, facts), false);
  assert.equal(isObsoleteVersion('0.1', facts), false);
});

test('Android: only PRODUCTION serves; an internal release that is live is not what is live', () => {
  const releases = [
    play('2.0.0', 'internal', 'live', ['210']),
    play('1.9.0', 'production', 'live', ['190']),
    play('1.9.1', 'beta', 'rolling_out', ['195']),
  ];
  const facts = liveOf(releases, { platform: 'android' });
  assert.deepEqual(
    facts.serving.map((r) => r.track),
    ['production'],
  );
  assert.deepEqual(facts.ref, { version: '1.9.0', build: null, codes: ['190'] });
  // custom track names and case are the same: Production is production
  const upper = liveOf([play('1.9.0', 'Production', 'live', ['190'])], { platform: 'android' });
  assert.equal(upper.serving.length, 1);
});

test('Android: the highest production code is live (staged rollout next to the previous release); inProgress is rolling_out', () => {
  const facts = liveOf(
    [
      play('1.9.0', 'production', 'live', ['190']),
      play('1.9.1', 'production', 'rolling_out', ['195', '196']),
      play('1.8.0', 'production', 'live', ['180']),
    ],
    { platform: 'android' },
  );
  assert.equal(facts.newestLive?.version, '1.9.1');
  assert.deepEqual(facts.ref?.codes, ['195', '196']);
  assert.deepEqual(
    facts.rollingOut.map((r) => r.version),
    ['1.9.1'],
  );
  assert.deepEqual(
    facts.live.map((r) => r.version),
    ['1.9.0', '1.8.0'],
  );
});

test('Android obsolete: a draft whose codes are all below production is left behind; equal or higher is not', () => {
  const releases = [
    play('1.9.0', 'production', 'live', ['190']),
    play('1.8.5', 'internal', 'draft', ['185']),
    play('1.9.1', 'internal', 'draft', ['191']),
    play('1.9.0', 'beta', 'draft', ['190']),
    play('x', 'internal', 'draft', []),
  ];
  const facts = liveOf(releases, { platform: 'android' });
  assert.equal(isObsolete(releases[1] as ReleaseFact, facts), true);
  assert.equal(isObsolete(releases[2] as ReleaseFact, facts), false);
  assert.equal(isObsolete(releases[3] as ReleaseFact, facts), false);
  assert.equal(isObsolete(releases[4] as ReleaseFact, facts), false);
});

test('obsolete reasons on Apple: lower, same, higher, unreadable, and only drafts are judged', () => {
  const facts = liveOf([apple('1.19.0', 'live')], { platform: 'ios' });
  const reason = (version: string, status: ReleaseState | null) =>
    obsoleteReasonOf({ version, status, versionCodes: null }, facts);
  assert.equal(reason('1.11.6', 'draft'), 'older_than_live');
  assert.equal(reason('1.19.0', 'ready'), 'same_as_live');
  assert.equal(reason('1.19.0.1', 'build_chosen'), null);
  assert.equal(reason('2.0', 'draft'), null);
  assert.equal(reason('nightly', 'draft'), null);
  assert.equal(reason('1.0', 'in_review'), null);
  assert.equal(reason('1.0', 'rejected'), null);
  assert.equal(reason('1.0', null), null);
  assert.equal(isObsoleteVersion('1.19.0', facts), true);
  assert.equal(isObsoleteVersion('1.19.1', facts), false);
  assert.equal(isObsoleteVersion('x', facts), false);
});

test('isNewerThanLive: version, then build, null when it cannot be told', () => {
  const facts = liveOf([apple('1.19.0', 'rolling_out', { build: '88' })], { platform: 'ios' });
  const newer = (version: string | null, buildNumber: string | null) =>
    isNewerThanLive({ version, buildNumber }, facts);
  assert.equal(newer('1.19.1', '1'), true);
  assert.equal(newer('1.19.0', '90'), true);
  assert.equal(newer('1.19.0', '88'), false);
  assert.equal(newer('1.19.0', '12'), false);
  assert.equal(newer('1.18.9', '999'), false);
  assert.equal(newer('2.0.0-beta', '1'), true);
  assert.equal(newer('next', '1'), null);
  assert.equal(newer(null, '1'), null);
  assert.equal(
    isNewerThanLive({ version: 'next', buildNumber: '1' }, liveOf([], { platform: 'ios' })),
    true,
  );
});

test('liveOf never mutates its input', () => {
  const releases = [apple('1.0.0', 'live'), apple('2.0.0', 'live')];
  const copy = releases.slice();
  liveOf(releases, { platform: 'ios' });
  assert.deepEqual(releases, copy);
});
