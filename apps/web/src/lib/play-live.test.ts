import assert from 'node:assert/strict';
import { test } from 'node:test';
import { playLiveUnconfirmed } from './play-live.ts';

test('a Google Play production release read as live or rolling out is not confirmed', () => {
  assert.equal(
    playLiveUnconfirmed({ platform: 'android', track: 'production', status: 'live' }),
    true,
  );
  assert.equal(
    playLiveUnconfirmed({ platform: 'android', track: 'Production', status: 'rolling_out' }),
    true,
  );
});

test('nothing else is: other tracks, other states (in review, draft, halted), iOS and macOS', () => {
  assert.equal(
    playLiveUnconfirmed({ platform: 'android', track: 'internal', status: 'live' }),
    false,
  );
  assert.equal(
    playLiveUnconfirmed({ platform: 'android', track: 'production', status: 'in_review' }),
    false,
  );
  assert.equal(
    playLiveUnconfirmed({ platform: 'android', track: 'production', status: 'draft' }),
    false,
  );
  assert.equal(
    playLiveUnconfirmed({ platform: 'android', track: 'production', status: 'halted' }),
    false,
  );
  assert.equal(playLiveUnconfirmed({ platform: 'ios', track: null, status: 'live' }), false);
  assert.equal(playLiveUnconfirmed({ platform: 'macos', track: null, status: 'live' }), false);
});
