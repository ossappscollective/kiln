import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FIRST_RELEASE_MESSAGE,
  FRACTION_REFUSED_MESSAGE,
  fractionRefusalNotice,
  hasEarlierProductionRelease,
  NEVER_MESSAGE,
  rolloutOffer,
  type StagedRolloutMode,
  sharePrefill,
} from './play-rollout-offer.ts';

const r = (track: string | null, status: string | null) => ({ track, status });

test('an earlier production release is one that served users in the production track', () => {
  assert.equal(hasEarlierProductionRelease([]), false);
  assert.equal(hasEarlierProductionRelease([r('production', 'live')]), true);
  assert.equal(hasEarlierProductionRelease([r('production', 'rolling_out')]), true);
  assert.equal(hasEarlierProductionRelease([r('production', 'halted')]), true);
  assert.equal(
    hasEarlierProductionRelease([r('production', 'draft')]),
    false,
    'a draft served nobody',
  );
  assert.equal(
    hasEarlierProductionRelease([r('production', 'in_review'), r('production', null)]),
    false,
  );
  assert.equal(
    hasEarlierProductionRelease([r('internal', 'live'), r('beta', 'live')]),
    false,
    'another track does not count',
  );
  assert.equal(hasEarlierProductionRelease([r(null, 'live')]), false, 'iOS rows have no track');
});

test('the offer matrix: auto follows the history, always asks, never is always 100%', () => {
  const offer = (mode: StagedRolloutMode, track: string, earlier: boolean) =>
    rolloutOffer({ mode, track, earlierProductionRelease: earlier });
  // auto
  assert.deepEqual(offer('auto', 'production', true), {
    offered: true,
    reason: null,
    message: null,
  });
  assert.deepEqual(offer('auto', 'production', false), {
    offered: false,
    reason: 'first_release',
    message: FIRST_RELEASE_MESSAGE,
  });
  assert.equal(
    offer('auto', 'beta', false).offered,
    true,
    'the first-release rule is for production',
  );
  // always_ask
  assert.equal(offer('always_ask', 'production', false).offered, true);
  assert.equal(offer('always_ask', 'production', true).offered, true);
  // never
  assert.deepEqual(offer('never', 'production', true), {
    offered: false,
    reason: 'never',
    message: NEVER_MESSAGE,
  });
  assert.equal(offer('never', 'beta', true).offered, false);
  assert.match(
    FIRST_RELEASE_MESSAGE,
    /first release in production: Google Play does not offer a staged rollout/,
  );
});

test('the share starts as 100 when no rollout is offered, else the staged share, else the default of the app, else empty', () => {
  const yes = rolloutOffer({ mode: 'auto', track: 'production', earlierProductionRelease: true });
  const no = rolloutOffer({ mode: 'never', track: 'production', earlierProductionRelease: true });
  assert.equal(sharePrefill({ offer: no, stagedPercent: '10', defaultPercent: 5 }), '100');
  assert.equal(
    sharePrefill({ offer: yes, stagedPercent: '10', defaultPercent: 5 }),
    '10',
    'a staged share wins',
  );
  assert.equal(sharePrefill({ offer: yes, stagedPercent: '', defaultPercent: 5 }), '5');
  assert.equal(sharePrefill({ offer: yes, stagedPercent: ' ', defaultPercent: 2.5 }), '2.5');
  assert.equal(sharePrefill({ offer: yes, stagedPercent: '', defaultPercent: null }), '');
});

test('a refusal about the share or the rollout gets the plain message, only when a share below 100% was asked', () => {
  assert.equal(
    fractionRefusalNotice('Invalid value for userFraction', 0.1),
    FRACTION_REFUSED_MESSAGE,
  );
  assert.equal(
    fractionRefusalNotice('Staged rollout is not available for this app', 0.5),
    FRACTION_REFUSED_MESSAGE,
  );
  assert.equal(fractionRefusalNotice('Invalid value for userFraction', 1), null);
  assert.equal(fractionRefusalNotice('Invalid value for userFraction', null), null);
  assert.equal(fractionRefusalNotice('Version code 5 is too low', 0.1), null);
});
