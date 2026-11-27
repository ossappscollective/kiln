import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isInternalTrack,
  isOptInTrack,
  isProductionTrack,
  PLAY_TRACK_ORDER,
  PLAY_TRACKS,
  playChannelOf,
  sameTrack,
  trackKind,
} from './tracks.ts';

test('Google names the tracks in one place', () => {
  assert.deepEqual(PLAY_TRACKS, {
    internal: 'internal',
    alpha: 'alpha',
    beta: 'beta',
    production: 'production',
  });
  assert.deepEqual(PLAY_TRACK_ORDER, ['internal', 'alpha', 'beta', 'production']);
});

test('trackKind: production, open, closed (alpha and custom), internal, sharing, none', () => {
  assert.equal(trackKind('production'), 'production');
  assert.equal(trackKind('Production'), 'production');
  assert.equal(trackKind('beta'), 'open');
  assert.equal(trackKind('alpha'), 'closed');
  assert.equal(trackKind('qa-team'), 'closed');
  assert.equal(trackKind('internal'), 'internal');
  assert.equal(trackKind('internal-app-sharing'), 'sharing');
  assert.equal(trackKind('app_sharing'), 'sharing');
  assert.equal(trackKind(null), 'none');
  assert.equal(trackKind(''), 'none');
  assert.equal(trackKind(undefined), 'none');
});

test('predicates', () => {
  assert.equal(isProductionTrack('production'), true);
  assert.equal(isProductionTrack('beta'), false);
  assert.equal(isInternalTrack('internal'), true);
  // the server's opt-in URL rule: neither internal nor production
  assert.deepEqual(
    ['internal', 'alpha', 'beta', 'production', 'qa'].filter((t) => isOptInTrack(t)),
    ['alpha', 'beta', 'qa'],
  );
  assert.equal(isOptInTrack(null), false);
  assert.equal(sameTrack('Beta', 'beta'), true);
  assert.equal(sameTrack(null, 'beta'), false);
  assert.equal(sameTrack(null, null), true);
});

test('playChannelOf: internal, then alpha, then beta, else other', () => {
  assert.equal(playChannelOf(['internal']), 'play_internal');
  assert.equal(playChannelOf(['beta', 'internal']), 'play_internal');
  assert.equal(playChannelOf(['alpha']), 'play_closed');
  assert.equal(playChannelOf(['beta']), 'play_open');
  assert.equal(playChannelOf(['qa']), 'play_other');
  assert.equal(playChannelOf([]), 'play_other');
});
