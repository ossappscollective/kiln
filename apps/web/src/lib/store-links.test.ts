import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PLAY_CONSOLE_URL, reviewUrl } from './store-links.ts';

test('the review page: App Store Connect for iOS and macOS, Play Console for Android', () => {
  assert.equal(
    reviewUrl({ platform: 'ios', storeAppId: '1234567890' }),
    'https://appstoreconnect.apple.com/apps/1234567890/appstore/ios/version/inflight',
  );
  assert.equal(
    reviewUrl({ platform: 'macos', storeAppId: '1234567890' }),
    'https://appstoreconnect.apple.com/apps/1234567890/appstore/macos/version/inflight',
  );
  assert.equal(reviewUrl({ platform: 'android', storeAppId: 'com.acme.app' }), PLAY_CONSOLE_URL);
});

test('no Apple app id (or one that is not a number): no link', () => {
  assert.equal(reviewUrl({ platform: 'ios', storeAppId: null }), null);
  assert.equal(reviewUrl({ platform: 'ios', storeAppId: 'com.acme' }), null);
});
